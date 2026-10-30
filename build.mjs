#!/usr/bin/env node
// build.mjs — Build pipeline (Laravel → Workers artifact)
//
// "Booting" happens HERE (build time): the real Laravel app renders pages and
// exports its route table. The artifact shipped to Cloudflare is request-time
// static: prerendered HTML + small JS ports. Nothing boots at request time.
//
// Route tiers (see README):
//   ports    — live JS handlers (registry.json → "ports"), highest priority
//   static   — manual page map (registry.json → "static")
//   snapshot — automatic: clean GET routes rendered at build time land on the edge
//   ignore   — consciously skipped (registry.json → "ignore")
//
// Usage: node build.mjs [--strict] [--scaffold]

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { buildRoutesJson } from './tools/routes-json.mjs';
import { mergePorts, serializeRegistry } from './tools/registry-json.mjs';
import { STUB_MARKER, buildStubSource, findStubPorts } from './tools/ports.mjs';
import { BLOB_DDL, BLOB_TABLE } from './kernel/storage.mjs';
import { BLOCK, DECLARED, renderReadiness, sweepAppSources } from './tools/readiness.mjs';
import { compilePolicies } from './compiler/src/policy.mjs';
import { compileClasses, compileOneMethod } from './compiler/src/classes.mjs';
import { reachableClasses, reachedMailables } from './compiler/src/mail-reach.mjs';
import { viewFileName } from './compiler/src/view-name.mjs';
import { ensureVendorLite } from './tools/vendor-lite.mjs';
import { ORACLE_PHP, resolvePhp } from './tools/php-runtime.mjs';
import { compileView } from './compiler/blade.mjs';
import { transpile } from './compiler/src/transpiler.mjs';
import { provisionPhp } from './tools/php-provision.mjs';
import { computeBuildCacheKey } from './tools/build-cache.mjs';
import { commitDist, discardStaging } from './compiler/src/dist-swap.mjs';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const pkgDir = dirname(fileURLToPath(import.meta.url));
let appDir;
if (existsSync(join(process.cwd(), 'artisan')) && existsSync(join(process.cwd(), 'vendor'))) {
  appDir = process.cwd();
} else if (existsSync(join(dirname(pkgDir), 'artisan'))) {
  appDir = dirname(pkgDir);
} else {
  appDir = process.cwd();
}
const isNpmMode = appDir !== pkgDir && existsSync(join(appDir, 'artisan'));
// The build writes into a STAGING directory and swaps it into place only after
// every artifact landed (see the end of this file). A build that fails halfway
// used to leave a half-written `dist/` behind - an operator (or a watcher)
// could then deploy an artifact the build never finished, and the bundler's
// error named a missing file instead of the skipped route that caused it.
const distFinal = isNpmMode ? join(appDir, 'dist') : join(pkgDir, 'dist');
const dist = distFinal + '.building';
const cacheDir = isNpmMode ? join(appDir, '.cache', 'laravel-workers') : join(pkgDir, '.cache');
const strict = process.argv.includes('--strict');
const scaffold = process.argv.includes('--scaffold');
// A cache HIT is a no-op build: no PHP boots, no vendor provisioning, no
// APP_KEY write. The escape hatch must exist because the key is a model, not a
// proof: an operator can always force the full pipeline.
const noCache = process.argv.includes('--no-cache') || process.env.LW_NO_BUILD_CACHE === '1';
// The interpreter that boots the app. It is RESOLVED below, once composer.json
// has been read: the app's own `require.php` decides which installed PHP can
// parse it, and hard-coding `php` from PATH fails for every user whose default
// differs from the app's. `PHP` stays a module-level binding so every tool call
// below uses the same binary.
let PHP = 'php';
// The PHP preflight lives below, after `fail` is initialised (calling a
// `const` before its declaration throws ReferenceError, and a bare catch
// would swallow it — the preflight would be dead code on exactly the path it
// exists to handle).

// Where the app's PHP dependencies live. An app that runs locally has them in
// <app>/vendor; a fresh clone has none, and `vendor:ensure` (tools/vendor-lite.mjs)
// keeps a content-addressed copy instead. Either way the helpers and artisan
// read the same override, so nothing below has to know which it is.
let vendorDir = process.env.LW_VENDOR_DIR ? resolve(process.env.LW_VENDOR_DIR) : null;
if (vendorDir) {
  const ok = existsSync(join(vendorDir, 'autoload.php')) || existsSync(join(vendorDir, 'vendor/autoload.php'));
  if (!ok) fail(`LW_VENDOR_DIR is set to "${process.env.LW_VENDOR_DIR}" but no autoload.php was found there (looked for <dir>/autoload.php and <dir>/vendor/autoload.php)`);
}
// Child PHP processes inherit this: artisan needs it, and the tools/*.php helpers
// read it through tools/_root.php.
// `dbSandboxPath` (set below, before the first boot) points at the build-time
// SQLite sandbox when the app's own SQLite database is absent — so every child
// that boots the app (routes, prerender, config dump) can reach the schema
// without the operator having a populated database. It is never a cloud resource.
let dbSandboxPath = null;
const childEnv = () => ({
  ...process.env,
  LW_APP_ROOT: appDir,
  ...(vendorDir ? { LW_VENDOR_DIR: vendorDir } : {}),
  ...(dbSandboxPath ? { DB_DATABASE: dbSandboxPath } : {}),
});

// One place the operator looks to answer "can my app run at the edge?"
const findings = [];
const note = (f) => findings.push(f);
const relPath = (p) => relative(appDir, p).split('\\').join('/');

// A missing wrangler.jsonc is deploy input, not a dist artifact, so it must be
// restored even on a build-cache hit: otherwise the next `deploy` fails after a
// successful (cached) build. Scaffolding is local and never provisions a D1.
function ensureWranglerConfig() {
  const wranglerPath = join(appDir, 'wrangler.jsonc');
  if (existsSync(wranglerPath)) {
    console.log('  -> wrangler.jsonc already exists - left as-is (run `npx laravel-workers deploy` to provision/fill database_id)');
    return;
  }
  const appSlug = basename(appDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = appSlug.slice(0, 63).replace(/-+$/g, '') || 'laravel-workers-app';
  const dbSlug = (slug.slice(0, 60).replace(/-+$/g, '') || 'laravel-workers-app') + '-db';
  writeFileSync(wranglerPath, `{
  "name": "${slug}",
  "main": "./dist/src/worker.mjs",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "./dist/public", "binding": "ASSETS" },
  "d1_databases": [ { "binding": "DB", "database_name": "${dbSlug}", "database_id": "REPLACE_WITH_D1_ID" } ],
  "observability": { "enabled": true }
}
`);
  console.log(`  -> wrangler.jsonc: written (worker name "${slug}") — run \`npx laravel-workers deploy\` (guided) or \`npx wrangler d1 create ${dbSlug}\` (manual)`);
}

const fail = (msg) => {
  console.error('BUILD FAILED: ' + msg);
  // The staging directory is thrown away: `dist/` keeps the last build that
  // COMPLETED (a failed build must never leave a half-written dist behind).
  discardStaging(dist);
  // A failed build must never print a green verdict. Failures raised before
  // their own check runs (missing frontend manifest, PHP preflight) would
  // otherwise leave `findings` empty and the banner would read RUNS ON THE
  // EDGE directly under BUILD FAILED. Record the failure as the blocking
  // finding so the verdict is DOES NOT RUN with the reason attached.
  if (!findings.some((f) => f && f.severity === BLOCK)) {
    note({
      severity: BLOCK,
      area: 'config',
      cause: msg.split('\n')[0],
      fix: 'fix the error above, then re-run the build',
    });
  }
  console.error(renderReadiness(findings, { dist: relPath(distFinal) }));
  process.exit(1);
};

// Resolve the interpreter that can boot THIS app.
//
// The app's `require.php` is the constraint, not the machine's default: an app
// declaring `^8.4` cannot be parsed by 8.3 at all, and an older app may not run
// on 8.4. `resolvePhp` honours PHP_BIN, then `php` from PATH, then any versioned
// interpreter installed on the machine (Laragon, XAMPP, C:\php, Herd,
// Homebrew, asdf, phpenv, mise), highest satisfying version first. When nothing
// satisfies it, the error names every interpreter found and the ways out.
let phpRequirement = null;
if (isNpmMode) {
  try {
    phpRequirement = JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8')).require?.php || null;
  } catch {
    phpRequirement = null; // no/unreadable composer.json: no constraint to enforce
  }
}
let resolved = null;
try {
  resolved = resolvePhp({ requirement: phpRequirement });
} catch (e) {
  // Nothing installed can boot the app. When the app declares a requirement and
  // provisioning is allowed, fetch a portable interpreter into the cache rather
  // than refusing to build: "this machine has no PHP 8.4" is not a reason an
  // 8.4 app cannot be built. LW_NO_PHP_PROVISION=1 opts out (offline CI).
  if (phpRequirement && !process.env.LW_NO_PHP_PROVISION) {
    console.log(`• php: no installed interpreter satisfies ${phpRequirement} — provisioning a portable build`);
    try {
      const p = await provisionPhp(phpRequirement);
      resolved = { bin: p.bin, version: p.version, source: p.source };
      console.log(`  -> php ${p.version} ${p.cached ? 'reused from cache' : 'downloaded and verified (sha256)'} at ${p.bin}`);
    } catch (e2) {
      fail(e.message + '\n  automatic provisioning also failed: ' + e2.message);
    }
  } else {
    fail(e.message);
  }
}
PHP = resolved.bin;
// A build with a different interpreter is valid — it boots the app — but the
// parity suite is pinned to ORACLE_PHP, so say which one was used. Silence
// here would let a version-specific divergence look like a compiler bug.
if (resolved.source !== 'PATH' || resolved.version !== ORACLE_PHP) {
  console.log(
    `• php: ${resolved.version} (${resolved.bin})` +
      (phpRequirement ? ` — app requires ${phpRequirement}` : '') +
      (resolved.version === ORACLE_PHP ? '' : `; parity suite is pinned to ${ORACLE_PHP}`)
  );
}
const lwConfig = process.env.LW_CONFIG ? resolve(appDir, process.env.LW_CONFIG) : null;
if (lwConfig && !existsSync(lwConfig))
  fail(`LW_CONFIG is set to "${process.env.LW_CONFIG}" but that file was not found (resolved: ${lwConfig})`);
const registryCandidates = [
  ...(lwConfig ? [lwConfig] : []),
  join(appDir, 'registry.json'),
  join(appDir, 'laravel-workers.json'),
  join(appDir, 'edge/registry.json'),
  join(pkgDir, 'registry.json'),
];
let registryPath = null;
for (const p of registryCandidates) if (existsSync(p)) { registryPath = p; break; }
if (lwConfig && registryPath === lwConfig) console.log(`• registry: LW_CONFIG -> ${registryPath}`);
let registry = {};
if (registryPath) {
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (e) {
    fail(
      `the registry (${relPath(registryPath)}) is not valid JSON: ${e.message} — fix the file; ` +
        'it is read as-is, so comments and trailing commas are not allowed'
    );
  }
} else {
  registryPath = join(appDir, 'registry.json');
  console.log('• registry: none found — using defaults (autoSnapshot on, no ports/ignore); add registry.json or set LW_CONFIG to declare routes');
}
const lwPortsDir = process.env.LW_PORTS_DIR ? resolve(appDir, process.env.LW_PORTS_DIR) : null;
if (lwPortsDir && !existsSync(lwPortsDir))
  fail(`LW_PORTS_DIR is set to "${process.env.LW_PORTS_DIR}" but that directory was not found (resolved: ${lwPortsDir})`);
const autoSnapshot = registry.autoSnapshot !== false;
const staticMap = Object.entries(registry.static || {});
const portEntries = Object.entries(registry.ports || {});
const ignoreMap = Object.entries(registry.ignore || {});
const viewMap = Object.entries(registry.views || {});
// Ensure the local deploy config before the cache short-circuit: the file is
// not part of dist/, so a cache hit must still restore a config the operator
// deleted. The build never provisions the D1 it names.
ensureWranglerConfig();
// ---- unchanged-input build cache -------------------------------------------
// The cache is checked BEFORE vendor provisioning and APP_KEY mutation: on a
// hit the only PHP process is the version probe inside resolvePhp(), not a
// Laravel boot. A missing/incomplete dist is a miss, so a crashed or manually
// deleted artifact never masquerades as current.
const cacheStampPath = join(cacheDir, 'build-cache.json');
// A stamp with a matching key is not enough: an interrupted deploy cleanup, an
// antivirus quarantine or a manual `rm` can leave a partial dist. These files
// are emitted by every successful build (worker entry, generated route/config
// tables, schema and the Static Assets route manifest); if one is gone the
// build must run again rather than serve a half-worker.
const cacheArtifactFiles = [
  'src/worker.mjs',
  'src/routes.generated.mjs',
  'src/config.generated.mjs',
  'schema.json',
  'public/_routes.json',
];
const missingCacheArtifacts = () =>
  cacheArtifactFiles.filter((file) => !existsSync(join(distFinal, file)));
let buildCacheKey = null;
let buildCacheInfo = null;
try {
  buildCacheInfo = computeBuildCacheKey({
    appDir,
    pkgDir,
    registryPath,
    vendorDir,
    php: resolved,
    flags: { strict, scaffold, argv: process.argv.slice(2).filter((a) => a !== '--no-cache') },
    env: process.env,
  });
  buildCacheKey = buildCacheInfo.key;
} catch (e) {
  console.log(`  build cache: key could not be computed (${String(e.message || e).slice(0, 160)}) — running the full build`);
}
if (noCache) {
  console.log('• build cache: disabled (--no-cache / LW_NO_BUILD_CACHE=1)');
} else if (buildCacheKey) {
  let stamp = null;
  try {
    stamp = JSON.parse(readFileSync(cacheStampPath, 'utf8'));
  } catch {
    /* no stamp or unreadable: miss */
  }
  if (stamp && stamp.version === 1 && stamp.key === buildCacheKey) {
    const missing = missingCacheArtifacts();
    if (!missing.length) {
      console.log(
        `• build cache: hit (${buildCacheInfo.files} input files unchanged; built with PHP ${stamp.phpVersion || '?'}) — dist/ is current`
      );
      console.log('  (pass --no-cache or set LW_NO_BUILD_CACHE=1 to rebuild anyway)');
      process.exit(0);
    }
    console.log(`• build cache: miss (dist artifact missing: ${missing.join(', ')}) — running the build`);
  } else {
    console.log(`• build cache: miss (${buildCacheInfo.files} input files hashed) — running the build`);
  }
}

if (!vendorDir && !existsSync(join(appDir, 'vendor/autoload.php'))) {
  // No vendor/ and no override: provision a composer-free vendor-lite cache
  // (fetch dist zips + write our own autoloader - no composer install).
  try {
    const v = await ensureVendorLite(appDir, { silent: true });
    vendorDir = v.dir;
    console.log(`  -> vendor: provisioned via composer-free vendor-lite at ${v.dir}`);
  } catch (e) {
    note({
      route: null,
      area: 'config',
      severity: BLOCK,
      cause: 'the app has no vendor/ (and LW_VENDOR_DIR is not set)',
      fix: 'the build boots your app to read its routes, config and schema, so it needs the PHP dependencies',
      paths: [
        { tier: 'free', what: 'the laravel-workers vendor-lite installer fetches the needed packages directly (no composer install)' },
        { tier: 'free', what: 'or reuse a cached tree: npx laravel-workers vendor:ensure && LW_VENDOR_DIR=<printed dir> npx laravel-workers build --strict' },
      ],
    });
    fail(`vendor provisioning failed: ${e.message}`);
  }
}

// ---- ensure APP_KEY (automatic; no artisan, no manual step) ----
// The compiled worker encrypts cookies/sessions with app.key, so the key must be
// STABLE across builds and deploys — a per-build random key would invalidate
// every session on redeploy. So: if the app already has a key (in .env, or in
// the real environment), keep it; otherwise write one into .env exactly like
// `artisan key:generate` would (base64 of 32 random bytes).
{
  const envPath = join(appDir, '.env');
  let envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const hasKeyInEnvFile = /^APP_KEY=[ \t]*\S/m.test(envText);
  const hasKeyInProcess = !!(process.env.APP_KEY && String(process.env.APP_KEY).trim());
  if (!hasKeyInEnvFile && !hasKeyInProcess) {
    if (!existsSync(envPath)) {
      const examplePath = join(appDir, '.env.example');
      if (existsSync(examplePath)) {
        envText = readFileSync(examplePath, 'utf8');
      }
    }
    const key = 'base64:' + randomBytes(32).toString('base64');
    envText = /^APP_KEY=.*$/m.test(envText)
      ? envText.replace(/^APP_KEY=.*$/m, 'APP_KEY=' + key)
      : envText + (envText.endsWith('\n') || envText === '' ? '' : '\n') + 'APP_KEY=' + key + '\n';
    writeFileSync(envPath, envText);
    process.env.APP_KEY = key;
    console.log('  -> APP_KEY: generated and written to .env (the worker signs cookies with it)');
  }
}

// A Vite app writes public/build/manifest.json; a Mix/webpack app writes
// public/mix-manifest.json. Whether the build NEEDS the frontend manifests is
// a property of the app, not of the repo:
//   - any Blade view calling @vite()/mix()  → the compiled HTML embeds hashed
//     asset URLs from the manifest → a missing manifest makes compile-view.php
//     throw (ViteManifestNotFoundException / an asset() miss) → fail loud with
//     the real reason. No silent-wrong HTML ships.
//   - no view touches the frontend manifests (a backend-only API app) → nothing
//     needs them; defer here used to fail the whole build for NO reason.
// So this block records WHICH manifest exists. A fullstack app without one no
// longer stops here with a to-do: the build runs the app's OWN frontend
// toolchain — bun first (probed once at the start of this step), npm as the
// automatic fallback — and re-checks. It only stops when there is nothing to
// run (no package.json, no "build" script, neither bun nor npm on PATH) or the
// frontend build itself fails: loud, above the compile table. The path is the
// one the app's own `bun run build` / `npm run build` writes.
{
  const manifestCandidates = [
    join(appDir, 'public/build/manifest.json'),
    join(appDir, 'public/dist/manifest.json'),
    join(appDir, 'public/mix-manifest.json'),
  ];
  const manifestPath = manifestCandidates.find((p) => existsSync(p));
  if (!manifestPath) {
    // The app is fullstack iff some Blade view calls the frontend (Vite's
    // @vite() or Laravel Mix's mix()). `mix` must stand alone — a lookbehind
    // keeps CSS `color-mix(...)` inside a welcome page's inline <style> from
    // reading as a frontend build (it did: a backend-only run installed bun
    // dependencies for nothing). A missing manifest means the compiled HTML
    // would reference asset URLs that don't exist — silent-wrong — so build
    // NOW with the view that needs it. Backend-only: no manifest needed.
    const viewsRoot = join(appDir, 'resources', 'views');
    const viteViews = [];
    const scan = (dir) => {
      if (!existsSync(dir)) return;
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) scan(p);
        else if (/\.blade\.php$/.test(ent.name)) {
          const src = readFileSync(p, 'utf8');
          if (/@vite\s*\(|(?<![-\w])mix\s*\(/.test(src)) viteViews.push(relPath(p));
        }
      }
    };
    scan(viewsRoot);
    if (viteViews.length) {
      const viewList =
        viteViews.length > 1 ? viteViews.length + ' Blade views (' + viteViews.join(', ') + ')' : viteViews[0];
      const candidates = manifestCandidates.map((p) => relPath(p)).join(', ');
      let scripts = {};
      try {
        scripts = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).scripts || {};
      } catch {
        // no package.json / unreadable — scripts stays empty
      }
      if (!scripts.build) {
        fail(
          'this is a FULLSTACK app: ' +
            viewList +
            ' call @vite()/mix(), but no frontend manifest is built (' +
            candidates +
            ') and there is no package.json "build" script to run automatically. ' +
            'Add the Vite frontend (package.json with scripts.build) or drop @vite()/mix() from those views. ' +
            'A backend-only API app (no @vite in any view) needs no manifest at all.'
        );
      }
      // Runner choice is probed ONCE, at the start: bun first — it is an
      // engine of this toolchain and keeps its installs fast — with npm as the
      // automatic fallback when bun is absent from PATH or its install/build
      // fails. Install runs only when node_modules is absent: touching an
      // existing tree would be a surprise.
      const hadDeps = existsSync(join(appDir, 'node_modules'));
      const has = (cmd) => {
        try {
          execFileSync(cmd, ['--version'], { cwd: appDir, stdio: 'ignore', shell: process.platform === 'win32' });
          return true;
        } catch {
          return false;
        }
      };
      const run = (cmd, args) => {
        console.log(`\u2022 manifest: no frontend manifest — running \`${cmd} ${args.join(' ')}\` (the app's own Vite)`);
        execFileSync(cmd, args, { cwd: appDir, stdio: 'inherit', shell: process.platform === 'win32' });
      };
      const attempt = (cmd) => {
        if (!hadDeps) {
          // bun on Windows can take bunfig's `dir = "~/.bun/install/cache"`
          // as a path RELATIVE TO THE APP and litter `~/` inside the project
          // (observed on every local install). Pin an absolute cache dir:
          // same global cache, clean tree.
          const install =
            cmd === 'bun' ? ['install', '--cache-dir=' + join(homedir(), '.bun', 'install', 'cache')] : ['install'];
          run(cmd, install);
        }
        run(cmd, ['run', 'build']);
      };
      const exitOf = (e) => (e && e.status != null ? e.status : 'unknown');
      const bunTried = has('bun');
      let runner = null;
      if (bunTried) {
        try {
          attempt('bun');
          runner = hadDeps ? 'bun run build' : 'bun install + bun run build';
        } catch (e) {
          console.log(
            `\u2022 manifest: bun failed (exit ${exitOf(e)}) — falling back to npm (output above)`
          );
        }
      }
      if (!runner) {
        if (!has('npm')) {
          fail(
            'this is a FULLSTACK app: ' +
              viewList +
              ' call @vite()/mix(), but no frontend manifest is built (' +
              candidates +
              ') and neither `bun` nor `npm` is on PATH to run the app\u2019s frontend build. ' +
              'Install bun (or npm), or run the frontend build yourself, then re-run.'
          );
        }
        try {
          attempt('npm');
          runner = hadDeps ? 'npm run build' : 'npm install + npm run build';
        } catch (e) {
          fail(
            'this is a FULLSTACK app: ' +
              viewList +
              ' call @vite()/mix(), and the automatic frontend build failed (' +
              (bunTried ? 'bun fell back to npm; ' : '') +
              'exit ' +
              exitOf(e) +
              ', output above). Fix the app\u2019s frontend (`bun run build` / `npm install && npm run build`) and re-run. ' +
              'With no manifest at (' +
              candidates +
              ') the compiled HTML would reference assets that 404 at the edge.'
          );
        }
      }
      const built = manifestCandidates.find((p) => existsSync(p));
      if (!built) {
        fail(
          'the frontend build finished but wrote none of the expected manifests (' +
            candidates +
            ') — check the output path in vite.config / webpack.mix.js.'
        );
      }
      console.log(`\u2022 manifest: ${relPath(built)} (frontend built automatically — ${runner})`);
    } else {
      console.log(
        '\u2022 manifest: no frontend manifest found (' +
          manifestCandidates.map((p) => relPath(p)).join(', ') +
          ') — no Blade view calls @vite()/mix(), treating this as backend-only (no frontend build needed)'
      );
    }
  } else {
    console.log(`\u2022 manifest: ${relPath(manifestPath)}`);
  }
}

