// kernel/tests/login-flow.test.mjs
//
// 7c "compiled rung" end-to-end: a real Breeze-shape login flow, diffed 1:1
// against a PHP 8.3 oracle running the *same* application.
//
// Unlike http.test.mjs (hand-built routes + hand-written handlers driving the
// kernel), this file:
//   1. builds the target Laravel app with the project's own `build.mjs --strict`,
//   2. loads the *generated* artifacts (route table, compiled controllers,
//      flattened config, model registry) out of the app's `dist/`,
//   3. replays GET /login -> POST /login (bad) -> POST /login (good) ->
//      GET /dashboard -> POST /logout through `handleHttp`, and
//   4. asserts byte parity with `tools/php-login-flow-oracle.php`.
//
// Steps exercised: session bootstrap on a guest redirect (url.intended),
// `$request->validate()` + `ValidationException::withMessages()` (HTML redirect
// back with flashed errors + old input, and the JSON 422), `Auth::attempt()`
// (session id + CSRF token regeneration, login_/password_hash_ session keys),
// `redirect()->intended()` and `Auth::logout()` + session invalidate.
//
// It needs a Laravel 13.x app on disk (vendor/autoload.php + a `dist` it can
// rebuild). Point LW_LARAVEL_APP at one, or use the default fixture path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Older Node without node:sqlite: this E2E skips.
}
const noSqlite = DatabaseSync ? false : 'node:sqlite unavailable (needs Node >= 22)';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '..', '..');
const BUILD = path.join(repoRoot, 'build.mjs');
const ORACLE = path.join(repoRoot, 'tools', 'php-login-flow-oracle.php');
const PHP = process.env.PHP_BIN || 'php';
const APP_ROOT =
  process.env.LW_LARAVEL_APP ||
  'C:\\Users\\HP\\AppData\\Local\\Temp\\opencode\\lw-fresh-e2e\\fresh-app';

const FREEZE_MS = 1792336827000;
const FREEZE_S = Math.floor(FREEZE_MS / 1000);
const BASE = 'http://localhost';
const CLIENT_IP = '127.0.0.1';
const USER_AGENT = 'Symfony';
const TOKEN = '\u00abTOKEN\u00bb';
const LOGIN_EMAIL = 'u@example.com';
const LOGIN_PASSWORD = 'secret';

function requireApp() {
  if (!existsSync(path.join(APP_ROOT, 'vendor', 'autoload.php'))) {
    throw new Error(
      `login-flow.test: no Laravel app at ${APP_ROOT} (vendor/autoload.php missing). ` +
        'Point LW_LARAVEL_APP at a Laravel 13.x app to run the login-flow parity test.'
    );
  }
}

// ---------------------------------------------------------------------------
// Step script (shared by the JS replay and the PHP oracle).
// ---------------------------------------------------------------------------

// NOTE: GET /login is deliberately absent. The app's `LoginController@create()`
// only returns `view('auth.login')`, so the build auto-snapshots it into a
// static asset that the Worker serves *before* the HTTP kernel ever runs
// (documented gap: snapshot routes bypass the session middleware). The CSRF
// token therefore bootstraps from the guest redirect in step 1, whose
// `XSRF-TOKEN` cookie the pipeline sets.
const STEPS = [
  { label: '1 GET /dashboard (guest)', method: 'GET', uri: '/dashboard' },
  {
    label: '2 POST /login (wrong password)',
    method: 'POST',
    uri: '/login',
    jar: true,
    form: { _token: '@token', email: LOGIN_EMAIL, password: 'wrong' },
  },
  {
    label: '3 POST /login (authenticates)',
    method: 'POST',
    uri: '/login',
    jar: true,
    form: { _token: '@token', email: LOGIN_EMAIL, password: LOGIN_PASSWORD },
  },
  { label: '4 GET /dashboard (authenticated)', method: 'GET', uri: '/dashboard', jar: true },
  { label: '5 POST /logout', method: 'POST', uri: '/logout', jar: true, form: { _token: '@token' } },
  { label: '6 GET /dashboard (after logout)', method: 'GET', uri: '/dashboard', jar: true },
  {
    label: '7 POST /login (wrong password, JSON)',
    method: 'POST',
    uri: '/login',
    jar: true,
    headers: { Accept: 'application/json' },
    form: { _token: '@token', email: LOGIN_EMAIL, password: 'wrong' },
  },
];

