import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// Port of spatie/laravel-settings v3.10.1 — grouped settings persisted to a
// table. In Laravel each `Settings` subclass maps to a row (`settings` table,
// `group` column); `get()->group->key` / `save()` go through `spatie`'s
// repository. Here a `{group, key, json}` row replaces that: JSON payload per
// group/key, `lw_settings` in D1.
//
// D1 schema (this cluster owns the table):
//   CREATE TABLE IF NOT EXISTS lw_settings (
//     id    INTEGER PRIMARY KEY AUTOINCREMENT,
//     group TEXT NOT NULL,
//     key   TEXT NOT NULL,
//     json  TEXT NOT NULL,           -- arbitrary JSON value for that key
//     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
//     UNIQUE (group, key)
//   );
//   NOTE: `group` is a SQL keyword in some engines — fine in D1/SQLite as an
//   identifier, but quoted here to be explicit.
//   Call ensureSchema(env) from wrangler init/migration (or lazily here).

export function ensureSchema(env) {
  return env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS lw_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "group" TEXT NOT NULL,
      key TEXT NOT NULL,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE ("group", key)
    )`
  ).run();
}

// GET /settings/{group} — return every key in the group as `{ key: parsedJson }`
// (Laravel's `Settings::group()->toArray()`-equivalent). Missing group -> `{}`.
export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const method = (ctx.request && ctx.request.method) || ctx.method || 'GET';
  const group = String(ctx.params && ctx.params.group);

  try {
    await ensureSchema(env);

    if (method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT key, json FROM lw_settings WHERE "group" = ?1 ORDER BY key'
      ).bind(group).all();
      const settings = {};
      for (const r of (rows.results || [])) {
        settings[r.key] = JSON.parse(r.json);
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({ group, settings }),
      };
    }

    if (method === 'PUT') {
      const payload = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
      // Upsert each key (mirrors Settings::save(), which diffs+writes changed
      // keys). A D1 UNIQUE(group,key) constraint backs the upsert.
      const keys = Object.keys(payload);
      for (const key of keys) {
        await env.DB.prepare(
          `INSERT INTO lw_settings ("group", key, json) VALUES (?1, ?2, ?3)
           ON CONFLICT("group", key) DO UPDATE SET json = excluded.json,
             updated_at = datetime('now')`
        ).bind(group, key, JSON.stringify(payload[key])).run();
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group, updated: keys }),
      };
    }

    return {
      status: 405,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'method not allowed' }),
    };
  } catch (err) {
    return {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: String((err && err.message) || err) }),
    };
  }
}
