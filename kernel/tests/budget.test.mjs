import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  const p95 = s[Math.floor(s.length * 0.95)];
  return { avg, p95 };
}

test('budget: router/db/validator/scheduler/cache/storage within 5ms p95', async () => {
  const N = 2000;

  const { normalizeTable: norm, match: mfn } = await import('../router.mjs');
  const rtTable = norm([{ uri: 'u/{id}', methods: ['GET'] }]);
  {
    const a = [];
    for (let i = 0; i < N; i++) { const t0 = performance.now(); mfn(rtTable, { method: 'GET', path: '/u/' + (i % 50) }); a.push(performance.now() - t0); }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `router avg ${avg}`);
    assert.ok(p95 <= 5, `router p95 ${p95}`);
  }

  const { table } = await import('../db.mjs');
  const fake = { prepare: () => ({ bind() { return this; }, async all() { return { results: [] }; } }) };
  {
    const a = [];
    for (let i = 0; i < N; i++) { const t0 = performance.now(); table(fake, 'config').where('k', '=', 'x').toSql(); a.push(performance.now() - t0); }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `db avg ${avg}`);
    assert.ok(p95 <= 5, `db p95 ${p95}`);
  }

  const { Validator } = await import('../validator.mjs');
  {
    const a = [];
    for (let i = 0; i < N; i++) { const t0 = performance.now(); const v = new Validator({ email: 'a@b.co' }, { email: 'required|email' }); await v.passes(); a.push(performance.now() - t0); }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `validator avg ${avg}`);
    assert.ok(p95 <= 5, `validator p95 ${p95}`);
  }

  const { defineSchedule } = await import('../scheduler.mjs');
  const s = defineSchedule(api => { api.call('a', '*/15 * * * *', async () => {}); });
  const d = new Date('2026-10-18T09:15:00Z');
  {
    const a = [];
    for (let i = 0; i < N; i++) { const t0 = performance.now(); s._match(d, '*/15 * * * *'); a.push(performance.now() - t0); }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `scheduler avg ${avg}`);
    assert.ok(p95 <= 5, `scheduler p95 ${p95}`);
  }

  const { createCache } = await import('../cache.mjs');
  const c = createCache({});
  await c.put('k', 1, 60000);
  {
    const a = [];
    for (let i = 0; i < N; i++) { const t0 = performance.now(); await c.get('k'); a.push(performance.now() - t0); }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `cache avg ${avg}`);
    assert.ok(p95 <= 5, `cache p95 ${p95}`);
  }

  const { createStorage } = await import('../storage.mjs');
  const st = createStorage({});
  await st.put('k', 'v');
  {
    const a = [];
    for (let i = 0; i < N; i++) { const t0 = performance.now(); await st.get('k'); a.push(performance.now() - t0); }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `storage avg ${avg}`);
    assert.ok(p95 <= 5, `storage p95 ${p95}`);
  }

  // rt.cache() facade (controller-facing Cache::* surface over the D1 store).
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const fakeCache = { async get() { return 1; }, async put() {}, async forget() {} };
  const rt = buildRt({}, { http: { cache: fakeCache } });
  {
    const a = [];
    for (let i = 0; i < N; i++) { const t0 = performance.now(); rt.cache(); a.push(performance.now() - t0); }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `rt.cache avg ${avg}`);
    assert.ok(p95 <= 5, `rt.cache p95 ${p95}`);
  }

  // Eloquent `hashed` cast. The bcrypt work itself is deliberately measured at
  // cost 4 here; the free-plan cost of the default cost 12 is recorded in
  // COMPILED.md (measured ~679ms CPU on Workers, matching Laravel).
  const { Model } = await import('../model.mjs');
  const { makeSync } = await import('../hash.mjs');
  class BudgetHashed extends Model {}
  BudgetHashed.table = 'users';
  BudgetHashed.casts = { password: 'hashed' };
  BudgetHashed.hashRounds = 4;
  const hashed = makeSync('secret', { rounds: 4 });
  {
    const m = new BudgetHashed();
    const a = [];
    for (let i = 0; i < N; i++) { const t0 = performance.now(); m.set('password', hashed); a.push(performance.now() - t0); }
    const { avg, p95 } = stats(a);
    // Already-hashed passthrough is regex-only (no bcrypt); must stay cheap.
    assert.ok(avg <= 2, `hashed-cast passthrough avg ${avg}`);
    assert.ok(p95 <= 5, `hashed-cast passthrough p95 ${p95}`);
  }
  {
    const m = new BudgetHashed();
    const a = [];
    for (let i = 0; i < 20; i++) { const t0 = performance.now(); m.set('password', 'secret-' + i); a.push(performance.now() - t0); }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 25, `hashed-cast bcrypt cost4 avg ${avg}`);
    assert.ok(p95 <= 40, `hashed-cast bcrypt cost4 p95 ${p95}`);
  }
});
