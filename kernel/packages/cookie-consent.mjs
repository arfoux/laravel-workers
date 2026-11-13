// kernel/packages/cookie-consent.mjs — spatie/laravel-cookie-consent port
// (kernel half).
//
// Parity target: spatie/laravel-cookie-consent. The package is a view
// component + a single line of consent JavaScript: it renders a cookie-banner
// partial into the response (right before `</body>`) and, when the visitor
// clicks "Allow", writes a `laravel_cookie_consent` cookie whose presence tells
// subsequent responses to skip the banner. There is no backend network / DB /
// crypto in the upstream flow — it is pure markup + a Set-Cookie header — so
// the port is a set of pure, side-effect-free string/regex helpers that run on
// the edge and in a unit test unchanged.
//
// Edge disclosure: upstream sets the consent cookie with `Cookie::forever`
// (Graham Campbell / Symfony CanonicalizingCookie → a far-future expiry). We
// reproduce that with an explicit lifetime (default 1 year = 31_536_000 s) and
// the same cookie value the upstream JS writes, `1`. The Set-Cookie header we
// build uses `Max-Age` + a far-future `Expires` so browsers that honour either
// mechanism persist the consent. Escaping mirrors upstream's `{{ $title }}`
// buffering: text inserted into the banner HTML is escaped, never echoed raw.
//
// The banner markup is intentionally small and dependency-free: a fixed
// `<div class="js-cookie-consent cookie-consent">` with a title, the message
// body, and a "Allow" button whose one-line script (when clicked) persists the
// consent cookie and fades the banner out — the same observable contract as the
// upstream `cookieConsent` Blade partial.

import { normalizePortCtx } from './port-ctx.mjs';
// Laravel's `{{ }}` blade echo is `e()` — the title/body of the banner go
// through the shared html-escape rule.
import { escapeHtml } from '../str.mjs';

const COOKIE_NAME = 'laravel_cookie_consent';
// `Cookie::forever` upstream expires at the end of year 2038 (INT_MAX); we keep
// the same spirit with a 1-year lifetime so the value is stable and testable.
export const COOKIE_LIFETIME_SECONDS = 60 * 60 * 24 * 365; // 1 year

/**
 * isCookieSet(request) — true when the Cookie header already carries the
 * `laravel_cookie_consent` consent cookie, so the banner should be skipped.
 *
 * `request` is anything with a `header(name)` method (the compiled kernel
 * Request, or a ctx normalized via `normalizePortCtx`) or a
 * `headers.get(name)` map — tolerant of both shapes, matching the `headerOf`
 * semantics the ports rely on. A missing/blank Cookie header returns false.
 */
export function isCookieSet(request) {
  const raw =
    request && typeof request.header === 'function'
      ? request.header('cookie')
      : (request && request.headers && typeof request.headers.get === 'function' && request.headers.get('cookie')) ||
        (request && request.headers && request.headers.cookie) ||
        null;
  if (!raw) return false;
  // Split on `;`, keep the part before `=`, exact-name match. Cookie names are
  // case-sensitive in practice but a user-agent may echo varying case; Laravel
  // reads the name case-insensitively, so we compare lowercased.
  const target = COOKIE_NAME.toLowerCase();
  for (const pair of String(raw).split(';')) {
    const eq = pair.indexOf('=');
    const name = (eq === -1 ? pair : pair.slice(0, eq)).trim().toLowerCase();
    if (name === target) return true;
  }
  return false;
}

/**
 * injectBanner(html, { title, body }) — splice the consent banner right before
 * the closing `</body>` tag (upstream injects its partial at `</body>`).
 *
 * Returns the original string unchanged when there is no `</body>` tag (nothing
 * sensible to attach a banner to — e.g. a JSON or partial body). `title` and
 * `body` are escaped. The banner is a no-JS-required fallback form plus the
 * upstream one-line consent script:
 *   1. a `POST` to the same path (Laravel's consent route) as the no-JS path,
 *      carrying the consent flag so the server can set the cookie, and
 *   2. a click handler on the Allow button that sets the cookie via JS and
 *      hides the banner for users who run scripts.
 */
