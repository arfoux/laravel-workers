// tools/tests/packages-fcm-webpush.test.mjs — FCM v1 + Web Push notification
// ports and their kernel crypto helpers.
//
// Covered:
//   - fcm-oauth: RS256 JWT mint (base64url header/body segments, signature
//     verifies against the service-account public key) + token exchange.
//   - fcm-notification port: Bearer send to /v1/projects/{id}/messages:send.
//   - webpush-crypto: aes128gcm encrypt/decrypt roundtrip (RFC 8291) + the
//     RFC 8292 VAPID JWT (ES256) header format, incl. verifying the derived
//     VAPID public key against the key we generated it from.
// All crypto runs on Node's WebCrypto (same API as Workers). No network — the
// OAuth/send fetches are faked via env.fetchImpl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { buildServiceAccountJwt, mintFcmAccessToken } from '../../kernel/packages/fcm-oauth.mjs';
import fcmPort from '../../ports/packages/fcm-notification.mjs';
import { encryptAes128Gcm, buildVapidHeader, vapidPublicKeyBase64url } from '../../kernel/packages/webpush-crypto.mjs';
import webpushPort from '../../ports/packages/webpush-notification.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const enc = new TextEncoder();
const dec = new TextDecoder();

// base64url helpers (local to the test for assert/inspect).
function b64urlToBytes(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  return new Uint8Array(Buffer.from(b64 + '='.repeat(pad), 'base64'));
}
function b64urlDecodeJson(seg) {
  return JSON.parse(dec.decode(b64urlToBytes(seg)));
}

// ---- fakes -----------------------------------------------------------------

function makeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const r = typeof responses === 'function' ? responses(calls.length - 1, url, init) : responses;
    return new Response(r.body, { status: r.status, headers: r.headers || { 'content-type': 'application/json' } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const okCtx = (body, params = {}) => ({ body, query: {}, params });

// ---- FCM -------------------------------------------------------------------

// Generate a fresh RSA keypair (PKCS8 PEM private) for the service account.
async function makeServiceAccount() {
  const { publicKey, privateKey } = webcrypto.subtle;
  void publicKey; void privateKey;
  const kp = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = await webcrypto.subtle.exportKey('spki', kp.publicKey);
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', kp.privateKey);
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  const wrap = (label, data) => `${label}\n${b64(data).replace(/(.{64})/g, '$1\n')}\n${label.replace('BEGIN', 'END')}`;
  const sa = {
    project_id: 'my-firebase-project',
    client_email: 'firebase-adminsdk-abc@my-firebase-project.iam.gserviceaccount.com',
    private_key: wrap('-----BEGIN PRIVATE KEY-----', pkcs8),
    public_spki: wrap('-----BEGIN PUBLIC KEY-----', spki),
  };
  return sa;
}

test('fcm: buildServiceAccountJwt produces RS256 header + correct claims, signature verifies', async () => {
  const sa = await makeServiceAccount();
  const now = 1_700_000_000;
  const { assertion, header, payload } = await buildServiceAccountJwt(sa, { now });

  const [h, p, s] = assertion.split('.');
  assert.equal(h, b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(payload.iss, sa.client_email);
  assert.equal(payload.sub, sa.client_email);
  assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(payload.iat, now);
  assert.equal(payload.exp, now + 3600);
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(b64urlDecodeJson(p).scope, 'https://www.googleapis.com/auth/firebase.messaging');

  // Signature verifies against the service-account public key.
  const sig = b64urlToBytes(s);
  const pub = await webcrypto.subtle.importKey(
    'spki',
    b64urlPemToBytes(sa.public_spki),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, sig, enc.encode(`${h}.${p}`));
  assert.equal(ok, true);
});

test('fcm: mintFcmAccessToken accepts a base64 service account and exchanges for a token', async () => {
  const sa = await makeServiceAccount();
  const b64Sa = Buffer.from(JSON.stringify(sa)).toString('base64');
  const fetchImpl = makeFetch({ status: 200, body: JSON.stringify({ access_token: 'ya29.abc', expires_in: 3600 }) });
  const env = { fetchImpl, FCM_SERVICE_ACCOUNT_JSON: b64Sa };

  const token = await mintFcmAccessToken(env, { now: 1_700_000_000 });

  assert.equal(token, 'ya29.abc');
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://oauth2.googleapis.com/token');
  assert.equal(call.init.method, 'POST');
  assert.match(String(call.init.headers['content-type']), /application\/x-www-form-urlencoded/);
  const body = new URLSearchParams(call.init.body);
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  // The assertion carries our client_email as iss.
  const assertion = body.get('assertion');
  assert.equal(b64urlDecodeJson(assertion.split('.')[1]).iss, sa.client_email);
});

test('fcm: mintFcmAccessToken accepts a raw JSON service account', async () => {
  const sa = await makeServiceAccount();
  const fetchImpl = makeFetch({ status: 200, body: JSON.stringify({ access_token: 'ya29.raw' }) });
  const token = await mintFcmAccessToken({ fetchImpl, FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) }, { now: 1 });
  assert.equal(token, 'ya29.raw');
});

test('fcm: token endpoint error surfaces a thrown error', async () => {
  const sa = await makeServiceAccount();
  const fetchImpl = makeFetch({ status: 400, body: JSON.stringify({ error: 'invalid_grant' }) });
  await assert.rejects(
    () => mintFcmAccessToken({ fetchImpl, FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) }, { now: 1 }),
    /invalid_grant/,
  );
});

test('fcm port: sends message to /v1/projects/{id}/messages:send with bearer token', async () => {
  const sa = await makeServiceAccount();
  // First call = token mint, second = send.
  const fetchImpl = makeFetch((i) =>
    i === 0
      ? { status: 200, body: JSON.stringify({ access_token: 'ya29.send' }) }
      : { status: 200, body: JSON.stringify({ name: 'projects/p/messages/0:1' }) },
  );
  const env = {
    fetchImpl,
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa),
    FCM_PROJECT_ID: 'my-firebase-project',
  };
  const ctx = okCtx({ token: 'device-token', notification: { title: 'Hi', body: 'Deploy done' } });

  const res = await fcmPort(ctx, env);

  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 2);
  const send = fetchImpl.calls[1];
  assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/my-firebase-project/messages:send');
  assert.equal(send.init.headers.authorization, 'Bearer ya29.send');
  const sent = JSON.parse(send.init.body);
  assert.equal(sent.message.token, 'device-token');
  assert.equal(sent.message.notification.title, 'Hi');
  assert.equal(sent.message.notification.body, 'Deploy done');
});

