// tools/routes-json.mjs — generate Cloudflare Static Assets `_routes.json`.
//
// With `_routes.json` present, the Worker is only invoked for the `include`
// patterns; everything else is served straight from static assets (0
// invocations). Dynamic (compiled/port) routes are the only ones that need the
// Worker, so they become the include list; public asset dirs are excluded.
//
// Cloudflare's documented limits on `_routes.json`
// (developers.cloudflare.com/workers/static-assets/routing/advanced/):
//   - at most 100 rules COMBINED across `include` and `exclude`;
//   - each rule at most 100 characters;
//   - at most one `*` per rule, and it must be the last character.
// The build checked include and exclude SEPARATELY against 100, so 60 include +
// 60 exclude (120 combined) passed the build and Cloudflare then rejected the
// file — every request reached the Worker (invocations billed) with no build
// error. The character limit was never checked either.

/** Cloudflare's combined rule cap for `_routes.json`. */
const MAX_RULES = 100;
/** Cloudflare's per-rule length cap. */
const MAX_RULE_LENGTH = 100;

// An optional segment (`{page?}`) — it may be absent.
const isOptionalSeg = (s) => /^\{[^}]*\?\}$/.test(s);

/**
 * Convert a Laravel-style uri into the Cloudflare patterns that cover every
 * request path Laravel's router would match.
 *
 * A trailing `{page?}` is `/posts` OR `/posts/<one segment>`; a MEDIAN one is
 * the pattern without it OR with one wildcard segment in its place — the old
 * code mapped a median optional to a REQUIRED wildcard (`/a/b/{c?}/d` became
 * `/a/b/[*]/d` with a real star inside the brackets), so `/a/b/d` — a path
 * Laravel serves (verified against Laravel 13's router) — was answered from
 * static assets with a 404. A catch-all keeps its single trailing wildcard.
 */
export function routeToPatterns(uri) {
  const norm = uri === '/' || uri === '' ? '/' : '/' + String(uri).replace(/^\/+|\/+$/g, '');
  if (norm === '/') return ['/'];
  const segs = norm.slice(1).split('/');
  // Cloudflare accepts at most ONE `*` per rule and only as the LAST character,
  // so a route with several dynamic segments cannot be spelled as
  // `/users/*/posts/*`: that rule is invalid and Cloudflare then ignores the
  // whole `_routes.json` (every request reaches the Worker, invocations billed,
  // no build error). The rule is therefore a PREFIX ending in one `*`: Laravel's
  // own router decides whether an included request belongs to the route (a
  // static path that does not belong answers the Worker's 404), so the pattern
  // only has to be at least as WIDE as the route — `/users/*` for
  // `/users/{user}/posts/{post}`, `/posts/*` for `/posts/{post}`.
  // A variable need not fill the whole segment (`/enc-suffix-{id}` is a real
  // Laravel uri — Symfony compiles it to `/enc\-suffix\-(?P<id>[^/]++)`), so a
  // segment is dynamic when it CONTAINS a placeholder, and the rule keeps the
  // literal text that precedes it (`/enc-suffix-*`; `/a{id}/b` widens to `/a*`,
  // the only expressible rule — one trailing `*`, no mid-rule wildcard).
  const isDynamic = (s) => /\{[^}]*\}/.test(s) || s === '*';
  const textBeforeVariable = (s) => {
    const at = s.indexOf('{');
    return at === -1 ? s : s.slice(0, at);
  };
  const firstDyn = segs.findIndex(isDynamic);
  // A static route keeps its exact path (one rule, no wildcard).
  if (firstDyn === -1) return ['/' + segs.join('/')];
  const prefix = segs.slice(0, firstDyn);
  const dynText = textBeforeVariable(segs[firstDyn]);
  const glob = (prefix.length ? '/' + prefix.join('/') + '/' : '/') + dynText + '*';
  const out = [glob];
  // An optional segment (`{page?}`) may be ABSENT, and a trailing one makes the
  // bare prefix a path of its own (`/posts` matches `/posts/{page?}`): the
  // literal prefix is emitted too (`/posts`), whose own trailing `*` form is not
  // matched by Cloudflare. `/{any?}` answers `/` (the prefix is empty).
  if (isOptionalSeg(segs[firstDyn])) {
    const bare = prefix.length ? '/' + prefix.join('/') : '/';
    out.unshift(bare);
  }
  return [...new Set(out)];
}