// ---------- 1. compile migrations → D1 schema (+ a build-time DB sandbox) ----------
// One `migrate` run does two jobs: the D1 schema snapshot (dist/schema.json +
// dist/schema.sql, written later) AND a throwaway SQLite with that schema
// applied, so the build can BOOT the app for prerendering even on a fresh
// skeleton that ships no database file. A fresh `laravel new` app cannot boot
// without one (the session middleware reads `sessions` on every request), which
// used to read as "DOES NOT RUN" on the simplest possible project. The sandbox
// is NOT the app's database and NOT the cloud D1: it lives in the build cache,
// lasts only for the build. Applying dist/schema.sql to the remote D1 is done
// by `laravel-workers deploy` (or manually with
// `wrangler d1 execute DB --file=dist/schema.sql --remote`).
console.log('\u2022 compiling migrations \u2192 schema (D1 SQLite dialect, in-memory)');
mkdirSync(cacheDir, { recursive: true });
const schemaPath = join(cacheDir, 'schema.json');
{
  // Read the app's DB setting the way its own config does (env() → .env). Only a
  // SQLite database that is actually absent is shadowed; an existing file (with
  // data) or a differently-configured database is respected — the build never
  // points the app at a database it did not find.
  const envPath = join(appDir, '.env');
  const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const envVal = (name, dflt) => {
    const m = envText.match(new RegExp('^' + name + '=[ \\t]*(.*)$', 'm'));
    const v = String(process.env[name] ?? (m ? m[1] : '')).trim();
    return v || dflt;
  };
  const dbConn = envVal('DB_CONNECTION', 'sqlite');
  const dbDatabase = envVal('DB_DATABASE', 'database/database.sqlite');
  const dbFile = resolve(appDir, dbDatabase);
  // A file that exists but has never been migrated (the classic
  // `touch database/database.sqlite`) holds no schema either, so it counts as
  // absent — and it is never written to: seeding the build's own sandbox is a
  // build cache file, the app's data file stays the operator's to migrate.
  const hasOwnDb = existsSync(dbFile) && lstatSync(dbFile).size > 0;
  if (dbConn === 'sqlite' && !hasOwnDb) {
    dbSandboxPath = join(cacheDir, 'build.sqlite');
  }
}
execFileSync(
  PHP,
  [join(pkgDir, 'tools', 'schema-compile.php'), schemaPath, ...(dbSandboxPath ? [dbSandboxPath] : [])],
  { cwd: appDir, env: childEnv() }
);
if (dbSandboxPath) {
  console.log(
    `  -> build-time DB sandbox: ${dbSandboxPath}\n` +
      '     (the schema is applied so the app boots for prerender; the guided deploy\n' +
      '      applies it; manual: `wrangler d1 execute DB --file=dist/schema.sql --remote`)'
  );
}

