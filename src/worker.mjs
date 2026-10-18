// src/worker.mjs — Example Worker (router → handler → D1)
import { normalizeTable, dispatch } from '../kernel/router.mjs';
import { routeTable, handlers, builtAt } from './routes.generated.mjs';

const table = normalizeTable(routeTable);

// Every method the router may dispatch. Anything else falls through to assets.
const DISPATCH_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (DISPATCH_METHODS.has(request.method)) {
      const res = await dispatch(
        { method: request.method, path: url.pathname + url.search, headers: Object.fromEntries(request.headers) },
        table,
        handlers,
        env
      );
      if (res) {
        const body = request.method === 'HEAD' ? null : res.body;
        return new Response(body, { status: res.status, headers: res.headers });
      }
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, worker: 'laravel-workers', builtAt });
    }

    return env.ASSETS.fetch(request);
  },
};
