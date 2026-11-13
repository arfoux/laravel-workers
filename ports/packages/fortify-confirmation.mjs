// Port of laravel/fortify v1.41 — password confirmation + email verification.
//
// Route seam: registry.json → "ports": {
//   "/user/confirm-password":             "fortify-confirmation",
//   "/user/confirm-password/status":      "fortify-confirmation",
//   "/email/verification-notification":   "fortify-confirmation",
//   "/email/verify/{id}/{hash}":          "fortify-confirmation",
// }
// The default export dispatches on the request path (the router fills `params`
// only from `{param}` captures, so there is no `action` segment on these routes);
// an explicit `ctx.params.action` is honoured as the override a unit test passes.
//
// What runs at the edge (parity with Fortify's ConfirmPasswordController +
// Laravel's VerificationController / signed URLs):
//   • password confirm = bcrypt verify, then stamp `password_confirmed_at`
//   • verification URL = Laravel's `URL::temporarySignedRoute` shape:
//       `${base}/email/verify/{id}/{sha1(email)}?expires={unix}&signature={hmac}`
//     where `signature` = HMAC-SHA256(appKey, `${path}?expires=${expires}`)
//     (kernel/packages/signedurl.mjs). The edge verifies the MAC + expiry +
//     the sha1(email) hash before flipping `email_verified_at`.
//
// Substitution (disclosed):
//   • Laravel signs with the app key via `Encrypter`; here the MAC is
//     HMAC-SHA256 over `env.APP_KEY` (or `env.SESSION_SECRET`). Same
//     construction (keyed hash over the signed portion), only the primitive is
//     a direct HMAC instead of the encrypter's MAC wrapper.
//   • "Sending" the verification email is out of scope at the edge — the
//     send-verification action MINTS the signed URL and returns it (the mailer
//     would carry it). No SMTP/pixel at the edge.
//   • Laravel hashes the email with sha1 for the URL segment; we do the same
//     (sha1, WebCrypto digest) so a leaked hash reveals nothing reversible.
//
// Free tier: password confirm = 1 D1 read + 1 write; verification = 1 read +
// 1 write. CPU trivial (one bcrypt + one HMAC). bcrypt dominates (~50ms),
// which is the deliberate cost of a password check.

