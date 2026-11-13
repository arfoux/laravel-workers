import { normalizePortCtx, jsonResponse } from '../../kernel/packages/port-ctx.mjs';

// Port of spatie/laravel-query-builder v7.3.7 — request-driven query building
// against an allowlist. In Laravel you configure a builder with
// `allowedFilters(...)`, `allowedSorts(...)`, `allowedFields(...)`,
// `allowedAppends(...)` and it reads `filter[...]`, `sort`, `fields[...]`,
// `append` from the request to compose an Eloquent query. Here the same four
// inputs compose a single parameterised SQL string against a D1 table, with
// the allowlist enforced before any SQL is emitted.
//
// Substitution + disclosure (algorithmic, 1:1 intent):
//   - Eloquent query object -> a SQL string + bound params built by hand.
//   - Relations (`fields[relation]`, `filter[relation.field]`, `append` of a
//     relation attribute) are NOT supported: D1/SQLite has no eager loading.
//     Only top-level columns are filtered/selected. Disclosure: a disallowed
//     or relation-scoped filter/sort/field/append is silently ignored, exactly
//     like spatie's default behaviour for a filter not in `allowedFilters`.
//   - `Filter::partial()` -> `LIKE '%value%'`. `Filter::exact()` -> `=` or
//     `IN (...)` when the value contains commas (spatie's `exact` + array).
//
// Route wiring: registry.json → "ports": { "/posts": "spatie-query-builder" }
//   GET /posts?filter[status]=published&filter[title]=laravel&sort=-created_at,title&fields[posts]=id,title,status&append=excerpt
//
// D1 schema (this cluster owns the demo table):
//   CREATE TABLE IF NOT EXISTS posts (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     title TEXT NOT NULL,
//     status TEXT NOT NULL,
//     author_id INTEGER NOT NULL,
//     created_at TEXT NOT NULL DEFAULT (datetime('now'))
//   );

export async function ensureSchema(env) {
  return env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
}

// ---------------------------------------------------------------------------
// Parsing (pure, no DB) — mirrors spatie's request introspection.
// ---------------------------------------------------------------------------
export function parseQueryBuilderRequest(searchParams) {
  const filters = {};
  let sorts = [];
  const fields = [];
  const appends = [];

  for (const [rawKey, rawValue] of searchParams.entries()) {
    const key = rawKey;
    const value = rawValue;
    if (key.startsWith('filter[') && key.endsWith(']')) {
      const col = key.slice('filter['.length, -1);
      // relation scope `filter[relation.field]` -> unsupported, kept but ignored
      filters[col] = value;
    } else if (key === 'sort') {
      sorts = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (key === 'fields') {
      fields.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (key.startsWith('fields[') && key.endsWith(']')) {
      // top-level `fields[posts]` -> same column set (relation ignored)
      fields.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (key === 'append') {
      appends.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
    }
  }
  return { filters, sorts, fields, appends };
}

// ---------------------------------------------------------------------------
// SQL building (pure) — allowlist enforced here, before SQL is emitted.
//   exactFilters : columns matched with `=` (or IN for comma values)
//   partialFilters: columns matched with LIKE %value%
//   allowSorts   : sortable columns
//   allowFields  : selectable columns
// ---------------------------------------------------------------------------
export function buildSql(table, parsed, config) {
  const exact = config.exactFilters || [];
  const partial = config.partialFilters || [];
  const allowSorts = config.allowSorts || [];
  const allowFields = config.allowFields || [];

  const params = [];
  const whereClauses = [];

  for (const [col, value] of Object.entries(parsed.filters)) {
    if (exact.includes(col)) {
      const parts = String(value).split(',').map((v) => v.trim()).filter(Boolean);
      if (parts.length > 1) {
        whereClauses.push(`${col} IN (${parts.map(() => '?').join(', ')})`);
        params.push(...parts);
      } else {
        whereClauses.push(`${col} = ?`);
        params.push(parts[0] ?? value);
      }
    } else if (partial.includes(col)) {
      whereClauses.push(`${col} LIKE ?`);
      params.push(`%${value}%`);
    }
    // else: disallowed / relation filter -> ignored (spatie default)
  }

  const orderParts = [];
  for (const raw of parsed.sorts) {
    const desc = raw.startsWith('-');
    const col = desc ? raw.slice(1) : raw;
    if (allowSorts.includes(col)) {
      orderParts.push(`${col} ${desc ? 'DESC' : 'ASC'}`);
    }
  }

  const selected = parsed.fields.filter((f) => allowFields.includes(f));
  const selectList = selected.length ? selected.join(', ') : '*';

  let sql = `SELECT ${selectList} FROM ${table}`;
  if (whereClauses.length) sql += ` WHERE ${whereClauses.join(' AND ')}`;
  if (orderParts.length) sql += ` ORDER BY ${orderParts.join(', ')}`;

  return { sql, params };
}

// Default demo config for the `posts` table. Appends are computed in JS
// post-fetch (Laravel appends are model accessors).
const POSTS_CONFIG = {
  table: 'posts',
  exactFilters: ['status', 'author_id'],
  partialFilters: ['title'],
  allowSorts: ['id', 'title', 'status', 'author_id', 'created_at'],
  allowFields: ['id', 'title', 'status', 'author_id', 'created_at'],
  appends: {
    excerpt: (row) => (row.title ? String(row.title).slice(0, 20) : ''),
    is_published: (row) => row.status === 'published',
  },
};

// port-ctx owns the envelope; this port sends no cache-control.
const json = (status, payload, extraHeaders = {}) =>
  jsonResponse(status, payload, { noStore: false, headers: extraHeaders });

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const method = (ctx.request && ctx.request.method) || ctx.method || 'GET';

  try {
    await ensureSchema(env);

    if (method === 'GET') {
      const url = new URL(ctx.request ? ctx.request.url : 'http://x/' + (ctx.url || ''));
      const parsed = parseQueryBuilderRequest(url.searchParams);
      const { sql, params } = buildSql(POSTS_CONFIG.table, parsed, POSTS_CONFIG);

      const result = await env.DB.prepare(sql).bind(...params).all();
      let rows = (result.results || []).map((r) => ({ ...r }));

      // Append computed attributes (only allowlisted names).
      const appliedAppends = parsed.appends.filter((a) => POSTS_CONFIG.appends[a]);
      for (const row of rows) {
        for (const name of appliedAppends) {
          row[name] = POSTS_CONFIG.appends[name](row);
        }
      }

      return json(200, {
        sql,            // disclosure: the emitted query (hand-built, not Eloquent)
        params,
        applied: {
          filters: Object.keys(parsed.filters).filter((c) =>
            POSTS_CONFIG.exactFilters.includes(c) || POSTS_CONFIG.partialFilters.includes(c)),
          sorts: parsed.sorts.filter((c) => {
            const col = c.startsWith('-') ? c.slice(1) : c;
            return POSTS_CONFIG.allowSorts.includes(col);
          }),
          fields: parsed.fields.filter((f) => POSTS_CONFIG.allowFields.includes(f)),
          appends: appliedAppends,
        },
        data: rows,
      });
    }

    return json(405, { error: 'method not allowed' });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}