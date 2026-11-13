// tools/tests/packages-pulse.test.mjs — laravel/pulse observability port.
//
// Exercises the two seams with an in-memory D1 fake (no real D1 / network):
//   - POST /pulse/record  -> inserts a row into `pulse_entries`; missing `type` -> 422.
//   - GET  /pulse         -> aggregates `pulse_entries` into a JSON summary.
// The fake supports exactly the SQL shapes `ports/packages/pulse.mjs` emits:
// CREATE TABLE IF NOT EXISTS / CREATE INDEX (no-ops), INSERT ... VALUES (?,?,...),
// and SELECT <cols> FROM <t>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pulse, { summarize, ensureSchema } from '../../ports/packages/pulse.mjs';
import { makeCtx } from './_helpers.mjs';

// ---- A compact in-memory D1 fake for the pulse SQL shapes ------------------

class FakeD1 {
  constructor() {
    this.tables = new Map(); // name -> [rows]
    this.sequences = new Map(); // name -> next id
    this._sql = null;
    this._params = [];
  }

  prepare(sql) {
    this._sql = sql;
    this._params = [];
    return this;
  }

  bind(...params) {
    this._params = params;
    return this;
  }

  async run() {
    const sql = this._sql.replace(/\s+/g, ' ').trim();
    const createTable = /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(sql);
    if (createTable) {
      if (!this.tables.has(createTable[1])) this.tables.set(createTable[1], []);
      return { changes: 0, meta: {} };
    }
    if (/^CREATE INDEX/i.test(sql)) return { changes: 0, meta: {} };

    const insert = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i.exec(sql);
    if (insert) {
      const [, table, colsRaw, placeholders] = insert;
      if (!this.tables.has(table)) this.tables.set(table, []);
      const cols = colsRaw.split(',').map((c) => c.trim());
      const row = {};
      let pi = 0;
      for (const ph of placeholders.split(',').map((p) => p.trim())) {
        const col = cols[pi];
        row[col] = ph === '?' ? this._params[pi] : undefined;
        pi += 1;
      }
      const nextId = (this.sequences.get(table) || 0) + 1;
      this.sequences.set(table, nextId);
      row.id = nextId;
      this.tables.get(table).push(row);
      return { changes: 1, last_row_id: nextId, meta: { last_row_id: nextId } };
    }
    throw new Error(`FakeD1.run: unsupported SQL: ${sql}`);
  }

  async first() {
    const { results } = await this.all();
    return results[0] ?? null;
  }

  async all() {
    const sql = this._sql.replace(/\s+/g, ' ').trim();
    const sel = /^SELECT (.+?) FROM (\w+)$/i.exec(sql);
    if (!sel) throw new Error(`FakeD1.all: unsupported SQL: ${sql}`);
    const [, colsRaw, table] = sel;
    const rows = this.tables.get(table) || [];
    if (colsRaw.trim() === '*') return { results: rows.map((r) => ({ ...r })) };
    const cols = colsRaw.split(',').map((c) => c.trim());
    return { results: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))) };
  }
}

function makeEnv() {
  return { DB: new FakeD1() };
}

const parse = (res) => JSON.parse(res.body);

// ---- POST /pulse/record ----------------------------------------------------

test('record: inserts an entry and returns it with an id', async () => {
  const env = makeEnv();
  const res = await pulse(
    makeCtx({
      method: 'POST',
      body: { type: 'request', path: '/api/users', status: 200, duration_ms: 42 },
    }),
    env
  );
  assert.equal(res.status, 201);
  const { entry } = parse(res);
  assert.equal(entry.type, 'request');
  assert.equal(entry.path, '/api/users');
  assert.equal(entry.status, 200);
  assert.equal(entry.duration_ms, 42);
  assert.ok(entry.id >= 1);
  assert.ok(entry.recorded_at);
  const rows = env.DB.tables.get('pulse_entries');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'request');
  assert.equal(rows[0].status, 200);
});

test('record: missing type is a 422 and writes nothing', async () => {
  const env = makeEnv();
  const res = await pulse(makeCtx({ method: 'POST', body: { path: '/x', status: 500 } }), env);
  assert.equal(res.status, 422);
  assert.ok(parse(res).error);
  assert.equal((env.DB.tables.get('pulse_entries') || []).length, 0);
});

test('record: empty-string type is a 422', async () => {
  const env = makeEnv();
  const res = await pulse(makeCtx({ method: 'POST', body: { type: '' } }), env);
  assert.equal(res.status, 422);
});

test('record: honours a supplied recorded_at and coerces status/duration', async () => {
  const env = makeEnv();
  const res = await pulse(
    makeCtx({
      method: 'POST',
      body: { type: 'error', path: '/boom', status: '503', duration_ms: '12.5', recorded_at: '2026-01-01T00:00:00.000Z' },
    }),
    env
  );
  assert.equal(res.status, 201);
  const { entry } = parse(res);
  assert.equal(entry.status, 503);
  assert.equal(entry.duration_ms, 12.5);
  assert.equal(entry.recorded_at, '2026-01-01T00:00:00.000Z');
});

