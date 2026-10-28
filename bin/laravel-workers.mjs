#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = process.cwd();
const cmd = process.argv[2] ?? 'help';

// The Laravel app root is not always the cwd. `npx laravel-workers …` may run
// from a subdirectory, and an npm install puts this package at
// <app>/node_modules/laravel-workers — so the cwd is <app> but the package's
// parent is node_modules, never the app. Walk up from both the cwd and the
// package directory until an `artisan` file turns up.
function findAppRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'artisan'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

const appRoot = findAppRoot(appDir) ?? findAppRoot(pkgDir) ?? appDir;

const run = (command, args, options = {}) => {
  const { cwd = pkgDir, ...rest } = options;
  const res = spawnSync(command, args, { cwd, stdio: 'inherit', ...rest });
  if (res.error) {
    console.error(res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
};

const HELP = `laravel-workers — compile a Laravel app to a JS bundle for Cloudflare Workers

Usage: npx laravel-workers <command> [options]

Commands:
  build [--strict] [--scaffold] [--no-cache]   compile the app to dist/ (no cloud)
  deploy [options]                              build, then (optionally) provision D1 and deploy
      --mode <1|2|3>         1=build only · 2=+D1 · 3=+D1+deploy (prompted when a TTY)
      --deploy               shorthand for --mode 3
      --db                   shorthand for --mode 2
      --name <worker>        worker name (modes 2/3)
      --d1-auto              auto create/reuse <worker>-db
      --d1-id <uuid>         use an existing D1 by id
      --skip-schema          don't apply dist/schema.sql
      --schema=apply         apply the schema even when the D1 has tables
      --plan [--check]       preview; no writes (--check adds read-only D1 checks)
      --allow-account-change  allow a different Cloudflare account than recorded
      --yes / -y             skip prompts (CI); drift/unconfirmed account change fails
  init                        scaffold registry.json + wrangler.jsonc (idempotent)
  status                     show the recorded deploy state (lw-state.json)
  doctor [--cloud] [--strict]  preflight checks (PHP, vendor, wrangler, deploy state)
  shadow [--app <root>]      proof harness: real PHP app vs the compiled worker
  verify                     VERIFY-S0 — does this app boot under the build?
  vendor:ensure              provision a composer-free vendor tree (CI prewarm)
  php:ensure                 resolve or provision the PHP interpreter (CI prewarm)

  --version                  print version and exit
  --help | -h                show this help

Developer tasks (test/bench/docs) run via the package.json scripts:
  npm test · npm run bench · npm run check:docs · npm run test:corpus
`;

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  process.stdout.write(HELP);
  process.exit(0);
}
if (cmd === '--version' || cmd === '-v') {
  process.stdout.write('laravel-workers ' + JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version + '\n');
  process.exit(0);
}


if (cmd === 'test' || cmd === 'test:db' || cmd === 'test:sqlite' || cmd === 'test:hash' || cmd === 'test:validator' || cmd === 'test:services' || cmd === 'test:budget' || cmd === 'test:corpus' || cmd === 'bench' || cmd === 'check:docs') {
  console.error(`laravel-workers: developer tasks run via the package.json scripts (npm test / npm run bench / npm run check:docs / npm run test:corpus), not through the CLI. Run from the laravel-workers checkout.`);
  process.exit(2);
} else if (cmd === 'init') {
  const initPath = join(pkgDir, 'tools', 'init.mjs');
  if (!existsSync(initPath)) {
    console.error('laravel-workers init: tools/init.mjs not found in package — reinstall laravel-workers.');
    process.exit(1);
  }
  run(process.execPath, [initPath], { cwd: appRoot });
} else if (cmd === 'build') {
  const buildPath = join(pkgDir, 'build.mjs');
  if (!existsSync(buildPath)) {
    console.error('laravel-workers build: build.mjs not found in package — reinstall laravel-workers. Run from your Laravel app root via npx laravel-workers build.');
    process.exit(1);
  }
  if (!existsSync(join(appRoot, 'artisan'))) {
    console.error('laravel-workers build: artisan not found — run from your Laravel app root via npx laravel-workers build (a directory containing artisan is required).');
    process.exit(1);
  }
  run(process.execPath, [buildPath, '--strict', ...process.argv.slice(3)], { cwd: appRoot });
} else if (cmd === 'shadow') {
  // The shadow harness: the real app (PHP oracle) vs the compiled worker.
  const shadowPath = join(pkgDir, 'shadow', 'run.mjs');
  if (!existsSync(shadowPath)) {
    console.error('laravel-workers shadow: shadow/run.mjs not found in package - reinstall laravel-workers.');
    process.exit(1);
  }
  const args = process.argv.slice(3);
  if (!args.includes('--app') && !process.env.LW_SHADOW_APP) {
    console.error('laravel-workers shadow: --app <laravel-app-root> is required (or set LW_SHADOW_APP).');
    process.exit(2);
  }
  run(process.execPath, [shadowPath, ...args], { cwd: appDir });
} else if (cmd === 'vendor:ensure') {
  // Build a (or reuse the cached) vendor tree the build needs to boot the app.
  // Content-addressed by composer.lock, so a second project with the same lock
  // costs nothing and a fresh clone never runs a full `composer install`.
  const litePath = join(pkgDir, 'tools', 'vendor-lite.mjs');
  if (!existsSync(litePath)) {
    console.error('laravel-workers vendor:ensure: tools/vendor-lite.mjs not found in package — reinstall laravel-workers.');
    process.exit(1);
  }
  run(process.execPath, [litePath, ...process.argv.slice(3)], { cwd: appRoot });
} else if (cmd === 'php:ensure') {
  // Resolve (or provision) the interpreter that can boot THIS app. The build
  // does this automatically; the explicit command exists for CI prewarming and
  // for operators who want the download to happen outside a build.
  const { resolvePhp } = await import(pathToFileURL(join(pkgDir, 'tools', 'php-runtime.mjs')).href);
  const { provisionPhp } = await import(pathToFileURL(join(pkgDir, 'tools', 'php-provision.mjs')).href);
  let requirement = null;
  try {
    requirement = JSON.parse(readFileSync(join(appRoot, 'composer.json'), 'utf8')).require?.php || null;
  } catch {
    requirement = null;
  }
  try {
    const r = resolvePhp({ requirement });
    console.log(`PHP ${r.version} (${r.bin})${requirement ? ` — satisfies ${requirement}` : ''}`);
  } catch (e) {
    if (!requirement) {
      console.error(e.message);
      process.exit(1);
    }
    console.log(e.message.split('\n')[0]);
    console.log(`provisioning PHP ${requirement}...`);
    try {
      const p = await provisionPhp(requirement);
      console.log(`PHP ${p.version} at ${p.bin}${p.cached ? ' (cached)' : ' (downloaded, sha256 verified)'}`);
      console.log(`  -> use it: PHP_BIN="${p.bin}" npx laravel-workers build --strict`);
    } catch (e2) {
      console.error(e2.message);
      process.exit(1);
    }
  }
} else if (cmd === 'verify') {
  const php = process.env.PHP_BIN ?? 'php';
  const verifyPath = join(pkgDir, 'tools', 'verify-s0.php');
  if (!existsSync(verifyPath)) {
    console.error('laravel-workers verify: tools/verify-s0.php not found in package.');
    process.exit(1);
  }
  const vendorInApp = existsSync(join(appRoot, 'vendor', 'autoload.php'));
  const vendorInParent = existsSync(join(dirname(pkgDir), 'vendor', 'autoload.php'));
  if (!vendorInApp && !vendorInParent) {
    console.log('VERIFY-S0: SKIP (no Laravel vendor/ found — run from your Laravel app root via npx laravel-workers verify).');
    process.exit(0);
  }
  run(php, [verifyPath], { cwd: appRoot, env: { ...process.env, LW_APP_ROOT: appRoot } });
} else if (cmd === 'deploy') {
  const deployPath = join(pkgDir, 'tools', 'deploy.mjs');
  if (!existsSync(deployPath)) {
    console.error('laravel-workers deploy: tools/deploy.mjs not found — reinstall laravel-workers.');
    process.exit(1);
  }
  run(process.execPath, [deployPath, ...process.argv.slice(3)], { cwd: appRoot });
} else if (cmd === 'status') {
  const statusPath = join(pkgDir, 'tools', 'status.mjs');
  if (!existsSync(statusPath)) {
    console.error('laravel-workers status: tools/status.mjs not found — reinstall laravel-workers.');
    process.exit(1);
  }
  run(process.execPath, [statusPath], { cwd: appRoot });
} else if (cmd === 'doctor') {
  const doctorPath = join(pkgDir, 'tools', 'doctor.mjs');
  if (!existsSync(doctorPath)) {
    console.error('laravel-workers doctor: tools/doctor.mjs not found — reinstall laravel-workers.');
    process.exit(1);
  }
  run(process.execPath, [doctorPath, ...process.argv.slice(3)], { cwd: appRoot });
} else {
  console.error(`laravel-workers: unknown command "${cmd}". Try: build | deploy | init | status | doctor | shadow | verify | vendor:ensure | php:ensure | help`);
  process.exit(1);
}
