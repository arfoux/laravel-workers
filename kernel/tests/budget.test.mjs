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

  // The `Hash` facade surface (rt.hash) — the facade call itself is cheap; the
  // bcrypt work it triggers is the hashed-cast row above.
  {
    const a = [];
    for (let i = 0; i < N; i++) { const t0 = performance.now(); rt.hash.isHashed('x'); a.push(performance.now() - t0); }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `rt.hash avg ${avg}`);
    assert.ok(p95 <= 5, `rt.hash p95 ${p95}`);
  }

  // The model write path: rt.db() (the D1 binding) + rt.propSet() (the
  // `$model->attr = $value` assignment) + Model#set() with the cast applied.
  {
    const fakeDb = { prepare: () => ({ bind() { return this; }, async run() { return { changes: 1, lastInsertRowid: 1 }; }, async all() { return { results: [] }; } }) };
    const rt2 = buildRt({}, { db: fakeDb, hashRounds: 4 });
    const a = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      rt2.db();
      rt2.propSet(new BudgetHashed(), 'title', 'x');
      a.push(performance.now() - t0);
    }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `rt.db+rt.propSet avg ${avg}`);
    assert.ok(p95 <= 5, `rt.db+rt.propSet p95 ${p95}`);
  }

  // The `auth.basic` middleware stage: Basic header parse + guard lookup.
  {
    const header = 'Basic ' + Buffer.from('a@b.co:secret').toString('base64');
    const a = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const m = /^\s*Basic\s+(.+)$/i.exec(header);
      const decoded = atob(m[1].trim());
      decoded.indexOf(':');
      a.push(performance.now() - t0);
    }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `auth.basic header parse avg ${avg}`);
    assert.ok(p95 <= 5, `auth.basic header parse p95 ${p95}`);
  }

  // The service adapters (storage/mail/queue) — the *local* part of the call
  // (the facade lookup + the payload shape). The network cost (R2 / Resend / CF
  // Queues) is not measurable here; it is a round trip per call.
  {
    const { createStorage } = await import('../storage.mjs');
    const { createMailer } = await import('../mail.mjs');
    const { createQueue } = await import('../queue.mjs');
    const storage = createStorage({});
    const mailer = createMailer({ transport: 'log' });
    const queue = createQueue({});
    const a = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await storage.put('k', 'v');
      await storage.exists('k');
      await mailer.send({ to: 'a@b.co', subject: 's', text: 't' });
      await queue.push('default', { i });
      a.push(performance.now() - t0);
    }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `services (storage/mail/queue) avg ${avg}`);
    assert.ok(p95 <= 5, `services (storage/mail/queue) p95 ${p95}`);
  }

  // The cron evaluation the edge does for the dumped schedule (the Cloudflare
  // Cron Trigger path): matching a handful of expressions.
  {
    const { dueEvents, cronMatches } = await import('../scheduler.mjs');
    const events = [
      { name: 'a', expression: '*/5 * * * *' },
      { name: 'b', expression: '0 9 * * *' },
      { name: 'c', expression: '0 0 1 * *' },
    ];
    const now = new Date('2026-10-18T12:15:00Z');
    const a = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      cronMatches('*/5 * * * *', now);
      dueEvents(events, now);
      a.push(performance.now() - t0);
    }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `schedule cron evaluation avg ${avg}`);
    assert.ok(p95 <= 5, `schedule cron evaluation p95 ${p95}`);
  }

  // The `new` expression (the built-in exceptions) + throw_if/throw_unless.
  {
    const a = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      rt.newError('RuntimeException', 'budget row');
      rt.throwIf(false, rt.newError('RuntimeException', 'never'));
      a.push(performance.now() - t0);
    }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `new exception avg ${avg}`);
    assert.ok(p95 <= 5, `new exception p95 ${p95}`);
  }

  // The helper verbs: rt.abortIf/rt.abortUnless/rt.today/rt.log (the request
  // clock, the platform log) - the local cost only.
  {
    const a = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      rt.abortIf(false, 404, 'never');
      rt.abortUnless(true, 500, 'never');
      rt.today().toDateString();
      rt.log('info', 'budget row');
      a.push(performance.now() - t0);
    }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `helper verbs avg ${avg}`);
    assert.ok(p95 <= 5, `helper verbs p95 ${p95}`);
  }

  // The D1 blob store (the Storage facade on D1 - no R2, no card): the local
  // part of one put + one get (the SQL text, the size check, the row shape).
  // The D1 round trip itself is not measurable here; on the free plan a blob
  // write counts as one D1 row write and a blob read as one row read
  // (100k writes/day, 5M reads/day).
  {
    const rows = new Map();
    const fakeD1 = {
      prepare(sql) {
        const stmt = {
          params: [],
          bind(...p) { this.params = p; return this; },
          async first() {
            if (/SELECT 1/.test(sql)) return { '1': 1 };
            const row = rows.get(this.params[0]);
            return row === undefined ? null : { body: row.body };
          },
          async run() {
            if (/^INSERT OR REPLACE/.test(sql)) {
              rows.set(this.params[0], { body: this.params[1] });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true };
          },
        };
        return stmt;
      },
    };
    const { createStorage: createStore } = await import('../storage.mjs');
    const blob = createStore({ d1: fakeD1 });
    await blob.put('k', 'v');
    const a = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await blob.put('k', 'v');
      await blob.get('k');
      a.push(performance.now() - t0);
    }
    const { avg, p95 } = stats(a);
    assert.ok(avg <= 2, `storage d1 blob store avg ${avg}`);
    assert.ok(p95 <= 5, `storage d1 blob store p95 ${p95}`);
  }
});
