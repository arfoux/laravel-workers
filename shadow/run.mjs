#!/usr/bin/env node
// shadow/run.mjs — the shadow harness: the proof machine.
//
// Boots the *real* Laravel app (PHP 8.3 + sqlite) and the *compiled* worker
// (the dist artifact) and replays the same scenario against both, diffing
// status / headers / body byte-wise.
//
// Usage:
//   node shadow/run.mjs --app <app-root> [--scenarios <file.mjs>] [--build] [--json]
//
//   --app         the Laravel app to compare (must have vendor/ installed)
//   --scenarios   the scenario file (default: shadow/scenarios/<app-name>.mjs)
//   --build       run `build.mjs --strict` in the app first (fail loud)
//   --json        print the machine-readable report
//
// A scenario file exports { name, steps, fixtures?, user? }:
//   steps[]    { label, method, uri, jar?, headers?, form?, json?, query?,
//                expect?: 'match' | 'diverges', why? }
//   fixtures[] { sql } — rows inserted before the steps (both sides see them)
//   user       { id, email, password, password_hash? } — the seeded auth user
//
// Exit code 0 = every step that is expected to match, matched. A step marked
// `expect: 'diverges'` is reported as a known divergence (it shrinks the
// uncovered list, it does not fail the run).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ORACLE = path.join(ROOT, 'tools', 'php-shadow-oracle.php');
const PHP = process.env.PHP_BIN || 'php';

const BASE = 'http://localhost';
const FREEZE_S = 1767225600; // 2026-01-01T00:00:00Z
const USER_AGENT = 'laravel-workers-shadow/1.0';
const CLIENT_IP = '127.0.0.1';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { app: null, scenarios: null, build: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app') out.app = argv[++i];
    else if (a === '--scenarios') out.scenarios = argv[++i];
    else if (a === '--build') out.build = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument ' + a);
  }
  out.app = out.app || process.env.LW_SHADOW_APP || null;
  return out;
}

// ---------------------------------------------------------------------------
// The D1 shim: node:sqlite (the same binding shape Cloudflare D1 exposes).
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

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function parseSetCookie(sc) {
  const [pair, ...attrs] = String(sc).split(';');
  const eq = pair.indexOf('=');
  const rawName = eq === -1 ? pair.trim() : pair.slice(0, eq).trim();
  const rawValue = eq === -1 ? '' : pair.slice(eq + 1).trim();
  // The cookie value is URL-encoded (the base64 padding arrives as %3D).
  const name = safeDecode(rawName);
  const value = safeDecode(rawValue);
  const map = { name, value };
  for (const a of attrs) {
    const i = a.indexOf('=');
    if (i === -1) continue;
    map[a.slice(0, i).trim().toLowerCase()] = a.slice(i + 1).trim();
  }
  return map;
}

function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

// Volatile values that can never match between two independent runs.
const VOLATILE_HEADERS = new Set(['date', 'set-cookie']);

function normHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = String(name).toLowerCase();
    if (VOLATILE_HEADERS.has(key)) continue;
    out[key] = Array.isArray(value) ? String(value[0]) : String(value);
  }
  return out;
}

// A body is "equal" when the bytes match, or when both sides are JSON with the
// same structure (the volatile values — session ids, CSRF tokens, timestamps —
// are normalised away first).
function bodiesEqual(phpBody, jsBody) {
  if (phpBody === jsBody) return { equal: true };
  const a = tryJson(phpBody);
  const b = tryJson(jsBody);
  if (a === null || b === null) return { equal: false };
  const na = normaliseVolatile(a);
  const nb = normaliseVolatile(b);
  if (JSON.stringify(na) === JSON.stringify(nb)) return { equal: true };
  return { equal: false, php: na, js: nb };
}

function tryJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    const v = JSON.parse(t);
    return typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// 40-char random-looking strings (session ids, CSRF tokens) and ISO timestamps
// differ between the two runs by construction.
const RANDOMISH = /^[A-Za-z0-9]{32,64}$/;
const TIMESTAMPISH = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

function normaliseVolatile(value) {
  if (Array.isArray(value)) return value.map(normaliseVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normaliseVolatile(value[k]);
    return out;
  }
  if (typeof value === 'string') {
    if (RANDOMISH.test(value)) return '<random>';
    if (TIMESTAMPISH.test(value)) return '<timestamp>';
  }
  return value;
}