// ---------- 1. export routes from the Laravel app ----------
console.log('• exporting routes from the route files with the static parser (no PHP boot)');
let listed;
try {
  // stderr = the static walk's scope disclosures and parse issues (streamed,
  // not captured: they belong in the build log even on success).
  const rawRoutes = execFileSync(process.execPath, [join(pkgDir, 'tools', 'routes-dump.mjs')], {
    cwd: appDir,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf8');
  try {
    listed = JSON.parse(rawRoutes);
  } catch {
    // A dump failure (a broken config/env file, a syntax error in a route or
    // config PHP source) is printed to STDOUT while the process still exits 0
    // — the real cause is in that text, not on stderr.
    const tail = rawRoutes.trim() ? rawRoutes.trim().split('\n').slice(-15).map((l) => '    ' + l).join('\n') : '    (empty)';
    fail(
      'route export failed — the route dump did not return the JSON route table\n' +
      '  dump output:\n' + tail +
      '\n  the build cannot continue without the route table — fix the error above, then re-run the build'
    );
  }
} catch (e) {
  // The scan is pure JS now, so a crash here is a parser/tooling failure, not
  // a boot failure — say that instead of pointing at .env/APP_KEY/DB.
  const stderr = e.stderr ? e.stderr.toString().trim() : '';
  const stdout = e.stdout ? e.stdout.toString().trim() : '';
  const outTail = stdout ? stdout.split('\n').slice(-15).join('\n') : '';
  const errTail = stderr ? stderr.split('\n').slice(-15).join('\n') : '';
  const combined = [errTail, outTail].filter(Boolean).join('\n');
  const errDetail = combined ? '\n  scanner output:\n    ' + combined.replace(/\n/g, '\n    ') : '';
  note({
    severity: BLOCK,
    area: 'route',
    cause: 'the static route scan failed' + (combined ? ': ' + combined.split('\n').pop().trim() : ''),
    fix: 'run `node tools/routes-dump.mjs` in the app directory to see the raw error',
  });
  fail(
    'route export crashed' + errDetail +
      '\n  the build cannot continue without the route table — this is a failure\n' +
      '  of the static scanner itself (a route file it cannot parse, most likely)\n' +
      '  -> run `node tools/routes-dump.mjs` in the app directory, fix what it prints'
  );
}
// Laravel only reports `path` for closure routes — controller-action routes
// (Route::get('/x', [XController::class, 'm']), Route::resource, invokable
// controllers) come back with path === null even though they live in routes/.
const isAppRoute = (r) => {
  const p = String(r.path || '');
  if (p) return p.startsWith('routes/');
  const action = String(r.action || '');
  return action !== '' && action !== 'Closure';
};
const appRoutes = listed.filter(isAppRoute);
const normalize = (u) => (u === '/' || u === '' ? '/' : '/' + String(u).replace(/^\/+|\/+$/g, ''));
// DECLARATION order, never a re-sort. Laravel answers the FIRST route whose
// pattern fits, walking the method's routes in REGISTRATION order
// (RouteCollection::match() -> Route::matches() first-wins), so an overlapping
// pattern pair resolves by precedence: a probe on Laravel 13 with
// `products/{id}` declared BEFORE `products/new` answers `products/{id}` for
// GET /products/new (reversing the declaration reverses the answer). The routes
// dump keeps declaration order for exactly this reason, and `new Set()` dedupes
// by URI while keeping the first occurrence - a uri-lexicographic table would
// answer `products/new` instead (the URL `-` and `{}` ordering differs).
const routes = [...new Set(appRoutes.map((r) => normalize(r.uri)))];
const methodsFor = new Map();
const metaFor = new Map(); // 'METHOD /uri' -> { name, domain }
for (const r of appRoutes) {
  const uri = normalize(r.uri);
  const set = methodsFor.get(uri) || new Set();
  const methods = String(r.method || 'GET').split('|');
  for (const m of methods) if (m) set.add(m);
  methodsFor.set(uri, set);
  for (const m of methods) {
    if (!m) continue;
    const key = m.toUpperCase() + ' ' + uri;
    if (!metaFor.has(key)) metaFor.set(key, { name: r.name ?? null, domain: r.domain ?? null, action: r.action ?? null, middleware: Array.isArray(r.middleware) ? r.middleware : null });
  }
}
const otherMethods = (route) =>
  [...(methodsFor.get(route) || new Set())].filter((m) => m !== 'GET' && m !== 'HEAD');
// first non-null name/domain/middleware across the route's methods (they share a
// uri in the table; middleware is preferred from GET like middlewareForRoute).
// The emitted `middleware` is what kernel/http.mjs uses to decide whether the
// `web` group (EncryptCookies → StartSession → CSRF) and route middleware
// (auth/guest/throttle) run — omitting it silently downgraded every compiled
// route to the bare, session-less path.
const metaForRoute = (route) => {
  let name = null;
  let domain = null;
  let middleware = null;
  for (const m of methodsFor.get(route) || []) {
    const meta = metaFor.get(m + ' ' + route);
    if (!meta) continue;
    if (name == null) name = meta.name;
    if (domain == null) domain = meta.domain;
    if (middleware == null && meta.middleware) middleware = meta.middleware;
  }
  return { name, domain, middleware };
};
// route:list action for a route (prefer GET — the only method controller
// transpilation supports today).
const actionForRoute = (route) => {
  const getMeta = metaFor.get('GET ' + route);
  if (getMeta && getMeta.action) return getMeta.action;
  for (const m of methodsFor.get(route) || []) {
    const meta = metaFor.get(m + ' ' + route);
    if (meta && meta.action) return meta.action;
  }
  return null;
};
// route:list middleware for a route (prefer GET — see above).
const middlewareForRoute = (route) => {
  const getMeta = metaFor.get('GET ' + route);
  if (getMeta && getMeta.middleware) return getMeta.middleware;
  for (const m of methodsFor.get(route) || []) {
    const meta = metaFor.get(m + ' ' + route);
    if (meta && meta.middleware) return meta.middleware;
  }
  return null;
};
// The verb a uri's "main" handler answers: GET when present, else the first
// non-HEAD verb (POST for form-only routes). Extra verbs (e.g. Breeze's
// GET+POST /login) are compiled as separate per-verb handlers below.
const mainVerbFor = (route) => {
  const set = methodsFor.get(route) || new Set();
  if (set.has('GET')) return 'GET';
  const others = [...set].filter((m) => m !== 'HEAD');
  return others.length ? others[0] : null;
};
const extraVerbsFor = (route) =>
  [...(methodsFor.get(route) || new Set())].filter((m) => m !== 'HEAD' && m !== mainVerbFor(route));
const metaForVerb = (route, verb) => metaFor.get(String(verb).toUpperCase() + ' ' + route) || null;
// Middleware kernel/http.mjs actually honours. auth/guest run on top of the web
// group; numeric `throttle:n[,m]` runs against the D1-backed `database` cache.
const HONOURED_MIDDLEWARE = new Set(['web', 'api', 'substitute_bindings', 'bindings', 'auth', 'auth.basic', 'guest']);
const isHonouredMiddleware = (m) => {
  const str = String(m);
  const name = str.split(':')[0];
  if (HONOURED_MIDDLEWARE.has(name)) return true;
  if (name !== 'throttle') return false;
  const spec = str.slice('throttle'.length).replace(/^:/, '');
  return spec === '' || /^\d+(,\d+)?$/.test(spec); // numeric spec only
};

const MIDDLEWARE_FIX = (m, route) => {
  const name = String(m).split(':')[0];
  const ignore = '{\"ignore\": {\"' + route + '\": \"<why the edge does not serve it>\"}}';
  switch (name) {
    case 'verified': return 'email verification needs a signed URL the edge cannot mint the same way -- add a port, or ' + ignore;
    case 'signed': return 'signed URLs are verified against app.key (a port can do it with WebCrypto) -- add a port, or ' + ignore;
    case 'password.confirm': return 'the password-confirm window is session state the compiled rung does not port -- add a port, or ' + ignore;
    case 'can': return 'a route-level `can:` check needs the policy at the route stage -- call `$this->authorize()` inside the controller instead (that compiles), or add a port';
    case 'throttle': return 'a NAMED rate limiter lives in AppServiceProvider and the build cannot read it -- use a numeric throttle (e.g. throttle:60,1) or ' + ignore;
    case 'cors': return 'CORS headers are added by a port or by the Cloudflare dashboard (Transform Rules) -- the compiled rung does not add them';
    default: return 'add a port for this route (build --scaffold), or ' + ignore;
  }
};
console.log(`  app routes (${routes.length}): ${routes.join('  ')}`);
const skippedRoutes = [
  ...new Set(listed.filter((r) => !isAppRoute(r)).map((r) => normalize(r.uri))),
];
if (skippedRoutes.length) {
  const shown = skippedRoutes.slice(0, 5).join(', ');
  console.log(
    `  skipped ${skippedRoutes.length} route(s) defined outside routes/ (not part of the edge build): ${shown}${
      skippedRoutes.length > 5 ? ', …' : ''
    }`
  );
}

// ---------- 2. prerender helper (boots the real app, build time only) ----------
// Origins a snapshot must turn relative: localhost (what prerender renders
// against) AND the app's own APP_URL. A Herd/Valet domain (myapp.test) is just
// as much a dev origin — keeping it absolute ships dead links to the edge.
// External origins (laravel.com, fonts, APIs) are never touched.
const appUrlOrigin = (() => {
  let raw = process.env.APP_URL || '';
  try {
    const envPath = join(appDir, '.env');
    if (existsSync(envPath)) {
      const m = readFileSync(envPath, 'utf8').match(/^APP_URL=[ \t]*(.*)$/m);
      if (m && m[1].trim()) raw = m[1].trim();
    }
  } catch { /* keep whatever process.env said */ }
  try {
    const u = new URL(raw);
    return u.host ? u.protocol + '//' + u.host : '';
  } catch {
    return ''; // no APP_URL / not an absolute URL
  }
})();
const originRe = new RegExp(
  '(?:https?:)?//(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::\\d+)?/|' +
    (appUrlOrigin ? appUrlOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/' : '(?!)'),
  'g'
);

// The framework can write an error page to stdout around our payload (console
// exception renderers bypass PHP output buffering), so prerender.php terminates
// its stdout with a marker and the JSON that follows it.
const PRERENDER_MARKER = '---LW-PRERENDER-JSON---';

// A failure that is NOT an app bug: the route asks for a runtime binding the
// build sandbox has no access to (D1 at build time). Kept separate so the
// verdict can mark it DECLARED (works once deployed) instead of BLOCK.
const isRuntimeBindingError = (reason) => /Database connection \[[^\]]+\] not configured|D1 (?:database configuration|Worker driver) requires (?:a|an) "/.test(String(reason));

// Track E (prerender-batch): every route that will be rendered enters ONE
// boot — one PHP process, one Laravel startup, N requests in order. The
// marker still fences the payload (an error page can surround it on stdout).
const prerenderBatch = (uris) => {
  const byUri = new Map();
  if (!uris.length) return byUri;
  let out;
  try {
    out = execFileSync(PHP, ['-d', 'display_errors=stderr', join(pkgDir, 'tools', 'prerender.php'), ...uris], {
      cwd: appDir,
      env: childEnv(),
      maxBuffer: 1 << 28,
    }).toString('utf8');
  } catch (e) {
    const stderr = String(e.stderr || '').trim();
    const stdout = String(e.stdout || '').trim();
    const detail = (stderr || stdout || String(e.message || '')).slice(-2000);
    fail(`prerender crashed (${uris.length} routes, first ${uris[0]})${detail ? `:\n${detail}` : ''}`);
  }
  const idx = out.lastIndexOf(PRERENDER_MARKER);
  const jsonText = idx >= 0 ? out.slice(idx + PRERENDER_MARKER.length) : out;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    fail(`prerender returned non-JSON for ${uris[0]} (+${uris.length - 1} more): ${jsonText.trim().slice(0, 200)}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== uris.length) {
    fail(
      `prerender returned ${Array.isArray(parsed) ? parsed.length + ' result(s)' : 'no array'} for ${uris.length} route(s) — one boot must answer every URI`
    );
  }
  for (const p of parsed) byUri.set(typeof p.uri === 'string' ? p.uri : '', p);
  return byUri;
};

// ---------- 3. dist skeleton + prerendered pages ----------
const hotFile = join(appDir, 'public/hot');
const hotAside = join(appDir, 'public/hot.edge-build-aside');
if (existsSync(hotFile)) {
  renameSync(hotFile, hotAside);
  console.log('  (moved public/hot aside for the build)');
}
// Clean dist/. On Windows a running `wrangler dev` (or editor) can hold a handle on
// dist/ or a subdirectory: file deletion still works, so fall back to wiping the
// contents and keeping the locked directory shells — the build rewrites everything
// fresh and the watcher picks the changes up.
for (const entry of readdirSync(appDir)) {
  if (entry.startsWith('dist.old-')) {
    try {
      rmSync(join(appDir, entry), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      /* still locked — try again next build */
    }
  }
}
try {
  rmSync(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
} catch {
  if (existsSync(dist)) {
    for (const entry of readdirSync(dist)) {
      try {
        rmSync(join(dist, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        console.log(
          `  (warning: ${relative(appDir, join(dist, entry))} is locked by a running process — restart the dev server if build output looks stale)`
        );
      }
    }
  }
}
mkdirSync(join(dist, 'public'), { recursive: true });
mkdirSync(join(dist, 'src'), { recursive: true });

const writePage = (file, html) => {
  const rel = html.replace(originRe, '/');
  const outPath = join(dist, 'public', file);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, rel);
  return { bytes: rel.length, fixed: (html.match(originRe) || []).length };
};

const snapshots = [];
const partials = [];
const needsPort = [];
const uncompiledExtraNonPost = [];

// Track E (prerender-batch): the render set is decided BEFORE the boot —
// every filter below only reads build state, then one batch covers the
// static entries and the auto-snapshots.
const handled = new Set([
  ...staticMap.map(([r]) => r),
  ...portEntries.map(([r]) => r),
  ...viewMap.map(([r]) => r),
  ...ignoreMap.map(([r]) => r),
]);
// Why a route is NOT snapshotted, or null when it is. Kept pure (no side
// effects) so the set can be collected before the single prerender batch.
const snapshotSkip = (route) => {
  if (!autoSnapshot) return 'unhandled (autoSnapshot: false)';
  const methods = methodsFor.get(route) || new Set();
  if (!methods.has('GET')) return `no GET (${[...methods].join(', ') || '?'})`;
  if (route.includes('{')) return 'dynamic segment — needs a port';
  // A controller route of the APP is compiled, not snapshotted: the build-time
  // page is the fallback for a route the build cannot compile. Snapshotting
  // it answered a stale page for anything the request decides (a query
  // string, a row created during the run) while the compiled controller was
  // never reached - the shadow compared the baked page and called it parity.
  //
  // A FRAMEWORK controller is different: `Illuminate\...` is not the app's
  // code and the build never compiles it (the composer autoload cannot even
  // resolve it), so its snapshot is the right answer - Laravel's own `/up`
  // health route is exactly that.
  const action = actionForRoute(route);
  const actionClass = action && action.includes('@') ? action.slice(0, action.lastIndexOf('@')) : action;
  if (actionClass && actionClass !== 'Closure' && !/^Illuminate\\/.test(actionClass)) {
    return 'a controller serves it — compiled, not snapshotted';
  }
  return null;
};
const prerenderUris = staticMap.map(([r]) => r);
for (const route of routes) {
  if (handled.has(route) || snapshotSkip(route)) continue;
  prerenderUris.push(route);
}
const prerendered = prerenderBatch(prerenderUris);
const prerender = (route) => {
  const res = prerendered.get(route);
  if (!res) fail(`prerender returned no result for ${route}`);
  return res;
};

try {
  // 3a. manual static pages (registry.json → "static")
  for (const [route, file] of staticMap) {
    const res = prerender(route);
    if (res.status < 200 || res.status >= 300) {
      const rawDetail = res.error ? String(res.error) : (res.body ? String(res.body) : '');
      const detail = res.error ? `: ${res.error}` : (res.body ? `: ${String(res.body).slice(0, 150).replace(/\n/g, ' ')}` : '');
      note({ route, area: 'route', severity: BLOCK, cause: `static entry "${route}" returned HTTP ${res.status}${detail}`, fix: rawDetail.includes('key:generate') ? 'run `npx laravel-workers init` to write .env + APP_KEY' : isRuntimeBindingError(rawDetail) ? 'this static entry reads a D1 binding the build cannot reach -- a static entry must prerender clean, so give the app a local sqlite fallback for the build (config/database.php) or make the route dynamic' : rawDetail.includes('database') ? 'prerender renders this route for real, so it needs live data: prepare a local DB with data (touch database/database.sqlite && php artisan migrate --seed). Note: the D1 schema itself does NOT need this — schema-compile derives it from migrations in memory' : 'a deployed build will prerender this route too -- fix the exception the app throws for bare GET `/` first' });
      fail(`static route ${route} returned HTTP ${res.status}${detail}`);
    }
    const { bytes, fixed } = writePage(file, res.body);
    console.log(`• static ${route} -> public/${file} (${bytes} bytes, ${fixed} URL(s) made relative)`);
    if (otherMethods(route).length) partials.push({ route, methods: otherMethods(route) });
  }

  // 3b. auto-snapshot: clean GET routes appear on the edge on the next deploy
  for (const route of routes) {
    if (handled.has(route)) continue;
    const skip = snapshotSkip(route);
    if (skip) {
      needsPort.push({ route, reason: skip });
      continue;
    }
    const others = otherMethods(route);
    const res = prerender(route);
    const isHtml = String(res.content_type || '').includes('text/html');
    if (res.status >= 200 && res.status < 300 && isHtml) {
      const file = route === '/' ? 'index.html' : route.slice(1) + '/index.html';
      const { bytes, fixed } = writePage(file, res.body);
      snapshots.push(route);
      console.log(`• snapshot ${route} -> public/${file} (${bytes} bytes, ${fixed} URL(s) made relative)`);
      if (others.length) partials.push({ route, methods: others });
    } else if (res.status >= 200 && res.status < 300) {
      needsPort.push({ route, reason: `HTTP ${res.status} non-HTML (${res.content_type || '?'})` });
    } else {
      const to = res.location ? ` -> ${res.location}` : '';
      const why = res.error ? `: ${res.error}` : '';
      needsPort.push({ route, reason: `HTTP ${res.status}${to}${why}` });
    }
  }
} finally {
  if (existsSync(hotAside)) renameSync(hotAside, hotFile);
}

// ---------- 2b. runtime config (compiled HTTP kernel) ----------
// kernel/http.mjs reads a FLAT dotted config. Anything the compiled rung cannot
// honour fails the build here instead of producing a silently-degraded worker.
console.log('• dumping runtime config via `tools/config-dump.mjs`');
let runtimeConfig;
try {
  const raw = execFileSync(process.execPath, [join(pkgDir, 'tools', 'config-dump.mjs')], {
    cwd: appDir,
    env: childEnv(),
    maxBuffer: 1 << 24,
  }).toString('utf8');
  try {
    runtimeConfig = JSON.parse(raw);
  } catch {
    const tail = raw.trim() ? raw.trim().split('\n').slice(-15).map((l) => '    ' + l).join('\n') : '    (empty)';
    note({
      severity: BLOCK,
      area: 'config',
      cause: 'runtime config dump failed — config-dump.mjs did not return the JSON config',
      fix: 'the dump error below is the cause; check APP_KEY, session.driver, and config file validity',
    });
    fail(
      'config dump failed — config-dump.mjs did not return the JSON runtime config\n' +
      '  dump output:\n' + tail
    );
  }
} catch (e) {
  const msg = String(e.stderr || e.message || '').trim().slice(0, 800);
  note({
    severity: BLOCK,
    area: 'config',
    cause: 'runtime config dump failed' + (msg ? ': ' + msg : ''),
    fix: 'check APP_KEY, session.driver, and config file validity; ensure required keys are present and valid JSON',
  });
  fail('config dump failed: ' + msg);
}
{
  const problems = [];
  const problem = (cause, fix) => { problems.push(cause); note({ route: null, area: 'config', severity: BLOCK, cause, fix }); };
  if (!runtimeConfig['app.key']) problem('app.key is empty', 'build.mjs auto-generates APP_KEY into .env when absent — if you see this, .env has APP_KEY= with no value; set it to the output of `node -e "console.log(\'base64:\',require(\'crypto\').randomBytes(32).toString(\'base64\'))"`');
  const driver = runtimeConfig['session.driver'];
  if (driver !== 'database' && driver !== 'cookie') {
    problem(`session.driver '${driver}' is not supported by the compiled rung (database/cookie only)`);
  }
  if (runtimeConfig['session.encrypt']) {
    problem('SESSION_ENCRYPT=true (EncryptedStore) is not supported by the compiled rung yet');
  }
  if (runtimeConfig['cookies.serialize']) {
    problem('EncryptCookies::$serialize must be false (cookie serialization is not ported)');
  }
  if ((runtimeConfig['hashing.driver'] || 'bcrypt') !== 'bcrypt') {
    problem(`hashing.driver '${runtimeConfig['hashing.driver']}' is not supported (bcrypt only)`);
  }
  const thirdPartyGuards = Object.entries(runtimeConfig)
    .filter(([k, v]) => k.startsWith('auth.guards.') && v && v.driver && v.driver !== 'session')
    .map(([k, v]) => `${k} (driver '${v.driver}')`);
  if (thirdPartyGuards.length) {
    problem(`guard(s) with a non-session driver: ${thirdPartyGuards.join(', ')} (only the session guard is ported)`);
  }
  if (problems.length) {
    fail('unsupported runtime config (the compiled rung would diverge from PHP):\n  - ' + problems.join('\n  - '));
  }
  writeFileSync(
    join(dist, 'src', 'config.generated.mjs'),
    '// generated by build.mjs — do not edit\n' + 'export default ' + JSON.stringify(runtimeConfig, null, 2) + ';\n'
  );
  console.log(`  -> dist/src/config.generated.mjs (session: ${driver}, guard: ${runtimeConfig['auth.defaults.guard']})`);
}

// The CORS paths (config/cors.php): HandleCors adds the CORS headers to the
// responses of the paths it matches, and answers the preflight with a 204.
// The compiled worker does not add the CORS headers, so the routes under a
// CORS path are skipped (a silent answer without the headers would break the
// browser's CORS - a divergence the build must not ship).
const corsPaths = (() => {
  const raw = runtimeConfig['cors.paths'];
  if (!raw || typeof raw !== 'object') return [];
  const out = [];
  for (const value of Object.values(raw)) {
    if (Array.isArray(value)) {
      for (const p of value) if (typeof p === 'string') out.push(p);
    } else if (typeof value === 'string') {
      out.push(value);
    }
  }
  return out;
})();
// Laravel matches CORS paths with `$request->is($pattern)` -> Str::is(): '*'
// matches any run of characters ANYWHERE in the pattern (full match), on the
// slash-trimmed path. `fullUrlIs()` is path-only too unless the pattern carries
// a scheme/host, which no sane cors.paths entry does.
const corsPathFor = (uri) => {
  const path = String(uri == null ? '' : uri).replace(/^\/+/, '').replace(/\/+$/, '');
  for (const pattern of corsPaths) {
    const p = pattern === '/' ? '/' : String(pattern).replace(/^\/+/, '').replace(/\/+$/, '');
    const re = new RegExp('^' + p.split('*').map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    if (re.test(path)) return pattern;
  }
  return null;
};

// The routes that dispatch a queued job, and the cron triggers the schedule
// produced: the queue check at the end reads both.
const queuePushes = [];
let cronTriggers = [];

// ---------- 3b-bis. the app's schedule -> Cloudflare Cron Triggers ----------
// The edge cannot run an artisan command, but it can *trigger* it: the schedule
// becomes a cron trigger (the padanan — Free allows 5 triggers per account) and
// the due event is queued for the app runtime that still exists.
{
  console.log('• dumping the app schedule via `tools/schedule-dump.mjs`');
  let schedule = { events: [] };
  try {
    const raw = execFileSync(process.execPath, [join(pkgDir, 'tools', 'schedule-dump.mjs')], {
      cwd: appDir,
      env: childEnv(),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).toString('utf8');
    schedule = JSON.parse(raw);
  } catch (e) {
    const detail = String(e.stderr || e.message || '').trim().slice(0, 300);
    console.log(`  schedule dump failed — the artifact ships an empty schedule: ${detail.slice(0, 200)}`);
    // A schedule that failed to compile is a missing cron trigger: the build
    // must say so in the verdict, not only in scrollback.
    note({
      route: null,
      severity: BLOCK,
      cause: `the schedule did not compile (${detail})`,
      fix: 'the edge ships no cron triggers until schedule-dump succeeds — run `node tools/schedule-dump.mjs` alone to see the full error',
    });
  }
  const events = Array.isArray(schedule.events) ? schedule.events : [];
  writeFileSync(
    join(dist, 'src', 'schedule.generated.mjs'),
    '// generated by build.mjs — do not edit\n' +
      'export const events = ' + JSON.stringify(events, null, 2) + ';\n' +
      'export default { events };\n'
  );
  // The Cloudflare cron trigger list (5 triggers per account on Free).
  const triggers = events.filter((e) => e && e.cron_triggerable && e.expression).map((e) => e.expression);
  const uniqueTriggers = [...new Set(triggers)];
  cronTriggers = uniqueTriggers;
  writeFileSync(
    join(dist, 'cron.json'),
    JSON.stringify({ crons: uniqueTriggers, events: events.map((e) => ({ name: e.name, expression: e.expression })) }, null, 2) + '\n'
  );
  const notTriggerable = events.filter((e) => e && !e.cron_triggerable);
  console.log(
    `  -> dist/src/schedule.generated.mjs (${events.length} event(s), ${uniqueTriggers.length} cron trigger(s))`
  );
  if (uniqueTriggers.length) {
    console.log(
      `  -> dist/cron.json (add the crons to wrangler.jsonc: {"triggers":{"crons":[${uniqueTriggers
        .map((c) => JSON.stringify(c))
        .join(', ')}]}})`
    );
  }
  for (const e of notTriggerable) {
    console.log(`     ! ${e.name}: ${e.reason || 'not triggerable at the edge'}`);
  }
}

// Eloquent auth providers name their model as a string; the compiled rung needs the
// generated Model class, so those FQCNs are always dumped into models.generated.mjs.
const authProviderFqcns = Object.entries(runtimeConfig)
  .filter(([k, v]) => k.startsWith('auth.providers.') && v && v.driver === 'eloquent' && typeof v.model === 'string')
  .map(([, v]) => v.model);

// ---------- 3c. compile view controllers ----------
const slugifyRoute = (route) =>
  route.replace(new RegExp('^/'), '').replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'home';

// Does the app bind a Cloudflare product under a given name? `product` is the
// wrangler key ('r2_buckets' | 'd1_databases'). `wrangler.jsonc` is JSON with
// comments, so the comments are stripped before parsing.
function hasBinding(appRoot, product, name) {
  const jsonc = join(appRoot, 'wrangler.jsonc');
  if (existsSync(jsonc)) {
    try {
      const text = readFileSync(jsonc, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const cfg = JSON.parse(text);
      const list = cfg[product];
      if (Array.isArray(list) && list.some((b) => b && b.binding === name)) return true;
    } catch {
      /* a wrangler.jsonc we cannot parse is not a binding we can rely on */
    }
  }
  const toml = join(appRoot, 'wrangler.toml');
  if (existsSync(toml)) {
    try {
      const text = readFileSync(toml, 'utf8');
      // Every [[product]] block (up to the next table): does one bind the name?
      return text
        .split(new RegExp('\\[\\[' + product + '\\]\\]'))
        .slice(1)
        .some((b) => new RegExp('binding\\s*=\\s*"' + name + '"').test(b.split(/\n\s*\[/)[0]));
    } catch {
      /* ignore */
    }
  }
  return false;
}

mkdirSync(join(dist, 'src', 'controllers'), { recursive: true });
mkdirSync(join(dist, 'src', 'views'), { recursive: true });
mkdirSync(join(dist, 'src', 'contexts'), { recursive: true });

// ---------- Blade compilation: blade2php is the authority ----------
// `blade2php` is the standalone compiler this package depends on (one-way: it
// knows nothing about laravel-workers). It emits the bytes Illuminate's
// BladeCompiler emits, so the transpiler's input contract is unchanged.
//
// compile-view.php still runs: it ALSO captures the view's runtime context
// (config, routes, vite, urls) by booting the app, and that capture is what
// the static-discovery phase replaces. The split is therefore PHP for the
// context, blade2php for the template.
//
// PHP's compiled output is kept as the ORACLE, not the product: a divergence
// or a blade2php failure is recorded as a blocking finding and the build falls
// back to the PHP bytes, so no build ever ships worse output than it did
// before the seam existed. LW_BLADE_JS=0 opts out entirely.
const bladeLaravel = (() => {
  try {
    const req = JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8')).require?.['laravel/framework'] ?? '';
    const m = /(\d+)/.exec(String(req));
    return m ? m[1] : null;
  } catch {
    return null; // no composer.json / no constraint: blade2php's own default
  }
})();
// The EXACT framework version from composer.lock (no boot, no vendor). Laravel
// changed bytes WITHIN a major — the view-data filter switched in v11.43.0 —
// so apps pinned to an older 11.x would diverge on every include if only the
// major reached blade2php.
const bladeInstalled = (() => {
  try {
    const lock = JSON.parse(readFileSync(join(appDir, 'composer.lock'), 'utf8'));
    const pkgs = [...(lock.packages || []), ...(lock['packages-dev'] || [])];
    const fw = pkgs.find((p) => p && p.name === 'laravel/framework');
    return fw && fw.version ? String(fw.version).replace(/^v/, '') : null;
  } catch {
    return null;
  }
})();
const bladeOff = process.env.LW_BLADE_JS === '0';
const blade = { checked: 0, diverged: 0, failed: 0 };

// The first byte where two compilations differ, for a message that locates the
// divergence instead of just announcing it.
const firstDiff = (a, b) => {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : limit;
};

function bladeCompile(dump, label) {
  if (bladeOff || !dump || typeof dump.compiled !== 'string') return;
  if (typeof dump.path !== 'string' || !existsSync(dump.path)) return;
  let out;
  try {
    out = compileView(readFileSync(dump.path, 'utf8'), {
      laravel: bladeLaravel ?? undefined,
      installed: bladeInstalled ?? undefined,
      app: appDir,
      path: dump.path,
    });
  } catch (e) {
    blade.failed++;
    const cause = `blade2php could not compile ${label}: ${e.code ? e.code + ' ' : ''}${e.message}`;
    console.error('  ! ' + cause);
    note({ severity: BLOCK, area: 'view', cause, fix: 'report it with the view source; until then this view builds with the PHP compiler' });
    return;
  }
  blade.checked++;
  const at = firstDiff(out.compiled, dump.compiled);
  if (at >= 0) {
    blade.diverged++;
    const around = (s) => s.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ');
    const cause =
      `blade2php diverged from Laravel for ${label} at byte ${at} ` +
      `(blade2php: "${around(out.compiled)}" | Laravel: "${around(dump.compiled)}")`;
    console.error('  ! ' + cause);
    note({ severity: BLOCK, area: 'view', cause, fix: 'report it with the view source; until then this view builds with the PHP compiler' });
    return;
  }
  // Byte-identical: the dump already holds exactly what blade2php produced, so
  // rewriting it would be pointless I/O. The check is the value here — it is
  // what lets the PHP compiler be deleted from this path later.
}

// Track E (transpile-batch): the transpiler is pure JS, so spawning
// `node compiler/bin/transpile.mjs` per view was process overhead only.
// Same code as the CLI, same bytes — the CLI stays for standalone debugging.
const transpileToModule = (dumpPath, viewModulePath) => {
  let data;
  try {
    data = JSON.parse(readFileSync(dumpPath, 'utf8'));
  } catch (e) {
    throw new Error(JSON.stringify([{ code: 'LW004', message: 'cannot read input: ' + (e.message || e), line: 0, column: 0, hint: '' }]));
  }
  if (typeof data.compiled !== 'string') {
    throw new Error(JSON.stringify([{ code: 'LW004', message: 'no .compiled string in JSON', line: 0, column: 0, hint: '' }]));
  }
  const viewDataKinds = data.viewDataKinds && typeof data.viewDataKinds === 'object' ? data.viewDataKinds : null;
  const { code, errors } = transpile(data.compiled, { viewDataKinds });
  if (errors && errors.length) throw new Error(JSON.stringify(errors));
  const tmp = viewModulePath + '.tmp-' + process.pid;
  writeFileSync(tmp, code, 'utf8');
  renameSync(tmp, viewModulePath);
};

// Read one dump, run the pure-JS Blade check, and emit the view + context
// modules. The manifest pass below uses this for the dependency closure that
// compile-view.php just compiled in the same boot.
const emitViewModule = (view, dumpPath, viewModulePath, viewDataKinds) => {
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  if (!dump || typeof dump.compiled !== 'string') {
    throw new Error('compile-view produced no compiled PHP');
  }
  bladeCompile(dump, view);
  if (viewDataKinds) {
    dump.viewDataKinds = viewDataKinds;
    writeFileSync(dumpPath, JSON.stringify(dump));
  }
  transpileToModule(dumpPath, viewModulePath);
  writeFileSync(
    join(dist, 'src', 'contexts', viewFileName(view) + '.mjs'),
    'export default ' + JSON.stringify(dump.context) + ';\n'
  );
  return dump;
};

// Track E (compile-view-batch): compile-view.php boots the whole framework per
// call; --batch runs the identical single-view steps for every job in ONE boot.
// A failed job leaves its dump unwritten and reports `view <name>: <error>` on
// stderr; every other job still writes its dump. The batch exits 1 if any job
// failed, but the dumps it did write are the per-view signal below.
const viewJobs = [];
let lastViewManifest = null;
const runViewJobs = (opts = {}) => {
  if (!viewJobs.length) return '';
  const jobsPath = join(cacheDir, 'view-jobs.json');
  const manifestPath = join(cacheDir, 'view-manifest.json');
  mkdirSync(cacheDir, { recursive: true });
  // The phase plan, not a bare wave: `recursive` lets compile-view.php walk
  // the compiled `make('...')` dependency closure in the same boot. The old
  // shape (an array) remains accepted by the tool for standalone callers.
  writeFileSync(
    jobsPath,
    JSON.stringify({
      jobs: viewJobs,
      outDir: cacheDir,
      recursive: opts.recursive === true,
      manifest: manifestPath,
    })
  );
  rmSync(manifestPath, { force: true });
  lastViewManifest = null;
  let stderr = '';
  try {
    execFileSync(PHP, [join(pkgDir, 'tools', 'compile-view.php'), '--batch', jobsPath], {
      cwd: appDir,
      env: childEnv(),
      maxBuffer: 1 << 28,
    });
  } catch (e) {
    stderr = String(e.stderr || e.stdout || e.message || '');
  } finally {
    rmSync(jobsPath, { force: true });
    try {
      lastViewManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      lastViewManifest = null;
    }
  }
  viewJobs.length = 0;
  return stderr;
};
// The batch's error line for one view (`view <name>: <error>`), or the tail of
// whatever killed the whole batch (a boot crash writes no per-view lines).
const viewJobError = (stderr, name) => {
  const prefix = `view ${name}: `;
  const line = String(stderr || '').split(/\r?\n/).find((l) => l.startsWith(prefix));
  if (line) return line.slice(prefix.length);
  return String(stderr || '').trim().split('\n').slice(-4).join(' / ');
};

const controllerByRoute = new Map();

// ---------- 3x. route views + error views, compiled in ONE boot ----------
// The jobs are collected here (collection is pure filesystem + route state);
// the loops below only read the dumps a single --batch run left behind. A
// dump the batch did not write = that view's `view <name>: ...` error line.
const errorViewDir = join(appDir, 'resources', 'views', 'errors');
const appErrorCodes = existsSync(errorViewDir)
  ? readdirSync(errorViewDir)
      .filter((f) => f.endsWith('.blade.php'))
      .map((f) => f.replace(/\.blade\.php$/, ''))
      .sort()
  : [];
// The framework's error views EXTEND `errors::minimal`, which extends
// `errors::layout`: the whole closure compiles, so the layout is in the list.
const frameworkErrorCodes = [
  '401', '402', '403', '404', '419', '429', '500', '503',
  'layout', 'minimal',
];
const errorViewCodes = [...new Set([...appErrorCodes, ...frameworkErrorCodes])].sort();
// Which of the codes come from the framework (the app did not override them):
// their view NAME is the namespaced one.
const frameworkOnly = new Set(errorViewCodes.filter((c) => !appErrorCodes.includes(c)));
const errorViewImports = [];
const errorViewCases = [];
mkdirSync(cacheDir, { recursive: true });

const viewJobSeen = new Set();
const queueViewJob = (name, out, uri) => {
  if (viewJobSeen.has(out)) return; // two routes, one view: the last URI wins,
  viewJobSeen.add(out);             // exactly like the per-view dumps did
  rmSync(out, { force: true });     // a dump from a previous build must not pass for this one
  viewJobs.push({ name, out, uri });
};
for (const [route, view] of viewMap) queueViewJob(view, join(cacheDir, view + '.compiled.json'), route);
for (const code of errorViewCodes) {
  const viewName = frameworkOnly.has(code) ? 'errors::' + code : 'errors.' + code;
  queueViewJob(viewName, join(cacheDir, 'errors.' + code + '.compiled.json'), '/');
}
const viewStderr = runViewJobs({ recursive: true });

for (const [route, view] of viewMap) {
  const slug = slugifyRoute(route);
  const dumpPath = join(cacheDir, view + '.compiled.json');
  console.log(`compiling view ${view} for ${route}`);
  if (!existsSync(dumpPath)) {
    // A view that fails to compile must land in the verdict, not only in
    // scrollback: the route would otherwise ship with no handler at all.
    const detail = viewJobError(viewStderr, view);
    console.log(`  view ${view}: compile FAILED — ${detail.slice(0, 300)}`);
    needsPort.push({ route, reason: `the view for ${route} did not compile (${view}): ${detail.slice(0, 200)}` });
    continue;
  }
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  if (!dump || typeof dump.compiled !== 'string') fail('compile-view produced no compiled PHP for ' + route);

  bladeCompile(dump, route);

  // The module NAME goes through viewFileName(): the error views below are
  // written as `errors.<code>.mjs`, and two different view names that sanitize
  // to the same file (`errors.404` and `errors/404`) must stop the build
  // instead of one silently overwriting the other.
  const viewModulePath = join(dist, 'src', 'views', viewFileName(view) + '.mjs');
  try {
    transpileToModule(dumpPath, viewModulePath);
  } catch (e) {
    // A transpiler refusal used to escape here as a raw stack dump with NO
    // READINESS block. fail() keeps the invariant: verdict first, staging thrown.
    const detail = String(e.message || '').trim().split('\n').slice(-4).join(' / ');
    fail(
      `transpiling the view for ${route} failed (${view}): ${detail}\n` +
        '  the compiler refuses what it cannot port — run it standalone for the full error:\n' +
        `    node compiler/bin/transpile.mjs ${dumpPath} --json`
    );
  }

  const contextPath = join(dist, 'src', 'contexts', viewFileName(view) + '.mjs');
  writeFileSync(contextPath, 'export default ' + JSON.stringify(dump.context) + ';\n');

  const controllerPath = join(dist, 'src', 'controllers', slug + '.mjs');
  writeFileSync(
    controllerPath,
    [
      "import main from '../views/" + viewFileName(view) + ".mjs';",
      "import context from '../contexts/" + viewFileName(view) + ".mjs';",
      "import { buildRt } from '../runtime/rt-from-context.mjs';",
      "import { html } from '../../kernel/response.mjs';",
      '',
      'export default function handle(ctx, env) {',
      '  const rt = buildRt(context, { strict: true });',
      '  main(rt);',
      '  return html(rt.__output);',
      '}',
      '',
        ].join('\n')
  );

  controllerByRoute.set(route, slug);
  console.log(`  -> dist/src/controllers/${slug}.mjs`);
}

// ---------- 3c1. compile error views ----------
// Laravel renders `errors::<code>`: the app's resources/views/errors/<code>
// when it exists, else the FRAMEWORK's own view
// (vendor/laravel/framework/src/Illuminate/Foundation/Exceptions/views - the
// Handler registers that namespace per render, RegisterErrorViewPaths). Both
// are Blade, so both compile here; a status with neither keeps the
// status-only page (and the shadow reports it as a divergence).
if (errorViewCodes.length) {
  console.log(`• error views: compiling ${errorViewCodes.length} (${errorViewCodes.join(', ')})`);
  mkdirSync(join(dist, 'src', 'views'), { recursive: true });
  mkdirSync(join(dist, 'src', 'contexts'), { recursive: true });
  for (const code of errorViewCodes) {
    const viewName = frameworkOnly.has(code) ? 'errors::' + code : 'errors.' + code;
    // The name the compiled Blade calls back (`$__env->make('errors::minimal')`)
    // and the name the renderer keys on differ for the framework views: the
    // runtime registry uses the `errors::<name>` form the source writes.
    const registryName = frameworkOnly.has(code) ? 'errors::' + code : viewName;
    const dumpPath = join(cacheDir, 'errors.' + code + '.compiled.json');
    console.log(`  compiling error view ${viewName}`);
    if (!existsSync(dumpPath)) {
      const detail = viewJobError(viewStderr, viewName);
      note({
        severity: BLOCK,
        area: 'route',
        cause: `error view ${code} failed to compile`,
        fix: 'check the view source compiles; ensure compile-view.php can write its cache output',
      });
      fail('compile-view failed for ' + code + ': ' + detail.slice(0, 800));
    }
    const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
    if (!dump || typeof dump.compiled !== 'string') fail('compile-view produced no compiled PHP for ' + viewName);

    bladeCompile(dump, viewName);

    // Same guard as the route views: This name must not collide with a route
    // view's file (viewFileName throws on a collision, stopping the build).
    const errorViewFileName = viewFileName('errors.' + code);
    const viewModulePath = join(dist, 'src', 'views', errorViewFileName + '.mjs');
    try {
      transpileToModule(dumpPath, viewModulePath);
    } catch (e) {
      // This site crashed the build with a raw execFileSync dump and no READINESS
      // block (seen: LW003 on Arr::except for a Laravel 11 app) — fail() instead.
      const detail = String(e.message || '').trim().split('\n').slice(-4).join(' / ');
      fail(
        `transpiling the error view errors::${code} failed: ${detail}\n` +
          '  the compiler refuses what it cannot port — run it standalone for the full error:\n' +
          `    node compiler/bin/transpile.mjs ${dumpPath} --json`
      );
    }

    const contextPath = join(dist, 'src', 'contexts', errorViewFileName + '.mjs');
    writeFileSync(contextPath, 'export default ' + JSON.stringify(dump.context) + ';\n');

    const importName = 'errorView_' + String(code).replace(/[^A-Za-z0-9_]/g, '_');
    errorViewImports.push(`import ${importName}Main from './views/${errorViewFileName}.mjs';`);
    errorViewImports.push(`import ${importName}Context from './contexts/${errorViewFileName}.mjs';`);
    errorViewCases.push({ code, importName, registryName });
    console.log(`  -> dist/src/views/${errorViewFileName}.mjs`);
  }
}

const errorViewModulePath = join(dist, 'src', 'error-views.generated.mjs');
const errorViewLines = ['// generated by build.mjs — do not edit', ...errorViewImports];
if (errorViewCases.length) {
  errorViewLines.push("import { buildRt } from './runtime/rt-from-context.mjs';");
  errorViewLines.push('');
  // The layout registry the compiled error views resolve through
  // (`$__env->make('errors::minimal')`): every non-status view compiled above.
  errorViewLines.push('const errorViewRegistry = {};');
  for (const { code, importName } of errorViewCases) {
    if (/^[0-9]/.test(code)) continue;
    errorViewLines.push(
      `errorViewRegistry[${JSON.stringify('errors::' + code)}] = { main: ${importName}Main, context: ${importName}Context };`
    );
  }
  errorViewLines.push('');
  errorViewLines.push('export const errorViews = {');
  for (const { code, importName, registryName } of errorViewCases) {
    if (!/^[0-9]/.test(code)) continue;
    errorViewLines.push(`  ${JSON.stringify(code)}: (status, request, ctx, error) => {`);
    // The exception the view sees: Laravel's framework views call
    // `$exception->getMessage()` (403/500), and the compiled handler's error is
    // a plain JS Error with `.status` - so it is wrapped in the exception
    // surface those views use (Laravel's Throwable API).
    errorViewLines.push(
      `    const ex = error == null ? null : { message: String(error.message == null ? '' : error.message), status: Number(error.status) || Number(status) || 500,` +
        ` getMessage() { return String(this.message); }, getCode() { return 0; }, getStatusCode() { return this.status; } };`
    );
    errorViewLines.push(
      `    const rt = buildRt(${importName}Context, { strict: true, views: { ...errorViewRegistry }, data: { exception: ex, errors: {} } });`
    );
    errorViewLines.push(`    ${importName}Main(rt);`);
    // PhpEngine::evaluatePath() returns ltrim(ob_get_clean()): a rendered view
    // never starts with whitespace (Laravel's own 404 body starts with
    // "<!DOCTYPE", not a newline).
    errorViewLines.push('    return String(rt.__output).replace(/^[ \\t\\n\\r\\0\\x0B]+/, "");');
    errorViewLines.push('  },');
  }
  errorViewLines.push('};');
} else {
  errorViewLines.push('export const errorViews = {};');
}
writeFileSync(errorViewModulePath, errorViewLines.join('\n') + '\n');

const errorRendererPath = join(dist, 'src', 'error-renderer.mjs');
writeFileSync(
  errorRendererPath,
  [
    "// generated by build.mjs — do not edit",
    "import { errorViews } from './error-views.generated.mjs';",
    '',
    'export function renderErrorView(status, request, ctx, error) {',
    '  const code = String(status);',
    '  let key = code;',
    '  if (!Object.prototype.hasOwnProperty.call(errorViews, key)) {',
    '    key = String(Math.floor(Number(status) / 100)) + "xx";',
    '  }',
    '  const render = errorViews[key];',
    '  if (typeof render !== "function") return null;',
    '  try {',
    '    return render(Number(status), request, ctx, error);',
    '  } catch (e) {',
    '    return null;',
    '  }',
    '}',
    '',
  ].join('\n')
);
console.log(`  -> dist/src/error-renderer.mjs (${errorViewCases.length} view(s))`);

for (const [route, name] of portEntries) {
  const slug = String(name);
  const controllerPath = join(dist, 'src', 'controllers', slug + '.mjs');
  writeFileSync(
    controllerPath,
    [
      "export { default } from '../ports/" + name + ".mjs';",
      '',
        ].join('\n')
  );
  controllerByRoute.set(route, slug);
  console.log(`port controller ${route} -> dist/src/controllers/${slug}.mjs`);
}

// ---------- 3c2. transpile controllers (single-method routes that still need a port) ----------
// A route only leaves the "needs a port" list when its controller method was fully
// transpiled at build time. The uri's main verb (GET, else POST) plus any extra
// verb (Breeze's GET+POST /login) are each compiled to their own "METHOD uri"
// handler / table entry. Anything outside the supported subset (auth flows,
// relations, unknown calls, non-scalar params, ...) stays blocked under --strict
// or keeps needing a port — the build never silently degrades.
const controllerRoutes = new Map(); // route -> { slug, fqcn, method }
// Does any compiled controller use the Storage facade? (decides the object store)
let usesStorage = false;
const verbControllers = []; // extra-verb handlers: { route, verb, slug, fqcn, method }
// The HTTP verbs the compiled rung can serve. OPTIONS is not one of them (the
// platform answers the CORS preflight, not the app).
const COMPILABLE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
{
  const methodsOk = (route) => {
    const main = mainVerbFor(route);
    // The compiled rung serves GET/POST/PUT/PATCH/DELETE; OPTIONS is not one
    // of them (the platform answers the CORS preflight).
    return COMPILABLE_METHODS.has(main);
  };
  const targets = [];
  for (const { route } of needsPort) {
    if (!methodsOk(route)) continue;
    const action = actionForRoute(route);
    if (!action || action === 'Closure') continue;
    const mwList = middlewareForRoute(route) || [];
    const blocking = mwList.filter((m) => !isHonouredMiddleware(m));
    if (blocking.length) {
      console.log(`  skip controller ${route}: middleware [${blocking.join(', ')}] not transpiled — write a port`);
      continue;
    }
    const at = action.lastIndexOf('@');
    const fqcn = at >= 0 ? action.slice(0, at) : action;
    const method = at >= 0 ? action.slice(at + 1) : '__invoke';
    if (!/^[A-Za-z_][A-Za-z0-9_\\]*$/.test(fqcn) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(method)) continue;
    targets.push({ route, verb: mainVerbFor(route), fqcn, method });
  }

  // Extra verbs on a uri whose main verb is already handled by a snapshot / view /
  // static page (Breeze's GET+POST /login is the canonical case). Each compiles to
  // its own handler keyed "METHOD uri"; a verb that cannot compile stays a partial
  // and still blocks the strict build.
  const extraTargets = [];
  // Verbs the compiled rung can serve as a controller. OPTIONS is not one of them
  // (the browser/CORS preflight is answered by the platform, not the app).
  for (const route of routes) {
    for (const verb of extraVerbsFor(route)) {
      const meta = metaForVerb(route, verb);
      const action = meta && meta.action;
      if (!COMPILABLE_METHODS.has(String(verb).toUpperCase())) {
        const alreadyTracked = partials.some((p) => p.route === route && p.methods.includes(verb));
        const ported = portEntries.some(([r]) => r === route);
        const ignored = ignoreMap.some(([r]) => r === route);
        if (!alreadyTracked && !ported && !ignored) {
          uncompiledExtraNonPost.push({ route, verb });
        }
        console.log(`  skip ${verb} ${route}: only GET/POST/PUT/PATCH/DELETE handlers are compiled — write a port`);
        continue;
      }
      if (!action || action === 'Closure') continue;
      const mwList = (meta && meta.middleware) || [];
      const blocking = mwList.filter((m) => !isHonouredMiddleware(m));
      if (blocking.length) {
        console.log(`  skip ${verb} ${route}: middleware [${blocking.join(', ')}] not transpiled — write a port`);
        continue;
      }
      const at = action.lastIndexOf('@');
      const fqcn = at >= 0 ? action.slice(0, at) : action;
      const method = at >= 0 ? action.slice(at + 1) : '__invoke';
      if (!/^[A-Za-z_][A-Za-z0-9_\\]*$/.test(fqcn) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(method)) continue;
      extraTargets.push({ route, verb, fqcn, method });
    }
  }
  for (const t of extraTargets) {
    if (!targets.some((x) => x.route === t.route && x.verb === t.verb)) targets.push(t);
  }

  if (targets.length) {
    console.log(`• controller routes: trying to transpile ${targets.length} route(s)`);

    const formatControllerErrors = (errs) =>
      Array.isArray(errs) && errs.length
        ? errs
            .map((x) => `${x.code || 'LW'} ${x.message || ''}${x.line ? ` (line ${x.line})` : ''}`)
            .join('; ')
        : 'unknown error';
    const formatControllerError = (e) => {
      const raw = String(e.stderr || e.stdout || e.message || '').trim();
      try {
        const errs = JSON.parse(raw);
        if (Array.isArray(errs) && errs.length) return formatControllerErrors(errs);
      } catch {
        /* not a JSON error payload */
      }
      return raw.slice(0, 300) || 'unknown error';
    };

    // resolve controller PHP files through the app's composer PSR-4 map
    let psr4 = {};
    try {
      const composer = JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8'));
      psr4 = Object.fromEntries(
        Object.entries((composer.autoload && composer.autoload['psr-4']) || {}).map(([prefix, dirs]) => [
          prefix,
          Array.isArray(dirs) ? dirs : [dirs],
        ])
      );
    } catch {
      /* defaults below win */
    }
    const resolvePsr4 = (fqcn) => {
      let best = null;
      for (const [prefix, dirs] of Object.entries(psr4)) {
        if (fqcn.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, dirs];
      }
      if (!best) return null;
      const rest = fqcn.slice(best[0].length).replace(/\\/g, '/') + '.php';
      for (const d of best[1]) {
        const p = join(appDir, String(d).replace(/[\\/]+$/, ''), rest);
        if (existsSync(p)) return p;
      }
      return null;
    };

    mkdirSync(join(dist, 'src', 'controllers'), { recursive: true });
    mkdirSync(join(dist, 'src', 'views'), { recursive: true });
    mkdirSync(join(dist, 'src', 'contexts'), { recursive: true });
    const metaDir = join(cacheDir, 'controllers');
    mkdirSync(metaDir, { recursive: true });

    // phase A: extract method metadata (params, model classes, views).
    // One Node process for every controller: extraction is pure AST work, so
    // spawning one process per method only adds startup overhead and makes the
    // build's process count O(routes).
    const prepared = [];
    const resolvable = [];
    for (const t of targets) {
      const file = resolvePsr4(t.fqcn);
      if (!file) {
        console.log(`  controller ${t.route}: skipped — cannot resolve ${t.fqcn} via composer autoload`);
        continue;
      }
      resolvable.push({ ...t, file });
    }
    if (resolvable.length) {
      const batchPath = join(metaDir, 'extract-jobs.json');
      writeFileSync(batchPath, JSON.stringify(resolvable.map((t) => ({ file: t.file, method: t.method }))));
      try {
        const raw = execFileSync(
          process.execPath,
          [join(pkgDir, 'compiler', 'bin', 'controller.mjs'), 'extract', '--batch', batchPath],
          { cwd: appDir, maxBuffer: 1 << 28 }
        ).toString('utf8');
        const results = JSON.parse(raw);
        for (let i = 0; i < resolvable.length; i++) {
          const t = resolvable[i];
          const r = results[i];
          if (!r || !r.ok) {
            console.log(`  controller ${t.route}: skipped — ${formatControllerErrors(r && r.errors)}`);
            continue;
          }
          prepared.push({ ...t, meta: r });
        }
      } catch (e) {
        console.log(`  controller metadata batch failed — ${formatControllerError(e)}`);
      } finally {
        rmSync(batchPath, { force: true });
      }
    }

    if (prepared.length) {
      // phase B: model metadata (one PHP dump for every referenced class)
      const aliasToFqcns = new Map(); // alias -> Set(fqcn)

      for (const p of prepared) {
        for (const c of p.meta.classes || []) {
          const set = aliasToFqcns.get(c.alias) || new Set();
          set.add(c.fqcn);
          aliasToFqcns.set(c.alias, set);
        }
      }
      // FormRequest candidates (a class-typed parameter that is not a plain
      // Request). The PHP dump decides whether it really is a FormRequest.
      const formRequestFqcns = new Set();
      for (const p of prepared) {
        for (const param of p.meta.params || []) {
          if (param.inject === 'request') continue;
          if (!param.typeFqcn) continue;
          formRequestFqcns.add(param.typeFqcn);
        }
      }
      // Class constants (e.g. RouteServiceProvider::HOME) are dumped too — the
      // value is baked into the handler.
      const constantFqcns = new Set();
      for (const p of prepared) {
        for (const c of p.meta.constants || []) constantFqcns.add(c.fqcn);
      }
      // The class-typed parameters: a FormRequest (injected like a Request) or a
      // model (Laravel's implicit route-model binding). The model dump decides
      // which one it is.
      const paramTypeFqcns = new Set();
      for (const p of prepared) {
        for (const param of p.meta.params || []) {
          if (param.inject === 'request') continue;
          if (!param.typeFqcn) continue;
          paramTypeFqcns.add(param.typeFqcn);
        }
      }
      const allFqcns = [...new Set([...aliasToFqcns.values()].flatMap((s) => [...s]))];
      // The model-bound parameters (Laravel's implicit route-model binding:
      // `show(Post $post)`): the type must be dumped too — the model and the key
      // it binds on.
      for (const fqcn of paramTypeFqcns) {
        if (!allFqcns.includes(fqcn)) allFqcns.push(fqcn);
      }
      // Eloquent auth provider models (config('auth.providers.*.model')) must be in the
      // generated registry even when no compiled controller references them.
      for (const fqcn of authProviderFqcns) {
        const short = fqcn.split('\\').pop();
        if (!aliasToFqcns.has(short)) aliasToFqcns.set(short, new Set());
        aliasToFqcns.get(short).add(fqcn);
        if (!allFqcns.includes(fqcn)) allFqcns.push(fqcn);
      }
      const modelDump = new Map();
      let policyDump = { globals: { before: 0, after: 0, abilities: [], definitions: {} }, models: [] };
      const formRequestDump = new Map();
      const formRequestList = [...formRequestFqcns];

      // One PHP boot for every metadata oracle: model reflection (recursive
      // relation closure), Gate/policy inspection and FormRequest rule
      // evaluation all read the same booted application. This replaced the
      // model-dump rounds + policy dump + extra model dump + FormRequest dump
      // (up to 6 boots) with one phase worker.
      if (allFqcns.length || formRequestList.length) {
        const planPath = join(metaDir, 'metadata-plan.json');
        writeFileSync(
          planPath,
          JSON.stringify({ models: allFqcns, formRequests: formRequestList })
        );
        console.log(
          `• metadata phase: one PHP boot (${allFqcns.length} model(s), ${formRequestList.length} FormRequest(s))`
        );
        try {
          const raw = execFileSync(PHP, [join(pkgDir, 'tools', 'metadata-phase.php'), planPath], {
            cwd: appDir,
            env: childEnv(),
            maxBuffer: 1 << 28,
          }).toString('utf8');
          const data = JSON.parse(raw);
          for (const d of data.models || []) modelDump.set(d.fqcn, d);
          if (data.policy) policyDump = data.policy;
          for (const d of data.formRequests || []) formRequestDump.set(d.fqcn, d);
          for (const err of data.errors || []) {
            console.log(`  metadata ${err.section}: ${err.message}`);
          }
          // Relations and policy models pulled in by the phase are compiled too
          // (the emit loop walks `aliasToFqcns`); their short name is the alias.
          for (const fqcn of modelDump.keys()) {
            const short = fqcn.split('\\').pop();
            if (!aliasToFqcns.has(short)) aliasToFqcns.set(short, new Set());
            aliasToFqcns.get(short).add(fqcn);
            if (!allFqcns.includes(fqcn)) allFqcns.push(fqcn);
          }
        } catch (e) {
          console.log(
            `  metadata phase failed — controller routes stay blocked: ${String(e.stderr || e.message || '')
              .trim()
              .slice(0, 200)}`
          );
        } finally {
          rmSync(planPath, { force: true });
        }
      }

      // The event listeners (the classes): at the edge there is no listener
      // runtime, so the build compiles the listeners (and the event classes).
      let classesDump = { events: {}, classes: {} };
      try {
        const raw = execFileSync(process.execPath, [join(pkgDir, 'tools', 'event-dump.mjs'), appDir], {
          cwd: appDir,
          env: childEnv(),
        }).toString('utf8');
        classesDump = JSON.parse(raw);
      } catch (e) {
        console.log(
          `  event dump failed — the routes that dispatch an event stay blocked: ${String(e.stderr || e.message || '')
            .trim()
            .slice(0, 200)}`
        );
      }

      // The GLOBAL Gate abilities' callback classes (`Gate::define('x',
      // 'App\\Policies\\Y@method')`) are app classes too: the kernel's gate
      // instantiates them, so they join the compiled set.
      const gateCallbackClasses = Object.values(
        (policyDump.globals && policyDump.globals.definitions) || {}
      )
        .filter((d) => d && d.kind === 'string' && d.callback)
        .map((d) => String(d.callback).split('@')[0]);
      if (gateCallbackClasses.length) {
        const seen = new Set(Object.keys(classesDump.classes || {}));
        for (const fqcn of gateCallbackClasses) {
          if (!seen.has(fqcn)) {
            try {
              const raw = execFileSync(process.execPath, [join(pkgDir, 'tools', 'class-dump.mjs'), fqcn], {
                cwd: appDir,
                env: childEnv(),
              }).toString('utf8');
              const extra = JSON.parse(raw);
              for (const [k, v] of Object.entries(extra.classes || {})) classesDump.classes[k] = v;
            } catch (e) {
              console.log(
                `  the Gate callback class ${fqcn} was not dumped — its routes stay blocked: ${String(
                  e.stderr || e.message || ''
                )
                  .trim()
                  .slice(0, 200)}`
              );
            }
          }
        }
      }

      // The models the policies mention (the user, the subject) join the
      // generated registry. metadata-phase.php already dumped them recursively,
      // so this is alias bookkeeping only — no extra PHP boot.
      const policyModelFqcns = new Set();
      for (const pm of policyDump.models || []) {
        const paramLists = Object.values(pm.methods || {}).map((x) => x.params || []);
        if (pm.before) paramLists.push(pm.before.params || []);
        for (const params of paramLists) {
          for (const p of params) {
            if (p.type && !p.builtin && !policyModelFqcns.has(p.type)) policyModelFqcns.add(p.type);
          }
        }
      }
      for (const fqcn of policyModelFqcns) {
        const short = fqcn.split('\\').pop();
        if (!aliasToFqcns.has(short)) aliasToFqcns.set(short, new Set());
        aliasToFqcns.get(short).add(fqcn);
        if (!allFqcns.includes(fqcn)) allFqcns.push(fqcn);
      }

      // A policy (and a compiled class) may read a class constant too
      // (`Post::PUBLISHED`): its model and policy classes join the dump, so
      // the body compiles instead of stopping on an unavailable constant.
      // This runs AFTER both dumps (they declare their own maps below the
      // controller loop, so reading them earlier is a TDZ error).
      for (const e of policyDump.models || []) {
        if (e && e.model) constantFqcns.add(e.model);
        if (e && e.policy) constantFqcns.add(e.policy);
      }
      for (const fqcn of Object.keys(classesDump.classes || {})) constantFqcns.add(fqcn);

      // Class constants — dumped at build time and baked into the handler.
      const constantDump = new Map();
      if (constantFqcns.size) {
        const list = [...constantFqcns];
        console.log(`• dumping class constants (${list.length}): ${list.join(', ')}`);
        try {
          const raw = execFileSync(process.execPath, [join(pkgDir, 'tools', 'constants-dump.mjs'), ...list], {
            cwd: appDir,
            env: childEnv(),
          }).toString('utf8');
          for (const d of JSON.parse(raw)) constantDump.set(d.fqcn, d);
        } catch (e) {
          console.log(
            `  constants dump failed — controller routes stay blocked: ${String(e.stderr || e.message || '')
              .trim()
              .slice(0, 200)}`
          );
        }
      }

      // views used by prepared controllers (compiled once; skipped views block their routes)
      // A view can depend on other views (a layout: `@extends('layouts.app')`, a
      // partial: `@include('partials.x')`) — the compiled PHP names them, so
      // the build compiles the whole closure and the handler imports it.
      const neededViews = new Set();
      for (const p of prepared) for (const v of p.meta.views || []) neededViews.add(v);
      // The pagination view (the framework's `pagination::tailwind`): a route
      // with a paginator renders it (`$paginator->links()`).
      const paginationView = runtimeConfig['pagination.view'] || 'pagination::tailwind';
      const usesPagination = prepared.some((p) => p.meta.usesPaginator);
      if (usesPagination) neededViews.add(paginationView);
      // The kinds of the data the views receive (a view carries no type
      // information, so the build tells the compiler).
      const viewDataKinds = {};
      for (const p of prepared) {
        for (const [v, kinds] of Object.entries(p.meta.viewDataKinds || {})) {
          viewDataKinds[v] = { ...(viewDataKinds[v] || {}), ...kinds };
        }
      }
      if (usesPagination) {
        viewDataKinds[paginationView] = {
          ...(viewDataKinds[paginationView] || {}),
          paginator: 'paginator',
          elements: 'array',
        };
      }
      const compiledViews = new Set();
      const failedViews = new Set();
      const viewDeps = new Map();
      const scanViewDeps = (view, compiledPhp) => {
        const deps = [];
        const re = /make\(\s*'([^']+)'/g;
        let m;
        while ((m = re.exec(String(compiledPhp || '')))) {
          if (m[1] && !deps.includes(m[1])) deps.push(m[1]);
        }
        viewDeps.set(view, deps);
        return deps;
      };
      // The mailable's views (the dump carries them): a mailable's view is not
      // reached from a route, so the build compiles it here.
      const mailViews = Array.isArray(classesDump.mailViews) ? classesDump.mailViews : [];
      // The views PER mailable: only the route that sends a mailable needs
      // them (the flat list above is the compile queue).
      const mailViewsByClass =
        classesDump.mailViewsByClass && typeof classesDump.mailViewsByClass === 'object'
          ? classesDump.mailViewsByClass
          : {};
      const viewQueue = [...neededViews, ...mailViews];
      while (viewQueue.length) {
        // Track E (compile-view-batch): one wave = one boot. The deps of a view
        // only become known once its dump exists (scanViewDeps reads the
        // compiled PHP for `make('...')`), so each depth level of the closure
        // is one batch, not one boot per view.
        const wave = [];
        const waveSeen = new Set();
        while (viewQueue.length) {
          const view = viewQueue.shift();
          if (compiledViews.has(view) || failedViews.has(view)) continue;
          const viewModulePath = join(dist, 'src', 'views', viewFileName(view) + '.mjs');
          const dumpPath = join(cacheDir, viewFileName(view) + '.compiled.json');
          if (existsSync(viewModulePath) && existsSync(dumpPath)) {
            // Already compiled (another route used it): read the dump for the
            // views it depends on.
            try {
              const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
              compiledViews.add(view);
              for (const d of scanViewDeps(view, dump.compiled)) {
                if (!compiledViews.has(d) && !failedViews.has(d)) viewQueue.push(d);
              }
            } catch {
              failedViews.add(view);
            }
            continue;
          }
          if (waveSeen.has(view)) continue; // two routes named it in one wave
          waveSeen.add(view);
          wave.push(view);
        }
        if (!wave.length) continue;
        // One batch run for the whole wave; a dump it failed to write marks
        // that view failed (the per-view `view <name>: ...` error line).
        for (const view of wave) {
          const dumpPath = join(cacheDir, viewFileName(view) + '.compiled.json');
          rmSync(dumpPath, { force: true }); // a dump from a previous build must not pass for this one
          console.log(`compiling view ${view} (controller)`);
          viewJobs.push({ name: view, out: dumpPath, uri: '/' });
        }
        const waveStderr = runViewJobs({ recursive: true });
        for (const view of wave) {
          const viewModulePath = join(dist, 'src', 'views', viewFileName(view) + '.mjs');
          const dumpPath = join(cacheDir, viewFileName(view) + '.compiled.json');
          if (!existsSync(dumpPath)) {
            failedViews.add(view);
            console.log(`  view ${view}: skipped — ${viewJobError(waveStderr, view).slice(0, 300)}`);
            continue;
          }
          try {
            const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
            if (!dump || typeof dump.compiled !== 'string') throw new Error('compile-view produced no compiled PHP');

            bladeCompile(dump, view);

            // The kinds of the view data (the pagination view receives a
            // paginator): the transpiler needs them to allow the method calls.
            if (viewDataKinds[view]) {
              dump.viewDataKinds = viewDataKinds[view];
              writeFileSync(dumpPath, JSON.stringify(dump));
            }
            transpileToModule(dumpPath, viewModulePath);
            writeFileSync(join(dist, 'src', 'contexts', viewFileName(view) + '.mjs'), 'export default ' + JSON.stringify(dump.context) + ';\n');
            compiledViews.add(view);
            for (const d of scanViewDeps(view, dump.compiled)) {
              if (!compiledViews.has(d) && !failedViews.has(d)) viewQueue.push(d);
            }
          } catch (e) {
            failedViews.add(view);
            console.log(`  view ${view}: skipped — ${String(e.stderr || e.message || '').trim().slice(0, 300)}`);
          }
        }

        // A dependency the recursive batch could not compile is a routing
        // failure too: mark it before the readiness check so `viewsFor()` does
        // not accept a parent whose layout/include is missing from the dump set.
        for (const [view, detail] of Object.entries(
          (lastViewManifest && lastViewManifest.failed) || {}
        )) {
          if (compiledViews.has(view) || failedViews.has(view)) continue;
          failedViews.add(view);
          console.log(`  view ${view}: skipped — ${String(detail).slice(0, 300)}`);
        }

        // compile-view.php's recursive batch already compiled the dependency
        // closure into dumps. Emit those modules now so the next loop iteration
        // sees them as complete instead of paying another PHP boot for a wave
        // that is already on disk.
        const waveSet = new Set(wave);
        for (const view of (lastViewManifest && lastViewManifest.views) || []) {
          if (waveSet.has(view) || compiledViews.has(view) || failedViews.has(view)) continue;
          const viewModulePath = join(dist, 'src', 'views', viewFileName(view) + '.mjs');
          const dumpPath = join(cacheDir, viewFileName(view) + '.compiled.json');
          if (!existsSync(dumpPath)) {
            failedViews.add(view);
            continue;
          }
          try {
            const dump = emitViewModule(view, dumpPath, viewModulePath, viewDataKinds[view]);
            compiledViews.add(view);
            for (const d of scanViewDeps(view, dump.compiled)) {
              if (!compiledViews.has(d) && !failedViews.has(d)) viewQueue.push(d);
            }
          } catch (e) {
            failedViews.add(view);
            console.log(`  view ${view}: skipped — ${String(e.stderr || e.message || '').trim().slice(0, 300)}`);
          }
        }
      }
      // The views a route needs: the ones it renders + the closure of their
      // dependencies (the layout).
      const viewsFor = (views) => {
        const out = [];
        const seen = new Set();
        const add = (v) => {
          if (seen.has(v)) return;
          seen.add(v);
          out.push(v);
          for (const d of viewDeps.get(v) || []) add(d);
        };
        for (const v of views || []) add(v);
        return out;
      };

      // generated model classes + route-name -> uri map (imported by controller handlers)
      const classVarNames = new Map(); // fqcn -> generated class identifier
      const modelLines = ['// generated by laravel-workers — do not edit', "import { Model } from '../kernel/model.mjs';", ''];
      // The relation lines wait until every model class is DECLARED (a class
      // binding is not hoisted, so `static relations` may only name one after
      // the declaration ran).
      const relationLines = [];
      // The compiled accessors + the ones that did not compile (the build
      // reports them and the routes that read them stay blocked).
      const accessorLines = [];
      const accessorErrors = [];
      const accessorWork = [];
      // fqcn -> the accessor attribute names the edge now CARRIES (compiled):
      // they leave `notCompiled`, so a property read of one compiles.
      const compiledAccessors = new Map();
      // varName/fqcn/names: `.notCompiled` waits for the accessor pass.
      const notCompiledWork = [];
      for (const [, fqcns] of aliasToFqcns) {
        for (const fqcn of fqcns) {
          if (classVarNames.has(fqcn)) continue;
          const d = modelDump.get(fqcn);
          if (!d || !d.model) continue;
          const varName = 'M_' + fqcn.replace(/[^A-Za-z0-9]/g, '_');
          classVarNames.set(fqcn, varName);
          modelLines.push(`export class ${varName} extends Model {}`);
          modelLines.push(`${varName}.table = ${JSON.stringify(d.table)};`);
          modelLines.push(`${varName}.primaryKey = ${JSON.stringify(d.primaryKey || 'id')};`);
          const casts = d.casts || {};
          modelLines.push(`${varName}.fillable = ${JSON.stringify(d.fillable || [])};`);
          modelLines.push(`${varName}.casts = ${JSON.stringify(casts)};`);
          // `hashed` casts hash at set-time like Eloquent's
          // castAttributeAsHashedString(), using the app's configured bcrypt
          // rounds (Hash::make() parity). Only emitted when the cast is present.
          if (Object.values(casts).some((c) => String(c).toLowerCase() === 'hashed')) {
            const rounds = Number(runtimeConfig['hashing.bcrypt.rounds'] ?? 12);
            modelLines.push(`${varName}.hashRounds = ${Number.isFinite(rounds) ? rounds : 12};`);
          }
          modelLines.push(`${varName}.timestamps = ${d.timestamps === false ? 'false' : 'true'};`);
          modelLines.push(`${varName}.softDeletes = ${d.softDeletes ? 'true' : 'false'};`);
          modelLines.push(`${varName}.hidden = ${JSON.stringify(d.hidden || [])};`);
          modelLines.push(`${varName}.appends = ${JSON.stringify(d.appends || [])};`);
          // Emitted after the accessor pass: an accessor the edge COMPILES leaves the
          // list, so the kernel does not refuse the read at request time.
          notCompiledWork.push([varName, fqcn, d.notCompiled || []]);
          // The model's ACCESSORS (`getFullNameAttribute`): compiled in the
          // second pass, once every model class is declared.
          for (const acc of Array.isArray(d.accessors) ? d.accessors : []) {
            accessorWork.push([varName, fqcn, acc]);
          }
          // The declared relations (dumped from the model's own return types):
          // `static relations = { comments: { type, model, foreignKey, ... } }`
          // - the kernel loads one lazily when it is read as a property.
          for (const rel of Array.isArray(d.relations) ? d.relations : []) {
            relationLines.push([varName, rel]);
          }
          modelLines.push('');
        }
      }
      // The relations, now that every model class exists. A relation whose
      // related model is not compiled is dropped: the read must fail the build
      // (it stays in `notCompiled`), never answer a half-loaded relation.
      for (const [varName, rel] of relationLines) {
        const relatedVar = classVarNames.get(rel.related);
        if (!relatedVar) continue;
        modelLines.push(
          `${varName}.relations = Object.assign({}, ${varName}.relations, { ${JSON.stringify(
            rel.name
          )}: { type: ${JSON.stringify(rel.type)}, model: ${relatedVar}, foreignKey: ${JSON.stringify(
            rel.foreignKey
          )}${rel.type === 'belongsTo' ? `, ownerKey: ${JSON.stringify(rel.ownerKey)}` : `, localKey: ${JSON.stringify(rel.localKey)}`} } });`
        );
      }
      // The model surface the accessor bodies compile against (the same maps
      // the controller path uses - built here because the model file is written
      // before those are declared).
      const accModelFqcns = new Set();
      const accNotCompiled = new Map();
      const accRelations = new Map();
      const accClassFqcns = {};
      for (const [alias, fqcns] of aliasToFqcns) {
        for (const fqcn of fqcns) {
          const d = modelDump.get(fqcn);
          if (!d || !d.model) continue;
          accModelFqcns.add(fqcn);
          accClassFqcns[alias] = fqcn;
          accClassFqcns[fqcn] = fqcn;
          if (Array.isArray(d.notCompiled) && d.notCompiled.length) {
            accNotCompiled.set(alias, d.notCompiled);
            accNotCompiled.set(fqcn, d.notCompiled);
          }
          if (Array.isArray(d.relations) && d.relations.length) {
            const byName = {};
            for (const rel of d.relations) {
              byName[rel.name] = { type: rel.type, related: rel.related, foreignKey: rel.foreignKey };
            }
            accRelations.set(alias, byName);
            accRelations.set(fqcn, byName);
          }
        }
      }
      for (const [varName, fqcn, acc] of accessorWork) {
        const compiledAcc = compileOneMethod(fqcn, acc.file, acc.method, {
          models: accModelFqcns,
          modelNotCompiled: accNotCompiled,
          modelClassFqcns: accClassFqcns,
          modelRelations: accRelations,
          // The class constants are dumped later in the build, so an accessor
          // that reads one fails loud (a precise reason) instead of guessing.
          constants: {},
          classes: new Set(Object.keys(classesDump.classes || {})),
        });
        if (compiledAcc.error) {
          accessorErrors.push(`${fqcn}::${acc.method}() — ${compiledAcc.error}`);
          continue;
        }
        modelLines.push(`${varName}.prototype[${JSON.stringify(acc.method)}] = ${compiledAcc.js};`);
        const names = compiledAccessors.get(fqcn) || [];
        names.push(acc.name);
        compiledAccessors.set(fqcn, names);
      }
      for (const e of accessorErrors) console.log(`  ! accessor ${e}`);
      for (const [varName, fqcn, names] of notCompiledWork) {
        const stillRefused = names.filter((n) => !(compiledAccessors.get(fqcn) || []).includes(n));
        modelLines.push(`${varName}.notCompiled = ${JSON.stringify(stillRefused)};`);
      }
      modelLines.push('');
      const mapPairs = [];
      for (const [alias, fqcns] of aliasToFqcns) {
        if (fqcns.size !== 1) continue; // ambiguous alias: never guessed
        const fqcn = [...fqcns][0];
        if (!classVarNames.has(fqcn)) continue;
        mapPairs.push(`${JSON.stringify(alias)}: ${classVarNames.get(fqcn)}`);
        mapPairs.push(`${JSON.stringify(fqcn)}: ${classVarNames.get(fqcn)}`);
      }
      modelLines.push('export const models = { ' + mapPairs.join(', ') + ' };');
      const routeMapObj = {};
      for (const route of routes) {
        const { name } = metaForRoute(route);
        if (name && !(name in routeMapObj)) routeMapObj[name] = route.replace(/^\//, '');
      }
      modelLines.push('export const routeMap = ' + JSON.stringify(routeMapObj) + ';');
      modelLines.push('');
      writeFileSync(join(dist, 'src', 'models.generated.mjs'), modelLines.join('\n'));

      // The compiled policies (the Gate checks). The policies become plain
      // async functions; the guest rules and the before() hook are baked in.
      const knownModelFqcnSet = new Set();
      const modelNotCompiled = new Map();
      const modelClassFqcns = {};
      for (const [alias, fqcns] of aliasToFqcns) {
        for (const fqcn of fqcns) {
          const d = modelDump.get(fqcn);
          if (!d || !d.model) continue;
          knownModelFqcnSet.add(fqcn);
          modelClassFqcns[alias] = fqcn;
          modelClassFqcns[fqcn] = fqcn;
          if (Array.isArray(d.notCompiled) && d.notCompiled.length) {
            modelNotCompiled.set(alias, d.notCompiled);
            modelNotCompiled.set(fqcn, d.notCompiled);
          }
        }
      }
      // The dumped constants keyed by the name the source writes (the alias
      // and the FQCN). An alias shared by two classes is skipped: the
      // transpiler must not guess which one the source meant.
      const constantsByAlias = {};
      const aliasOwners = new Map();
      for (const [fqcn, dumped] of constantDump) {
        if (!dumped || dumped.error) continue;
        const alias = fqcn.split('\\').pop();
        if (aliasOwners.has(alias) && aliasOwners.get(alias) !== fqcn) {
          aliasOwners.set(alias, null);
        } else {
          aliasOwners.set(alias, fqcn);
        }
      }
      for (const [fqcn, dumped] of constantDump) {
        if (!dumped || dumped.error) continue;
        const alias = fqcn.split('\\').pop();
        if (aliasOwners.get(alias) === fqcn) constantsByAlias[alias] = dumped.constants || {};
        constantsByAlias[fqcn] = dumped.constants || {};
      }
      const policyCompile = compilePolicies(policyDump, {
        models: knownModelFqcnSet,
        modelNotCompiled,
        modelClassFqcns,
        // The user of a policy: the app's auth provider model.
        userModel: authProviderFqcns[0] || null,
        // The class constants the policy bodies may read.
        constants: constantsByAlias,
      });
      writeFileSync(join(dist, 'src', 'policies.generated.mjs'), policyCompile.code);
      const policiesMeta = policyCompile.meta;
      console.log(
        `  -> dist/src/policies.generated.mjs (${Object.keys(policiesMeta).length} model(s)${
          policyCompile.errors.length ? `, ${policyCompile.errors.length} policy/policies did not compile` : ''
        })`
      );
      for (const e of policyCompile.errors) {
        console.log(`     ! ${e.model}: ${e.message}`);
      }

      // The classes (the event listeners + the event classes): the compiled
      // constructors and methods (the edge has no listener runtime).
      const classesCompile = compileClasses(classesDump, {
        models: knownModelFqcnSet,
        modelNotCompiled,
        modelClassFqcns,
        // The class constants a listener/service body may read.
        constants: constantsByAlias,
        classes: new Set(Object.keys(classesDump.classes || {})),
      });
      writeFileSync(join(dist, 'src', 'classes.generated.mjs'), classesCompile.code);
      // The alias of each compiled class (`new PostPublished($id)`): an
      // ambiguous short name is not resolved (the build fails loud on it).
      const classAliases = new Map();
      for (const fqcn of Object.keys(classesCompile.meta)) {
        const alias = fqcn.split('\\').pop();
        if (classAliases.has(alias)) classAliases.delete(alias);
        else classAliases.set(alias, fqcn);
      }
      // The events that did not compile (the event class itself or one of its
      // listeners): a dispatch of one of them would be a silent no-op (the edge
      // has no listener runtime), so the routes that dispatch it stay blocked -
      // and the build names the reason (the listener is queued, the listener
      // injects a service, ...).
      const classErrors = new Map();
      for (const e of classesCompile.errors) classErrors.set(e.class, e.message);
      const blockedClasses = {};
      const blockedShortNames = new Set();
      // EVERY class that did not compile is blocked - not only the event
      // classes: a mailable with Laravel 13's modern API, a listener with a
      // queued trait, ... The transpiler then refuses to instantiate it, and
      // the route that instantiates it is stopped with the reason.
      for (const [cls, why] of classErrors) {
        blockedClasses[cls] = why;
        const short = cls.split('\\').pop();
        if (!blockedShortNames.has(short)) {
          blockedShortNames.add(short);
          blockedClasses[short] = why;
        }
      }
      for (const [event, info] of Object.entries(classesDump.events || {})) {
        const names = [event, ...(info.listeners || [])];
        const bad = names.find((n) => classErrors.has(n));
        if (!bad) continue;
        const why = classErrors.get(bad);
        blockedClasses[event] = why;
        const short = event.split('\\').pop();
        if (!blockedShortNames.has(short)) {
          blockedShortNames.add(short);
          blockedClasses[short] = why;
        }
      }
      const classesMeta = {
        fqcns: Object.keys(classesCompile.meta),
        // The JOB classes (app/Jobs): `Job::dispatch()` writes a queue row and
        // the cron consumer runs the class's handle(), so the transpiler must
        // know which classes are jobs (a plain `dispatch()` on anything else
        // is not a queue push).
        jobs: Object.keys(classesDump.classes || {}).filter(
          (fqcn) => (classesDump.classes[fqcn] || {}).kind === 'job'
        ),
        aliases: Object.fromEntries(classAliases),
        blocked: blockedClasses,
        // The compiled classes' own methods (FQCN -> { methods, base }): a
        // call on an INLINE instance (`(new OrderService())->doIt($o)`) must
        // hand the runtime over as the first argument - the compiled methods
        // are `async function (rt, ...)`. Without this the app's first
        // argument landed in the `rt` slot (a 500 where Laravel answers 200).
        registry: Object.fromEntries(
          Object.entries(classesCompile.meta).map(([fqcn, m]) => [
            fqcn,
            { methods: m.methods || [], base: m.base || null },
          ])
        ),
      };
      console.log(
        `  -> dist/src/classes.generated.mjs (${classesMeta.fqcns.length} class(es)${
          classesCompile.errors.length ? `, ${classesCompile.errors.length} did not compile` : ''
        })`
      );
      for (const e of classesCompile.errors) {
        console.log(`     ! ${e.code || 'LW002'} ${e.class}: ${e.message}`);
      }

      // phase C: emit one handler module per transpilable route
      let emittedCount = 0;
      for (const p of prepared) {
        // A class the route instantiates that did not compile (a mailable with
        // Laravel 13's modern API, ...) makes the route fail at REQUEST time -
        // the build stops the route and names the reason.
        const brokenClass = (p.meta.newClasses || []).find(
          (c) => classErrors.has(c.fqcn) || classErrors.has(c.alias)
        );
        if (brokenClass) {
          console.log(
            `  controller ${p.route}: skipped — the class ${brokenClass.fqcn} did not compile: ${
              classErrors.get(brokenClass.fqcn) || classErrors.get(brokenClass.alias)
            }`
          );
          continue;
        }
        const ambiguous = (p.meta.classes || []).find((c) => (aliasToFqcns.get(c.alias) || new Set()).size > 1);
        if (ambiguous) {
          console.log(`  controller ${p.route}: skipped — model alias "${ambiguous.alias}" is ambiguous between namespaces`);
          continue;
        }
        // A JOB class is not a model: `Job::dispatch()` is a queue push the
        // transpiler compiles, so it must not be judged by the model dump.
        const jobFqcns = new Set(
          Object.keys(classesDump.classes || {}).filter(
            (fqcn) => (classesDump.classes[fqcn] || {}).kind === 'job'
          )
        );
        // A framework class the transpiler compiles ITSELF (`Collection::make()`
        // / `Collection::wrap()` -> the kernel Collection) is not an app model,
        // so the model dump must not judge it. Without this the route is
        // skipped with "not a usable Eloquent model" - a misleading refusal for
        // a construct that compiles.
        const frameworkFqcns = new Set(['Collection', 'Illuminate\\Support\\Collection']);
        const badModel = (p.meta.classes || []).find((c) => {
          if (jobFqcns.has(c.fqcn)) return false;
          if (frameworkFqcns.has(c.fqcn)) return false;
          const d = modelDump.get(c.fqcn);
          return !d || !d.model;
        });
        if (badModel) {
          const d = modelDump.get(badModel.fqcn);
          console.log(
            `  controller ${p.route}: skipped — ${badModel.fqcn} is not a usable Eloquent model${
              d && d.error ? ' (' + d.error + ')' : ''
            }`
          );
          continue;
        }
        // FormRequest rules for this route (by FQCN). A class-typed parameter
        // that is not a FormRequest is a service — the route needs a port.
        const formRequests = {};
        let formRequestError = null;
        for (const param of p.meta.params || []) {
          if (param.inject === 'request') continue;
          if (!param.typeFqcn) continue;
          // A model-typed parameter is the implicit route-model binding (the
          // model comes from the route segment) — it is not a FormRequest.
          const md = modelDump.get(param.typeFqcn);
          if (md && md.model) continue;
          const dumped = formRequestDump.get(param.typeFqcn);
          if (!dumped || dumped.error) {
            // The dump knows WHY (a rule object, an overridden
            // prepareForValidation(), ...): the reason must survive - a generic
            // "unsupported type" would hide it.
            formRequestError =
              dumped && dumped.error
                ? `$${param.name} (${param.typeHint}): ${dumped.error}`
                : `$${param.name} has unsupported type "${param.typeHint}" — only scalar parameters, Illuminate\\Http\\Request and FormRequest are supported here`;
            break;
          }
          formRequests[param.typeFqcn] = {
            rules: dumped.rules || {},
            messages: dumped.messages || {},
            attributes: dumped.attributes || {},
            // The hooks Laravel runs on the request (prepareForValidation) -
            // the compiled handler runs them in Laravel's order.
            hooks: dumped.hooks || [],
          };
        }
        if (formRequestError) {
          console.log(`  controller ${p.route}: skipped — ${formRequestError}`);
          continue;
        }
        // Class constants for this route (by alias — the transpiler resolves the
        // alias as written in the source).
        const constants = {};
        let constantError = null;
        for (const c of p.meta.constants || []) {
          const dumped = constantDump.get(c.fqcn);
          if (!dumped || dumped.error) {
            constantError = `${c.fqcn} (${dumped ? dumped.error : 'not dumped'})`;
            break;
          }
          if (constants[c.alias]) {
            constantError = `${c.alias} is ambiguous between classes`;
            break;
          }
          constants[c.alias] = dumped.constants || {};
        }
        if (constantError) {
          console.log(`  controller ${p.route}: skipped — class constant ${constantError}`);
          continue;
        }
        // The views the route renders + the ones they depend on (the layout).
        // The route's views + the pagination view (when the route has a
        // paginator: `$paginator->links()` renders it).
        const routeViewNames = [...(p.meta.views || [])];
        // A mailable's view (the route sends a mail): the runtime renders it
        // through the ROUTE's runtime, so the view must be in THIS route's
        // view map. The mailables a route can send are the ones it REACHES:
        // the classes its body instantiates, the listeners of the events it
        // dispatches, and their dependencies - a route that dispatches an event
        // whose listener sends a mailable needs that mailable's view.
        // The views are attached per route: a mailable no route reaches costs
        // no route a view (and one broken mailable view no longer skips every
        // route of the app).
        const routeReach = reachableClasses(p.meta.newClasses, classesMeta, {
          classMeta: classesCompile.meta,
          dumpClasses: classesDump.classes,
          events: classesDump.events,
        });
        for (const mailable of reachedMailables(routeReach.reached, classesDump.classes)) {
          for (const v of mailViewsByClass[mailable] || []) routeViewNames.push(v);
        }
        if (p.meta.usesPaginator) routeViewNames.push(paginationView);
        const routeViews = viewsFor(routeViewNames);
        const missingView = routeViews.find((v) => !compiledViews.has(v));
        if (missingView) {
          // A mailable's view that did not compile: the reason names the
          // mailable (the class that renders it) and the route that reaches it -
          // the route would answer 500 where Laravel sends the mail.
          const mailableOf = Object.keys(mailViewsByClass).find(
            (m) => (mailViewsByClass[m] || []).includes(missingView)
          );
          console.log(
            mailableOf
              ? `  controller ${p.route}: skipped — the view "${missingView}" of the mailable ${mailableOf} did not compile`
              : `  controller ${p.route}: skipped — view "${missingView}" did not compile`
          );
          continue;
        }
        // The CORS paths (HandleCors): the compiled worker does not add the CORS
        // headers, so a route under a CORS path is skipped (a silent answer
        // without the headers would break the browser's CORS).
        const corsPath = corsPathFor(p.route);
        if (corsPath) {
          console.log(
            `  controller ${p.route}: skipped — the app configures CORS for "${corsPath}" and the ` +
              'compiled worker does not add the CORS headers — remove the CORS config (config/cors.php) ' +
              'or answer the preflight on the platform'
          );
          continue;
        }
        const isExtraVerb = extraVerbsFor(p.route).includes(p.verb);
        // `--` keeps the extra-verb slug apart from a base route slug
        // (POST /posts -> "posts--post" vs GET /posts/{post} -> "posts-post").
        const slug = isExtraVerb
          ? `${slugifyRoute(p.route)}--${String(p.verb).toLowerCase()}`
          : slugifyRoute(p.route);
        const meta = {
          routeUri: p.route,
          // The pagination view (the framework's `pagination::tailwind`): the
          // handler imports it when the route has a paginator.
          paginationView,
          // A paginator in the method + the kinds of the data the views get.
          usesPaginator: !!p.meta.usesPaginator,
          viewDataKinds: p.meta.viewDataKinds || {},
          routeParams: (p.route.match(/\{([^}]+)\}/g) || []).map((s) => s.slice(1, -1).replace(/[?*]$/, '')),
          models: (() => {
            // The models this route uses: the classes in the body + the
            // model-bound parameters (the implicit route-model binding).
            const list = [];
            const seen = new Set();
            const push = (alias, fqcn) => {
              if (!fqcn || seen.has(fqcn)) return;
              seen.add(fqcn);
              const d = modelDump.get(fqcn) || {};
              list.push({
                alias,
                fqcn,
                // The methods the app declares on the model (the relations, the
                // accessors): the compiler rejects them (a relation read as a
                // property used to answer null - a wrong answer, silently).
                notCompiled: (d.notCompiled || []).filter(
                  (n) => !(compiledAccessors.get(fqcn) || []).includes(n)
                ),
                // The relations the model declares: a property read of one is
                // COMPILED (a lazy load), not refused. A relation whose model
                // is not compiled is dropped here, so it stays refused.
                relations: (Array.isArray(d.relations) ? d.relations : []).filter((r) =>
                  modelDump.has(r.related) && modelDump.get(r.related).model
                ),
                // The route-model binding key ('id' by default) + the key.
                routeKey: d.routeKey || d.primaryKey || 'id',
                primaryKey: d.primaryKey || 'id',
              });
            };
            for (const c of p.meta.classes || []) {
              const d = modelDump.get(c.fqcn);
              if (!d || !d.model) continue;
              push(c.alias, c.fqcn);
            }
            for (const param of p.meta.params || []) {
              if (param.inject === 'request') continue;
              if (!param.typeFqcn) continue;
              const d = modelDump.get(param.typeFqcn);
              if (!d || !d.model) continue;
              push(param.typeFqcn.split('\\').pop(), param.typeFqcn);
            }
            return list;
          })(),
          views: routeViews,
          constants,
          formRequests,
          // The Gate metadata (the policies, their abilities, the guest rules).
          policies: policiesMeta,
          // The GLOBAL Gate::define() abilities: the compilable ones (a
          // 'Class@method' string callback) reach the kernel's gate; a closure
          // never gets here (the transpiler refuses the call).
          gateDefinitions: Object.fromEntries(
            Object.entries((policyDump.globals || {}).definitions || {}).filter(
              ([, d]) => d && d.kind === 'string' && d.callback
            )
          ),
          classes: classesMeta,
          // The object store: the app's default disk (the compiled rung has ONE
          // store — the padanan for it) + the configured disk names.
          storage: {
            defaultDisk: runtimeConfig['filesystems.default'] || null,
            disks: Array.isArray(runtimeConfig['filesystems.disks'])
              ? runtimeConfig['filesystems.disks']
              : [],
          },
          // Hash::make() must use the app's configured bcrypt rounds.
          hashRounds: Number(runtimeConfig['hashing.bcrypt.rounds'] ?? 12) || 12,
        };
        const metaPath = join(metaDir, slug + '.meta.json');
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        const outPath = join(dist, 'src', 'controllers', slug + '.mjs');
        try {
          execFileSync(
            process.execPath,
            [
              join(pkgDir, 'compiler', 'bin', 'controller.mjs'),
              'emit',
              '--file', p.file,
              '--method', p.method,
              '--meta', metaPath,
              '--out', outPath,
            ],
            { cwd: appDir }
          );
          // A handler that queues a job writes a `lw_jobs` row the CRON
          // TRIGGER drains. With no trigger the job would never run, so the
          // build refuses it below (the route itself is fine - the deployment
          // is not).
          if (readFileSync(outPath, 'utf8').includes('rt.queuePush(')) {
            queuePushes.push(p.route);
          }
          if (isExtraVerb) {
            verbControllers.push({ route: p.route, verb: p.verb, slug, fqcn: p.fqcn, method: p.method });
            console.log(`  controller ${p.verb} ${p.route} -> dist/src/controllers/${slug}.mjs (${p.fqcn}@${p.method})`);
          } else {
            controllerRoutes.set(p.route, { slug, fqcn: p.fqcn, method: p.method });
            console.log(`  controller ${p.route} -> dist/src/controllers/${slug}.mjs (${p.fqcn}@${p.method})`);
          }
          emittedCount++;
        } catch (e) {
          const detail = formatControllerError(e);
          console.log(`  controller ${p.route}: skipped — ${detail}`);
          // The upload: the operator needs to know that the edge has no
          // multipart parser and what to do about it (an object store — R2
          // asks for a credit card; the free path is the D1 blob store — or
          // remove/disable the upload).
          if (/an uploaded file/.test(detail)) {
            console.log(
              '     ! this route uploads a file: the edge has no multipart parser. Bind R2\n' +
                '       ("r2_buckets": [{"binding":"R2","bucket_name":"<bucket>"}] in wrangler.jsonc - R2 asks for a\n' +
                '       credit card; the free path is the D1 blob store, 1.5 MB per object) or remove/disable\n' +
                '       the upload in this route.'
            );
          }
        }
      }
      if (emittedCount) {
        console.log(`• controllers transpiled: ${emittedCount}/${targets.length}`);
        for (let i = needsPort.length - 1; i >= 0; i--) {
          if (controllerRoutes.has(needsPort[i].route)) needsPort.splice(i, 1);
        }
      }

      // A route a COMPILED controller serves is NOT a snapshot: the build-time
      // page is the fallback for a route the build could not compile. Keeping
      // both hid the controller (the shadow compared a page baked at build
      // time and called it parity - a stale answer for anything that depends
      // on the request: a query string, a row created during the run).
      for (const route of [...snapshots]) {
        if (!controllerRoutes.has(route)) continue;
        snapshots.splice(snapshots.indexOf(route), 1);
        const file = route === '/' ? 'index.html' : route.slice(1) + '/index.html';
        try {
          rmSync(join(dist, 'public', file), { force: true });
        } catch {
          /* the page was never written */
        }
        console.log(`  snapshot ${route} dropped - the compiled controller serves it`);
      }

      // The Storage facade needs an object store: the app's local disk is
      // object storage at the edge (there is no local filesystem). R2 when the
      // app binds it, else the D1 blob store (one row per object - no extra
      // Cloudflare product, no card). With neither, the compiled handler would
      // only fail at request time - catch it here, where the build can still
      // tell the operator what to add.
      if (emittedCount) {
        const controllerDir = join(dist, 'src', 'controllers');
        const controllerSources = readdirSync(controllerDir)
          .filter((f) => f.endsWith('.mjs'))
          .map((f) => readFileSync(join(controllerDir, f), 'utf8'));
        usesStorage = controllerSources.some((s) => s.includes('rt.storage()'));
        if (usesStorage) {
          if (hasBinding(appDir, 'r2_buckets', 'R2')) {
            console.log('• Storage:: -> R2 (the R2 binding)');
          } else if (hasBinding(appDir, 'd1_databases', 'DB')) {
            console.log('• Storage:: -> the D1 blob store (no R2 binding): one row per object in lw_blobs.');
            console.log('  Free-plan limits apply: 100k row writes/day, 5M row reads/day, 500 MB per database, 1.5 MB per object.');
            console.log('  Bind an R2 bucket ("r2_buckets": [{"binding":"R2",...}]) for real object storage (it asks for a credit card).');
          } else {
            note({ route: null, area: 'runtime', severity: DECLARED, cause: 'a compiled controller uses the Storage facade, but the app binds neither R2 nor D1 — at the edge there is no local filesystem, so Storage::put/get/exists/delete have no object store to back them', fix: 'add the D1 binding (the app ships a D1 blob store, no extra product) or an R2 bucket to wrangler.toml. Until then, Storage facade calls return null at request time.', paths: [{ tier: 'free', what: 'add the D1 binding to wrangler.toml ({"d1_databases":[{"binding":"DB",...}]}) — the app ships a D1 blob store (one row per object in lw_blobs), no extra Cloudflare product' }, { tier: 'paid', what: 'or bind an R2 bucket ({"r2_buckets":[{"binding":"R2",...}]}) — real object storage, asks for a credit card' }] });
          }
        }
        // The compiled cache store is the D1-backed `database` store (the
        // Laravel DatabaseCacheStore, oracle-verified). A compiled route that
        // uses the cache on another driver (redis, memcached, file, ...) would
        // read and write a DIFFERENT store - a silent divergence. The build
        // stops instead.
        const usesCache = controllerSources.some((s) => s.includes('rt.cache()'));
        if (usesCache && runtimeConfig['cache.driver'] !== 'database') {
          note({ route: null, area: 'config', severity: DECLARED, cause: `a compiled controller uses the cache, but cache.driver is '${runtimeConfig['cache.driver']}' — the compiled rung has exactly one cache store: the D1-backed 'database' store`, fix: 'set CACHE_STORE=database (with the cache + cache_locks tables) or write a port for the route. Until then, cache reads/writes hit a different store than the compiled rung expects — a silent divergence.', paths: [{ tier: 'free', what: 'set CACHE_STORE=database and migrate the cache + cache_locks tables — the compiled rung then reads/writes the D1-backed store' }, { tier: 'free', what: 'or write a port for the route (the port handles the cache)' }] });
        }
      }
    }
  }
}

// Extra verbs that compiled to their own handler no longer need a port; the rest
// stay as partials so `--strict` still fails on them.
{
  const resolved = new Set(verbControllers.map((v) => v.route + ' ' + v.verb));
  const remaining = [];
  for (const p of partials) {
    const left = p.methods.filter((m) => !resolved.has(p.route + ' ' + m));
    if (left.length) remaining.push({ route: p.route, methods: left });
  }
  partials.length = 0;
  partials.push(...remaining);
}

// Always emit the registries the worker template imports (models, policies,
// classes) - even when NO controller compiled and no dump ran. The template is
// copied into dist unconditionally, so a missing registry is a bundler error
// ("Could not resolve ./classes.generated.mjs") instead of the build naming the
// routes it skipped. A real registry (written earlier) wins.
if (!existsSync(join(dist, 'src', 'models.generated.mjs'))) {
  writeFileSync(
    join(dist, 'src', 'models.generated.mjs'),
    '// generated by laravel-workers — do not edit\nimport { Model } from \'../kernel/model.mjs\';\n\nexport const models = { };\nexport const routeMap = {};\n'
  );
}
if (!existsSync(join(dist, 'src', 'policies.generated.mjs'))) {
  writeFileSync(
    join(dist, 'src', 'policies.generated.mjs'),
    '// generated by laravel-workers — do not edit\nexport const policies = {};\nexport const gateDefinitions = {};\n'
  );
}
if (!existsSync(join(dist, 'src', 'classes.generated.mjs'))) {
  writeFileSync(
    join(dist, 'src', 'classes.generated.mjs'),
    '// generated by laravel-workers — do not edit\nexport const classes = {};\nexport const eventListeners = {};\nexport default classes;\n'
  );
}

// ---------- 3d. schema snapshot ----------
// Keep the count so the success footer can name the D1 tables and remind the
// operator that the schema statement must be applied ONCE by hand. The schema
// itself was compiled at the top of the build (it also seeds the DB sandbox).
let schemaTableCount = 0;
cpSync(schemaPath, join(dist, 'schema.json'));
console.log('  -> dist/schema.json');

// The same schema as plain SQL. `npx laravel-workers deploy` applies it to the
// selected D1; the manual equivalent is
// `wrangler d1 execute DB --file=dist/schema.sql`. The blob store table (the
// Storage facade on D1) is included when the app uses Storage::.
{
  let tables = [];
  try {
    const snapshot = JSON.parse(readFileSync(schemaPath, 'utf8'));
    tables = (snapshot.tables || [])
      .map((t) => String(t.sql || '').trim().replace(/;+$/, ''))
      .filter(Boolean);
    schemaTableCount = tables.length;
  } catch {
    /* the snapshot is unreadable - dist/schema.json is still written */
  }
  const head =
    '-- laravel-workers: the D1 schema for this app\n' +
    '-- apply: npx laravel-workers deploy --mode 3\n' +
    '-- manual: npx wrangler d1 execute DB --file=dist/schema.sql --remote\n';
  const blob = usesStorage
    ? '\n-- the Storage facade on D1 (one row per object)\n' + BLOB_DDL + ';\n'
    : '';
  writeFileSync(
    join(dist, 'schema.sql'),
    head + (tables.length ? tables.join(';\n') + ';\n' : '') + blob
  );
  console.log(
    `  -> dist/schema.sql (${tables.length} table(s)` + (usesStorage ? ` + ${BLOB_TABLE}` : '') + ')'
  );
}

// ---------- 4. copy static assets ----------
// Static Assets IS the document root at the edge: every public entry ships or
// the URL 404s. Only PHP entrypoints and dotfiles stay behind (index.php is the
// front controller — shipping it would expose PHP source; .htaccess is Apache).
for (const ent of readdirSync(join(appDir, 'public'), { withFileTypes: true })) {
  if (ent.name === 'index.php' || ent.name === '.htaccess') continue;
  if (ent.name.startsWith('.')) continue;
  const src = join(appDir, 'public', ent.name);
  if (lstatSync(src).isSymbolicLink()) {
    console.log(`  ! public/${ent.name} is a symlink — skipped (Storage files arrive through the R2/blob binding)`);
    continue;
  }
  cpSync(src, join(dist, 'public', ent.name), { recursive: true });
  console.log(`• copied public/${ent.name}`);
}

// ---------- 5. worker + ports + routes ----------
const workerCandidates = [join(appDir, 'src/worker.mjs'), join(pkgDir, 'src/worker.mjs')];
let workerSrc = null;
for (const p of workerCandidates) if (existsSync(p)) { workerSrc = p; break; }
if (!workerSrc) fail('no worker template found — looked for src/worker.mjs in the app and in the package (reinstall laravel-workers)');
cpSync(workerSrc, join(dist, 'src/worker.mjs'));
const portsCandidates = [
  ...(lwPortsDir ? [lwPortsDir] : []),
  join(appDir, 'src/ports'),
  join(appDir, 'ports'),
  join(appDir, 'edge/src/ports'),
  join(pkgDir, 'src/ports'),
];
let portsSrc = null;
for (const p of portsCandidates) if (existsSync(p)) { portsSrc = p; break; }
if (!portsSrc) portsSrc = join(pkgDir, 'src/ports');
if (portsSrc === lwPortsDir) console.log(`• ports: LW_PORTS_DIR -> ${portsSrc}`);
const missingPortFiles = portEntries
  .map(([route, name]) => [route, String(name)])
  .filter(([, slug]) => !existsSync(join(portsSrc, slug + '.mjs')));
if (missingPortFiles.length)
  fail(
    'port file(s) missing in ' + portsSrc + ': ' +
      missingPortFiles.map(([route, slug]) => `${route} -> ${slug}.mjs`).join(', ') +
      ' — create them, fix the "ports" mapping in registry.json, or point LW_PORTS_DIR at the right directory'
  );
if (existsSync(portsSrc)) {
  cpSync(portsSrc, join(dist, 'src/ports'), { recursive: true });
} else {
  mkdirSync(join(dist, 'src/ports'), { recursive: true });
  console.log('  ! no ports directory found — created empty dist/src/ports');
}
cpSync(join(pkgDir, 'kernel'), join(dist, 'kernel'), { recursive: true });
// kernel/auth.mjs and kernel/hash.mjs import bcryptjs (pure JS, WebCrypto
// fallback). The dist tree is what Wrangler bundles, so the package must live
// inside it: a bare `bcryptjs` import from <app>/dist resolves only if
// <app>/dist/node_modules/bcryptjs exists (the app itself need not depend on it).
let bcryptSrc = [join(pkgDir, 'node_modules', 'bcryptjs'), join(appDir, 'node_modules', 'bcryptjs')].find((p) =>
  existsSync(join(p, 'index.js'))
);
if (!bcryptSrc) {
  // npm hoists a package dependency to the consumer's top-level node_modules,
  // so it is often NOT under <pkgDir>/node_modules. Resolve it the same way
  // Node resolves the import, then copy the resulting package.
  try {
    bcryptSrc = dirname(createRequire(import.meta.url).resolve('bcryptjs'));
  } catch {
    // reported below
  }
}
if (bcryptSrc && existsSync(join(bcryptSrc, 'index.js'))) {
  cpSync(bcryptSrc, join(dist, 'node_modules', 'bcryptjs'), { recursive: true });
} else {
  fail(
    'bcryptjs is missing — kernel/auth.mjs and kernel/hash.mjs import it, and the dist bundle cannot resolve it.\n' +
      '  Reinstall laravel-workers (npm i) or add bcryptjs to the app and run npm i.'
  );
}
cpSync(join(pkgDir, 'compiler', 'runtime'), join(dist, 'src', 'runtime'), { recursive: true });

const builtAt = new Date().toISOString();
// A uri's base entry answers only its main verb; extra verbs (POST on a
// snapshotted GET uri, etc.) get their own table entry below so router.routeKey()
// — which keys a handler by the entry's first method — resolves each verb.
const baseMethodsFor = (route) => {
  const all = [...(methodsFor.get(route) || new Set())];
  const extras = extraVerbsFor(route);
  if (!extras.length) return all;
  const kept = all.filter((m) => !extras.includes(m));
  return kept.length ? kept : all;
};
const routeTable = routes.map((route) => {
  if (ignoreMap.some(([r]) => r === route)) {
    const entry = ignoreMap.find(([r]) => r === route);
    return { uri: route, ...metaForRoute(route), methods: baseMethodsFor(route), kind: 'ignore', reason: entry[1] };
  }
  if (portEntries.some(([r]) => r === route)) {
    const slug = portEntries.find(([r]) => r === route)[1];
    return { uri: route, ...metaForRoute(route), methods: baseMethodsFor(route), kind: 'port', controller: slug };
  }
  // A view whose compile failed has NO controller (the loop above pushed a
  // needsPort finding and moved on), so it must fall through to `unhandled`
  // instead of emitting `import handlerN from './controllers/undefined.mjs'`
  // - an import wrangler cannot resolve.
  if (viewMap.some(([r]) => r === route) && controllerByRoute.has(route)) {
    const slug = controllerByRoute.get(route);
    const view = viewMap.find(([r]) => r === route)[1];
    return { uri: route, ...metaForRoute(route), methods: baseMethodsFor(route), kind: 'view', view, controller: slug };
  }
  if (controllerRoutes.has(route)) {
    const info = controllerRoutes.get(route);
    return { uri: route, ...metaForRoute(route), methods: baseMethodsFor(route), kind: 'controller', controller: info.slug };
  }
  if (staticMap.some(([r]) => r === route)) {
    const file = staticMap.find(([r]) => r === route)[1];
    return { uri: route, ...metaForRoute(route), methods: baseMethodsFor(route), kind: 'snapshot', snapshot: file };
  }
  if (snapshots.includes(route)) {
    const file = route === '/' ? 'index.html' : route.slice(1) + '/index.html';
    return { uri: route, ...metaForRoute(route), methods: baseMethodsFor(route), kind: 'snapshot', snapshot: file };
  }
  return { uri: route, ...metaForRoute(route), methods: baseMethodsFor(route), kind: 'unhandled' };
});
for (const v of verbControllers) {
  const meta = metaForVerb(v.route, v.verb) || {};
  routeTable.push({
    uri: v.route,
    name: meta.name ?? null,
    domain: meta.domain ?? null,
    middleware: meta.middleware ?? null,
    methods: [v.verb],
    kind: 'controller',
    controller: v.slug,
  });
}

// ---------- 5a. middleware audit ----------
// The app's own GLOBAL stack: anything the compiled kernel does not run is
// written to `middleware.prevented` by config-dump and would 500 on every
// request, so the build stops here and names each class.
{
  const prevented = Array.isArray(runtimeConfig['middleware.prevented']) ? runtimeConfig['middleware.prevented'] : [];
  if (prevented.length) {
    for (const cls of prevented) {
      note({
        route: null,
        area: 'middleware',
        severity: BLOCK,
        cause: `bootstrap/app.php puts ${cls} on the global middleware stack, and the compiled rung does not run it`,
        fix: 'drop the class from ->use()/prepend()/append() (or replace() it with a class the kernel honours), or add a port for it — every request would otherwise answer 500' ,
      });
    }
    fail(
      'global middleware the compiled rung does not run:\n  - ' + prevented.join('\n  - ') +
        '\n  remove it from the global stack in bootstrap/app.php, or add a port.'
    );
  }
}
// kernel/http.mjs honours exactly this set. Anything else on a view / controller /
// snapshot route would be bypassed at the edge — fail the build instead.
{
  const isNumericThrottle = (m) => {
    const str = String(m);
    if (str.split(':')[0] !== 'throttle') return false;
    const spec = str.slice('throttle'.length).replace(/^:/, '');
    return spec === '' || /^\d+(,\d+)?$/.test(spec);
  };
  const RUNTIME_MIDDLEWARE = new Set(['web', 'api', 'substitute_bindings', 'bindings', 'auth', 'auth.basic', 'guest']);
  const offenders = [];
  let throttleRoutes = 0;
  for (const entry of routeTable) {
    if (entry.kind !== 'view' && entry.kind !== 'controller' && entry.kind !== 'snapshot') continue;
    const bad = (entry.middleware || []).filter(
      (m) => !RUNTIME_MIDDLEWARE.has(String(m).split(':')[0]) && !isNumericThrottle(m)
    );
    if (bad.length) {
      offenders.push(`${entry.uri} [${bad.join(', ')}] (${entry.kind})`);
      for (const m of bad) note({ route: entry.uri, area: 'middleware', severity: BLOCK, cause: `runs the "${m}" middleware, which the compiled rung does not honour`, fix: MIDDLEWARE_FIX(m, entry.uri) });
    }
    if ((entry.middleware || []).some(isNumericThrottle)) throttleRoutes++;
  }
  if (offenders.length) {
    fail(
      'route middleware the compiled rung does not honour:\n  - ' +
        offenders.join('\n  - ') +
        '\n  add a port for these routes, or drop the middleware.\n' +
        '  (named rate limiters — throttle:name — need their AppServiceProvider\n' +
        '  definition; the build only honours numeric throttle:n,m)'
    );
  }
  // `throttle` reads/writes the D1-backed `database` cache store. Without it,
  // the compiled limiter 500s at request time — but the operator can rewrite
  // the app (set CACHE_STORE=database) to make it work. So this is a declared
  // gap, not a hard block: the build ships, and the operator knows exactly
  // what to do to close the gap.
  if (throttleRoutes && runtimeConfig['cache.driver'] !== 'database') {
    note({ route: null, area: 'config', severity: DECLARED, cause: `${throttleRoutes} route(s) use throttle middleware, but cache.driver is '${runtimeConfig['cache.driver']}' — the compiled limiter needs the D1-backed 'database' store`, fix: 'set CACHE_STORE=database and migrate the cache + cache_locks tables (the free path) — or add a port for the throttled routes. Until then the throttled routes 500 at request time.', paths: [{ tier: 'free', what: 'set CACHE_STORE=database in the app and migrate the cache + cache_locks tables — the compiled limiter then reads/writes D1' }, { tier: 'free', what: 'or add a port for the throttled route(s) — the port handles the throttling' }] });
  }
}

const controllerImports = [];
const controllerMap = [];
let controllerIndex = 0;
for (const entry of routeTable) {
  if (entry.kind === 'view' || entry.kind === 'port' || entry.kind === 'controller') {
    const idx = controllerIndex++;
    controllerImports.push(`import handler${idx} from './controllers/${entry.controller}.mjs';`);
    controllerMap.push({ uri: entry.uri, methods: entry.methods, idx });
  }
}

const routeNames = {};
for (const [key, meta] of metaFor) {
  if (meta.name) routeNames[meta.name] = key.slice(key.indexOf(' ') + 1);
}

const handlersLines = controllerMap.map(({ uri, methods, idx }) => {
  const m = methods && methods.length ? methods : ['GET'];
  return `  ${JSON.stringify(m[0] + ' ' + uri)}: handler${idx},`;
});

writeFileSync(
  join(dist, 'src', 'routes.generated.mjs'),
  [
    '// generated by build.mjs — do not edit',
    ...controllerImports,
    `export const builtAt = ${JSON.stringify(builtAt)};`,
    'export const routeTable = ' + JSON.stringify(routeTable, null, 2) + ';',
    'export const routeNames = ' + JSON.stringify(routeNames, null, 2) + ';',
    'export const handlers = {',
    ...handlersLines,
    '};',
    '',
  ].join('\n')
);
// ---------- 5b. Cloudflare Static Assets routing ----------
mkdirSync(join(dist, 'public'), { recursive: true });
const routesJson = buildRoutesJson(routeTable, { publicDirs: ['build'], extraInclude: ['/health'] });
writeFileSync(join(dist, 'public', '_routes.json'), JSON.stringify(routesJson, null, 2) + '\n');
console.log(`  -> dist/public/_routes.json (${(routesJson.include || []).length} include, ${(routesJson.exclude || []).length} exclude)`);

// The action for an unhandled route. The reason already says WHY; this says
// WHAT TO DO, and the four cases are genuinely different (a dynamic segment is
// a five-minute port; a route that answers 500 at build time is a bug in the
// app that the build just found for free).
const needsPortFix = (n) => {
  const reason = String(n.reason || '');
  const ignore = `{"ignore": {"${n.route}": "<why>"}}`;
  if (reason.startsWith('dynamic segment')) return `write a port — the worker router matches dynamic segments and hands them to the handler as ctx.params (build --scaffold creates the file), or ${ignore}`;
  if (reason.startsWith('no GET')) return `the route has no GET to snapshot — write a port for the verb(s) it does answer, or ${ignore}`;
  if (reason.startsWith('unhandled (autoSnapshot: false)')) return `registry.json sets "autoSnapshot": false, so nothing is snapshotted — write a port, or set autoSnapshot back to true`;
  if (reason.startsWith('a controller serves it')) return 'the controller did not compile — the reason is on its `controller ... skipped` line above; fix that, or write a port';
  if (reason.startsWith('HTTP 5')) {
    const dbHint = /no such table/i.test(reason)
      ? ' — the database is missing tables: run `php artisan migrate` first (a fresh clone starts with an empty database)'
      : '';
    return `the route throws when the app boots at build time (${reason}) — this is a bug the build found for free; fix the route, then rebuild${dbHint}`;
  }
  if (reason.startsWith('HTTP 3')) return `the route redirects (${reason}) — a redirect needs a handler: write a port that returns it, or ${ignore}`;
  if (reason.startsWith('HTTP 4')) return `the route answers ${reason} for a bare GET — it probably needs a parameter or auth; write a port, or ${ignore}`;
  if (reason.startsWith('HTTP')) return `the response is not an HTML page (${reason}) — write a port that returns it (a JSON or file body), or ${ignore}`;
  return `write a port (build --scaffold), or ${ignore}`;
};

// ---------- 6. coverage report ----------
const unknown = [
  ...new Set([
    ...staticMap.map(([r]) => r),
    ...portEntries.map(([r]) => r),
    ...viewMap.map(([r]) => r),
    ...ignoreMap.map(([r]) => r),
  ]),
].filter((r) => !routes.includes(r));
const stubPorts = findStubPorts(portsSrc);
const runtimeBinding = needsPort.filter((n) => isRuntimeBindingError(n.reason));
const blocked = (needsPort.length - runtimeBinding.length) > 0 || partials.length > 0 || unknown.length > 0 || stubPorts.length > 0 || uncompiledExtraNonPost.length > 0;

if (snapshots.length) console.log(`• auto-snapshots (${snapshots.length}): ${snapshots.join(', ')}`);
for (const p of partials)
  console.log(`  WARN ${p.route}: GET is snapshotted, but ${p.methods.join(', ')} needs a port`);
for (const x of uncompiledExtraNonPost)
  console.log(`  WARN ${x.route}: ${x.verb} needs a port (only GET/POST handlers are compiled)`);
for (const n of needsPort) console.log(`  UNHANDLED ${n.route}: ${n.reason}`);
if (needsPort.length)
  console.log('  -> add a port, a "static" entry, or "ignore" (with a reason) in registry.json');
if (unknown.length) console.log(`  registry entries not found in route:list: ${unknown.join(', ')}`);
if (stubPorts.length)
  console.log(
    `  STUB ${stubPorts.length} port(s) not implemented yet (returning 501): ${stubPorts
      .map((n) => relative(appDir, join(portsSrc, n)))
      .join(', ')}`
  );
if (!blocked)
  console.log(
    `• coverage: all ${routes.length} route(s) handled — static ${staticMap.length}, snapshots ${snapshots.length}, ports ${portEntries.length}, controllers ${controllerRoutes.size}, extra-verb controllers ${verbControllers.length}, ignored ${ignoreMap.length}`
  );

// Every undecided route becomes a finding with the action that resolves it.
// The reasons above are already specific ("dynamic segment", "HTTP 500"); what
// the operator lacks is the STEP, so each row names one.
for (const n of needsPort) {
  if (isRuntimeBindingError(n.reason)) {
    note({ route: n.route, area: 'route', severity: DECLARED, cause: `needs a runtime binding (auto-gap): ${n.reason}`, fix: 'declare the binding in wrangler.jsonc (d1_databases) or set the env at deploy time; the build cannot prerender a route that needs a live connection' });
  } else {
    note({ route: n.route, area: 'route', severity: BLOCK, cause: `no handler: ${n.reason}`, fix: needsPortFix(n) });
  }
  // A route that never became a snapshot or a controller skips the middleware
  // audit above (that one walks the route TABLE), so its middleware is never
  // named - and the reason it could not be served is usually the middleware,
  // not the status it happened to answer. `verified` reads as "HTTP 500"; the
  // truth is a stage the compiled rung does not run.
  for (const m of middlewareForRoute(n.route) || []) {
    if (isHonouredMiddleware(m)) continue;
    note({ route: n.route, area: 'middleware', severity: BLOCK, cause: `runs the "${m}" middleware, which the compiled rung does not honour`, fix: MIDDLEWARE_FIX(m, n.route) });
  }
}
for (const p of partials) note({ route: p.route, area: 'route', severity: BLOCK, cause: `GET is snapshotted, but ${p.methods.join(', ')} has no handler`, fix: `write a port for ${p.methods.join('/')} ${p.route} (build --scaffold), or ignore the route with a reason` });
for (const x of uncompiledExtraNonPost) note({ route: x.route, area: 'route', severity: BLOCK, cause: `${x.verb} has no handler (only GET/POST/PUT/PATCH/DELETE compile)`, fix: `write a port for ${x.verb} ${x.route}, or ignore the route with a reason` });
for (const u of unknown) note({ route: u, area: 'registry', severity: BLOCK, cause: 'registry.json names this route, but `artisan route:list` has no such route', fix: 'fix the path in registry.json (it must match route:list exactly), or delete the entry' });
for (const ss of stubPorts) note({ route: null, area: 'route', severity: BLOCK, cause: `the port ${relPath(join(portsSrc, ss))} is still the scaffold stub (it answers 501)`, fix: 'implement the handler against env.DB (or another binding), then re-run the build' });
// An `ignore` is a decision, not a failure: it ships, so it is reported as a
// declared gap and never changes a green build into a red one.
for (const [route, reason] of ignoreMap) note({ route, area: 'route', severity: DECLARED, cause: `ignored -- ${reason || 'no reason given'}`, fix: reason ? null : 'registry.json: give the "ignore" entry a reason (the next reader needs it)' });


// ---------- 6b. app-source sweep (advisory only) ----------------------------
// The compiler is the authority on what compiles. This sweep is not: it names
// constructs the sandbox CANNOT ever carry even if the route is compiled, so
// the operator fixes them before hitting the first build failure. Advisory
// means severity = ADVISORY: green builds are not turned red by this list.
// We walk only app/ (not vendor/) because everything outside the app is
// framework code -- the build already refuses or ignores it correctly.
{
  const sweepDir = join(appDir, 'app');
  if (existsSync(sweepDir)) {
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (lstatSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!e.endsWith('.php')) continue;
        try {
          files.push({ file: relPath(p), source: readFileSync(p, 'utf8') });
        } catch {
          /* unreadable file: not a build input */
        }
      }
    };
    walk(sweepDir);
    for (const f of sweepAppSources(files)) note(f);
  }
}