test('fcm port: passes a ready `message` object through verbatim', async () => {
  const sa = await makeServiceAccount();
  const fetchImpl = makeFetch((i) =>
    i === 0
      ? { status: 200, body: JSON.stringify({ access_token: 't' }) }
      : { status: 200, body: JSON.stringify({ name: 'x' }) },
  );
  const env = { fetchImpl, FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa), FCM_PROJECT_ID: 'p' };
  const message = { topic: 'news', data: { a: '1' }, android: { priority: 'HIGH' } };
  const res = await fcmPort(okCtx({ message }), env);
  assert.equal(res.status, 200);
  const sent = JSON.parse(fetchImpl.calls[1].init.body);
  assert.deepEqual(sent.message, message);
});

test('fcm port: missing target is a 422 and never mints/fetches', async () => {
  const sa = await makeServiceAccount();
  const fetchImpl = makeFetch({ status: 200, body: JSON.stringify({ access_token: 't' }) });
  const env = { fetchImpl, FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa), FCM_PROJECT_ID: 'p' };
  const res = await fcmPort(okCtx({ notification: { title: 'x' } }), env);
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('fcm port: missing project id is a 500', async () => {
  const sa = await makeServiceAccount();
  const fetchImpl = makeFetch({ status: 200, body: JSON.stringify({ access_token: 't' }) });
  const env = { fetchImpl, FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) };
  const res = await fcmPort(okCtx({ token: 'x' }), env);
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- webpush crypto --------------------------------------------------------

// Parse the aes128gcm body into { salt, rs, ephemeralPub, ciphertext } so the
// test can decrypt and confirm the roundtrip.
function parseAes128Gcm(ciphertext) {
  const salt = ciphertext.slice(0, 16);
  const rs = (ciphertext[16] << 24) | (ciphertext[17] << 16) | (ciphertext[18] << 8) | ciphertext[19];
  const keyidLen = ciphertext[20];
  const ephemeralPub = ciphertext.slice(21, 21 + keyidLen);
  const ct = ciphertext.slice(21 + keyidLen);
  return { salt, rs, ephemeralPub, ct };
}

// Decrypt an aes128gcm body with the recipient (client) private key + auth.
async function decryptAes128Gcm(ciphertext, authSecretBytes, clientPrivateKey) {
  const { salt, ephemeralPub, ct } = parseAes128Gcm(ciphertext);
  const ephPubKey = await webcrypto.subtle.importKey(
    'raw', ephemeralPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(
    await webcrypto.subtle.deriveBits({ name: 'ECDH', public: ephPubKey }, clientPrivateKey, 256),
  );
  const auth = authSecretBytes;
  const ikm = concat(shared, auth);
  const hkdfKey = await webcrypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const context = lengthPrefix(ephemeralPub);
  const cek = new Uint8Array(await webcrypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt,
      info: concat(enc.encode('Content-Encoding: aes128gcm'), Uint8Array.of(0x00), context) },
    hkdfKey, 128,
  ));
  const nonce = new Uint8Array(await webcrypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt,
      info: concat(enc.encode('Content-Encoding: nonce'), Uint8Array.of(0x00), context) },
    hkdfKey, 96,
  ));
  const aesKey = await webcrypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const block = new Uint8Array(await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ct,
  ));
  // strip 0x02 padding delimiter
  let end = block.length;
  for (let i = block.length - 1; i >= 0; i -= 1) {
    if (block[i] === 0x02) { end = i; break; }
  }
  return block.slice(0, end);
}

