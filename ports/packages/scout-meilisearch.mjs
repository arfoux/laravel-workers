import { normalizePortCtx, jsonResponse } from '../../kernel/packages/port-ctx.mjs';

// ports/packages/scout-meilisearch.mjs — laravel/scout (v11.9.0) +
// meilisearch/meilisearch-php (v1.x) search port.
//
// Route contract (registry.json → {"ports": {"/search": "scout-meilisearch"}}):
//   GET /search?q=<query>[&index=<uid>][&filter=<expr>][&limit=n][&offset=n][&sort=field:asc]
//   → proxies to Meilisearch `POST /indexes/{uid}/search`, preserving the
//     `hits` / `estimatedTotalHits` shape 1:1.
//
// Settings port (applied once at build/deploy, not per request):
//   import { putSettings } from '<...>/scout-meilisearch.mjs';
//   await putSettings(env, 'products', { searchableAttributes: ['name'] });
//
// Substitutions (disclosed):
//   - guzzle HTTP client → global `fetch` (or an injected `fetchImpl` in tests).
//   - Scout's `Searchable` trait / Engine (vendor, LW002-refused) → this route
//     port; indexing sync happens out-of-band, the route only searches.
//
// D1 (optional observability): every search appends a row to `scout_search_log`
// so the free-tier budget can be watched. `ensureSchema` is idempotent.
//
// Free-tier note: one search = one subrequest to Meilisearch + one D1 insert.
// 50 subrequests/req and 100k D1 rows/day are far from hit by a search route.

export async function ensureSchema(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS scout_search_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      index_uid TEXT NOT NULL,
      q TEXT,
      hits INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
}

// Build the upstream search URL. `env.MEILISEARCH_HOST` may or may not carry a
// trailing slash; the Meilisearch PHP SDK tolerates both.
function searchUrl(host, indexUid) {
  const base = String(host || '').replace(/\/+$/, '');
  return `${base}/indexes/${encodeURIComponent(indexUid)}/search`;
}

// Forward a search to Meilisearch and return the parsed JSON body.
// `fetchImpl` is injectable so tests never touch the network.
export async function searchMeilisearch(env, indexUid, searchParams, fetchImpl = globalThis.fetch) {
  const host = env.MEILISEARCH_HOST;
  const key = env.MEILISEARCH_KEY ?? env.MEILISEARCH_API_KEY;
  if (!host) throw new Error('MEILISEARCH_HOST not configured');
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetchImpl(searchUrl(host, indexUid), {
    method: 'POST',
    headers,
    body: JSON.stringify(searchParams),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (json && (json.message || json.error)) || `meilisearch search failed (${res.status})`;
    throw new Error(message);
  }
  return json;
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    const q = (ctx.query && ctx.query.q) ?? ctx.request?.input?.('q') ?? '';
    const indexUid = (ctx.query && ctx.query.index) || env.SCOUT_INDEX || 'default';
    const searchParams = { q: String(q) };
    const filter = ctx.query?.filter;
    if (filter) searchParams.filter = filter;
    if (ctx.query?.limit != null) searchParams.limit = Number(ctx.query.limit);
    if (ctx.query?.offset != null) searchParams.offset = Number(ctx.query.offset);
    if (ctx.query?.sort) {
      // Accept `sort=field:asc,other:desc` and normalize to Meilisearch's array form.
      searchParams.sort = String(ctx.query.sort).split(',').map((s) => s.trim()).filter(Boolean);
    }

    const json = await searchMeilisearch(env, indexUid, searchParams, ctx.fetchImpl);

    // Log best-effort; a failed log insert must not fail the search.
    if (env.DB) {
      try {
        await ensureSchema(env);
        await env.DB.prepare('INSERT INTO scout_search_log (index_uid, q, hits) VALUES (?, ?, ?)')
          .bind(indexUid, String(q), json && typeof json.estimatedTotalHits === 'number' ? json.estimatedTotalHits : null)
          .run();
      } catch { /* observability only */ }
    }

    // Preserve Meilisearch's exact response shape — the client (and Scout's
    // hydration path) reads `hits` and `estimatedTotalHits` verbatim.
    return jsonResponse(200, {
      hits: json?.hits ?? [],
      estimatedTotalHits: json?.estimatedTotalHits ?? 0,
      ...(json?.processingTimeMs != null ? { processingTimeMs: json.processingTimeMs } : {}),
      ...(json?.facetDistribution ? { facetDistribution: json.facetDistribution } : {}),
    });
  } catch (err) {
    return jsonResponse(502, { error: String((err && err.message) || err) }, { noStore: false });
  }
}

// Apply index settings once (build/deploy hook, NOT the request route).
// Mirrors the PHP SDK's `updateSettings` (PUT /indexes/{uid}/settings).
export async function putSettings(env, indexUid, settings, fetchImpl = globalThis.fetch) {
  const host = String(env.MEILISEARCH_HOST || '').replace(/\/+$/, '');
  if (!host) throw new Error('MEILISEARCH_HOST not configured');
  const key = env.MEILISEARCH_KEY ?? env.MEILISEARCH_API_KEY;
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetchImpl(`${host}/indexes/${encodeURIComponent(indexUid)}/settings`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(settings),
  });
  if (!res.ok && res.status !== 202) {
    const text = await res.text().catch(() => '');
    throw new Error(`meilisearch settings failed (${res.status}): ${text}`);
  }
  return { ok: true, task: await res.json().catch(() => null) };
}
