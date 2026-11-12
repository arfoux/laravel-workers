import { normalizePortCtx, guardUserId } from '../../kernel/packages/port-ctx.mjs';

// ports/packages/permission.mjs — port of spatie/laravel-permission v8.5.0 seam.
//
// Answers hasRole / hasPermissionTo / hasAnyRole / hasAnyPermission (direct +
// via-role) and mutates assignRole / revokeRole / givePermissionTo /
// revokePermissionTo, all over D1. Mirrors the package's table shape:
// roles, permissions, model_has_roles, model_has_permissions,
// role_has_permissions (Spatie's default migration, team-scoped columns
// omitted — single-team edge tenant).
//
// Route wiring: registry.json → "ports": {
//   "/model/{modelType}/{modelKey}/has-role":       "permission",  // GET
//   "/model/{modelType}/{modelKey}/has-permission": "permission",  // GET
//   "/model/{modelType}/{modelKey}/has-any":        "permission",  // GET (?permissions / ?roles)
//   "/model/{modelType}/{modelKey}/roles/{action}":  "permission",  // POST assign-role|revoke-role
//   "/model/{modelType}/{modelKey}/permissions/{action}": "permission", // POST give-permission|revoke-permission
// }
// Registry keys are Laravel route patterns: `{param}`, never `:param` (the build
// matches the key against `route:list` and fails loud on a miss).
//
// GET  has-role        ?role=<name>            → { hasRole }
// GET  has-role        ?roleIds=1,2            → { hasRoleIds: [..] }
// GET  has-permission  ?permission=<name>      → { hasPermissionTo }
// GET  has-permission  ?permissions=a,b        → { hasAnyPermission }
// POST assign-role     {role, model_type?}     → { assigned: n }
// POST revoke-role     {role, model_type?}     → { revoked: n }
// POST give-permission {permission, model_type?}→ { given: n }
// POST revoke-permission {permission, model_type?}→ { revoked: n }
//
// model_type defaults to `App\\Models\\User`; model_key is a route param.

