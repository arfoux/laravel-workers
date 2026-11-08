#!/usr/bin/env node
// tools/ascii-map-check.mjs — the portable-ascii gate.
//
// `tools/ascii-map.php` generates `kernel/ascii-map.data.mjs` from the app's
// `voku/portable-ascii`, which is what `Str::ascii()` (and therefore
// `Str::slug()`) runs on. A Laravel upgrade that changes that data would leave
// the module silently wrong: every non-ASCII title would transliterate the old
// way.
//
// This check regenerates the table and compares it with the shipped module.
// The data lives in a *Laravel app's* vendor/, which the repo does not carry,
// so the comparison needs a PHP binary and an app root:
//
//   LW_APP_ROOT=<laravel-app> PHP_BIN=php node tools/ascii-map-check.mjs
//
// With neither available it SKIPS (exit 0) with a note; `--require` (or
// LW_ASCII_REQUIRE=1) turns that into a failure for the CI job that owns an app.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toNativePath } from './native-path.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(ROOT, 'kernel', 'ascii-map.data.mjs');
const GENERATOR = join(ROOT, 'tools', 'ascii-map.php');

const requireApp = process.argv.includes('--require') || process.env.LW_ASCII_REQUIRE === '1';
const appRoot = toNativePath(process.env.LW_APP_ROOT) || '';
const php = toNativePath(process.env.PHP_BIN) || 'php';

if (!appRoot || !existsSync(join(appRoot, 'artisan'))) {
  if (requireApp) {
    console.error(
      'ascii-map: FAIL - no Laravel app (LW_APP_ROOT unset or without artisan), ' +
        'but this run REQUIRES the oracle (--require / LW_ASCII_REQUIRE=1). ' +
        'kernel/ascii-map.data.mjs was NOT audited.',
    );
    process.exit(1);
  }
  console.log('ascii-map: SKIP - the module was NOT audited (set LW_APP_ROOT to a Laravel app); pass --require to make this fatal');
  process.exit(0);
}

let generated;
try {
  generated = execFileSync(php, [GENERATOR, appRoot], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });
} catch (e) {
  const msg = String(e.stderr || e.message || '').trim().slice(0, 600);
  console.error('ascii-map: the generator failed:\n' + msg);
  process.exit(1);
}

const shipped = readFileSync(MODULE, 'utf8');
const m = shipped.match(/export const LARAVEL_ASCII_REPLACE = ([\s\S]*?);\s*$/);
if (!m) {
  console.error('ascii-map: cannot find LARAVEL_ASCII_REPLACE in ' + MODULE);
  process.exit(1);
}

const wanted = JSON.parse(generated);
const have = JSON.parse(m[1]);
// The table order is load-bearing (`strtr()` breaks length ties by it), so the
// comparison is positional, not keyed.
if (JSON.stringify(wanted) !== JSON.stringify(have)) {
  console.error("ascii-map: kernel/ascii-map.data.mjs is STALE vs the app's portable-ascii");
  console.error('  regenerate: php tools/ascii-map.php ' + appRoot + ' --write');
  process.exit(1);
}
console.log(`ascii-map: OK (${wanted.length} replacement pairs match portable-ascii)`);
