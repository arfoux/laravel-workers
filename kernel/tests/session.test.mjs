// kernel/tests/session.test.mjs — session layer parity vs PHP 8.3 oracle.
//
// Spawns tools/php-session-oracle.php against a real Laravel app (set
// LW_LARAVEL_APP, or the dev-machine default) and proves:
//   - Store semantics: per-op Store::all() bytes, ids, tokens, return values
//   - save() payload bytes for session.serialization=json and =php
//   - read-from-handler identity (payload -> start() -> save())
//   - cookie driver envelopes ({data,expires}), CookieJar queueing and
//     Symfony Cookie::__toString() bytes
//   - id validation (setId keep-or-regenerate) against PHP
//   - D1 DatabaseSessionHandler SQL/exists/expiry behaviour (mock D1)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PhpSessionStore,
  CookieJar,
  CookieSessionHandler,
  DatabaseSessionHandler,
  SESSION_ID_LENGTH,
  isValidSessionId,
  phpRandomString,
} from '../session.mjs';
import { phpJsonEncode } from '../php-json.mjs';
import { serializeCookie } from '../cookies.mjs';
import { oracleAppRoot, oracleSkip } from './oracle-app.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const oraclePath = path.resolve(testsDir, '..', '..', 'tools', 'php-session-oracle.php');
const PHP = process.env.PHP_BIN || 'php';
const APP_ROOT = oracleAppRoot();
// The PHP oracle parity tests need a real Laravel app (PHP 8.3 + vendor/).
// Without one they SKIP (the CI `test` job has no app; the `e2e` job points
// LW_LARAVEL_APP at the app it creates and runs them for real).
const noApp = APP_ROOT ? false : oracleSkip('session.test.mjs');

const FIXED_ID = 'a1'.repeat(20); // 40 chars, alnum
const NOW = Math.floor(Date.now() / 1000);

