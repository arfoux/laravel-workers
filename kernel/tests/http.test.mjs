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
import { handleHttp, parsePhpQuery } from '../http.mjs';
import { createDatabaseCache } from '../cache.mjs';
import { applyAuthenticatable } from '../auth.mjs';
import { Model } from '../model.mjs';
import { normalizeTable } from '../router.mjs';

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
const APP_ROOT =
  process.env.LW_LARAVEL_APP ||
  'C:\\Users\\HP\\AppData\\Local\\Temp\\opencode\\lw-fresh-e2e\\fresh-app';

const FREEZE_MS = 1792336827000;
const FREEZE_S = Math.floor(FREEZE_MS / 1000);
const HASH12 = '$2y$12$d0pIpZcCKtpClnDI9BCFgeYNp2hPFUuoGalG4focVyYVTL01s2ZmW';
const CLIENT_IP = '127.0.0.1';
const USER_AGENT = 'Symfony';
const BASE = 'http://localhost';
const TOKEN = '\u00abTOKEN\u00bb';

function requireApp() {
  if (!existsSync(path.join(APP_ROOT, 'vendor', 'autoload.php'))) {
    throw new Error(
      `http.test: no Laravel app at ${APP_ROOT} (vendor/autoload.php missing). ` +
        'Point LW_LARAVEL_APP at a Laravel 13.x app to run the pipeline parity tests.'
    );
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
  { uri: '/__probe/guest', methods: ['GET', 'HEAD'], middleware: ['web', 'guest'] },
  { uri: '/__probe/login', methods: ['POST'], middleware: ['web'] },
  { uri: '/__probe/logout', methods: ['POST'], middleware: ['web'] },
  { uri: '/login', name: 'login', methods: ['GET', 'HEAD'], middleware: [] },
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

test('compiled pipeline matches the PHP 8.3 web pipeline, 11 steps', { skip: noSqlite }, async () => {
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
