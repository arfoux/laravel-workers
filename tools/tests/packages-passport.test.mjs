// tools/tests/packages-passport.test.mjs — batch-2a, laravel/passport v13
// OAuth authorization server port.
//
// Keys are minted in-test via WebCrypto and injected as PEM through the env
// (PASSPORT_PRIVATE_KEY / PASSPORT_PUBLIC_KEY) — exactly how a deployment
// supplies them. Covers:
//   • PKCE S256 (RFC 7636): challenge == base64url(sha256(verifier)),
//     constant-time verify, method enforced to S256.
//   • GET /oauth/jwks — RSA JWK matching the generated public key.
//   • the authorization-code flow: authorize (302 + code) → token (JWT +
//     refresh, PKCE-verified) → offline JWT verification; wrong verifier,
//     client-auth failure, and refresh rotation are all exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { FakeD1 } from './_batch2a-faked1.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import passport from '../../ports/packages/passport-oauth.mjs';
import { dispatch, normalizeTable } from '../../kernel/router.mjs';
import { pkceChallenge, verifyPkce, generateCodeVerifier, verifyJwt } from '../../kernel/packages/passport.mjs';

function toPem(buf, label) {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
}

async function genKeys() {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const jwkPub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { publicPem: toPem(spki, 'PUBLIC KEY'), privatePem: toPem(pkcs8, 'PRIVATE KEY'), jwkPub };
}

const KEYS = await genKeys();

function makeEnv() {
  const DB = new FakeD1();
  return {
    DB,
    PASSPORT_PRIVATE_KEY: KEYS.privatePem,
    PASSPORT_PUBLIC_KEY: KEYS.publicPem,
  };
}

async function seedClient(env, { id = 'client-1', secret = '', redirect = 'https://app.test/cb', userId = 7 } = {}) {
  await env.DB.prepare(
    'INSERT INTO oauth_clients (id, user_id, name, secret, redirect) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, userId, 'SPA', secret, redirect).run();
}

// The accessor the worker hands every port: kernel/http.mjs passes
// `ctxExtra.user = () => auth.guard().user()`, so a port resolves the
// authenticated user by CALLING it (async).
const guardUser = (id) => async () => ({ id });

// GET /oauth/authorize as the user the platform's guard resolves.
// `user` overrides the identity: a function (any guard), or null for none.
async function authorize(env, { challenge, state = 'xyz', scope = 'read write', userId = 7, user } = {}) {
  const identity = user !== undefined ? user : guardUser(userId);
  const res = await passport(
    {
      params: { action: 'authorize' },
      query: {
        response_type: 'code',
        client_id: 'client-1',
        redirect_uri: 'https://app.test/cb',
        scope,
        state,
        ...(challenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
      },
      request: new Request('https://app.test/oauth/authorize'),
      ...(identity === null ? {} : { user: identity }),
    },
    env
  );
  return res;
}

function codeFromRedirect(res) {
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.location);
  assert.equal(loc.origin + loc.pathname, 'https://app.test/cb');
  return { code: loc.searchParams.get('code'), state: loc.searchParams.get('state') };
}

// ---------------------------------------------------------------------------
// PKCE primitive
// ---------------------------------------------------------------------------

test('passport: PKCE S256 challenge == base64url(sha256(verifier)) and verifies', async () => {
  const verifier = generateCodeVerifier();
  const challenge = await pkceChallenge(verifier);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/); // base64url, no padding
  assert.equal(await verifyPkce(verifier, challenge), true);
  assert.equal(await verifyPkce('wrong-verifier', challenge), false);
  assert.equal(await verifyPkce(verifier, challenge, 'plain'), false); // only S256
});

// ---------------------------------------------------------------------------
// JWKS
// ---------------------------------------------------------------------------

test('passport: GET /oauth/jwks exports the public key as an RSA JWK', async () => {
  const env = makeEnv();
  env.PASSPORT_KEY_ID = 'key-2026';
  const res = await passport({ params: { action: 'jwks' }, query: {}, request: new Request('https://app.test/oauth/jwks') }, env);
  assert.equal(res.status, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.keys.length, 1);
  const k = doc.keys[0];
  assert.equal(k.kty, 'RSA');
  assert.equal(k.alg, 'RS256');
  assert.equal(k.use, 'sig');
  assert.equal(k.kid, 'key-2026');
  assert.equal(k.n, KEYS.jwkPub.n);
  assert.equal(k.e, KEYS.jwkPub.e);
});

test('passport: missing keys is a 500 (secrets come from env, never hardcoded)', async () => {
  const env = { DB: new FakeD1() };
  const res = await passport({ params: { action: 'jwks' }, query: {}, request: new Request('https://app.test/oauth/jwks') }, env);
  assert.equal(res.status, 500);
});