// ---------- 7. scaffold stubs for routes that need a port ----------

if (scaffold && needsPort.length) {
  const slugify = (route) =>
    route.replace(/^\//, '').replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'home';
  const entries = needsPort.map(({ route }) => ({ route, slug: slugify(route) }));
  for (const { route, slug } of entries) {
    const stubDir = isNpmMode ? (portsSrc !== join(pkgDir, 'src/ports') ? portsSrc : join(appDir, 'src/ports')) : join(pkgDir, 'src/ports');
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, `${slug}.mjs`);
    if (existsSync(stub)) {
      console.log(`  scaffold: ${relative(appDir, stub)} already exists`);
    } else {
      writeFileSync(stub, buildStubSource(route));
      console.log(`  scaffolded ${relative(appDir, stub)} (${STUB_MARKER} — build --strict fails until implemented)`);
    }
  }
  const { registry: nextRegistry, added } = mergePorts(registry, entries);
  if (added.length) {
    writeFileSync(registryPath, serializeRegistry(nextRegistry));
    for (const { route, slug } of added) {
      console.log(`  registry.json: "ports" += ${JSON.stringify(route)}: ${JSON.stringify(slug)}`);
    }
  } else {
    console.log('  registry.json: all scaffolded ports already registered');
  }
}
if (blocked && !scaffold) {
  if (needsPort.length) console.log('  (tip: re-run with --scaffold to generate + register port stubs)');
  else if (stubPorts.length) console.log('  (tip: implement the stub port(s), then re-run)');
}
if (strict && blocked) {
  const stubNote = stubPorts.length
    ? ` — ${stubPorts.length} port(s) are still scaffold stubs (returning 501): ${stubPorts.join(', ')}`
    : '';
  // Count the findings themselves, not the route arrays - the routes were
  // re-checked into multiple findings (one per unresolved middleware), and
  // that's what the readiness block above prints.
  const blocking = findings.filter((f) => f.severity === BLOCK).length;
  fail(
    'coverage check failed (--strict)' +
      ` — ${blocking} finding(s) need a decision, listed above` +
      (scaffold ? ' — port stubs were scaffolded + registered; implement them, then re-run' : '') +
      stubNote
  );
}

