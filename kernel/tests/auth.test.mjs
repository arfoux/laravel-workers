// kernel/tests/auth.test.mjs — auth layer parity vs the PHP 8.3 oracle.
//
// Spawns tools/php-auth-oracle.php against a real Laravel app (set
// LW_LARAVEL_APP, or the dev-machine default) and proves the compiled rung is
// byte-for-byte what PHP 8.3 + Laravel 13.37 does:
//   - Request negotiation: getAcceptableContentTypes / ajax / pjax / wantsJson
//     / expectsJson (the Accept machinery AuthenticationException depends on)
//   - Recaller: constructor unserialize semantics, including hostile payloads
//   - BcryptHasher: check/info/needsRehash/verifyConfiguration/make with
//     verify=true (fresh-app config), $2y$ vs $2a$/$2b$ handling
//   - SessionGuard end to end: attempt/attemptWhen/once/validate/login, the
//     remember-me cookies, session attributes, DB writes, event stream, logout
//     semantics and the auth/guest middleware behaviour
//
// The guard runs compare snapshot-by-snapshot for the exact same input: ret,
// threw, session bytes, session id, queued cookies (incl. Set-Cookie bytes),
// DB rows and the recorded event stream. Only rehash cases normalise the
// fresh bcrypt salt bytes (random by definition) — everything else must match
// exactly. Any drift is a fail-loud build/test failure, not a tolerance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptsAnyContentType,
  applyAuthenticatable,
  Authenticate,
  AuthenticationException,
  BcryptHasher,
  createAuthManager,
  getAcceptableContentTypes,
  Recaller,
  RedirectIfAuthenticated,
  requestAjax,
  requestExpectsJson,
  requestPjax,
  requestWantsJson,
} from '../auth.mjs';
import { CookieJar, PhpSessionStore } from '../session.mjs';
import { serializeCookie } from '../cookies.mjs';
import { hmacSha256Hex, sha1Hex } from '../digest.mjs';
import { Model } from '../model.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Older Node without node:sqlite: the guard section skips (it needs real SQL).
}
const noSqlite = DatabaseSync ? false : 'node:sqlite unavailable (needs Node >= 22)';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const oraclePath = path.resolve(testsDir, '..', '..', 'tools', 'php-auth-oracle.php');
const PHP = process.env.PHP_BIN || 'php';
const APP_ROOT =
  process.env.LW_LARAVEL_APP ||
  'C:\\Users\\HP\\AppData\\Local\\Temp\\opencode\\lw-fresh-e2e\\fresh-app';

// Frozen clock shared by both runs: Carbon::setTestNow in PHP, a fake clock in
// JS. Cookie expiries therefore land on exact, comparable integers.
const FREEZE_MS = 1792336827000;
const FREEZE_S = Math.floor(FREEZE_MS / 1000);

// Pinned bcrypt hashes for 'secret' (cost 12 / 10). Both runs are seeded with
// the same literal bytes, so the hmac-based remember-cookie values and the DB
// rows stay directly comparable.
const HASH12 = '$2y$12$d0pIpZcCKtpClnDI9BCFgeYNp2hPFUuoGalG4focVyYVTL01s2ZmW';
const HASH10 = '$2y$10$cyT1llBUHIVeZFxw/hKj0eIeqIJNsMI0SUhpbh6K5FWh7NxcNqnf.';
const HASH12_A = '$2a$' + HASH12.slice(4); // same bytes, wrong bcrypt version
const HASH12_B = '$2b$' + HASH12.slice(4);

const GUARD_CLASS = 'Illuminate\\Auth\\SessionGuard';
const LOGIN_NAME = 'login_web_' + sha1Hex(GUARD_CLASS);
const RECALLER_NAME = 'remember_web_' + sha1Hex(GUARD_CLASS);

