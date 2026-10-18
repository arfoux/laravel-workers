#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  run(process.execPath, ['--test', 'kernel/tests/router.test.mjs', 'kernel/tests/db.test.mjs', 'kernel/tests/sqlite-integration.test.mjs', 'kernel/tests/hash.test.mjs', 'kernel/tests/encrypter.test.mjs', 'kernel/tests/validator.test.mjs', 'kernel/tests/services.test.mjs', 'kernel/tests/routes-json.test.mjs', 'kernel/tests/registry-json.test.mjs', 'kernel/tests/budget.test.mjs'], { cwd: pkgDir });
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
  console.error(`laravel-workers: unknown command "${cmd}". Try: test | test:db | test:sqlite | test:hash | test:validator | test:services | test:budget | test:corpus | bench | check:docs | init | build | verify`);
  process.exit(1);
}
