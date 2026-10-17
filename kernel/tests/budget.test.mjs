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
});
