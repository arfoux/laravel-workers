// Port of laravel/sanctum v4.3.3 — the SPA COOKIE mode (complements the PAT
// port in sanctum.mjs). This is Sanctum's first-party SPA flow: a CSRF cookie
// (double-submit) + an HttpOnly session cookie, exactly the shape Laravel
// serves to a same-origin/first-party JS app.
//
// Route seam: registry.json → "ports": {
//   "/sanctum/csrf-cookie":   "sanctum-spa-cookie:csrf",
//   "/sanctum/spa/login":     "sanctum-spa-cookie:login",
//   "/sanctum/spa/user":      "sanctum-spa-cookie:user",
//   "/sanctum/spa/logout":    "sanctum-spa-cookie:logout",
// }
// The default export dispatches on `ctx.params.action`.
//
// What runs at the edge (parity with Sanctum's SPA auth):
//   • CSRF      = double-submit: `XSRF-TOKEN` cookie must equal the
//                 `X-XSRF-TOKEN` request header on state-changing verbs
//                 (Laravel's VerifyCsrfToken). Constant-time compare.
//   • session   = opaque random id, stored in D1; the cookie carries
//                 signValue(sessionId) (HMAC-SHA256 over the app key), so a
//                 client cannot forge an id (kernel/packages/signedurl.mjs).
//   • cookie    = HttpOnly + Secure + SameSite=Lax, 2h rolling lifetime.
//   • login     = email + password (bcrypt) → session row + both cookies.
//   • user      = session cookie → D1 session → user.
//   • logout    = delete the session row + clear the cookie.
//
// Substitution (disclosed): Laravel stores the session server-side (file/
// redis/DB) keyed by an encrypted cookie. Here the D1 `sessions` table IS the
// server-side store and the cookie is an HMAC-signed handle to it — same trust
// boundary (the id is unforgeable), only the store is D1. No PHP session
// garbage collection at the edge; expired sessions are rejected on read.
//
// Free tier: csrf = 0 D1 (stateless cookie); login = 1 read + 1 write; user/
// logout = 1 read (+1 write on logout). CPU trivial (one bcrypt on login).