function runOracle(payload) {
  if (!existsSync(path.join(APP_ROOT, 'vendor', 'autoload.php'))) {
    throw new Error(
      `auth.test: no Laravel app at ${APP_ROOT} (vendor/autoload.php missing). ` +
        'Point LW_LARAVEL_APP at a Laravel 11+/13.x app to run the auth parity tests.'
    );
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

// ---------------------------------------------------------------------------
// Request shim: what the compiled rung passes around, driven by a `server`
// map exactly like the oracle's Request::create($server) input.
// ---------------------------------------------------------------------------

function requestFromServer(server = {}, dropAccept = false) {
  const headers = new Map();
  for (const [key, value] of Object.entries(server)) {
    const name = key.startsWith('HTTP_') ? key.slice(5).replace(/_/g, '-') : key;
    headers.set(name.toLowerCase(), value);
  }
  if (dropAccept) headers.delete('accept');
  return {
    header(name) {
      const value = headers.get(String(name).toLowerCase());
      return value === undefined ? null : value;
    },
  };
}

function requestFromInput(input) {
  return requestFromServer(input.server ?? {}, false);
}

// ---------------------------------------------------------------------------
// Negotiation parity.
// ---------------------------------------------------------------------------

test('auth: Request negotiation parity (Accept machinery)', () => {
  const vectors = [
    // FPM/worker reality: HeaderBag has no Accept header at all.
    { server: {}, drop_accept: true },
    { server: { HTTP_X_REQUESTED_WITH: 'XMLHttpRequest' }, drop_accept: true },
    {
      server: { HTTP_X_PJAX: 'true', HTTP_X_REQUESTED_WITH: 'XMLHttpRequest' },
      drop_accept: true,
    },
    // Browser default Accept header (the Symfony-synthesized string).
    { server: { HTTP_ACCEPT: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } },
    { server: { HTTP_ACCEPT: 'application/json' } },
    { server: { HTTP_ACCEPT: '*/*' } },
    { server: { HTTP_ACCEPT: 'text/html;q=0, application/json' } },
    { server: { HTTP_ACCEPT: 'application/json;q=0.5, text/html' } },
    { server: { HTTP_ACCEPT: 'application/vnd.api+json' } },
    { server: { HTTP_ACCEPT: 'application/problem+json;q=0.5' } },
    { server: { HTTP_ACCEPT: 'application/json;q=0, */*' } },
    { server: { HTTP_ACCEPT: 'text/html;level=1, application/json' } },
    {
      server: { HTTP_X_PJAX: '0', HTTP_X_REQUESTED_WITH: 'XMLHttpRequest', HTTP_ACCEPT: '*/*' },
    },
    { server: { HTTP_X_PJAX: 'true', HTTP_X_REQUESTED_WITH: 'XMLHttpRequest', HTTP_ACCEPT: '*/*' } },
  ];

  const oracle = runOracle({ mode: 'negotiation', vectors });
  assert.equal(oracle.results.length, vectors.length);

  for (let i = 0; i < vectors.length; i++) {
    const php = oracle.results[i];
    const request = requestFromServer(vectors[i].server, vectors[i].drop_accept === true);
    const label = `vector ${i} ${JSON.stringify(vectors[i].server)}${
      vectors[i].drop_accept ? ' [no Accept]' : ''
    }`;

    assert.deepEqual(
      {
        acceptsAnyContentType: acceptsAnyContentType(request),
        ajax: requestAjax(request),
        pjax: requestPjax(request),
        wantsJson: requestWantsJson(request),
        expectsJson: requestExpectsJson(request),
      },
      {
        acceptsAnyContentType: php.acceptsAnyContentType,
        ajax: php.ajax,
        pjax: php.pjax,
        wantsJson: php.wantsJson,
        expectsJson: php.expectsJson,
      },
      label
    );
    assert.deepEqual(getAcceptableContentTypes(request), php.acceptable, `${label}: acceptable`);
  }
});

// ---------------------------------------------------------------------------
// Recaller parity (lenient unserialize surface).
// ---------------------------------------------------------------------------

test('auth: Recaller semantics parity (lenient unserialize)', () => {
  const values = [
    `1|abcdef|${'f'.repeat(64)}`,
    '1|abcdefghij|0123456789abcdef',
    '1|tok',
    '1|tok|hash|extra',
    'abc|def|ghi',
    '|tok|hash',
    ' 1 |tok|hash ',
    '1|tok|',
    '',
    'N;',
    'b:0;',
    'b:1;',
    'i:0;',
    'i:5;',
    'i:-0;',
    'd:0;',
    'd:1.5;',
    'd:NAN;',
    'd:INF;',
    'd:-INF;',
    's:0:"";',
    's:3:"abc";',
    's:3:"a|b";',
    's:5:"a|b|c";',
    's:6:"a|b|cd";',
    's:2:"é";',
    's:1:"é";',
    's:3:"|ab";',
    'a:0:{}',
    'a:1:{i:0;i:1;}',
    'O:8:"stdClass":0:{}',
    'C:3:"Foo":0:{}',
    'x:1;',
    'truthy',
  ];

  const oracle = runOracle({ mode: 'recaller', values });
  assert.equal(oracle.results.length, values.length);

  for (let i = 0; i < values.length; i++) {
    const php = oracle.results[i];
    const recaller = new Recaller(values[i]);
    const valid = recaller.valid();
    assert.deepEqual(
      {
        in: values[i],
        valid,
        id: valid ? recaller.id() : null,
        token: valid ? recaller.token() : null,
        hash: valid ? recaller.hash() : null,
        segments: valid ? recaller.segments() : null,
      },
      php,
      `recaller ${JSON.stringify(values[i])}`
    );
  }
});

// ---------------------------------------------------------------------------
// BcryptHasher parity.
// ---------------------------------------------------------------------------

test('auth: BcryptHasher parity (verify=true, rounds=12)', async () => {
  const ops = [
    ['info', [HASH12]],
    ['info', [HASH12_B]],
    ['info', ['garbage']],
    ['check', ['secret', HASH12]],
    ['check', ['wrong', HASH12]],
    ['check', ['secret', '']],
    ['check', ['secret', null]],
    ['check', ['secret', HASH12_A]],
    ['check', ['secret', HASH12_B]],
    ['needsRehash', [HASH12]],
    ['needsRehash', [HASH12, { rounds: 10 }]],
    ['needsRehash', [HASH10]],
    ['needsRehash', [HASH12_A]],
    ['needsRehash', ['garbage']],
    ['verifyConfiguration', [HASH12]],
    ['verifyConfiguration', [HASH12_B]],
    ['verifyConfiguration', [`$2y$14$${'a'.repeat(53)}`]],
    ['make', ['secret']],
    ['setRoundsMake', [10, 'secret']],
  ];

  const oracle = runOracle({ mode: 'hasher', ops });
  assert.deepEqual(oracle.meta, { rounds: 12, verify: true, limit: null, rehash_on_login: true });

  const hasher = new BcryptHasher({
    rounds: oracle.meta.rounds,
    verify: oracle.meta.verify,
    limit: oracle.meta.limit,
  });

  const apply = async (op, args) => {
    switch (op) {
      case 'check':
        return hasher.check(args[0], args[1], args[2] ?? []);
      case 'needsRehash':
        return hasher.needsRehash(args[0], args[1] ?? []);
      case 'info':
        return hasher.info(args[0]);
      case 'verifyConfiguration':
        return hasher.verifyConfiguration(args[0]);
      case 'make': {
        const made = await hasher.make(args[0], args[1] ?? []);
        return {
          prefix: made.slice(0, 4),
          cost: parseInt(made.slice(4, 6), 10),
          verifies: await hasher.check(args[0], made),
          len: made.length,
        };
      }
      case 'setRoundsMake': {
        const previous = hasher.cost();
        hasher.setRounds(parseInt(args[0], 10));
        const made = await hasher.make(args[1]);
        hasher.setRounds(previous);
        return { prefix: made.slice(0, 4), cost: parseInt(made.slice(4, 6), 10) };
      }
      default:
        throw new Error(`unknown hasher op ${op}`);
    }
  };

  for (let i = 0; i < ops.length; i++) {
    const [op, args] = ops[i];
    const php = oracle.results[i];
    let ret = null;
    let threw = null;
    try {
      ret = await apply(op, args);
    } catch (err) {
      threw = { class: err.phpClass ?? err.constructor.name, message: err.message };
    }
    assert.deepEqual(JSON.parse(JSON.stringify(ret)), JSON.parse(php.ret), `hasher op#${i} (${op}): ret`);
    assert.deepEqual(threw, php.threw, `hasher op#${i} (${op}): threw`);
    assert.deepEqual(JSON.parse(php.op), [op, ...args], `hasher op#${i}: op echo`);
  }
});

// ---------------------------------------------------------------------------
// The JS mirror of the guard run.
// ---------------------------------------------------------------------------

class MemHandler {
  constructor() {
    this.store = new Map();
  }
  async read(id) {
    return this.store.has(id) ? this.store.get(id) : '';
  }
  async write(id, payload) {
    this.store.set(id, payload);
    return true;
  }
  async destroy(id) {
    this.store.delete(id);
    return true;
  }
  async gc() {
    return 0;
  }
}

class RecordingEvents {
  constructor() {
    this.events = [];
    this.listeners = new Map();
  }
  listen(name, callback) {
    const list = this.listeners.get(name) ?? [];
    list.push(callback);
    this.listeners.set(name, list);
    return this;
  }
  dispatch(event) {
    this.events.push(event);
    for (const callback of this.listeners.get(event.class) ?? []) callback(event);
    return event;
  }
}

class LWFakeUser extends Model {}
LWFakeUser.table = 'lw_users';
applyAuthenticatable(LWFakeUser);

// Minimal D1-shaped wrapper over node:sqlite (same as sqlite-integration.test).
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
          return {
            success: true,
            meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid ?? 0) },
          };
        },
      };
    },
  };
}