function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function lengthPrefix(bytes) {
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

test('webpush: aes128gcm encrypt/decrypt roundtrip recovers the payload', async () => {
  // Client (browser) subscription keypair.
  const client = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const clientPublicRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', client.publicKey));
  // Server ephemeral keypair.
  const eph = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephPublicRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', eph.publicKey));
  const authSecret = b64urlEncodeBytes(new Uint8Array(16).fill(7));

  const payload = JSON.stringify({ title: 'Hello', body: 'World' });
  const encd = await encryptAes128Gcm(authSecret, {
    clientPublicKey: clientPublicRaw,
    ephemeralPrivateKey: eph.privateKey,
    ephemeralPublicKey: ephPublicRaw,
  }, payload);

  const { rs, ephemeralPub } = parseAes128Gcm(encd.ciphertext);
  assert.equal(rs, 4096);
  assert.deepEqual(ephemeralPub, ephPublicRaw); // keyid == ephemeral public

  const recovered = dec.decode(await decryptAes128Gcm(encd.ciphertext, b64urlToBytes(authSecret), client.privateKey));
  assert.equal(recovered, payload);
});

test('webpush: roundtrip with a string authSecret and Uint8 payload', async () => {
  const client = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const eph = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const authSecret = b64urlEncodeBytes(new Uint8Array(16).fill(3));
  const payloadBytes = enc.encode('raw bytes payload');
  const encd = await encryptAes128Gcm(authSecret, {
    clientPublicKey: new Uint8Array(await webcrypto.subtle.exportKey('raw', client.publicKey)),
    ephemeralPrivateKey: eph.privateKey,
    ephemeralPublicKey: new Uint8Array(await webcrypto.subtle.exportKey('raw', eph.publicKey)),
  }, payloadBytes);
  const recovered = await decryptAes128Gcm(encd.ciphertext, b64urlToBytes(authSecret), client.privateKey);
  assert.deepEqual(recovered, payloadBytes);
});

// ---- webpush VAPID ---------------------------------------------------------

// Generate a VAPID keypair (ECDH P-256) and return the base64url private scalar.
async function makeVapidKey() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
  return { priv: jwk.d, publicRaw: new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)) };
}

test('webpush: vapid public key derivation matches the generated key', async () => {
  const { priv, publicRaw } = await makeVapidKey();
  const derived = b64urlToBytes(vapidPublicKeyBase64url(priv));
  assert.deepEqual(derived, publicRaw);
});

test('webpush: buildVapidHeader returns vapid t=..,k=.. with ES256 header + aud/exp/sub claims', async () => {
  const { priv, publicRaw } = await makeVapidKey();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
  const now = 1_700_000_000;

  const header = await buildVapidHeader(endpoint, priv, 'mailto:ops@example.com', { now });

  const m = header.match(/^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/);
  assert.ok(m, `header not in vapid t=,k= form: ${header}`);
  const jwt = m[1];
  const kPub = b64urlToBytes(m[2]);
  assert.deepEqual(kPub, publicRaw); // the k= public key matches the generated key

  const [h, p, s] = jwt.split('.');
  assert.deepEqual(b64urlDecodeJson(h), { typ: 'JWT', alg: 'ES256' });
  const claims = b64urlDecodeJson(p);
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:ops@example.com');
  assert.equal(claims.exp, now + 12 * 3600);

  // Verify the ES256 signature with the public key.
  const pub = await webcrypto.subtle.importKey(
    'raw', kPub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  );
  const ok = await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlToBytes(s), enc.encode(`${h}.${p}`),
  );
  assert.equal(ok, true);
});

