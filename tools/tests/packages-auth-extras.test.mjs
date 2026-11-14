// tools/tests/packages-auth-extras.test.mjs — the AUTH-EXTRAS cluster ports:
//   • ports/packages/jwt-auth.mjs            (POST /auth/jwt/login, GET /auth/jwt/user)
//   • ports/packages/firebase-php-jwt.mjs    (POST /auth/firebase/verify)
//   • ports/packages/auth0.mjs               (POST /auth/auth0/callback)
//
// Each handler is exercised for real:
//   - jwt-auth: bcryptjs-verified login, then HS256 tokens signed/verified via
//     the same WebCrypto primitives the handler uses; guards on expiry/malformed
//     tokens and bad credentials.
//   - firebase-php-jwt: RS256 ID tokens verified against a fake JWKS fetch (both
//     the JWK form and the x509-cert PEM form), with the Admin-SDK claim checks
//     (iss/aud/exp/sub) asserted.
//   - auth0: the code→token exchange against a fake token endpoint (captured
//     body/auth asserted), plus error surfacing.
// No network, no real D1: the auth seams run against real SQLite through the
// shared `tools/tests/_fake-d1.mjs`. Passwords hashed with bcryptjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  generateKeyPairSync,
  sign as nodeSign,
  createHmac,
  createPrivateKey,
} from 'node:crypto';
import bcrypt from 'bcryptjs';

import jwtAuth from '../../ports/packages/jwt-auth.mjs';
import { verifyJwt as verifyHs256, ensureSchema } from '../../ports/packages/jwt-auth.mjs';
import firebaseVerify from '../../ports/packages/firebase-php-jwt.mjs';
import auth0 from '../../ports/packages/auth0.mjs';
import { FIXTURE_CERT_PEM, FIXTURE_KEY_PEM } from './fixtures/firebase-x509-fixture.mjs';
import { FakeD1 } from './_fake-d1.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

// ---------------------------------------------------------------------------
// Request / fetch helpers
// ---------------------------------------------------------------------------
const makeReq = (method, path, { body = '{}', headers = {} } = {}) => ({
  method,
  headers: {
    get: (n) => (n.toLowerCase() === 'authorization' ? headers.authorization || null : (headers[n] ?? null)),
  },
  json: () => JSON.parse(body),
  text: () => body,
  pathInfo: () => path,
  host: () => 'port.local',
});

// A fake fetch that records the call and replies with a canned Response.
function makeFetch(status, jsonBody, { rawBody, headers } = {}) {
  const calls = [];
  const bodyText = rawBody !== undefined ? rawBody : JSON.stringify(jsonBody);
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null, forEach() {} },
      json: async () => (rawBody === undefined ? jsonBody : JSON.parse(rawBody)),
      text: async () => bodyText,
    };
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
// Key material for the firebase tests (RS256, JWK + real X.509 cert)
// ---------------------------------------------------------------------------
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_PAIR = {
  publicJwk: publicKey.export({ format: 'jwk' }),
  privateKey,
  publicKey,
  kid: 'test-key-1',
};
KEY_PAIR.publicJwk.kid = KEY_PAIR.kid;

// Sign a compact JWS with an RS256 private key and arbitrary header/payload.
function signRs256(header, payload, key = privateKey) {
  const enc = new TextEncoder();
  const b64url = (bytes) =>
    Buffer.from(bytes).toString('base64url').replace(/=+$/, '');
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const sig = nodeSign('sha256', Buffer.from(`${h}.${p}`), key);
  return `${h}.${p}.${sig.toString('base64url').replace(/=+$/, '')}`;
}

const hsEnc = new TextEncoder();
const hsB64url = (bytes) => Buffer.from(bytes).toString('base64url').replace(/=+$/, '');
function signHs256(header, payload, secret) {
  const h = hsB64url(hsEnc.encode(JSON.stringify(header)));
  const p = hsB64url(hsEnc.encode(JSON.stringify(payload)));
  const sig = createHmac('sha256', Buffer.from(String(secret))).update(`${h}.${p}`).digest();
  return `${h}.${p}.${sig.toString('base64url').replace(/=+$/, '')}`;
}

// ---- jwt-auth: login --------------------------------------------------------

