// tools/route-gaps.mjs — the reason a route could not be handled, and the fix
// that reason maps to.
//
// Both halves used to live inline in build.mjs: `snapshotSkip()` and the
// snapshot loop BUILT the reason string (`'dynamic segment — needs a port'`,
// `` `no GET (${methods})` ``, `` `HTTP ${status}${to}${why}` `` …) and
// `needsPortFix()` matched it back with `reason.startsWith(...)`. Nothing pinned
// the pairing, so editing a message in one half silently dropped the other to
// the generic "write a port" fallback — the readiness line would lose its real
// fix with no test to catch it.
//
// The producers and the matcher now share these constructors, and
// tools/tests/route-gaps.test.mjs pins the pairing: every reason a producer can
// emit maps to a SPECIFIC fix, and only an unknown reason takes the fallback.
export const SKIP_REASONS = {
  /** `autoSnapshot: false` in registry.json — nothing is snapshotted on purpose. */
  autoSnapshotOff: () => 'unhandled (autoSnapshot: false)',
  /** The route answers no GET, so there is no page to snapshot. */
  noGet: (methods) => `no GET (${methods || '?'})`,
  /** A `{param}` uri — the worker router can match it, a snapshot cannot. */
  dynamic: () => 'dynamic segment — needs a port',
  /** A controller of the APP: compiled, not snapshotted (framework ones snapshot). */
  controller: () => 'a controller serves it — compiled, not snapshotted',
};

export const RUNTIME_REASONS = {
  /** A 2xx body that is not an HTML page — nothing to write as static HTML. */
  nonHtml: (status, contentType) => `HTTP ${status} non-HTML (${contentType || '?'})`,
  /** Any other status: a redirect (` -> /to`), a 4xx/5xx, or an error detail. */
  http: (status, to = '', why = '') => `HTTP ${status}${to}${why}`,
};

/**
 * WHAT TO DO for a route with no handler. The reason already says WHY; the four
 * shapes are genuinely different (a dynamic segment is a five-minute port; a
 * route that answers 500 at build time is a bug the build just found for free).
 *
 * `isRuntimeBindingError(reason)` is passed in (tools/readiness.mjs) rather than
 * imported, so this module stays dependency-free and the caller owns the DB-gap
 * classifier.
 */
export function needsPortFix(n, isRuntimeBindingError = () => false) {
  const reason = String(n.reason || '');
  const ignore = `{"ignore": {"${n.route}": "<why>"}}`;
  if (reason.startsWith('dynamic segment')) return `write a port — the worker router matches dynamic segments and hands them to the handler as ctx.params (build --scaffold creates the file), or ${ignore}`;
  if (reason.startsWith('no GET')) return `the route has no GET to snapshot — write a port for the verb(s) it does answer, or ${ignore}`;
  if (reason.startsWith('unhandled (autoSnapshot: false)')) return `registry.json sets "autoSnapshot": false, so nothing is snapshotted — write a port, or set autoSnapshot back to true`;
  if (reason.startsWith('a controller serves it')) return 'the controller did not compile — the reason is on its `controller ... skipped` line above; fix that, or write a port';
  if (reason.startsWith('HTTP 5')) {
    // #310: a 5xx whose cause is a build-ENVIRONMENT database gap (the app's
    // default connection is not the sqlite the build can sandbox, so the
    // prerender hits an unreachable DB). Telling the operator to "fix the
    // route" sends them hunting an app bug that does not exist; name the real
    // cause instead.
    if (isRuntimeBindingError(reason)) {
      return `the route needs a reachable database the build does not have (${reason}) — a build-ENVIRONMENT gap, not an app bug: give the build a local sqlite fallback (config/database.php) or make DB_CONNECTION/DB_DATABASE point at a database with data, then rebuild; at the edge the route gets a live D1 connection`;
    }
    const dbHint = /no such table/i.test(reason)
      ? ' — the database is missing tables: run `php artisan migrate` first (a fresh clone starts with an empty database)'
      : '';
    return `the route throws when the app boots at build time (${reason}) — this is a bug the build found for free; fix the route, then rebuild${dbHint}`;
  }
  if (reason.startsWith('HTTP 3')) return `the route redirects (${reason}) — a redirect needs a handler: write a port that returns it, or ${ignore}`;
  if (reason.startsWith('HTTP 4')) return `the route answers ${reason} for a bare GET — it probably needs a parameter or auth; write a port, or ${ignore}`;
  if (reason.startsWith('HTTP')) return `the response is not an HTML page (${reason}) — write a port that returns it (a JSON or file body), or ${ignore}`;
  return `write a port (build --scaffold), or ${ignore}`;
}
