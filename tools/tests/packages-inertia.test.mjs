// tools/tests/packages-inertia.test.mjs — the Inertia.js server-adapter port.
//
// Exercised with hand-built ctx objects (the same shape the router hands a
// port): `X-Inertia` / `X-Inertia-Version` come in as request headers, the page
// object (component/props/url) comes in as `ctx.body`. We assert:
//   - an X-Inertia request answers with the JSON page-object + version header,
//   - a version mismatch (client older than APP_VERSION) answers 409 with
//     `X-Inertia-Location` = the current URL,
//   - a redirect after PUT/PATCH/DELETE is `303 See Other` (POST stays 302),
//   - a non-XHR request answers with the HTML shell carrying the page inline.
// No network, no D1 — this is pure response-shape logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import inertia, { redirect } from '../../ports/packages/inertia.mjs';

// Build a ctx whose kernel-shaped Request answers `header(name)`.
function makeCtx({ method = 'GET', path = '/dashboard', headers = {}, body = {}, params = {} } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    params,
    body,
    request: {
      method: () => method,
      pathInfo: () => path,
      getQueryString: () => '',
      host: () => 'app.test',
      header: (name) => headerMap.get(String(name).toLowerCase()) ?? null,
      headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
    },
  };
}

const inertiaHeaders = (version) => ({
  'x-inertia': 'true',
  ...(version !== undefined ? { 'x-inertia-version': version } : {}),
});

const pageBody = {
  component: 'Dashboard',
  props: { user: { id: 1, name: 'Ada' } },
  url: '/dashboard',
};

const jsonHeaders = (res) => Object.fromEntries(
  Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v])
);

// ---- X-Inertia request → JSON page-object ---------------------------------

test('inertia: X-Inertia request returns the JSON page object', async () => {
  const res = await inertia(
    makeCtx({ method: 'GET', headers: inertiaHeaders('v1'), body: pageBody }),
    { APP_VERSION: 'v1' },
  );

  assert.equal(res.status, 200);
  const h = jsonHeaders(res);
  assert.equal(h['content-type'], 'application/json');
  assert.equal(h['x-inertia'], 'true');
  assert.equal(h['x-inertia-version'], 'v1');

  const page = JSON.parse(res.body);
  assert.equal(page.component, 'Dashboard');
  assert.deepEqual(page.props, { user: { id: 1, name: 'Ada' } });
  assert.equal(page.url, '/dashboard');
});

test('inertia: JSON page object carries optional flags through', async () => {
  const res = await inertia(
    makeCtx({
      method: 'GET',
      headers: inertiaHeaders('v1'),
      body: {
        ...pageBody,
        clearHistory: true,
        preserveScroll: true,
        deferredProps: { default: ['orders'] },
        mergeProps: { items: 'append' },
      },
    }),
    { APP_VERSION: 'v1' },
  );

  assert.equal(res.status, 200);
  const page = JSON.parse(res.body);
  assert.equal(page.clearHistory, true);
  assert.equal(page.preserveScroll, true);
  assert.deepEqual(page.deferredProps, { default: ['orders'] });
  assert.deepEqual(page.mergeProps, { items: 'append' });
});

// ---- Version mismatch → 409 + X-Inertia-Location --------------------------

test('inertia: version mismatch answers 409 with X-Inertia-Location', async () => {
  const res = await inertia(
    makeCtx({ method: 'GET', path: '/dashboard', headers: inertiaHeaders('v-old'), body: pageBody }),
    { APP_VERSION: 'v-new' },
  );

  assert.equal(res.status, 409);
  const h = jsonHeaders(res);
  assert.equal(h['x-inertia-location'], '/dashboard');
  assert.equal(h['x-inertia-version'], 'v-new');
  // The 409 body is an empty page-object, not the requested content.
  assert.deepEqual(JSON.parse(res.body), {});
});

test('inertia: matching version is NOT stale (no 409)', async () => {
  const res = await inertia(
    makeCtx({ method: 'GET', headers: inertiaHeaders('v1'), body: pageBody }),
    { APP_VERSION: 'v1' },
  );
  assert.equal(res.status, 200);
});

test('inertia: version mismatch is ignored when APP_VERSION is unset', async () => {
  // No configured version → the server cannot call the client stale.
  const res = await inertia(
    makeCtx({ method: 'GET', headers: inertiaHeaders('anything'), body: pageBody }),
    {},
  );
  assert.equal(res.status, 200);
});

// ---- Redirect after partial request → 303 ---------------------------------

test('redirect: PUT after a partial request is 303 See Other', () => {
  const res = redirect(makeCtx({ method: 'PUT' }), '/dashboard');
  assert.equal(res.status, 303);
  assert.equal(jsonHeaders(res).location, '/dashboard');
  assert.equal(jsonHeaders(res)['x-inertia'], 'true');
});

test('redirect: PATCH and DELETE are 303 too', () => {
  assert.equal(redirect(makeCtx({ method: 'PATCH' }), '/x').status, 303);
  assert.equal(redirect(makeCtx({ method: 'DELETE' }), '/x').status, 303);
});

test('redirect: POST stays 302 Found', () => {
  const res = redirect(makeCtx({ method: 'POST' }), '/login');
  assert.equal(res.status, 302);
  assert.equal(jsonHeaders(res).location, '/login');
});

test('redirect: attaches via the default export namespace', () => {
  assert.equal(typeof inertia.redirect, 'function');
  assert.equal(inertia.redirect(makeCtx({ method: 'DELETE' }), '/bye').status, 303);
});

// ---- Non-XHR request → HTML shell -----------------------------------------

test('inertia: non-XHR request returns the HTML shell', async () => {
  const res = await inertia(
    makeCtx({ method: 'GET', headers: {}, body: pageBody }),
    { APP_VERSION: 'v1' },
  );

  assert.equal(res.status, 200);
  const h = jsonHeaders(res);
  assert.equal(h['content-type'], 'text/html; charset=utf-8');
  assert.equal(h['x-inertia-version'], 'v1');

  assert.match(res.body, /<!DOCTYPE html>/i);
  assert.match(res.body, /id="app"/);
  // The page object is inlined for client hydration (data-page attribute).
  assert.match(res.body, /data-page="/);
  assert.match(res.body, /Dashboard/);
  assert.match(res.body, /Ada/);
});

test('inertia: HTML shell escapes HTML-sensitive characters in the page data', async () => {
  const res = await inertia(
    makeCtx({
      method: 'GET',
      headers: {},
      body: { component: 'X', props: { html: '<script>alert("x")</script>' }, url: '/x' },
    }),
    { APP_VERSION: 'v1' },
  );

  assert.equal(res.status, 200);
  // The inlined JSON must not contain a raw `<script>` that could break out.
  assert.ok(!/<script>alert/.test(res.body), 'raw <script> must be escaped');
  assert.match(res.body, /\\u003c/);
});

test('inertia: version mismatch on a non-XHR request is ignored (always fresh HTML)', async () => {
  const res = await inertia(
    makeCtx({ method: 'GET', headers: { 'x-inertia-version': 'v-old' }, body: pageBody }),
    { APP_VERSION: 'v-new' },
  );
  // Non-XHR never gets the 409 — it just renders the shell.
  assert.equal(res.status, 200);
  assert.match(res.body, /<!DOCTYPE html>/i);
});
