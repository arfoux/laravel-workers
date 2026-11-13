import { normalizePortCtx, jsonResponse } from '../../kernel/packages/port-ctx.mjs';

// Port of spatie/laravel-translatable v6.15.0 — per-locale translation columns
// stored as JSON. In Laravel a translatable model declares which attributes are
// translatable; each is stored as a JSON object `{ "en": "...", "nl": "..." }`.
// `getTranslation(attr, locale)` reads one locale (with fallback), `setTranslation`
// merges into the JSON, and `whereTranslationLike(attr, term, locale)` queries a
// single locale via `json_extract`. Ported directly onto a D1 table whose
// translatable columns hold the same JSON.
//
// Route wiring: registry.json → "ports": {
//   "/translatable":        "spatie-translatable",  // GET list / POST create
//   "/translatable/{id}":   "spatie-translatable",  // GET one / PUT setTranslation
// }
//   GET  /translatable?locale=nl                     -> list, locale-resolved
//   GET  /translatable/{id}?locale=nl                -> one, locale-resolved
//   POST /translatable        { title:{en,nl}, body:{en} }
//   PUT  /translatable/{id}   { title:{nl:"..."} }   -> setTranslation (merge)
//   GET  /translatable-search?column=title&locale=en&q=lar
//
// D1 schema (this cluster owns the table):
//   CREATE TABLE IF NOT EXISTS translatable_posts (
//     id         INTEGER PRIMARY KEY AUTOINCREMENT,
//     title      TEXT NOT NULL DEFAULT '{}',  -- JSON {locale: string}
//     body       TEXT NOT NULL DEFAULT '{}',  -- JSON {locale: string}
//     created_at TEXT NOT NULL DEFAULT (datetime('now')),
//     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
//   );

const TRANSLATABLE_COLUMNS = ['title', 'body'];
const LOCALES = ['en', 'nl', 'fr'];
const FALLBACK_LOCALE = 'en';

export async function ensureSchema(env) {
  return env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS translatable_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '{}',
      body TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
}

// port-ctx owns the envelope; this port sends no cache-control.
const json = (status, payload, extraHeaders = {}) =>
  jsonResponse(status, payload, { noStore: false, headers: extraHeaders });

// getTranslation: read one locale from a stored JSON column, falling back to
// FALLBACK_LOCALE when the locale is missing/empty and fallback is enabled.
export function getTranslation(jsonText, locale, { fallback = true, fallbackLocale = FALLBACK_LOCALE } = {}) {
  let map = {};
  try { map = jsonText ? JSON.parse(jsonText) : {}; } catch { map = {}; }
  const raw = map[locale];
  if (raw != null && raw !== '') return raw;
  if (fallback) {
    const fb = map[fallbackLocale];
    if (fb != null && fb !== '') return fb;
  }
  return null;
}

// Resolve every translatable column of a row into a flat locale-resolved object.
export function resolveRow(row, locale, opts) {
  const out = { id: row.id, locale };
  for (const col of TRANSLATABLE_COLUMNS) {
    out[col] = getTranslation(row[col], locale, opts);
  }
  out.translations = {};
  for (const col of TRANSLATABLE_COLUMNS) {
    try { out.translations[col] = row[col] ? JSON.parse(row[col]) : {}; } catch { out.translations[col] = {}; }
  }
  return out;
}

async function findRow(env, id) {
  return env.DB.prepare('SELECT * FROM translatable_posts WHERE id = ?').bind(Number(id)).first();
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const method = (ctx.request && ctx.request.method) || ctx.method || 'GET';
  const url = new URL(ctx.request ? ctx.request.url : 'http://x/' + (ctx.url || ''));
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const segs = url.pathname.split('/').filter(Boolean);
  const id = (ctx.params && ctx.params.id) != null ? ctx.params.id : segs[1];

  try {
    await ensureSchema(env);

    // GET /translatable-search — whereTranslationLike via json_extract
    if (method === 'GET' && url.pathname.endsWith('/translatable-search')) {
      const column = url.searchParams.get('column') || 'title';
      const locale = url.searchParams.get('locale') || FALLBACK_LOCALE;
      const q = url.searchParams.get('q') || '';
      if (!TRANSLATABLE_COLUMNS.includes(column)) {
        return json(400, { error: `column '${column}' is not translatable` });
      }
      const sql =
        `SELECT * FROM translatable_posts WHERE json_extract(${column}, '$.${locale}') LIKE ? ORDER BY id`;
      const rows = await env.DB.prepare(sql).bind(`%${q}%`).all();
      const data = (rows.results || []).map((r) => resolveRow(r, locale));
      return json(200, { query: { column, locale, q, sql }, data });
    }

    // Collection
    if (method === 'GET' && !id) {
      const locale = url.searchParams.get('locale') || FALLBACK_LOCALE;
      const rows = await env.DB.prepare('SELECT * FROM translatable_posts ORDER BY id').all();
      const data = (rows.results || []).map((r) => resolveRow(r, locale));
      return json(200, { locale, data });
    }

    // Single
    if (method === 'GET' && id) {
      const row = await findRow(env, id);
      if (!row) return json(404, { error: 'not found' });
      const locale = url.searchParams.get('locale') || FALLBACK_LOCALE;
      const fallback = url.searchParams.get('fallback') !== 'false';
      return json(200, resolveRow(row, locale, { fallback }));
    }

    // Create — each translatable column serialised to JSON
    if (method === 'POST' && !id) {
      const cols = {};
      for (const col of TRANSLATABLE_COLUMNS) {
        const val = body[col];
        cols[col] = JSON.stringify(val && typeof val === 'object' ? val : {});
      }
      const res = await env.DB.prepare(
        'INSERT INTO translatable_posts (title, body) VALUES (?, ?)'
      ).bind(cols.title, cols.body).run();
      const row = await findRow(env, res.last_row_id ?? res.meta?.last_row_id);
      return json(201, resolveRow(row, FALLBACK_LOCALE));
    }

    // setTranslation — merge provided {locale:value} into existing JSON per column
    if (method === 'PUT' && id) {
      const row = await findRow(env, id);
      if (!row) return json(404, { error: 'not found' });
      const updates = [];
      const params = [];
      for (const col of TRANSLATABLE_COLUMNS) {
        const patch = body[col];
        if (!patch || typeof patch !== 'object') continue;
        let map = {};
        try { map = row[col] ? JSON.parse(row[col]) : {}; } catch { map = {}; }
        for (const [loc, val] of Object.entries(patch)) {
          if (!LOCALES.includes(loc)) continue; // unknown locale ignored
          map[loc] = String(val);
        }
        updates.push(`${col} = ?`);
        params.push(JSON.stringify(map));
      }
      if (updates.length) {
        updates.push(`updated_at = datetime('now')`);
        await env.DB.prepare(
          `UPDATE translatable_posts SET ${updates.join(', ')} WHERE id = ?`
        ).bind(...params, Number(id)).run();
      }
      const fresh = await findRow(env, id);
      const locale = url.searchParams.get('locale') || FALLBACK_LOCALE;
      return json(200, resolveRow(fresh, locale));
    }

    return json(405, { error: 'method not allowed' });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}