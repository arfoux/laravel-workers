// tools/tests/packages-adversarial-auth-webhook.test.mjs — ADVERSARIAL tests for
// the auth + webhook cluster. Unlike packages-auth-extras / packages-webhook-*
// (which prove the happy path), this file attacks the handlers the way an
// attacker would and asserts the security posture the cluster promises:
//
//   jwt-auth          (POST /auth/jwt/login, GET /auth/jwt/user)
//     - an expired-but-validly-signed token is rejected (401)
//     - a token that is not three base64url segments is rejected (401)
//     - a token smuggled in the ?token= QUERY PARAM is ignored (401) — the
//       Bearer must come from the Authorization header only
//     - repeated failed logins are observed for throttling (rate limit)
//
//   firebase-php-jwt  (POST /auth/firebase/verify)
//     - a token signed by a DIFFERENT RSA key (unknown kid) is rejected (401)
//     - a correctly-signed token whose exp is in the past is rejected (401)
//     - a malformed token (bad segment count / undecodable segment) → 401
//
//   webhook-client    (POST /webhooks/{name})
//     - a wrong HMAC signature is rejected (400) and NOT stored
//     - a valid signature re-sent with the identical body (a replay) → 200,
//       and the duplicate call is recorded
//     - a body tampered AFTER signing is rejected (400) and NOT stored
//
//   webhook-server    (POST /webhook-server/send)
//     - a non-HTTPS target url is refused (422) before any subrequest
//     - an injection-laden payload is signed AS-IS (verbatim, unescaped) so a
//       receiver's HMAC over the raw body matches byte-for-byte
//
// No network and no real D1 binding: every D1-touching seam runs against real
// SQLite through the shared `tools/tests/_fake-d1.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, generateKeyPairSync, sign as nodeSign, createHmac } from 'node:crypto';
import bcrypt from 'bcryptjs';

import jwtAuth, { ensureSchema } from '../../ports/packages/jwt-auth.mjs';
import firebaseVerify from '../../ports/packages/firebase-php-jwt.mjs';
import webhookClient from '../../ports/packages/webhook-client.mjs';
import webhookServer from '../../ports/packages/webhook-server.mjs';
import { FakeD1 } from './_fake-d1.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

// ---------------------------------------------------------------------------
// Request / fetch helpers
// ---------------------------------------------------------------------------

// A kernel-shaped request (methods, not properties) — the shape normalizePortCtx
// reads. `query` is carried on ctx so a query-param token is observable.
const makeReq = (method, path, { body = '{}', headers = {} } = {}) => ({
  method,
  headers: {
    get: (n) => {
      const k = String(n).toLowerCase();
      const found = Object.keys(headers).find((h) => h.toLowerCase() === k);
      return found ? String(headers[found]) : null;
    },
  },
  json: () => JSON.parse(body),
  text: () => body,
  pathInfo: () => path,
  host: () => 'port.local',
});

// Seed a users table with one account (id 1 / ada@example.com). The port owns
// the `users` DDL, so use its `ensureSchema` rather than restating it here.
async function seedUser(env, { email = 'ada@example.com', password = 'correct-horse' } = {}) {
  await ensureSchema(env);
  await env.DB.prepare('INSERT INTO users (id, name, email, password) VALUES (?1, ?2, ?3, ?4)')
    .bind(1, 'Ada Lovelace', email, await bcrypt.hash(password, 4))
    .run();
}

// The `webhook_calls` rows a port stored, straight out of SQLite. Both webhook
// ports create their own table via `ensureSchema`, so an untouched DB has none.
const storedCalls = (db) => db.tables.get('webhook_calls') || [];

