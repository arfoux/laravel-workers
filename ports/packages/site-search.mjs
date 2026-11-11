import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// ports/packages/site-search.mjs — spatie/laravel-site-search port.
//
// Route contract (registry.json → {"ports": {"/site-search": "site-search"}}):
//   GET /site-search?q=<term>[&index=<uid>][&limit=n]
//     → proxies to Meilisearch `POST /indexes/{uid}/search` with body {q, limit}
//     → 200 { hits: [...], query, totalHits }
//   missing/empty `q` → 422 (Laravel JSON error bag)
//   Meilisearch unreachable / non-2xx → 502
//
// Env: MEILISEARCH_HOST (required), MEILISEARCH_KEY (optional; sent as Bearer).
// The index uid defaults to env.SITE_SEARCH_INDEX, falling back to env.SCOUT_INDEX,
// then 'default' — matching spatie/laravel-site-search's configurable index.
//
// Substitutions (disclosed):
//   - spatie/laravel-site-search's Searchable aspect + Scout sync (vendor,
//     LW002-refused) → indexing happens out-of-band; this route only searches
//     the upstream Meilisearch index.
//   - guzzle HTTP client → global `fetch` (or an injected `fetchImpl` in tests).

// Build the upstream search URL. Tolerates a trailing slash on the host.
function searchUrl(host, indexUid) {
  const base = String(host || '').replace(/\/+$/, '');
  return `${base}/indexes/${encodeURIComponent(indexUid)}/search`;
}

// Forward a site search to Meilisearch. `fetchImpl` is injectable so tests
// never touch the network. Throws on a non-2xx upstream response.
export async function searchMeilisearch(env, indexUid, searchParams, fetchImpl = globalThis.fetch) {
  const host = env && env.MEILISEARCH_HOST;
  const key = (env && (env.MEILISEARCH_KEY ?? env.MEILISEARCH_API_KEY)) || '';
  if (!host) throw new Error('MEILISEARCH_HOST not configured');
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(searchUrl(host, indexUid), {
    method: 'POST',
    headers,
    body: JSON.stringify(searchParams),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (json && (json.message || json.error)) || `meilisearch search failed (${res.status})`;
    throw new Error(message);
  }
  return json;
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const json = (status, payload) => ({
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  // Validate `q` (required, non-empty) — Laravel JSON error bag on failure.
  const q = ctx.query && ctx.query.q != null ? String(ctx.query.q) : '';
  if (!q.trim()) {
    return json(422, {
      message: 'The given data was invalid.',
      errors: { q: ['The q field is required.'] },
    });
  }

  const indexUid =
    (ctx.query && ctx.query.index) ||
    (env && (env.SITE_SEARCH_INDEX || env.SCOUT_INDEX)) ||
    'default';

  const searchParams = { q, limit: 20 };
  if (ctx.query && ctx.query.limit != null) {
    const limit = Number(ctx.query.limit);
    if (Number.isFinite(limit) && limit > 0) searchParams.limit = Math.floor(limit);
  }

  try {
    const upstream = await searchMeilisearch(env, indexUid, searchParams, ctx.fetchImpl);
    const hits = Array.isArray(upstream && upstream.hits) ? upstream.hits : [];
    const totalHits =
      typeof (upstream && upstream.estimatedTotalHits) === 'number'
        ? upstream.estimatedTotalHits
        : (upstream && typeof upstream.totalHits === 'number' ? upstream.totalHits : hits.length);
    return json(200, { hits, query: q, totalHits });
  } catch (err) {
    return json(502, { error: String((err && err.message) || err) });
  }
}