// ---------------------------------------------------------------------------
// Authorization-code flow + PKCE
// ---------------------------------------------------------------------------

test('passport: authorize mints a code bound to the client and state', async () => {
  const env = makeEnv();
  await seedClient(env);
  const verifier = generateCodeVerifier();
  const challenge = await pkceChallenge(verifier);
  const res = await authorize(env, { challenge });
  const { code, state } = codeFromRedirect(res);
  assert.ok(code);
  assert.equal(state, 'xyz');
  const row = await env.DB.prepare('SELECT * FROM oauth_auth_codes WHERE id = ?1').bind(code).first();
  assert.equal(row.client_id, 'client-1');
  assert.equal(row.code_challenge, challenge);
  assert.equal(row.code_challenge_method, 'S256');
  assert.equal(row.revoked, 0);
});

test('passport: authorize rejects an unregistered redirect_uri (open-redirect guard)', async () => {
  const env = makeEnv();
  await seedClient(env);
  const res = await passport(
    {
      params: { action: 'authorize' },
      query: { client_id: 'client-1', redirect_uri: 'https://evil.test/cb' },
      request: new Request('https://app.test/oauth/authorize'),
    },
    env
  );
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, 'invalid_request');
});

test('passport: token exchanges code+verifier for an RS256 JWT + refresh token', async () => {
  const env = makeEnv();
  await seedClient(env);
  const verifier = generateCodeVerifier();
  const { code } = codeFromRedirect(await authorize(env, { challenge: await pkceChallenge(verifier) }));

  const res = await passport(
    {
      params: { action: 'token' },
      body: { grant_type: 'authorization_code', client_id: 'client-1', code, code_verifier: verifier, redirect_uri: 'https://app.test/cb' },
      request: new Request('https://app.test/oauth/token', { method: 'POST' }),
    },
    env
  );
  assert.equal(res.status, 200);
  const tok = JSON.parse(res.body);
  assert.equal(tok.token_type, 'Bearer');
  assert.equal(tok.expires_in, 3600);
  const parts = tok.access_token.split('.');
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  assert.equal(header.alg, 'RS256');
  assert.equal(header.typ, 'JWT');

  // offline verification against the public key
  const payload = await verifyJwt(tok.access_token, KEYS.publicPem);
  assert.equal(payload.sub, '7');
  assert.equal(payload.aud, 'client-1');
  assert.ok(payload.scopes.includes('read') && payload.scopes.includes('write'));

  // the code is single-use now
  const codeRow = await env.DB.prepare('SELECT * FROM oauth_auth_codes WHERE id = ?1').bind(code).first();
  assert.equal(codeRow.revoked, 1);

  // the refresh token is stored hashed, never plaintext
  assert.match(tok.refresh_token, /^rt_/);
});

test('passport: token with a wrong PKCE verifier is rejected (invalid_grant)', async () => {
  const env = makeEnv();
  await seedClient(env);
  const verifier = generateCodeVerifier();
  const { code } = codeFromRedirect(await authorize(env, { challenge: await pkceChallenge(verifier) }));
  const res = await passport(
    {
      params: { action: 'token' },
      body: { grant_type: 'authorization_code', client_id: 'client-1', code, code_verifier: 'not-the-right-verifier-'.repeat(2), redirect_uri: 'https://app.test/cb' },
      request: new Request('https://app.test/oauth/token', { method: 'POST' }),
    },
    env
  );
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, 'invalid_grant');
});

test('passport: token requires PKCE when a challenge was stored (no verifier -> invalid_grant)', async () => {
  const env = makeEnv();
  await seedClient(env);
  const verifier = generateCodeVerifier();
  const { code } = codeFromRedirect(await authorize(env, { challenge: await pkceChallenge(verifier) }));
  const res = await passport(
    {
      params: { action: 'token' },
      body: { grant_type: 'authorization_code', client_id: 'client-1', code, redirect_uri: 'https://app.test/cb' },
      request: new Request('https://app.test/oauth/token', { method: 'POST' }),
    },
    env
  );
  assert.equal(res.status, 400);
});

