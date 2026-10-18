// kernel/tests/cookies.test.mjs — byte/behaviour parity for kernel/cookies.mjs
// against PHP 8.3 implementations.
//
// Static checks run against kernel/tests/fixtures/laravel-1337-cookies.json
// (real Set-Cookie bytes captured from Laravel 13.37 via tools/http-oracle.php).
// Dynamic checks cross-verify crypto in both directions using
// tools/php-crypto-oracle.php (standalone PHP openssl/hmac implementation).
//
// Run: node --test kernel/tests/cookies.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CookieError,
  rawUrlEncode,
  rawUrlDecode,
  gmdateCookie,
  makeCookie,
  serializeCookie,
  parseSetCookie,
  parseCookieHeader,
  cookieValuePrefix,
  cookieValuePrefixRemove,
  createCookieEncryptor,
  ResponseCookies,
} from '../cookies.mjs';

import { phpJsonEncode } from '../php-json.mjs';

const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/laravel-1337-cookies.json', import.meta.url), 'utf8')
);

const phpOraclePath = fileURLToPath(new URL('../../tools/php-crypto-oracle.php', import.meta.url));

function phpCrypto(mode, items, keyB64 = fixture.key_b64) {
  const res = spawnSync('php', [phpOraclePath], {
    input: JSON.stringify({ key_b64: keyB64, mode, items }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`php exit ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// rawurlencode / rawurldecode
// ---------------------------------------------------------------------------

test('rawUrlEncode matches PHP rawurlencode()', () => {
  assert.equal(rawUrlEncode('a b+c/d=e'), 'a%20b%2Bc%2Fd%3De');
  assert.equal(rawUrlEncode('héllo'), 'h%C3%A9llo');
  assert.equal(rawUrlEncode("A-Za-z0-9-_.~"), 'A-Za-z0-9-_.~');
  assert.equal(rawUrlEncode("!'()*"), '%21%27%28%29%2A');
});

test('rawUrlDecode is PHP rawurldecode() semantics (no plus-to-space)', () => {
  assert.equal(rawUrlDecode('a%20b%2Bc%2Fd%3De'), 'a b+c/d=e');
  assert.equal(rawUrlDecode('a+b'), 'a+b'); // plus stays literal
  assert.equal(rawUrlDecode('%C3%BC'), 'ü');
  assert.equal(rawUrlDecode('100%'), '100%');
  assert.equal(rawUrlDecode('%zz'), '%zz');
  // Round-trip
  const s = '{"iv":"a+b/c=","value":"ü"}';
  assert.equal(rawUrlDecode(rawUrlEncode(s)), s);
});

// ---------------------------------------------------------------------------
// gmdate
// ---------------------------------------------------------------------------

test('gmdateCookie matches PHP gmdate(D, d M Y H:i:s T)', () => {
  assert.equal(gmdateCookie(0), 'Thu, 01 Jan 1970 00:00:00 GMT');
  assert.equal(gmdateCookie(1), 'Thu, 01 Jan 1970 00:00:01 GMT');
  assert.equal(gmdateCookie(1792336827), 'Sun, 18 Oct 2026 15:20:27 GMT');
});

// ---------------------------------------------------------------------------
// serialize/parse round-trip on real PHP Set-Cookie bytes
// ---------------------------------------------------------------------------

function nowForRaw(raw, cookie) {
  const maxAge = /;\s*Max-Age=(-?\d+)/i.exec(raw);
  if (/=deleted;/.test(raw)) return cookie.expires + 31536001;
  if (maxAge && cookie.expires) return cookie.expires - Number(maxAge[1]);
  return 1700000000;
}

test('serializeCookie round-trips every captured PHP Set-Cookie byte-for-byte', () => {
  assert.ok(fixture.all_set_cookie.length >= 30, 'fixture should contain many cookies');
  for (const raw of fixture.all_set_cookie) {
    const cookie = parseSetCookie(raw);
    const now = nowForRaw(raw, cookie);
    assert.equal(serializeCookie(cookie, now), raw, `round-trip failed for: ${raw.slice(0, 80)}…`);
  }
});

test('parsed fixture cookie attributes are exact', () => {
  const [xsrf, session, data] = fixture.s1.set_cookie;
  const c1 = parseSetCookie(xsrf);
  assert.equal(c1.name, 'XSRF-TOKEN');
  assert.equal(c1.httpOnly, false);
  assert.equal(c1.sameSite, 'lax');
  assert.equal(c1.path, '/');
  assert.equal(c1.secure, false);

  const c2 = parseSetCookie(session);
  assert.equal(c2.name, fixture.session_cookie_name);
  assert.equal(c2.httpOnly, true);

  const c3 = parseSetCookie(data);
  assert.equal(c3.name, fixture.s1.body.id);
  assert.equal(c3.httpOnly, true);
  assert.ok(/^[A-Za-z0-9]{40}$/.test(c3.name));
});

test('deletion cookie serialization matches Symfony exactly', () => {
  const now = 1792336827; // Sun, 18 Oct 2026 15:20:27 GMT
  const deleted = serializeCookie(makeCookie('laravel-session', null, 0, { sameSite: 'lax' }), now);
  assert.equal(
    deleted,
    'laravel-session=deleted; expires=Sat, 18 Oct 2025 15:20:26 GMT; Max-Age=0; path=/; httponly; samesite=lax'
  );
});

test('session cookie with expires=0 omits Expires/Max-Age', () => {
  const c = serializeCookie(makeCookie('a', 'b', 0), 1792336827);
  assert.equal(c, 'a=b; path=/; httponly');
});

// ---------------------------------------------------------------------------
// Request cookie parsing
// ---------------------------------------------------------------------------

test('parseCookieHeader decodes values, keeps + literal, last duplicate wins', () => {
  const parsed = parseCookieHeader('a=1; b=x%2By; c=%3D%20z; a=2; lone');
  assert.deepEqual(parsed, { a: '2', b: 'x+y', c: '= z' });
});

test('parseCookieHeader supports bracket syntax', () => {
  const parsed = parseCookieHeader('arr%5B0%5D=a; arr%5B1%5D=b; obj%5Bk%5D=v');
  assert.deepEqual(parsed, { arr: { 0: 'a', 1: 'b' }, obj: { k: 'v' } });
});

// ---------------------------------------------------------------------------
// CookieValuePrefix against PHP (dynamic)
// ---------------------------------------------------------------------------

test('cookieValuePrefix matches PHP CookieValuePrefix::create', async () => {
  const names = Object.keys(fixture.s1.jar_prefix);
  const phpPrefixes = phpCrypto('prefix', names);
  const keyBytes = b64ToBytes(fixture.key_b64);
  for (let i = 0; i < names.length; i++) {
    const js = await cookieValuePrefix(names[i], keyBytes);
    assert.equal(js, phpPrefixes[i], `prefix mismatch for ${names[i]}`);
    assert.equal(js.length, 41);
    assert.equal(js, fixture.s1.jar_prefix[names[i]], 'fixture prefix mismatch');
  }
});

// ---------------------------------------------------------------------------
// Decrypting real Laravel cookies (static fixture)
// ---------------------------------------------------------------------------

test('decryptRequestCookies reproduces PHP plaintexts byte-for-byte', async () => {
  const enc = createCookieEncryptor({ keyBase64: fixture.key_b64 });
  const decrypted = await enc.decryptRequestCookies(fixture.s1.jar_after);

  for (const [name, plain] of Object.entries(fixture.s1.jar_plain)) {
    const prefix = fixture.s1.jar_prefix[name];
    assert.ok(plain.startsWith(prefix), `${name} fixture missing prefix`);
    assert.equal(decrypted[name], cookieValuePrefixRemove(plain), `plaintext mismatch for ${name}`);
  }

  const id = fixture.s1.body.id;
  const token = fixture.s1.body.token;
  assert.equal(decrypted[fixture.session_cookie_name], id);
  assert.equal(decrypted['XSRF-TOKEN'], token);

  // Data cookie: envelope JSON + session payload must match Store::save() +
  // CookieSessionHandler::write() byte-for-byte (session.serialization=json
  // is the Laravel 11+/13 default).
  const payload = JSON.parse(decrypted[id]);
  assert.deepEqual(Object.keys(payload).sort(), ['data', 'expires']);
  assert.equal(typeof payload.expires, 'number');
  const attrs = JSON.parse(payload.data);
  assert.deepEqual(attrs, {
    _token: token,
    _previous: { url: 'http://localhost/__probe/session', route: null },
    _flash: { old: [], new: [] },
  });
  assert.equal(payload.data, phpJsonEncode(attrs), 'session payload must re-encode byte-for-byte');
});

test('decryptRequestCookies nulls tampered/garbage cookies (no throw)', async () => {
  const enc = createCookieEncryptor({ keyBase64: fixture.key_b64 });
  const out = await enc.decryptRequestCookies({
    'XSRF-TOKEN': 'not-base64-%%%',
    'laravel-session': 'eyJpdiI6ImJhZCIsInZhbHVlIjoiYmFkIiwibWFjIjoiYmFkIiwidGFnIjoiIn0=',
  });
  assert.equal(out['XSRF-TOKEN'], null);
  assert.equal(out['laravel-session'], null);
});

test('decryptRequestCookies keeps except-listed cookies untouched', async () => {
  const enc = createCookieEncryptor({ keyBase64: fixture.key_b64, except: ['plain-cookie'] });
  const out = await enc.decryptRequestCookies({ 'plain-cookie': 'raw%value', 'XSRF-TOKEN': fixture.s1.jar_after['XSRF-TOKEN'] });
  assert.equal(out['plain-cookie'], 'raw%value');
  assert.equal(out['XSRF-TOKEN'], fixture.s1.body.token);
});

// ---------------------------------------------------------------------------
// Encrypting cookies for PHP (dynamic, both directions)
// ---------------------------------------------------------------------------

test('encryptResponseCookies output is byte-parity decryptable by PHP', async () => {
  const enc = createCookieEncryptor({ keyBase64: fixture.key_b64 });
  const id = fixture.s1.body.id;
  const token = fixture.s1.body.token;

  const cookies = [
    makeCookie(fixture.session_cookie_name, id, 1792337099, { httpOnly: true, sameSite: 'lax' }),
    makeCookie('XSRF-TOKEN', token, 1792337099, { httpOnly: false, sameSite: 'lax' }),
  ];
  const [sessionOut, xsrfOut] = await enc.encryptResponseCookies(cookies);

  const phpDecrypted = phpCrypto('cookie-decrypt', [
    { name: sessionOut.name, value: sessionOut.value },
    { name: xsrfOut.name, value: xsrfOut.value },
  ]);
  assert.equal(phpDecrypted[0], id);
  assert.equal(phpDecrypted[1], token);

  // Attributes must be preserved by the encryption wrapper.
  assert.equal(sessionOut.httpOnly, true);
  assert.equal(sessionOut.expires, 1792337099);
});

test('PHP-encrypted cookie values decrypt in JS (dynamic)', async () => {
  const enc = createCookieEncryptor({ keyBase64: fixture.key_b64 });
  const payloads = ['plain payload', '', 'ünïcode ✓'];
  const phpValues = phpCrypto(
    'cookie-encrypt',
    payloads.map((v) => ({ name: 'laravel-session', value: v }))
  );
  // decryptRequestCookies validates the prefix against the request cookie
  // name, so every value must be decrypted under "laravel-session".
  for (let i = 0; i < payloads.length; i++) {
    const decrypted = await enc.decryptRequestCookies({ 'laravel-session': phpValues[i] });
    assert.equal(decrypted['laravel-session'], payloads[i]);
  }
});

test('JS-encrypted cookies survive PHP decrypt with unicode payloads', async () => {
  const enc = createCookieEncryptor({ keyBase64: fixture.key_b64 });
  const payloads = ['', 'ü ✓', '{"data":"a:1:{s:1:\\"k\\";s:1:\\"v\\";}","expires":123}'];
  const [out1, out2, out3] = await enc.encryptResponseCookies(
    payloads.map((v) => makeCookie('laravel-session', v))
  );
  const back = phpCrypto('cookie-decrypt', [
    { name: out1.name, value: out1.value },
    { name: out2.name, value: out2.value },
    { name: out3.name, value: out3.value },
  ]);
  assert.deepEqual(back, payloads);
});

// ---------------------------------------------------------------------------
// ResponseCookies ordering (Symfony ResponseHeaderBag semantics)
// ---------------------------------------------------------------------------

test('ResponseCookies replaces by name keeping original position', () => {
  const bag = new ResponseCookies();
  bag.set(makeCookie('a', '1'));
  bag.set(makeCookie('b', '2'));
  bag.set(makeCookie('c', '3'));
  bag.set(makeCookie('b', '22'));
  assert.deepEqual(
    bag.list().map((c) => [c.name, c.value]),
    [
      ['a', '1'],
      ['b', '22'],
      ['c', '3'],
    ]
  );
});

test('createCookieEncryptor rejects missing key', () => {
  assert.throws(() => createCookieEncryptor({}), CookieError);
});
