// Port of laravel/fortify v1.41 — two-factor (TOTP) endpoints at the edge.
//
// Route seam: registry.json → "ports": {
//   "/user/two-factor-authentication":        "fortify-two-factor",
//   "/user/two-factor-authentication/confirm":"fortify-two-factor",
//   "/user/two-factor-challenge":             "fortify-two-factor",
//   "/user/two-factor-challenge/recovery":    "fortify-two-factor",
// }
// One module, four routes: the registry value is a bare SLUG (the build emits
// `export { default } from '../ports/<slug>.mjs'`, so a `slug:action` form would
// look for a file that does not exist). The default export dispatches on the
// request path; an explicit `ctx.params.action` is honoured as the override a
// unit test passes. The named exports are each handler, so a caller (or the
// compiler) can also wire them 1:1.
//
// What runs at the edge (parity with Fortify's TwoFactorAuthenticationController
// + Google2FA under the hood):
//   • secret      = base32, 20 CSPRNG bytes (kernel/packages/totp.mjs)
//   • code check  = RFC 6238 TOTP, HMAC-SHA1, 8 digits, 30s step, ±1 window
//   • recovery    = 8 `random10-random10` codes; consuming one removes it
//   • confirm     = one valid TOTP flips two_factor_confirmed_at
//
// Identity (who the 2FA belongs to): in Laravel, Fortify's enable/confirm/disable
// sit behind the `auth` middleware and act on `$request->user()`; the challenge
// step resolves the user from the SESSION's pending login (`login.id`), and the
// recovery step from the same session. None of them take an email from the body —
// an email is not a credential and, at the edge, no caller-provided value may
// select the account. `currentUser()` here mirrors the platform's own `ctx.user()`
// (kernel/http.mjs: `user: () => auth.guard().user()`, awaited) or an id a
// `middlewarePorts` guard wrote onto `ctx` (kernel/router.mjs) — the app hands
// the pending login over the same seams a real Fortify flow would. No identity →
// 401 `Unauthenticated.` with no state touched.
//
// Substitution (disclosed): Fortify encrypts `two_factor_secret` and the
// recovery codes at rest with the app encrypter. This port stores the base32
// secret and the recovery codes as PLAINTEXT JSON in D1 — the edge has no PHP
// encrypter here, and a plaintext column behind the same DB ACL is the honest
// substitution. Recovery codes are consumed (never reused), which is the
// security property that matters; wire the column to a KMS/encrypter if the
// deployment needs ciphertext at rest.
//
// Free tier: ≤1 D1 read to resolve the user, ≤1 read + ≤1 write per action.
// CPU is negligible (HMAC-SHA1 over a 20-byte key).

