// tools/tests/packages-response-cache.test.mjs — full-page response cache.
// Exercises ports/packages/response-cache.mjs (the middleware handler) and the
// storage helper kernel/packages/response-cache.mjs against an in-memory D1
// fake that supports exactly the SQL the cluster emits (CREATE TABLE, SELECT,
// DELETE by `?` key, INSERT). No network.
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
import { cacheKey, get, put, purge, init } from '../../kernel/packages/response-cache.mjs';

function epoch() { return Math.floor(Date.now() / 1000); }

// Stand the real SQL engine up. The module only issues these five statements;
// we dispatch on the leading keyword so the storage semantics stay honest.
const REAL = {
  'CREATE': () => true,
  'SELECT body, headers_json, expires_at FROM cache_response WHERE cache_key = ?': (db, params) => {
    const row = db.rows.find((r) => r.cache_key === params[0]);
    return row ? { body: row.body, headers_json: row.headers_json, expires_at: row.expires_at } : null;
  },
  'DELETE FROM cache_response WHERE cache_key = ?': (db, params) => {
    const before = db.rows.length;
    db.rows = db.rows.filter((r) => r.cache_key !== params[0]);
    return { changes: before - db.rows.length, meta: { last_row_id: 0 } };
  },
  'DELETE FROM cache_response WHERE cache_key = ? OR cache_key LIKE ? ESCAPE ?': (db, params) => {
    // Minimal LIKE matcher for the arg shape the kernel builds: `path?%` — an
    // exact base path plus the trailing wildcard. Paths containing literal
    // `%`/`_` are ESCAPE-quoted by the caller, so undo that before matching.
    const exact = String(params[0]);
    const prefix = String(params[1])
      .replace(/\\\\/g, '\u0000').replace(/\\%/g, '%').replace(/\\_/g, '_').replace(/\u0000/g, '\\')
      .slice(0, -1); // drop the trailing `%` wildcard
    const before = db.rows.length;
    db.rows = db.rows.filter((r) => r.cache_key !== exact && !r.cache_key.startsWith(prefix));
    return { changes: before - db.rows.length, meta: { last_row_id: 0 } };
  },
  'DELETE FROM cache_response': (db) => {
    const before = db.rows.length;
    db.rows = [];
    return { changes: before, meta: { last_row_id: 0 } };
  },
  'INSERT INTO cache_response (cache_key, body, headers_json, expires_at) VALUES (?, ?, ?, ?)': (db, params) => {
    db.lastId += 1;
    db.rows.push({ cache_key: params[0], body: params[1], headers_json: params[2], expires_at: params[3] });
    return { changes: 1, meta: { last_row_id: db.lastId } };
  },
};

class SqlFakeD1 {
  constructor() {
    this.rows = [];
    this.lastId = 0;
    this._sql = null;
    this._params = [];
  }
  prepare(sql) {
    const stmt = { sql: sql.trim().replace(/\s+/g, ' '), params: [], db: this };
    stmt.bind = (...params) => { stmt.params = params; return stmt; };
    stmt.first = async () => this._exec(stmt) || null;
    stmt.all = async () => { const r = this._exec(stmt); return { results: r ? [r] : [] }; };
    stmt.run = async () => { const r = this._exec(stmt); return { changes: (r && r.changes) || 0, meta: { last_row_id: this.lastId } }; };
    return stmt;
  }
  _exec(stmt) {
    const sql = stmt.sql;
    const p = stmt.params || [];
    if (sql.startsWith('CREATE')) return { changes: 0, meta: { last_row_id: 0 } };
    const fn = REAL[sql];
    if (!fn) throw new Error('unexpected SQL: ' + sql);
    const res = fn(this, p);
    if (res === null) return null;
    if (res.meta && typeof res.meta.last_row_id === 'number') this.lastId = res.meta.last_row_id;
    return res;
  }
}

const newDb = () => new SqlFakeD1();

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
  const row = db.rows.find((r) => r.cache_key === '/old');
  row.expires_at = epoch() - 10;
  assert.equal(await get('/old', '', db), null);
  assert.equal(db.rows.some((r) => r.cache_key === '/old'), false); // self-cleans
});

// ---- middleware handler ---------------------------------------------

test('response-cache: GET on a cold cache passes through (returns null)', async () => {
  const db = newDb();
  const res = await handle(ctxFor(db, 'GET', '/posts'), {});
  assert.equal(res, null);
  assert.equal(db.rows.length, 0);
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
  const row = db.rows.find((r) => r.cache_key === '/stale');
  row.expires_at = epoch() - 1;
  assert.equal(await handle(ctxFor(db, 'GET', '/stale'), {}), null);
  assert.equal(db.rows.length, 0);
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
    assert.equal(db.rows.some((r) => r.cache_key.startsWith('/posts')), false, `${method}: /posts purged`);
    // …but unrelated paths survive
    assert.equal(db.rows.some((r) => r.cache_key === '/about'), true, `${method}: /about kept`);
  }
});

test('response-cache: no D1 binding keeps the port inert (pass-through)', async () => {
  const res = await handle(ctxFor(null, 'GET', '/posts'), {});
  assert.equal(res, null);
  const res2 = await handle(ctxFor(null, 'POST', '/posts'), {});
  assert.equal(res2, null);
});
