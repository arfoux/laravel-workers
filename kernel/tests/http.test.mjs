// kernel/tests/http.test.mjs — compiled HTTP pipeline parity vs PHP 8.3.
//
// Two independent proofs:
//
//   1. parsePhpQuery: the compiled rung's `a[b][c]`/`a[]` parser compared
//      against the live PHP 8.3 `parse_str` for a broad case table. Anything
//      that diverges is either fixed or pinned as an explicit KNOWN_DIVERGENCE
//      (never silently tolerated).
//
//   2. The 11-step pipeline scenario: tools/php-http-pipeline-oracle.php boots a
//      real Laravel 13.37 web pipeline (EncryptCookies → AddQueuedCookiesToResponse
//      → StartSession → PreventRequestForgery → route middleware) over a dedicated
//      sqlite database and replays a cookie-jar session that covers a fresh
//      session, a CSRF failure, a JSON/HTML unauthenticated redirect, a login
//      (session id + CSRF token regeneration), a guest redirect and a logout.
//      The compiled `handleHttp` replays the exact same steps and both sides are
//      compared per step:
//
//        - status (exact)
//        - response headers minus `date`/`set-cookie` (exact)
//        - Set-Cookie per cookie: name + attribute list in order (the `Max-Age`
//          *value* is normalised: Symfony derives it from real time(), which the
//          frozen-clock oracle cannot reproduce — the `expires` value is asserted
//          exactly instead)
//        - body: JSON parsed + deepEqual; redirect bodies byte-exact; the 419
//          debug body (absolute file/line/trace) is compared status + message
//        - session row columns, and the raw session payload *bytes* after
//          normalising the two random values (session id, CSRF token)
//
// Every random value is one of exactly two: the session id (random 40 chars) and
// the CSRF token (random 40 chars). Both are fed deterministically to the
// compiled side and normalised out of the payload comparison on both sides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCookieEncryptor } from '../cookies.mjs';
import { handleHttp, parsePhpQuery, buildRequest, validationMessagesOf } from '../http.mjs';
import { createDatabaseCache } from '../cache.mjs';
import { applyAuthenticatable } from '../auth.mjs';
import { Model } from '../model.mjs';
import { normalizeTable } from '../router.mjs';
import { oracleAppRoot, oracleDbPath, oracleSkip } from './oracle-app.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Older Node without node:sqlite: the pipeline section skips.
}
const noSqlite = DatabaseSync ? false : 'node:sqlite unavailable (needs Node >= 22)';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const oraclePath = path.resolve(testsDir, '..', '..', 'tools', 'php-http-pipeline-oracle.php');
const PHP = process.env.PHP_BIN || 'php';
const APP_ROOT = oracleAppRoot();
// The PHP oracle parity tests need a real Laravel app (PHP 8.3 + vendor/).
// Without one they SKIP (the CI `test` job has no app; the `e2e` job points
// LW_LARAVEL_APP at the app it creates and runs them for real).
const noApp = APP_ROOT ? false : oracleSkip('http.test.mjs');

const FREEZE_MS = 1792336827000;
const FREEZE_S = Math.floor(FREEZE_MS / 1000);
const HASH12 = '$2y$12$d0pIpZcCKtpClnDI9BCFgeYNp2hPFUuoGalG4focVyYVTL01s2ZmW';
const CLIENT_IP = '127.0.0.1';
const USER_AGENT = 'Symfony';
const BASE = 'http://localhost';
const TOKEN = '\u00abTOKEN\u00bb';

function requireApp() {
  if (!APP_ROOT || !existsSync(path.join(APP_ROOT, 'vendor', 'autoload.php'))) {
    throw new Error(oracleSkip('http.test.mjs'));
  }
}

// ---------------------------------------------------------------------------
// 1. parsePhpQuery vs the live PHP 8.3 parse_str
// ---------------------------------------------------------------------------
//
// MATCH_CASES must be byte-identical on both sides. KNOWN_DIVERGENCES are
// asserted to *stay* divergent (pinned to PHP's output) so a future change that
// silently widens or narrows the gap fails the suite.
const MATCH_CASES = [
  'a=1&b=2',
  'a[]=1&a[]=2',
  'a[b]=1&a[b][c]=2',
  'a[b][c]=2&a[b]=1',
  'a.b=1',
  'a b=2',
  'a=1&a=2',
  'x=0&x[]=1',
  'x[]=1&x=s',
  'a%5Bb%5D=1',
  'n=+1',
  'e=',
  'k=1&k=2&k[]=3',
  'arr[0]=a&arr[1]=b',
  'arr[]=a&arr[2]=b',
  'a[b][]=1&a[b][]=2',
  'a[b]=1&a=2',
  'a=2&a[b]=1',
  'x[1][2]=3',
  'a=1&&b=2',
  'a[]=1&a[0]=9',
  'A=1&a=2',
  'a[0][0]=1',
  'foo=bar%20baz',
  'arr[a][b][c][d]=1',
  'k[]=1&k[a]=2',
  'a=b%26c',
  'k[n][]=1',
  'k[][]=1',
  // A key named `__proto__`/`constructor`/`prototype` is ordinary DATA in PHP
  // (`parse_str` builds a PHP array); registered through kernel/php-bag.mjs it
  // stays data on the JS side too, and Object.prototype is never touched
  // (the invariant test below runs the same table through the pristine check).
  'a[__proto__][p]=1',
  'x[__proto__]=1',
  '__proto__[p]=1',
  'x[constructor][prototype][polluted]=1',
  'a[prototype]=1',
  'x[__proto__][p]=1&x[a]=2',
  'a[__proto__][]=1',
  'x[__proto__][]=1&x[__proto__][]=2',
  'a[toString]=1',
];

// PHP's parse_str walks the *decoded* name as a C string, so a NUL byte (%00)
// truncates the variable name. The compiled rung keeps the NUL instead
// (it is a JS string, not a NUL-terminated buffer). The direction is
// fail-closed: `_token%00x=...` is *not* seen as `_token` by the compiled rung,
// so the CSRF check rejects the request rather than accepting it. Pinned here
// so the divergence stays explicit and is never widened by accident.
const NUL_CASES = [
  ['a%00b=1', { a: '1' }],
  ['%00a=1', []],
  ['a[b%00c]=1', { a_b: '1' }],
];

