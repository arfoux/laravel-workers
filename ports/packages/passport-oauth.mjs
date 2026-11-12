// Port of laravel/passport v13.10 — the OAuth 2.0 authorization server
// endpoints at the edge (RS256 access tokens).
//
// Route seam: registry.json → "ports": {
//   "/oauth/authorize": "passport-oauth:authorize",
//   "/oauth/token":     "passport-oauth:token",      // authorization_code grant
//   "/oauth/refresh":   "passport-oauth:refresh",    // refresh_token grant
//   "/oauth/jwks":      "passport-oauth:jwks",
// }
// The default export dispatches on `ctx.params.action`.
//
// What runs at the edge (parity with Passport's authorization server):
//   • access token  = RS256 JWT `{ alg: RS256, typ: JWT, kid }` signed with the
//                     private key from env (kernel/packages/passport.mjs)
//   • refresh token = opaque random, stored as sha256(plaintext) (token.mjs)
//   • PKCE S256     = challenge == base64url(sha256(code_verifier)), RFC 7636
//   • /oauth/jwks   = public half exported as a JWK (RFC 7517), offline verify
//
// Identity (who the code is issued FOR): in Laravel the authorize endpoint sits
// behind the `auth` middleware, so the resource owner comes from the SESSION —
// never from the request. Same here: `resolveUserId()` reads the platform's own
// guard (`ctx.user()`, kernel/http.mjs) or an id a `middlewarePorts` guard wrote
// onto `ctx` (kernel/router.mjs). No identity → 401 `access_denied`, no code
// stored. `?user_id=` is deliberately NOT a source: an authorization request is
// client-supplied, so honouring it let any caller mint a code — and then a
// token — for any user.
//
// Keys never live in code — env secrets:
//   PASSPORT_PRIVATE_KEY (PKCS#8 PEM, "-----BEGIN PRIVATE KEY-----")
//   PASSPORT_PUBLIC_KEY  (SPKI PEM,   "-----BEGIN PUBLIC KEY------")
//   PASSPORT_KEY_ID      (optional kid; defaults to a sha256 fingerprint)
//
// D1 tables (mirrors Passport's migrations):
//   oauth_clients(id, user_id, name, secret, redirect, grant_types, scopes, ...)
//   oauth_auth_codes(id, user_id, client_id, scopes, revoked, expires_at, code_challenge, code_challenge_method, ...)
//   oauth_access_tokens(id, user_id, client_id, scopes, revoked, expires_at, ...)
//   oauth_refresh_tokens(id, access_token_id, revoked, expires_at, ...)
// The AuthorizationCode model's `code` (a JWT in Passport) is reduced here to a
// single random string (the id) + a stored challenge — the challenge is what
// PKCE needs; the code itself is only a handle to it.
//
// Substitution (disclosed): Passport stores the client `secret` hashed
// (bcrypt) and verifies via Hash::check. This port stores the client secret in
// the `secret` column and compares it with a constant-time string compare —
// the honest edge substitution (no bcrypt at the edge today). Rotate client
// secrets through the same env/DB channel you already trust.
//
// Free tier: 1-2 D1 reads + 1 write per token; signing is one RSA-2048 op
// (sub-millisecond). JWKS is a pure key export (cacheable, no D1).

