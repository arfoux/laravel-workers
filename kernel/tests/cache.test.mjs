// kernel/tests/cache.test.mjs — D1-backed `database` cache store parity vs PHP 8.3.
//
// Drives the identical tagged op sequence through:
//   - tools/php-cache-oracle.php  (Illuminate\Cache\DatabaseStore on SQLite), and
//   - DatabaseCacheStore          (kernel/cache.mjs on a D1-shaped node:sqlite),
// and asserts both the per-op return values and the raw `cache` rows match 1:1.
//
// Covers the methods the compiled rung's RateLimiter + Cache facade call:
// get / has / put / add / forever / increment / decrement / forget / touch / flush,
// plus expiration (read-then-delete) and the SQLite NUL -> base64 serialization rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DatabaseCacheStore } from '../cache.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const oraclePath = path.resolve(testsDir, '..', '..', 'tools', 'php-cache-oracle.php');
const PHP = process.env.PHP_BIN || 'php';
const APP_ROOT =
  process.env.LW_LARAVEL_APP ||
  'C:\\Users\\HP\\AppData\\Local\\Temp\\opencode\\lw-fresh-e2e\\fresh-app';

const PREFIX = 'laravel-cache-';
const NOW = 1792336827; // Sun, 18 Oct 2026 15:20:27 GMT

/** PHP value -> tagged JSON */
function enc(value) {
  if (value === null) return { t: 'null' };
  if (typeof value === 'boolean') return { t: 'bool', v: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { t: 'int', v: value } : { t: 'float', v: value };
  if (typeof value === 'string') return { t: 'str', v: value };
  if (Array.isArray(value)) return { t: 'array', v: value.map(enc) };
  const out = {};
  for (const k of Object.keys(value)) out[k] = enc(value[k]);
  return { t: 'array', v: out };
}

/** tagged JSON -> PHP value */
function dec(tagged) {
  if (tagged === null) return null;
  switch (tagged.t) {
    case 'int':
    case 'float':
      return Number(tagged.v);
    case 'str':
      return String(tagged.v);
    case 'bool':
      return Boolean(tagged.v);
    case 'null':
      return null;
    case 'array': {
      const src = tagged.v;
      if (Array.isArray(src)) return src.map(dec);
      const out = {};
      for (const k of Object.keys(src)) out[k] = dec(src[k]);
      return out;
    }
    default:
      throw new Error('unknown tag ' + tagged.t);
  }
}

function taggedEqual(a, b, msg) {
  assert.deepEqual(a, b, msg);
}

// Minimal D1-shaped wrapper over node:sqlite.
function d1(sqlite) {
  return {
    prepare(sql) {
      let params = [];
      return {
        bind(...p) {
          params = p;
          return this;
        },
        async all() {
          const st = sqlite.prepare(sql);
          const rows = params.length ? st.all(...params) : st.all();
          return { results: rows.map((r) => ({ ...r })) };
        },
        async first() {
          const st = sqlite.prepare(sql);
          const row = params.length ? st.get(...params) : st.get();
          return row ? { ...row } : null;
        },
        async run() {
          const st = sqlite.prepare(sql);
          const info = params.length ? st.run(...params) : st.run();
          return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid ?? 0) } };
        },
      };
    },
  };
}

