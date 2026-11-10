// tools/route-map.mjs — the runtime `route()` table (name → uri).
//
// Laravel's `route('login.store')` answers an ABSOLUTE URL (`http://host/login`),
// and the compiled rung must too. This table is built from the route scan, which
// is deduped PER PATH (`normalize(uri)`), so a path carrying two names — the
// idiomatic `Route::get('/login')->name('login')` plus
// `Route::post('/login')->name('login.store')` — has to contribute BOTH. Taking
// only the first named verb's name (what `metaForRoute()` returns) dropped the
// POST name, and a compiled view calling `route('login.store')` fell through to
// the build-time URL map, whose value is ROOT-RELATIVE (the dev origin is
// stripped) — the page emitted `/login` where PHP emitted `http://host/login`.
//
// Values are stored WITHOUT a leading slash: the runtime re-adds the request's
// origin (`joinRoot`), and a root route stays `''` so `route('home')` answers
// `http://host` with no double slash.

/**
 * Build `{ name: uri }` from the scanned routes — one entry per NAME, across all
 * verbs on the path.
 *
 * @param {string[]} routes deduped, normalized route paths
 * @param {Map<string, Set<string>>} methodsFor path → HTTP verbs
 * @param {Map<string, {name?: string}>} metaFor `'METHOD /path'` → route meta
 * @returns {Record<string, string>}
 */
export function buildRouteMap(routes, methodsFor, metaFor) {
  const map = {};
  for (const route of routes) {
    for (const method of methodsFor.get(route) || []) {
      const meta = metaFor.get(method + ' ' + route);
      const name = meta && meta.name;
      if (name && !(name in map)) map[name] = route.replace(/^\//, '');
    }
  }
  return map;
}