function phpParseStr(cases) {
  const code = [
    '$cases = json_decode(stream_get_contents(STDIN), true);',
    '$out = [];',
    'foreach ($cases as $c) { parse_str($c, $r); $out[] = $r; }',
    'echo json_encode($out);',
  ].join(' ');
  const res = spawnSync(PHP, ['-r', code], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    throw new Error(`php parse_str probe failed: ${res.error?.message ?? res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

test('parsePhpQuery matches PHP 8.3 parse_str exactly', () => {
  const php = phpParseStr(MATCH_CASES);
  for (let i = 0; i < MATCH_CASES.length; i += 1) {
    const js = JSON.parse(JSON.stringify(parsePhpQuery(MATCH_CASES[i])));
    assert.deepEqual(js, php[i], `parsePhpQuery diverged for ${MATCH_CASES[i]}`);
  }
});

// The security invariant the hostile keys above exist for: registering a name
// through the bag must never write through an inherited property. (`out['__proto__'][p] = 1`
// on a plain object literal walks the prototype chain and pollutes
// Object.prototype for the whole isolate.) kernel/tests/proto-pollution.test.mjs
// covers the other writers; this one pins the query-string parser.
test('parsePhpQuery never mutates Object.prototype', () => {
  const baseline = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
  const hostile = [
    ...MATCH_CASES,
    'x[__proto__][p]=1',
    'x[constructor][prototype][polluted]=1',
    '__proto__=1',
    'x[__proto__]=1&x[__proto__][p]=2',
    'x[toString][__proto__]=1',
  ];
  for (const c of hostile) {
    const out = parsePhpQuery(c);
    assert.equal(
      Object.getOwnPropertyNames(Object.prototype).sort().join(','),
      baseline,
      `Object.prototype mutated by ${c}`
    );
    assert.equal(
      Object.prototype.polluted,
      undefined,
      `Object.prototype.polluted leaked from ${c}`
    );
    // The bag answers the same DATA PHP does for the hostile key (`{"__proto__":{"p":"1"}}`):
    // either an own `__proto__` property holding it, or a null-prototype-ish bag
    // that kept it as data. What must never happen is a write THROUGH the
    // inherited accessor, which the pristine check above catches.
    if (c.startsWith('__proto__[p]')) {
      assert.equal(out.__proto__.p, '1', `the sent __proto__ value was lost for ${c}`);
      assert.equal(
        Object.prototype.hasOwnProperty.call(out, '__proto__'),
        true,
        `__proto__ (as data) is not an own key for ${c}`
      );
    }
  }
});

test('parsePhpQuery NUL-in-name divergence is explicit and fail-closed', () => {
  const cases = NUL_CASES.map(([c]) => c);
  const php = phpParseStr(cases);
  for (let i = 0; i < cases.length; i += 1) {
    const js = JSON.parse(JSON.stringify(parsePhpQuery(cases[i])));
    // PHP's value is pinned: it is the C-string-truncation artifact.
    assert.deepEqual(php[i], NUL_CASES[i][1], `pinned PHP output drifted for ${cases[i]}`);
    assert.notDeepEqual(
      js,
      php[i],
      `parsePhpQuery now matches PHP for ${cases[i]} — move it to MATCH_CASES and update MAP.md`
    );
  }
});

// ---------------------------------------------------------------------------
// 2. the pipeline scenario
// ---------------------------------------------------------------------------
//
// Keep this table/labels in lockstep with tools/php-http-pipeline-oracle.php:
// the oracle registers exactly these routes and probes only these observation
// points, so the compiled handlers below are the same functions in JS.
const STEPS = [
  { label: '1 GET state anon', method: 'GET', uri: '/__probe/state' },
  { label: '2 GET state jar', method: 'GET', uri: '/__probe/state', jar: true },
  { label: '3 POST state no csrf', method: 'POST', uri: '/__probe/state', jar: true },
  {
    label: '4 POST state csrf',
    method: 'POST',
    uri: '/__probe/state',
    jar: true,
    form: { _token: '@token' },
  },
  { label: '5 GET auth json', method: 'GET', uri: '/__probe/auth', jar: true },
  {
    label: '6 GET auth html',
    method: 'GET',
    uri: '/__probe/auth',
    jar: true,
    headers: { Accept: 'text/html' },
  },
  {
    label: '7 POST login',
    method: 'POST',
    uri: '/__probe/login',
    jar: true,
    form: { _token: '@token', email: 'u@example.com', password: 'secret' },
  },
  { label: '8 GET auth json after login', method: 'GET', uri: '/__probe/auth', jar: true },
  {
    label: '9 GET guest html',
    method: 'GET',
    uri: '/__probe/guest',
    jar: true,
    headers: { Accept: 'text/html' },
  },
  {
    label: '10 POST logout',
    method: 'POST',
    uri: '/__probe/logout',
    jar: true,
    form: { _token: '@token' },
  },
  { label: '11 GET auth json after logout', method: 'GET', uri: '/__probe/auth', jar: true },
];

function runOracle() {
  requireApp();
  const steps = STEPS.map((s) => ({
    label: s.label,
    method: s.method,
    uri: s.uri,
    jar: Boolean(s.jar),
    ...(s.headers ? { headers: s.headers } : {}),
    ...(s.form ? { form: s.form } : {}),
  }));
  const res = spawnSync(PHP, [oraclePath], {
    input: JSON.stringify({
      app_root: APP_ROOT,
      db_path: oracleDbPath('http-pipeline'),
      freeze_ms: FREEZE_MS,
      user: { id: 1, name: 'Test User', email: 'u@example.com', password_hash: HASH12 },
      steps,
    }),
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

class LWOracleUser extends Model {}
LWOracleUser.table = 'lw_users';
applyAuthenticatable(LWOracleUser);

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
          return {
            success: true,
            meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid ?? 0) },
          };
        },
      };
    },
  };
}

// Schema mirrors the oracle's: Laravel's default `sessions` table + the oracle's
// `lw_users`, seeded with the same pinned bcrypt hash.
function makeDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NULL,
      ip_address TEXT NULL,
      user_agent TEXT NULL,
      payload TEXT NOT NULL,
      last_activity INTEGER NOT NULL
    );
    CREATE TABLE lw_users (
      id INTEGER PRIMARY KEY,
      name TEXT NULL,
      email TEXT UNIQUE,
      email_verified_at TEXT NULL,
      password TEXT NOT NULL,
      remember_token TEXT NULL,
      created_at TEXT NULL,
      updated_at TEXT NULL
    );
  `);
  sqlite
    .prepare(
      `INSERT INTO lw_users
         (id, name, email, email_verified_at, password, remember_token, created_at, updated_at)
       VALUES (1, 'Test User', 'u@example.com', NULL, ?, NULL, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`
    )
    .run(HASH12);
  return { sqlite, db: d1(sqlite) };
}

// Synthetic route table. `routeKey` = `methods[0] + ' ' + uri`, so GET+HEAD
// routes key on the GET handler (exactly what a Laravel `Route::get()` produces).
const ROUTES = [
  { uri: '/__probe/state', methods: ['GET', 'HEAD'], middleware: ['web'] },
  { uri: '/__probe/state', methods: ['POST'], middleware: ['web'] },
  { uri: '/__probe/auth', methods: ['GET', 'HEAD'], middleware: ['web', 'auth'] },
  { uri: '/__probe/basic', methods: ['GET', 'HEAD'], middleware: ['web', 'auth.basic'] },
  { uri: '/__probe/guest', methods: ['GET', 'HEAD'], middleware: ['web', 'guest'] },
  { uri: '/__probe/login', methods: ['POST'], middleware: ['web'] },
  { uri: '/__probe/logout', methods: ['POST'], middleware: ['web'] },
  { uri: '/login', name: 'login', methods: ['GET', 'HEAD'], middleware: [] },
  // The oracle app defines a named `dashboard` route, and
  // RedirectIfAuthenticated::defaultRedirectUri() probes for it first — so the
  // synthetic table has to mirror that name or `guest` redirects to `/`.
  { uri: '/dashboard', name: 'dashboard', methods: ['GET', 'HEAD'], middleware: [] },
];

function json(data, status = 200) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) };
}

async function guardId(ctx) {
  const user = await ctx.auth.guard().user();
  return user ? user.getAuthIdentifier() : null;
}

function stateBody(ctx) {
  return {
    ok: true,
    token: ctx.session.token(),
    keys: Object.keys(ctx.session.all()),
    user: null, // filled below (async)
    path: ctx.request.path(),
    previous: ctx.session.previousUrl(),
  };
}

async function stateHandler(ctx) {
  const body = stateBody(ctx);
  body.user = await guardId(ctx);
  return json(body);
}

// Mirrors the oracle's probe bodies — every one carries the *current* session
// token so `@token` resolves from the immediately preceding response (login and
// logout regenerate the CSRF token).
const handlers = {
  'GET /__probe/state': stateHandler,
  'POST /__probe/state': stateHandler,
  'GET /__probe/auth': async (ctx) =>
    json({ user: await guardId(ctx), token: ctx.session.token() }),
  'GET /__probe/basic': async (ctx) =>
    json({ user: await guardId(ctx), token: ctx.session.token() }),
  'GET /__probe/guest': async (ctx) =>
    json({ guest: true, token: ctx.session.token() }),
  'POST /__probe/login': async (ctx) => {
    const ok = await ctx.auth
      .guard()
      .attempt({ email: ctx.request.input('email'), password: ctx.request.input('password') });
    return json({ ok, user: await guardId(ctx), token: ctx.session.token() });
  },
  'POST /__probe/logout': async (ctx) => {
    await ctx.auth.guard().logout();
    return json({ ok: true, user: await guardId(ctx), token: ctx.session.token() });
  },
  'GET /login': () => ({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: 'login',
  }),
};

function serializeJar(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// --------------------------------------------------------------- comparisons

function normHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = String(name).toLowerCase();
    if (key === 'date' || key === 'set-cookie') continue;
    out[key] = Array.isArray(value) ? String(value[0]) : String(value);
  }
  return out;
}

// Normalise the random session token out of a probe JSON body.
function normJsonBody(parsed) {
  if (parsed === null || typeof parsed !== 'object') return parsed;
  const out = { ...parsed };
  if (typeof out.token === 'string') out.token = TOKEN;
  return out;
}

function parseSetCookie(raw) {
  const parts = String(raw).split('; ');
  const first = parts[0];
  const eq = first.indexOf('=');
  const name = decodeURIComponent(first.slice(0, eq));
  const value = decodeURIComponent(first.slice(eq + 1));
  // Keep attribute order (parity), normalise only the Max-Age value.
  const attrs = parts.slice(1).map((a) => (a.toLowerCase().startsWith('max-age=') ? 'max-age=*' : a));
  return { name, value, attrs };
}

