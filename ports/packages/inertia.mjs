// Port of inertiajs/inertia-laravel (server adapter) — the Inertia.js PAGE
// response, both shapes Laravel emits:
//
//   • XHR  (request carries `X-Inertia: true`)  → JSON page-object:
//       { component, props, url, version, clearHistory, preserveScroll,
//         deferredProps, mergeProps }
//   • non-XHR                                  → full HTML shell: the
//       root element the compiled Blade template is served with, carrying the
//       page-object inline so the client hydrates from it on first paint.
//
// Version check: the client sends its asset version in `X-Inertia-Version`.
// When it disagrees with the server's (`APP_VERSION`, falling back to a
// content hash) this is a STALE PAGE and Inertia answers `409 Conflict` with an
// `X-Inertia-Location` header pointing at the current URL — the client does a
// hard reload. Only checked for XHR requests (a non-XHR always gets fresh HTML).
//
// Redirect after a partial request: Laravel Inertia upgrades the redirect that
// follows a PUT / PATCH / DELETE to `303 See Other` (the browser then replays it
// as a GET, so the new page lands cleanly). This module exports `redirect()` for
// that shape; a controller port that decides "this request should now go to X"
// returns `redirect(ctx, '/target')` instead of a page.
//
// Route seam: registry.json → "ports": { "<path>": "inertia" } — the default
// export is the page handler; the named export `redirect` is the 303 helper a
// controller port can re-export.
//
// Substitution (disclosed): Laravel resolves `component` from the page Blade
// and props from the controller; the compiled rung has no PHP view engine, so
// the caller supplies the page object and this module is responsible for the
// WIRE PROTOCOL only — headers, version, 409, 303, and the two response shapes.
// The HTML shell inlines the page data as JSON in a `data-page` attribute (the
// attribute the Inertia client runtime reads); the compiled Blade root template
// can carry the same attribute — this module is the fallback so a page renders
// even when the Blade template is not the one compiled in.

import { normalizePortCtx, jsonResponse as jsonEnvelope } from '../../kernel/packages/port-ctx.mjs';
// The `data-page` attribute is escaped with Laravel's `e()` — the Blade
// template Laravel's Inertia adapter serves is `data-page="{{ json_encode(...) }}"`.
import { escapeHtml } from '../../kernel/str.mjs';

const INERTIA_HEADER = 'x-inertia';
const VERSION_HEADER = 'x-inertia-version';
const LOCATION_HEADER = 'x-inertia-location';

/** The request methods that follow a redirect with 303 (not 302). */
const REDIRECT_303_METHODS = new Set(['PUT', 'PATCH', 'DELETE']);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The server's asset version — `APP_VERSION`, else a stable default. */
function assetVersion(env) {
  const v = env && (env.APP_VERSION || env.INERTIA_VERSION);
  return v != null && String(v).length ? String(v) : '';
}

/** Truthy when the request came from the Inertia client (`X-Inertia: true`). */
function isInertiaRequest(headerOf) {
  const v = headerOf(INERTIA_HEADER);
  return v === 'true' || v === '1' || v === 'True' || v === 'TRUE';
}

/** Version mismatch → the client's copy of the assets is stale. */
function versionIsStale(headerOf, env) {
  const serverVersion = assetVersion(env);
  if (!serverVersion) return false; // no version configured → never stale
  const clientVersion = headerOf(VERSION_HEADER);
  return clientVersion != null && String(clientVersion) !== serverVersion;
}

// port-ctx owns the envelope; an Inertia response differs only by the
// `X-Inertia: true` header it always carries (and it sends no cache-control).
const jsonResponse = (status, payload, headers = {}) =>
  jsonEnvelope(status, payload, { noStore: false, headers: { [INERTIA_HEADER]: 'true', ...headers } });

function htmlResponse(status, html, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body: html,
  };
}