function makeSqlite() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE cache (
      "key" TEXT PRIMARY KEY,
      "value" TEXT NOT NULL,
      "expiration" INTEGER NOT NULL
    );
    CREATE TABLE cache_locks (
      "key" TEXT PRIMARY KEY,
      "owner" TEXT NOT NULL,
      "expiration" INTEGER NOT NULL
    );
  `);
  return sqlite;
}

function readRows(sqlite) {
  return sqlite.prepare('SELECT "key", "value", "expiration" FROM cache ORDER BY "key"').all().map((r) => ({
    key: r.key,
    value: r.value,
    expiration: Number(r.expiration),
  }));
}

// The identical sequence both sides run.
const OPS = [
  { op: 'put', key: 'alpha', value: enc('plain string'), seconds: 3600 },
  { op: 'put', key: 'num', value: enc(42), seconds: 3600 },
  { op: 'put', key: 'flt', value: enc(1.5), seconds: 3600 },
  { op: 'put', key: 'arr', value: enc({ a: 1, b: { c: [1, 2, 3] } }), seconds: 3600 },
  { op: 'put', key: 'nul', value: enc('x\u0000y'), seconds: 3600 },
  { op: 'forever', key: 'ever', value: enc('kept') },
  { op: 'add', key: 'alpha', value: enc('other'), seconds: 3600 }, // false (exists)
  { op: 'add', key: 'fresh', value: enc('v'), seconds: 3600 }, // true
  { op: 'get', key: 'alpha' },
  { op: 'get', key: 'num' },
  { op: 'get', key: 'flt' },
  { op: 'get', key: 'arr' },
  { op: 'get', key: 'nul' },
  { op: 'get', key: 'missing' },
  { op: 'get', key: 'missing', default: enc('DEF') },
  { op: 'has', key: 'num' },
  { op: 'has', key: 'missing' },
  { op: 'increment', key: 'num', amount: 8 }, // 50
  { op: 'decrement', key: 'num', amount: 3 }, // 47
  { op: 'increment', key: 'nope' }, // false (missing)
  { op: 'put', key: 'short', value: enc('v'), seconds: 10 },
  { op: 'advance', seconds: 11 },
  { op: 'get', key: 'short' }, // null + row deleted
  { op: 'touch', key: 'ever', seconds: 100 },
  { op: 'forget', key: 'fresh' },
  { op: 'rows' },
  { op: 'flush' },
  { op: 'put', key: 'after', value: enc('post-flush'), seconds: 60 },
  { op: 'rows' },
];

async function runJs() {
  const sqlite = makeSqlite();
  let now = NOW;
  const store = new DatabaseCacheStore(d1(sqlite), {
    table: 'cache',
    prefix: PREFIX,
    lockTable: 'cache_locks',
    clock: () => now,
  });

  const results = [];
  for (const op of OPS) {
    switch (op.op) {
      case 'put':
        results.push(enc(await store.put(op.key, dec(op.value), op.seconds)));
        break;
      case 'add':
        results.push(enc(await store.add(op.key, dec(op.value), op.seconds)));
        break;
      case 'forever':
        results.push(enc(await store.forever(op.key, dec(op.value))));
        break;
      case 'get':
        results.push(enc(await store.get(op.key, 'default' in op ? dec(op.default) : null)));
        break;
      case 'has':
        results.push(enc(await store.has(op.key)));
        break;
      case 'increment':
        results.push(enc(await store.increment(op.key, op.amount ?? 1)));
        break;
      case 'decrement':
        results.push(enc(await store.decrement(op.key, op.amount ?? 1)));
        break;
      case 'forget':
        results.push(enc(await store.forget(op.key)));
        break;
      case 'touch':
        results.push(enc(await store.touch(op.key, op.seconds)));
        break;
      case 'flush':
        results.push(enc(await store.flush()));
        break;
      case 'advance':
        now += Number(op.seconds);
        results.push(enc(now));
        break;
      case 'rows':
        results.push(enc(readRows(sqlite)));
        break;
      default:
        throw new Error('unknown op ' + op.op);
    }
  }
  return { results, rows: readRows(sqlite) };
}

function runOracle() {
  if (!existsSync(path.join(APP_ROOT, 'vendor', 'autoload.php'))) {
    throw new Error(
      `cache.test: no Laravel app at ${APP_ROOT} (vendor/autoload.php missing). ` +
        'Point LW_LARAVEL_APP at a Laravel 11+/13.x app to run PHP parity tests.'
    );
  }
  const res = spawnSync(PHP, [oraclePath], {
    input: JSON.stringify({ app_root: APP_ROOT, prefix: PREFIX, now: NOW, ops: OPS }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`PHP oracle failed to start (${res.error.message}). Install PHP 8.3 or set PHP_BIN.`);
  }
  if (res.status !== 0) {
    throw new Error(`PHP oracle exited ${res.status}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

test('DatabaseCacheStore: op results + raw cache rows match PHP 8.3 1:1', async () => {
  const js = await runJs();
  const php = runOracle();
  assert.equal(js.results.length, php.results.length, 'op count');
  for (let i = 0; i < js.results.length; i++) {
    taggedEqual(js.results[i], php.results[i], `op #${i} ${OPS[i].op} ${OPS[i].key || ''}`);
  }
  assert.deepEqual(js.rows, php.rows, 'final cache rows');
});

test('DatabaseCacheStore: get(key, default) returns the default on miss', async () => {
  const sqlite = makeSqlite();
  const store = new DatabaseCacheStore(d1(sqlite), { table: 'cache', prefix: PREFIX, clock: () => NOW });
  assert.equal(await store.get('nope'), null);
  assert.equal(await store.get('nope', 7), 7);
  assert.equal(await store.get('nope', 'x'), 'x');
});

test('DatabaseCacheStore: requires a D1 binding', () => {
  assert.throws(() => new DatabaseCacheStore(null), /D1 binding/);
  assert.throws(() => new DatabaseCacheStore({}), /D1 binding/);
});

test('DatabaseCacheStore: increment clamps PHP int cast (string current)', async () => {
  const sqlite = makeSqlite();
  const store = new DatabaseCacheStore(d1(sqlite), { table: 'cache', prefix: PREFIX, clock: () => NOW });
  await store.put('s', 'not numeric', 60);
  assert.equal(await store.increment('s', 1), false);
  assert.equal(await store.get('s'), 'not numeric');
});

test('DatabaseCacheStore: prefix is applied inside the store', async () => {
  const sqlite = makeSqlite();
  const store = new DatabaseCacheStore(d1(sqlite), { table: 'cache', prefix: PREFIX, clock: () => NOW });
  await store.put('k', 'v', 60);
  const rows = readRows(sqlite);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, PREFIX + 'k');
});