// ---------------------------------------------------------------------------
// 1. Build the app itself (fail loud) and load the generated artifacts.
// ---------------------------------------------------------------------------

function buildFixture() {
  const res = spawnSync(process.execPath, [BUILD, '--strict'], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`fixture build failed to start: ${res.error.message}`);
  const log = `${res.stdout || ''}${res.stderr || ''}`;
  assert.equal(res.status, 0, `fixture build --strict must exit 0:\n${log}`);
  assert.match(
    log,
    /controller POST \/login -> .*login-post\.mjs/,
    'the multi-verb pass must compile POST /login (extra verb on an otherwise GET-only uri)'
  );
}

async function loadDist() {
  const u = (p) => pathToFileURL(path.join(APP_ROOT, 'dist', p)).href;
  const { handleHttp } = await import(u('kernel/http.mjs'));
  const { createDatabaseCache } = await import(u('kernel/cache.mjs'));
  const { createCookieEncryptor } = await import(u('kernel/cookies.mjs'));
  const { normalizeTable } = await import(u('kernel/router.mjs'));
  const { routeTable, handlers } = await import(u('src/routes.generated.mjs'));
  const { default: config } = await import(u('src/config.generated.mjs'));
  const { models } = await import(u('src/models.generated.mjs'));
  return { handleHttp, createDatabaseCache, createCookieEncryptor, normalizeTable, routeTable, handlers, config, models };
}

// ---------------------------------------------------------------------------
// 2. The PHP oracle.
// ---------------------------------------------------------------------------

