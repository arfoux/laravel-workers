// src/worker.mjs — compiled Worker entry point
//   fetch -> kernel/http.mjs (EncryptCookies -> StartSession -> CSRF -> route middleware)
//        -> kernel/router.mjs handler -> cookies/session persisted back onto the response.
//
// Everything the compiled rung does not support fails loud inside handleHttp; this
// file only adapts the Workers Request/Response boundary.
import { normalizeTable } from '../kernel/router.mjs';
import { handleHttp } from '../kernel/http.mjs';
import { createDatabaseCache } from '../kernel/cache.mjs';
import { routeTable, handlers, builtAt } from './routes.generated.mjs';
import config from './config.generated.mjs';
import { models } from './models.generated.mjs';

const table = normalizeTable(routeTable);

// Every method the router may dispatch. Anything else falls through to assets.
const DISPATCH_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// The `database` cache driver compiled to D1 backs `throttle:n,m` and the Cache
// facade. Only built when the app's default cache store IS `database`; any other
// driver leaves it null, and a `throttle` route then fails loud inside handleHttp.
function makeCache(env) {
  if (!env || !env.DB || config['cache.driver'] !== 'database') return null;
  return createDatabaseCache({ db: env.DB, config });
}

function toResponse(res, method) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers || {})) {
    if (v !== undefined && v !== null) headers.set(k, String(v));
  }
  for (const cookie of res.setCookie || []) headers.append('set-cookie', cookie);
  return new Response(method === 'HEAD' ? null : res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (DISPATCH_METHODS.has(request.method)) {
      const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
      const db = env && env.DB ? env.DB : null;
      const res = await handleHttp(
        {
          method: request.method,
          url: request.url,
          // Multiple headers of the same name arrive comma-joined, like PHP's
          // $_SERVER. `set-cookie` never appears on requests, so this is lossless.
          headers: Object.fromEntries(request.headers),
          body,
        },
        {
          table,
          handlers,
          config,
          env,
          db,
          cache: makeCache(env),
          models,
        }
      );
      if (res) return toResponse(res, request.method);
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, worker: 'laravel-workers', builtAt });
    }

    return env.ASSETS.fetch(request);
  },
};