function normCookies(list) {
  return list.map(parseSetCookie).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function decodePayload(b64) {
  return Buffer.from(String(b64), 'base64').toString('utf8');
}

// Normalise the payload bytes: only the CSRF token attribute is random on both
// sides (the session id lives in the row `id` column, never inside the payload).
// Everything else — attribute order, `/`-escaping, flash shape — must be
// byte-identical.
function normPayloadText(text, token) {
  if (!token) return text;
  return text.split(token).join(TOKEN);
}

function normRow(row, token) {
  const payload = decodePayload(row.payload);
  let keys = null;
  try {
    keys = Object.keys(JSON.parse(payload)).sort();
  } catch {
    keys = null;
  }
  return {
    id_length: String(row.id).length,
    user_id: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    ip_address: row.ip_address,
    user_agent: row.user_agent,
    last_activity: Number(row.last_activity),
    keys,
    payload: normPayloadText(payload, token),
  };
}

// ------------------------------------------------------------------ JS replay

async function runJs(config) {
  const { sqlite, db } = makeDb();
  const table = normalizeTable(ROUTES);
  const models = { LWOracleUser };
  const jar = new Map();
  let lastToken = null;
  const out = [];

  for (const step of STEPS) {
    const headers = { host: 'localhost', 'user-agent': USER_AGENT, accept: 'application/json' };
    if (step.headers?.Accept) headers.accept = step.headers.Accept;
    if (jar.size) headers.cookie = serializeJar(jar);

    let body = '';
    if (step.form) {
      const form = {};
      for (const [k, v] of Object.entries(step.form)) form[k] = v === '@token' ? lastToken : v;
      body = new URLSearchParams(form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }

    const res = await handleHttp(
      { method: step.method, url: BASE + step.uri, headers, body },
      {
        table,
        handlers,
        config,
        env: { DB: db },
        db,
        models,
        clock: () => FREEZE_S,
        randomString: (n) => 'A'.repeat(n),
        strRandom: (n) => 'A'.repeat(n),
        clientIp: CLIENT_IP,
      }
    );
    if (!res) throw new Error(`compiled rung returned null for ${step.label} (no handler matched)`);

    for (const sc of res.setCookie) {
      const c = parseSetCookie(sc);
      const value = c.value;
      if (value === '' && /expires=/i.test(sc) && /max-age=0/i.test(sc)) jar.delete(c.name);
      else jar.set(c.name, value);
    }

    let parsed = null;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed.token === 'string') lastToken = parsed.token;

    const rows = sqlite
      .prepare('SELECT * FROM sessions ORDER BY id')
      .all()
      .map((r) => ({ ...r }));

    out.push({
      label: step.label,
      status: res.status,
      headers: res.headers,
      setCookie: res.setCookie,
      body: res.body,
      parsed,
      rows,
      jar: new Map(jar),
    });
  }
  return out;
}

function normPhpStep(step) {
  const rawRows = (step.session_rows || []).map((r) => ({
    id: r.id,
    user_id: r.user_id,
    ip_address: r.ip_address,
    user_agent: r.user_agent,
    payload: r.payload,
    last_activity: r.last_activity,
  }));
  return {
    label: step.label,
    status: step.status,
    headers: step.headers || {},
    setCookie: step.set_cookie || [],
    body: String(step.body ?? ''),
    parsed: (() => {
      try {
        return JSON.parse(String(step.body ?? ''));
      } catch {
        return null;
      }
    })(),
    rows: rawRows,
    sessionPlain: step.session_plain ?? null,
    xsrfPlain: step.xsrf_plain ?? null,
  };
}

test('compiled pipeline matches the PHP 8.3 web pipeline, 11 steps', { skip: noSqlite || noApp }, async () => {
  const oracle = runOracle();
  const config = oracle.config;
  assert.equal(config['session.driver'], 'database', 'oracle must run the database session driver');
  assert.equal(config['session.serialization'], 'json', 'oracle must use json session serialization');

  const js = await runJs(config);
  assert.equal(js.length, STEPS.length);
  const encryptor = createCookieEncryptor({
    keyBase64: String(config['app.key'] ?? '').replace(/^base64:/, ''),
    except: config['cookies.except'] ?? [],
  });

  for (let i = 0; i < STEPS.length; i += 1) {
    const mine = js[i];
    const php = normPhpStep(oracle.steps[i]);
    const where = `step ${php.label}`;

    // --- status ---------------------------------------------------------
    assert.equal(mine.status, php.status, `${where}: status`);

    // --- headers (minus date/set-cookie) --------------------------------
    assert.deepEqual(normHeaders(mine.headers), normHeaders(php.headers), `${where}: headers`);
    assert.equal(
      String(normHeaders(mine.headers)['cache-control']),
      'no-cache, private',
      `${where}: cache-control must be the Symfony default`
    );

    // --- Set-Cookie -----------------------------------------------------
    assert.deepEqual(
      normCookies(mine.setCookie).map((c) => ({ name: c.name, attrs: c.attrs })),
      normCookies(php.setCookie).map((c) => ({ name: c.name, attrs: c.attrs })),
      `${where}: Set-Cookie name+attributes (order preserved)`
    );
    for (const c of normCookies(mine.setCookie)) {
      assert.ok(c.value.length > 0, `${where}: cookie ${c.name} must carry a value`);
    }

    // --- body -----------------------------------------------------------
    const ct = String(normHeaders(php.headers)['content-type'] || '');
    if (ct.startsWith('application/json')) {
      if (php.status === 419) {
        // Laravel's debug 419 body embeds absolute file/line/trace paths.
        assert.equal(mine.parsed?.message, php.parsed?.message, `${where}: 419 message`);
      } else {
        assert.deepEqual(normJsonBody(mine.parsed), normJsonBody(php.parsed), `${where}: JSON body`);
      }
    } else {
      assert.equal(mine.body, php.body, `${where}: body`);
    }

    // --- session id / CSRF token (random on both sides) -----------------
    const sid = php.sessionPlain;
    const xsrf = php.xsrfPlain;
    assert.ok(sid, `${where}: oracle must report session_plain`);
    assert.equal(String(sid).length, 40, `${where}: oracle session id length`);
    assert.ok(xsrf, `${where}: oracle must report xsrf_plain`);
    assert.equal(String(xsrf).length, 40, `${where}: oracle CSRF token length`);

    const jsSid = await jarPlain(encryptor, mine.jar, config['session.cookie']);
    const jsXsrf = await jarPlain(encryptor, mine.jar, 'XSRF-TOKEN');
    assert.equal(String(jsSid).length, 40, `${where}: compiled session id length`);
    assert.equal(String(jsXsrf).length, 40, `${where}: compiled CSRF token length`);

    // --- session row + payload bytes ------------------------------------
    // Each side is normalised with its *own* two random values, so the payload
    // bytes must then be byte-identical (attribute order, `/`-escaping, flash
    // shape, login/remember keys, everything).
    const mineRows = mine.rows.map((r) => normRow(r, jsXsrf));
    const phpRows = php.rows.map((r) => normRow(r, xsrf));
    assert.equal(mineRows.length, phpRows.length, `${where}: session row count`);
    assert.deepEqual(mineRows, phpRows, `${where}: session rows (payload bytes + columns)`);

    // --- cookie jar -----------------------------------------------------
    const phpJar = Object.keys(oracle.steps[i].jar_after || {}).sort();
    const jsJar = [...mine.jar.keys()].sort();
    assert.deepEqual(jsJar, phpJar, `${where}: cookie jar names`);
  }
});

// Decrypt a request-cookie value out of a jar with the EncryptCookies scheme.
async function jarPlain(encryptor, jar, name) {
  const raw = jar.get(name);
  if (raw === undefined) return null;
  const out = await encryptor.decryptRequestCookies({ [name]: raw });
  return out[name];
}

// ---------------------------------------------------------------------------
// 3. fail-loud guards
// ---------------------------------------------------------------------------

async function callPipeline(mutate) {
  const { db } = makeDb();
  const config = baseConfig();
  const table = normalizeTable(ROUTES);
  const options = {
    table,
    handlers,
    config,
    env: { DB: db },
    db,
    models: { LWOracleUser },
    clock: () => FREEZE_S,
    randomString: (n) => 'A'.repeat(n),
    strRandom: (n) => 'A'.repeat(n),
    clientIp: CLIENT_IP,
  };
  if (mutate) mutate(options);
  return handleHttp(
    {
      method: 'GET',
      url: BASE + '/__probe/state',
      headers: { host: 'localhost', accept: 'application/json' },
      body: '',
    },
    options
  );
}

function baseConfig() {
  return {
    'app.key': 'base64:3xd/I1bUWfA8Rugdso1ILBcgFHCBKkPtC8GLvAsSYHY=',
    'app.url': 'http://localhost',
    'session.driver': 'database',
    'session.cookie': 'laravel-session',
    'session.lifetime': 120,
    'session.path': '/',
    'session.domain': null,
    'session.secure': null,
    'session.http_only': true,
    'session.same_site': 'lax',
    'session.serialization': 'json',
    'session.table': 'sessions',
    'session.encrypt': false,
    'cookies.except': [],
    'csrf.except': [],
    'auth.defaults.guard': 'web',
    'auth.guards.web': { driver: 'session', provider: 'users' },
    'auth.providers.users': { driver: 'eloquent', model: 'LWOracleUser' },
    'auth.hash_key': 'base64:3xd/I1bUWfA8Rugdso1ILBcgFHCBKkPtC8GLvAsSYHY=',
    'auth.timebox_duration': 200000,
    'auth.rehash_on_login': true,
    'hashing.driver': 'bcrypt',
    'hashing.bcrypt.rounds': '12',
    'hashing.bcrypt.verify': true,
  };
}

test('fail loud: unknown route middleware is rejected', async () => {
  await assert.rejects(
    callPipeline((o) => {
      o.table = normalizeTable([
        { uri: '/__probe/state', methods: ['GET', 'HEAD'], middleware: ['web', 'can:update,post'] },
      ]);
    }),
    /not supported by the compiled rung/
  );
});

// ---------------------------------------------------------------------------
// A guard PORT through the real pipeline: `handleHttp` → `createAuthManager` →
// `PortedGuard` (registry.json → "guards"). The driver belongs to the app
// (`Auth::extend('seal', fn)`), so the app's JS answers `user()` while the
// `auth:seal` middleware, `Authenticate::shouldUse()`, `auth()->user()` and the
// unauthenticated answer stay the compiled rung's. No oracle: the port is app
// code, and what is pinned here is the compiled half + the wiring.
// ---------------------------------------------------------------------------

test('guard port: auth:<driver> authenticates through the app port, and a guest is refused', { skip: noSqlite }, async () => {
  const { db } = makeDb();
  const config = { ...baseConfig(), 'auth.guards.seal': { driver: 'seal' } };
  const table = normalizeTable([
    { uri: '/__probe/seal', methods: ['GET', 'HEAD'], middleware: ['web', 'auth:seal'] },
  ]);
  let portCalls = 0;
  const options = {
    table,
    handlers: {
      'GET /__probe/seal': async (ctx) => {
        const user = await ctx.auth.guard().user();
        return json({
          id: user === null ? null : user.id,
          name: user === null ? null : user.name,
          defaultGuard: ctx.auth.getDefaultDriver(),
        });
      },
    },
    config,
    env: { DB: db },
    db,
    models: { LWOracleUser },
    guardPorts: {
      seal: {
        async user(ctx) {
          portCalls += 1;
          const header = ctx.request.header('x-seal');
          return header ? { id: Number(header), name: 'sealed-' + header } : null;
        },
      },
    },
    clock: () => FREEZE_S,
    randomString: (n) => 'A'.repeat(n),
    strRandom: (n) => 'A'.repeat(n),
    clientIp: CLIENT_IP,
  };

  const hit = await handleHttp(
    {
      method: 'GET',
      url: BASE + '/__probe/seal',
      headers: { host: 'localhost', accept: 'application/json', 'x-seal': '7' },
      body: '',
    },
    options
  );
  assert.equal(hit.status, 200, 'the port answered a user, so the middleware passed');
  assert.deepEqual(JSON.parse(hit.body), {
    id: 7,
    name: 'sealed-7',
    defaultGuard: 'seal',
  });
  assert.equal(portCalls, 1, 'the port ran once for the request, not once per question');

  const guest = await handleHttp(
    {
      method: 'GET',
      url: BASE + '/__probe/seal',
      headers: { host: 'localhost', accept: 'application/json' },
      body: '',
    },
    options
  );
  assert.equal(guest.status, 401, 'a JSON request answers 401, never a 200 with a null user');
  assert.equal(JSON.parse(guest.body).message, 'Unauthenticated.');
  assert.equal(portCalls, 2, 'the second request resolved the user once more');
});

test('guest redirect: url.intended = the referer, then the previous session URL, then the root (probed)', { skip: noSqlite }, async () => {
  // Redirector::guest() (Redirector.php:71-84) stores the intended URL:
  //   a GET that matched a route and does not want JSON  => UrlGenerator::full()
  //   anything else => UrlGenerator::previous() (UrlGenerator.php:162-175):
  //     `$referrer = $this->request->headers->get('referer');`
  //     `$url = $referrer ? $this->to($referrer) : $this->getPreviousUrlFromSession();`
  //     `if ($url) { return $url; } ... return $this->to('/');`
  // Probed against the vendor (Laravel 13.37 on PHP 8.3): referer + session =>
  // the REFERER; session only => the session value; neither => 'http://localhost'
  // (`to('/')` has no trailing slash). The kernel asked the session first
  // (audit #851) and stored nothing at all when both were absent, so
  // `redirect()->intended()` fell to its default instead of the root.
  // The non-GET path is exercised with a POST, because a routed GET takes the
  // `full()` branch above (its own URL) - also probed.
  const table = normalizeTable([...ROUTES, { uri: '/__probe/auth', methods: ['POST'], middleware: ['web', 'auth'] }]);
  const handlers = {
    'GET /__probe/state': stateHandler,
    'GET /__probe/auth': async (ctx) => json({ user: await guardId(ctx) }),
    'POST /__probe/auth': async (ctx) => json({ user: await guardId(ctx) }),
  };
  const makeOptions = () => {
    const { db, sqlite } = makeDb();
    return {
      sqlite,
      options: {
        table,
        handlers,
        config: baseConfig(),
        env: { DB: db },
        db,
        models: { LWOracleUser },
        clock: () => FREEZE_S,
        randomString: (n) => 'A'.repeat(n),
        strRandom: (n) => 'A'.repeat(n),
        clientIp: CLIENT_IP,
      },
    };
  };
  const step = async (options, jar, method, uri, { headers = {}, body = '' } = {}) => {
    const h = { host: 'localhost', 'user-agent': USER_AGENT, accept: 'text/html', ...headers };
    if (jar.size) h.cookie = serializeJar(jar);
    if (body !== '') h['content-type'] = 'application/x-www-form-urlencoded';
    const res = await handleHttp({ method, url: BASE + uri, headers: h, body }, options);
    if (!res) throw new Error(`no handler matched ${method} ${uri}`);
    for (const sc of res.setCookie) {
      const c = parseSetCookie(sc);
      if (c.value === '' && /expires=/i.test(sc) && /max-age=0/i.test(sc)) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }
    return res;
  };
  // A CSRF token for the session in `jar`. An ajax GET does NOT record
  // `_previous.url` (StartSession::storeCurrentUrl skips it), so case 3 can
  // reach the root floor.
  const tokenOf = async (options, jar, ajax) => {
    const headers = { accept: 'application/json' };
    if (ajax) headers['x-requested-with'] = 'XMLHttpRequest';
    const res = await step(options, jar, 'GET', '/__probe/state', { headers });
    assert.equal(res.status, 200);
    return JSON.parse(res.body).token;
  };
  const intendedOf = (sqlite) => {
    for (const row of sqlite.prepare('SELECT payload FROM sessions').all()) {
      const stored = JSON.parse(decodePayload(row.payload));
      if (stored && stored.url && stored.url.intended) return stored.url.intended;
    }
    return null;
  };

  // (1) a routed GET takes full(), so the intended URL is the request's own URL.
  {
    const { sqlite, options } = makeOptions();
    const jar = new Map();
    assert.equal((await step(options, jar, 'GET', '/__probe/state')).status, 200);
    const res = await step(options, jar, 'GET', '/__probe/auth');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, BASE + '/login');
    assert.equal(intendedOf(sqlite), BASE + '/__probe/auth', 'a routed GET intends its own URL');
  }
  // (2) a POST with no referer: the session's `_previous.url` (the earlier GET).
  {
    const { sqlite, options } = makeOptions();
    const jar = new Map();
    const token = await tokenOf(options, jar, false);
    const res = await step(options, jar, 'POST', '/__probe/auth', { body: '_token=' + token });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, BASE + '/login');
    assert.equal(intendedOf(sqlite), BASE + '/__probe/state', 'no referer: the session previous URL');
  }
  // (3) the referer wins over the session value.
  {
    const { sqlite, options } = makeOptions();
    const jar = new Map();
    const token = await tokenOf(options, jar, false);
    const res = await step(options, jar, 'POST', '/__probe/auth', {
      headers: { referer: 'http://example.com/from-referer' },
      body: '_token=' + token,
    });
    assert.equal(res.status, 302);
    assert.equal(intendedOf(sqlite), 'http://example.com/from-referer', 'the referer wins');
  }
  // (4) neither: UrlGenerator::to('/') floors it at the site root.
  {
    const { sqlite, options } = makeOptions();
    const jar = new Map();
    const token = await tokenOf(options, jar, true);
    const res = await step(options, jar, 'POST', '/__probe/auth', { body: '_token=' + token });
    assert.equal(res.status, 302);
    assert.equal(intendedOf(sqlite), BASE, 'the root floor (to("/") has no trailing slash)');
  }
});