// ---- webpush port ----------------------------------------------------------

test('webpush port: sends encrypted body + vapid header to the subscription endpoint', async () => {
  const { priv } = await makeVapidKey();
  const client = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const clientPublicRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', client.publicKey));
  const authSecret = b64urlEncodeBytes(new Uint8Array(16).fill(9));

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response('', { status: 201, headers: {} });
  };
  const env = {
    fetchImpl,
    WEBPUSH_VAPID_PRIVATE_KEY: priv,
    WEBPUSH_VAPID_SUBJECT: 'mailto:ops@example.com',
  };
  const ctx = okCtx({
    endpoint: 'https://fcm.googleapis.com/fcm/send/xyz',
    keys: { p256dh: b64urlEncodeBytes(clientPublicRaw), auth: authSecret },
    payload: { title: 'Ping' },
    ttl: 3600,
  });

  const res = await webpushPort(ctx, env);

  assert.equal(res.status, 201);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://fcm.googleapis.com/fcm/send/xyz');
  assert.match(call.init.headers.authorization, /^vapid t=/);
  assert.equal(call.init.headers['content-encoding'], 'aes128gcm');
  assert.equal(call.init.headers.ttl, '3600');
  assert.ok(call.init.body instanceof Uint8Array, 'encrypted body is a Uint8Array');

  // The sent ciphertext must decrypt (roundtrip) with the client private key.
  const recovered = dec.decode(await decryptAes128Gcm(
    call.init.body,
    b64urlToBytes(authSecret),
    client.privateKey,
  ));
  assert.deepEqual(JSON.parse(recovered), { title: 'Ping' });
});

test('webpush port: looks up a subscription from D1 by id and sends', async () => {
  const { priv } = await makeVapidKey();
  const client = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const clientPublicRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', client.publicKey));
  const authSecret = b64urlEncodeBytes(new Uint8Array(16).fill(1));

  const rows = {
    endpoint: 'https://push.example.com/send/1',
    p256dh: b64urlEncodeBytes(clientPublicRaw),
    auth: authSecret,
  };
  const db = {
    prepare(sql) {
      assert.match(sql, /SELECT endpoint, p256dh, auth FROM webpush_subscriptions WHERE id = \?1/);
      return { bind: () => ({ first: async () => rows }) };
    },
  };
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init: init || {} }); return new Response('', { status: 201 }); };
  const env = {
    fetchImpl, DB: db,
    WEBPUSH_VAPID_PRIVATE_KEY: priv,
    WEBPUSH_VAPID_SUBJECT: 'mailto:a@b.c',
  };
  const res = await webpushPort(okCtx({ payload: 'hello' }, { id: '42' }), env);
  assert.equal(res.status, 201);
  assert.equal(calls[0].url, 'https://push.example.com/send/1');
});

test('webpush port: missing vapid private key is a 500 before fetch', async () => {
  const fetchImpl = makeFetch({ status: 201, body: '' });
  const env = { fetchImpl, WEBPUSH_VAPID_SUBJECT: 'mailto:a@b.c' };
  const res = await webpushPort(okCtx({ endpoint: 'https://x/', keys: { p256dh: 'a', auth: 'b' }, payload: 'x' }), env);
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('webpush port: no subscription (neither id nor keys) is a 422 before fetch', async () => {
  const { priv } = await makeVapidKey();
  const fetchImpl = makeFetch({ status: 201, body: '' });
  const env = { fetchImpl, WEBPUSH_VAPID_PRIVATE_KEY: priv, WEBPUSH_VAPID_SUBJECT: 'mailto:a@b.c' };
  const res = await webpushPort(okCtx({ payload: 'x' }), env);
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- helpers ---------------------------------------------------------------

function b64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlEncodeBytes(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
// Turn a PEM-wrapped base64 into raw DER bytes (strip header/footer/whitespace).
function b64urlPemToBytes(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