test('jwt-auth: valid email+password mints an HS256 JWT with correct claims', async () => {
  const passwordHash = await bcrypt.hash('s3cret!', 4);
  const env = {
    DB: new FakeD1(),
    JWT_SECRET: 'test-secret-key',
    JWT_TTL: 1800,
  };
  await ensureSchema(env);
  await env.DB.prepare('INSERT INTO users (id, name, email, password) VALUES (?1, ?2, ?3, ?4)')
    .bind(7, 'Ada Lovelace', 'ada@example.com', passwordHash).run();

  const ctx = { request: makeReq('POST', '/auth/jwt/login', { body: JSON.stringify({ email: 'ada@example.com', password: 's3cret!' }) }), params: {} };
  const res = await jwtAuth(ctx, env);

  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.user.id, 7);
  assert.equal(out.user.email, 'ada@example.com');
  assert.equal(out.user.password, undefined, 'never leak the password hash');

  const payload = await verifyHs256(out.token, env.JWT_SECRET);
  assert.ok(payload, 'token round-trips through the handler verify path');
  assert.equal(payload.sub, '7');
  assert.equal(payload.email, 'ada@example.com');
  assert.equal(payload.exp - payload.iat, 1800, 'JWT_TTL honoured');
  assert.equal(payload.iat, payload.nbf);
});

test('jwt-auth: wrong password / unknown email → 422, no token minted', async () => {
  const env = {
    DB: new FakeD1(),
    JWT_SECRET: 'test-secret-key',
  };
  await ensureSchema(env);
  await env.DB.prepare('INSERT INTO users (id, name, email, password) VALUES (?1, ?2, ?3, ?4)')
    .bind(1, 'Ada', 'ada@example.com', await bcrypt.hash('right', 4)).run();

  const badPw = await jwtAuth(
    { request: makeReq('POST', '/auth/jwt/login', { body: JSON.stringify({ email: 'ada@example.com', password: 'wrong' }) }), params: {} },
    env,
  );
  assert.equal(badPw.status, 422);
  assert.match(JSON.parse(badPw.body).message, /credentials do not match/i);

  const missing = await jwtAuth(
    { request: makeReq('POST', '/auth/jwt/login', { body: JSON.stringify({ email: 'ghost@example.com', password: 'x' }) }), params: {} },
    env,
  );
  assert.equal(missing.status, 422);

  const noFields = await jwtAuth({ request: makeReq('POST', '/auth/jwt/login', { body: '{}' }), params: {} }, env);
  assert.equal(noFields.status, 422);
});

// ---- jwt-auth: user (middleware) ----------------------------------------------

test('jwt-auth: /auth/jwt/user returns the user for a valid Bearer HS256 JWT', async () => {
  const env = {
    DB: new FakeD1(),
    JWT_SECRET: 'test-secret-key',
  };
  await ensureSchema(env);
  await env.DB.prepare('INSERT INTO users (id, name, email, password) VALUES (?1, ?2, ?3, ?4)')
    .bind(11, 'Grace Hopper', 'grace@example.com', 'x').run();

  const token = signHs256(
    { alg: 'HS256', typ: 'JWT' },
    { sub: '11', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 },
    env.JWT_SECRET,
  );
  const ctx = {
    request: makeReq('GET', '/auth/jwt/user', { headers: { authorization: `Bearer ${token}` } }),
    params: {}
  };
  const res = await jwtAuth(ctx, env);
  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.user.id, 11);
  assert.equal(out.user.email, 'grace@example.com');
  assert.equal(out.user.password, undefined);
});

test('jwt-auth: /auth/jwt/user rejects expired, tampered and missing tokens', async () => {
  const env = {
    DB: new FakeD1(),
    JWT_SECRET: 'test-secret-key',
  };
  await ensureSchema(env);
  await env.DB.prepare('INSERT INTO users (id, name, email, password) VALUES (?1, ?2, ?3, ?4)')
    .bind(1, 'A', 'a@example.com', 'x').run();

  const now = Math.floor(Date.now() / 1000);
  const expired = await signHs256({ alg: 'HS256', typ: 'JWT' }, { sub: '1', iat: now - 120, exp: now - 60 }, env.JWT_SECRET);
  const expiredRes = await jwtAuth({ request: makeReq('GET', '/auth/jwt/user', { headers: { authorization: `Bearer ${expired}` } }), params: {} }, env);
  assert.equal(expiredRes.status, 401);

  // Tampered payload (sub flipped to second user) fails signature.
  const [h, , s] = await signHs256({ alg: 'HS256', typ: 'JWT' }, { sub: '1', exp: now + 600 }, env.JWT_SECRET).split('.');
  const tamperedPayload = hsB64url(hsEnc.encode(JSON.stringify({ sub: '999', exp: now + 600 })));
  const tampered = `${h}.${tamperedPayload}.${s}`;
  const tamperedRes = await jwtAuth({ request: makeReq('GET', '/auth/jwt/user', { headers: { authorization: `Bearer ${tampered}` } }), params: {} }, env);
  assert.equal(tamperedRes.status, 401);

  const noToken = await jwtAuth({ request: makeReq('GET', '/auth/jwt/user'), params: {} }, env);
  assert.equal(noToken.status, 401);

  const wrongAlg = await signHs256({ alg: 'none', typ: 'JWT' }, { sub: '1', exp: now + 600 }, env.JWT_SECRET);
  const wrongAlgRes = await jwtAuth({ request: makeReq('GET', '/auth/jwt/user', { headers: { authorization: `Bearer ${wrongAlg}` } }), params: {} }, env);
  assert.equal(wrongAlgRes.status, 401, 'alg=none must not be accepted');
});