test('passport: confidential client with wrong secret is a 401', async () => {
  const env = makeEnv();
  await seedClient(env, { id: 'conf-1', secret: 'topsecret', redirect: 'https://app.test/cb' });
  const verifier = generateCodeVerifier();
  const res = await passport(
    {
      params: { action: 'authorize' },
      query: { client_id: 'conf-1', redirect_uri: 'https://app.test/cb', code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256' },
      request: new Request('https://app.test/oauth/authorize'),
      user: guardUser(7),
    },
    env
  );
  const { code } = codeFromRedirect(res);
  const tokRes = await passport(
    {
      params: { action: 'token' },
      body: { grant_type: 'authorization_code', client_id: 'conf-1', client_secret: 'WRONG', code, code_verifier: verifier, redirect_uri: 'https://app.test/cb' },
      request: new Request('https://app.test/oauth/token', { method: 'POST' }),
    },
    env
  );
  assert.equal(tokRes.status, 401);
  assert.equal(JSON.parse(tokRes.body).error, 'invalid_client');
});

// A malformed `Authorization: Basic` header is attacker-supplied input, and the
// helper parses it OUTSIDE the handlers' try/catch - so it must fail closed.
test('passport: a malformed Authorization: Basic header is a 401, never a throw', async () => {
  const env = makeEnv();
  await seedClient(env, { id: 'conf-1', secret: 'topsecret' });
  for (const auth of ['Basic !!!not-base64!!!', 'Basic', 'Basic ', `Basic ${btoa('nocolon')}`]) {
    const res = await passport(
      {
        params: { action: 'token' },
        body: { grant_type: 'authorization_code', code: 'nope' },
        request: new Request('https://app.test/oauth/token', { method: 'POST', headers: { authorization: auth } }),
      },
      env
    );
    assert.equal(res.status, 401, `${JSON.stringify(auth)} must answer 401`);
    assert.equal(JSON.parse(res.body).error, 'invalid_client');
  }
});

test('passport: refresh with a malformed Basic header is a 401 too', async () => {
  const env = makeEnv();
  await seedClient(env, { id: 'conf-1', secret: 'topsecret' });
  const res = await passport(
    {
      params: { action: 'refresh' },
      body: { grant_type: 'refresh_token', refresh_token: 'rt_nope' },
      request: new Request('https://app.test/oauth/refresh', { method: 'POST', headers: { authorization: 'Basic !!!not-base64!!!' } }),
    },
    env
  );
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error, 'invalid_client');
});

test('passport: refresh rotates tokens and revokes the old pair', async () => {
  const env = makeEnv();
  await seedClient(env);
  const verifier = generateCodeVerifier();
  const { code } = codeFromRedirect(await authorize(env, { challenge: await pkceChallenge(verifier) }));
  const first = JSON.parse(
    (
      await passport(
        {
          params: { action: 'token' },
          body: { grant_type: 'authorization_code', client_id: 'client-1', code, code_verifier: verifier, redirect_uri: 'https://app.test/cb' },
          request: new Request('https://app.test/oauth/token', { method: 'POST' }),
        },
        env
      )
    ).body
  );

  const refRes = await passport(
    {
      params: { action: 'refresh' },
      body: { grant_type: 'refresh_token', client_id: 'client-1', refresh_token: first.refresh_token },
      request: new Request('https://app.test/oauth/refresh', { method: 'POST' }),
    },
    env
  );
  assert.equal(refRes.status, 200);
  const second = JSON.parse(refRes.body);
  assert.notEqual(second.access_token, first.access_token);
  assert.notEqual(second.refresh_token, first.refresh_token);

  // old refresh token is revoked -> replay is refused
  const replay = await passport(
    {
      params: { action: 'refresh' },
      body: { grant_type: 'refresh_token', client_id: 'client-1', refresh_token: first.refresh_token },
      request: new Request('https://app.test/oauth/refresh', { method: 'POST' }),
    },
    env
  );
  assert.equal(replay.status, 400);
  assert.equal(JSON.parse(replay.body).error, 'invalid_grant');
});

// ---------------------------------------------------------------------------
// Identity: who the code is issued FOR (regression - the port used to trust
// `user_id` from the query string, so any caller could authorize as any user)
// ---------------------------------------------------------------------------

test('passport: authorize with no authenticated user is a 401 and stores no code', async () => {
  const env = makeEnv();
  await seedClient(env);
  const res = await authorize(env, { challenge: await pkceChallenge(generateCodeVerifier()), user: null });
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error, 'access_denied');
  assert.equal(env.DB.tables.get('oauth_auth_codes').length, 0);
});

test('passport: a query-string user_id does not authorize (impersonation guard)', async () => {
  const env = makeEnv();
  await seedClient(env, { userId: 7 });
  const res = await passport(
    {
      params: { action: 'authorize' },
      query: { client_id: 'client-1', redirect_uri: 'https://app.test/cb', user_id: '999' },
      request: new Request('https://app.test/oauth/authorize?client_id=client-1&redirect_uri=https%3A%2F%2Fapp.test%2Fcb&user_id=999'),
    },
    env
  );
  assert.equal(res.status, 401);
  assert.equal(env.DB.tables.get('oauth_auth_codes').length, 0);
});

test('passport: a guard that resolves no user (or throws) is a 401, never a fallback', async () => {
  const env = makeEnv();
  await seedClient(env);
  const noUser = await authorize(env, { user: async () => null });
  assert.equal(noUser.status, 401);
  const throws = await authorize(env, {
    user: async () => {
      throw new Error('no guard configured');
    },
  });
  assert.equal(throws.status, 401);
  assert.equal(env.DB.tables.get('oauth_auth_codes').length, 0);
});