// A queued job with no cron trigger never runs: the route would answer 200 and
// the work would silently never happen (Laravel runs it). This runs LAST -
// `queuePushes` is filled while the controllers are emitted.
if (queuePushes.length && !(cronTriggers && cronTriggers.length)) {
  for (const route of queuePushes) note({ route, area: 'queue', severity: BLOCK, cause: 'dispatches a queued job, but the worker has no cron trigger', fix: 'add `[triggers] crons = ["*/1 * * * *"]` to wrangler.toml (a Worker has no long-lived consumer), or dispatch the job inline (QUEUE_CONNECTION=sync)', paths: [{ tier: 'free', what: 'add `[triggers] crons = ["*/1 * * * *"]` to wrangler.toml - the compiled rung writes the job to the D1 lw_jobs table and the cron trigger drains it (free accounts get 5 triggers)' }, { tier: 'free', what: 'or dispatch inline with QUEUE_CONNECTION=sync when the work is small enough to finish in the request' }, { tier: 'paid', what: 'Cloudflare Queues with a consumer you write - charged per operation' }] });
  fail(
    'the route(s) ' + queuePushes.join(', ') + ' dispatch a queued job, but the worker has no cron trigger - ' +
      'a Worker has no long-lived queue consumer, so the job would never run. Add a cron trigger ' +
      '(wrangler.toml `[triggers] crons = ["*/1 * * * *"]`) or dispatch the job inline ' +
      "(Laravel's sync driver) instead"
  );
}

