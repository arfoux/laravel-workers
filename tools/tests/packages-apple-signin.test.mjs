// tools/tests/packages-apple-signin.test.mjs — Sign in with Apple.
//
// Two layers, both fake-fetch / no-network:
//   kernel apple.mjs  — mintClientSecret produces an ES256 JWT (header/body +
//                       a signature that actually verifies against the key),
//                       decodeIdToken splits the id_token; a real P-256 keypair
//                       is generated per run with WebCrypto, the .p8 being the
//                       exported PKCS8 base64.
//   port apple-signin.mjs — the form_post callback: reads code/user, exchanges
//                       the code at Apple's token endpoint (fake fetch records
//                       the exchange), decodes the id_token THAT CALL RETURNED
//                       (a form-supplied id_token is ignored) and returns
//                       { id, email, name }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import appleSignin from '../../ports/packages/apple-signin.mjs';
import {
  mintClientSecret,
  decodeIdToken,
  p8DerFromB64,
  APPLE_TOKEN_URL,
  APPLE_ISSUER,
  APPLE_MAX_CLIENT_SECRET_TTL,
} from '../../kernel/packages/apple.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- base64url helpers -------------------------------------------------------

function b64urlFromBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlToBytes(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  const bin = atob(b64 + '='.repeat(pad));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const b64urlDecodeJson = (seg) => JSON.parse(dec.decode(b64urlToBytes(seg)));

// Sign a JWT with an ECDSA private key (raw R||S, the JOSE ES256 shape).
async function signJwt(header, payload, privateKey) {
  const h = b64urlFromBytes(enc.encode(JSON.stringify(header)));
  const p = b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

// A fresh P-256 keypair; the .p8 the kernel reads is the base64 PKCS8.
async function makeP8() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', kp.privateKey);
  return { kp, p8: Buffer.from(pkcs8).toString('base64') };
}

// Fake fetch that records the outgoing call and replies with a canned JSON body.
function makeFetch(status, jsonBody) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(JSON.stringify(jsonBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const okCtx = (body = {}) => ({ body, query: {}, params: {} });

const TEAM_ID = 'TEAM99ABCD';
const CLIENT_ID = 'com.example.worker';
const KEY_ID = 'KEYID12345';
const NOW = 1_700_000_000;

// A realistic Apple id_token payload.
const appleClaims = {
  iss: APPLE_ISSUER,
  aud: CLIENT_ID,
  exp: NOW + 3600,
  iat: NOW,
  sub: '001234.567890.1f2e3d4c5b',
  email: 'ada@privaterelay.appleid.com',
  email_verified: true,
  is_private_email: true,
  auth_time: NOW,
  nonce_supported: true,
};

// ---- kernel: mintClientSecret ----------------------------------------------

test('apple kernel: mintClientSecret mints an ES256 secret (kid header, claims, valid signature)', async () => {
  const { kp, p8 } = await makeP8();
  const { assertion, header, payload } = await mintClientSecret({
    teamId: TEAM_ID,
    clientId: CLIENT_ID,
    p8PrivateKey: p8,
    keyId: KEY_ID,
    now: NOW,
  });

  const [h, p, s] = assertion.split('.');
  assert.equal(h, b64urlFromBytes(enc.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: KEY_ID }))));
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, KEY_ID);
  assert.equal(payload.iss, TEAM_ID);
  assert.equal(payload.sub, CLIENT_ID);
  assert.equal(payload.aud, APPLE_ISSUER);
  assert.equal(payload.iat, NOW);
  assert.equal(payload.exp, NOW + APPLE_MAX_CLIENT_SECRET_TTL);
  assert.equal(b64urlDecodeJson(p).iss, TEAM_ID, 'the wire payload matches');

  // The ES256 signature verifies against the public half of the same key.
  const ok = await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    kp.publicKey,
    b64urlToBytes(s),
    enc.encode(`${h}.${p}`)
  );
  assert.equal(ok, true, 'the client-secret signature must verify');
});

