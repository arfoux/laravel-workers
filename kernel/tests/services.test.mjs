import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailer } from '../mail.mjs';
import { createQueue } from '../queue.mjs';
import { createCache } from '../cache.mjs';
import { createStorage } from '../storage.mjs';
import { defineSchedule } from '../scheduler.mjs';

// mail — log
test('mail log transport', async () => {
  const mail = createMailer({ transport: 'log', from: 'x@example.com' });
  const r = await mail.send({ to: 'a@b.co', subject: 'hi', html: '<p>hi</p>' });
  assert.ok(r.id.startsWith('log-'));
  assert.equal(mail.outbox[0].to, 'a@b.co');
});
test('mail noop', async () => {
  const mail = createMailer({ transport: 'noop' });
  const r = await mail.send({ to: 'a@b.co', subject: 'hi' });
  assert.equal(r.id, 'noop');
});
test('mail resend mock fetch', async () => {
  let lastUrl = null;
  const fetchImpl = async (url) => { lastUrl = url; return { ok: true, async json(){ return { id: 're_123' }; } }; };
  const mail = createMailer({ transport: 'resend', from: 'from@example.com', fetchImpl });
  const r = await mail.send({ to: 'a@b.co', subject: 'hi', html: 'x' });
  assert.equal(r.id, 're_123');
  assert.equal(lastUrl, 'https://api.resend.com/emails');
});
test('mail resend error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, async text(){ return 'bad key'; } });
  const mail = createMailer({ transport: 'resend', fetchImpl });
  await assert.rejects(() => mail.send({ to: 'a@b.co', subject: 'hi' }));
});

// queue — memory
test('queue memory push/pop', async () => {
  const q = createQueue({});
  await q.push('emails', { to: 'a' });
  await q.push('emails', { to: 'b' });
  const a = await q.pop('emails');
  assert.equal(a.payload.to, 'a');
  const b = await q.pop('emails');
  assert.equal(b.payload.to, 'b');
  assert.equal(await q.pop('emails'), null);
});
test('queue binding send', async () => {
  const sent = [];
  const binding = { async send(m){ sent.push(m); } };
  const q = createQueue({ binding });
  const j = await q.push('emails', { to: 'a' });
  assert.equal(sent[0].queue, 'emails');
  assert.equal(j.payload.to, 'a');
  assert.equal(await q.pop(), null);
});

// cache — memory
test('cache memory get/put/forget', async () => {
  const c = createCache({});
  assert.equal(await c.get('k'), null);
  await c.put('k', { v: 1 }, 10000);
  assert.deepEqual(await c.get('k'), { v: 1 });
  await c.forget('k');
  assert.equal(await c.get('k'), null);
});
test('cache remember', async () => {
  const c = createCache({});
  let n = 0;
  const v1 = await c.remember('k', 10000, async () => ++n);
  assert.equal(v1, 1);
  const v2 = await c.remember('k', 10000, async () => ++n);
  assert.equal(v2, 1);
  assert.equal(n, 1);
});
test('cache ttl expiry', async () => {
  const c = createCache({});
  await c.put('k', 1, 5);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(await c.get('k'), null);
});
test('cache kv binding', async () => {
  const store = new Map();
  const kv = { async get(k){ const v=store.get(k); return v===undefined?null:v; }, async put(k,v){ store.set(k,v); }, async delete(k){ store.delete(k); } };
  const c = createCache({ kv });
  await c.put('k', { x: 1 });
  assert.deepEqual(await c.get('k'), { x: 1 });
  await c.forget('k');
  assert.equal(await c.get('k'), null);
});

// The `new` expression: the built-in exceptions become errors with the same
// class name and message (Laravel answers a 500 for them too).
test('the runtime: rt.newError keeps the PHP class name and message', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const rt = buildRt(null, { runtime: true });
  const e = rt.newError('RuntimeException', 'boom');
  assert.equal(e.name, 'RuntimeException');
  assert.equal(e.message, 'boom');
  assert.equal(e.phpClass, 'RuntimeException');
  assert.equal(rt.throwIf(false, e), null);
  assert.throws(() => rt.throwIf(true, e), /boom/);
  assert.equal(rt.throwUnless(true, e), null);
  assert.throws(() => rt.throwUnless(false, e), /boom/);
});

