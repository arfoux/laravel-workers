// Port of mcamara/laravel-localization — the URL-locale detection + redirect
// middleware (upstream: `LaravelLocalization::setLocale()` plus the
// `LaravelLocalizationRedirectFilter` middleware).
//
// What it does (pure HTTP, no D1, no I/O):
//   - Read the request path's FIRST segment and check it against the configured
//     `LOCALES` list (env, comma-separated). A matching prefix is the locale.
//   - Non-default locale prefix (`/es/foo`) -> resolve `ctx.locale = 'es'` and
//     pass through (`null`) so the router continues to the real controller.
//   - Default-locale prefix (`/en/foo`) while `hideDefaultLocaleInURL` is on ->
//     302-redirect to the de-prefixed path (`/foo`), preserving the query.
//   - No locale prefix (`/foo`) -> resolve the default locale, pass through.
//
// In Laravel the middleware stashes the locale on the app; here the resolved
// locale is written back onto the incoming `ctx` as `ctx.locale`, which is how a
// port signals context to the wrapping route without owning a response. When the
// handler returns `null` the router dispatches onward; the only response this
// port ever produces is the default-locale redirect (302).
//
// Env:
//   LOCALES                    — comma-separated supported locales (default 'en')
//   DEFAULT_LOCALE             — the fallback locale (default: first of LOCALES)
//   HIDE_DEFAULT_LOCALE_IN_URL — 'true'/'1'/true: drop the default-locale prefix
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

/** Parse the `LOCALES` env into a lowercase list, trimming entries. */
function parseLocales(env) {
  const raw = env && typeof env.LOCALES === 'string' ? env.LOCALES : '';
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : ['en'];
}

/** Parse `HIDE_DEFAULT_LOCALE_IN_URL` from the boolean-ish shapes env allows. */
function parseHideDefault(env) {
  const v = env && env.HIDE_DEFAULT_LOCALE_IN_URL;
  if (v === true) return true;
  if (v === false || v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

export default async function handle(ctx, env) {
  const locales = parseLocales(env);
  const rawDefault =
    env && typeof env.DEFAULT_LOCALE === 'string' && env.DEFAULT_LOCALE.trim()
      ? env.DEFAULT_LOCALE.trim().toLowerCase()
      : '';
  const defaultLocale = locales.includes(rawDefault) ? rawDefault : locales[0];
  const hideDefault = parseHideDefault(env);

  // Normalise so the same code reads both the real kernel Request (accessors are
  // methods) and the plain object a unit test hand-builds. Keep a reference to
  // the ORIGINAL ctx — that is the object the caller/router inspects for
  // `ctx.locale` after we return `null`.
  const norm = normalizePortCtx(ctx || {});
  const path = String(norm.request.path || '/');
  // `queryString` is only reachable via `request.getQueryString()` on the
  // normalised ctx (not lifted to the top level), so read it from there.
  const qsRaw = String(norm.request.getQueryString() || '');
  const qs = qsRaw ? `?${qsRaw}` : '';

  // First path segment is a candidate locale prefix: "/es/foo" -> "es".
  const m = /^\/([^/?#]+)/.exec(path);
  const seg = m ? decodeURIComponent(m[1]).toLowerCase() : '';

  if (seg && locales.includes(seg)) {
    if (ctx) ctx.locale = seg;

    // Default locale is hidden from URLs: "/en/foo" must not be a canonical page.
    if (hideDefault && seg === defaultLocale) {
      const rest = path.slice(m[0].length) || '/';
      return {
        status: 302,
        headers: {
          location: rest + qs,
          'content-type': 'text/plain; charset=utf-8',
        },
        body: '',
      };
    }

    // Non-default (or default with URLs kept): continue with the locale set.
    return null;
  }

  // No locale prefix: fall back to the default locale and pass through.
  if (ctx) ctx.locale = defaultLocale;
  return null;
}