function runOracle() {
  const steps = STEPS.map((s) => ({
    label: s.label,
    method: s.method,
    uri: s.uri,
    jar: Boolean(s.jar),
    ...(s.headers ? { headers: s.headers } : {}),
    ...(s.form ? { form: s.form } : {}),
  }));
  const res = spawnSync(PHP, [ORACLE], {
    input: JSON.stringify({ app_root: APP_ROOT, freeze_ms: FREEZE_MS, steps }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`PHP oracle failed to start (${res.error.message}). Install PHP 8.3 or set PHP_BIN.`);
  }
  if (res.status !== 0) {
    throw new Error(`PHP oracle exited ${res.status}:\n${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

// ---------------------------------------------------------------------------
// 3. Minimal D1 shim + the app's storage schema.
// ---------------------------------------------------------------------------

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

// `sessions` (Laravel default), `users` (the app's User model table) + the
// `cache` tables the database cache store backs `throttle:5,1` with. The user
// row is seeded with the *oracle's* bcrypt hash so both sides check the same
// digest.
function makeDb(passwordHash) {
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
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NULL,
      email TEXT UNIQUE,
      email_verified_at TEXT NULL,
      password TEXT NOT NULL,
      remember_token TEXT NULL,
      created_at TEXT NULL,
      updated_at TEXT NULL
    );
    CREATE TABLE cache ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL, "expiration" INTEGER NOT NULL);
    CREATE TABLE cache_locks ("key" TEXT PRIMARY KEY, "owner" TEXT NOT NULL, "expiration" INTEGER NOT NULL);
  `);
  sqlite
    .prepare(
      `INSERT INTO users
         (id, name, email, email_verified_at, password, remember_token, created_at, updated_at)
       VALUES (1, 'Test User', ?, NULL, ?, NULL, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`
    )
    .run(LOGIN_EMAIL, passwordHash);
  return { sqlite, db: d1(sqlite) };
}

// ---------------------------------------------------------------------------
// 4. Replay the same steps through the compiled kernel.
// ---------------------------------------------------------------------------

function decodePayload(b64) {
  return Buffer.from(String(b64), 'base64').toString('utf8');
}

function rowToken(row) {
  if (!row) return null;
  try {
    const p = JSON.parse(decodePayload(row.payload));
    return typeof p._token === 'string' ? p._token : null;
  } catch {
    return null;
  }
}

async function runJs(loaded, passwordHash) {
  const { handleHttp, createDatabaseCache, createCookieEncryptor, normalizeTable, routeTable, handlers, config, models } =
    loaded;
  const { sqlite, db } = makeDb(passwordHash);
  const table = normalizeTable(routeTable);
  const cache = createDatabaseCache({ db, config, clock: () => FREEZE_S });
  const encryptor = createCookieEncryptor({
    keyBase64: String(config['app.key'] ?? '').replace(/^base64:/, ''),
    except: config['cookies.except'] ?? [],
  });

  const jar = new Map();
  let lastToken = null;
  let randSeq = 0;
  // Distinct 40-char value per call, so the session id actually rotates on
  // SessionGuard::login / regenerate() (both sides then differ by *value*, and
  // the assertions compare structure + normalised payload bytes).
  const rand = (n) => String.fromCharCode(65 + (randSeq++ % 26)).repeat(n);
  const out = [];

  for (const step of STEPS) {
    const headers = { host: 'localhost', 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' };
    if (step.headers?.Accept) headers.accept = step.headers.Accept;
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

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
        cache,
        models,
        clock: () => FREEZE_S,
        randomString: rand,
        strRandom: rand,
        clientIp: CLIENT_IP,
      }
    );
    if (!res) throw new Error(`compiled rung returned null for ${step.label} (no handler matched)`);

    for (const sc of res.setCookie) {
      const c = parseSetCookie(sc);
      if (c.value === '' && /expires=/i.test(sc) && /max-age=0/i.test(sc)) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }

    let parsed = null;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      parsed = null;
    }

    const rows = sqlite
      .prepare('SELECT * FROM sessions ORDER BY id')
      .all()
      .map((r) => ({ ...r }));

    // Resolve the next step's `@token` from the current session row (mirrors the
    // oracle). Decrypt the session cookie to find which row the jar points at.
    const sid = await jarPlain(encryptor, jar, config['session.cookie']);
    if (sid != null) {
      const row = sqlite.prepare('SELECT payload FROM sessions WHERE id = ?').get(sid);
      lastToken = rowToken(row) ?? lastToken;
    }
    if (process.env.LW_DBG) {
      console.error(`[dbg] ${step.label} -> ${res.status} sid=${String(sid).slice(0, 4)} token=${String(lastToken).slice(0, 4)} rows=${rows.length} keys=${JSON.stringify(rows.map((r) => Object.keys(JSON.parse(decodePayload(r.payload)))))}`);
    }

    out.push({ label: step.label, status: res.status, headers: res.headers, setCookie: res.setCookie, body: res.body, parsed, rows, jar: new Map(jar), sessionPlain: sid });
  }
  return { out, encryptor };
}

async function jarPlain(encryptor, jar, name) {
  const raw = jar.get(name);
  if (raw === undefined) return null;
  const out = await encryptor.decryptRequestCookies({ [name]: raw });
  return out[name];
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
  const attrs = parts.slice(1).map((a) => (a.toLowerCase().startsWith('max-age=') ? 'max-age=*' : a));
  return { name, value, attrs };
}