import { signJwt, jwks as jwksExport, verifyPkce } from '../../kernel/packages/passport.mjs';
import { randomString } from '../../kernel/packages/token.mjs';
import { timingSafeEqual } from '../../kernel/packages/webhook.mjs';
import { normalizePortCtx, guardUserId } from '../../kernel/packages/port-ctx.mjs';
import { bytesToHex } from '../../kernel/digest.mjs';

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      name TEXT,
      secret TEXT,
      redirect TEXT NOT NULL,
      grant_types TEXT,
      scopes TEXT,
      revoked INTEGER NOT NULL DEFAULT 0
    )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS oauth_auth_codes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      scopes TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      code_challenge TEXT,
      code_challenge_method TEXT
    )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS oauth_access_tokens (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      scopes TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      expires_at TEXT
    )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      id TEXT PRIMARY KEY,
      access_token_id INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT
    )`
  ).run();
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const sha256hex = async (text) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return bytesToHex(new Uint8Array(d));
};

function json(status, payload) {
  return { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(payload) };
}

function keys(env) {
  const priv = env.PASSPORT_PRIVATE_KEY;
  const pub = env.PASSPORT_PUBLIC_KEY;
  if (!priv || !pub) throw new Error('PASSPORT_PRIVATE_KEY / PASSPORT_PUBLIC_KEY are not configured');
  return { priv, pub, kid: env.PASSPORT_KEY_ID || null };
}

function basicClient(ctx) {
  const h = (ctx.request && ctx.request.headers && ctx.request.headers.get('authorization')) || '';
  const m = /^Basic\s+(.+)$/i.exec(h.trim());
  if (!m) return {};
  let raw;
  try {
    raw = atob(m[1]);
  } catch {
    // Not base64: no client credentials. `authenticateClient` then answers 401 -
    // a malformed header must not escape this helper as a 500 (it is called
    // OUTSIDE the token/refresh handlers' try/catch).
    return {};
  }
  const i = raw.indexOf(':');
  return i === -1 ? {} : { id: raw.slice(0, i), secret: raw.slice(i + 1) };
}

async function findClient(env, clientId) {
  if (!clientId) return null;
  return env.DB.prepare('SELECT * FROM oauth_clients WHERE id = ?1').bind(String(clientId)).first();
}

// Client auth: secret from the body or HTTP Basic. Omitted when the row has no
// secret (a public / PKCE-only client).
async function authenticateClient(env, clientId, clientSecret) {
  const client = await findClient(env, clientId);
  if (!client || client.revoked) return null;
  if (client.secret) {
    if (!clientSecret || !timingSafeEqual(String(client.secret), String(clientSecret))) return null;
  }
  return client;
}

// --- caller identity ---------------------------------------------------------
// Who the authorization code belongs to. Like Laravel - where this endpoint sits
// behind the `auth` middleware - the resource owner comes from the platform's own
// guard (`guardUserId`, kernel/packages/port-ctx.mjs): `ctx.user()` — the accessor
// the worker hands every port (kernel/http.mjs: `user: () => auth.guard().user()`)
// — or an id a `middlewarePorts` guard wrote onto ctx before this handler ran
// (kernel/router.mjs). No identity => 401 `access_denied`, no code stored.
// `?user_id=` is deliberately NOT a source: an authorization request is
// client-supplied, so trusting it let any caller mint a code — and then a
// token — for any user id (the class the pusher/reverb presence fix closes too).

async function issueTokens(env, { userId, clientId, scopes, privatePem, pub, kid, ttlSeconds = 3600, refreshTtlSeconds = 60 * 60 * 24 * 14 }) {
  const expSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
  const jti = randomString(24);
  const accessToken = await signJwt(
    {
      aud: clientId,
      jti,
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000),
      exp: expSeconds,
      sub: String(userId),
      scopes,
    },
    privatePem,
    { kid }
  );
  // The row id IS the JWT's jti, so a token can be revoked by id (Passport parity).
  await env.DB.prepare(
    'INSERT INTO oauth_access_tokens (id, user_id, client_id, scopes, revoked, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
  ).bind(jti, userId, clientId, JSON.stringify(scopes), now(), new Date(expSeconds * 1000).toISOString()).run();
  const atId = jti;

  const refreshPlain = `rt_${randomString(40)}`;
  const refreshStored = await sha256hex(refreshPlain);
  const refreshExp = new Date((Math.floor(Date.now() / 1000) + refreshTtlSeconds) * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO oauth_refresh_tokens (id, access_token_id, revoked, expires_at) VALUES (?, ?, 0, ?)'
  ).bind(refreshStored, atId, refreshExp).run();

  return { token_type: 'Bearer', expires_in: ttlSeconds, access_token: accessToken, refresh_token: refreshPlain };
}

// GET /oauth/authorize — validate client + PKCE, store an auth code, redirect.
export async function handleAuthorize(ctx, env) {
  await ensureSchema(env);
  let priv, kid;
  try {
    ({ priv, kid } = keys(env));
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
  void priv;
  const q = { ...(ctx.query || {}) };
  const url = ctx.request && ctx.request.url ? new URL(ctx.request.url) : null;
  if (url) for (const [k, v] of url.searchParams) if (!(k in q)) q[k] = v;

  const clientId = q.client_id;
  const redirectUri = q.redirect_uri;
  const state = q.state || '';
  const scopes = (q.scope || q.scopes || '').split(/[\s,]+/).filter(Boolean);
  const challenge = q.code_challenge || '';
  const method = q.code_challenge_method || 'S256';

  const client = await findClient(env, clientId);
  if (!client || client.revoked) return json(404, { error: 'invalid_client', message: 'Unknown client.' });

  // The redirect_uri must be pre-registered (exact match) — open-redirect guard.
  const registered = String(client.redirect || '').split(/[\s,]+/).filter(Boolean);
  if (!redirectUri || !registered.includes(redirectUri)) {
    return json(400, { error: 'invalid_request', message: 'redirect_uri is not registered for this client.' });
  }

  // Who is authorizing: the platform's own guard (`ctx.user()`), or an identity a
  // middleware port wrote onto ctx. NOT `user_id` from the query string - an
  // authorization request is client-supplied, so trusting it let any caller mint
  // a code, and then a token, for any user id.
  const userId = await guardUserId(ctx);
  if (userId == null) {
    return json(401, { error: 'access_denied', message: 'No authenticated user for the authorization.' });
  }

  if (challenge && method !== 'S256') {
    return json(400, { error: 'invalid_request', message: 'Only code_challenge_method=S256 is supported.' });
  }

  const code = randomString(40);
  const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO oauth_auth_codes (id, user_id, client_id, scopes, revoked, expires_at, code_challenge, code_challenge_method) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
  ).bind(code, userId, clientId, JSON.stringify(scopes), exp, challenge || null, challenge ? 'S256' : null).run();

  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  return { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store' }, body: '' };
}

// POST /oauth/token — authorization_code grant (+ optional PKCE verify).
export async function handleToken(ctx, env) {
  await ensureSchema(env);
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const basic = basicClient(ctx);
  const clientId = body.client_id || basic.id;
  const clientSecret = body.client_secret || basic.secret;

  try {
    const { priv, pub, kid } = keys(env);
    if (body.grant_type && body.grant_type !== 'authorization_code') {
      return json(400, { error: 'unsupported_grant_type', message: 'Use /oauth/refresh for refresh_token.' });
    }
    const client = await authenticateClient(env, clientId, clientSecret);
    if (!client) return json(401, { error: 'invalid_client', message: 'Client authentication failed.' });

    const code = body.code;
    if (!code) return json(400, { error: 'invalid_request', message: 'The code field is required.' });
    const authCode = await env.DB.prepare('SELECT * FROM oauth_auth_codes WHERE id = ?1').bind(String(code)).first();
    if (!authCode || authCode.revoked) return json(400, { error: 'invalid_grant', message: 'The authorization code is invalid.' });
    if (authCode.client_id !== String(clientId)) return json(400, { error: 'invalid_grant', message: 'Code was not issued to this client.' });
    if (authCode.expires_at && new Date(authCode.expires_at).getTime() < Date.now()) {
      return json(400, { error: 'invalid_grant', message: 'The authorization code has expired.' });
    }

    // PKCE: if a challenge was stored, a matching verifier is mandatory.
    if (authCode.code_challenge) {
      const verifier = body.code_verifier;
      const ok = verifier
        ? await verifyPkce(String(verifier), String(authCode.code_challenge), authCode.code_challenge_method || 'S256')
        : false;
      if (!ok) return json(400, { error: 'invalid_grant', message: 'PKCE verification failed.' });
    }

    // Single use: revoke the code.
    await env.DB.prepare('UPDATE oauth_auth_codes SET revoked = 1 WHERE id = ?').bind(String(code)).run();

    const scopes = authCode.scopes ? JSON.parse(authCode.scopes) : [];
    const tokens = await issueTokens(env, {
      userId: authCode.user_id,
      clientId,
      scopes,
      privatePem: priv,
      pub,
      kid,
    });
    return json(200, tokens);
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
}

// POST /oauth/refresh — refresh_token grant, rotates the refresh token.
export async function handleRefresh(ctx, env) {
  await ensureSchema(env);
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const basic = basicClient(ctx);
  const clientId = body.client_id || basic.id;
  const clientSecret = body.client_secret || basic.secret;

  try {
    const { priv, pub, kid } = keys(env);
    const client = await authenticateClient(env, clientId, clientSecret);
    if (!client) return json(401, { error: 'invalid_client', message: 'Client authentication failed.' });

    const presented = body.refresh_token;
    if (!presented) return json(400, { error: 'invalid_request', message: 'The refresh_token field is required.' });
    const stored = await sha256hex(presented);
    const row = await env.DB.prepare('SELECT * FROM oauth_refresh_tokens WHERE id = ?1').bind(stored).first();
    if (!row || row.revoked) return json(400, { error: 'invalid_grant', message: 'The refresh token is invalid.' });
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return json(400, { error: 'invalid_grant', message: 'The refresh token has expired.' });
    }

    const at = await env.DB.prepare('SELECT * FROM oauth_access_tokens WHERE id = ?1').bind(row.access_token_id).first();
    if (!at || at.revoked) return json(400, { error: 'invalid_grant', message: 'The access token was revoked.' });
    if (String(at.client_id) !== String(clientId)) return json(400, { error: 'invalid_grant', message: 'Refresh token was not issued to this client.' });

    // Rotation: revoke the old pair, mint a fresh one.
    await env.DB.prepare('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE id = ?').bind(stored).run();
    await env.DB.prepare('UPDATE oauth_access_tokens SET revoked = 1 WHERE id = ?').bind(at.id).run();

    const scopes = at.scopes ? JSON.parse(at.scopes) : [];
    const tokens = await issueTokens(env, {
      userId: at.user_id,
      clientId,
      scopes,
      privatePem: priv,
      pub,
      kid,
    });
    return json(200, tokens);
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
}

// GET /oauth/jwks — public key as a JWK set for offline token verification.
export async function handleJwks(ctx, env) {
  try {
    const { pub, kid } = keys(env);
    const doc = await jwksExport(pub, kid);
    return json(200, doc);
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const path = ctx.request.path || ctx.request.url || '';
  const action =
    (ctx.params && ctx.params.action) ||
    (path.includes('/oauth/authorize')
      ? 'authorize'
      : path.includes('/oauth/token')
        ? 'token'
        : path.includes('/oauth/refresh')
          ? 'refresh'
          : path.includes('/oauth/jwks')
            ? 'jwks'
            : '');
  switch (action) {
    case 'authorize': return handleAuthorize(ctx, env);
    case 'token': return handleToken(ctx, env);
    case 'refresh': return handleRefresh(ctx, env);
    case 'jwks': return handleJwks(ctx, env);
    default: return json(404, { message: `Unknown passport action '${action}'.` });
  }
}