// The helper verbs: the request clock (now()/today()) and the log sink.
test('the runtime: now()/today() follow the request clock and rt.log reaches the sink', async () => {
  const { buildRt } = await import('../../compiler/runtime/rt-from-context.mjs');
  const logged = [];
  const rt = buildRt(null, {
    runtime: true,
    http: {
      clock: () => 1767225600, // 2026-01-01T00:00:00Z (the shadow freeze)
      log: (level, message) => { logged.push({ level, message }); return null; },
    },
  });
  assert.equal(rt.now().toDateTimeString(), '2026-01-01 00:00:00');
  assert.equal(rt.today().toDateString(), '2026-01-01');
  assert.equal(rt.abortIf(false, 404, 'never'), null);
  assert.throws(() => rt.abortIf(true, 404, 'gone'), (e) => e.status === 404);
  assert.equal(rt.abortUnless(true, 404, 'never'), null);
  assert.throws(() => rt.abortUnless(false, 500, 'gone'), (e) => e.status === 500);
  assert.equal(rt.log('info', 'hello'), null);
  assert.deepEqual(logged, [{ level: 'info', message: 'hello' }]);
});

// storage — memory
test('storage memory put/get/delete', async () => {
  const s = createStorage({});
  // Laravel's FilesystemAdapter::put() answers a bool, not the path.
  assert.equal(await s.put('a/b.txt', 'hello'), true);
  const obj = await s.get('a/b.txt');
  assert.equal(obj.body, 'hello');
  assert.equal(s.url('a/b.txt'), '/r2/a/b.txt');
  assert.equal(await s.delete('a/b.txt'), true);
  assert.equal(await s.get('a/b.txt'), null);
  // Laravel answers false when the file was missing.
  assert.equal(await s.delete('a/b.txt'), false);
});
test('storage: a missing file fails loud on get (Laravel throws UnableToReadFile)', async () => {
  const s = createStorage({});
  await assert.rejects(() => s.getText('nope.txt'), /does not exist/);
});
test('storage r2 binding', async () => {
  const m = new Map();
  const r2 = {
    async put(k,v){ m.set(k,v); },
    async get(k){ const v=m.get(k); return v===undefined?null:{ body: v }; },
    async head(k){ return m.has(k) ? { body: 'x' } : null; },
    async delete(k){ m.delete(k); },
  };
  const s = createStorage({ r2 });
  assert.equal(await s.put('x', 'v'), true);
  assert.equal((await s.get('x')).body, 'v');
  assert.equal(await s.delete('x'), true);
  assert.equal(await s.delete('x'), false);
});

// storage — the D1 blob store (one row per object; no R2, no card)
function mockD1() {
  const rows = new Map();
  const state = { tables: new Set(), created: 0, statements: [] };
  return {
    state,
    prepare(sql) {
      state.statements.push(sql);
      const stmt = {
        params: [],
        bind(...p) { this.params = p; return this; },
        async first() {
          if (sql.includes('lw_blobs') && !state.tables.has('lw_blobs')) {
            throw new Error('D1_ERROR: no such table: lw_blobs');
          }
          if (/SELECT 1/.test(sql)) return { '1': 1 };
          const row = rows.get(this.params[0]);
          return row === undefined ? null : { body: row.body, size: row.size };
        },
        async run() {
          if (/^CREATE TABLE/.test(sql)) {
            state.tables.add('lw_blobs');
            state.created++;
            return { success: true };
          }
          if (/^INSERT OR REPLACE/.test(sql)) {
            const [key, body, size] = this.params;
            rows.set(key, { body, size });
            return { success: true, meta: { changes: 1 } };
          }
          if (/^DELETE/.test(sql)) {
            const existed = rows.has(this.params[0]);
            rows.delete(this.params[0]);
            return { success: true, meta: { changes: existed ? 1 : 0 } };
          }
          return { success: true };
        },
        async all() { return { results: [] }; },
      };
      return stmt;
    },
  };
}