import {
  generateSecret,
  provisioningUri,
  recoveryCodes,
  verifyTotp,
} from '../../kernel/packages/totp.mjs';
import { normalizePortCtx, guardUserId, jsonResponse as json } from '../../kernel/packages/port-ctx.mjs';
import { dateToSqlite } from '../../kernel/db.mjs';

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password TEXT,
      two_factor_secret TEXT,
      two_factor_recovery_codes TEXT,
      two_factor_confirmed_at TEXT,
      email_verified_at TEXT
    )`
  ).run();
}

const now = () => dateToSqlite(new Date());


async function userById(env, id) {
  if (id == null) return null;
  return env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(String(id)).first();
}

// Who the 2FA belongs to: the platform's own guard (`ctx.user()`, awaited — the
// same accessor the Worker hands every port, kernel/http.mjs) or an id a
// `middlewarePorts` guard wrote onto ctx (kernel/router.mjs). A caller-provided
// email is never a source. No identity => null (the handler answers 401).
async function currentUser(ctx, env) {
  const id = await guardUserId(ctx);
  return id == null ? null : userById(env, id);
}

// POST enable — mint a secret + recovery codes for the AUTHENTICATED user.
// Fortify's controller acts on `$request->user()`; an email from the body would
// let anyone rotate the 2FA secret of any account (and receive the new one back).
export async function handleEnable(ctx, env) {
  await ensureSchema(env);
  const user = await currentUser(ctx, env);
  if (!user) return json(401, { message: 'Unauthenticated.' });

  const secret = generateSecret();
  const codes = recoveryCodes(8);
  await env.DB.prepare(
    'UPDATE users SET two_factor_secret = ?, two_factor_recovery_codes = ?, two_factor_confirmed_at = ? WHERE id = ?'
  ).bind(secret, JSON.stringify(codes), null, user.id).run();

  return json(200, {
    secret,
    uri: provisioningUri(user.email, secret),
    recovery_codes: codes,
    confirmed: false,
  });
}

// POST confirm — one valid TOTP marks 2FA confirmed (for the AUTHENTICATED user).
export async function handleConfirm(ctx, env) {
  await ensureSchema(env);
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const user = await currentUser(ctx, env);
  if (!user) return json(401, { message: 'Unauthenticated.' });
  if (!user.two_factor_secret) return json(422, { message: 'Two-factor is not enabled.' });
  if (typeof body.code !== 'string') return json(422, { errors: { code: ['The code field is required.'] } });

  const ok = await verifyTotp(user.two_factor_secret, body.code);
  if (!ok) return json(422, { errors: { code: ['The provided two factor authentication code was invalid.'] } });

  await env.DB.prepare('UPDATE users SET two_factor_confirmed_at = ? WHERE id = ?').bind(now(), user.id).run();
  return json(200, { confirmed: true });
}

// POST challenge — verify a TOTP code at login. The user is the pending login
// the app handed over (session guard on ctx), NOT an email from the body.
export async function handleChallenge(ctx, env) {
  await ensureSchema(env);
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const user = await currentUser(ctx, env);
  if (!user) return json(401, { message: 'Unauthenticated.' });
  if (!user.two_factor_secret || !user.two_factor_confirmed_at) {
    return json(422, { message: 'Two-factor authentication is not enabled for this account.' });
  }
  if (typeof body.code !== 'string') return json(422, { errors: { code: ['The code field is required.'] } });

  const ok = await verifyTotp(user.two_factor_secret, body.code);
  if (!ok) return json(422, { errors: { code: ['The provided two factor authentication code was invalid.'] } });

  return json(200, { authenticated: true, user: { id: user.id, email: user.email, name: user.name } });
}

// POST recovery — verify + consume a single recovery code (session user only).
export async function handleRecovery(ctx, env) {
  await ensureSchema(env);
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const user = await currentUser(ctx, env);
  if (!user) return json(401, { message: 'Unauthenticated.' });
  if (!user.two_factor_secret || !user.two_factor_recovery_codes) {
    return json(422, { message: 'No recovery codes for this account.' });
  }
  if (typeof body.code !== 'string') return json(422, { errors: { code: ['The code field is required.'] } });

  let codes = [];
  try {
    codes = JSON.parse(user.two_factor_recovery_codes) || [];
  } catch {
    codes = [];
  }
  const idx = codes.indexOf(body.code);
  if (idx === -1) return json(422, { errors: { code: ['The provided recovery code was invalid.'] } });

  codes.splice(idx, 1);
  await env.DB.prepare('UPDATE users SET two_factor_recovery_codes = ? WHERE id = ?')
    .bind(JSON.stringify(codes), user.id).run();

  return json(200, { authenticated: true, remaining: codes.length, user: { id: user.id, email: user.email, name: user.name } });
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  // `ctx.params.action` is only present when a route declares a segment named
  // `action`; the router fills params from `{param}` captures, so the real route
  // shape puts the action in the path tail. Read the tail, keep the explicit
  // param as the override a unit test passes.
  const path = ctx.request.path || ctx.request.url || '';
  const action =
    (ctx.params && ctx.params.action) ||
    (path.includes('/two-factor-authentication/confirm')
      ? 'confirm'
      : path.includes('/two-factor-authentication')
        ? 'enable'
        : path.includes('/two-factor-challenge/recovery')
          ? 'recovery'
          : path.includes('/two-factor-challenge')
            ? 'challenge'
            : 'enable');
  try {
    switch (action) {
      case 'enable': return await handleEnable(ctx, env);
      case 'confirm': return await handleConfirm(ctx, env);
      case 'challenge': return await handleChallenge(ctx, env);
      case 'recovery': return await handleRecovery(ctx, env);
      default: return json(404, { message: `Unknown 2FA action '${action}'.` });
    }
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
