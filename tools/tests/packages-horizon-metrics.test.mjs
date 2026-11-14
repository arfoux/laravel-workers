// tools/tests/packages-horizon-metrics.test.mjs — laravel/horizon job-metrics port.
//
// Exercises the two seams against real SQLite (`tools/tests/_fake-d1.mjs`),
// no real D1 / network:
//   - POST /horizon/record   -> inserts a row into `job_metrics`; missing `type` -> 422.
//   - GET  /horizon/metrics  -> aggregates `job_metrics` per queue into a JSON summary.
//   - GET  ?queue=<name>     -> narrows the read to a single queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import horizon, { aggregateByQueue, ensureSchema } from '../../ports/packages/horizon-metrics.mjs';
import { FakeD1 } from './_fake-d1.mjs';
import { makeCtx } from './_helpers.mjs';

function makeEnv() {
  return { DB: new FakeD1() };
}

const parse = (res) => JSON.parse(res.body);

// ---- POST /horizon/record --------------------------------------------------

test('record: inserts a metric and returns it with an id', async () => {
  const env = makeEnv();
  const res = await horizon(
    makeCtx({
      method: 'POST',
      body: { type: 'Job\\ProcessPodcast', queue: 'podcasts', status: 'completed', duration_ms: 250 },
    }),
    env
  );
  assert.equal(res.status, 201);
  const { metric } = parse(res);
  assert.equal(metric.type, 'Job\\ProcessPodcast');
  assert.equal(metric.queue, 'podcasts');
  assert.equal(metric.status, 'completed');
  assert.equal(metric.duration_ms, 250);
  assert.ok(metric.id >= 1);
  assert.ok(metric.created_at);
  const rows = env.DB.tables.get('job_metrics');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'Job\\ProcessPodcast');
  assert.equal(rows[0].status, 'completed');
});

test('record: missing type is a 422 and writes nothing', async () => {
  const env = makeEnv();
  const res = await horizon(makeCtx({ method: 'POST', body: { queue: 'emails', status: 'failed' } }), env);
  assert.equal(res.status, 422);
  assert.ok(parse(res).error);
  assert.equal((env.DB.tables.get('job_metrics') || []).length, 0);
});

test('record: empty-string type is a 422', async () => {
  const env = makeEnv();
  const res = await horizon(makeCtx({ method: 'POST', body: { type: '' } }), env);
  assert.equal(res.status, 422);
});

test('record: queue/status optional, duration coerced, created_at honoured', async () => {
  const env = makeEnv();
  const res = await horizon(
    makeCtx({
      method: 'POST',
      body: { type: 'builder', duration_ms: '12.5', created_at: '2026-01-01T00:00:00.000Z' },
    }),
    env
  );
  assert.equal(res.status, 201);
  const { metric } = parse(res);
  assert.equal(metric.queue, null);
  assert.equal(metric.status, null);
  assert.equal(metric.duration_ms, 12.5);
  assert.equal(metric.created_at, '2026-01-01T00:00:00.000Z');
});

test('record: defaults created_at to now when absent', async () => {
  const env = makeEnv();
  const before = Date.now();
  const res = await horizon(makeCtx({ method: 'POST', body: { type: 'seeder' } }), env);
  assert.equal(res.status, 201);
  const t = Date.parse(parse(res).metric.created_at);
  assert.ok(t >= before - 1000 && t <= Date.now() + 1000);
});

test('record: stores a pending-status metric too', async () => {
  const env = makeEnv();
  const res = await horizon(
    makeCtx({ method: 'POST', body: { type: 'export', queue: 'reports', status: 'pending' } }),
    env
  );
  assert.equal(res.status, 201);
  assert.equal(parse(res).metric.status, 'pending');
});

// ---- GET /horizon/metrics (per-queue aggregation) --------------------------

test('dashboard: returns 200 with the metrics shape on an empty table', async () => {
  const env = makeEnv();
  const res = await horizon(makeCtx({ method: 'GET' }), env);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const { metrics } = parse(res);
  assert.deepEqual(metrics.queues, []);
  assert.deepEqual(metrics.total, { total: 0, completed: 0, failed: 0, pending: 0, other: 0 });
});