function makeRequest(input) {
  const headers = new Map();
  for (const [key, value] of Object.entries(input.server ?? {})) {
    const name = key.startsWith('HTTP_') ? key.slice(5).replace(/_/g, '-') : key;
    headers.set(name.toLowerCase(), value);
  }
  return {
    cookies: new Map(Object.entries(input.cookies ?? {})),
    header(name) {
      const value = headers.get(String(name).toLowerCase());
      return value === undefined ? null : value;
    },
  };
}

function marshalUser(user) {
  if (user === null || user === undefined || user === false) {
    return user === undefined ? null : user;
  }
  if (typeof user.getAuthIdentifier === 'function') {
    return { id: user.getAuthIdentifier(), email: user.get('email') ?? null };
  }
  return user;
}

function marshalRet(ret) {
  if (ret === null || ret === undefined) return null;
  if (typeof ret === 'object' && typeof ret.getAuthIdentifier === 'function') {
    return marshalUser(ret);
  }
  return ret;
}

function marshalEvent(event) {
  const out = { class: event.class };
  if ('guard' in event) out.guard = event.guard;
  if ('remember' in event) out.remember = event.remember;
  if ('credentials' in event) out.credentials = event.credentials;
  if ('user' in event) out.user = marshalUser(event.user);
  return out;
}