// ---- firebase-php-jwt: verify (JWK form) --------------------------------------

test('firebase: verify accepts a token signed by the JWK endpoint key (JWKS cache)', async () => {
  // Fail the first JWKS fetch, succeed the second — proves cache-retry semantics.
  const fetchImpl = makeFetch(200, { keys: [KEY_PAIR.publicJwk] });
  const env = {
    fetchImpl,
    FIREBASE_PROJECT_ID: 'my-app-123',
  };
  const now = Math.floor(Date.now() / 1000);
  const idToken = signRs256(
    { alg: 'RS256', kid: KEY_PAIR.kid, typ: 'JWT' },
    {
      iss: 'https://securetoken.google.com/my-app-123',
      aud: 'my-app-123',
      exp: now + 3600,
      iat: now,
      sub: 'firebase-uid-1',
      email: 'dev@example.com',
      name: 'Dev',
      email_verified: true,
    },
    KEY_PAIR.privateKey,
  );

  const res = await firebaseVerify({ request: makeReq('POST', '/auth/firebase/verify', { body: JSON.stringify({ idToken }) }), params: {} }, env);

  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.ok, true);
  assert.equal(out.user.sub, 'firebase-uid-1');
  assert.equal(out.user.email, 'dev@example.com');
  assert.equal(out.user.aud, 'my-app-123');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');

  // Second call hits the same cache — zero new subrequests.
  const res2 = await firebaseVerify({ request: makeReq('POST', '/auth/firebase/verify', { body: JSON.stringify({ idToken }) }), params: {} }, env);
  assert.equal(res2.status, 200);
  assert.equal(fetchImpl.calls.length, 1, 'key set is cached for the isolate lifetime');
});

test('firebase: verify rejects a tampered signature and wrong claims', async () => {
  const env = {
    fetchImpl: makeFetch(200, { keys: [KEY_PAIR.publicJwk] }),
    FIREBASE_PROJECT_ID: 'my-app-123',
    FIREBASE_JWKS_URL: 'https://example.test/jwks',
  };
  const now = Math.floor(Date.now() / 1000);

  const badSig = signRs256(
    { alg: 'RS256', kid: KEY_PAIR.kid, typ: 'JWT' },
    { iss: 'https://securetoken.google.com/my-app-123', aud: 'my-app-123', sub: 'u1', exp: now + 3600, iat: now },
    KEY_PAIR.privateKey,
  );
  // Corrupt the signature bytes without re-signing.
  const [h, p, s] = badSig.split('.');
  const flipped = s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA');
  const tampered = await firebaseVerify({ request: makeReq('POST', '/auth/firebase/verify', { body: JSON.stringify({ idToken: `${h}.${p}.${flipped}` }) }), params: {} }, env);
  assert.equal(tampered.status, 401);
  assert.match(JSON.parse(tampered.body).error, /signature/i);

  const wrongAud = await firebaseVerify(
    { request: makeReq('POST', '/auth/firebase/verify', { body: JSON.stringify({ idToken: signRs256({ alg: 'RS256', kid: KEY_PAIR.kid, typ: 'JWT' }, { iss: 'https://securetoken.google.com/my-app-123', aud: 'other-app', sub: 'u1', exp: now + 3600, iat: now }, KEY_PAIR.privateKey) }) }), params: {} },
    env,
  );
  assert.equal(wrongAud.status, 401);
  assert.match(JSON.parse(wrongAud.body).error, /audience/i);

  const expired = await firebaseVerify(
    { request: makeReq('POST', '/auth/firebase/verify', { body: JSON.stringify({ idToken: signRs256({ alg: 'RS256', kid: KEY_PAIR.kid, typ: 'JWT' }, { iss: 'https://securetoken.google.com/my-app-123', aud: 'my-app-123', sub: 'u1', exp: now - 60, iat: now - 120 }, KEY_PAIR.privateKey) }) }), params: {} },
    env,
  );
  assert.equal(expired.status, 401);
  assert.match(JSON.parse(expired.body).error, /expired/i);
});