function runOracle(payload, { requireApp = true } = {}) {
  if (requireApp && !APP_ROOT || !existsSync(path.join(APP_ROOT, 'vendor', 'autoload.php'))) {
    throw new Error(oracleSkip('session.test.mjs'));
  }
  const res = spawnSync(PHP, [oraclePath], {
    input: JSON.stringify({ app_root: APP_ROOT, ...payload }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(
      `PHP oracle failed to start (${res.error.message}). Install PHP 8.3 or set PHP_BIN.`
    );
  }
  if (res.status !== 0) {
    throw new Error(`PHP oracle exited ${res.status}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

class RecordingHandler {
  constructor(data = '') {
    this.data = data;
    this.writes = [];
    this.destroys = [];
  }
  async read() {
    return this.data;
  }
  async write(id, payload) {
    this.writes.push([id, payload]);
    return true;
  }
  async destroy(id) {
    this.destroys.push(id);
    return true;
  }
  async gc() {
    return 0;
  }
}

/** Mirrors the op dispatch table in tools/php-session-oracle.php.
 *  Op format is flat: [name, ...args]; array-arg ops pass one array. */
function applyJsOp(store, [op, ...args]) {
  switch (op) {
    case 'get':
      return { hasRet: true, ret: store.get(...args) };
    case 'put':
      store.put(...args);
      return { hasRet: false };
    case 'putAll':
      store.put(args[0]);
      return { hasRet: false };
    case 'pull':
      return { hasRet: true, ret: store.pull(...args) };
    case 'remove':
      return { hasRet: true, ret: store.remove(...args) };
    case 'push':
      store.push(...args);
      return { hasRet: false };
    case 'increment':
      return { hasRet: true, ret: store.increment(...args) };
    case 'decrement':
      return { hasRet: true, ret: store.decrement(...args) };
    case 'flash':
      store.flash(...args);
      return { hasRet: false };
    case 'now':
      store.now(...args);
      return { hasRet: false };
    case 'reflash':
      store.reflash();
      return { hasRet: false };
    case 'keep':
      store.keep(...args);
      return { hasRet: false };
    case 'ageFlashData':
      store.ageFlashData();
      return { hasRet: false };
    case 'flashInput':
      store.flashInput(args[0]);
      return { hasRet: false };
    case 'forget':
      store.forget(args[0]);
      return { hasRet: false };
    case 'flush':
      store.flush();
      return { hasRet: false };
    case 'replace':
      store.replace(args[0]);
      return { hasRet: false };
    case 'has':
      return { hasRet: true, ret: store.has(...args) };
    case 'exists':
      return { hasRet: true, ret: store.exists(...args) };
    case 'missing':
      return { hasRet: true, ret: store.missing(...args) };
    case 'hasAny':
      return { hasRet: true, ret: store.hasAny(...args) };
    case 'only':
      return { hasRet: true, ret: store.only(args[0]) };
    case 'except':
      return { hasRet: true, ret: store.except(args[0]) };
    case 'hasOldInput':
      return { hasRet: true, ret: store.hasOldInput(...args) };
    case 'getOldInput':
      return { hasRet: true, ret: store.getOldInput(...args) };
    case 'token':
      return { hasRet: true, ret: store.token() };
    case 'regenerateToken':
      store.regenerateToken();
      return { hasRet: false };
    case 'getId':
      return { hasRet: true, ret: store.getId() };
    case 'setId':
      store.setId(args[0]);
      return { hasRet: false };
    case 'setPreviousUrl':
      store.setPreviousUrl(args[0]);
      return { hasRet: false };
    case 'setPreviousRoute':
      store.setPreviousRoute(args[0]);
      return { hasRet: false };
    case 'previousUrl':
      return { hasRet: true, ret: store.previousUrl() };
    case 'previousRoute':
      return { hasRet: true, ret: store.previousRoute() };
    default:
      throw new Error(`applyJsOp: unknown op ${op}`);
  }
}

/** Compare the JS store against the oracle's recorded state after one op. */
function assertStep(store, oracle, i, op, ret) {
  const step = oracle.results[i];
  const label = `step ${i} (${op[0]})`;
  assert.equal(phpJsonEncode(store.attributes), step.all, `${label}: all() bytes`);
  assert.equal(store.getId(), step.id, `${label}: id`);
  assert.equal(store.isStarted(), step.started, `${label}: started`);
  if (step.has_ret) {
    assert.equal(phpJsonEncode(ret.ret), step.ret, `${label}: return value`);
  } else {
    assert.equal(ret.hasRet, false, `${label}: JS op unexpectedly returned a value`);
  }
}

// The big deterministic op script: dot-notation, gapped flash arrays
// (array_diff/array_merge/array_unique shapes), duplicate flashes, old input,
// previous URL/route, scalar-overwrite via put('key.sub').
const STORE_OPS = [
  ['get', 'known'],
  ['get', 'known', 'D'],
  ['get', 'missing.key'],
  ['get', 'missing.key', 'DEF'],
  ['put', 'user.name', 'Ada'],
  ['get', 'user.name'],
  ['get', 'user'],
  ['put', 'user.age', 30],
  ['get', 'user.age'],
  ['push', 'tags', 'x'],
  ['push', 'tags', 'y'],
  ['get', 'tags'],
  ['increment', 'count'],
  ['increment', 'count', 5],
  ['decrement', 'count', 2],
  ['get', 'count'],
  ['put', 'strnum', '5'],
  ['increment', 'strnum'],
  ['put', 'nullval', null],
  ['has', 'nullval'],
  ['exists', 'nullval'],
  ['has', 'known', 'count'],
  ['has', 'known', 'nope'],
  ['exists', 'known', 'user.name'],
  ['exists', 'known', 'user.nope'],
  ['missing', 'nope'],
  ['hasAny', 'nope', 'known'],
  ['hasAny', 'nope', 'nope2'],
  ['only', ['known', 'count']],
  ['except', ['known', 'count']],
  ['put', 'user2', 'scalar'],
  ['get', 'user2'],
  ['put', 'user2.deep', 5],
  ['get', 'user2'],
  ['putAll', { a: 1, b: 2 }],
  ['pull', 'a'],
  ['remove', 'b'],
  ['flash', 'msg', 'hi'],
  ['flash', 'msg2'],
  ['get', '_flash'],
  ['now', 'gx', 1],
  ['now', 'gy', 2],
  ['now', 'gz', 3],
  ['flash', 'gy', 'g2'],
  ['get', '_flash'],
  ['keep', ['gy']],
  ['get', '_flash'],
  ['reflash'],
  ['get', '_flash'],
  ['flash', 'dup', 1],
  ['flash', 'dup', 2],
  ['get', '_flash'],
  ['flashInput', { email: 'e@x.com', pw: 's' }],
  ['hasOldInput'],
  ['hasOldInput', 'email'],
  ['getOldInput'],
  ['getOldInput', 'email'],
  ['getOldInput', 'nope', 'D'],
  ['ageFlashData'],
  ['get', '_flash'],
  ['setPreviousUrl', 'http://localhost/a'],
  ['setPreviousRoute', null],
  ['previousUrl'],
  ['previousRoute'],
  ['setPreviousRoute', 'home'],
  ['previousRoute'],
  ['replace', { c: 3, d: 4 }],
  ['forget', ['c']],
  ['get', 'c', 'GONE'],
  ['flush'],
  ['get', 'known', 'GONE2'],
  ['put', '_token', 'T1'],
  ['flash', 'fmsg', 'hello'],
  ['now', 'fnow', 1],
  ['token'],
];

for (const serialization of ['json', 'php']) {
  test(`Store ops parity vs PHP 8.3 oracle (serialization=${serialization})`, { skip: noApp }, async () => {
    const oracle = runOracle({
      mode: 'store',
      serialization,
      id: FIXED_ID,
      seed: { _token: 'T0', known: 1 },
      ops: STORE_OPS,
      save: true,
    });

    const handler = new RecordingHandler();
    const store = new PhpSessionStore({
      name: 'laravel_session',
      handler,
      id: FIXED_ID,
      serialization,
    });
    await store.start();
    store.put({ _token: 'T0', known: 1 });

    assert.equal(oracle.results.length, STORE_OPS.length, 'oracle ran every op');
    for (let i = 0; i < STORE_OPS.length; i++) {
      assertStep(store, oracle, i, STORE_OPS[i], applyJsOp(store, STORE_OPS[i]));
    }

    await store.save();
    assert.equal(handler.writes.length, 1, 'one handler write on save');
    assert.equal(handler.writes[0][0], oracle.written_id, 'written id');
    assert.equal(handler.writes[0][1], oracle.payload, 'save() payload bytes');
    assert.equal(phpJsonEncode(store.attributes), oracle.all, 'final all() bytes');

    // Read-back identity: PHP reads its own payload, saves again.
    const oracle2 = runOracle({
      mode: 'store',
      serialization,
      id: FIXED_ID,
      seed_handler_data: oracle.payload,
      ops: [],
      save: true,
    });
    const handler2 = new RecordingHandler(oracle.payload);
    const store2 = new PhpSessionStore({
      name: 'laravel_session',
      handler: handler2,
      id: FIXED_ID,
      serialization,
    });
    await store2.start();
    await store2.save();
    assert.equal(handler2.writes[0][1], oracle2.payload, 'read->save identity payload');
  });
}

test('flash lifecycle unit: gapped PHP array shapes', async () => {
  const store = new PhpSessionStore({ handler: new RecordingHandler() });
  store.now('x', 1);
  store.now('y', 2);
  store.now('z', 3);
  store.flash('y', 9); // array_diff([x,y,z],[y]) -> keys 0,2 (gap)
  assert.equal(phpJsonEncode(store.attributes._flash.old), '{"0":"x","2":"z"}');
  store.keep(['y']);
  assert.equal(phpJsonEncode(store.attributes._flash.new), '["y"]');
  store.flash('dup', 1);
  store.flash('dup', 2); // push() appends again -> duplicate entries
  assert.equal(phpJsonEncode(store.attributes._flash.new), '["y","dup","dup"]');
  store.reflash();
  assert.equal(phpJsonEncode(store.attributes._flash.old), '[]');
  // array_unique() drops the second "dup" -> preserved-key gap at index 2.
  assert.equal(
    phpJsonEncode(store.attributes._flash.new),
    '{"0":"y","1":"dup","3":"x","4":"z"}'
  );
});

test('cookie driver: fresh session envelope + Symfony header parity', { skip: noApp }, async () => {
  const oracle = runOracle({
    mode: 'cookie',
    serialization: 'json',
    id: FIXED_ID,
    seed: { _token: 'T0', n: 7 },
    ops: [['put', 'flag', true]],
    save: true,
    lifetime: 120,
    // Freeze Carbon so the envelope expiry and the Set-Cookie attribute expiry
    // come from one exact second (PHP otherwise reads the clock twice:
    // CookieSessionHandler::write -> availableAt, CookieJar::make ->
    // availableAt). Symfony still reads native time() for Max-Age; lwCookieOut
    // reports that second as q.render_now.
    freeze_ms: NOW * 1000,
  });
  assert.equal(oracle.queue.length, 1);
  const q = oracle.queue[0];
  const env = JSON.parse(q.value);
  const jsNow = env.expires - 120 * 60; // derive PHP's clock second

  const jar = new CookieJar({ clock: () => jsNow });
  const handler = new CookieSessionHandler({ jar, minutes: 120, clock: () => jsNow });
  const store = new PhpSessionStore({ handler, id: FIXED_ID, serialization: 'json', clock: () => jsNow });
  await store.start();
  store.put({ _token: 'T0', n: 7 });
  store.put('flag', true);
  await store.save();

  const list = jar.list();
  assert.equal(list.length, 1);
  const c = list[0];
  assert.equal(c.name, FIXED_ID);
  assert.equal(c.name, q.name);
  assert.equal(c.value, q.value, 'cookie envelope bytes (data + expires)');
  assert.equal(c.expires, q.expires, 'cookie expiry timestamp');
  assert.equal(!!c.secure, q.secure);
  assert.equal(c.httpOnly, q.http_only);
  assert.equal(c.sameSite, q.same_site);
  assert.equal(c.path, q.path);
  assert.equal(c.raw, q.raw);
  // Symfony's Max-Age is `expire - time()` (native clock): render the JS
  // cookie with the same native second the oracle reported for this cookie.
  assert.equal(serializeCookie(c, q.render_now), q.header, 'Set-Cookie bytes');
  assert.equal(env.data, oracle.all, 'envelope data == phpJsonEncode(all())');
  assert.equal(phpJsonEncode(store.attributes), oracle.all, 'attributes bytes');
});

test('cookie driver: reads valid envelope and preserves token', { skip: noApp }, async () => {
  const envelope = phpJsonEncode({
    data: phpJsonEncode({ _token: 'T'.repeat(40), x: 1 }),
    expires: NOW + 100,
  });
  const oracle = runOracle({
    mode: 'cookie',
    serialization: 'json',
    id: FIXED_ID,
    request_cookie: { name: FIXED_ID, value: envelope },
    ops: [['get', 'x'], ['token']],
    save: true,
    lifetime: 120,
  });
  assert.equal(oracle.results[1].ret, JSON.stringify('T'.repeat(40)));

  const env2 = JSON.parse(oracle.queue[0].value);
  const jsNow = env2.expires - 120 * 60;
  const jar = new CookieJar({ clock: () => jsNow });
  const handler = new CookieSessionHandler({ jar, minutes: 120, clock: () => jsNow });
  handler.setRequest({ [FIXED_ID]: envelope });
  const store = new PhpSessionStore({ handler, id: FIXED_ID, serialization: 'json', clock: () => jsNow });
  await store.start();
  const readOps = [['get', 'x'], ['token']];
  for (let i = 0; i < readOps.length; i++) {
    assertStep(store, oracle, i, readOps[i], applyJsOp(store, readOps[i]));
  }
  assert.equal(store.token(), 'T'.repeat(40), 'token preserved from cookie');
  await store.save();
  assert.equal(jar.list()[0].value, oracle.queue[0].value, 're-written envelope bytes');
});

test('cookie driver: expired envelope starts a fresh session', { skip: noApp }, async () => {
  const envelope = phpJsonEncode({
    data: phpJsonEncode({ _token: 'T'.repeat(40), x: 1 }),
    expires: NOW - 10,
  });
  const oracle = runOracle({
    mode: 'cookie',
    serialization: 'json',
    id: FIXED_ID,
    request_cookie: { name: FIXED_ID, value: envelope },
    ops: [],
    save: true,
    lifetime: 120,
  });
  const oracleAll = JSON.parse(oracle.all);
  // post-save() the oracle payload also carries the aged _flash bookkeeping
  assert.deepEqual(Object.keys(oracleAll), ['_token', '_flash']);
  assert.match(oracleAll._token, /^[A-Za-z0-9]{40}$/);

  const jar = new CookieJar();
  const handler = new CookieSessionHandler({ jar, minutes: 120 });
  handler.setRequest({ [FIXED_ID]: envelope });
  const store = new PhpSessionStore({ handler, id: FIXED_ID, serialization: 'json' });
  await store.start();
  assert.deepEqual(Object.keys(store.attributes), ['_token']);
  assert.match(store.token(), /^[A-Za-z0-9]{40}$/);
  assert.notEqual(store.token(), 'T'.repeat(40));
});

test('cookie driver: invalidate destroys old id and queues deletion cookie', { skip: noApp }, async () => {
  const oracle = runOracle({
    mode: 'cookie',
    serialization: 'json',
    id: FIXED_ID,
    seed: { _token: 'T0', bye: 1 },
    ops: [['invalidate']],
    save: true,
    lifetime: 120,
    // Same deterministic-clock rationale as the fresh-envelope test above.
    freeze_ms: NOW * 1000,
  });
  assert.equal(oracle.queue.length, 2);
  const [qOld, qNew] = oracle.queue;
  assert.equal(qOld.name, FIXED_ID);
  assert.equal(qOld.value, null);
  assert.match(qNew.name, /^[A-Za-z0-9]{40}$/);
  assert.notEqual(qNew.name, FIXED_ID);

  const env2 = JSON.parse(qNew.value);
  const jsNow = env2.expires - 120 * 60;
  const jar = new CookieJar({ clock: () => jsNow });
  const handler = new CookieSessionHandler({ jar, minutes: 120, clock: () => jsNow });
  const store = new PhpSessionStore({ handler, id: FIXED_ID, serialization: 'json', clock: () => jsNow });
  await store.start();
  store.put({ _token: 'T0', bye: 1 });
  await store.invalidate();
  await store.save();

  const list = jar.list();
  assert.equal(list.length, 2);
  const [cOld, cNew] = list;
  assert.equal(cOld.name, FIXED_ID);
  assert.equal(cOld.value, null);
  assert.equal(cOld.expires, qOld.expires, 'deletion cookie expiry');
  assert.equal(serializeCookie(cOld, qOld.render_now), qOld.header, 'deletion Set-Cookie bytes');
  assert.equal(cNew.name, store.getId());
  assert.match(cNew.name, /^[A-Za-z0-9]{40}$/);
  assert.equal(cNew.value, qNew.value, 'new id envelope bytes');
  // The new id is random on both sides; normalize the name to compare bytes.
  const norm = (header) => header.replace(/^[^=]+=/, 'ID=');
  assert.equal(norm(serializeCookie(cNew, qNew.render_now)), norm(qNew.header), 'new id Set-Cookie bytes');
  assert.equal(phpJsonEncode(store.attributes), oracle.all, 'attributes after invalidate+save');
});

test('setId validation parity (40 alnum kept, everything else regenerated)', { skip: noApp }, async () => {
  const cases = [
    'b'.repeat(40), // valid
    'a'.repeat(39), // too short
    'a'.repeat(41), // too long
    'A0'.repeat(20), // valid
    'a'.repeat(39) + '-', // symbol
    'é'.repeat(40), // non-ascii
    'a'.repeat(40) + ' ', // trailing space
    'Zz9'.repeat(13) + 'q', // 40 alnum (mixed case)
  ];
  const ops = [];
  for (const c of cases) {
    ops.push(['setId', c]);
    ops.push(['getId']);
  }
  const oracle = runOracle({ mode: 'store', serialization: 'json', ops, save: false, id: null });

  const store = new PhpSessionStore({ handler: new RecordingHandler() });
  for (let i = 0; i < cases.length; i++) {
    const given = cases[i];
    store.setId(given);
    const oracleId = oracle.results[i * 2].id;
    const idAfterSet = store.getId();
    if (isValidSessionId(given)) {
      assert.equal(oracleId, given, `PHP keeps valid id ${i}`);
      assert.equal(idAfterSet, given, `JS keeps valid id ${i}`);
    } else {
      // Both sides regenerate a random 40-char alnum id; values must differ.
      assert.match(oracleId, /^[A-Za-z0-9]{40}$/, `PHP regenerates invalid id ${i}`);
      assert.notEqual(oracleId, given, `PHP drops invalid id ${i}`);
      assert.match(idAfterSet, /^[A-Za-z0-9]{40}$/, `JS regenerates invalid id ${i}`);
      assert.notEqual(idAfterSet, given, `JS drops invalid id ${i}`);
    }
    assert.equal(oracle.results[i * 2 + 1].id, oracleId, `PHP getId stable ${i}`);
    assert.equal(store.getId(), idAfterSet, `JS getId stable ${i}`);
  }
});

test('phpRandomString: Str::random shape and charset', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(phpRandomString(SESSION_ID_LENGTH), /^[A-Za-z0-9]{40}$/);
  }
  // Deterministic zero bytes: base64 of \0 is all 'A' — no strips needed.
  const zeros = (n) => new Uint8Array(n);
  assert.equal(phpRandomString(40, zeros), 'A'.repeat(40));
  // Every byte value (seeded LCG): '/' '+' '=' must never survive.
  const seeded = (seed) => (n) => {
    const out = new Uint8Array(n);
    let x = seed >>> 0;
    for (let i = 0; i < n; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      out[i] = x & 0xff;
    }
    return out;
  };
  for (let i = 0; i < 50; i++) {
    assert.match(phpRandomString(63, seeded(i + 1)), /^[A-Za-z0-9]{63}$/);
  }
});

test('isValidSessionId: ctype_alnum + length 40', () => {
  assert.equal(isValidSessionId('a'.repeat(40)), true);
  assert.equal(isValidSessionId('A0'.repeat(20)), true);
  assert.equal(isValidSessionId('a'.repeat(39)), false);
  assert.equal(isValidSessionId('a'.repeat(41)), false);
  assert.equal(isValidSessionId('a'.repeat(39) + '-'), false);
  assert.equal(isValidSessionId('é'.repeat(40)), false);
  assert.equal(isValidSessionId(''), false);
  assert.equal(isValidSessionId(null), false);
  assert.equal(isValidSessionId(123), false);
});

// ---------------------------------------------------------------------------
// DatabaseSessionHandler on a mock D1 binding.
// ---------------------------------------------------------------------------

function mockSessionsDb() {
  const rows = new Map();
  const log = [];
  return {
    rows,
    log,
    prepare(sql) {
      return {
        params: [],
        bind(...p) {
          this.params = p;
          return this;
        },
        async all() {
          log.push({ sql, params: this.params });
          if (/^SELECT/.test(sql)) {
            const row = rows.get(this.params[0]);
            return { results: row ? [row] : [] };
          }
          return { results: [] };
        },
        async first() {
          return rows.get(this.params[0]) ?? null;
        },
        async run() {
          log.push({ sql, params: this.params });
          if (/^INSERT/.test(sql)) {
            const cols = sql
              .match(/\(([^)]+)\)/)[1]
              .split(', ')
              .map((c) => c.replaceAll('"', ''));
            const row = {};
            cols.forEach((c, i) => (row[c] = this.params[i]));
            rows.set(row.id, row);
            return { success: true, meta: { changes: 1 } };
          }
          if (/^UPDATE/.test(sql)) {
            const setCols = sql
              .match(/SET (.+?) WHERE/)[1]
              .split(', ')
              .map((c) => c.split(' = ')[0].replaceAll('"', ''));
            const id = this.params[this.params.length - 1];
            const row = rows.get(id) ?? {};
            setCols.forEach((c, i) => (row[c] = this.params[i]));
            row.id = id;
            rows.set(id, row);
            return { success: true, meta: { changes: 1 } };
          }
          if (/^DELETE/.test(sql)) {
            if (sql.includes('"last_activity" <=')) {
              const limit = this.params[0];
              let n = 0;
              for (const [id, row] of rows) {
                if (row.last_activity <= limit) {
                  rows.delete(id);
                  n++;
                }
              }
              return { success: true, meta: { changes: n } };
            }
            const had = rows.delete(this.params[0]);
            return { success: true, meta: { changes: had ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
    },
  };
}

test('DatabaseSessionHandler: insert -> read -> update -> destroy -> gc SQL', async () => {
  const db = mockSessionsDb();
  const clock = () => 1000;
  const handler = new DatabaseSessionHandler({ db, minutes: 120, clock });
  const id = 'c'.repeat(40);
  const data = '{"data":"héllo"}'; // non-ascii -> utf8 base64

  await handler.write(id, data);
  assert.equal(db.log[0].sql, 'SELECT * FROM "sessions" WHERE "id" = ? LIMIT ?');
  assert.equal(db.log[1].sql, 'INSERT INTO "sessions" ("payload", "last_activity", "id") VALUES (?, ?, ?)');
  assert.deepEqual(db.log[1].params, [
    Buffer.from(data, 'utf8').toString('base64'),
    1000,
    id,
  ]);

  // Fresh handler: read finds the row (exists=true), write updates.
  const handler2 = new DatabaseSessionHandler({ db, minutes: 120, clock });
  assert.equal(await handler2.read(id), data);
  await handler2.write(id, 'second');
  assert.equal(db.log.at(-1).sql, 'UPDATE "sessions" SET "payload" = ?, "last_activity" = ? WHERE "id" = ?');
  assert.equal(db.rows.get(id).payload, Buffer.from('second', 'utf8').toString('base64'));

  // Expired row: read returns '' but flags exists -> next write updates.
  db.rows.get(id).last_activity = 1000 - 120 * 60 - 1;
  const handler3 = new DatabaseSessionHandler({ db, minutes: 120, clock });
  assert.equal(await handler3.read(id), '');
  assert.equal(handler3.exists, true);
  await handler3.write(id, 'third');
  assert.equal(db.log.at(-1).sql, 'UPDATE "sessions" SET "payload" = ?, "last_activity" = ? WHERE "id" = ?');

  // Info hook adds user/request columns.
  const handler4 = new DatabaseSessionHandler({
    db,
    minutes: 120,
    clock,
    info: () => ({ user_id: 5, ip_address: '1.2.3.4', user_agent: 'UA' }),
  });
  const id2 = 'd'.repeat(40);
  await handler4.write(id2, 'x');
  const insert = db.log.find((l) => /^INSERT/.test(l.sql) && l.params.includes(id2));
  assert.equal(insert.sql, 'INSERT INTO "sessions" ("payload", "last_activity", "user_id", "ip_address", "user_agent", "id") VALUES (?, ?, ?, ?, ?, ?)');
  assert.deepEqual(insert.params, [
    Buffer.from('x', 'utf8').toString('base64'),
    1000,
    5,
    '1.2.3.4',
    'UA',
    id2,
  ]);

  await handler4.destroy(id2);
  assert.equal(db.log.at(-1).sql, 'DELETE FROM "sessions" WHERE "id" = ?');
  assert.equal(db.rows.has(id2), false);

  await handler4.gc(7200);
  assert.equal(db.log.at(-1).sql, 'DELETE FROM "sessions" WHERE "last_activity" <= ?');
  assert.deepEqual(db.log.at(-1).params, [1000 - 7200]);
});

test('DatabaseSessionHandler without D1 binding fails loud', () => {
  assert.throws(() => new DatabaseSessionHandler({}), /requires a D1 binding/);
});
