import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// Port of spatie/laravel-multitenancy v4 — multi-tenancy on the edge.
//
// Where Laravel resolves the current tenant once per request through the
// `FindTenant` / `NeedsTenant` middleware (a D1 lookup that later middleware
// and app code reach via `tenancy()->current()`), this handler does the same
// per-request D1 lookup and returns the booted context directly. There is no
// long-lived process state to carry between middleware steps — each port call
// re-resolves, which mirrors the spreadsheet verdict: `tenants()` is a static
// morph map (here: hard table `tenants`, `data_json` payload) and
// `currentTenant()` is helper state scoped to one request.
//
// Routes:
//   POST /tenants                    -> create a tenant (key/name/data)
//   GET|POST /tenants/{tenantKey}    -> resolve + boot the tenant, return context
//
// D1 schema (this cluster owns the table):
//   CREATE TABLE IF NOT EXISTS tenants (
//     id         INTEGER PRIMARY KEY AUTOINCREMENT,
//     key        TEXT NOT NULL UNIQUE,
//     name       TEXT NOT NULL,
//     data_json  TEXT NOT NULL DEFAULT '{}',   -- arbitrary JSON payload
//     created_at TEXT NOT NULL DEFAULT (datetime('now'))
//   );
//   Call ensureSchema(env) from wrangler init/migration (or lazily here).

export function ensureSchema(env) {
  return env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
}

function json(status, payload, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  };
}

function methodOf(ctx) {
  const m = String(ctx.method || (ctx.request && ctx.request.method) || 'GET').toUpperCase();
  return typeof m === 'string' ? m : String(m());
}

function readBody(ctx) {
  const r = ctx.request;
  if (r && typeof r.json === 'function') {
    try {
      const j = r.json();
      if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    } catch { /* fall through to ctx.body */ }
  }
  return ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
}

function parseData(raw) {
  if (raw == null || raw === '') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export async function createTenant(db, payload) {
  const key = String((payload && payload.key) || '').trim();
  const name = String((payload && payload.name) || key || '').trim();
  const data = payload && payload.data !== undefined ? payload.data : {};
  if (!key) return json(422, { error: 'the key field is required.' });
  if (!name) return json(422, { error: 'the name field is required.' });

  const res = await db
    .prepare('INSERT INTO tenants (key, name, data_json) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO NOTHING')
    .bind(key, name, JSON.stringify(data))
    .run();
  const changed = (res.meta && res.meta.changes !== undefined ? res.meta.changes : res.changes) ?? 0;
  if (Number(changed) === 0) return json(409, { error: `a tenant with key "${key}" already exists.` });

  const row = await db
    .prepare('SELECT id, key, name, data_json, created_at FROM tenants WHERE key = ?1 LIMIT 1')
    .bind(key)
    .first();
  return json(201, {
    tenant: { id: row && row.id, key, name },
    created: true,
    data,
  });
}

// Resolve a tenant by key and boot its context: {tenant, data}. Returns 404
// when the key does not exist — the `NeedsTenant` middleware equivalent.
export async function resolveTenant(db, key) {
  const row = await db
    .prepare('SELECT id, key, name, data_json, created_at FROM tenants WHERE key = ?1 LIMIT 1')
    .bind(String(key))
    .first();
  if (!row) return null;
  return {
    tenant: { id: row.id, key: row.key, name: row.name, created_at: row.created_at },
    data: parseData(row.data_json),
  };
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const db = ctx.db || (env && env.DB);
  if (!db) return json(500, { error: 'no D1 binding (DB) available.' });

  try {
    await ensureSchema({ DB: db });

    const method = methodOf(ctx);
    const params = ctx.params || {};
    const tenantKey = params.tenantKey !== undefined && params.tenantKey !== null
      ? String(params.tenantKey)
      : '';

    // POST /tenants (no key path segment) -> create a tenant.
    if (method === 'POST' && !tenantKey) {
      return createTenant(db, readBody(ctx));
    }

    // Any other verb without a key is unaddressable.
    if (!tenantKey) return json(422, { error: 'a tenant key is required.' });

    const booted = await resolveTenant(db, tenantKey);
    if (!booted) return json(404, { error: `tenant "${tenantKey}" not found.` });

    // GET/POST /tenants/{tenantKey}: the tenant is resolved and its context
    // booted (data_json parsed) — consumers read `data` as the booted payload.
    return json(200, { tenant: booted.tenant, data: booted.data });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