test('dashboard: aggregates counts and avg duration per queue', async () => {
  const env = makeEnv();
  await ensureSchema(env);
  const ins = env.DB.prepare(
    'INSERT INTO job_metrics (type, queue, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  await ins.bind('Job\\A', 'default', 'completed', 100, '2026-01-01T00:00:00.000Z').run();
  await ins.bind('Job\\A', 'default', 'failed', 200, '2026-01-01T00:01:00.000Z').run();
  await ins.bind('Job\\B', 'emails', 'completed', 300, '2026-01-01T00:01:00.000Z').run();
  await ins.bind('Job\\B', 'emails', 'pending', null, '2026-01-01T00:02:00.000Z').run();
  const res = await horizon(makeCtx({ method: 'GET' }), env);
  assert.equal(res.status, 200);
  const { metrics } = parse(res);
  assert.equal(metrics.queues.length, 2);
  const def = metrics.queues[0];
  assert.equal(def.queue, 'default');
  assert.equal(def.total, 2);
  assert.equal(def.completed, 1);
  assert.equal(def.failed, 1);
  assert.equal(def.pending, 0);
  assert.equal(def.avg_duration, 150);
  const emails = metrics.queues[1];
  assert.equal(emails.queue, 'emails');
  assert.equal(emails.completed, 1);
  assert.equal(emails.pending, 1);
  assert.equal(emails.failed, 0);
  assert.equal(emails.avg_duration, 300);
  assert.deepEqual(metrics.total, { total: 4, completed: 2, failed: 1, pending: 1, other: 0 });
});

test('dashboard: filter by queue narrows to that queue only', async () => {
  const env = makeEnv();
  await ensureSchema(env);
  const ins = env.DB.prepare(
    'INSERT INTO job_metrics (type, queue, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  await ins.bind('Job\\A', 'default', 'completed', 100, '2026-01-01T00:00:00.000Z').run();
  await ins.bind('Job\\B', 'emails', 'failed', 50, '2026-01-01T00:00:00.000Z').run();
  const res = await horizon(makeCtx({ method: 'GET', query: { queue: 'emails' } }), env);
  assert.equal(res.status, 200);
  const { metrics } = parse(res);
  assert.equal(metrics.queues.length, 1);
  assert.equal(metrics.queues[0].queue, 'emails');
  assert.equal(metrics.queues[0].failed, 1);
  assert.equal(metrics.total.total, 1);
  assert.equal(metrics.total.completed, 0);
});

test('dashboard: records then reads round-trip through the same port', async () => {
  const env = makeEnv();
  await horizon(
    makeCtx({ method: 'POST', body: { type: 'Job\\A', queue: 'webhooks', status: 'completed', duration_ms: 40 } }),
    env
  );
  await horizon(
    makeCtx({ method: 'POST', body: { type: 'Job\\A', queue: 'webhooks', status: 'failed', duration_ms: 160 } }),
    env
  );
  const res = await horizon(makeCtx({ method: 'GET' }), env);
  const { metrics } = parse(res);
  assert.equal(metrics.queues.length, 1);
  assert.equal(metrics.queues[0].total, 2);
  assert.equal(metrics.queues[0].completed, 1);
  assert.equal(metrics.queues[0].failed, 1);
  assert.equal(metrics.queues[0].avg_duration, 100);
});

// ---- aggregateByQueue() unit -----------------------------------------------

test('aggregateByQueue: unknown status rolls into other', () => {
  const { total, queues } = aggregateByQueue([
    { queue: 'a', status: 'running', duration_ms: 10 },
    { queue: 'a', status: 'COMPLETED', duration_ms: 20 },
  ]);
  assert.equal(queues[0].completed, 1);
  assert.equal(queues[0].other, 1);
  assert.equal(total.other, 1);
});

test('aggregateByQueue: rows without a queue bucket into (default)', () => {
  const { queues } = aggregateByQueue([{ queue: null, status: 'completed', duration_ms: 5 }]);
  assert.equal(queues.length, 1);
  assert.equal(queues[0].queue, '(default)');
  assert.equal(queues[0].completed, 1);
});

test('aggregateByQueue: rows without a duration are excluded from avg_duration', () => {
  const { queues } = aggregateByQueue([
    { queue: 'a', status: 'pending' },
    { queue: 'a', status: 'completed', duration_ms: 100 },
  ]);
  assert.equal(queues[0].avg_duration, 100);
});
