// nearfind-edge — the request path runs NO interpreter and does NO booting.
// Static pages are prerendered at build time and served by the asset layer
// (this worker is never invoked for them). Dynamic endpoints are small ports
// mapped in registry.generated.mjs — straight to D1, no framework.
import * as registry from './registry.generated.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' || request.method === 'HEAD') {
      const port = registry.ports[url.pathname];
      if (port) return port(request, env);
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, worker: 'nearfind-edge', builtAt: registry.builtAt });
    }

    return env.ASSETS.fetch(request);
  },
};