test('csrf: preventRequestForgery(allowSameSite/originOnly) reaches the middleware (audit #801)', { skip: noSqlite }, async () => {
  // Laravel's `->withMiddleware(fn (Middleware $m) => $m->preventRequestForgery(
  // originOnly: true, allowSameSite: true))` (Foundation/Configuration/Middleware.php:605-612)
  // sets PreventRequestForgery::$allowSameSite / $originOnly, which the middleware
  // reads in hasValidOrigin() (:151 same-site, :155 origin-only) and
  // shouldAddXsrfTokenCookie() (:205). Both config dumps wrote the flags as
  // `csrf.allow_same_site` / `csrf.origin_only` and NOTHING in the runtime read
  // them, so an app that asked for origin-only verification silently kept the
  // token check and the XSRF cookie.
  const post = async (csrfConfig, headers, body = '') => {
    const { db } = makeDb();
    const res = await handleHttp(
      {
        method: 'POST',
        url: BASE + '/__probe/state',
        headers: {
          host: 'localhost',
          'user-agent': USER_AGENT,
          'content-type': 'application/x-www-form-urlencoded',
          ...headers,
        },
        body,
      },
      {
        table: normalizeTable(ROUTES),
        handlers,
        config: { ...baseConfig(), ...csrfConfig },
        env: { DB: db },
        db,
        models: { LWOracleUser },
        clock: () => FREEZE_S,
        randomString: (n) => 'A'.repeat(n),
        strRandom: (n) => 'A'.repeat(n),
        clientIp: CLIENT_IP,
      }
    );
    if (!res) throw new Error('no handler matched POST /__probe/state');
    return res;
  };
  const hasXsrf = (res) => res.setCookie.some((c) => /^XSRF-TOKEN=/.test(c));

  // A tokenless same-site POST is refused by default...
  assert.equal((await post({}, { 'sec-fetch-site': 'same-site' })).status, 419);
  // ...allowed once the app turned the flag on...
  assert.equal((await post({ 'csrf.allow_same_site': true }, { 'sec-fetch-site': 'same-site' })).status, 200);
  // ...and same-origin passes either way.
  assert.equal((await post({}, { 'sec-fetch-site': 'same-origin' })).status, 200);
  // `originOnly` throws OriginMismatchException - a plain Exception, so Laravel
  // answers 500 - and stops the XSRF cookie from being added (:205).
  const sameSite = await post({ 'csrf.origin_only': true }, { 'sec-fetch-site': 'same-site' });
  assert.equal(sameSite.status, 500);
  assert.equal(hasXsrf(sameSite), false, 'origin-only drops the XSRF cookie');
  const sameOrigin = await post({ 'csrf.origin_only': true }, { 'sec-fetch-site': 'same-origin' });
  assert.equal(sameOrigin.status, 200);
  assert.equal(hasXsrf(sameOrigin), false, 'origin-only drops the XSRF cookie');
  // The token check still wins when both bypass flags are irrelevant.
  const noToken = await post({ 'csrf.allow_same_site': true }, {});
  assert.equal(noToken.status, 419, 'no token at all is still a mismatch');
});

