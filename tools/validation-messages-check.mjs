#!/usr/bin/env node
// tools/validation-messages-check.mjs — the validation-messages gate (#353).
//
// `tools/validation-messages.php` generates `kernel/validation-messages.data.mjs`
// from the framework's own `lang/en/validation.php`. The generator's header used
// to CLAIM that the gate compared the module with that file; the gate only ran
// docs-check/construct-audit/docs-counts, so a Laravel upgrade that reworded a
// message left the module stale and silent.
//
// This check regenerates the JSON and compares it with what the module ships.
// The framework file lives in a *Laravel app's* vendor/, which the repo does not
// carry, so the comparison needs a PHP binary and an app root:
//
//   LW_APP_ROOT=<laravel-app> PHP_BIN=php node tools/validation-messages-check.mjs
//
// With neither available it SKIPS (exit 0) with a note — the gate stays runnable
// on a machine without PHP, but the claim is no longer false.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(ROOT, 'kernel', 'validation-messages.data.mjs');
const GENERATOR = join(ROOT, 'tools', 'validation-messages.php');

const appRoot = process.env.LW_APP_ROOT || '';
const php = process.env.PHP_BIN || 'php';

if (!appRoot || !existsSync(join(appRoot, 'artisan'))) {
  console.log('validation-messages: skipped (set LW_APP_ROOT to a Laravel app to audit the module)');
  process.exit(0);
}

let generated;
try {
  generated = execFileSync(php, [GENERATOR, appRoot], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });
} catch (e) {
  const msg = String(e.stderr || e.message || '').trim().slice(0, 600);
  console.error('validation-messages: the generator failed:\n' + msg);
  process.exit(1);
}

const shipped = readFileSync(MODULE, 'utf8');
const m = shipped.match(/export const LARAVEL_VALIDATION_MESSAGES = ([\s\S]*?);\s*$/);
if (!m) {
  console.error('validation-messages: cannot find LARAVEL_VALIDATION_MESSAGES in ' + MODULE);
  process.exit(1);
}

const a = JSON.parse(generated);
const b = JSON.parse(m[1]);
if (JSON.stringify(canon(a)) !== JSON.stringify(canon(b))) {
  console.error('validation-messages: kernel/validation-messages.data.mjs is STALE vs the app\'s framework copy');
  console.error('  regenerate: php tools/validation-messages.php ' + appRoot + ' --write');
  process.exit(1);
}
console.log(`validation-messages: OK (${Object.keys(a).length} messages match the framework copy)`);

/** Canonical form: the same key order on both sides (deep, plain-object keys sorted). */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v;
}