test('storage d1 blob store: put/get/exists/delete (one row per object)', async () => {
  const d1 = mockD1();
  const s = createStorage({ d1 });
  assert.equal(s.kind, 'd1');
  assert.equal(await s.put('a/b.txt', 'hello'), true);
  assert.equal(await s.getText('a/b.txt'), 'hello');
  assert.equal(await s.exists('a/b.txt'), true);
  assert.equal(s.url('a/b.txt'), '/storage/a/b.txt');
  assert.equal(await s.delete('a/b.txt'), true);
  assert.equal(await s.exists('a/b.txt'), false);
  // Laravel: false when the file was missing; a missing file is not null on get.
  assert.equal(await s.delete('a/b.txt'), false);
  await assert.rejects(() => s.getText('a/b.txt'), /does not exist/);
});

test('storage d1 blob store: the table is created once per binding, not per request', async () => {
  const d1 = mockD1();
  const s = createStorage({ d1 });
  await s.put('k', 'v');
  await s.get('k');
  await s.exists('k');
  assert.equal(d1.state.created, 1, 'the CREATE TABLE ran more than once');
  assert.ok(d1.state.tables.has('lw_blobs'));
});

test('storage d1 blob store: an object over the D1 row limit fails loud', async () => {
  const d1 = mockD1();
  const s = createStorage({ d1 });
  await assert.rejects(() => s.put('big', 'x'.repeat(1500001)), /at most 1500000 bytes/);
});

test('storage: r2 wins over d1 when the app binds both', async () => {
  const m = new Map();
  const r2 = { async put(k,v){ m.set(k,v); }, async get(k){ const v=m.get(k); return v===undefined?null:{ body: v }; }, async delete(k){ m.delete(k); } };
  const s = createStorage({ r2, d1: mockD1() });
  assert.equal(s.kind, 'r2');
  assert.equal(s.url('x'), '/r2/x');
});

// scheduler — cron
test('the dumped schedule: dueEvents picks the events that fire now', async () => {
  const { dueEvents, cronMatches } = await import('../scheduler.mjs');
  const events = [
    { name: 'posts:prune', expression: '*/5 * * * *', command: 'posts:prune', timezone: 'UTC' },
    { name: 'inspire', expression: '0 9 * * *', command: 'inspire', timezone: 'UTC' },
    { name: 'broken', expression: '', command: 'x' },
  ];
  assert.equal(cronMatches('*/5 * * * *', new Date('2026-10-18T12:15:00Z')), true);
  assert.equal(cronMatches('*/5 * * * *', new Date('2026-10-18T12:16:00Z')), false);
  const due = dueEvents(events, new Date('2026-10-18T12:15:00Z'));
  assert.equal(due.length, 1);
  assert.equal(due[0].name, 'posts:prune');
  // An event without an expression is never due (and never throws).
  assert.equal(dueEvents([{ name: 'x' }], new Date('2026-10-18T12:15:00Z')).length, 0);
  // A broken expression is skipped, not fatal.
  assert.equal(dueEvents([{ name: 'y', expression: 'not a cron' }], new Date('2026-10-18T12:15:00Z')).length, 0);
});
test('scheduler every minute', async () => {
  const s = defineSchedule(api => { api.call('a', '* * * * *', async()=>{}); });
  const d = new Date('2026-10-18T12:34:00Z');
  assert.equal(s._match(d, '* * * * *'), true);
  const r = s.run(d);
  assert.equal(r.due.length, 1);
});
test('scheduler minute step', async () => {
  const s = defineSchedule(api => { api.call('a', '*/15 * * * *', async()=>{}); });
  assert.equal(s._match(new Date('2026-10-18T12:15:00Z'), '*/15 * * * *'), true);
  assert.equal(s._match(new Date('2026-10-18T12:16:00Z'), '*/15 * * * *'), false);
});
test('scheduler hour and dow', async () => {
  assert.equal(defineSchedule(()=>{})._match(new Date('2026-10-18T09:00:00Z'), '0 9 * * *'), true);
  assert.equal(defineSchedule(()=>{})._match(new Date('2026-10-18T09:00:00Z'), '0 10 * * *'), false);
  // 2026-10-18 is Sunday (0)
  assert.equal(defineSchedule(()=>{})._match(new Date('2026-10-18T00:00:00Z'), '* * * * 0'), true);
  assert.equal(defineSchedule(()=>{})._match(new Date('2026-10-18T00:00:00Z'), '* * * * 7'), true);
  assert.equal(defineSchedule(()=>{})._match(new Date('2026-10-18T00:00:00Z'), '* * * * 1'), false);
});
test('scheduler list and range', async () => {
  assert.equal(defineSchedule(()=>{})._match(new Date('2026-10-18T12:01:00Z'), '0,15,30 * * * *'), false);
  assert.equal(defineSchedule(()=>{})._match(new Date('2026-10-18T12:15:00Z'), '0,15,30 * * * *'), true);
  assert.equal(defineSchedule(()=>{})._match(new Date('2026-10-18T12:07:00Z'), '5-10 * * * *'), true);
  assert.equal(defineSchedule(()=>{})._match(new Date('2026-10-18T12:11:00Z'), '5-10 * * * *'), false);
});
test('scheduler month names', async () => {
  assert.equal(defineSchedule(()=>{})._match(new Date('2026-01-01T00:00:00Z'), '* * * jan *'), true);
  assert.equal(defineSchedule(()=>{})._match(new Date('2026-02-01T00:00:00Z'), '* * * jan *'), false);
});
test('scheduler exec runs handlers', async () => {
  let ran = 0;
  const s = defineSchedule(api => { api.call('a', '* * * * *', async()=>{ ran++; }); });
  const r = s.run(new Date());
  await r.exec();
  assert.equal(ran, 1);
});