test('fail loud: throttle middleware without a cache store', async () => {
  await assert.rejects(
    callPipeline((o) => {
      o.table = normalizeTable([
        { uri: '/__probe/state', methods: ['GET', 'HEAD'], middleware: ['web', 'throttle:60,1'] },
      ]);
    }),
    /cache store/
  );
});

// ---------------------------------------------------------------------------
// The method-not-allowed path (Laravel's AbstractRouteCollection):
//   - an OPTIONS request gets the automatic OPTIONS response (200, an empty
//     body, the Allow header with the verbs the URI accepts);
//   - any other method raises MethodNotAllowedHttpException: the status is the
//     exception's own - 405 - with or without an `errors/405` view (only the
//     BODY follows the view; `convertExceptionToResponse` uses
//     `$e->getStatusCode()`). Probed with the PHP oracle: no view, debug off,
//     `Accept: application/json` -> 405, `Allow: POST`,
//     `{"message":"The GET method is not supported for route queue-demo.
//     Supported methods: POST."}`.
// ---------------------------------------------------------------------------

async function callMethod(method, uri, mutate, headers) {
  const { db } = makeDb();
  const config = baseConfig();
  const options = {
    table: normalizeTable(ROUTES),
    handlers,
    config,
    env: { DB: db },
    db,
    models: { LWOracleUser },
    clock: () => FREEZE_S,
    randomString: (n) => 'A'.repeat(n),
    strRandom: (n) => 'A'.repeat(n),
    clientIp: CLIENT_IP,
  };
  if (mutate) mutate(options);
  return handleHttp(
    { method, url: BASE + uri, headers: { host: 'localhost', ...(headers || {}) }, body: '' },
    options
  );
}

test('fail loud: a JSON body with a lossy 64-bit integer stops loudly (LW006)', async () => {
  const { db } = makeDb();
  const config = baseConfig();
  // PHP holds 9223372036854775807 exactly; a JS number rounds it to
  // 9223372036854776000. The decode error used to be swallowed into `json =
  // null`, so `$request->json('id')` answered null - silently wrong.
  await assert.rejects(
    handleHttp(
      {
        method: 'POST',
        url: BASE + '/__probe/state',
        headers: { host: 'localhost', 'content-type': 'application/json' },
        body: '{"id":9223372036854775807}',
      },
      {
        table: normalizeTable(ROUTES),
        handlers,
        config,
        env: { DB: db },
        db,
        models: { LWOracleUser },
        clock: () => FREEZE_S,
        randomString: (n) => 'A'.repeat(n),
        strRandom: (n) => 'A'.repeat(n),
        clientIp: CLIENT_IP,
      }
    ),
    (e) => e.code === 'LW006'
  );
});

