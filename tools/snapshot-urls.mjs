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
  return new RegExp(`(?:${origins})(?:/|(?=["'\\s<>]|$))`, 'g');
}

/**
 * @param {string} html
 * @param {string} [appUrlOrigin]
 * @returns {{ html: string, fixed: number }}
 */
export function relativizeSnapshotUrls(html, appUrlOrigin = '') {
  const re = snapshotOriginRe(appUrlOrigin);
  const fixed = (html.match(re) || []).length;
  return { html: html.replace(re, '/'), fixed };
}
