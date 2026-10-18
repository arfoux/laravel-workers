// tools/routes-json.mjs — generate Cloudflare Static Assets `_routes.json`.
//
// With `_routes.json` present, the Worker is only invoked for the `include`
// patterns; everything else is served straight from static assets (0
// invocations). Dynamic (compiled/port) routes are the only ones that need the
// Worker, so they become the include list; public asset dirs are excluded.

// Convert a Laravel-style uri into one or more Cloudflare patterns.
export function routeToPatterns(uri) {
  const norm = uri === '/' || uri === '' ? '/' : '/' + String(uri).replace(/^\/+|\/+$/g, '');
  if (norm === '/') return ['/'];
  const segs = norm.slice(1).split('/');
  const head = (n) => '/' + segs.slice(0, n).join('/');
  const last = segs[segs.length - 1];

  if (/^\{[^}]*\?\}$/.test(last)) {
    const base = head(segs.length - 1);
    if (base === '/') return ['/'];
    return [base, base + '/*'];
  }
  if (/\*/.test(last)) {
    return [head(segs.length - 1) + '/*'];
  }
  const mapped = segs.map((s) => (/^\{[^}]+\}$/.test(s) ? '*' : s)).join('/');
  return ['/' + mapped];
}

export function buildRoutesJson(routeTable, opts = {}) {
  const publicDirs = opts.publicDirs || [];
  const extraInclude = opts.extraInclude || [];
  const include = new Set(extraInclude);
  for (const entry of routeTable || []) {
    if (entry.kind !== 'view' && entry.kind !== 'port') continue;
    for (const p of routeToPatterns(entry.uri)) include.add(p);
  }
  const includeList = [...include].sort();
  const excludeList = publicDirs
    .map((d) => '/' + String(d).replace(/^\/+|\/+$/g, '') + '/*')
    .sort();
  if (includeList.length > 100) throw new Error('_routes.json include exceeds Cloudflare limit (100)');
  if (excludeList.length > 100) throw new Error('_routes.json exclude exceeds Cloudflare limit (100)');
  const out = { version: 1 };
  if (includeList.length) out.include = includeList;
  if (excludeList.length) out.exclude = excludeList;
  return out;
}

export default { routeToPatterns, buildRoutesJson };