// Sign base64(HMAC-SHA256(secret, message)) — the spatie webhook signature.
async function hmacB64(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// RS256 key material for the firebase adversarial cases
// ---------------------------------------------------------------------------
const GOOD = generateKeyPairSync('rsa', { modulusLength: 2048 });
const EVIL = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'adv-key-1';

const jwkFor = (kp) => {
  const jwk = kp.publicKey.export({ format: 'jwk' });
  jwk.kid = KID;
  return jwk;
};

// Sign a compact RS256 JWS with an arbitrary header/payload.
function signRs256(header, payload, key) {
  const enc = new TextEncoder();
  const b64url = (bytes) => Buffer.from(bytes).toString('base64url').replace(/=+$/, '');
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const sig = nodeSign('sha256', Buffer.from(`${h}.${p}`), key);
  return `${h}.${p}.${sig.toString('base64url').replace(/=+$/, '')}`;
}

// A fake JWKS fetch serving ONE key (used via a per-test unique URL so the
// module-scope key cache never collides between cases).
function jwksFetch(kp) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ keys: [jwkFor(kp)] }),
    };
  };
  impl.calls = calls;
  return impl;
}

const PROJECT = 'adv-project';

// ===========================================================================
// jwt-auth — expired / malformed / query-param / brute-force
// ===========================================================================

test('jwt-auth ADV: an expired but correctly-signed token is rejected (401)', async () => {
  const env = { DB: new FakeD1(), JWT_SECRET: 'adv-secret' };
  await seedUser(env);

  const now = Math.floor(Date.now() / 1000);
  // Signed by an independent HS256 signer with exp already in the past.
  const expired = signHs({ sub: '1', iat: now - 120, nbf: now - 120, exp: now - 60 }, env.JWT_SECRET);

  const res = await jwtAuth(
    { request: makeReq('GET', '/auth/jwt/user', { headers: { authorization: `Bearer ${expired}` } }), params: {} },
    env,
  );
  assert.equal(res.status, 401);
  assert.match(JSON.parse(res.body).message, /Unauthenticated\./i);
});

function signHs(payload, secret) {
  // Independent HS256 signer (node:crypto) — must agree with the port's WebCrypto.
  // HMAC via createHmac (a string secret is a valid HMAC key; nodeSign's raw-key
  // path would demand a key object).
  const enc = new TextEncoder();
  const b64url = (bytes) => Buffer.from(bytes).toString('base64url').replace(/=+$/, '');
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const sig = createHmac('sha256', String(secret)).update(Buffer.from(`${h}.${p}`)).digest('base64url');
  return `${h}.${p}.${sig}`;
}

test('jwt-auth ADV: a token that is not three segments is rejected (401)', async () => {
  const env = { DB: new FakeD1(), JWT_SECRET: 'adv-secret' };
  await seedUser(env);

  for (const garbage of ['not-a-jwt', 'abc.def', 'a.b.c.d', '', '....']) {
    const res = await jwtAuth(
      { request: makeReq('GET', '/auth/jwt/user', { headers: { authorization: `Bearer ${garbage}` } }), params: {} },
      env,
    );
    assert.equal(res.status, 401, `malformed token ${JSON.stringify(garbage)} must be a 401`);
  }
});

test('jwt-auth ADV: a valid token sent as a ?token= query param is ignored (401)', async () => {
  const env = { DB: new FakeD1(), JWT_SECRET: 'adv-secret' };
  await seedUser(env);

  const now = Math.floor(Date.now() / 1000);
  const token = signHs({ sub: '1', iat: now, nbf: now, exp: now + 600 }, env.JWT_SECRET);

  // No Authorization header; the token rides in the query string instead.
  const res = await jwtAuth(
    {
      request: makeReq('GET', `/auth/jwt/user?token=${encodeURIComponent(token)}`),
      params: {},
      query: { token },
    },
    env,
  );
  assert.equal(res.status, 401, 'a query-param token must never authenticate');
  assert.match(JSON.parse(res.body).message, /Unauthenticated\./i);
});