// ---------------------------------------------------------------------------
// The PHP side
// ---------------------------------------------------------------------------

function runOracle(appRoot, scenario, dbPath, seedPath) {
  const steps = scenario.steps.map((s) => ({
    label: s.label,
    method: s.method,
    uri: s.uri,
    jar: Boolean(s.jar),
    ...(s.headers ? { headers: s.headers } : {}),
    ...(s.form ? { form: s.form } : {}),
    ...(s.json !== undefined ? { json: s.json } : {}),
    ...(s.query ? { query: s.query } : {}),
  }));
  const res = spawnSync(PHP, [ORACLE], {
    input: JSON.stringify({
      app_root: appRoot,
      db_path: dbPath,
      seed_path: seedPath,
      freeze_ms: FREEZE_S * 1000,
      migrate: scenario.migrate !== false,
      user: scenario.user || {},
      fixtures: scenario.fixtures || [],
      steps,
    }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`PHP oracle failed to start (${res.error.message}). Install PHP 8.3 or set PHP_BIN.`);
  }
  if (res.status !== 0) {
    throw new Error(`PHP oracle exited ${res.status}:\n${res.stderr}`);
  }
  // The oracle prints its JSON behind a marker: the error renderer (the
  // Symfony error page) writes to the output stream while it renders.
  const marker = '__LW_JSON__';
  const at = res.stdout.lastIndexOf(marker);
  const payload = at === -1 ? res.stdout : res.stdout.slice(at + marker.length);
  return JSON.parse(payload);
}

// ---------------------------------------------------------------------------
// The compiled side
// ---------------------------------------------------------------------------

async function loadDist(appRoot) {
  const u = (p) => pathToFileURL(path.join(appRoot, 'dist', p)).href;
  const { handleHttp } = await import(u('kernel/http.mjs'));
  const { createDatabaseCache } = await import(u('kernel/cache.mjs'));
  const { createCookieEncryptor } = await import(u('kernel/cookies.mjs'));
  const { normalizeTable } = await import(u('kernel/router.mjs'));
  const { createStorage } = await import(u('kernel/storage.mjs'));
  const { routeTable, handlers } = await import(u('src/routes.generated.mjs'));
  const { default: config } = await import(u('src/config.generated.mjs'));
  const { models } = await import(u('src/models.generated.mjs'));
  return { handleHttp, createDatabaseCache, createCookieEncryptor, normalizeTable, routeTable, handlers, config, models, createStorage };
}

function decodePayload(b64) {
  return Buffer.from(String(b64), 'base64').toString('utf8');
}

// The build writes a snapshot to dist/public/<route>/index.html and rewrites
// the absolute URLs to relative ones. The harness applies the same rewrite to
// the live PHP body so the two are comparable.
const ORIGIN_RE = /(?:https?:)?\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//g;

function snapshotFile(appRoot, uri) {
  const clean = String(uri).split('?')[0].replace(/\/+$/, '') || '/';
  const rel = clean === '/' ? 'index.html' : clean.slice(1) + '/index.html';
  const p = path.join(appRoot, 'dist', 'public', rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

function relativise(body) {
  return String(body ?? '').replace(ORIGIN_RE, '/');
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

async function runCompiled(loaded, appRoot, scenario, dbPath) {
  const { handleHttp, createDatabaseCache, createCookieEncryptor, normalizeTable, routeTable, handlers, config, models, createStorage } =
    loaded;
  const { DatabaseSync } = await import('node:sqlite');
  const sqlite = new DatabaseSync(dbPath);
  const db = d1(sqlite);
  if (process.env.LW_DBG) {
    for (const t of ['posts', 'users', 'sessions']) {
      try {
        console.error(`[dbg] js db ${t}: ${JSON.stringify(sqlite.prepare(`SELECT * FROM ${t}`).all()).slice(0, 300)}`);
      } catch (e) {
        console.error(`[dbg] js db ${t}: ${e.message}`);
      }
    }
  }
  const table = normalizeTable(routeTable);
  const cache = createDatabaseCache({ db, config, clock: () => FREEZE_S });
  const encryptor = createCookieEncryptor({
    keyBase64: String(config['app.key'] ?? '').replace(/^base64:/, ''),
    except: config['cookies.except'] ?? [],
  });
  // The object store (the padanan for the app's local disk): no R2 binding here,
  // so the worker would use the D1 blob store - one row per object.
  const storage = createStorage({ d1: db, secret: config['app.key'] });

  const logs = [];
  const jar = new Map();
  let lastToken = null;
  let randSeq = 0;
  const rand = (n) => String.fromCharCode(65 + (randSeq++ % 26)).repeat(n);
  const out = [];

  for (const step of scenario.steps) {
    const headers = { host: 'localhost', 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' };
    for (const [k, v] of Object.entries(step.headers || {})) {
      headers[String(k).toLowerCase()] = v;
    }
    // Only a step that *uses* the jar sends it (a step without it is a separate
    // visitor) — the same rule the PHP oracle follows.
    if (step.jar && jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

    let body = '';
    if (step.form) {
      const form = {};
      for (const [k, v] of Object.entries(step.form)) form[k] = v === '@token' ? lastToken : v;
      body = new URLSearchParams(form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (step.json !== undefined) {
      body = typeof step.json === 'string' ? step.json : JSON.stringify(step.json);
      headers['content-type'] = 'application/json';
      headers.accept = 'application/json';
    }

    const url = BASE + (step.uri || '/');
    let res;
    try {
      res = await handleHttp(
      { method: step.method || 'GET', url, headers, body },
      {
        table,
        handlers,
        config,
        env: { DB: db },
        db,
        cache,
        storage,
        log: (level, message, context) => {
          logs.push({ level, message, context: context ?? null });
          return null;
        },
        models,
        clock: () => FREEZE_S,
        randomString: rand,
        strRandom: rand,
        clientIp: CLIENT_IP,
      }
      );
    } catch (e) {
      // The worker does not catch an uncaught error either: the platform
      // answers the 500 (workerd's default response).
      res = {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'Internal Server Error',
        setCookie: [],
        cookies: [],
      };
    }
    if (!res) {
      // No compiled handler: the route is served from the *static bundle* (a
      // build-time snapshot). Compare the prerendered file with the live render
      // (the build rewrites absolute URLs to relative ones).
      const snap = snapshotFile(appRoot, step.uri || '/');
      if (snap) {
        out.push({
          label: step.label,
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: snap,
          source: 'snapshot',
        });
        continue;
      }
      out.push({ label: step.label, status: null, headers: {}, body: '', missing: true });
      continue;
    }

    for (const sc of res.setCookie) {
      // Only a step that used the jar may update it (a step without it is a
      // separate visitor) — the same rule the PHP oracle follows.
      if (!step.jar) continue;
      const c = parseSetCookie(sc);
      if (c.value === '' && /expires=/i.test(sc) && /max-age=0/i.test(sc)) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }

    // Resolve the next step's `@token` from the session row the jar points at.
    const sid = await jarPlain(encryptor, jar, config['session.cookie']);
    if (sid != null) {
      const row = sqlite.prepare('SELECT payload FROM sessions WHERE id = ?').get(sid);
      lastToken = rowToken(row) ?? lastToken;
    }
    if (process.env.LW_DBG) {
      console.error(
        `[dbg] ${step.label} -> ${res.status} jar=[${[...jar.keys()].join(',')}] ` +
          `sid=${String(sid).slice(0, 8)} token=${String(lastToken).slice(0, 8)}`
      );
    }

    out.push({ label: step.label, status: res.status, headers: res.headers, body: res.body });
  }

  sqlite.close();
  return out;
}

async function jarPlain(encryptor, jar, name) {
  const raw = jar.get(name);
  if (raw === undefined) return null;
  const out = await encryptor.decryptRequestCookies({ [name]: raw });
  return out[name];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.app) {
    console.log(
      'usage: node shadow/run.mjs --app <app-root> [--scenarios <file.mjs>] [--build] [--json]\n' +
        '       (or set LW_SHADOW_APP=<app-root>)'
    );
    process.exit(args.help ? 0 : 2);
  }
  const appRoot = path.resolve(args.app);
  if (!existsSync(path.join(appRoot, 'vendor', 'autoload.php'))) {
    console.error(`shadow: ${appRoot} has no vendor/ — run composer install first`);
    process.exit(2);
  }

  const scenarioFile = args.scenarios
    ? path.resolve(args.scenarios)
    : path.join(ROOT, 'shadow', 'scenarios', `${path.basename(appRoot)}.mjs`);
  if (!existsSync(scenarioFile)) {
    console.error(`shadow: no scenario file at ${scenarioFile} — pass --scenarios <file.mjs>`);
    process.exit(2);
  }
  const scenario = (await import(pathToFileURL(scenarioFile).href)).default;

  if (args.build) {
    console.log(`• building ${appRoot} (--strict)`);
    const res = spawnSync(process.execPath, [path.join(ROOT, 'build.mjs'), '--strict'], {
      cwd: appRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) {
      console.error(`shadow: the build failed — the compiled side cannot be compared:\n${res.stdout}\n${res.stderr}`);
      process.exit(3);
    }
  }

  const work = mkdtempSync(path.join(os.tmpdir(), 'lw-shadow-'));
  const phpDb = path.join(work, 'php.sqlite');
  const seedDb = path.join(work, 'seed.sqlite');
  const jsDb = path.join(work, 'js.sqlite');
  try {
    console.log(`• php oracle  (${path.basename(scenarioFile)})`);
    const php = runOracle(appRoot, scenario, phpDb, seedDb);
    // The compiled side starts from the *seed* state (schema + fixtures, before
    // any step ran) — the same rows the oracle saw.
    copyFileSync(seedDb, jsDb);

    console.log('• compiled worker');
    const loaded = await loadDist(appRoot);
    const js = await runCompiled(loaded, appRoot, scenario, jsDb);

    const results = [];
    let matched = 0;
    let shaped = 0;
    let diverged = 0;
    let failed = 0;
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const p = php.steps[i] || { status: null, headers: {}, body: '' };
      const j = js[i] || { status: null, headers: {}, body: '' };
      const ph = normHeaders(p.headers);
      const jh = normHeaders(j.headers);
      // A snapshot route is served from the static bundle by the platform: the
      // headers are the platform's, not the app's. Only the body is comparable.
      const isSnapshot = j.source === 'snapshot';
      const headerDiff = isSnapshot
        ? []
        : Object.keys({ ...ph, ...jh }).filter((k) => ph[k] !== jh[k]);
      // A snapshot route is compared against the live render with the origin
      // rewritten to relative URLs (the build does the same).
      const phpBody = j.source === 'snapshot' ? relativise(p.body) : p.body;
      // A step may declare a `shape` (a regex) instead of byte equality — for a
      // body that is random by construction (a bcrypt digest, a session id).
      // Both sides must match the shape; the verdict is then "shape", not
      // "identical".
      let body = bodiesEqual(phpBody, j.body);
      let shapeOk = false;
      if (!body.equal && step.shape) {
        const re = new RegExp(step.shape);
        shapeOk = re.test(String(phpBody ?? '')) && re.test(String(j.body ?? ''));
      }
      const statusOk = p.status === j.status;
      // A step may declare the status both sides must answer (`expectStatus`).
      // It is what makes a documented divergence *provable*: the bodies of the
      // error pages differ (a Laravel framework asset), but the status must be
      // Laravel's.
      const expectStatusOk =
        step.expectStatus === undefined ||
        (p.status === step.expectStatus && j.status === step.expectStatus);
      // A step may declare the headers both sides must carry (`expectHeader`:
      // { name: value }). The 405 carries the Allow header (the methods the URI
      // accepts) - the same list Laravel's router answers.
      let expectHeaderOk = true;
      for (const [name, value] of Object.entries(step.expectHeader || {})) {
        const key = String(name).toLowerCase();
        if (ph[key] !== value || jh[key] !== value) {
          expectHeaderOk = false;
          break;
        }
      }
      // A step may declare the body it expects (`expectBody`: a string the body
      // must contain). It catches the vacuous match: if both sides are broken in
      // the same way (a route that does not exist answers 404 on both), the
      // bodies agree and the step would pass without proving anything.
      const expectBodyOk =
        step.expectBody === undefined ||
        (String(phpBody ?? '').includes(String(step.expectBody)) &&
          String(j.body ?? '').includes(String(step.expectBody)));
      const ok =
        statusOk && headerDiff.length === 0 && body.equal && expectBodyOk && expectStatusOk && expectHeaderOk;
      const expected = step.expect || 'match';
      let verdict;
      if (ok) {
        verdict = expected === 'diverges' ? 'MATCHED (expected a divergence)' : 'match';
        matched++;
      } else if (shapeOk && statusOk && headerDiff.length === 0 && expectBodyOk) {
        // The body is random by construction (a bcrypt digest): both sides match
        // the declared shape, so the step is verified — but not byte-identical.
        verdict = 'shape';
        shaped++;
        matched++;
      } else if (expected === 'diverges' && expectStatusOk && expectHeaderOk) {
        // A known divergence: the bodies differ (a Laravel framework asset),
        // but the status and the declared headers are the ones Laravel answers.
        verdict = 'diverges (known)';
        diverged++;
      } else {
        verdict = 'MISMATCH';
        failed++;
      }
      results.push({
        label: step.label,
        method: step.method || 'GET',
        uri: step.uri || '/',
        phpStatus: p.status,
        jsStatus: j.status,
        statusOk,
        expectBodyOk,
        expectBody: step.expectBody ?? null,
        headerDiff: headerDiff.map((k) => ({ name: k, php: ph[k], js: jh[k] })),
        bodyOk: body.equal,
        bodyPhp: body.equal ? undefined : preview(p.body),
        bodyJs: body.equal ? undefined : preview(j.body),
        bodyPhpRaw: phpBody,
        bodyJsRaw: j.body,
        verdict,
        why: step.why || '',
      });
    }

    const report = {
      app: appRoot,
      scenario: scenarioFile,
      total: scenario.steps.length,
      matched,
      shaped,
      diverged,
      failed,
      // The byte-identical rate — a shape-verified step is *not* byte-identical.
      coverage: scenario.steps.length ? (matched - shaped) / scenario.steps.length : 1,
      // Every step is accounted for: identical, shape-verified, documented, or
      // unexplained.
      accounted: scenario.steps.length ? (matched + diverged) / scenario.steps.length : 1,
      results,
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const r of results) {
        const mark = r.verdict === 'MISMATCH' ? 'x' : r.verdict.startsWith('diverges') ? '~' : '+';
        console.log(
          `${mark} ${String(r.phpStatus)}/${String(r.jsStatus)} ${r.method} ${r.uri} — ${r.verdict}${
            r.why ? ` (${r.why})` : ''
          }`
        );
        if (r.verdict === 'MISMATCH') {
          for (const h of r.headerDiff) console.log(`    header ${h.name}: php=${h.php} js=${h.js}`);
          if (r.expectBody !== null && !r.expectBodyOk) {
            console.log(`    expected the body to contain: ${r.expectBody}`);
          }
          if (!r.bodyOk) {
            const d = firstDiffLine(r.bodyPhpRaw, r.bodyJsRaw);
            if (d) {
              console.log(`    body line ${d.line} php: ${d.php}`);
              console.log(`    body line ${d.line}  js: ${d.js}`);
            } else {
              console.log(`    body php: ${r.bodyPhp}`);
              console.log(`    body  js: ${r.bodyJs}`);
            }
          }
        }
      }
      console.log(
        `\nshadow: ${matched - shaped}/${scenario.steps.length} byte-identical, ${shaped} shape-verified, ` +
          `${diverged} documented divergence(s), ${failed} unexplained — coverage ` +
          `${(report.coverage * 100).toFixed(0)}% (accounted ${(report.accounted * 100).toFixed(0)}%)`
      );
    }
    process.exit(failed ? 1 : 0);
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* best effort on Windows */
    }
  }
}

function preview(body) {
  const s = String(body ?? '');
  return s.length > 300 ? `${s.slice(0, 300)}… (${s.length} bytes)` : s;
}

// The first line that differs — the useful bit when two HTML pages differ.
function firstDiffLine(a, b) {
  const la = String(a ?? '').split('\n');
  const lb = String(b ?? '').split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return { line: i + 1, php: la[i], js: lb[i] };
  }
  return null;
}

await main();