// ---------- the Blade seam verdict ----------
// "0 diverged" is the evidence that the PHP Blade compiler can be dropped from
// this path; a silent pass would hide the one number that matters.
if (!bladeOff) {
  console.log(
    `• blade2php: ${blade.checked} view(s) compiled byte-identical to Laravel` +
      (bladeLaravel ? ` (${bladeLaravel})` : '') +
      (blade.diverged || blade.failed ? ` — ${blade.diverged} diverged, ${blade.failed} failed (PHP compiler used for those)` : '')
  );
}

// ---------- the swap ----------
// Every check passed and every artifact landed in the staging directory: move
// the previous `dist/` aside and put the new one in its place. A build that
// failed above never reaches this line, so `dist/` still holds the last build
// that COMPLETED (compiler/src/dist-swap.mjs).
commitDist(dist, distFinal, (file) =>
  console.log(
    `  (warning: ${relative(appDir, file)} is locked by a running process — restart the dev server if build output looks stale)`
  )
);

// The cache check ran before APP_KEY generation and vendor provisioning. Those
// steps mutate inputs (.env, vendor/composer/installed.php), so hash again now:
// the stamp must describe the tree the next build will actually see, otherwise
// the first build after `key:generate`/`vendor:ensure` can never hit.
//
// --no-cache is read-opt-out, not write-blind: a forced build still mutates
// hashed inputs itself (the prerender boots write sessions through the app's
// sqlite cache table, and `database/` hashing tracks that file), so without
// this write-through every build after a forced one would first pay an
// unexplained full rebuild.
try {
  const finalInfo = computeBuildCacheKey({
    appDir,
    pkgDir,
    registryPath,
    vendorDir,
    php: resolved,
    flags: { strict, scaffold, argv: process.argv.slice(2).filter((a) => a !== '--no-cache') },
    env: process.env,
  });
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    cacheStampPath,
    JSON.stringify(
      {
        version: 1,
        key: finalInfo.key,
        createdAt: new Date().toISOString(),
        files: finalInfo.files,
        bytes: finalInfo.bytes,
        phpVersion: resolved && resolved.version,
        dist: relPath(distFinal),
      },
      null,
      2
    )
  );
  if (noCache) console.log('  build cache: stamp refreshed — the next run without --no-cache can hit');
} catch (e) {
  console.log(`  (warning: build cache stamp not written: ${String(e.message || e).slice(0, 160)})`);
}

