// kernel/packages/response-cache.mjs — full-page response cache on D1, the
// edge equivalent of spatie/laravel-responsecache. The Laravel package caches
// the rendered response for a GET request (keyed by the full URI) in the
// configured store and serves it on the next GET, purging entries when the
// underlying data changes. On Workers there is no shared filesystem and no
// APCu; D1 is the durable key/value store we already carry for auth/billing,
// so the cached page lives in one table:
//
//   cache_response (
//     id           INTEGER PRIMARY KEY AUTOINCREMENT,
//     cache_key    TEXT    NOT NULL UNIQUE,
//     body         TEXT    NOT NULL,
//     headers_json TEXT    NOT NULL,   -- JSON object, lowercase header names
//     expires_at   INTEGER NOT NULL    -- unix seconds; 0 = no expiry
//   )
//
// Split of concerns:
//   - THIS module is pure storage: key derivation, get, put, purge. It never
//     looks at the HTTP method.
//   - ports/packages/response-cache.mjs is the middleware handler: GET reads
//     (hit -> serve, miss -> pass-through to the origin), mutating verbs purge
//     the cached entry for the same path.
//
// The cache key folds in the query string (like Laravel's `fullUrl`-based key)
// so `/items?page=2` and `/items?page=3` are distinct entries; the mutating
// purge clears every entry for the path regardless of query, which matches the
// package's "forget the page the form posted to" behaviour.

// D1 schema, applied lazily by `init()`. Kept in one place so the migration and
// the runtime agree.
export const CACHE_RESPONSE_SCHEMA = `
CREATE TABLE IF NOT EXISTS cache_response (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);`;

// Derive the cache key for a path + query. Query is normalised through
// URLSearchParams so `a=1&b=2` and `b=2&a=1` share an entry. An empty/absent
// query yields the bare path.
export function cacheKey(path, query) {
  const p = String(path || '/');
  let qs = '';
  if (typeof query === 'string') {
    qs = query;
  } else if (query && typeof query === 'object') {
    qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, v == null ? '' : String(v)])).toString();
  } else {
    qs = '';
  }
  if (!qs) return p;
  // Sort so key order in the incoming object doesn't fragment the cache.
  const sp = new URLSearchParams(qs);
  const sorted = new URLSearchParams([...sp.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${p}?${sorted.toString()}`;
}

// Ensure the backing table exists. Idempotent; safe to call on every miss.
export async function init(db) {
  if (!db) return false;
  await db.prepare(CACHE_RESPONSE_SCHEMA).run();
  return true;
}

// Look up a cached response. Returns `{ status, headers, body }` on a live hit,
// or `null` on a miss / expired entry (an expired row is deleted on read so the
// table self-cleans).
export async function get(path, query, db) {
  if (!db) return null;
  const key = cacheKey(path, query);
  const row = await db
    .prepare('SELECT body, headers_json, expires_at FROM cache_response WHERE cache_key = ?')
    .bind(key)
    .first();
  if (!row) return null;
  const expiresAt = Number(row.expires_at || 0);
  if (expiresAt > 0 && expiresAt <= Math.floor(Date.now() / 1000)) {
    await db.prepare('DELETE FROM cache_response WHERE cache_key = ?').bind(key).run();
    return null;
  }
  let headers = {};
  try {
    headers = row.headers_json ? JSON.parse(row.headers_json) : {};
  } catch {
    headers = {};
  }
  return {
    status: 200,
    headers: headers && typeof headers === 'object' ? headers : {},
    body: String(row.body == null ? '' : row.body),
  };
}

// Store a response. `response` is the port return shape `{status, headers,
// body}`; only 2xx responses are worth caching (a 4xx/5xx page is not a hit we
// want to serve later), and the caller can override with `ttlSeconds`.
// `ttlSeconds <= 0` means "no expiry" (stored as expires_at = 0).
export async function put(path, query, response, db, ttlSeconds = 0) {
  if (!db || !response) return false;
  const status = Number(response.status == null ? 200 : response.status);
  if (!(status >= 200 && status < 300)) return false;
  const key = cacheKey(path, query);
  const body = String(response.body == null ? '' : response.body);
  const headers = response.headers && typeof response.headers === 'object' ? response.headers : {};
  const ttl = Number(ttlSeconds);
  const expiresAt = Number.isFinite(ttl) && ttl > 0 ? Math.floor(Date.now() / 1000) + Math.floor(ttl) : 0;
  // DELETE-then-INSERT is the portable upsert across D1 and the test fake
  // (avoids relying on `ON CONFLICT` support).
  await db.prepare('DELETE FROM cache_response WHERE cache_key = ?').bind(key).run();
  await db
    .prepare('INSERT INTO cache_response (cache_key, body, headers_json, expires_at) VALUES (?, ?, ?, ?)')
    .bind(key, body, JSON.stringify(headers), expiresAt)
    .run();
  return true;
}

// Purge cached entries. Called with a path, it clears that path for every query
// variant (what a mutating request wants); called with no path it flushes the
// whole cache. Returns the number of rows removed.
export async function purge(path, db) {
  if (!db) return 0;
  if (path === undefined || path === null || path === '') {
    const res = await db.prepare('DELETE FROM cache_response').run();
    return Number((res && (res.changes ?? (res.meta && res.meta.changes))) || 0);
  }
  // Purge by path PREFIX so every query variant of the page is dropped (Laravel
  // clears "the page the form posted to", not one query string of it). We match
  // on the bare path and on `path?...`; the LIKE arg is escaped for LIKE use so
  // paths containing `%`/`_` behave.
  const base = String(path);
  const escaped = base.replace(/[\\%_]/g, (c) => '\\' + c);
  const res = await db
    .prepare('DELETE FROM cache_response WHERE cache_key = ? OR cache_key LIKE ? ESCAPE ?')
    .bind(base, escaped + '?%', '\\')
    .run();
  return Number((res && (res.changes ?? (res.meta && res.meta.changes))) || 0);
}
