// Port of a JWT (HS256) authentication flow — login + an authenticated-user
// middleware endpoint, at the edge.
//
// Route seam: registry.json → "ports": {
//   "POST /auth/jwt/login": "jwt-auth:login",
//   "GET  /auth/jwt/user":  "jwt-auth:user",
// }
// The default export dispatches on the resolved verb + path (multi-route port).
//
// What runs at the edge:
//   • POST /auth/jwt/login  — verify {email, password} against the D1 `users`
//     table (bcryptjs, same dep + `$2y$` handling as the Sanctum port), then mint
//     an HS256 JWT `{ alg: HS256, typ: JWT }` via WebCrypto and return
//     `{ token, user }`. `token.mjs` supplies the Bearer parser; HS256 minting is
//     local (a symmetric key imported from `env.JWT_SECRET`).
//   • GET  /auth/jwt/user   — verify the `Authorization: Bearer` JWT (signature +
//     `exp`/`nbf`/`iat`), look the user back up, return `{ user }`. The classic
//     `auth:api` middleware reduced to one D1 read.
//
// Config (env): JWT_SECRET (required HMAC key), JWT_TTL (optional seconds, default 3600).
// D1 tables: users (Laravel's default: id, name, email, password UNIQUE).
//
// Substitution (disclosed): Laravel emits `$2y$` bcrypt and verifies with
// Hash::check; bcryptjs verifies `$2a$`/`$2y$` identically (same algorithm). The
// JWT is signed HS256 (not Passport's RS256) — the stateless symmetric default
// `tymon/jwt-auth` ships with; set JWT_SECRET through the same env-secret channel.
//
// Free tier: ≤1 D1 read per login, ≤2 reads (token decode is offline) per verify;
// one HMAC sign/verify (sub-millisecond). No outbound subrequests.

import bcrypt from 'bcryptjs';
import { bearerToken } from '../../kernel/packages/token.mjs';
import { timingSafeEqual } from '../../kernel/packages/webhook.mjs';
import { normalizePortCtx, jsonResponse as json, unauthorized } from '../../kernel/packages/port-ctx.mjs';
import { b64url, b64urlToBytes } from '../../kernel/packages/b64url.mjs';

// Re-exported: these were this port's public surface before the shared
// `b64url.mjs` existed; keep the names importable from here.
export { b64url, b64urlToBytes };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlJson(obj) {
  return b64url(enc.encode(JSON.stringify(obj)));
}

// --- HS256 JWT ---------------------------------------------------------------

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

// Sign an arbitrary JSON payload as an HS256 JWT. Returns the compact JWS.
export async function signJwt(payload, secret) {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const signingInput = `${b64urlJson({ alg: 'HS256', typ: 'JWT' })}.${b64urlJson(payload)}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

// Verify an HS256 JWT. Returns the decoded payload on a valid signature, else
// null. `exp`/`nbf`/`iat` are the caller's to enforce (they get the full payload).
export async function verifyJwt(token, secret) {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header;
  try {
    header = JSON.parse(dec.decode(b64urlToBytes(h)));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;
  const key = await hmacKey(secret);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(s), enc.encode(`${h}.${p}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    return JSON.parse(dec.decode(b64urlToBytes(p)));
  } catch {
    return null;
  }
}

// --- schema / helpers --------------------------------------------------------

export async function ensureSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL
  )`).run();
}


function isFresh(payload) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= nowSec) return false;
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec) return false;
  return true;
}

async function findUserByEmail(env, email) {
  return env.DB.prepare('SELECT id, name, email, password FROM users WHERE email = ?').bind(String(email)).first();
}

// POST /auth/jwt/login — {email, password} → {token, user}
export async function handleLogin(ctx, env) {
  try {
    await ensureSchema(env);
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    const { email, password } = body;
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return json(422, { message: 'The email and password fields are required.' });
    }
    const user = await findUserByEmail(env, email);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return json(422, { message: 'These credentials do not match our records.' });
    }
    const ttl = Number(env.JWT_TTL) > 0 ? Number(env.JWT_TTL) : 3600;
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      { sub: String(user.id), email: user.email, iat: nowSec, nbf: nowSec, exp: nowSec + ttl },
      env.JWT_SECRET,
    );
    return json(200, { token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    return json(500, { message: String((err && err.message) || err) });
  }
}

// GET /auth/jwt/user — Bearer JWT → {user}. The `auth:api` middleware shape.
export async function handleUser(ctx, env) {
  try {
    await ensureSchema(env);
    const token = bearerToken(ctx.request.headers.get('authorization'));
    if (!token) return unauthorized();
    const payload = await verifyJwt(token, env.JWT_SECRET);
    if (!payload || !isFresh(payload)) return unauthorized();
    const user = await env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(Number(payload.sub)).first();
    if (!user) return unauthorized();
    return json(200, { user });
  } catch (err) {
    return json(500, { message: String((err && err.message) || err) });
  }
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const path = ctx.request.path || '';
  const isUser = ctx.method === 'GET' && path.includes('/auth/jwt/user');
  const isLogin = ctx.method === 'POST' && path.includes('/auth/jwt/login');
  if (isUser) return handleUser(ctx, env);
  if (isLogin) return handleLogin(ctx, env);
  return json(404, { message: `Unknown jwt-auth route (${ctx.method} ${path}).` });
}