// scheduler — timezone
test('scheduler tz matches in zone not utc', async () => {
  const d = new Date('2026-10-18T00:00:00Z'); // 07:00 Asia/Jakarta
  assert.equal(defineSchedule(()=>{})._match(d, '0 7 * * *', 'Asia/Jakarta'), true);
  assert.equal(defineSchedule(()=>{})._match(d, '0 0 * * *', 'Asia/Jakarta'), false);
  assert.equal(defineSchedule(()=>{})._match(d, '0 0 * * *'), true);
});
test('scheduler tz invalid throws', async () => {
  assert.throws(() => defineSchedule(()=>{})._match(new Date(), '* * * * *', 'Nope/Zone'), Error);
});

// queue — delay
test('queue delay not popped before availableAt', async () => {
  const q = createQueue({});
  await q.push('q', { v: 1 }, { delayMs: 20 });
  assert.equal(await q.pop('q'), null);
  await new Promise(r => setTimeout(r, 25));
  const j = await q.pop('q');
  assert.equal(j.payload.v, 1);
});
// queue — retry/backoff then failed
test('queue retry backoff then failed', async () => {
  const q = createQueue({});
  await q.push('q', { v: 1 }, { tries: 2, backoffMs: 0 });
  const j1 = await q.pop('q');
  await q.fail('q', j1);
  const j2 = await q.pop('q');
  assert.equal(j2.attempts, 1);
  await q.fail(j2);
  assert.equal(await q.pop('q'), null);
  const failed = await q.failed('q');
  assert.equal(failed.length, 1);
});

// cache — tags
test('cache tags put/flush isolation', async () => {
  const c = createCache({});
  const t = c.tags(['tag1']);
  await t.put('k1', 'v1');
  await c.put('k2', 'v2');
  assert.equal(await t.get('k1'), 'v1');
  await t.flush();
  assert.equal(await t.get('k1'), null);
  assert.equal(await c.get('k2'), 'v2');
});
test('cache tags empty throws', async () => {
  const c = createCache({});
  assert.throws(() => c.tags([]), Error);
});

// storage — temporary url
test('storage temporaryUrl sign verify', async () => {
  const s = createStorage({ secret: 'sec' });
  const url = await s.temporaryUrl('a/b.txt', 10000);
  assert.equal(await s.verifyTemporaryUrl(url), true);
  const tampered = url.replace(/sig=[a-f0-9]+/, 'sig=deadbeef');
  assert.equal(await s.verifyTemporaryUrl(tampered, 'sec'), false);
});
test('storage temporaryUrl expired', async () => {
  const s = createStorage({});
  const url = await s.temporaryUrl('k', 0, { secret: 'sec' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(await s.verifyTemporaryUrl(url, 'sec'), false);
});
test('storage temporaryUrl missing secret throws', async () => {
  const s = createStorage({});
  await assert.rejects(() => s.temporaryUrl('k', 1000), Error);
});