/** Minimal HTML shell carrying the page object for client hydration. */
function renderShell(page) {
  const pageJson = JSON.stringify(page).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const title = typeof page.component === 'string' && page.component
    ? page.component.replace(/[<>&]/g, '')
    : 'App';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <script>window.__inertia_page__ = ${pageJson};</script>
</head>
<body>
  <div id="app" data-page="${escapeHtml(pageJson)}"></div>
</body>
</html>`;
}

/**
 * Normalise whatever the caller handed us into a full Inertia page-object.
 * Accepts a bare page object, or the port context (`ctx.body` / `ctx.params`)
 * the default handler assembles. Defaults every optional flag Inertia defines.
 */
function normalizePage(page, ctx) {
  const src = page && typeof page === 'object' ? page : {};
  return {
    component: String(src.component || (ctx && ctx.params && ctx.params.component) || ''),
    props: src.props && typeof src.props === 'object' ? src.props : {},
    url: String(src.url || (ctx && ctx.request && ctx.request.path) || '/'),
    // Optional flags — only present when explicitly requested (Inertia omits
    // them when false, but a stable object shape is easier for callers).
    clearHistory: Boolean(src.clearHistory),
    preserveScroll: Boolean(src.preserveScroll),
    ...(src.deferredProps && typeof src.deferredProps === 'object'
      ? { deferredProps: src.deferredProps }
      : {}),
    ...(src.mergeProps && typeof src.mergeProps === 'object'
      ? { mergeProps: src.mergeProps }
      : {}),
    ...(src.errorBag && typeof src.errorBag === 'string' ? { errorBag: src.errorBag } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The Inertia page response. `page` is the page object (or a port ctx carrying
 * `body`/`params` that describes one); `env` supplies `APP_VERSION`.
 *
 *   X-Inertia: true  → JSON page-object (or 409 + X-Inertia-Location if stale)
 *   otherwise        → HTML shell carrying the same page object inline
 */
export async function handle(ctx, env = {}) {
  ctx = normalizePortCtx(ctx);
  const headerOf = ctx.request.header;
  const isInertia = isInertiaRequest(headerOf);
  const version = assetVersion(env);

  let page;
  try {
    page = normalizePage(ctx.body || ctx.params, ctx);
  } catch (err) {
    return jsonResponse(500, { error: String((err && err.message) || err) });
  }

  // Stale assets: the client is showing a page built from an older deploy.
  // Only matters for XHR — a non-XHR always receives fresh HTML.
  if (isInertia && versionIsStale(headerOf, env)) {
    return jsonResponse(409, {}, {
      [LOCATION_HEADER]: page.url,
      // Stamp the current (server) version so the client learns what it should
      // be on before it hard-reloads.
      [VERSION_HEADER]: version,
    });
  }

  if (isInertia) {
    // Inertia never sends the version back in the JSON body — the client reads
    // it from the X-Inertia-Version header the server sets on every response.
    return jsonResponse(200, page, {
      [VERSION_HEADER]: version,
    });
  }

  // Non-XHR: serve the HTML shell with the version stamped as a header too, so
  // a client that re-requests this URL via XHR can compare.
  return htmlResponse(200, renderShell({ ...page, version }), {
    [VERSION_HEADER]: version,
  });
}

/**
 * Redirect after a partial request. Laravel Inertia upgrades the status to
 * `303 See Other` for PUT / PATCH / DELETE (and any method flagged "query"),
 * so the browser replays the redirect as a GET and the new page lands cleanly.
 *
 *   redirect(ctx, '/dashboard')        → 303 (or 302 for POST/GET)
 *   redirect(ctx, '/login', { flash }) → carries a Location + optional props
 */
export function redirect(ctx, to, { props } = {}) {
  ctx = normalizePortCtx(ctx);
  const method = String(ctx.method || 'GET').toUpperCase();
  const status = REDIRECT_303_METHODS.has(method) ? 303 : 302;
  const headers = {
    location: String(to || '/'),
    [INERTIA_HEADER]: 'true',
  };
  if (props && typeof props === 'object' && Object.keys(props).length) {
    headers['x-inertia-props'] = JSON.stringify(props);
  }
  return { status, headers, body: '' };
}

// Attach helpers so the default export doubles as a namespace, the way
// sanctum.mjs exposes `handle.ensureSchema`.
handle.redirect = redirect;
handle.handle = handle;
handle.isInertiaRequest = isInertiaRequest;
handle.assetVersion = assetVersion;

export default handle;