test('router: an OPTIONS request gets the automatic OPTIONS response', async () => {
  const res = await callMethod('OPTIONS', '/__probe/state', (o) => {
    o.table = normalizeTable([
      { uri: '/__probe/state', methods: ['GET', 'HEAD'] },
      { uri: '/__probe/state', methods: ['POST'] },
    ]);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body, '');
  // Laravel: implode(',', $methods) - the verbs the URI accepts, no spaces.
  assert.equal(res.headers.allow, 'GET,HEAD,POST');
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache, private');
});

test('router: a method that is not allowed answers Laravel\'s 405', async () => {
  const res = await callMethod('DELETE', '/__probe/state', (o) => {
    o.table = normalizeTable([{ uri: '/__probe/state', methods: ['GET', 'HEAD'] }]);
  });
  // Laravel keeps the exception's status with or without an errors/405 view
  // (Handler::renderHttpException -> convertExceptionToResponse ->
  // `$e->getStatusCode()`); the Allow header is Symfony's
  // `implode(', ', $allow)` and the cache header is Laravel's.
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache, private');
  // No compiled errors/405 view: the framework's own error page is a framework
  // asset the build does not ship, so the edge answers the minimal page.
  assert.equal(res.body, '<html><body><h1>405</h1><p>Method Not Allowed</p></body></html>');
});

test('router: a JSON request for a method that is not allowed gets Laravel\'s message', async () => {
  const res = await callMethod(
    'DELETE',
    '/__probe/state',
    (o) => {
      o.table = normalizeTable([{ uri: '/__probe/state', methods: ['GET', 'HEAD'] }]);
    },
    { accept: 'application/json' }
  );
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
  assert.equal(res.headers['content-type'], 'application/json');
  // Laravel's prepareJsonResponse: convertExceptionToArray (debug off) answers
  // the message, JSON_PRETTY_PRINT (4 spaces), no trailing newline. The message
  // is AbstractRouteCollection::requestMethodNotAllowed's:
  // 'The %s method is not supported for route %s. Supported methods: %s.'
  assert.equal(
    res.body,
    '{\n    "message": "The DELETE method is not supported for route __probe/state. Supported methods: GET, HEAD."\n}'
  );
});

test('router: a method that is not allowed renders the compiled errors/405 view', async () => {
  const res = await callMethod('DELETE', '/__probe/state', (o) => {
    o.table = normalizeTable([{ uri: '/__probe/state', methods: ['GET', 'HEAD'] }]);
    // The compiled view is `renderErrorView` (dist/src/error-renderer.mjs); the
    // app's own `errors/405` (or its `errors/4xx` fallback) reaches it here.
    o.renderErrorView = (status, request, ctx, error) =>
      status === 405 ? '<h1>app 405</h1><p>' + error.message + '</p>' : null;
  });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
  assert.match(res.body, /^<h1>app 405<\/h1><p>The DELETE method is not supported for route __probe\/state\./);
});

test('router: a URI that matches no route is left to the platform', async () => {
  const res = await callMethod('GET', '/__probe/nothing', (o) => {
    o.table = normalizeTable([{ uri: '/__probe/state', methods: ['GET', 'HEAD'] }]);
  });
  assert.equal(res, null);
});

test('throttle over the D1 cache store: first N allowed, then 429', async (t) => {
  if (noSqlite) return t.skip(noSqlite);
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    CREATE TABLE cache ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL, "expiration" INTEGER NOT NULL);
    CREATE TABLE cache_locks ("key" TEXT PRIMARY KEY, "owner" TEXT NOT NULL, "expiration" INTEGER NOT NULL);
  `);
  const cache = createDatabaseCache({
    db,
    config: { 'cache.table': 'cache', 'cache.prefix': 'laravel-cache-', 'cache.lock_table': 'cache_locks' },
  });
  const table = normalizeTable([
    { uri: '/__probe/state', methods: ['GET', 'HEAD'], middleware: ['web', 'throttle:2,1'] },
  ]);
  const call = () =>
    handleHttp(
      {
        method: 'GET',
        url: BASE + '/__probe/state',
        headers: { host: 'localhost', accept: 'application/json' },
        body: '',
      },
      {
        table,
        handlers: { 'GET /__probe/state': handlers['GET /__probe/state'] },
        config: baseConfig(),
        env: { DB: db },
        db,
        cache,
        models: { LWOracleUser },
        clock: () => FREEZE_S,
        randomString: (n) => 'A'.repeat(n),
        strRandom: (n) => 'A'.repeat(n),
        clientIp: CLIENT_IP,
      }
    );

  const r1 = await call();
  const r2 = await call();
  const r3 = await call();
  assert.equal(r1.status, 200, 'hit #1 within throttle:2,1');
  assert.equal(r2.status, 200, 'hit #2 within throttle:2,1');
  assert.equal(r3.status, 429, 'hit #3 exceeds throttle:2,1');
});

// The `auth.basic` middleware (Illuminate\Auth\Middleware\AuthenticateWithBasicAuth):
// the Basic credentials are verified and the user is logged in; a failure is a 401
// with Symfony's `WWW-Authenticate: Basic realm="Basic"` challenge.
function basicHeader(user, password) {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
}

test('auth.basic: a missing Basic header is a 401 with the challenge', async () => {
  const { db } = makeDb();
  const res = await handleHttp(
    { method: 'GET', url: BASE + '/__probe/basic', headers: { host: 'localhost', accept: 'application/json' }, body: '' },
    {
      table: normalizeTable(ROUTES),
      handlers,
      config: baseConfig(),
      env: { DB: db },
      db,
      models: { LWOracleUser },
      clock: () => FREEZE_S,
      clientIp: CLIENT_IP,
    }
  );
  assert.equal(res.status, 401);
  // Symfony's UnauthorizedHttpException('Basic') — the challenge is the
  // exception's argument, so the header is exactly `Basic`.
  assert.equal(res.headers['www-authenticate'], 'Basic');
});

test('auth.basic: wrong credentials are a 401, valid credentials log the user in', async () => {
  const { db } = makeDb();
  const call = (authorization) =>
    handleHttp(
      {
        method: 'GET',
        url: BASE + '/__probe/basic',
        headers: { host: 'localhost', accept: 'application/json', authorization },
        body: '',
      },
      {
        table: normalizeTable(ROUTES),
        handlers,
        config: baseConfig(),
        env: { DB: db },
        db,
        models: { LWOracleUser },
        clock: () => FREEZE_S,
        clientIp: CLIENT_IP,
      }
    );

  const bad = await call(basicHeader('u@example.com', 'wrong'));
  assert.equal(bad.status, 401);
  assert.equal(bad.headers['www-authenticate'], 'Basic');

  const ok = await call(basicHeader('u@example.com', 'secret'));
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).user, 1);
});

test('the service adapters (storage/mail/queue) reach the handler context', async () => {
  const { db } = makeDb();
  const sent = [];
  const storage = {
    async put(k, v) { sent.push(['put', k, v]); return k; },
    async getText(k) { return sent.find((s) => s[1] === k) ? 'body' : null; },
    async exists(k) { return sent.some((s) => s[1] === k); },
    async delete(k) { sent.push(['delete', k]); },
  };
  const mail = { async send(m) { sent.push(['mail', m.to]); return { id: 'x' }; } };
  const queue = { async push(q, p) { sent.push(['queue', q, p]); return { id: 'q' }; } };
  const table = normalizeTable([{ uri: '/__probe/services', methods: ['GET', 'HEAD'], middleware: ['web'] }]);
  const res = await handleHttp(
    { method: 'GET', url: BASE + '/__probe/services', headers: { host: 'localhost', accept: 'application/json' }, body: '' },
    {
      table,
      handlers: {
        'GET /__probe/services': async (ctx) => {
          await ctx.storage.put('a.txt', 'x');
          const v = await ctx.storage.getText('a.txt');
          await ctx.mail.send({ to: 'a@b.co' });
          await ctx.queue.push('default', { id: 1 });
          return json({ v, sent: sent.length });
        },
      },
      config: baseConfig(),
      env: { DB: db },
      db,
      models: { LWOracleUser },
      storage,
      mail,
      queue,
      clock: () => FREEZE_S,
      clientIp: CLIENT_IP,
    }
  );
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).v, 'body');
  assert.deepEqual(
    sent.map((s) => s[0]),
    ['put', 'mail', 'queue']
  );
});

// An unhandled exception inside a compiled handler has no `.status`: Laravel's
// Handler::render() prepares it into a 500 (`prepareException()` wraps it in an
// HttpException with status 500) and `prepareResponse()` renders errors/500 -
// or prepareJsonResponse() for an expectsJson request. The compiled rung used to
// rethrow here, so the exception escaped handleHttp (and the Worker's fetch, which
// has no catch) and the platform answered "error code: 1101" instead of a 500.
test('an unhandled exception answers a 500 (app page / PrepareJsonResponse body)', async () => {
  const { db } = makeDb();
  const table = normalizeTable([{ uri: '/__probe/boom', methods: ['GET', 'HEAD'], middleware: ['web'] }]);
  const handlers = {
    'GET /__probe/boom': async () => {
      throw new Error('kaboom');
    },
  };
  const call = (accept, extra = {}) =>
    handleHttp(
      { method: 'GET', url: BASE + '/__probe/boom', headers: { host: 'localhost', accept }, body: '' },
      {
        table,
        handlers,
        config: baseConfig(),
        env: { DB: db },
        db,
        models: { LWOracleUser },
        clock: () => FREEZE_S,
        clientIp: CLIENT_IP,
        ...extra,
      }
    );

  // HTML: the status-only body when the build compiled no error view for the app.
  const html = await call('text/html');
  assert.equal(html.status, 500);
  assert.equal(html.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(html.body, /<h1>500<\/h1>/);

  // The compiled errors/500 view wins when the ctx carries renderErrorView (the
  // Worker hands `options.renderErrorView` down to the handler ctx).
  const withView = await call('text/html', { renderErrorView: (status) => `<h1>app ${status}</h1>` });
  assert.equal(withView.status, 500);
  assert.equal(withView.body, '<h1>app 500</h1>');

  // JSON: Handler::prepareJsonResponse() -> convertExceptionToArray() answers
  // ['message' => 'Server Error'] outside debug, pretty-printed
  // (JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES).
  const json = await call('application/json');
  assert.equal(json.status, 500);
  assert.equal(json.headers['content-type'], 'application/json');
  assert.equal(json.body, '{\n    "message": "Server Error"\n}');
});

test('fail loud: session.encrypt=true and unknown drivers', async () => {
  await assert.rejects(
    callPipeline((o) => {
      o.config['session.encrypt'] = true;
    }),
    /SESSION_ENCRYPT=true/
  );

  await assert.rejects(
    callPipeline((o) => {
      o.config['session.driver'] = 'redis';
    }),
    /session driver 'redis'/
  );
});

test('routes with no compiled handler return null (assets served by the worker)', async () => {
  const res = await callPipeline((o) => {
    o.table = normalizeTable([{ uri: '/storage/asset.png', methods: ['GET', 'HEAD'] }]);
    o.handlers = {};
  });
  assert.equal(res, null);
});

// status-only smoke tests for the three interim error codes (419/429/500).
test('status-only: missing CSRF token returns 419', async () => {
  const { db } = makeDb();
  const config = baseConfig();
  const table = normalizeTable(ROUTES);
  const res = await handleHttp(
    { method: 'POST', url: BASE + '/__probe/state', headers: { host: 'localhost', accept: 'application/json' }, body: '' },
    { table, handlers, config, env: { DB: db }, db, models: { LWOracleUser }, clock: () => FREEZE_S, clientIp: CLIENT_IP }
  );
  assert.equal(res.status, 419);
});

test('status-only: handler throwing HttpError(500) renders 500', async () => {
  const { HttpError } = await import('../http.mjs');
  const { db } = makeDb();
  const config = baseConfig();
  const table = normalizeTable([{ uri: '/__probe/boom', methods: ['GET', 'HEAD'], middleware: ['web'] }]);
  const boomHandlers = { 'GET /__probe/boom': async () => { throw new HttpError('boom', 500); } };
  const res = await handleHttp(
    { method: 'GET', url: BASE + '/__probe/boom', headers: { host: 'localhost', accept: 'application/json' }, body: '' },
    { table, handlers: boomHandlers, config, env: { DB: db }, db, models: { LWOracleUser }, clock: () => FREEZE_S, clientIp: CLIENT_IP }
  );
  assert.equal(res.status, 500);
});

test('status-only: renderErrorView hook overrides 419 body', async () => {
  const { db } = makeDb();
  const config = baseConfig();
  const table = normalizeTable(ROUTES);
  const res = await handleHttp(
    { method: 'POST', url: BASE + '/__probe/state', headers: { host: 'localhost', accept: 'application/json' }, body: '' },
    { table, handlers, config, env: { DB: db }, db, models: { LWOracleUser }, clock: () => FREEZE_S, clientIp: CLIENT_IP,
      renderErrorView: (status) => (status === 419 ? '<html><body>custom-419</body></html>' : null) }
  );
  assert.equal(res.status, 419);
  assert.match(res.body, /custom-419/);
});

// status-only smoke tests for the three interim error codes (419/429/500).
test('status-only: missing CSRF token returns 419', async () => {
  const { db } = makeDb();
  const config = baseConfig();
  const table = normalizeTable(ROUTES);
  const res = await handleHttp(
    { method: 'POST', url: BASE + '/__probe/state', headers: { host: 'localhost', accept: 'application/json' }, body: '' },
    { table, handlers, config, env: { DB: db }, db, models: { LWOracleUser }, clock: () => FREEZE_S, clientIp: CLIENT_IP }
  );
  assert.equal(res.status, 419);
});

test('status-only: handler throwing HttpError(500) renders 500', async () => {
  const { HttpError } = await import('../http.mjs');
  const { db } = makeDb();
  const config = baseConfig();
  const table = normalizeTable([{ uri: '/__probe/boom', methods: ['GET', 'HEAD'], middleware: ['web'] }]);
  const boomHandlers = { 'GET /__probe/boom': async () => { throw new HttpError('boom', 500); } };
  const res = await handleHttp(
    { method: 'GET', url: BASE + '/__probe/boom', headers: { host: 'localhost', accept: 'application/json' }, body: '' },
    { table, handlers: boomHandlers, config, env: { DB: db }, db, models: { LWOracleUser }, clock: () => FREEZE_S, clientIp: CLIENT_IP }
  );
  assert.equal(res.status, 500);
});

// status-only smoke tests for the three interim error codes (419/429/500).
test('status-only: missing CSRF token returns 419', async () => {
  const { db } = makeDb();
  const config = baseConfig();
  const table = normalizeTable(ROUTES);
  const res = await handleHttp(
    { method: 'POST', url: BASE + '/__probe/state', headers: { host: 'localhost', accept: 'application/json' }, body: '' },
    { table, handlers, config, env: { DB: db }, db, models: { LWOracleUser }, clock: () => FREEZE_S, clientIp: CLIENT_IP }
  );
  assert.equal(res.status, 419);
});

test('status-only: handler throwing HttpError(500) renders 500', async () => {
  const { HttpError } = await import('../http.mjs');
  const { db } = makeDb();
  const config = baseConfig();
  const table = normalizeTable([{ uri: '/__probe/boom', methods: ['GET', 'HEAD'], middleware: ['web'] }]);
  const boomHandlers = { 'GET /__probe/boom': async () => { throw new HttpError('boom', 500); } };
  const res = await handleHttp(
    { method: 'GET', url: BASE + '/__probe/boom', headers: { host: 'localhost', accept: 'application/json' }, body: '' },
    { table, handlers: boomHandlers, config, env: { DB: db }, db, models: { LWOracleUser }, clock: () => FREEZE_S, clientIp: CLIENT_IP }
  );
  assert.equal(res.status, 500);
});

test('status-only: renderErrorView hook overrides 419 body', async () => {
  const { db } = makeDb();
  const config = baseConfig();
  const table = normalizeTable(ROUTES);
  const res = await handleHttp(
    { method: 'POST', url: BASE + '/__probe/state', headers: { host: 'localhost', accept: 'application/json' }, body: '' },
    { table, handlers, config, env: { DB: db }, db, models: { LWOracleUser }, clock: () => FREEZE_S, clientIp: CLIENT_IP,
      renderErrorView: (status) => (status === 419 ? '<html><body>custom-419</body></html>' : null) }
  );
  assert.equal(res.status, 419);
  assert.match(res.body, /custom-419/);
});

test('request: a multipart body is parsed (the fields + the uploaded file)', () => {
  const boundary = '----lwBoundary';
  const body =
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="title"\r\n\r\n' +
    'Shadow upload\r\n' +
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="avatar"; filename="a b.txt"\r\n' +
    'Content-Type: text/plain\r\n\r\n' +
    'hello file\r\n' +
    `--${boundary}--\r\n`;
  const req = buildRequest({
    method: 'POST',
    url: 'http://localhost/upload',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: new TextEncoder().encode(body),
  });
  assert.equal(req.input('title'), 'Shadow upload');
  const file = req.file('avatar');
  assert.equal(file.getClientOriginalName(), 'a b.txt');
  assert.equal(file.getClientOriginalExtension(), 'txt');
  assert.equal(file.getClientMimeType(), 'text/plain');
  assert.equal(file.getSize(), 10);
  assert.equal(new TextDecoder().decode(file.get()), 'hello file');
  assert.equal(req.hasFile('avatar'), true);
  assert.equal(req.hasFile('nope'), false);
  // allFiles(): the map of the uploaded files (Laravel's FileBag::all()).
  assert.equal(Object.keys(req.allFiles()).length, 1);
  assert.equal(req.allFiles().avatar.getClientOriginalName(), 'a b.txt');
  assert.equal(req.file('nope'), null);
  // The files are in the validated data (Laravel's all() merges them).
  assert.equal(req.all().avatar.getSize(), 10);
  // ... but the body wins on a key that is in both.
  assert.equal(typeof req.all().title, 'string');
});

test('request: the method override follows Symfony (the header wins, A-Z only)', () => {
  // Symfony's getMethod(): the X-HTTP-Method-Override header wins over the
  // `_method` parameter (body/query), and an override that is not A-Z throws
  // a SuspiciousOperationException ('Invalid HTTP method override.') - which
  // Laravel does not map, so the answer is a 500.
  const req = buildRequest({
    method: 'POST',
    url: 'http://localhost/x',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-http-method-override': 'PUT' },
    body: '_method=DELETE',
  });
  assert.equal(req.methodOverride(), 'PUT', 'the header wins over the _method parameter');
  const req2 = buildRequest({
    method: 'POST',
    url: 'http://localhost/x',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '_method=DELETE',
  });
  assert.equal(req2.methodOverride(), 'DELETE', 'the _method parameter is honoured');
  assert.throws(
    () =>
      buildRequest({
        method: 'POST',
        url: 'http://localhost/x',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-http-method-override': 'PU T' },
        body: '',
      }),
    /Invalid HTTP method override/,
  );
});

test('request: the _method override reads the FORM bag, not a JSON body (probed)', () => {
  // Symfony's getMethod() (http-foundation 7.4, Request.php:1263-1300):
  //   `$method = $this->headers->get('X-HTTP-METHOD-OVERRIDE');`
  //   `if (!$method && $override) $method = $this->request->get('_method',
  //      $this->query->get('_method', 'POST'));`
  // `$this->request` is the FORM bag - filled for a urlencoded/multipart body
  // only. Probed on a live PHP 8.3 server + 13.37:
  //   JSON {"_method":"PUT"}        -> POST (the JSON body is not the form bag)
  //   form PUT + ?_method=PATCH     -> PUT  (the form bag wins)
  //   _method=put                   -> PUT
  //   X-HTTP-Method-Override: 0     -> POST (PHP's `!$method` is true for '0')
  //   _method=GET                   -> GET  (only a deprecation in 7.4)
  //   _method[]=PUT (form or query) -> BadRequestException, 'Input value
  //     "_method" contains a non-scalar value.' (a 500)
  // The kernel read the JSON body, so an SPA's `_method` selected a different
  // route (audit #850).
  const form = (body, extra = {}) =>
    buildRequest({
      method: 'POST',
      url: 'http://localhost/x',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra },
      body,
    });
  const jsonReq = buildRequest({
    method: 'POST',
    url: 'http://localhost/x',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ _method: 'PUT' }),
  });
  assert.equal(jsonReq.methodOverride(), null);
  assert.equal(jsonReq.method(), 'POST');
  const formWins = buildRequest({
    method: 'POST',
    url: 'http://localhost/x?_method=PATCH',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '_method=PUT',
  });
  assert.equal(formWins.methodOverride(), 'PUT');
  assert.equal(form('_method=put').methodOverride(), 'PUT');
  assert.equal(form('_method=DELETE', { 'x-http-method-override': '0' }).methodOverride(), 'DELETE');
  assert.equal(form('_method=GET').methodOverride(), 'GET');
  // A plain POST (or an explicit `_method=POST`) is not an override.
  assert.equal(form('').methodOverride(), null);
  assert.equal(form('_method=POST').methodOverride(), null);
  for (const [url, body] of [
    ['http://localhost/x', '_method[]=PUT'],
    ['http://localhost/x?_method[]=PUT', '_method=PUT'],
  ]) {
    assert.throws(
      () =>
        buildRequest({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        }),
      (e) => e.name === 'BadRequestException' && e.message === 'Input value "_method" contains a non-scalar value.'
    );
  }
});