test('apple kernel: ttl is capped at the 6-month limit and a smaller ttl is honoured', async () => {
  const { p8 } = await makeP8();
  const over = APPLE_MAX_CLIENT_SECRET_TTL + 999_999;
  const { payload: overP } = await mintClientSecret({ teamId: TEAM_ID, clientId: CLIENT_ID, p8PrivateKey: p8, ttlSeconds: over, now: NOW });
  assert.equal(overP.exp - overP.iat, APPLE_MAX_CLIENT_SECRET_TTL, 'over-limit ttl is capped');

  const short = 3600;
  const { payload: shortP } = await mintClientSecret({ teamId: TEAM_ID, clientId: CLIENT_ID, p8PrivateKey: p8, ttlSeconds: short, now: NOW });
  assert.equal(shortP.exp - shortP.iat, short, 'a shorter ttl is used verbatim');
});

test('apple kernel: .p8 accepts either bare base64 or PEM armour', async () => {
  const { p8 } = await makeP8();
  const bare = p8DerFromB64(p8);
  const wrapped = p8.replace(/(.{64})/g, '$1\n');
  const pem = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`;
  assert.deepEqual(p8DerFromB64(pem), bare, 'PEM and bare base64 yield the same DER');
  assert.throws(() => p8DerFromB64(''), /empty/);
  assert.throws(() => p8DerFromB64('   -----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----  '), /no key body/);
});

test('apple kernel: mintClientSecret fails loud on missing inputs', async () => {
  const { p8 } = await makeP8();
  await assert.rejects(mintClientSecret({ teamId: '', clientId: CLIENT_ID, p8PrivateKey: p8 }), /teamId/);
  await assert.rejects(mintClientSecret({ teamId: TEAM_ID, clientId: '', p8PrivateKey: p8 }), /clientId/);
  await assert.rejects(mintClientSecret({ teamId: TEAM_ID, clientId: CLIENT_ID, p8PrivateKey: '' }), /p8PrivateKey/);
});

test('apple kernel: decodeIdToken splits header/payload/signature', async () => {
  const { kp } = await makeP8();
  const idToken = await signJwt({ alg: 'ES256', kid: KEY_ID }, appleClaims, kp.privateKey);
  const { header, payload, signature } = decodeIdToken(idToken);
  assert.equal(header.alg, 'ES256');
  assert.equal(payload.iss, APPLE_ISSUER);
  assert.equal(payload.sub, appleClaims.sub);
  assert.equal(payload.email, appleClaims.email);
  assert.equal(signature, idToken.split('.')[2]);
  assert.throws(() => decodeIdToken('not-a-jwt'), /3-part/);
  assert.throws(() => decodeIdToken('a.b'), /3-part/);
});

// ---- port: form_post callback -----------------------------------------------

test('apple-signin: form_post callback exchanges the code and returns the user', async () => {
  const { kp, p8 } = await makeP8();
  const idToken = await signJwt({ alg: 'ES256', kid: KEY_ID }, appleClaims, kp.privateKey);
  const fetchImpl = makeFetch(200, {
    access_token: 'access-tok-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-tok-1',
    id_token: idToken,
  });
  const env = {
    fetchImpl,
    APPLE_TEAM_ID: TEAM_ID,
    APPLE_CLIENT_ID: CLIENT_ID,
    APPLE_P8_PRIVATE_KEY: p8,
    APPLE_KEY_ID: KEY_ID,
    APPLE_REDIRECT_URI: 'https://app.example/callback',
  };
  const ctx = okCtx({
    code: 'authcode-abc',
    id_token: idToken,
    user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' }, email: 'ada@privaterelay.appleid.com' }),
  });

  const res = await appleSignin(ctx, env);
  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.ok, true);
  assert.deepEqual(out.user, {
    id: appleClaims.sub,
    email: appleClaims.email,
    name: 'Ada Lovelace',
    email_verified: true,
    is_private_email: true,
  });

  // The exchange hit Apple's token endpoint with the right grant.
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, APPLE_TOKEN_URL);
  assert.equal(call.init.method, 'POST');
  assert.match(call.init.headers['content-type'], /x-www-form-urlencoded/);
  const form = new URLSearchParams(call.init.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'authcode-abc');
  assert.equal(form.get('client_id'), CLIENT_ID);
  assert.ok(form.get('client_secret'), 'a client secret was minted and sent');
  const secret = b64urlDecodeJson(form.get('client_secret').split('.')[1]);
  assert.equal(secret.iss, TEAM_ID);
  assert.equal(secret.aud, APPLE_ISSUER);
  assert.equal(form.get('redirect_uri'), 'https://app.example/callback');
});

test('apple-signin: decodes the id_token the token endpoint returns', async () => {
  const { kp, p8 } = await makeP8();
  const idToken = await signJwt({ alg: 'ES256', kid: KEY_ID }, appleClaims, kp.privateKey);
  const fetchImpl = makeFetch(200, { access_token: 'at', id_token: idToken });
  const env = { fetchImpl, APPLE_TEAM_ID: TEAM_ID, APPLE_CLIENT_ID: CLIENT_ID, APPLE_P8_PRIVATE_KEY: p8 };
  const res = await appleSignin(okCtx({ code: 'c1' }), env);
  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.user.id, appleClaims.sub);
  assert.equal(out.user.name, null, 'no form `user` field on later sign-ins -> null name');
});

test('apple-signin: a swapped form id_token cannot pick the account signed in', async () => {
  const { kp, p8 } = await makeP8();
  // Apple's answer for THIS code — the identity the route must use.
  const realToken = await signJwt({ alg: 'ES256', kid: KEY_ID }, appleClaims, kp.privateKey);
  // What a caller holding their own valid code would post to impersonate.
  const swapped = await signJwt(
    { alg: 'ES256', kid: KEY_ID },
    { ...appleClaims, sub: '999999.888888.attacker', email: 'attacker@example.com' },
    kp.privateKey,
  );
  const fetchImpl = makeFetch(200, { access_token: 'at', id_token: realToken });
  const env = { fetchImpl, APPLE_TEAM_ID: TEAM_ID, APPLE_CLIENT_ID: CLIENT_ID, APPLE_P8_PRIVATE_KEY: p8 };
  const res = await appleSignin(okCtx({ code: 'c1', id_token: swapped }), env);
  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.user.id, appleClaims.sub);
  assert.equal(out.user.email, appleClaims.email);
});

test('apple-signin: missing code is a 422 and never reaches the token endpoint', async () => {
  const { p8 } = await makeP8();
  const fetchImpl = makeFetch(200, { access_token: 'at' });
  const res = await appleSignin(okCtx({}), { fetchImpl, APPLE_TEAM_ID: TEAM_ID, APPLE_CLIENT_ID: CLIENT_ID, APPLE_P8_PRIVATE_KEY: p8 });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('apple-signin: missing config is a 500 and never reaches the token endpoint', async () => {
  const fetchImpl = makeFetch(200, { access_token: 'at' });
  const res = await appleSignin(okCtx({ code: 'c1' }), { fetchImpl, APPLE_P8_PRIVATE_KEY: 'x' });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
});

test('apple-signin: a failing token exchange surfaces Apple\'s error', async () => {
  const { p8 } = await makeP8();
  const fetchImpl = makeFetch(400, { error: 'invalid_client', error_description: 'secret expired' });
  const env = { fetchImpl, APPLE_TEAM_ID: TEAM_ID, APPLE_CLIENT_ID: CLIENT_ID, APPLE_P8_PRIVATE_KEY: p8 };
  const res = await appleSignin(okCtx({ code: 'bad' }), env);
  assert.equal(res.status, 400);
  const out = JSON.parse(res.body);
  assert.equal(out.error, 'secret expired', "Apple's error_description is surfaced verbatim");
  assert.equal(fetchImpl.calls.length, 1);
});

test('apple-signin: a thrown fetch (network) is a 502, never an unhandled reject', async () => {
  const { p8 } = await makeP8();
  const fetchImpl = async () => {
    throw new Error('socket hang up');
  };
  const env = { fetchImpl, APPLE_TEAM_ID: TEAM_ID, APPLE_CLIENT_ID: CLIENT_ID, APPLE_P8_PRIVATE_KEY: p8 };
  const res = await appleSignin(okCtx({ code: 'c1' }), env);
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).error, /unreachable/);
});