import bcrypt from 'bcryptjs';
import { signPath, verifyPath } from '../../kernel/packages/signedurl.mjs';
import { timingSafeEqual } from '../../kernel/packages/webhook.mjs';
import { normalizePortCtx, guardUserId } from '../../kernel/packages/port-ctx.mjs';
import { bytesToHex } from '../../kernel/digest.mjs';
import { dateToSqlite } from '../../kernel/db.mjs';

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password TEXT,
      email_verified_at TEXT,
      password_confirmed_at TEXT
    )`
  ).run();
}

const now = () => dateToSqlite(new Date());

function json(status, payload) {
  return { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(payload) };
}

async function sha1hex(text) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(String(text)));
  return bytesToHex(new Uint8Array(d));
}

function appKey(env) {
  const key = env.APP_KEY || env.SESSION_SECRET;
  if (!key) throw new Error('APP_KEY / SESSION_SECRET is not configured');
  return String(key).replace(/^base64:/, '');
}

async function findUserById(env, id) {
  if (id == null) return null;
  return env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(String(id)).first();
}

// Who the action belongs to: the platform's own guard (ctx.user(), awaited —
// the same accessor the Worker hands every port, kernel/http.mjs) or an id a
// `middlewarePorts` guard wrote onto ctx (kernel/router.mjs). A caller-provided
// email is never a source. No identity => null (the handlers answer 401).
async function currentUser(ctx, env) {
  const id = await guardUserId(ctx);
  return id == null ? null : findUserById(env, id);
}

function baseUrl(ctx, env, override) {
  if (override) return String(override).replace(/\/+$/, '');
  if (env.APP_URL) return String(env.APP_URL).replace(/\/+$/, '');
  if (ctx.request && ctx.request.url) return new URL(ctx.request.url).origin;
  return 'https://edge.test';
}

// POST /user/confirm-password — verify the password, stamp the confirmation.
// Fortify's controller sits behind `auth` and acts on `$request->user()`; the
// password is checked against THAT user's hash. An email from the body would
// make this a remote password oracle for any account.
export async function handleConfirmPassword(ctx, env) {
  await ensureSchema(env);
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const user = await currentUser(ctx, env);
  if (!user) return json(401, { message: 'Unauthenticated.' });
  if (typeof body.password !== 'string') return json(422, { errors: { password: ['The password field is required.'] } });

  const ok = user.password ? await bcrypt.compare(body.password, user.password) : false;
  if (!ok) return json(422, { errors: { password: ['The provided password was incorrect.'] } });

  const ts = now();
  await env.DB.prepare('UPDATE users SET password_confirmed_at = ? WHERE id = ?').bind(ts, user.id).run();
  return json(200, { confirmed: true, confirmed_at: ts });
}

// GET /user/confirm-password — has the session/user confirmed recently enough?
// `maxAgeSeconds` (default 3h, Laravel's `password_timeout`) bounds it. Fortify
// answers for `$request->user()` — there is no email query.
export async function handleConfirmStatus(ctx, env) {
  await ensureSchema(env);
  const q = { ...(ctx.query || {}) };
  const maxAge = Number(q.max_age ?? q.maxAge ?? 60 * 60 * 3);
  const user = await currentUser(ctx, env);
  if (!user) return json(401, { message: 'Unauthenticated.' });
  if (!user.password_confirmed_at) return json(200, { confirmed: false });

  const age = (Date.now() - new Date(user.password_confirmed_at.replace(' ', 'T') + 'Z').getTime()) / 1000;
  return json(200, { confirmed: age <= maxAge, confirmed_at: user.password_confirmed_at, age_seconds: Math.floor(age) });
}

// POST /email/verification-notification — mint the signed verification URL.
// Fortify's controller acts on `$request->user()` (auth middleware); the email
// in the body must not select the account (user enumeration + minting a valid
// link for a known account).
export async function handleSendVerification(ctx, env) {
  await ensureSchema(env);
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const user = await currentUser(ctx, env);
  if (!user) return json(401, { message: 'Unauthenticated.' });
  if (user.email_verified_at) return json(200, { already_verified: true, verification_url: null });

  let key;
  try {
    key = appKey(env);
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }

  const id = user.id;
  const hash = await sha1hex(user.email);
  const expires = Math.floor(Date.now() / 1000) + 60 * 60; // Laravel: 1h
  const path = `/email/verify/${id}/${hash}`;
  const signature = await signPath(`${path}?expires=${expires}`, key);
  const verificationUrl = `${baseUrl(ctx, env, body.base_url)}${path}?expires=${expires}&signature=${signature}`;

  return json(200, { verification_url: verificationUrl });
}

// GET /email/verify/:id/:hash?expires=&signature= — verify the signed URL and
// flip `email_verified_at`. idempotent: an already-verified user is a 200.
export async function handleVerify(ctx, env) {
  await ensureSchema(env);
  const params = ctx.params || {};
  const q = { ...(ctx.query || {}) };
  const url = ctx.request && ctx.request.url ? new URL(ctx.request.url) : null;
  if (url) for (const [k, v] of url.searchParams) if (!(k in q)) q[k] = v;

  let key;
  try {
    key = appKey(env);
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }

  const id = params.id;
  const hash = params.hash;
  const expires = q.expires;
  const signature = q.signature;
  if (!id || !hash || !expires || !signature) {
    return json(403, { message: 'Invalid verification link.' });
  }

  const path = `/email/verify/${id}/${hash}`;
  const res = await verifyPath(`${path}?expires=${expires}`, String(signature), key);
  if (!res.valid) {
    return json(403, { message: res.expired ? 'The verification link has expired.' : 'Invalid signature.' });
  }

  const user = await findUserById(env, id);
  if (!user) return json(404, { message: 'User not found.' });
  // The hash must match THIS user's email (binds the link to the account).
  const expectedHash = await sha1hex(user.email);
  if (!timingSafeEqual(expectedHash, String(hash))) {
    return json(403, { message: 'Invalid verification link.' });
  }
  if (user.email_verified_at) return json(200, { verified: true, already_verified: true });

  const ts = now();
  await env.DB.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').bind(ts, user.id).run();
  return json(200, { verified: true });
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  // The real Fortify routes carry no `{action}` segment, so the router never fills
  // `ctx.params.action`; read the action from the path tail and keep the explicit
  // param as the override a unit test passes. `/status` is matched before
  // `/user/confirm-password` (same prefix).
  const path = ctx.request.path || ctx.request.url || '';
  const action =
    (ctx.params && ctx.params.action) ||
    (path.includes('/user/confirm-password/status')
      ? 'confirm-status'
      : path.includes('/user/confirm-password')
        ? 'confirm-password'
        : path.includes('/email/verification-notification')
          ? 'send-verification'
          : path.includes('/email/verify/')
            ? 'verify'
            : '');
  try {
    switch (action) {
      case 'confirm-password': return await handleConfirmPassword(ctx, env);
      case 'confirm-status': return await handleConfirmStatus(ctx, env);
      case 'send-verification': return await handleSendVerification(ctx, env);
      case 'verify': return await handleVerify(ctx, env);
      default: return json(404, { message: `Unknown confirmation action '${action}'.` });
    }
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