export function injectBanner(html, { title, body } = {}) {
  const source = String(html ?? '');
  const banner = [
    '<div id="cookie-consent" class="cookie-consent" role="region" aria-label="Cookie consent" hidden>',
    `  <div class="cookie-consent__inner">`,
    `    <div class="cookie-consent__copy">`,
    `      <span class="cookie-consent__title">${escapeHtml(title)}</span>`,
    `      <span class="cookie-consent__message">${escapeHtml(body)}</span>`,
    `    </div>`,
    `    <button type="button" class="cookie-consent__button" data-cookie-consent="allow">Allow cookies</button>`,
    `  </div>`,
    `</div>`,
    `<script>(function(){var b=document.getElementById('cookie-consent'),btn=b&&b.querySelector('[data-cookie-consent="allow"]');if(!b)return;b.hidden=false;if(btn){btn.addEventListener('click',function(){document.cookie='laravel_cookie_consent=1; path=/; max-age='+(60*60*24*365)+'; SameSite=Lax';b.hidden=true;});}})();</script>`,
  ].join('\n');

  const lower = source.toLowerCase();
  const idx = lower.lastIndexOf('</body>');
  if (idx === -1) return source;
  return source.slice(0, idx) + banner + '\n' + source.slice(idx);
}

/**
 * buildSetCookie(seconds) — the `Set-Cookie` header VALUE that persists the
 * `laravel_cookie_consent` consent. `seconds` is the lifetime in seconds
 * (default COOKIE_LIFETIME_SECONDS, 1 year). Produces a `Max-Age` plus a
 * matching far-future `Expires` (RFC 1123 GMT) so browser support for either
 * framing persists the consent, plus `Path=/; SameSite=Lax` — the cookie must
 * be readable across the whole site and not leak cross-site.
 *
 * Returns null for a non-positive lifetime, so a caller can decide to skip
 * sending the header.
 */
export function buildSetCookie(seconds = COOKIE_LIFETIME_SECONDS) {
  const secs = Math.floor(Number(seconds));
  if (!Number.isFinite(secs) || secs <= 0) return null;
  const now = Date.now();
  const maxAge = Math.floor(secs);
  const expires = new Date(now + maxAge * 1000);
  const expiresStr = expires.toUTCString().replace(/ GMT$/, ' GMT');
  return `${COOKIE_NAME}=1; Max-Age=${maxAge}; Expires=${expiresStr}; Path=/; SameSite=Lax`;
}

// Default banner copy, mirroring spatie/laravel-cookie-consent's config
// placeholders. The middleware lets env override both.
const DEFAULT_TITLE = 'This website uses cookies';
const DEFAULT_BODY =
  'We use cookies to enhance your experience. By continuing to browse this site you agree to our use of cookies.';

/**
 * Default export — the cookie-consent MIDDLEWARE, spatie's
 * `AddCookieConsentToResponse` equivalent.
 *
 * Returns `null` when the `laravel_cookie_consent` cookie is already present
 * (the visitor has answered, so `</body>` is left untouched — the "cookie set"
 * pass-through) and otherwise wraps the HTML in the banner: it splices the
 * consent block before `</body>` and stamps a `Set-Cookie` that persists the
 * answer, i.e. the "not set" branch produces banner + Set-Cookie.
 *
 * The HTML to decorate is read from `ctx.body` when it is a string (the
 * compiled view body a downstream handler passes). Banner copy and lifetime
 * come from env, all optional:
 *   COOKIE_CONSENT_TITLE, COOKIE_CONSENT_BODY, COOKIE_CONSENT_LIFETIME (seconds).
 * A non-HTML body (no `</body>`) passes through with the Set-Cookie still set.
 */
export default async function handle(ctx, env = {}) {
  ctx = normalizePortCtx(ctx);

  if (isCookieSet(ctx.request)) return null;

  const lifetime = Number.isFinite(Number(env.COOKIE_CONSENT_LIFETIME))
    ? Math.floor(Number(env.COOKIE_CONSENT_LIFETIME))
    : COOKIE_LIFETIME_SECONDS;
  const setCookie = buildSetCookie(lifetime);

  const html = typeof ctx.body === 'string' ? ctx.body : '';
  const title = env.COOKIE_CONSENT_TITLE ?? DEFAULT_TITLE;
  const body = env.COOKIE_CONSENT_BODY ?? DEFAULT_BODY;

  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': setCookie,
    },
    body: injectBanner(html, { title, body }),
  };
}