const DEFAULT_MODEL_TYPE = 'App\\Models\\User';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    guard_name TEXT NOT NULL DEFAULT 'web',
    UNIQUE (name, guard_name)
  )`,
  `CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    guard_name TEXT NOT NULL DEFAULT 'web',
    UNIQUE (name, guard_name)
  )`,
  `CREATE TABLE IF NOT EXISTS model_has_roles (
    role_id INTEGER NOT NULL,
    model_type TEXT NOT NULL,
    model_key TEXT NOT NULL,
    UNIQUE (role_id, model_type, model_key)
  )`,
  `CREATE TABLE IF NOT EXISTS model_has_permissions (
    permission_id INTEGER NOT NULL,
    model_type TEXT NOT NULL,
    model_key TEXT NOT NULL,
    UNIQUE (permission_id, model_type, model_key)
  )`,
  `CREATE TABLE IF NOT EXISTS role_has_permissions (
    permission_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    PRIMARY KEY (permission_id, role_id)
  )`,
];

export async function ensureSchema(env) {
  for (const sql of SCHEMA) {
    await env.DB.prepare(sql).run();
  }
}

function json(status, payload) {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

async function findRole(env, name) {
  return env.DB.prepare('SELECT id, name FROM roles WHERE name = ? LIMIT 1')
    .bind(name)
    .first();
}

async function findPermission(env, name) {
  return env.DB.prepare('SELECT id, name FROM permissions WHERE name = ? LIMIT 1')
    .bind(name)
    .first();
}

// hasRole: direct assignment only (Spatie's hasRole does not walk "via" roles).
async function hasRoleName(env, modelType, modelKey, roleName) {
  const role = await findRole(env, roleName);
  if (!role) return false;
  const row = await env.DB
    .prepare('SELECT role_id FROM model_has_roles WHERE role_id = ? AND model_type = ? AND model_key = ? LIMIT 1')
    .bind(role.id, modelType, modelKey)
    .first();
  return !!row;
}

async function hasRoleIds(env, modelType, modelKey, ids) {
  const found = [];
  for (const id of ids) {
    const row = await env.DB
      .prepare('SELECT role_id FROM model_has_roles WHERE role_id = ? AND model_type = ? AND model_key = ? LIMIT 1')
      .bind(id, modelType, modelKey)
      .first();
    if (row) found.push(id);
  }
  return found;
}

// hasPermissionTo: direct model_has_permissions OR via role_has_permissions.
async function hasPermissionTo(env, modelType, modelKey, permissionName) {
  const perm = await findPermission(env, permissionName);
  if (!perm) return false;
  const direct = await env.DB
    .prepare('SELECT permission_id FROM model_has_permissions WHERE permission_id = ? AND model_type = ? AND model_key = ? LIMIT 1')
    .bind(perm.id, modelType, modelKey)
    .first();
  if (direct) return true;
  const viaRole = await env.DB
    .prepare(
      `SELECT rhp.permission_id FROM role_has_permissions AS rhp
       INNER JOIN model_has_roles AS mhr ON mhr.role_id = rhp.role_id
       WHERE rhp.permission_id = ? AND mhr.model_type = ? AND mhr.model_key = ? LIMIT 1`
    )
    .bind(perm.id, modelType, modelKey)
    .first();
  return !!viaRole;
}

async function hasAnyPermission(env, modelType, modelKey, names) {
  const results = {};
  let any = false;
  for (const name of names) {
    const ok = await hasPermissionTo(env, modelType, modelKey, name);
    results[name] = ok;
    if (ok) any = true;
  }
  return { hasAnyPermission: any, per_permission: results };
}

async function hasAnyRole(env, modelType, modelKey, names) {
  const results = {};
  let any = false;
  for (const name of names) {
    const ok = await hasRoleName(env, modelType, modelKey, name);
    results[name] = ok;
    if (ok) any = true;
  }
  return { hasAnyRole: any, per_role: results };
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    // spatie/laravel-permission is a LIBRARY: `$user->assignRole()` /
    // `$user->hasPermissionTo()` run inside app code, in an authenticated request
    // context, after the app's own authorization. The port's routes are that
    // capability's seam, so without an identity an anonymous caller could read any
    // model's roles (a role oracle) or grant itself `admin`. A caller-supplied
    // modelType/modelKey/body is never an identity: the guard decides, and its
    // absence is 401 — before any D1 write.
    if ((await guardUserId(ctx)) == null) return json(401, { message: 'Unauthenticated.' });
    await ensureSchema(env);
    const modelType = (ctx.body && ctx.body.model_type) || (ctx.query && ctx.query.model_type) || DEFAULT_MODEL_TYPE;
    const modelKey = ctx.params && ctx.params.modelKey;
    if (!modelKey) return json(400, { error: 'modelKey route param required' });

    const q = ctx.query || {};
    const method = ctx.request ? ctx.request.method : 'GET';

    if (method === 'GET') {
      if ('role' in q) {
        return json(200, { hasRole: await hasRoleName(env, modelType, modelKey, q.role) });
      }
      if ('roleIds' in q) {
        const ids = String(q.roleIds).split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
        return json(200, { hasRoleIds: await hasRoleIds(env, modelType, modelKey, ids) });
      }
      if ('permission' in q) {
        return json(200, { hasPermissionTo: await hasPermissionTo(env, modelType, modelKey, q.permission) });
      }
      if ('permissions' in q) {
        const names = String(q.permissions).split(',').map((s) => s.trim()).filter(Boolean);
        return json(200, await hasAnyPermission(env, modelType, modelKey, names));
      }
      if ('roles' in q) {
        const names = String(q.roles).split(',').map((s) => s.trim()).filter(Boolean);
        return json(200, await hasAnyRole(env, modelType, modelKey, names));
      }
      return json(400, { error: 'provide ?role, ?roleIds, ?permission, ?permissions or ?roles' });
    }

    // Mutations: { role | permission, model_type? }
    const body = ctx.body || {};
    const action = ctx.params && ctx.params.action;

    if (action === 'assign-role' || action === 'revoke-role') {
      if (!body.role) return json(400, { error: 'body.role required' });
      const role = await findRole(env, body.role);
      if (!role) return json(404, { error: `role "${body.role}" not found` });
      if (action === 'assign-role') {
        const res = await env.DB
          .prepare('INSERT OR IGNORE INTO model_has_roles (role_id, model_type, model_key) VALUES (?, ?, ?)')
          .bind(role.id, modelType, modelKey)
          .run();
        return json(200, { assigned: (res && res.changes) || 0 });
      }
      const res = await env.DB
        .prepare('DELETE FROM model_has_roles WHERE role_id = ? AND model_type = ? AND model_key = ?')
        .bind(role.id, modelType, modelKey)
        .run();
      return json(200, { revoked: (res && res.changes) || 0 });
    }

    if (action === 'give-permission' || action === 'revoke-permission') {
      if (!body.permission) return json(400, { error: 'body.permission required' });
      const perm = await findPermission(env, body.permission);
      if (!perm) return json(404, { error: `permission "${body.permission}" not found` });
      if (action === 'give-permission') {
        const res = await env.DB
          .prepare('INSERT OR IGNORE INTO model_has_permissions (permission_id, model_type, model_key) VALUES (?, ?, ?)')
          .bind(perm.id, modelType, modelKey)
          .run();
        return json(200, { given: (res && res.changes) || 0 });
      }
      const res = await env.DB
        .prepare('DELETE FROM model_has_permissions WHERE permission_id = ? AND model_type = ? AND model_key = ?')
        .bind(perm.id, modelType, modelKey)
        .run();
      return json(200, { revoked: (res && res.changes) || 0 });
    }

    return json(400, { error: 'unknown action' });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
