import { normalizePortCtx, jsonResponse } from '../../kernel/packages/port-ctx.mjs';
import { timingSafeEqual } from '../../kernel/packages/webhook.mjs';

// ports/packages/scout-algolia.mjs — laravel/scout (v11.9.0) +
// algolia/algoliasearch-client-php (v4.51.0) search port.
//
// Route contract (registry.json → {"ports": {"/1/indexes/{name}/query": "scout-algolia"}}):
//   POST /1/indexes/{name}/query
//   headers: X-Algolia-Application-Id, X-Algolia-API-Key
//   body: { query, attributesToRetrieve?, facetFilters?, ... }
//   → proxies to Algolia `POST /1/indexes/{name}/query` with the `X-Algolia-*`
//     headers, preserving the SDK's `hits` / `nbHits` / `page` shape.
//
// The PHP SDK reads the app id / api key from its client constructor; on the
// edge they arrive from the client's `X-Algolia-*` headers (mirroring the JS
// search client) and are re-emitted upstream from the worker secrets. The
// handler validates that the presented credentials match `env.ALGOLIA_APP_ID`
// / `env.ALGOLIA_KEY` before proxying — a public, unauthenticated proxy to a
// metered search API would be an abuse vector.
//
// Substitutions (disclosed):
//   - guzzle HTTP client → global `fetch` (injectable `fetchImpl` in tests).
//   - Scout `Searchable`/Engine (vendor) → this route port.
//
// Free-tier: one search = one subrequest. No D1 involved.

const ALGOLIA_HOSTS = {
  // read: search client; write: admin client. Both live under the app id.
  read: (appId) => `${appId}-dsn.algolia.net`,
  write: (appId) => `${appId}.algolia.net`,
};

function algoliaHeaders(appId, apiKey) {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-algolia-application-id': String(appId),
    'x-algolia-api-key': String(apiKey),
  };
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    const indexName = ctx.params?.name;
    if (!indexName) {
      return jsonResponse(400, { error: 'missing index name' }, { noStore: false });
    }
    const appId = env.ALGOLIA_APP_ID;
    const apiKey = env.ALGOLIA_KEY ?? env.ALGOLIA_API_KEY;
    if (!appId || !apiKey) {
      return jsonResponse(500, { error: 'ALGOLIA_APP_ID / ALGOLIA_KEY not configured' }, { noStore: false });
    }

    // Verify the presented X-Algolia-* headers against the configured secrets.
    // Both are REQUIRED: validating only the headers that happen to be present
    // let a caller with no credentials at all (or one that simply omits the key)
    // proxy through the worker's own secret — an open proxy to a metered API.
    // Constant-time compare, mirroring `hash_equals()`.
    const reqHeaders = ctx.request?.headers ?? {};
    const readHeader = (k) => (typeof reqHeaders.get === 'function' ? reqHeaders.get(k) : reqHeaders[k]);
    const presentedAppId = readHeader('x-algolia-application-id');
    const presentedKey = readHeader('x-algolia-api-key');
    if (!presentedAppId || !timingSafeEqual(presentedAppId, appId)) {
      return jsonResponse(403, { error: 'application id mismatch' }, { noStore: false });
    }
    if (!presentedKey || !timingSafeEqual(presentedKey, apiKey)) {
      return jsonResponse(403, { error: 'api key mismatch' }, { noStore: false });
    }

    const body = typeof ctx.body === 'string' ? JSON.parse(ctx.body || '{}') : (ctx.body || {});
    const searchBody = { query: body.query ?? '', ...body };
    if (searchBody.query === '') delete searchBody.query; // SDK omits empty query

    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
    const url = `https://${ALGOLIA_HOSTS.read(appId)}/1/indexes/${encodeURIComponent(indexName)}/query`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: algoliaHeaders(appId, apiKey),
      body: JSON.stringify(searchBody),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const message = (json && (json.message || json.error)) || `algolia search failed (${res.status})`;
      return jsonResponse(res.status, { error: message }, { noStore: false });
    }

    // Preserve Algolia's response contract: hits, nbHits, page, nbPages, params.
    return jsonResponse(200, {
      hits: json?.hits ?? [],
      nbHits: json?.nbHits ?? 0,
      page: json?.page ?? 0,
      nbPages: json?.nbPages ?? 0,
      ...(json?.params ? { params: json.params } : {}),
      ...(json?.facets ? { facets: json.facets } : {}),
    });
  } catch (err) {
    return jsonResponse(502, { error: String((err && err.message) || err) }, { noStore: false });
  }
}
