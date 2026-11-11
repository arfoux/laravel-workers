// tools/tests/packages-cookie-consent.test.mjs — Cluster C cookie-consent port
// (spatie/laravel-cookie-consent).
//
// Three primitives + the middleware handle:
//   - isCookieSet(request)   — true when the `laravel_cookie_consent` cookie is
//                              present (banner can be skipped),
//   - injectBanner(html,…)   — splice the banner before `</body>`,
//   - buildSetCookie(s)      — the Set-Cookie header value that persists consent,
//   - handle(ctx, env)       — null when the cookie is set, otherwise the HTML
//                              with the banner plus the Set-Cookie header.
// No network, no D1 — pure string/header work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handle, {
  isCookieSet,
  injectBanner,
  buildSetCookie,
  COOKIE_LIFETIME_SECONDS,
} from '../../kernel/packages/cookie-consent.mjs';

// ---- isCookieSet -----------------------------------------------------------

test('isCookieSet: false on a blank/missing Cookie header', () => {
  assert.equal(isCookieSet({}), false);
  assert.equal(isCookieSet({ headers: {} }), false);
  assert.equal(isCookieSet({ headers: { cookie: '' } }), false);
});

test('isCookieSet: true when laravel_cookie_consent is present', () => {
  const req = {
    header: (name) => (name.toLowerCase() === 'cookie' ? 'theme=dark; laravel_cookie_consent=1' : null),
  };
  assert.equal(isCookieSet(req), true);
});

test('isCookieSet: header() method shape is preferred over the headers map', () => {
  // The compiled kernel Request exposes `header(name)`; make sure the method is
  // consulted even when a stale headers map disagrees.
  const req = {
    header: (name) => (name.toLowerCase() === 'cookie' ? 'laravel_cookie_consent=0' : null),
    headers: { cookie: 'session=abc' },
  };
  assert.equal(isCookieSet(req), true);
});

test('isCookieSet: matches the exact name, not a longer sibling', () => {
  const req = { headers: { cookie: 'x_laravel_cookie_consent_adm=1; other=2' } };
  assert.equal(isCookieSet(req), false);
});

test('isCookieSet: a Request-like headers.get() map is accepted', () => {
  const headers = { get: (n) => (String(n).toLowerCase() === 'cookie' ? 'laravel_cookie_consent=1' : null) };
  assert.equal(isCookieSet({ headers }), true);
});

// ---- injectBanner ----------------------------------------------------------

test('injectBanner: splices the banner right before the closing body tag', () => {
  const html = '<html><body><main>Hello</main></body></html>';
  const out = injectBanner(html, { title: 'Cookies?', body: 'We use them.' });
  const bodyIdx = out.indexOf('<body>');
  const endIdx = out.lastIndexOf('</body>');
  assert.ok(bodyIdx !== -1 && endIdx !== -1, 'keeps the original html');
  assert.ok(out.slice(bodyIdx, endIdx).includes('cookie-consent'), 'banner sits inside <body>');
  assert.ok(out.indexOf('</body>') > out.indexOf('cookie-consent'), 'banner is before </body>');
  assert.ok(out.includes('Cookies?'), 'title echoed');
  assert.ok(out.includes('We use them.'), 'body echoed');
  assert.ok(out.indexOf('</body>') === endIdx, 'no trailing copies after the close tag');
});

test('injectBanner: escapes title/body so text cannot break the markup', () => {
  const out = injectBanner('<html><body>Hi</body></html>', { title: '<script>x</script>', body: '"&<>' });
  assert.ok(!out.includes('<script>x</script>'), 'raw title not echoed');
  assert.ok(out.includes('&lt;script&gt;'), 'title escaped');
  assert.ok(out.includes('&quot;&amp;&lt;&gt;'), 'body escaped');
});

test('injectBanner: returns the html unchanged when there is no </body>', () => {
  const html = '<html><head>almost done</head>';
  const out = injectBanner(html, { title: 't', body: 'b' });
  assert.equal(out, html);
});

test('injectBanner: case-insensitive closing body tag is honoured', () => {
  const out = injectBanner('<HTML><BODY>page</BODY></HTML>', { title: 't', body: 'b' });
  assert.ok(out.includes('cookie-consent'), 'banner injected with uppercase BODY tag');
  assert.ok(out.endsWith('</BODY></HTML>'), 'original casing preserved at the tag');
});

// ---- buildSetCookie --------------------------------------------------------

test('buildSetCookie: builds a far-future Set-Cookie value for the consent name', () => {
  const header = buildSetCookie(100);
  assert.match(header, /^laravel_cookie_consent=1;/);
  assert.match(header, /Max-Age=100/);
  assert.match(header, /Expires=/);
  assert.match(header, /Path=\//);
  assert.match(header, /SameSite=Lax/);
  // Expires lands ~100s in the future from build time.
  const exp = header.match(/Expires=([^;]+)/i)[1];
  const cutoff = Date.now() + 99 * 1000;
  assert.ok(Date.parse(exp) > cutoff, 'expires is ~100s out');
});

test('buildSetCookie: defaults to a one-year lifetime', () => {
  const header = buildSetCookie();
  assert.ok(header.includes(`Max-Age=${COOKIE_LIFETIME_SECONDS}`), 'uses the package default lifetime');
});

test('buildSetCookie: non-positive or invalid lifetimes return null', () => {
  assert.equal(buildSetCookie(0), null);
  assert.equal(buildSetCookie(-5), null);
  assert.equal(buildSetCookie('nope'), null);
  assert.equal(buildSetCookie(NaN), null);
});

// ---- middleware handle -----------------------------------------------------

const okCtx = (cookie, html = '<html><body>main</body></html>') => ({ request: { header: () => cookie }, body: html });

test('handle: cookie already set → returns null (banner skipped, no Set-Cookie)', async () => {
  const res = await handle(okCtx('laravel_cookie_consent=1'));
  assert.equal(res, null);
});

test('handle: no consent cookie → banner + Set-Cookie with the html passed through', async () => {
  const html = '<html><body><main>Shop</main></body></html>';
  const res = await handle(okCtx(null, html), { COOKIE_CONSENT_TITLE: 'Our cookies', COOKIE_CONSENT_BODY: 'We respect you.' });

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.headers['set-cookie'], /^laravel_cookie_consent=1;/);
  assert.ok(res.body.includes('<main>Shop</main>'), 'original html preserved');
  assert.ok(res.body.includes('Our cookies'), 'env title used');
  assert.ok(res.body.includes('We respect you.'), 'env body used');
  assert.ok(res.body.indexOf('cookie-consent') < res.body.indexOf('</body>'), 'banner before </body>');
});

test('handle: env lifetime is honoured in the Set-Cookie', async () => {
  const res = await handle(okCtx(null), { COOKIE_CONSENT_LIFETIME: '3600' });
  assert.match(res.headers['set-cookie'], /Max-Age=3600/);
});

test('handle: non-HTML body (no </body>) still sets the consent cookie', async () => {
  const res = await handle(okCtx(null, '{ "partial": true }'));
  assert.equal(res.body, '{ "partial": true }', 'body passed through untouched');
  assert.match(res.headers['set-cookie'], /^laravel_cookie_consent=1;/);
});
