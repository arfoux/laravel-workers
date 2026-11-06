// Snapshot URL rewriting.
//
// `tools/prerender.php` boots the app for a request whose host is `localhost`,
// so every absolute URL Laravel generates (`route()`) carries a dev origin:
//
//   http://localhost          <- route('home') for the root route: NO trailing slash
//   http://localhost/masuk    <- any non-root route
//
// A snapshot is served from the edge, so those origins must be turned relative
// or the page ships dead links. The trailing slash used to be mandatory in the
// pattern, which meant the root URL survived verbatim: `href="http://localhost"`
// on the deployed page. The boundary alternative below catches a bare origin.
//
// External origins (fonts, APIs) are never touched — only localhost, the
// loopback variants, and the app's own APP_URL origin.

const DEV_ORIGIN = '(?:https?:)?//(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::\\d+)?';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} [appUrlOrigin] e.g. `https://nearfind.example.workers.dev`
 * @returns {RegExp}
 */
export function snapshotOriginRe(appUrlOrigin = '') {
  const origins = appUrlOrigin ? `${DEV_ORIGIN}|${escapeRe(appUrlOrigin)}` : DEV_ORIGIN;
  // `/` consumes the path separator (replacement keeps exactly one slash);
  // the lookahead covers a bare origin followed by a quote/space/tag/end.
  // `i`: an origin authored in caps (`HTTP://LOCALHOST`) resolves the same way
  // in a browser, so it must not survive as a dead link either.
  return new RegExp(`(?:${origins})(?:/|(?=["'\\s<>]|$))`, 'gi');
}

/**
 * The JSON-escaped form: `json_encode()` (Laravel's `@json`/`Js::from`)
 * writes slashes as `\/`, so a URL inside a JSON blob is
 * `http:\/\/localhost\/masuk` and the plain pattern never sees it. The
 * replacement keeps the escape (`\/`) so the blob stays valid JSON.
 */
export function snapshotEscapedOriginRe(appUrlOrigin = '') {
  const origins = (appUrlOrigin ? `${DEV_ORIGIN}|${escapeRe(appUrlOrigin)}` : DEV_ORIGIN).replace(/\//g, '\\\\/');
  return new RegExp(`(?:${origins})(?:\\\\/|(?=["'\\s<>]|$))`, 'gi');
}

/**
 * @param {string} html
 * @param {string} [appUrlOrigin]
 * @returns {{ html: string, fixed: number }}
 */
export function relativizeSnapshotUrls(html, appUrlOrigin = '') {
  const re = snapshotOriginRe(appUrlOrigin);
  const fixed = (html.match(re) || []).length;
  let out = html.replace(re, '/');
  const escaped = snapshotEscapedOriginRe(appUrlOrigin);
  const escapedFixed = (out.match(escaped) || []).length;
  out = out.replace(escaped, '\\/');
  return { html: out, fixed: fixed + escapedFixed };
}

/**
 * A compiled view's captured runtime context, serialized for
 * `dist/src/contexts/`. compile-view.php boots the app with host `localhost`,
 * so `@vite()` and the precomputed `url()` entries carry that origin. Unlike a
 * prerendered snapshot, these views run in the worker per request — an
 * absolute `http://localhost/build/...` would point at the visitor's machine.
 *
 * @param {object} context
 * @param {string} [appUrlOrigin]
 * @returns {string} JSON with the dev/app origins turned root-relative
 */
export function relativizeContextJson(context, appUrlOrigin = '') {
  return relativizeSnapshotUrls(JSON.stringify(context), appUrlOrigin).html;
}