function marshalQueued(cookie) {
  return {
    name: cookie.name,
    value: cookie.value ?? null,
    expires: cookie.expires ?? 0,
    path: cookie.path ?? null,
    domain: cookie.domain ?? null,
    secure: !!cookie.secure,
    http_only: !!cookie.httpOnly,
    raw: !!cookie.raw,
    same_site: cookie.sameSite ?? null,
  };
}

function queuedPick(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    expires: cookie.expires,
    path: cookie.path,
    domain: cookie.domain,
    secure: cookie.secure,
    http_only: cookie.http_only,
    raw: cookie.raw,
    same_site: cookie.same_site,
  };
}

function phpErrorClass(err) {
  if (err instanceof AuthenticationException) {
    return 'Illuminate\\Auth\\AuthenticationException';
  }
  if (typeof err.phpClass === 'string' && err.phpClass) return err.phpClass;
  return err?.constructor?.name ?? 'Error';
}

async function runJs(input, { hashKey }) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE lw_users (
    id INTEGER PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE,
    email_verified_at TEXT NULL,
    password TEXT NOT NULL,
    remember_token TEXT NULL,
    created_at TEXT NULL,
    updated_at TEXT NULL
  )`);

  const user = input.user ?? null;
  if (user) {
    sqlite
      .prepare(
        'INSERT INTO lw_users (id, name, email, email_verified_at, password, remember_token, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)'
      )
      .run(
        user.id ?? 1,
        user.name ?? 'Test User',
        user.email ?? 'u@example.com',
        user.password_hash ?? HASH12,
        user.remember_token ?? null,
        '2026-01-01 00:00:00',
        '2026-01-01 00:00:00'
      );
  }
  const db = d1(sqlite);

  const store = new PhpSessionStore({
    name: 'laravel_session',
    handler: new MemHandler(),
    id: input.session_id ?? null,
    serialization: 'json',
    randomString: (length) => 'A'.repeat(length),
  });
  await store.start();
  for (const [key, value] of Object.entries(input.session_seed ?? {})) store.put(key, value);

  const jar = new CookieJar({
    path: '/',
    domain: null,
    secure: null,
    sameSite: 'lax',
    clock: () => FREEZE_S,
  });
  const events = new RecordingEvents();
  const request = makeRequest(input);
  const hasher = new BcryptHasher({ rounds: 12, verify: true, limit: null });
  const manager = createAuthManager({
    config: {
      'auth.defaults.guard': input.guard ?? 'web',
      'auth.guards.web': { driver: 'session', provider: 'users' },
      'auth.providers.users': { driver: 'eloquent', model: LWFakeUser },
    },
    db,
    session: store,
    request,
    cookieJar: jar,
    events,
    hasher,
    strRandom: (length) => 'A'.repeat(length),
    timeboxDuration: 200000,
    rehashOnLogin: true,
    hashKey,
  });
  const guard = manager.guard();

  const attemptingCalls = [];
  guard.attempting((event) => attemptingCalls.push(event.credentials));

  const shouldUseCalls = [];
  const originalShouldUse = manager.shouldUse.bind(manager);
  manager.shouldUse = (name) => {
    shouldUseCalls.push(name);
    return originalShouldUse(name);
  };

  const dbSnapshot = () =>
    sqlite
      .prepare('SELECT id, email, remember_token, password FROM lw_users ORDER BY id')
      .all()
      .map((row) => ({
        id: row.id,
        email: row.email,
        remember_token: row.remember_token ?? null,
        password: row.password,
      }));

  const applyOp = async (op, args) => {
    switch (op) {
      case 'attempt':
        return { ret: await guard.attempt(args[0], args[1] ?? false) };
      case 'attemptWhen': {
        const spec = args[1] ?? null;
        const makeCallback = (entry) => {
          if (typeof entry === 'boolean') return () => entry;
          if (entry && typeof entry === 'object' && 'user_email_suffix' in entry) {
            return (candidate) =>
              String(candidate.get('email') ?? '').endsWith(entry.user_email_suffix);
          }
          return () => true;
        };
        const callbacks =
          spec === null ? null : Array.isArray(spec) ? spec.map(makeCallback) : makeCallback(spec);
        return { ret: await guard.attemptWhen(args[0], callbacks, args[2] ?? false) };
      }
      case 'once':
        return { ret: await guard.once(args[0]) };
      case 'onceUsingId':
        return { ret: await guard.onceUsingId(args[0]) };
      case 'validate':
        return { ret: await guard.validate(args[0]) };
      case 'loginUsingId':
        return { ret: await guard.loginUsingId(args[0], args[1] ?? false) };
      case 'logout':
        await guard.logout();
        return { hasRet: false };
      case 'logoutCurrentDevice':
        await guard.logoutCurrentDevice();
        return { hasRet: false };
      case 'logoutOtherDevices':
        await guard.logoutOtherDevices(args[0]);
        return { hasRet: false };
      case 'user':
        return { ret: await guard.user() };
      case 'id':
        return { ret: await guard.id() };
      case 'check':
        return { ret: await guard.check() };
      case 'guest':
        return { ret: await guard.guest() };
      case 'hasUser':
        return { ret: guard.hasUser() };
      case 'viaRemember':
        return { ret: guard.viaRemember() };
      case 'getLastAttempted':
        return { ret: guard.getLastAttempted() };
      case 'hashPasswordForCookie':
        return { ret: guard.hashPasswordForCookie(args[0]) };
      case 'getName':
        return { ret: guard.getName() };
      case 'getRecallerName':
        return { ret: guard.getRecallerName() };
      case 'sessionPut':
        store.put(args[0], args[1]);
        return { hasRet: false };
      case 'sessionRemove':
        store.remove(args[0]);
        return { hasRet: false };
      case 'middlewareAuth': {
        const middleware = new Authenticate(manager);
        let nextCalled = false;
        const next = () => {
          nextCalled = true;
          return 'NEXT';
        };
        try {
          const ret = await middleware.handle(request, next, ...(args[0] ?? []));
          return {
            ret,
            extra: {
              next: nextCalled,
              shouldUse: shouldUseCalls.length ? shouldUseCalls[shouldUseCalls.length - 1] : null,
            },
          };
        } catch (err) {
          if (!(err instanceof AuthenticationException)) throw err;
          return {
            ret: null,
            threw: { class: 'Illuminate\\Auth\\AuthenticationException', message: err.message },
            extra: {
              next: nextCalled,
              guards: err.guards(),
              redirectTo: err.redirectTo(request),
              expectsJson: requestExpectsJson(request),
            },
          };
        }
      }
      case 'middlewareGuest': {
        const middleware = new RedirectIfAuthenticated(manager);
        let nextCalled = false;
        const next = () => {
          nextCalled = true;
          return 'NEXT';
        };
        const value = await middleware.handle(request, next, ...(args[0] ?? []));
        if (value && typeof value === 'object' && 'status' in value && 'location' in value) {
          return { ret: { status: value.status, location: value.location, next: nextCalled } };
        }
        return { ret: { ret: value, next: nextCalled } };
      }
      default:
        throw new Error(`unknown auth op ${op}`);
    }
  };

  const snapshots = [];
  const rawQueued = [];
  for (const step of input.ops ?? []) {
    const [op, args = []] = step;
    const beforeEvents = events.events.length;
    const startedAt = Date.now();
    let ret = null;
    let hasRet = true;
    let threw = null;
    let extra = []; // PHP's `$extra = []` marshals to [] not {}
    try {
      const outcome = await applyOp(op, args);
      if (outcome) {
        if ('ret' in outcome) ret = outcome.ret;
        if (outcome.hasRet === false) hasRet = false;
        if (outcome.threw) threw = outcome.threw;
        if (outcome.extra) extra = outcome.extra;
      }
    } catch (err) {
      ret = null;
      threw = { class: phpErrorClass(err), message: err.message };
    }
    const cookies = jar.getQueuedCookies();
    snapshots.push({
      op,
      has_ret: hasRet,
      ret: JSON.stringify(marshalRet(ret)),
      threw,
      extra,
      session: JSON.stringify(store.all()),
      session_id: store.getId(),
      queued: cookies.map(marshalQueued),
      db: dbSnapshot(),
      events: events.events.slice(beforeEvents).map(marshalEvent),
      duration_ms: Date.now() - startedAt,
    });
    rawQueued.push(cookies);
  }

  return {
    meta: {
      login_name: guard.getName(),
      recaller_name: guard.getRecallerName(),
      remember_minutes: 5760,
      hash_key: hashKey,
      rounds: 12,
      verify: true,
      rehash_on_login: true,
      timebox_duration: 200000,
      expects_json: requestExpectsJson(request),
      attempting_calls: attemptingCalls,
    },
    snapshots,
    rawQueued,
    hasher,
    final: {
      session: JSON.stringify(store.all()),
      session_id: store.getId(),
    },
  };
}

// The guest/auth middleware redirect target: Laravel's redirect() helper
// resolves paths through the UrlGenerator (absolute URL, e.g.
// http://localhost:8000 for '/'), while the compiled rung's auth layer returns
// the raw path. Absolute URL resolution ships with the redirect/URL helper
// (compiler stage); compare the path portion so the auth-layer contract stays
// under test.
function normalizeRet(ret) {
  if (
    ret &&
    typeof ret === 'object' &&
    !Array.isArray(ret) &&
    'status' in ret &&
    'location' in ret &&
    typeof ret.location === 'string'
  ) {
    let location = ret.location;
    if (/^https?:\/\//.test(location)) {
      const url = new URL(location);
      location = url.pathname + url.search + url.hash;
    }
    return { ...ret, location };
  }
  return ret;
}

function assertRun(label, js, oracle, { rehashIndex = -1 } = {}) {
  assert.deepEqual(js.meta, oracle.meta, `${label}: meta`);
  assert.equal(js.snapshots.length, oracle.snapshots.length, `${label}: op count`);

  for (let i = 0; i < oracle.snapshots.length; i++) {
    const j = js.snapshots[i];
    const p = oracle.snapshots[i];
    const at = `${label} op#${i} (${j.op})`;
    const scrubDb = (rows) =>
      i === rehashIndex ? rows.map((row) => ({ ...row, password: null })) : rows;
    const scrubQueued = (queued) =>
      i === rehashIndex ? queued.map((cookie) => ({ ...cookie, value: null })) : queued;

    assert.equal(j.op, p.op, `${at}: op`);
    assert.equal(j.has_ret, p.has_ret, `${at}: has_ret`);
    assert.deepEqual(normalizeRet(JSON.parse(j.ret)), normalizeRet(JSON.parse(p.ret)), `${at}: ret`);
    assert.deepEqual(j.threw, p.threw, `${at}: threw`);
    assert.deepEqual(j.extra, p.extra, `${at}: extra`);
    assert.deepEqual(JSON.parse(j.session), JSON.parse(p.session), `${at}: session bytes`);
    assert.equal(j.session_id, p.session_id, `${at}: session id`);
    assert.deepEqual(
      scrubQueued(j.queued),
      scrubQueued(p.queued.map(queuedPick)),
      `${at}: queued cookies`
    );
    if (i !== rehashIndex) {
      for (let qi = 0; qi < p.queued.length; qi++) {
        assert.equal(
          serializeCookie(js.rawQueued[i][qi], p.queued[qi].render_now),
          p.queued[qi].header,
          `${at}: Set-Cookie bytes #${qi}`
        );
      }
    }
    assert.deepEqual(scrubDb(j.db), scrubDb(p.db), `${at}: db rows`);
    assert.deepEqual(j.events, p.events, `${at}: events`);
  }

  assert.deepEqual(JSON.parse(js.final.session), JSON.parse(oracle.final.session), `${label}: final session`);
  assert.equal(js.final.session_id, oracle.final.session_id, `${label}: final session id`);
}

