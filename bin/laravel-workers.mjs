#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = process.cwd();
const cmd = process.argv[2] ?? 'test';

const run = (command, args, options = {}) => {
  const { cwd = pkgDir, ...rest } = options;
  const res = spawnSync(command, args, { cwd, stdio: 'inherit', ...rest });
  if (res.error) {
    console.error(res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
};

if (cmd === 'test') {
  run(process.execPath, ['--test', 'kernel/tests/router.test.mjs', 'kernel/tests/db.test.mjs', 'kernel/tests/sqlite-integration.test.mjs', 'kernel/tests/hash.test.mjs', 'kernel/tests/encrypter.test.mjs', 'kernel/tests/validator.test.mjs', 'kernel/tests/services.test.mjs', 'kernel/tests/routes-json.test.mjs', 'kernel/tests/registry-json.test.mjs', 'kernel/tests/ports.test.mjs', 'kernel/tests/budget.test.mjs', 'compiler/tests/controller.test.mjs'], { cwd: pkgDir });
} else if (cmd === 'test:db') {
  run(process.execPath, ['--test', 'kernel/tests/db.test.mjs'], { cwd: pkgDir });
} else if (cmd === 'test:sqlite') {
  run(process.execPath, ['--test', 'kernel/tests/sqlite-integration.test.mjs'], { cwd: pkgDir });
} else if (cmd === 'test:hash') {
  run(process.execPath, ['--test', 'kernel/tests/hash.test.mjs', 'kernel/tests/encrypter.test.mjs'], { cwd: pkgDir });
} else if (cmd === 'test:validator') {
  run(process.execPath, ['--test', 'kernel/tests/validator.test.mjs'], { cwd: pkgDir });
} else if (cmd === 'test:services') {
  run(process.execPath, ['--test', 'kernel/tests/services.test.mjs'], { cwd: pkgDir });
} else if (cmd === 'test:budget') {
  run(process.execPath, ['--test', 'kernel/tests/budget.test.mjs'], { cwd: pkgDir });
} else if (cmd === 'test:corpus') {
  run(process.execPath, ['compiler/tests/run-corpus.mjs'], { cwd: pkgDir });
} else if (cmd === 'bench') {
  run(process.execPath, ['tools/bench.mjs'], { cwd: pkgDir });
} else if (cmd === 'check:docs') {
  run(process.execPath, ['tools/docs-check.mjs'], { cwd: pkgDir });
} else if (cmd === 'init') {
  const initPath = join(pkgDir, 'tools', 'init.mjs');
  if (!existsSync(initPath)) {
    console.error('laravel-workers init: tools/init.mjs not found in package — reinstall laravel-workers.');
    process.exit(1);
  }
  let cwd = appDir;
  if (!existsSync(join(appDir, 'artisan')) && existsSync(join(dirname(pkgDir), 'artisan'))) {
    cwd = dirname(pkgDir);
  }
  run(process.execPath, [initPath], { cwd });
} else if (cmd === 'build') {
  const buildPath = join(pkgDir, 'build.mjs');
  if (!existsSync(buildPath)) {
    console.error('laravel-workers build: build.mjs not found in package — reinstall laravel-workers. Run from your Laravel app root via npx laravel-workers build.');
    process.exit(1);
  }
  let cwd = appDir;
  if (existsSync(join(appDir, 'artisan'))) {
    cwd = appDir;
  } else if (existsSync(join(dirname(pkgDir), 'artisan'))) {
    cwd = dirname(pkgDir);
  } else {
    cwd = appDir;
  }
  if (!existsSync(join(cwd, 'artisan'))) {
    console.error('laravel-workers build: artisan not found — run from your Laravel app root via npx laravel-workers build (cwd must contain artisan).');
  }
  run(process.execPath, [buildPath, '--strict', ...process.argv.slice(3)], { cwd });
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
  run(process.execPath, [litePath, ...process.argv.slice(3)], { cwd: appDir });
} else if (cmd === 'php:ensure') {
  // Resolve (or provision) the interpreter that can boot THIS app. The build
  // does this automatically; the explicit command exists for CI prewarming and
  // for operators who want the download to happen outside a build.
  const { resolvePhp } = await import(pathToFileURL(join(pkgDir, 'tools', 'php-runtime.mjs')).href);
  const { provisionPhp } = await import(pathToFileURL(join(pkgDir, 'tools', 'php-provision.mjs')).href);
  let requirement = null;
  try {
    requirement = JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8')).require?.php || null;
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
  const vendorInApp = existsSync(join(appDir, 'vendor', 'autoload.php'));
  const vendorInParent = existsSync(join(dirname(pkgDir), 'vendor', 'autoload.php'));
  if (!vendorInApp && !vendorInParent) {
    console.log('VERIFY-S0: SKIP (no Laravel vendor/ found — run from your Laravel app root via npx laravel-workers verify).');
    process.exit(0);
  }
  run(php, [verifyPath], { cwd: appDir, env: { ...process.env, LW_APP_ROOT: appDir } });
} else {
  console.error(`laravel-workers: unknown command "${cmd}". Try: test | test:db | test:sqlite | test:hash | test:validator | test:services | test:budget | test:corpus | bench | check:docs | init | build | verify | vendor:ensure | php:ensure`);
  process.exit(1);
}
