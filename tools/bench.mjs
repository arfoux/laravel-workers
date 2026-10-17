#!/usr/bin/env node
// tools/bench.mjs — Micro-bench (p95 gate)
// Hot paths: router, db.toSql, validator, scheduler, cache/memory, storage/memory, encrypter.
import { performance } from 'node:perf_hooks';

const N = Number(process.env.BENCH_N || 5000);

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const avg = sum / s.length;
  const p50 = s[Math.floor(s.length * 0.5)];
  const p95 = s[Math.floor(s.length * 0.95)];
  const max = s[s.length - 1];
  return { n: s.length, avg, p50, p95, max };
}

async function benchRouter() {
  const { normalizeTable, match } = await import('../kernel/router.mjs');
  const table = normalizeTable([{ uri: '/', methods: ['GET'] }, { uri: 'u/{id}', methods: ['GET'] }]);
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    match(table, { method: 'GET', path: '/u/' + (i % 100) });
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

async function benchDb() {
  const { table } = await import('../kernel/db.mjs');
  const fake = { prepare: () => ({ bind() { return this; }, async all() { return { results: [] }; }, async first() { return null; }, async run() { return {}; } }) };
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    table(fake, 'config').where('k', '=', 'v' + i).limit(10).toSql();
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

async function benchValidator() {
  const { Validator } = await import('../kernel/validator.mjs');
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const v = new Validator({ email: 'a@b.co', name: 'John' }, { email: 'required|email', name: 'required|min:3' });
    await v.passes();
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

async function benchScheduler() {
  const { defineSchedule } = await import('../kernel/scheduler.mjs');
  const s = defineSchedule(api => { api.call('a', '*/15 * * * *', async () => {}); api.call('b', '0 9 * * *', async () => {}); });
  const d = new Date('2026-10-18T09:15:00Z');
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    s._match(d, '*/15 * * * *');
    s._match(d, '0 9 * * *');
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

async function benchCache() {
  const { createCache } = await import('../kernel/cache.mjs');
  const c = createCache({});
  await c.put('k', { v: 1 }, 60000);
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await c.get('k');
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

async function benchStorage() {
  const { createStorage } = await import('../kernel/storage.mjs');
  const s = createStorage({});
  await s.put('a/b.txt', 'hello');
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await s.get('a/b.txt');
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

async function benchEncrypter() {
  const { encryptString, decryptString } = await import('../kernel/encrypter.mjs');
  const raw = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
  const samples = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    const tok = await encryptString('hello ' + i, raw);
    await decryptString(tok, raw);
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

const ops = [
  ['router.match', benchRouter, 2.0, 5.0],
  ['db.toSql', benchDb, 2.0, 5.0],
  ['validator.passes', benchValidator, 2.0, 5.0],
  ['scheduler._match', benchScheduler, 2.0, 5.0],
  ['cache.get(memory)', benchCache, 2.0, 5.0],
  ['storage.get(memory)', benchStorage, 2.0, 5.0],
  ['encrypter.roundTrip', benchEncrypter, 20.0, 30.0],
];

const results = [];
let allPass = true;
for (const [name, fn, avgBudget, p95Budget] of ops) {
  const st = await fn();
  const pass = st.avg <= avgBudget && st.p95 <= p95Budget;
  if (!pass) allPass = false;
  const row = { op: name, n: st.n, avg_ms: Number(st.avg.toFixed(4)), p50_ms: Number(st.p50.toFixed(4)), p95_ms: Number(st.p95.toFixed(4)), max_ms: Number(st.max.toFixed(4)), budget: { avg: avgBudget, p95: p95Budget }, pass };
  results.push(row);
  console.log(JSON.stringify(row));
}

if (allPass) console.log('bench PASS: all ops within budget (hot p95 <= 5ms, encrypter p95 <= 30ms)');
else { console.error('bench FAIL: one or more ops exceeded budget'); process.exit(1); }