test('request: merge() follows Laravel (the input source, replace not deep merge)', () => {
  // Laravel's Request::merge() (Request.php:389-401), probed:
  //   the new input goes into the request's INPUT SOURCE (the JSON bag, the
  //   query bag for GET/HEAD, the post bag otherwise);
  //   every key REPLACES the value (it is NOT a deep merge: the old sub-keys
  //   are gone) and the dot notation is honoured (Arr::set);
  //   the other keys are kept.
  const req = buildRequest({
    method: 'POST',
    url: 'http://localhost/x?keep=1',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'a=1&nested[x]=1&nested[y]=2',
  });
  req.merge({ a: '2', nested: { y: '9' }, b: '3', deep: { k: 'v' } });
  assert.equal(req.input('a'), '2', 'the key is replaced');
  assert.deepEqual(req.input('nested'), { y: '9' }, 'the value is replaced, not deep-merged');
  assert.equal(req.input('b'), '3', 'a new key is added');
  assert.deepEqual(req.input('deep'), { k: 'v' });
  // The dot notation is honoured (Arr::set): merge(['deep.k' => 'v']) sets the
  // NESTED value (probed against Laravel 13).
  req.merge({ 'deep.k2': 'w' });
  assert.deepEqual(req.input('deep'), { k: 'v', k2: 'w' });
  // The input Laravel reads is the input source UNION the query bag
  // (InteractsWithInput::input(): `$this->getInputSource()->all() +
  // $this->query->all()`) - the source's keys win.
  assert.equal(req.query('keep'), '1', 'the query bag is untouched');
  assert.equal(req.input('keep'), '1', 'the query bag is part of the input');
  // A GET merges into the query bag.
  const get = buildRequest({ method: 'GET', url: 'http://localhost/x?q=1' });
  get.merge({ q: '2' });
  assert.equal(get.input('q'), '2');
});

test('request: all() answers the source union the query bag, source keys first', () => {
  // InteractsWithInput::all($keys = null) (:87-105): the input is
  // `getInputSource()->all() + query->all()` (the SOURCE's keys first, the
  // source wins), plus the files; with arguments it answers an Arr::only-shaped
  // subset built through Arr::set/Arr::get — the dot notation works, an absent
  // key answers null, and an EMPTY array means "everything" (`! $keys`).
  // Probed against the real Request: all(['name']) is `{"name":"Ada"}`.
  const req = buildRequest({
    method: 'POST',
    url: 'http://localhost/x?q=1&nested%5Ba%5D=1',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Ada&email=a%40b&empty=',
  });
  assert.deepEqual(Object.keys(req.all()), ['name', 'email', 'empty', 'q', 'nested'], 'the POST keys come first');
  assert.deepEqual(req.all(['name']), { name: 'Ada' });
  assert.deepEqual(req.all(['name', 'email']), { name: 'Ada', email: 'a@b' });
  assert.deepEqual(req.all(['nested.a']), { nested: { a: '1' } }, 'the dot notation is honoured');
  assert.deepEqual(req.all(['nope']), { nope: null }, 'an absent key answers null');
  assert.deepEqual(req.all([]), req.all(), 'an empty array is no filter');
  assert.deepEqual(req.all('name', 'email'), { name: 'Ada', email: 'a@b' });
});