test('firebase: verify accepts the x509 certificate PEM form (SPKI peeled from cert)', async () => {
  // Fixture cert embeds the public half of FIXTURE_KEY_PEM, so a token signed
  // with that key verifies against the certificate's extracted SPKI.
  const fixtureKey = createPrivateKey(FIXTURE_KEY_PEM);
  const env = {
    fetchImpl: makeFetch(200, { 'firebase-cert-kid': FIXTURE_CERT_PEM }),
    FIREBASE_PROJECT_ID: 'my-app-123',
    FIREBASE_JWKS_URL: 'https://example.test/x509',
  };
  const now = Math.floor(Date.now() / 1000);
  const idToken = signRs256(
    { alg: 'RS256', kid: 'firebase-cert-kid', typ: 'JWT' },
    { iss: 'https://securetoken.google.com/my-app-123', aud: 'my-app-123', sub: 'u9', exp: now + 3600, iat: now },
    fixtureKey,
  );
  const res = await firebaseVerify({ request: makeReq('POST', '/auth/firebase/verify', { body: JSON.stringify({ idToken }) }), params: {} }, env);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).user.sub, 'u9');
});

test('firebase: missing idToken / unconfigured project → guarded before any fetch', async () => {
  const fetchImpl = makeFetch(200, { keys: [KEY_PAIR.publicJwk] });
  const noToken = await firebaseVerify({ request: makeReq('POST', '/auth/firebase/verify', { body: '{}' }), params: {} }, { fetchImpl, FIREBASE_PROJECT_ID: 'p' });
  assert.equal(noToken.status, 422);
  assert.equal(fetchImpl.calls.length, 0, 'no subrequest on a validation failure');

  const noProject = await firebaseVerify({ request: makeReq('POST', '/auth/firebase/verify', { body: JSON.stringify({ idToken: 'a.b.c' }) }), params: {} }, { fetchImpl });
  assert.equal(noProject.status, 500);
  assert.match(JSON.parse(noProject.body).error, /FIREBASE_PROJECT_ID/);
});

// ---- auth0: callback ----------------------------------------------------------

test('auth0: callback exchanges the code at https://{domain}/oauth/token and returns tokens', async () => {
  const fetchImpl = makeFetch(200, {
    access_token: 'eyJacc',
    id_token: 'eyJid',
    refresh_token: 'rt1',
    expires_in: 86400,
    token_type: 'Bearer',
    scope: 'openid profile email',
  });
  const env = {
    fetchImpl,
    AUTH0_DOMAIN: 'dev-abc123.us.auth0.com',
    AUTH0_CLIENT_ID: 'cid_123',
    AUTH0_CLIENT_SECRET: 'csecret_456',
    AUTH0_REDIRECT_URI: 'https://app.example.com/callback',
    AUTH0_AUDIENCE: 'https://api.example.com',
  };
  const ctx = { request: makeReq('POST', '/auth/auth0/callback', { body: JSON.stringify({ code: 'auth0code_xyz' }) }), params: {} };

  const res = await auth0(ctx, env);

  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.access_token, 'eyJacc');
  assert.equal(out.refresh_token, 'rt1');
  assert.equal(out.expires_in, 86400);

  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://dev-abc123.us.auth0.com/oauth/token');
  assert.equal(call.init.method, 'POST');
  assert.match(call.init.headers['content-type'], /application\/x-www-form-urlencoded/);
  const sent = new URLSearchParams(call.init.body);
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('client_id'), 'cid_123');
  assert.equal(sent.get('client_secret'), 'csecret_456');
  assert.equal(sent.get('redirect_uri'), 'https://app.example.com/callback');
  assert.equal(sent.get('code'), 'auth0code_xyz');
  assert.equal(sent.get('audience'), 'https://api.example.com');
});

test('auth0: surfaces a non-2xx grant error and guards a missing code', async () => {
  const fetchImpl = makeFetch(400, { error: 'invalid_grant', error_description: 'The code is expired or was already used.' });
  const env = {
    fetchImpl,
    AUTH0_DOMAIN: 'dev-abc123.us.auth0.com',
    AUTH0_CLIENT_ID: 'cid',
    AUTH0_CLIENT_SECRET: 'sec',
    AUTH0_REDIRECT_URI: 'https://app.example.com/callback',
  };
  const res = await auth0({ request: makeReq('POST', '/auth/auth0/callback', { body: JSON.stringify({ code: 'expired' }) }), params: {} }, env);
  assert.equal(res.status, 401);
  const out = JSON.parse(res.body);
  assert.equal(out.error, 'invalid_grant');
  assert.match(out.message, /expired/);

  const noCode = await auth0({ request: makeReq('POST', '/auth/auth0/callback', { body: '{}' }), params: {} }, env);
  assert.equal(noCode.status, 400);
  assert.equal(fetchImpl.calls.length, 1, 'only the successful exchange attempt made it out');
});

test('auth0: missing domain config → 500 server_configuration', async () => {
  const res = await auth0({ request: makeReq('POST', '/auth/auth0/callback', { body: JSON.stringify({ code: 'x' }) }), params: {} }, { fetchImpl: makeFetch(200, {}) });
  assert.equal(res.status, 500);
  assert.equal(JSON.parse(res.body).error, 'server_configuration');
});
