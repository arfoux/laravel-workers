// nearfind-edge — request path uses the W3 router (M2); no PHP at request time.
import { normalizeTable, dispatch } from './kernel/router.mjs';
import { routeTable, handlers, builtAt } from './routes.generated.mjs';

const table = normalizeTable(routeTable);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'PUT' || request.method === 'POST') {
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
      return Response.json({ ok: true, worker: 'nearfind-edge', builtAt });
    }

    return env.ASSETS.fetch(request);
  },
};
