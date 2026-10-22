// compiler/tests/queue.test.mjs — the queue producer + the cron consumer (M63).
//
// Laravel's `database` queue driver writes a row into `jobs` and a worker
// consumes it later (Illuminate/Queue/DatabaseQueue.php); the `sync` driver
// runs the job inline. A Worker has no long-lived queue process, so the edge
// writes `lw_jobs` and the CRON TRIGGER drains it — the job runs AFTER the
// response, which is the `database` behaviour, and the build refuses a push
// when the worker has no cron trigger (build.mjs).
//
// What this pins:
//   - `rt.queuePush(fqcn, args)` writes ONE row with the arguments as JSON;
//   - `rt.queueDrain(db, handlers)` builds the class with those arguments,
//     calls `handle()` with the constructor's properties reachable through
//     `this`, then DELETES the row (a row that stayed would run forever);
//   - a job that throws is retried up to three attempts and then dropped (a
//     row that never succeeds must not block the queue);
//   - an unknown job class is dropped, not retried forever.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRt } from '../runtime/rt-from-context.mjs';

// A tiny D1 stub over an array of rows: the statements the queue issues.
function makeDb() {
  const rows = [];
  let nextId = 1;
  const db = {
    rows,
    prepare(sql) {
      const stmt = {
        args: [],
        bind(...args) {
          stmt.args = args;
          return stmt;
        },
        async run() {
          if (/CREATE TABLE/i.test(sql)) return { meta: { changes: 0 } };
          if (/INSERT INTO/i.test(sql)) {
            const [job, payload, availableAt, createdAt] = stmt.args;
            const id = nextId++;
            rows.push({ id, job, payload, attempts: 0, available_at: availableAt, created_at: createdAt });
            return { meta: { changes: 1, last_row_id: id } };
          }
          if (/DELETE FROM/i.test(sql)) {
            const [id] = stmt.args;
            const at = rows.findIndex((r) => r.id === id);
            if (at === -1) return { meta: { changes: 0 } };
            rows.splice(at, 1);
            return { meta: { changes: 1 } };
          }
          if (/UPDATE/i.test(sql)) {
            const [attempts, availableAt, id] = stmt.args;
            const row = rows.find((r) => r.id === id);
            if (!row) return { meta: { changes: 0 } };
            row.attempts = attempts;
            row.available_at = availableAt;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (/SELECT 1 FROM/i.test(sql)) return { 1: 1 };
          return null;
        },
        async all() {
          if (!/SELECT/i.test(sql)) return { results: [] };
          const [availableAt, limit] = stmt.args;
          const due = rows.filter((r) => r.available_at <= availableAt).slice(0, limit);
          return { results: due.map((r) => ({ ...r })) };
        },
      };
      return stmt;
    },
  };
  return db;
}

test('a push writes one row and the drain runs the job, then deletes it', async () => {
  const db = makeDb();
  const rt = buildRt(null, { strict: false, runtime: true, db });
  const seen = [];
  const handlers = {
    'App\\Jobs\\SendWelcomeNote': {
      build: async (runtime, args) => {
        const instance = { note: args[0] };
        instance.handle = async function () {
          seen.push(this.note);
        };
        return instance;
      },
    },
  };
  const id = await rt.queuePush('App\\Jobs\\SendWelcomeNote', ['hello']);
  assert.equal(id, 1);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].job, 'App\\Jobs\\SendWelcomeNote');
  assert.equal(db.rows[0].payload, JSON.stringify(['hello']));

  const out = await rt.queueDrain(db, handlers);
  assert.deepEqual(out, { ran: 1, failed: 0 });
  assert.deepEqual(seen, ['hello'], 'handle() ran with the constructor argument');
  assert.equal(db.rows.length, 0, 'the row is deleted once it ran');
});

test('a failing job is retried and then dropped (it must not block the queue)', async () => {
  const db = makeDb();
  const rt = buildRt(null, { strict: false, runtime: true, db });
  let calls = 0;
  const handlers = {
    'App\\Jobs\\Broken': {
      build: async () => ({
        handle: async () => {
          calls++;
          throw new Error('boom');
        },
      }),
    },
  };
  await rt.queuePush('App\\Jobs\\Broken', []);
  // Three drains: the first two leave the row (attempts 1, 2), the third drops it.
  await rt.queueDrain(db, handlers);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].attempts, 1);
  await rt.queueDrain(db, handlers);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].attempts, 2);
  await rt.queueDrain(db, handlers);
  assert.equal(db.rows.length, 0, 'the third failure drops the row');
  assert.equal(calls, 3);
});

test('an unknown job class is dropped, not retried forever', async () => {
  const db = makeDb();
  const rt = buildRt(null, { strict: false, runtime: true, db });
  await rt.queuePush('App\\Jobs\\Gone', []);
  const out = await rt.queueDrain(db, {});
  assert.deepEqual(out, { ran: 0, failed: 1 });
  assert.equal(db.rows.length, 0);
});

test('a push without a database binding fails loud', async () => {
  const rt = buildRt(null, { strict: false, runtime: true, db: null });
  await assert.rejects(() => rt.queuePush('App\\Jobs\\X', []), /no database binding/);
});