test('jwt-auth ADV: brute-force logins are observed for throttling', async () => {
  const env = { DB: new FakeD1(), JWT_SECRET: 'adv-secret' };
  await seedUser(env);

  const attempts = 25;
  const statuses = [];
  for (let i = 0; i < attempts; i += 1) {
    const res = await jwtAuth(
      {
        request: makeReq('POST', '/auth/jwt/login', {
          body: JSON.stringify({ email: 'ada@example.com', password: `wrong-${i}` }),
        }),
        params: {},
      },
      env,
    );
    statuses.push(res.status);
  }

  // Every wrong attempt is a credential failure (422). Document whether the
  // port throttles: with no rate limiter, no attempt is ever a 429.
  const throttled = statuses.filter((s) => s === 429);
  const failures = statuses.filter((s) => s === 422);
  assert.equal(failures.length, attempts, 'every wrong password stays a credential failure');
  assert.equal(
    throttled.length,
    0,
    'FINDING: jwt-auth applies no rate limiting — brute force is unthrottled (all ' +
      `${attempts} attempts returned 422, none 429). A Laravel-side throttle:api ` +
      'middleware is expected to front this route.',
  );
});

// ===========================================================================
// firebase-php-jwt — wrong key / expired / malformed
// ===========================================================================

test('firebase ADV: a token signed by a different (unknown-kid) RSA key is rejected (401)', async () => {
  // JWKS serves the GOOD key; the token is signed by EVIL but claims GOOD's kid.
  const fetchImpl = jwksFetch(GOOD);
  const token = signRs256({ alg: 'RS256', typ: 'JWT', kid: KID }, claims({}), EVIL.privateKey);

  const res = await firebaseVerify(
    { request: makeReq('POST', '/auth/firebase/verify', { body: JSON.stringify({ idToken: token }) }), params: {} },
    { FIREBASE_PROJECT_ID: PROJECT, FIREBASE_JWKS_URL: `https://jwks.test/good-${Math.random()}`, fetchImpl },
  );
  assert.equal(res.status, 401);
  assert.match(JSON.parse(res.body).error, /invalid signature|invalid token/i);
});

test('firebase ADV: an expired but correctly-signed token is rejected (401)', async () => {
  const fetchImpl = jwksFetch(GOOD);
  const now = Math.floor(Date.now() / 1000);
  const token = signRs256(
    { alg: 'RS256', typ: 'JWT', kid: KID },
    claims({ exp: now - 60, iat: now - 120 }),
    GOOD.privateKey,
  );

  const res = await firebaseVerify(
    { request: makeReq('POST', '/auth/firebase/verify', { body: JSON.stringify({ idToken: token }) }), params: {} },
    { FIREBASE_PROJECT_ID: PROJECT, FIREBASE_JWKS_URL: `https://jwks.test/exp-${Math.random()}`, fetchImpl },
  );
  assert.equal(res.status, 401);
  assert.match(JSON.parse(res.body).error, /expired/i);
});

test('firebase ADV: malformed tokens are rejected (401)', async () => {
  const fetchImpl = jwksFetch(GOOD);
  const env = { FIREBASE_PROJECT_ID: PROJECT, FIREBASE_JWKS_URL: `https://jwks.test/mal-${Math.random()}`, fetchImpl };

  const now = Math.floor(Date.now() / 1000);
  // A token whose payload segment is not base64url JSON.
  const undecodable = `eyJhbGciOiJSUzI1NiJ9.@@not-base64-json@@.c2ln`;
  // A token with the wrong segment count.
  const twoSeg = 'eyJhbGciOiJSUzI1NiJ9.cGF5bG9hZA';
  // A structurally valid JWS whose payload decodes to garbage.
  const garbagePayload = signRs256({ alg: 'RS256', typ: 'JWT', kid: KID }, { iss: 'not-the-right-issuer' }, GOOD.privateKey);

  for (const [label, token] of [
    ['undecodable-payload', undecodable],
    ['two-segments', twoSeg],
  ]) {
    const res = await firebaseVerify(
      { request: makeReq('POST', '/auth/firebase/verify', { body: JSON.stringify({ idToken: token }) }), params: {} },
      env,
    );
    assert.equal(res.status, 401, `${label} must be a 401`);
    assert.equal(JSON.parse(res.body).ok, undefined, `${label} must not return a user`);
  }

  // An empty / non-string idToken is a request-validation error (422), not an
  // auth failure — asserted separately so the 401 contract stays exact.
  const emptyRes = await firebaseVerify(
    { request: makeReq('POST', '/auth/firebase/verify', { body: '{}' }), params: {} },
    env,
  );
  assert.equal(emptyRes.status, 422);
  assert.match(JSON.parse(emptyRes.body).error, /idToken.*required/i);

  // garbagePayload decodes but fails the issuer claim → still 401.
  const wrongIss = await firebaseVerify(
    { request: makeReq('POST', '/auth/firebase/verify', { body: JSON.stringify({ idToken: garbagePayload }) }), params: {} },
    env,
  );
  assert.equal(wrongIss.status, 401);
});

