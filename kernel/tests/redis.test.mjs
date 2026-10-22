// kernel/tests/redis.test.mjs — the D1-backed Redis store at the edge.
//
// Ground truth: Illuminate\Cache\RedisStore (the vendored Laravel 13), probed
// line by line:
//   - put()/setex(): `(int) max(1, $seconds)` - a ttl of 0 or less means ONE
//     second, not "forever" and not "delete" (RedisStore.php:135-136, :168-169)
//     - deliberately different from DatabaseStore, where a non-positive ttl
//     forgets the key (Cache/Repository.php:367-380);
//   - ttl(): Redis's own answers - -2 when the key is absent, -1 when it has no
//     expiry, else the remaining seconds;
//   - increment()/decrement() are incrby/decrby (:204-219);
//   - the commands that need a real server (publish/subscribe/xadd/eval/
//     pipeline) are refused, never silently degraded.
//
// The D1 handle is a small in-memory stub: the test is deterministic and runs
// no PHP.

import test from 'node:test';
import assert from 'node:assert/strict';

import { RedisStore, RedisUnsupportedError, LW_REDIS_SCHEMA } from '../redis.mjs';

// A tiny D1 stub: `prepare(sql).bind(...).run()/first()/all()` over a Map.
// The store reads through `.all()` (a SELECT) and writes through `.run()`.
function makeDb(now) {
  const rows = new Map();
  const clock = now || (() => Date.now());
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
            const [key, value, expiration] = stmt.args;
            rows.set(key, { value, expiration });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE/i.test(sql)) {
            const [expiration, key] = stmt.args;
            const row = rows.get(key);
            if (!row) return { meta: { changes: 0 } };
            row.expiration = expiration;
            return { meta: { changes: 1 } };
          }
          if (/DELETE FROM/i.test(sql)) {
            const [key] = stmt.args;
            const had = rows.delete(key);
            return { meta: { changes: had ? 1 : 0 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          const [key] = stmt.args;
          const row = rows.get(key);
          if (!row) return null;
          if (row.expiration !== null && row.expiration <= clock()) {
            rows.delete(key);
            return null;
          }
          return { value: row.value, expiration: row.expiration };
        },
        async all() {
          if (!/SELECT/i.test(sql)) return { results: [] };
          const [key] = stmt.args;
          const row = rows.get(key);
          if (!row) return { results: [] };
          if (row.expiration !== null && row.expiration <= clock()) {
            rows.delete(key);
            return { results: [] };
          }
          return { results: [{ value: row.value, expiration: row.expiration }] };
        },
      };
      return stmt;
    },
    async exec() {
      return { meta: { changes: 0 } };
    },
  };
  return db;
}

test('the schema is the store\'s own D1 table', () => {
  assert.match(LW_REDIS_SCHEMA, /CREATE TABLE IF NOT EXISTS lw_redis/);
});

test('set/get/del/exists round trip', async () => {
  const store = new RedisStore(makeDb());
  assert.equal(await store.set('a', 'one'), true);
  assert.equal(await store.get('a'), 'one');
  // Redis answers 1/0 for EXISTS and DEL, not booleans.
  assert.equal(await store.exists('a'), 1);
  assert.equal(await store.del('a'), 1);
  assert.equal(await store.get('a'), null);
  assert.equal(await store.exists('a'), 0);
  // Redis's del answers 0 for a key that is not there.
  assert.equal(await store.del('a'), 0);
});

test('a ttl of 0 (or less) is ONE second, exactly like RedisStore::setex', async () => {
  // RedisStore.php:135-136: `(int) max(1, $seconds)`. A ttl of 0 does NOT mean
  // "forever" (that is a null ttl) and does NOT delete the key.
  const db = makeDb();
  const store = new RedisStore(db);
  await store.set('k', 'v', 0);
  const row = db.rows.get('k');
  assert.ok(row, 'the key exists');
  const life = row.expiration - Date.now();
  assert.ok(life <= 1000 && life > 0, 'the expiry is about one second away, got ' + life);
  // A null ttl is the forever() path: no expiry.
  await store.set('forever', 'v', null);
  assert.equal(db.rows.get('forever').expiration, null);
});

test('ttl answers -2 (absent), -1 (no expiry) and the remaining seconds', async () => {
  const store = new RedisStore(makeDb());
  assert.equal(await store.ttl('nope'), -2);
  await store.set('forever', 'v', null);
  assert.equal(await store.ttl('forever'), -1);
  await store.set('short', 'v', 30);
  const ttl = await store.ttl('short');
  assert.ok(ttl > 25 && ttl <= 30, 'the remaining seconds, got ' + ttl);
  // An EXPIRED key answers -2 (Redis reaps it on read).
  const expired = new RedisStore(makeDb(() => Date.now() + 60000));
  await expired.set('gone', 'v', 1);
  assert.equal(await expired.ttl('gone'), -2);
});

test('incr/decr are incrby/decrby (RedisStore.php:204-219)', async () => {
  const store = new RedisStore(makeDb());
  // A missing key starts at 0, so the first incr answers 1 (Redis's INCR).
  assert.equal(await store.incr('n'), 1);
  assert.equal(await store.incr('n', 5), 6);
  assert.equal(await store.decr('n', 2), 4);
  assert.equal(await store.get('n'), 4);
});

test('expire() sets the expiry; a non-positive ttl clamps to one second', async () => {
  const db = makeDb();
  const store = new RedisStore(db);
  await store.set('k', 'v', null);
  // Redis answers 1 when the key existed, 0 when it did not.
  assert.equal(await store.expire('k', 60), 1);
  const ttl = await store.ttl('k');
  assert.ok(ttl > 55 && ttl <= 60, 'got ' + ttl);
  // RedisStore::setex clamps: max(1, $seconds) (:277 for expire).
  assert.equal(await store.expire('k', 0), 1);
  // A non-positive ttl DELETES the key (Redis's own EXPIRE semantics), so the
  // next ttl answers -2 - not the RedisStore::setex clamp (that is set()).
  assert.equal(await store.ttl('k'), -2);
});

test('the server-only commands are refused loudly', () => {
  const store = new RedisStore(makeDb());
  // A D1 row is not a Redis server: pub/sub, the streams, Lua and the
  // pipelines/transactions cannot be reproduced, so they throw with a reason
  // instead of returning a plausible empty answer.
  for (const command of ['publish', 'subscribe', 'xadd', 'eval', 'pipeline']) {
    assert.throws(
      () => store[command]('a'),
      (err) => {
        assert.ok(err instanceof RedisUnsupportedError, command + ' must throw RedisUnsupportedError');
        assert.ok(err.message.length > 20, command + ' must carry a reason');
        return true;
      },
      command
    );
  }
});