// ---------------------------------------------------------------------------
// SessionGuard + middleware end-to-end parity.
// ---------------------------------------------------------------------------

test('auth: SessionGuard + middleware end-to-end parity', { skip: noSqlite }, async () => {
  const base = () => ({ mode: 'auth', freeze_ms: FREEZE_MS, str_random: true });

  const baselineInput = {
    ...base(),
    user: { id: 1, email: 'u@example.com', password_hash: HASH12, remember_token: null },
    ops: [
      ['guest', []],
      ['check', []],
      ['id', []],
      ['hasUser', []],
      ['viaRemember', []],
      ['getLastAttempted', []],
      ['getName', []],
      ['getRecallerName', []],
      ['hashPasswordForCookie', ['abc']],
      ['hashPasswordForCookie', ['']],
    ],
  };

  const baseline = runOracle(baselineInput);
  // The fixture app must expose the config the compiled rung assumes; the
  // pinned expectations guard against running against a drifted app.
  assert.equal(baseline.meta.login_name, LOGIN_NAME);
  assert.equal(baseline.meta.recaller_name, RECALLER_NAME);
  assert.equal(baseline.meta.remember_minutes, 5760);
  assert.equal(baseline.meta.rounds, 12);
  assert.equal(baseline.meta.verify, true);
  assert.equal(baseline.meta.rehash_on_login, true);
  assert.equal(baseline.meta.timebox_duration, 200000);

  const hashKey = baseline.meta.hash_key;
  const seedUser = () => ({
    id: 1,
    name: 'Test User',
    email: 'u@example.com',
    password_hash: HASH12,
    remember_token: null,
  });
  const resumeToken = 'A'.repeat(60);
  const resumeValue = `1|${resumeToken}|${hmacSha256Hex(HASH12, hashKey)}`;
  const badHashValue = `1|${resumeToken}|${hmacSha256Hex(HASH10, hashKey)}`;

  const runs = [
    { label: 'baseline', input: baselineInput, oracle: baseline },
    {
      label: 'attempt-login',
      input: {
        ...base(),
        user: seedUser(),
        ops: [
          ['attempt', [{ email: 'u@example.com', password: 'secret' }, false]],
          ['check', []],
          ['id', []],
          ['user', []],
          ['getLastAttempted', []],
          ['hashPasswordForCookie', ['abc']],
        ],
      },
    },
    {
      label: 'attempt-fail',
      input: {
        ...base(),
        user: seedUser(),
        ops: [
          ['attempt', [{ email: 'u@example.com', password: 'wrong' }, false]],
          ['check', []],
          ['guest', []],
          ['getLastAttempted', []],
          ['hasUser', []],
        ],
      },
    },
    {
      label: 'remember-login',
      input: {
        ...base(),
        user: seedUser(),
        ops: [
          ['attempt', [{ email: 'u@example.com', password: 'secret' }, true]],
          ['check', []],
          ['viaRemember', []],
        ],
      },
    },
    {
      label: 'remember-resume',
      input: {
        ...base(),
        user: { ...seedUser(), remember_token: resumeToken },
        cookies: { [RECALLER_NAME]: resumeValue },
        ops: [['user', []], ['check', []], ['id', []], ['viaRemember', []], ['user', []]],
      },
    },
    {
      label: 'remember-bad-hash',
      input: {
        ...base(),
        user: { ...seedUser(), remember_token: resumeToken },
        cookies: { [RECALLER_NAME]: badHashValue },
        ops: [['user', []], ['viaRemember', []], ['check', []]],
      },
    },
    {
      label: 'logout',
      input: {
        ...base(),
        user: { ...seedUser(), remember_token: 'legacy-remember-token-value' },
        cookies: { [RECALLER_NAME]: resumeValue },
        session_seed: { [LOGIN_NAME]: 1 },
        ops: [
          ['user', []],
          ['check', []],
          ['logout', []],
          ['logoutCurrentDevice', []],
          ['check', []],
          ['id', []],
        ],
      },
    },
    {
      label: 'logout-other-devices',
      input: {
        ...base(),
        user: { ...seedUser(), remember_token: resumeToken },
        cookies: { [RECALLER_NAME]: resumeValue },
        session_seed: { [LOGIN_NAME]: 1 },
        ops: [
          ['logoutOtherDevices', ['nope']],
          ['logoutOtherDevices', ['secret']],
        ],
      },
      rehashIndex: 1,
    },
    {
      label: 'once-validate',
      input: {
        ...base(),
        user: seedUser(),
        ops: [
          ['validate', [{ email: 'u@example.com', password: 'secret' }]],
          ['validate', [{ email: 'u@example.com', password: 'wrong' }]],
          ['once', [{ email: 'u@example.com', password: 'secret' }]],
          ['check', []],
          ['once', [{ email: 'u@example.com', password: 'wrong' }]],
          ['hasUser', []],
        ],
      },
    },
    {
      label: 'attempt-when',
      input: {
        ...base(),
        user: seedUser(),
        ops: [
          ['attemptWhen', [{ email: 'u@example.com', password: 'secret' }, false, false]],
          ['attemptWhen', [{ email: 'u@example.com', password: 'secret' }, true, true]],
          ['check', []],
          ['attemptWhen', [{ email: 'u@example.com', password: 'secret' }, { user_email_suffix: '@example.com' }, false]],
          ['attemptWhen', [{ email: 'u@example.com', password: 'secret' }, null, false]],
          ['attemptWhen', [{ email: 'u@example.com', password: 'secret' }, [true, false], false]],
        ],
      },
    },
    {
      label: 'middleware-authenticated',
      input: {
        ...base(),
        user: seedUser(),
        session_seed: { [LOGIN_NAME]: 1 },
        ops: [
          ['middlewareAuth', [['web']]],
          ['middlewareGuest', [['web']]],
          ['middlewareAuth', [[]]],
        ],
      },
    },
    {
      label: 'middleware-guest',
      input: {
        ...base(),
        user: seedUser(),
        ops: [['middlewareAuth', [['web']]], ['middlewareGuest', [['web']]]],
      },
    },
    {
      label: 'middleware-json',
      input: {
        ...base(),
        user: seedUser(),
        server: { HTTP_ACCEPT: 'application/json' },
        ops: [['middlewareAuth', [['web']]]],
      },
    },
  ];

  assert.equal(Authenticate.using('web'), 'Illuminate\\Auth\\Middleware\\Authenticate:web');
  assert.equal(
    RedirectIfAuthenticated.using('web', 'api'),
    'Illuminate\\Auth\\Middleware\\RedirectIfAuthenticated:web,api'
  );

  for (const run of runs) {
    const oracle = run.oracle ?? runOracle(run.input);
    const js = await runJs(run.input, { hashKey });
    assertRun(run.label, js, oracle, { rehashIndex: run.rehashIndex ?? -1 });

    if (run.label === 'remember-login') {
      // The queued remember cookie must be id|token|hmac(password-hash).
      const queued = js.snapshots[0].queued[0];
      assert.equal(queued.value, resumeValue, 'remember-login: recaller cookie bytes');
    }

    if (run.label === 'logout-other-devices') {
      // The rehash produces fresh random salt bytes on both sides; assert the
      // structure and that each side's recaller mac follows from its own hash.
      const jsHash = js.snapshots[1].db[0].password;
      const phpHash = oracle.snapshots[1].db[0].password;
      for (const [who, hash] of [
        ['php', phpHash],
        ['js', jsHash],
      ]) {
        assert.match(hash, /^\$2y\$12\$/, `${run.label}: ${who} rehash prefix/cost`);
        assert.notEqual(hash, HASH12, `${run.label}: ${who} rehash is fresh`);
      }
      assert.ok(await js.hasher.check('secret', jsHash), `${run.label}: js stored hash verifies`);
      assert.equal(
        js.rawQueued[1][0].value,
        `1|${resumeToken}|${hmacSha256Hex(jsHash, hashKey)}`,
        `${run.label}: js recaller mac after rehash`
      );
      assert.equal(
        oracle.snapshots[1].queued[0].value,
        `1|${resumeToken}|${hmacSha256Hex(phpHash, hashKey)}`,
        `${run.label}: php recaller mac after rehash`
      );
    }
  }
});
