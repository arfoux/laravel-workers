// tools/tests/packages-site-search.test.mjs — spatie/laravel-site-search port.
// Run: node --test tools/tests/packages-site-search.test.mjs
//
// Injects a fake `fetchImpl` (records the outgoing request, returns a canned
// response) so nothing touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import siteSearch from '../../ports/packages/site-search.mjs';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url, ...init };
    calls.push(call);
    const res = handler ? await handler(call) : null;
    return res ?? jsonResponse({});
  };
  fn.calls = calls;
  return fn;
}

const json = (r) => JSON.parse(r.body);

// ═══ happy path: forwards q to Meilisearch, returns hits/query/totalHits ═══
test('site-search: GET /site-search?q=foo → POST /indexes/{index}/search', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({
    hits: [{ id: 1, name: 'Foo widget' }, { id: 2, name: 'Foo gadget' }],
    estimatedTotalHits: 42,
  }));
  const ctx = { query: { q: 'foo' }, request: {}, fetchImpl };
  const res = await siteSearch(ctx, { MEILISEARCH_HOST: 'https://meili.example.com', MEILISEARCH_KEY: 'mk' });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  const body = json(res);
  assert.deepEqual(body.hits, [{ id: 1, name: 'Foo widget' }, { id: 2, name: 'Foo gadget' }]);
  assert.equal(body.query, 'foo');
  assert.equal(body.totalHits, 42);

  // upstream call shape: POST to the meilisearch search endpoint, bearer auth, {q, limit} body
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://meili.example.com/indexes/default/search');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, 'Bearer mk');
  const sent = JSON.parse(call.body);
  assert.equal(sent.q, 'foo');
  assert.ok(Number.isFinite(sent.limit) && sent.limit > 0);
});

// ═══ index override via query / env ═══
test('site-search: ?index= overrides the index uid in the upstream URL', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ hits: [], estimatedTotalHits: 0 }));
  await siteSearch(
    { query: { q: 'x', index: 'products' }, request: {}, fetchImpl },
    { MEILISEARCH_HOST: 'https://m.test' },
  );
  assert.equal(fetchImpl.calls[0].url, 'https://m.test/indexes/products/search');
});

test('site-search: SITE_SEARCH_INDEX env used when no ?index=', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ hits: [], estimatedTotalHits: 0 }));
  await siteSearch(
    { query: { q: 'x' }, request: {}, fetchImpl },
    { MEILISEARCH_HOST: 'https://m.test', SITE_SEARCH_INDEX: 'pages' },
  );
  assert.equal(fetchImpl.calls[0].url, 'https://m.test/indexes/pages/search');
});

// ═══ ?limit forwarded ═══
test('site-search: ?limit forwarded in the search body', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ hits: [], estimatedTotalHits: 0 }));
  await siteSearch(
    { query: { q: 'x', limit: '5' }, request: {}, fetchImpl },
    { MEILISEARCH_HOST: 'https://m.test' },
  );
  assert.equal(JSON.parse(fetchImpl.calls[0].body).limit, 5);
});

// ═══ validation: missing / empty q → 422 (no subrequest spent) ═══
test('site-search: no ?q → 422 Laravel error bag, no upstream call', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ hits: [] }));
  const res = await siteSearch({ query: {}, request: {}, fetchImpl }, { MEILISEARCH_HOST: 'https://m.test' });

  assert.equal(res.status, 422);
  const body = json(res);
  assert.equal(body.message, 'The given data was invalid.');
  assert.ok(Array.isArray(body.errors.q) && body.errors.q.length > 0);
  assert.equal(fetchImpl.calls.length, 0); // nothing forwarded
});

test('site-search: blank ?q → 422, no upstream call', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ hits: [] }));
  const res = await siteSearch({ query: { q: '   ' }, request: {}, fetchImpl }, { MEILISEARCH_HOST: 'https://m.test' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ═══ upstream failure → 502 ═══
test('site-search: meilisearch non-2xx → 502 with upstream message', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ message: 'index not found' }, 404));
  const res = await siteSearch(
    { query: { q: 'z' }, request: {}, fetchImpl },
    { MEILISEARCH_HOST: 'https://m.test' },
  );
  assert.equal(res.status, 502);
  assert.equal(json(res).error, 'index not found');
});

test('site-search: network throw → 502', async () => {
  const fetchImpl = fakeFetch(() => { throw new Error('connect ECONNREFUSED'); });
  const res = await siteSearch(
    { query: { q: 'z' }, request: {}, fetchImpl },
    { MEILISEARCH_HOST: 'https://m.test' },
  );
  assert.equal(res.status, 502);
  assert.match(json(res).error, /ECONNREFUSED/);
});

// ═══ config: missing host → 502 (not 500) ═══
test('site-search: MEILISEARCH_HOST unset → 502', async () => {
  const res = await siteSearch({ query: { q: 'z' }, request: {}, fetchImpl: fakeFetch() }, {});
  assert.equal(res.status, 502);
});

// ═══ tolerant upstream shape (hits only) ═══
test('site-search: missing estimatedTotalHits falls back to hits.length', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ hits: [{ id: 1 }, { id: 2 }, { id: 3 }] }));
  const res = await siteSearch(
    { query: { q: 'x' }, request: {}, fetchImpl },
    { MEILISEARCH_HOST: 'https://m.test' },
  );
  const body = json(res);
  assert.equal(body.totalHits, 3);
  assert.equal(body.hits.length, 3);
});
