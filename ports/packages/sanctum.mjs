// Port of laravel/sanctum v4.3.3 — personal-access-token endpoints at the edge.
//
// Route seam: registry.json → "ports": {
//   "/sanctum/token": "sanctum-token",
//   "/sanctum/tokens": "sanctum-list",
//   "/sanctum/verify": "sanctum-verify",
//   "/sanctum/tokens/:id": "sanctum-revoke",
// }
//
// What runs at the edge (1:1 with Sanctum 4.x):
//   • plaintext token shape  = `${id}|${random40}`  (Str::random alphabet)
//   • stored value           = sha256(plaintext), hex lowercase — never the plaintext
//   • Bearer verify          = sha256 + constant-time compare (kernel/packages/token.mjs)
//   • abilities              = JSON column, checked / returned verbatim
//   • last_used_at           = touched on every successful verify
//
// Substitution (disclosed): Sanctum's PHP `PersonalAccessToken` model + the
// `HasApiTokens` trait are vendor code the compiled rung cannot load (LW002), so
// the D1 `personal_access_tokens` table IS the token store and this module is the
// controller. Guard resolution (`auth()->guard('sanctum')`) is out of scope —
// the routes here ARE the guard's token endpoints, not a drop-in middleware.
//
// Password check: Laravel emits `$2y$` bcrypt; `bcryptjs` (already a repo dep,
// used by kernel/auth.mjs) verifies `$2a$`/`$2y$` identically — same algorithm.
//
// Free tier: ≤1 D1 read/verify, ≤1 read + 1 write per token create, CPU negligible.
// D1 100k rows/day is the binding limit for a token-issuing endpoint.

import {
  bearerToken,
  createPersonalAccessToken,
  verifyPersonalAccessToken,
} from '../../kernel/packages/token.mjs';
import { timingSafeEqual } from '../../kernel/packages/webhook.mjs';
import bcrypt from 'bcryptjs';
import { normalizePortCtx, jsonResponse as json } from '../../kernel/packages/port-ctx.mjs';
import { dateToSqlite } from '../../kernel/db.mjs';