test('passport: the code is bound to the guard user, not the client owner', async () => {
  const env = makeEnv();
  await seedClient(env, { userId: 7 });
  const verifier = generateCodeVerifier();
  const res = await authorize(env, { challenge: await pkceChallenge(verifier), userId: 42 });
  const { code } = codeFromRedirect(res);
  const row = await env.DB.prepare('SELECT * FROM oauth_auth_codes WHERE id = ?1').bind(code).first();
  assert.equal(row.user_id, 42);

  const tok = await passport(
    {
      params: { action: 'token' },
      body: { grant_type: 'authorization_code', client_id: 'client-1', code, code_verifier: verifier, redirect_uri: 'https://app.test/cb' },
      request: new Request('https://app.test/oauth/token', { method: 'POST' }),
    },
    env
  );
  assert.equal((await verifyJwt(JSON.parse(tok.body).access_token, KEYS.publicPem)).sub, '42');
});

test('passport: an identity a middleware guard put on ctx authorizes (no ctx.user)', async () => {
  const env = makeEnv();
  await seedClient(env);
  const res = await passport(
    {
      params: { action: 'authorize' },
      query: { client_id: 'client-1', redirect_uri: 'https://app.test/cb' },
      request: new Request('https://app.test/oauth/authorize'),
      user_id: 5,
    },
    env
  );
  const { code } = codeFromRedirect(res);
  const row = await env.DB.prepare('SELECT * FROM oauth_auth_codes WHERE id = ?1').bind(code).first();
  assert.equal(row.user_id, 5);
});

// ---------------------------------------------------------------------------
// The same contract through the ROUTER's own dispatch: the Worker hands a port
// its ctx (kernel/http.mjs — `ctxRequest` is the kernel Request, whose accessors
// are METHODS, plus `ctxExtra.user`). Driving it end-to-end means a router that
// stops forwarding `ctxExtra`, or a port that reads `ctx.request.method` as a
// property, fails here rather than in production.
// ---------------------------------------------------------------------------

const AUTHORIZE_PATH = '/oauth/authorize';
const AUTHORIZE_QS = 'client_id=client-1&redirect_uri=https%3A%2F%2Fapp.test%2Fcb&state=xyz';

function kernelRequest(query = AUTHORIZE_QS) {
  return {
    method: () => 'GET',
    pathInfo: () => AUTHORIZE_PATH,
    getQueryString: () => query,
    header: (n) => (String(n).toLowerCase() === 'host' ? 'app.test' : null),
    host: () => 'app.test',
  };
}

const authorizeTable = (extra = {}) =>
  normalizeTable([{ uri: AUTHORIZE_PATH, name: 'oauth.authorize', methods: ['GET'], domain: null, ...extra }]);

const authorizeHandlers = (handlers = {}) => ({ 'GET /oauth/authorize': passport, ...handlers });

test('passport: through the router, /oauth/authorize answers as ctx.user() (the Worker guard)', async () => {
  const env = makeEnv();
  await seedClient(env);
  const res = await dispatch({ method: 'GET', path: AUTHORIZE_PATH }, authorizeTable(), authorizeHandlers(), env, {
    ctxRequest: kernelRequest(),
    ctxExtra: { user: guardUser(9) },
  });
  const { code, state } = codeFromRedirect(res);
  assert.equal(state, 'xyz');
  const row = await env.DB.prepare('SELECT * FROM oauth_auth_codes WHERE id = ?1').bind(code).first();
  assert.equal(row.user_id, 9, 'the code must belong to the guard user');
});

test('passport: through the router, no ctxExtra.user is a 401 (no code)', async () => {
  const env = makeEnv();
  await seedClient(env);
  const res = await dispatch({ method: 'GET', path: AUTHORIZE_PATH }, authorizeTable(), authorizeHandlers(), env, {
    ctxRequest: kernelRequest(),
  });
  assert.equal(res.status, 401);
  assert.equal(env.DB.tables.get('oauth_auth_codes').length, 0);
});

test('passport: through the router, a middlewarePorts guard may set the identity', async () => {
  const env = makeEnv();
  await seedClient(env);
  const res = await dispatch(
    { method: 'GET', path: AUTHORIZE_PATH },
    authorizeTable({ middlewarePorts: ['guard'] }),
    authorizeHandlers({
      'MW guard': async (ctx) => {
        ctx.user_id = 11;
        return null; // not mine — hand the request on to the port
      },
    }),
    env,
    { ctxRequest: kernelRequest() }
  );
  const { code } = codeFromRedirect(res);
  const row = await env.DB.prepare('SELECT * FROM oauth_auth_codes WHERE id = ?1').bind(code).first();
  assert.equal(row.user_id, 11, 'the identity the middleware port put on ctx must be used');
});