/**
 * Collapse include patterns that share a first path segment into one
 * `/segment/*` rule until the include+exclude total fits `cap`. Cloudflare
 * routes a `/segment/*` include to the Worker, whose own router still picks the
 * exact handler by path — so collapsing only widens WHICH requests reach the
 * Worker, never which handler answers them. It is cap-aware: it fires only when
 * the flat list exceeds the limit (a fleet of package ports on one app blows
 * past Cloudflare's 100 combined rules), and it collapses the largest groups
 * first so a small app keeps its exact per-path rules.
 *
 * Root (`/`) and already-wildcarded top segments are left alone.
 */
function collapseIncludesToCap(includeList, cap) {
  let rules = [...includeList];
  const collapseOnce = (list) => {
    // Group literal-first-segment patterns by that segment.
    const groups = new Map();
    for (const rule of list) {
      const seg = rule.split('/')[1];
      if (!seg || seg === '*') continue; // root or top-level wildcard: skip
      if (!groups.has(seg)) groups.set(seg, []);
      groups.get(seg).push(rule);
    }
    // Pick the collapsible group (>=2 rules) with the biggest reduction.
    let bestSeg = null;
    let bestSaving = 1; // need to save at least 1 rule to bother
    for (const [seg, members] of groups) {
      const saving = members.length - 1;
      if (saving > bestSaving) {
        bestSaving = saving;
        bestSeg = seg;
      }
    }
    if (!bestSeg) return null;
    const dropped = new Set(groups.get(bestSeg));
    const next = list.filter((r) => !dropped.has(r));
    next.push('/' + bestSeg + '/*');
    return [...new Set(next)].sort();
  };
  let guard = 0;
  while (rules.length > cap && guard++ < 500) {
    const next = collapseOnce(rules);
    if (!next) break; // nothing left to collapse
    rules = next;
  }
  return rules;
}

export function buildRoutesJson(routeTable, opts = {}) {
  const publicDirs = opts.publicDirs || [];
  const extraInclude = opts.extraInclude || [];
  // A route kind the WORKER serves at runtime. `worker` is the marker the build
  // uses when it feeds the handler table directly (a route whose controller
  // never compiled is absent there, so it must not be included); the three
  // route-table kinds are kept for callers that pass the table itself.
  const SERVED = new Set(['view', 'port', 'controller', 'worker']);
  const include = new Set(extraInclude);
  for (const entry of routeTable || []) {
    if (!SERVED.has(entry.kind)) continue;
    for (const p of routeToPatterns(entry.uri)) include.add(p);
  }
  let includeList = [...include].sort();
  const excludeList = publicDirs
    .map((d) => '/' + String(d).replace(/^\/+|\/+$/g, '') + '/*')
    .sort();
  // Cloudflare reads ONE cap for the two lists together: checking them apart let
  // a 120-rule file through, and Cloudflare then ignored the file in silence.
  // Over the cap, merge sibling patterns under a common first segment into one
  // `/segment/*` rule (the Worker's router still answers each exact path) rather
  // than failing the build — a fleet of package ports on one app legitimately
  // needs more paths than Cloudflare's flat 100-rule `_routes.json` allows.
  const cap = MAX_RULES - excludeList.length;
  if (includeList.length > cap) {
    const merged = collapseIncludesToCap(includeList, cap);
    if (merged.length !== includeList.length) {
      console.log(
        `  _routes.json: ${includeList.length} include patterns exceed Cloudflare's ` +
          `${MAX_RULES}-rule combined cap -> merged sibling prefixes down to ${merged.length} ` +
          `(Worker still answers each exact path)`
      );
    }
    includeList = merged;
  }
  const combined = includeList.length + excludeList.length;
  if (combined > MAX_RULES) {
    throw new Error(
      '_routes.json has ' + combined + ' rules combined (Cloudflare allows at most ' + MAX_RULES +
        ' include+exclude together: ' + includeList.length + ' include + ' + excludeList.length +
        ' exclude) — a `/*` rule already covers a subtree, so merge patterns or move routes off the Worker'
    );
  }
  for (const rule of [...includeList, ...excludeList]) {
    if (rule.length > MAX_RULE_LENGTH) {
      throw new Error(
        '_routes.json rule "' + rule + '" is ' + rule.length + ' characters long (Cloudflare allows at most ' +
          MAX_RULE_LENGTH + ') — shorten the route'
      );
    }
  }
  const out = { version: 1 };
  if (includeList.length) out.include = includeList;
  if (excludeList.length) out.exclude = excludeList;
  return out;
}

export default { routeToPatterns, buildRoutesJson };