test('record: defaults recorded_at to now when absent', async () => {
  const env = makeEnv();
  const before = Date.now();
  const res = await pulse(makeCtx({ method: 'POST', body: { type: 'request' } }), env);
  assert.equal(res.status, 201);
  const t = Date.parse(parse(res).entry.recorded_at);
  assert.ok(t >= before - 1000 && t <= Date.now() + 1000);
});

// ---- GET /pulse (dashboard summary) ---------------------------------------

test('dashboard: returns 200 with the summary shape on an empty table', async () => {
  const env = makeEnv();
  const res = await pulse(makeCtx({ method: 'GET' }), env);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const { summary } = parse(res);
  assert.equal(summary.requests_count, 0);
  assert.equal(summary.errors_count, 0);
  assert.equal(summary.avg_duration, 0);
  assert.deepEqual(summary.top_routes, []);
});

test('dashboard: aggregates requests, errors and avg duration', async () => {
  const env = makeEnv();
  await ensureSchema(env);
  const ins = env.DB.prepare(
    'INSERT INTO pulse_entries (type, path, status, duration_ms, recorded_at) VALUES (?, ?, ?, ?, ?)'
  );
  await ins.bind('request', '/a', 200, 100, '2026-01-01T00:00:00.000Z').run();
  await ins.bind('request', '/a', 200, 300, '2026-01-01T00:01:00.000Z').run();
  await ins.bind('request', '/b', 500, 200, '2026-01-01T00:01:00.000Z').run();
  const res = await pulse(makeCtx({ method: 'GET' }), env);
  const { summary } = parse(res);
  assert.equal(summary.requests_count, 3);
  assert.equal(summary.errors_count, 1);
  assert.equal(summary.avg_duration, 200);
  assert.equal(summary.top_routes[0].path, '/a');
  assert.equal(summary.top_routes[0].requests, 2);
  assert.equal(summary.top_routes[0].avg_duration, 200);
  assert.equal(summary.top_routes[1].path, '/b');
  assert.equal(summary.top_routes[1].errors, 1);
});

test('dashboard: records then reads round-trip through the same port', async () => {
  const env = makeEnv();
  await pulse(makeCtx({ method: 'POST', body: { type: 'request', path: '/x', status: 404, duration_ms: 50 } }), env);
  await pulse(makeCtx({ method: 'POST', body: { type: 'request', path: '/x', status: 200, duration_ms: 150 } }), env);
  const res = await pulse(makeCtx({ method: 'GET' }), env);
  const { summary } = parse(res);
  assert.equal(summary.requests_count, 2);
  assert.equal(summary.errors_count, 1);
  assert.equal(summary.avg_duration, 100);
});

test('dashboard: range filter narrows to recent entries only', async () => {
  const env = makeEnv();
  await ensureSchema(env);
  const ins = env.DB.prepare(
    'INSERT INTO pulse_entries (type, path, status, duration_ms, recorded_at) VALUES (?, ?, ?, ?, ?)'
  );
  const now = Date.now();
  await ins.bind('request', '/old', 200, 10, new Date(now - 10 * 60_000).toISOString()).run();
  await ins.bind('request', '/new', 200, 20, new Date(now - 60_000).toISOString()).run();
  const res = await pulse(makeCtx({ method: 'GET', query: { range: '5' } }), env);
  const { summary } = parse(res);
  assert.equal(summary.requests_count, 1);
  assert.equal(summary.top_routes[0].path, '/new');
});

// ---- summarize() unit ------------------------------------------------------

test('summarize: per_minute buckets entries by minute', () => {
  const rows = [
    { path: '/a', status: 200, duration_ms: 10, recorded_at: '2026-01-01T00:00:30.000Z' },
    { path: '/a', status: 200, duration_ms: 10, recorded_at: '2026-01-01T00:00:50.000Z' },
    { path: '/a', status: 200, duration_ms: 10, recorded_at: '2026-01-01T00:01:10.000Z' },
  ];
  const s = summarize(rows);
  assert.deepEqual(s.per_minute, [
    { minute: '2026-01-01T00:00:00.000Z', requests: 2 },
    { minute: '2026-01-01T00:01:00.000Z', requests: 1 },
  ]);
});

test('summarize: rows without a duration are excluded from avg_duration', () => {
  const s = summarize([
    { path: '/a', status: 200, duration_ms: 100, recorded_at: '2026-01-01T00:00:00.000Z' },
    { path: '/a', status: 200, duration_ms: null, recorded_at: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.equal(s.requests_count, 2);
  assert.equal(s.avg_duration, 100);
});
