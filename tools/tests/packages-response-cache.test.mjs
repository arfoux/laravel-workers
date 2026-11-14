// tools/tests/packages-response-cache.test.mjs — full-page response cache.
// Exercises ports/packages/response-cache.mjs (the middleware handler) and the
// storage helper kernel/packages/response-cache.mjs, against real SQLite
// (`tools/tests/_fake-d1.mjs`). No network.
//
// Scenarios:
//   - GET on an empty cache -> handler returns `null` (pass-through to origin);
//   - kernel put() then GET   -> handler serves the cached body + HIT header;
//   - POST/PUT/PATCH/DELETE   -> purge the cached entry for that path;
//   - expired entry           -> treated as a miss (and removed on read);
//   - non-2xx put             -> not stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handle from '../../ports/packages/response-cache.mjs';
import { cacheKey, get, put, purge, init, CACHE_RESPONSE_SCHEMA } from '../../kernel/packages/response-cache.mjs';
import { FakeD1 } from './_fake-d1.mjs';

function epoch() { return Math.floor(Date.now() / 1000); }

const newDb = () => new FakeD1({ schema: CACHE_RESPONSE_SCHEMA });
// The rows the handler stored, straight out of SQLite.
const cachedRows = (db) => db.tables.get('cache_response') || [];

// Build a router-like ctx for the handler: plain body/params/db plus a kernel
// Request whose accessors are METHODS (method/pathInfo/getQueryString), which is
// exactly what the kernel router hands a port and what the normaliser must map.
const ctxFor = (db, method, path) => {
  const request = {
    method: () => method,
    pathInfo: () => path,
    getQueryString: () => (path.includes('?') ? path.slice(path.indexOf('?') + 1) : ''),
    path: () => path.split('?')[0],
  };
  return { request, params: {}, method, db };
};

// ---- storage helpers ------------------------------------------------

test('response-cache: cacheKey folds and normalises the query string', () => {
  assert.equal(cacheKey('/items', ''), '/items');
  assert.equal(cacheKey('/items', null), '/items');
  assert.equal(cacheKey('/items', 'page=2'), '/items?page=2');
  // key order must not fragment the cache
  assert.equal(cacheKey('/items', 'b=2&a=1'), cacheKey('/items', 'a=1&b=2'));
});

test('response-cache: put then get round-trips with headers_json intact', async () => {
  const db = newDb();
  await init(db);
  const resp = {
    status: 200,
    headers: { 'content-type': 'text/html', 'x-page': 'catalog' },
    body: '<h1>catalog</h1>',
  };
  assert.equal(await put('/items', 'page=2', resp, db, 60), true);

  const got = await get('/items', 'page=2', db);
  assert.ok(got);
  assert.equal(got.status, 200);
  assert.equal(got.body, '<h1>catalog</h1>');
  assert.equal(got.headers['x-page'], 'catalog');

  // a different query string is a different entry
  assert.equal(await get('/items', 'page=3', db), null);
  // the same query in a different order still hits
  assert.deepEqual(await get('/items', '2=page', db), null);
});

test('response-cache: non-2xx responses are never stored', async () => {
  const db = newDb();
  assert.equal(await put('/items', '', { status: 500, headers: {}, body: 'boom' }, db), false);
  assert.equal(await get('/items', '', db), null);
});

test('response-cache: ttl expiry is a miss and the row is removed', async () => {
  const db = newDb();
  await put('/hit', '', { status: 200, headers: {}, body: 'fresh' }, db, -1);
  // expires_at = 0 => never expires
  assert.equal((await get('/hit', '', db)).body, 'fresh');

  await put('/old', '', { status: 200, headers: {}, body: 'stale' }, db, 1);
  // force the stored row into the past
  await db.prepare('UPDATE cache_response SET expires_at = ? WHERE cache_key = ?').bind(epoch() - 10, '/old').run();
  assert.equal(await get('/old', '', db), null);
  assert.equal(cachedRows(db).some((r) => r.cache_key === '/old'), false); // self-cleans
});

// ---- middleware handler ---------------------------------------------

test('response-cache: GET on a cold cache passes through (returns null)', async () => {
  const db = newDb();
  const res = await handle(ctxFor(db, 'GET', '/posts'), {});
  assert.equal(res, null);
  assert.equal(cachedRows(db).length, 0);
});

test('response-cache: GET serves the cached body with a HIT header', async () => {
  const db = newDb();
  await put('/posts', '', { status: 200, headers: { 'content-type': 'text/html' }, body: '<article>1</article>' }, db, 300);
  const res = await handle(ctxFor(db, 'GET', '/posts'), {});
  assert.ok(res);
  assert.equal(res.status, 200);
  assert.equal(res.body, '<article>1</article>');
  assert.equal(res.headers['x-response-cache'], 'HIT');
  assert.match(res.headers['content-type'], /text\/html/);
});

test('response-cache: an expired entry is not served – origin renders', async () => {
  const db = newDb();
  await put('/stale', '', { status: 200, headers: {}, body: 'stale' }, db, 5);
  await db.prepare('UPDATE cache_response SET expires_at = ? WHERE cache_key = ?').bind(epoch() - 1, '/stale').run();
  assert.equal(await handle(ctxFor(db, 'GET', '/stale'), {}), null);
  assert.equal(cachedRows(db).length, 0);
});

test('response-cache: mutating verbs purge the path and pass through', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const db = newDb();
    // seed two query variants of the same path plus an unrelated page
    await put('/posts', '', { status: 200, headers: {}, body: 'a' }, db, 300);
    await put('/posts', 'page=2', { status: 200, headers: {}, body: 'b' }, db, 300);
    await put('/about', '', { status: 200, headers: {}, body: 'c' }, db, 300);

    const res = await handle(ctxFor(db, method, '/posts?page=2'), {});
    assert.equal(res, null, `${method}: origin must still run`);
    // this path is gone for every query variant…
    assert.equal(cachedRows(db).some((r) => r.cache_key.startsWith('/posts')), false, `${method}: /posts purged`);
    // …but unrelated paths survive
    assert.equal(cachedRows(db).some((r) => r.cache_key === '/about'), true, `${method}: /about kept`);
  }
});

test('response-cache: no D1 binding keeps the port inert (pass-through)', async () => {
  const res = await handle(ctxFor(null, 'GET', '/posts'), {});
  assert.equal(res, null);
  const res2 = await handle(ctxFor(null, 'POST', '/posts'), {});
  assert.equal(res2, null);
});
