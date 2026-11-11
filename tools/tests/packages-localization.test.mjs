// tools/tests/packages-localization.test.mjs — the mcamara/laravel-localization
// port (URL-locale prefix detection + default-locale redirect).
//
// What we exercise:
//   - a non-default locale prefix (/es/foo) resolves `ctx.locale` and passes
//     through (`null`), so the router continues to the controller,
//   - the default-locale prefix is 302-redirected to the de-prefixed path when
//     HIDE_DEFAULT_LOCALE_IN_URL is on (query preserved),
//   - a path with no locale prefix resolves to the default locale and passes.
// Pure HTTP middleware — no D1, no fetch, so no fake binding/fetch needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../ports/packages/localization.mjs';

// Build a router-like ctx matching the port contract: a kernel-style Request
// whose accessors are METHODS (`pathInfo()`, `getQueryString()`, ...), exactly
// what the kernel router hands a port and what `normalizePortCtx` maps.
function makeCtx({ method = 'GET', path = '/', query = '' } = {}) {
  return {
    method,
    params: {},
    query: {},
    request: {
      method: () => method,
      path: () => path,
      pathInfo: () => path.split('?')[0],
      getQueryString: () => (path.includes('?') ? path.slice(path.indexOf('?') + 1) : query),
      host: () => 'app.test',
      headers: { get: () => null },
      header: () => null,
      query: () => undefined,
      json: () => ({}),
      text: () => '',
    },
  };
}

// ---- locale-prefix detection ----------------------------------------------

test('localization: non-default prefix (/es/foo) sets ctx.locale and passes through', async () => {
  const ctx = makeCtx({ path: '/es/foo' });
  const env = { LOCALES: 'en,es,fr', DEFAULT_LOCALE: 'en' };

  const res = await handler(ctx, env);

  assert.equal(res, null); // pass-through: router continues to the controller
  assert.equal(ctx.locale, 'es');
});

test('localization: uppercase prefix (/ES/foo) is normalised to the locale', async () => {
  const ctx = makeCtx({ path: '/ES/foo' });
  const res = await handler(ctx, envOf('en,es', 'en'));
  assert.equal(res, null);
  assert.equal(ctx.locale, 'es');
});

test('localization: prefix that is not a configured locale is not treated as one', async () => {
  const ctx = makeCtx({ path: '/de/foo' });
  const env = { LOCALES: 'en,es', DEFAULT_LOCALE: 'en' };

  const res = await handler(ctx, env);

  assert.equal(res, null);
  assert.equal(ctx.locale, 'en'); // falls back to default
});

// ---- default locale + hideDefaultLocaleInURL ------------------------------

test('localization: default prefix with hideDefault (/en/foo) redirects to /foo', async () => {
  const ctx = makeCtx({ path: '/en/foo' });
  const env = { LOCALES: 'en,es', DEFAULT_LOCALE: 'en', HIDE_DEFAULT_LOCALE_IN_URL: 'true' };

  const res = await handler(ctx, env);

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/foo');
});

test('localization: hideDefault redirect preserves the query string', async () => {
  const ctx = makeCtx({ path: '/en/foo?page=2&sort=asc' });
  const env = { LOCALES: 'en,es', DEFAULT_LOCALE: 'en', HIDE_DEFAULT_LOCALE_IN_URL: true };

  const res = await handler(ctx, env);

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/foo?page=2&sort=asc');
});

test('localization: default prefix redirects to the root when it is the whole path', async () => {
  const ctx = makeCtx({ path: '/en' });
  const env = { LOCALES: 'en,es', DEFAULT_LOCALE: 'en', HIDE_DEFAULT_LOCALE_IN_URL: '1' };

  const res = await handler(ctx, env);

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
});

test('localization: default prefix is NOT redirected when hideDefault is off', async () => {
  const ctx = makeCtx({ path: '/en/foo' });
  const env = { LOCALES: 'en,es', DEFAULT_LOCALE: 'en', HIDE_DEFAULT_LOCALE_IN_URL: 'false' };

  const res = await handler(ctx, env);

  assert.equal(res, null);
  assert.equal(ctx.locale, 'en');
});

test('localization: non-default prefix is not redirected even with hideDefault on', async () => {
  const ctx = makeCtx({ path: '/es/foo' });
  const env = { LOCALES: 'en,es', DEFAULT_LOCALE: 'en', HIDE_DEFAULT_LOCALE_IN_URL: 'true' };

  const res = await handler(ctx, env);

  assert.equal(res, null);
  assert.equal(ctx.locale, 'es');
});

// ---- no prefix ------------------------------------------------------------

test('localization: no prefix (/foo) resolves the default locale and passes through', async () => {
  const ctx = makeCtx({ path: '/foo' });
  const env = { LOCALES: 'en,es,fr', DEFAULT_LOCALE: 'en' };

  const res = await handler(ctx, env);

  assert.equal(res, null);
  assert.equal(ctx.locale, 'en');
});

test('localization: a custom DEFAULT_LOCALE wins (installLocaleFallback)', async () => {
  const ctx = makeCtx({ path: '/foo' });
  const env = { LOCALES: 'en,es,fr', DEFAULT_LOCALE: 'es' };

  const res = await handler(ctx, env);

  assert.equal(res, null);
  assert.equal(ctx.locale, 'es');
});

test('localization: the root path falls back to the default locale', async () => {
  const ctx = makeCtx({ path: '/' });
  const env = { LOCALES: 'en,es', DEFAULT_LOCALE: 'en' };

  const res = await handler(ctx, env);

  assert.equal(res, null);
  assert.equal(ctx.locale, 'en');
});

// ---- env defaults ---------------------------------------------------------

test('localization: no env at all defaults to LOCALES ["en"] and DEFAULT_LOCALE en', async () => {
  const ctx = makeCtx({ path: '/foo' });
  const res = await handler(ctx, {});
  assert.equal(res, null);
  assert.equal(ctx.locale, 'en');
});

test('localization: LOCALES splits on commas and trims whitespace', async () => {
  const ctx = makeCtx({ path: '/es/foo' });
  const env = { LOCALES: ' en , es, fr ', DEFAULT_LOCALE: 'en' };
  const res = await handler(ctx, env);
  assert.equal(res, null);
  assert.equal(ctx.locale, 'es');
});

function envOf(locales, def) {
  return { LOCALES: locales, DEFAULT_LOCALE: def };
}