function normCookies(list) {
  return list.map(parseSetCookie).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Only the CSRF token is random inside the payload; everything else — attribute
// order, `/`-escaping, flash shape, login_* / password_hash_* keys — must be
// byte-identical once each side's own token is replaced.
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

function normPhpStep(step) {
  const rows = (step.session_rows || []).map((r) => ({
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
    rows,
    sessionPlain: step.session_plain ?? null,
    xsrfPlain: step.xsrf_plain ?? null,
    jar: Object.keys(step.jar_after || {}).sort(),
  };
}

// ---------------------------------------------------------------------------
// 5. The parity test.
// ---------------------------------------------------------------------------

test('Breeze login flow matches the PHP 8.3 oracle (compiled rung, E2E)', { skip: noSqlite }, async () => {
  requireApp();
  buildFixture();
  const loaded = await loadDist();

  const oracle = runOracle();
  assert.equal(oracle.config['session.driver'], 'database', 'oracle must run the database session driver');
  assert.equal(oracle.config['session.serialization'], 'json', 'oracle must use json session serialization');
  const config = loaded.config;
  assert.equal(String(config['app.key']), String(oracle.config['app.key']), 'app key must match (cookie encryption)');
  assert.equal(String(config['session.cookie']), String(oracle.config['session.cookie']), 'session cookie name must match');

  const { out: js, encryptor } = await runJs(loaded, oracle.user.password_hash);
  assert.equal(js.length, STEPS.length);
  assert.equal(oracle.steps.length, STEPS.length);

  const seenSid = new Set();

  for (let i = 0; i < STEPS.length; i += 1) {
    const mine = js[i];
    const php = normPhpStep(oracle.steps[i]);
    const where = `step ${php.label}`;

    // status
    assert.equal(mine.status, php.status, `${where}: status`);

    // headers (minus date/set-cookie)
    assert.deepEqual(normHeaders(mine.headers), normHeaders(php.headers), `${where}: headers`);
    assert.equal(String(normHeaders(mine.headers)['cache-control']), 'no-cache, private', `${where}: cache-control`);

    // Set-Cookie name + attributes (order preserved)
    assert.deepEqual(
      normCookies(mine.setCookie).map((c) => ({ name: c.name, attrs: c.attrs })),
      normCookies(php.setCookie).map((c) => ({ name: c.name, attrs: c.attrs })),
      `${where}: Set-Cookie name+attributes`
    );

    // body
    const ct = String(normHeaders(php.headers)['content-type'] || '');
    if (ct.startsWith('application/json')) {
      assert.deepEqual(normJsonBody(mine.parsed), normJsonBody(php.parsed), `${where}: JSON body`);
    } else {
      assert.equal(mine.body, php.body, `${where}: body`);
    }

    // session id / CSRF token: random on both sides, 40 chars, same shape
    assert.ok(php.sessionPlain, `${where}: oracle must report session_plain`);
    assert.equal(String(php.sessionPlain).length, 40, `${where}: oracle session id length`);
    assert.equal(String(php.xsrfPlain).length, 40, `${where}: oracle CSRF token length`);
    const jsSid = await jarPlain(encryptor, mine.jar, config['session.cookie']);
    const jsXsrf = await jarPlain(encryptor, mine.jar, 'XSRF-TOKEN');
    assert.equal(String(jsSid).length, 40, `${where}: compiled session id length`);
    assert.equal(String(jsXsrf).length, 40, `${where}: compiled CSRF token length`);
    seenSid.add(jsSid);

    // session row + payload bytes
    const mineRows = mine.rows.map((r) => normRow(r, jsXsrf));
    const phpRows = php.rows.map((r) => normRow(r, php.xsrfPlain));
    assert.equal(mineRows.length, phpRows.length, `${where}: session row count`);
    assert.deepEqual(mineRows, phpRows, `${where}: session rows (payload bytes + columns)`);

    // cookie jar names
    assert.deepEqual([...mine.jar.keys()].sort(), php.jar, `${where}: cookie jar names`);
  }

  // Both sides rotate the session id at least once (login) — guard against the
  // replay silently reusing one id for every step.
  assert.ok(seenSid.size >= 2, 'the compiled session id must rotate during the flow (login/regenerate)');
});
