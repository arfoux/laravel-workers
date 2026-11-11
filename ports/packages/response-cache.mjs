// ports/packages/response-cache.mjs — full-page response cache middleware, the
// edge port of spatie/laravel-responsecache.
//
// Parity target: `Spatie\ResponseCache\Commands\Clear` / the package's
// `CacheResponse` + `DispatchCacheClearCommands` middleware pair. In Laravel the
// middleware caches the rendered response for a GET (keyed by the full URI) and
// serves it on the next identical GET; a mutating request to the same path
// triggers a cache clear so stale pages never outlive the change that made them
// stale.
//
// Workers shape of that contract, given the port returns to a router that
// dispatches to the real controller when the port passes:
//   - GET       -> serve the cached page on a hit; return `null` on a miss so
//                  the origin (the compiled controller) renders and the caller
//                  can `put()` the result it wants cached.
//   - POST/PUT/ -> purge the cached entry for this path (every query variant)
//   - PATCH/       and pass through to the origin (`null`). The write goes to
//     DELETE       the database; the next GET re-caches the fresh page.
// Other verbs (HEAD/OPTIONS) are left alone — pass-through.
//
// Like every port, `ctx` is normalised first: on the real kernel Request the
// accessors are METHODS (`method()`, `pathInfo()`, `getQueryString()`), while a
// unit test hands us a plain object. `normalizePortCtx` flattens both into the
// same shape.
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';
import { get as cacheGet, purge as cachePurge } from '../../kernel/packages/response-cache.mjs';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const method = String(ctx.method || 'GET').toUpperCase();
  const db = ctx.db;
  // No D1 binding -> the cache is inert; pass through either way so the origin
  // always sees the request. This keeps the port safe to wire unconditionally.
  if (!db) return null;

  const path = String(ctx.request.path || '/');

  if (method === 'GET') {
    const hit = await cacheGet(path, ctx.request.getQueryString(), db);
    // Miss (or expired): hand the request to the origin. The caller caches the
    // rendered response via kernel `put()` — we deliberately do not own the
    // render step, so this port composes with any controller.
    if (!hit) return null;
    return {
      status: hit.status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-response-cache': 'HIT',
        ...(hit.headers && typeof hit.headers === 'object' ? hit.headers : {}),
      },
      body: hit.body,
    };
  }

  if (MUTATING.has(method)) {
    // Invalidate every cached variant of this path, then pass through so the
    // origin performs the write. `null` = "not served from cache".
    await cachePurge(path, db);
    return null;
  }

  return null;
}