test('the app validation messages merge with the fallback locale RECURSIVELY', () => {
  // Illuminate\Translation\FileLoader merges its language paths with
  // `array_replace_recursive` (:134) and Translator::get() falls back per KEY,
  // so a locale file that redefines `validation.custom.only_this` keeps the
  // fallback's other `custom` entries. `Object.assign` replaced the whole
  // top-level key, so those rules named themselves at the edge.
  const merged = validationMessagesOf({
    'app.locale': 'de',
    'app.fallback_locale': 'en',
    translations: {
      en: {
        validation: {
          required: 'The :attribute field is required.',
          custom: { email: { required: 'Email is required.' }, name: 'Name is wrong.' },
        },
      },
      de: { validation: { custom: { name: 'Name ist falsch.' } } },
    },
  });
  assert.equal(merged.required, 'The :attribute field is required.', 'the fallback answers the rule');
  assert.deepEqual(
    merged.custom,
    { email: { required: 'Email is required.' }, name: 'Name ist falsch.' },
    'the locale wins leaf-by-leaf and the fallback keeps its siblings'
  );
  // The fallback locale is the app's own `fallback_locale`, not a hardcoded en.
  const fr = validationMessagesOf({
    'app.locale': 'de',
    'app.fallback_locale': 'fr',
    translations: { fr: { validation: { required: 'Requis.' } }, de: { validation: { max: 'Trop long.' } } },
  });
  assert.deepEqual(fr, { required: 'Requis.', max: 'Trop long.' });
  // No dumped translations at all: no defaults (the runtime's own table wins).
  assert.equal(validationMessagesOf({ translations: {} }), null);
});

// A-series #67 / COMPILED.md §6: PHP's `urldecode()` is byte-wise, so `%FF` is
// the raw byte 0xFF and `urldecode('a%FFb')` is `61 ff 62` (probed on PHP 8.3).
// A JS string cannot hold a non-UTF-8 byte, so the compiled rung answers the
// replacement character instead. This test pins the gap at exactly that width:
// valid-UTF-8 input stays byte-identical, a non-UTF-8 byte stays U+FFFD (one per
// undecodable byte, never silently dropped or turned into '?'). The case cannot
// ride the parse_str oracle above because PHP cannot carry the byte through
// json_encode.
test('a non-UTF-8 %XX byte is the documented U+FFFD gap (COMPILED §6)', () => {
  const value = (query) => JSON.parse(JSON.stringify(parsePhpQuery(query))).a;
  assert.equal(value('a=%FF'), '\uFFFD');
  assert.equal(value('a=%FF%FE'), '\uFFFD\uFFFD');
  // The byte-identical half: a valid UTF-8 sequence decodes to the same text.
  assert.equal(value('a=%C3%A9'), 'é');
  assert.equal(value('a=%F0%9F%98%80'), '😀');
  // A lone/aborted `%` is literal in PHP too (urldecode keeps it).
  assert.equal(value('a=%'), '%');
  assert.equal(value('a=%4'), '%4');
});

// ─────────────────────────────────────────────────────────────────────────────
// Request::getContent() — the RAW body, byte for byte.
//
// The seam ports that verify a provider signature (Cashier/Stripe, Paddle, Lemon
// Squeezy, Mollie, webhook-client) HMAC the bytes as they arrived. The kernel
// Request exposed no raw-body accessor, so `normalizePortCtx`'s `rawText()` fell
// back to `JSON.stringify(json())` and every one of those verifiers compared
// against a re-serialised copy: a genuinely signed, pretty-printed webhook was
// answered 401 in production (probed). Symfony's `getContent()` is the parity
// accessor; `text()` is the alias a port written against a fetch `Request` reads.
// ─────────────────────────────────────────────────────────────────────────────
test('Request::getContent() returns the raw bytes, not a re-serialisation', async () => {
  const pretty = '{\n  "id": "tr_1",\n  "status": "paid"\n}';
  const jsonReq = buildRequest({
    method: 'POST', url: 'https://app.test/hook',
    headers: { 'content-type': 'application/json' }, body: pretty,
  });
  assert.equal(jsonReq.getContent(), pretty);
  assert.equal(await jsonReq.text(), pretty);
  assert.notEqual(jsonReq.getContent(), JSON.stringify(jsonReq.json()));
  assert.deepEqual(jsonReq.json(), { id: 'tr_1', status: 'paid' });

  // A form body stays verbatim too (PHP keeps the raw query string).
  const form = 'name=Ada&tags[]=a&tags[]=b';
  const formReq = buildRequest({
    method: 'POST', url: 'https://app.test/hook',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
  });
  assert.equal(formReq.getContent(), form);

  // A GET has an empty body, like Symfony.
  const getReq = buildRequest({ method: 'GET', url: 'https://app.test/hook?a=1', headers: {} });
  assert.equal(getReq.getContent(), '');
});

// `Illuminate\Http\Middleware\ValidatePathEncoding` (the FIRST middleware of the
// global stack): a `rawurldecode()`d path that is not valid UTF-8 raises
// `MalformedUrlException` (400, 'Malformed URL.') and it happens BEFORE the
// router - so a malformed path answers 400 even when no route matches, and no
// session/CSRF layer runs (no Set-Cookie).
//
// Every expectation below is PHP 8.3's own answer for the same string
// (`rawurldecode()` then `mb_check_encoding($d, 'UTF-8')`), measured on the
// oracle app; a malformed ESCAPE is not a malformed encoding, which is why the
// check cannot be `decodeURIComponent()` + try/catch (`%zz` throws there but PHP
// leaves it literal and answers the route).
test('ValidatePathEncoding: a path whose rawurldecode() is not UTF-8 is a 400 before routing', async () => {
  const { db } = makeDb();
  const options = {
    table: normalizeTable(ROUTES),
    handlers,
    config: baseConfig(),
    env: { DB: db },
    db,
    models: { LWOracleUser },
    clock: () => FREEZE_S,
    clientIp: CLIENT_IP,
  };
  const call = (uri, headers) =>
    handleHttp(
      { method: 'GET', url: BASE + uri, headers: { host: 'localhost', ...(headers || {}) }, body: '' },
      options
    );

  // Malformed: a stray byte, a truncated sequence, an overlong form, a surrogate,
  // an out-of-range lead byte - and a path with NO matching route (the middleware
  // runs first, so PHP answers 400 and not the platform's 404).
  const malformed = [
    '/letters/a%FFb',
    '/letters/%FF',
    '/letters/%C3',
    '/letters/%E9',
    '/letters/%80',
    '/letters/%C0%AF',
    '/letters/%ED%A0%80',
    '/letters/%F5%80%80%80',
    '/letters/%FE%FF',
    '/letters/%F0%9F%98',
    '/letters/%C3%25A9',
    '/nope%FF',
  ];
  for (const uri of malformed) {
    const res = await call(uri);
    assert.equal(res.status, 400, `${uri} must be a 400`);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-cache, private');
    assert.equal(res.body, '<html><body><h1>400</h1><p>Malformed URL.</p></body></html>');
    assert.deepEqual(res.setCookie, [], `${uri} must not start a session (PHP sends no Set-Cookie)`);
  }

  // Valid: ASCII, a real UTF-8 sequence, an emoji, and the cases where PHP's
  // rawurldecode() leaves the escape alone. None of these routes exists in the
  // synthetic table, so the pipeline answers "no route" (null) - the point is
  // that it is NOT a 400.
  const valid = ['/letters/plain', '/letters/%C3%A9', '/letters/café', '/letters/%F0%9F%98%80', '/letters/%41%42', '/letters/%2F', '/letters/%zz', '/letters/%', '/letters/%2', '/letters/%25FF', '/letters/%2541', '/letters/%25'];
  for (const uri of valid) {
    const res = await call(uri);
    assert.equal(res, null, `${uri} must not be a 400`);
  }

  // An expectsJson request gets Laravel's JSON body for the exception
  // (`Handler::prepareJsonResponse()`: JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES).
  const json = await call('/letters/a%FFb', { accept: 'application/json' });
  assert.equal(json.status, 400);
  assert.equal(json.headers['content-type'], 'application/json');
  assert.equal(json.body, '{\n    "message": "Malformed URL."\n}');
});

test('ValidatePathEncoding: an app that removed the middleware routes instead of 400', async () => {
  // `bootstrap/app.php` may drop `ValidatePathEncoding` from the global stack
  // (`$middleware->remove(...)` / `use([...])`); config-dump writes that as
  // `middleware.validate_path_encoding: false` and the kernel skips the guard.
  // Otherwise the edge would answer 400 where Laravel answers the route.
  const { db } = makeDb();
  const options = {
    table: normalizeTable(ROUTES),
    handlers,
    config: { ...baseConfig(), 'middleware.validate_path_encoding': false },
    env: { DB: db },
    db,
    models: { LWOracleUser },
    clock: () => FREEZE_S,
    clientIp: CLIENT_IP,
  };
  const res = await handleHttp(
    { method: 'GET', url: BASE + '/letters/a%FFb', headers: { host: 'localhost' }, body: '' },
    options
  );
  assert.equal(res, null, 'the guard must not run when the app removed the middleware');
});