// Build a claims payload that satisfies every claim check except the overrides.
function claims(overrides) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: 'attacker-uid',
    email: 'attacker@example.com',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

// ===========================================================================
// webhook-client — wrong sig / replay / post-sign tamper
// ===========================================================================

const CLIENT_SECRET = 'wh-client-secret';
const RAW = JSON.stringify({ event: 'payment.captured', data: { id: 'evt_adv', amount: 4200 } });
const clientCtx = (rawBody, headers) => ({
  request: new Request('https://edge.example/webhooks/stripe', { method: 'POST', headers, body: rawBody }),
  params: { name: 'stripe' },
  method: 'POST',
  body: {},
  query: {},
});

test('webhook-client ADV: a wrong HMAC signature is rejected (400) and not stored', async () => {
  const db = new FakeD1();
  const wrong = await hmacB64('a-different-secret', RAW);
  const res = await webhookClient(clientCtx(RAW, { 'webhook-signature': wrong }), {
    WEBHOOK_CLIENT_SECRET: CLIENT_SECRET,
    DB: db,
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, 'invalid signature');
  assert.equal(storedCalls(db).length, 0, 'a bad-signature call must never be persisted');
});

test('webhook-client ADV: a replay (valid signature, identical body re-sent) is accepted (200) and recorded', async () => {
  const sig = await hmacB64(CLIENT_SECRET, RAW);
  const db = new FakeD1();
  const env = { WEBHOOK_CLIENT_SECRET: CLIENT_SECRET, DB: db };

  const first = await webhookClient(clientCtx(RAW, { 'webhook-signature': sig }), env);
  const replay = await webhookClient(clientCtx(RAW, { 'webhook-signature': sig }), env);

  assert.equal(first.status, 200);
  assert.equal(replay.status, 200, 'the port has no replay guard — the duplicate is ACKed like the original');
  assert.equal(JSON.parse(replay.body).received, true);

  // Both deliveries are recorded (no dedup / nonce ledger).
  assert.equal(storedCalls(db).length, 2, 'FINDING: replays are not deduplicated — both calls are stored');
});

test('webhook-client ADV: a body tampered after signing is rejected (400) and not stored', async () => {
  const sig = await hmacB64(CLIENT_SECRET, RAW);
  const db = new FakeD1();
  const tampered = JSON.stringify({ event: 'payment.captured', data: { id: 'evt_adv', amount: 999999 } });
  const res = await webhookClient(clientCtx(tampered, { 'webhook-signature': sig }), {
    WEBHOOK_CLIENT_SECRET: CLIENT_SECRET,
    DB: db,
  });
  assert.equal(res.status, 400);
  assert.equal(storedCalls(db).length, 0, 'a post-sign tamper must never be persisted');
});

// ===========================================================================
// webhook-server — non-HTTPS target / payload injection signed as-is
// ===========================================================================

const SERVER_SECRET = 'wh-server-secret';
// The route is an authenticated seam (an anonymous caller would get a signing
// oracle + arbitrary-https egress), so the adversarial cases run as a caller.
const serverCtx = (body) => ({ body, query: {}, params: {}, user_id: 1 });

function makeFetch(status, jsonBody) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(JSON.stringify(jsonBody), { status, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

test('webhook-server ADV: non-HTTPS (plain http) target url is REFUSED (422)', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const db = new FakeD1();
  const res = await webhookServer(serverCtx({ url: 'http://example.com/hook', payload: {} }), {
    fetchImpl,
    DB: db,
    WEBHOOK_SERVER_SECRET: SERVER_SECRET,
  });

  // https-only is now enforced: the validator is /^https:\/\//i, so a plain
  // http:// target is REFUSED (422) and no subrequest is spent.
  assert.equal(res.status, 422, 'an insecure http:// target is refused (422)');
  assert.equal(fetchImpl.calls.length, 0, 'no subrequest is spent to an insecure http:// target');

  // The only scheme actually refused is a non-http(s) one (e.g. ftp://) — 422.
  const ftpFetch = makeFetch(200, { ok: true });
  const ftpRes = await webhookServer(serverCtx({ url: 'ftp://example.com/hook', payload: {} }), {
    fetchImpl: ftpFetch,
    DB: new FakeD1(),
    WEBHOOK_SERVER_SECRET: SERVER_SECRET,
  });
  assert.equal(ftpRes.status, 422, 'a non-http(s) scheme (ftp://) is refused');
  assert.equal(ftpFetch.calls.length, 0);
});

test('webhook-server ADV: an injection-laden payload is signed as-is (unescaped)', async () => {
  const fetchImpl = makeFetch(200, { ok: true });
  const db = new FakeD1();
  // Every flavour of injection an attacker would plant in an outbound body.
  const payload = {
    comment: '<script>alert("xss")</script>',
    name: 'Robert"); DROP TABLE users;--',
    note: 'ignored\\"}\\u0000{"injected":true}',
    html: '<img src=x onerror=alert(1)>',
  };
  const res = await webhookServer(serverCtx({ url: 'https://example.com/hook', payload }), {
    fetchImpl,
    DB: db,
    WEBHOOK_SERVER_SECRET: SERVER_SECRET,
  });

  assert.equal(res.status, 201);
  const call = fetchImpl.calls[0];
  const sentBody = call.init.body;

  // The payload travels VERBATIM — the port signs and sends it as-is with NO
  // HTML escaping applied (escaping a payload is the receiver's job, not the
  // signer's). The only transformation is JSON.stringify's own quote/backslash
  // escaping inside JSON string literals, so we assert on the content that must
  // survive transit untouched: the raw markup and SQL survive byte-for-byte.
  assert.ok(sentBody.includes('<script>'), 'script tag must not be HTML-escaped');
  assert.ok(sentBody.includes('</script>'), 'closing script tag must not be escaped');
  assert.ok(sentBody.includes('<img src=x onerror=alert(1)>'), 'raw injection markup travels verbatim');
  assert.ok(sentBody.includes('DROP TABLE users;--'), 'SQL-injection text travels verbatim');
  assert.ok(sentBody.includes('\\u0000'), 'control char kept as its JSON escape (no stripping)');
  assert.ok(!sentBody.includes('&lt;') && !sentBody.includes('&quot;') && !sentBody.includes('&#'),
    'no HTML-entity escaping applied by the signer');

  // The signature matches an independent HMAC over the EXACT sent bytes — so a
  // receiver can verify it, and a tamper anywhere in those bytes breaks it.
  const sigFromHeader = call.init.headers['webhook-signature'];
  assert.equal(typeof sigFromHeader, 'string');
  assert.ok(sigFromHeader.length > 0);
  assert.equal(sigFromHeader, createHmac('sha256', SERVER_SECRET).update(sentBody).digest('base64'));
  assert.notEqual(sigFromHeader, createHmac('sha256', SERVER_SECRET).update(sentBody + 'x').digest('base64'));

  // The stored row carries the same verbatim payload + matching signature.
  const rows = storedCalls(db);
  assert.equal(rows.length, 1);
  const stored = rows[0];
  assert.equal(stored.payload, sentBody, 'stored payload is the exact bytes sent');
  assert.equal(stored.signature, sigFromHeader);
});