console.log(
  `done. dist: ${relative(appDir, distFinal)}  (static: ${staticMap.length}, snapshots: ${snapshots.length}, ports: ${portEntries.length}, controllers: ${controllerRoutes.size}, ignored: ${ignoreMap.length})`
);

// The build is green: say what that green MEANS. A green build with two
// ignored routes is not the same product as one with none, and the operator
// must see the difference here - not discover it at the edge.
console.log(renderReadiness(findings));

// The first deploy needs the D1 schema to exist before the worker serves
// requests. `npx laravel-workers deploy` does that (and D1 provisioning) in one
// guided command; the manual Wrangler route is printed for operators who
// manage Cloudflare themselves. The build runs neither: both need an account
// and auth token, and creating a database is provisioning, not compiling.
if (schemaTableCount) {
  console.log(
    `  schema: ${relPath(join(distFinal, 'schema.sql'))} (${schemaTableCount} table(s))\n` +
      '    apply:  npx laravel-workers deploy --mode 3  (guided: also creates/reuses D1)\n' +
      '    manual: npx wrangler d1 execute DB --file=dist/schema.sql --remote'
  );
}
console.log(
  '  next:   npx laravel-workers deploy --mode 3  (guided: build + D1 + schema + deploy)\n' +
    '  manual: npx wrangler deploy               (after the D1 schema exists)\n' +
    '  local:  npx wrangler dev                  (preview without deploying)'
);
