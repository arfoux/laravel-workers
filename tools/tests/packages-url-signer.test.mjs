// tools/tests/packages-url-signer.test.mjs — spatie/laravel-url-signer port.
//
// Pure primitive tests (no ctx handler, no fetch, no D1): sign + validate.
// The expected signature is recomputed independently with node:crypto
// (base64url HMAC-SHA256 over `${url}${sep}expires=${expires}`) so we are not
// just round-tripping our own function. Assertions cover:
//   - sign produces `?expires=&signature=` and the signature matches the oracle,
//   - validate returns { valid: true } for a fresh signature,
//   - an expired URL yields { valid: false, expired: true },
//   - a tampered URL/expires yields { valid: false }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { sign, validate } from '../../kernel/packages/url-signer.mjs';

const SECRET = 'url-signer-test-secret-key';
const BASE = 'https://app.example.com/account/billing';

// Independent oracle: base64url HMAC-SHA256 of `${url}${sep}expires=${expires}`,
// joining with `?` (bare url) or `&` (url already has a query string) — exactly
// how the output of the primitive appends `expires`.
function expectedSignature(url, expires, secret) {
  const sep = url.includes('?') || url.includes('&') ? '&' : '?';
  return createHmac('sha256', secret).update(`${url}${sep}expires=${expires}`).digest('base64url');
}

// Split a signed URL into { base, expires, signature }. `base` is the original
// url with only the `expires`/`signature` params removed, so a pre-existing
// query string survives intact.
function parseSigned(url) {
  const params = new URLSearchParams(url.slice(url.indexOf('?')));
  const base = url.replace(/[?&](expires|signature)=[^&]+/g, '');
  return { base, expires: params.get('expires'), signature: params.get('signature') };
}

test('url-signer: sign appends expires + base64url HMAC-SHA256 signature', async () => {
  const signed = await sign(BASE, 3600, SECRET);
  const { base, expires, signature } = parseSigned(signed);
  assert.equal(base, BASE, 'base URL preserved');
  assert.match(expires, /^\d+$/, 'expires is a unix timestamp');
  assert.ok(signature, 'signature present');
  assert.equal(signature, expectedSignature(BASE, expires, SECRET), 'signature matches independent oracle');
});

test('url-signer: sign uses `&` when the url already carries a query string', async () => {
  const url = `${BASE}?plan=pro`;
  const signed = await sign(url, 3600, SECRET);
  const { base, expires, signature } = parseSigned(signed);
  assert.equal(base, url, 'existing query preserved');
  assert.equal(signature, expectedSignature(url, expires, SECRET), 'oracle signs `${url}?expires=`');
  assert.ok(signed.startsWith(`${url}&expires=`), 'joins with &');
});

test('url-signer: validate accepts a fresh signature', async () => {
  const signed = await sign(BASE, 3600, SECRET);
  const res = await validate(signed, SECRET);
  assert.deepEqual(res, { valid: true });
});

test('url-signer: validate flags an expired url', async () => {
  const signed = await sign(BASE, 60, SECRET);
  const now = Math.floor(Date.now() / 1000) + 120;
  const res = await validate(signed, SECRET, { now });
  assert.deepEqual(res, { valid: false, expired: true });
});

test('url-signer: validate rejects a tampered url', async () => {
  const signed = await sign(BASE, 3600, SECRET);
  const tampered = signed.replace('/account/billing', '/account/refund');
  const res = await validate(tampered, SECRET);
  assert.deepEqual(res, { valid: false });
});

test('url-signer: validate rejects a tampered expires', async () => {
  const signed = await sign(BASE, 3600, SECRET);
  const tampered = signed.replace(/expires=\d+/, 'expires=99999999999');
  const res = await validate(tampered, SECRET);
  assert.deepEqual(res, { valid: false });
});

test('url-signer: validate rejects a wrong secret', async () => {
  const signed = await sign(BASE, 3600, SECRET);
  const res = await validate(signed, 'another-secret');
  assert.deepEqual(res, { valid: false });
});

test('url-signer: validate rejects a url without signature or expires', async () => {
  assert.deepEqual(await validate(BASE, SECRET), { valid: false });
  assert.deepEqual(await validate(`${BASE}?expires=123`, SECRET), { valid: false });
});