// ---------------------------------------------------------------------------
// Schema (mirrors Sanctum's migration verbatim; users = Laravel's default)
// ---------------------------------------------------------------------------
export async function ensureSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS personal_access_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tokenable_type TEXT NOT NULL,
    tokenable_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    abilities TEXT,
    last_used_at TEXT,
    expires_at TEXT,
    created_at TEXT,
    updated_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL
  )`).run();
}

const now = () => dateToSqlite(new Date());


// Resolve the caller: an existing Bearer token (re-auth) OR email+password.
// Returns `{ user }` on success, `{ error }` (a Response) on failure.
async function resolveUser(ctx, env) {
  const plain = bearerToken(ctx.request.headers.get('authorization'));
  if (plain) {
    const id = Number.parseInt(plain.split('|')[0], 10);
    if (!Number.isFinite(id)) return { error: json(401, { message: 'Unauthenticated.' }) };
    const row = await env.DB.prepare(
      'SELECT t.token AS token_hash, t.tokenable_id AS uid FROM personal_access_tokens t WHERE t.id = ?'
    ).bind(id).first();
    if (row && (await verifyPersonalAccessToken(plain, row.token_hash))) {
      const user = await env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(row.uid).first();
      if (user) return { user };
    }
    return { error: json(401, { message: 'Unauthenticated.' }) };
  }
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const { email, password } = body;
  if (typeof email !== 'string' || typeof password !== 'string') {
    return { error: json(422, { message: 'The email and password fields are required.' }) };
  }
  const user = await env.DB.prepare('SELECT id, name, email, password FROM users WHERE email = ?').bind(email).first();
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return { error: json(422, { message: 'These credentials do not match our records.' }) };
  }
  return { user };
}

async function touch(env, id) {
  await env.DB.prepare('UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?').bind(now(), id).run();
}

// POST /sanctum/token — issue a PAT. Auth via Bearer (already-authed user) or
// email+password body. Optional `abilities: string[]` in the body.
export async function handleCreate(ctx, env) {
  try {
    await ensureSchema(env);
    const { user, error } = await resolveUser(ctx, env);
    if (error) return error;

    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    const name = typeof body.name === 'string' && body.name !== '' ? body.name : 'default';
    const abilities = Array.isArray(body.abilities) ? body.abilities.map(String) : [];

    // Reserve the autoincrement id first so the plaintext embeds it (Sanctum parity).
    const reserved = await env.DB.prepare(
      'INSERT INTO personal_access_tokens (tokenable_type, tokenable_id, name, token, abilities, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind('App\\Models\\User', user.id, name, `__reserved__${Date.now()}-${Math.random()}`, JSON.stringify(abilities), now(), now()).run();
    const tokenId = reserved.meta?.lastInsertRowid ?? reserved.lastInsertRowid;

    const { plain, row } = await createPersonalAccessToken(user.id, name, abilities, { id: tokenId });
    await env.DB.prepare(
      'UPDATE personal_access_tokens SET token = ?, abilities = ?, updated_at = ? WHERE id = ?'
    ).bind(row.token, row.abilities, now(), tokenId).run();

    // Shape mirrors Sanctum's `NewAccessToken` (JsonResource): id + plainText token.
    return json(201, { token: plain, id: tokenId, name, abilities });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}

// GET /sanctum/verify — middleware-ish: is this Bearer token valid, and what can it do?
export async function handleVerify(ctx, env) {
  try {
    await ensureSchema(env);
    const plain = bearerToken(ctx.request.headers.get('authorization'));
    if (!plain) return json(401, { message: 'Unauthenticated.' });
    const id = Number.parseInt(plain.split('|')[0], 10);
    if (!Number.isFinite(id)) return json(401, { message: 'Unauthenticated.' });

    const row = await env.DB.prepare('SELECT * FROM personal_access_tokens WHERE id = ?').bind(id).first();
    if (!row) return json(401, { message: 'Unauthenticated.' });

    const abilities = row.abilities ? JSON.parse(row.abilities) : [];
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return json(401, { message: 'Token expired.' });
    }
    if (!(await verifyPersonalAccessToken(plain, row.token))) {
      return json(401, { message: 'Unauthenticated.' });
    }
    await touch(env, row.id);
    return json(200, {
      valid: true,
      token_id: row.id,
      token_name: row.name,
      abilities,
      tokenable_type: row.tokenable_type,
      tokenable_id: row.tokenable_id,
    });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}

// GET /sanctum/tokens — list the caller's tokens (id + name + meta, never the hash).
export async function handleList(ctx, env) {
  try {
    await ensureSchema(env);
    const { user, error } = await resolveUser(ctx, env);
    if (error) return error;
    const rows = await env.DB.prepare(
      'SELECT id, name, abilities, last_used_at, expires_at, created_at FROM personal_access_tokens WHERE tokenable_id = ? ORDER BY id DESC'
    ).bind(user.id).all();
    return json(200, {
      tokens: (rows.results || []).map((r) => ({
        id: r.id,
        name: r.name,
        abilities: r.abilities ? JSON.parse(r.abilities) : [],
        last_used_at: r.last_used_at,
        expires_at: r.expires_at,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}

// DELETE /sanctum/tokens/:id — revoke one token owned by the caller.
export async function handleRevoke(ctx, env) {
  try {
    await ensureSchema(env);
    const { user, error } = await resolveUser(ctx, env);
    if (error) return error;
    const id = Number.parseInt(ctx.params?.id, 10);
    if (!Number.isFinite(id)) return json(400, { message: 'Invalid token id.' });
    const res = await env.DB.prepare('DELETE FROM personal_access_tokens WHERE id = ? AND tokenable_id = ?')
      .bind(id, user.id).run();
    const n = res.meta?.changes ?? res.changes ?? 0;
    if (n === 0) return json(404, { message: 'Token not found.' });
    return json(200, { revoked: id });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}

// DELETE /sanctum/tokens — revoke every token owned by the caller.
export async function handleRevokeAll(ctx, env) {
  try {
    await ensureSchema(env);
    const { user, error } = await resolveUser(ctx, env);
    if (error) return error;
    await env.DB.prepare('DELETE FROM personal_access_tokens WHERE tokenable_id = ?').bind(user.id).run();
    return json(200, { revoked: 'all' });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}

// Default dispatch — one port file, several Sanctum endpoints. `ctx.params.method`
// (or the path suffix) selects; falls back to create on POST /sanctum/token.
export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const path = ctx.request.path || ctx.request.url || '';
  const seg =
    (ctx.params && (ctx.params.method || ctx.params.id)) ||
    (path.includes('/sanctum/verify')
      ? 'verify'
      : path.includes('/sanctum/tokens')
        ? 'list'
        : '');
  const method = (ctx.request.method || 'POST').toUpperCase();
  if (seg === 'verify') return handleVerify(ctx, env);
  if (seg === 'revoke') return handleRevokeAll(ctx, env);
  if (ctx.params && ctx.params.id !== undefined && method === 'DELETE') return handleRevoke(ctx, env);
  if (seg === 'list' || method === 'GET') return handleList(ctx, env);
  return handleCreate(ctx, env);
}

// Attach route helpers to the default handler so a caller (and tests) reach the
// named endpoints through one module: `handler(ctx, env)` dispatches, while
// `handler.ensureSchema(env)` / `handler.handleCreate(...)` stay reachable.
handle.ensureSchema = ensureSchema;
handle.handleCreate = handleCreate;
handle.handleVerify = handleVerify;
handle.handleList = handleList;
handle.handleRevoke = handleRevoke;
handle.handleRevokeAll = handleRevokeAll;