import bcrypt from 'bcryptjs';
import { signValue, verifyValue } from '../../kernel/packages/signedurl.mjs';
import { randomString } from '../../kernel/packages/token.mjs';
import { timingSafeEqual } from '../../kernel/packages/webhook.mjs';
import { normalizePortCtx, unauthorized } from '../../kernel/packages/port-ctx.mjs';
import { dateToSqlite } from '../../kernel/db.mjs';

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password TEXT
    )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      csrf_token TEXT NOT NULL,
      created_at TEXT,
      last_activity TEXT
    )`
  ).run();
}

const now = () => dateToSqlite(new Date());
const SESSION_COOKIE = 'laravel_session';
const CSRF_COOKIE = 'XSRF-TOKEN';
const SESSION_TTL = 60 * 60 * 2; // 2h rolling, Laravel's default lifetime

function json(status, payload, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(payload),
  };
}

function appKey(env) {
  const key = env.APP_KEY || env.SESSION_SECRET;
  if (!key) throw new Error('APP_KEY / SESSION_SECRET is not configured');
  return String(key).replace(/^base64:/, '');
}

function readCookie(ctx, name) {
  const header = (ctx.request && ctx.request.headers && ctx.request.headers.get('cookie')) || '';
  for (const part of header.split(/;\s*/)) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

// Double-submit CSRF: cookie value must equal the X-XSRF-TOKEN header.
function csrfOk(ctx) {
  const cookieTok = readCookie(ctx, CSRF_COOKIE);
  const headerTok = (ctx.request && ctx.request.headers && ctx.request.headers.get('x-xsrf-token')) || '';
  if (!cookieTok || !headerTok) return false;
  return timingSafeEqual(cookieTok, headerTok);
}

function csrfRequired(ctx) {
  const method = ((ctx.request && ctx.request.method) || 'GET').toUpperCase();
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function sessionCookie(signed, { clear = false } = {}) {
  const base = `${SESSION_COOKIE}=${clear ? '' : signed}; Path=/; HttpOnly; SameSite=Lax`;
  return clear ? `${base}; Max-Age=0` : `${base}; Max-Age=${SESSION_TTL}; Secure`;
}

function csrfCookie(token, { clear = false } = {}) {
  // Readable by JS (NOT HttpOnly) so the SPA can echo it back as a header.
  const base = `${CSRF_COOKIE}=${clear ? '' : token}; Path=/; SameSite=Lax`;
  return clear ? `${base}; Max-Age=0` : `${base}; Max-Age=${SESSION_TTL}`;
}

async function findUser(env, email) {
  if (!email) return null;
  return env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(String(email)).first();
}

async function userById(env, id) {
  if (id == null) return null;
  return env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(String(id)).first();
}

// GET /sanctum/csrf-cookie — mint + set the XSRF-TOKEN cookie (stateless).
export async function handleCsrf(ctx, env) {
  const token = randomString(40);
  return json(204, {}, { 'set-cookie': csrfCookie(token) });
}

// POST /sanctum/spa/login — CSRF + email/password → session cookies.
export async function handleLogin(ctx, env) {
  await ensureSchema(env);
  if (csrfRequired(ctx) && !csrfOk(ctx)) {
    return json(419, { message: 'CSRF token mismatch.' });
  }
  let key;
  try {
    key = appKey(env);
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const user = await findUser(env, body.email);
  const ok = user && user.password && typeof body.password === 'string'
    ? await bcrypt.compare(body.password, user.password)
    : false;
  if (!ok) return json(422, { message: 'These credentials do not match our records.' });

  const sessionId = randomString(40);
  const csrfToken = randomString(40);
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, csrf_token, created_at, last_activity) VALUES (?, ?, ?, ?, ?)'
  ).bind(sessionId, user.id, csrfToken, now(), now()).run();

  const signed = await signValue(sessionId, key, { ttlSeconds: SESSION_TTL });
  return json(200, { user: { id: user.id, email: user.email, name: user.name } }, {
    'set-cookie': `${sessionCookie(signed)}\n${csrfCookie(csrfToken)}`,
  });
}

// GET /sanctum/spa/user — resolve the session cookie to the user.
export async function handleUser(ctx, env) {
  await ensureSchema(env);
  let key;
  try {
    key = appKey(env);
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
  const signed = readCookie(ctx, SESSION_COOKIE);
  if (!signed) return unauthorized();

  const { valid, value } = await verifyValue(signed, key);
  if (!valid) return unauthorized();

  const session = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?1').bind(String(value)).first();
  if (!session) return unauthorized();

  const user = await userById(env, session.user_id);
  if (!user) return unauthorized();

  await env.DB.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?').bind(now(), session.id).run();
  return json(200, { user: { id: user.id, email: user.email, name: user.name } });
}

// POST /sanctum/spa/logout — CSRF + delete the session, clear the cookies.
export async function handleLogout(ctx, env) {
  await ensureSchema(env);
  if (csrfRequired(ctx) && !csrfOk(ctx)) {
    return json(419, { message: 'CSRF token mismatch.' });
  }
  let key;
  try {
    key = appKey(env);
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
  const signed = readCookie(ctx, SESSION_COOKIE);
  if (signed) {
    const { valid, value } = await verifyValue(signed, key);
    if (valid) {
      await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(String(value)).run();
    }
  }
  return json(200, { logged_out: true }, {
    'set-cookie': `${sessionCookie('', { clear: true })}\n${csrfCookie('', { clear: true })}`,
  });
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const path = ctx.request.path || ctx.request.url || '';
  const action =
    (ctx.params && ctx.params.action) ||
    (path.includes('/sanctum/csrf-cookie')
      ? 'csrf'
      : path.includes('/sanctum/spa/login')
        ? 'login'
        : path.includes('/sanctum/spa/user')
          ? 'user'
          : path.includes('/sanctum/spa/logout')
            ? 'logout'
            : '');
  try {
    switch (action) {
      case 'csrf': return await handleCsrf(ctx, env);
      case 'login': return await handleLogin(ctx, env);
      case 'user': return await handleUser(ctx, env);
      case 'logout': return await handleLogout(ctx, env);
      default: return json(404, { message: `Unknown SPA action '${action}'.` });
    }
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
