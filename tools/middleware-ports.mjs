// tools/middleware-ports.mjs — attach registry.json "middlewarePorts" to the
// route table.
//
// build.mjs used to `routeTable.find(...)`, so when a URI appeared twice (a GET
// and a POST entry, for example) only the first entry got the ports: requests
// reaching the second handler silently skipped the middleware. Every table
// entry with that URI is the same Laravel route, so all of them get the same
// port list. Separate from build.mjs so the rule can be pinned by a fast unit
// test instead of a full build.

/**
 * @param {Array<{ uri: string, kind?: string, middlewarePorts?: string[] }>} routeTable
 * @param {Map<string, string[]> | Record<string, string[]>} middlewarePortsMap
 * @param {(route: string) => boolean} isIgnored
 * @param {(msg: string) => void} fail
 */
export function applyMiddlewarePorts(routeTable, middlewarePortsMap, isIgnored, fail) {
  const declared = middlewarePortsMap instanceof Map
    ? middlewarePortsMap
    : Object.entries(middlewarePortsMap ?? {});
  for (const [route, slugs] of declared) {
    if (isIgnored(route)) {
      fail(
        `registry.json declares ${route} in BOTH "middlewarePorts" and "ignore" — the middleware cannot wrap a route the edge does not serve.`
      );
    }
    const matching = routeTable.filter((entry) => entry.uri === route);
    if (!matching.length) {
      fail(
        `registry.json "middlewarePorts" names ${route}, but the route table has no such route — the path must match route:list exactly.`
      );
    }
    for (const entry of matching) {
      if (entry.kind === 'snapshot' || entry.kind === 'unhandled' || entry.kind === 'ignore') {
        fail(
          `registry.json "middlewarePorts" wraps ${route}, but that route has no request-time handler (kind '${entry.kind}').\n` +
            '  A middleware port runs in the Worker, so the route needs a compiled controller or a "ports" handler behind it: ' +
            'give it one, or drop the "middlewarePorts" entry.'
        );
      }
    }
    for (const entry of matching) entry.middlewarePorts = slugs;
  }
}
