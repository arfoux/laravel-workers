#!/usr/bin/env node
// tools/facade-count-check.mjs — the facade census is measured, not asserted.
//
// `tools/constructs.json` declares `meta.facade_total`, and the construct audit
// prints "N of 47 classified (the facade coverage is X%)". That total is a
// NUMBER IN A FILE: when Laravel adds a facade, the audit keeps printing
// 47 of 47 and the coverage stays at 100% while a whole facade went
// unclassified — the silent omission the audit exists to prevent.
//
// The audit itself runs in the `test` CI job, which has no app and therefore no
// `vendor/`; it cannot count the directory there. This check runs in a job that
// OWNS an app (the same `e2e` job as validation-messages-check / ascii-map-check)
// and compares the number in the file with the directory Laravel actually ships.
//
//   LW_APP_ROOT=<laravel-app> node tools/facade-count-check.mjs
//
// With no app it SKIPS (exit 0) with a note; `--require` (or
// LW_FACADE_REQUIRE=1) turns that into a failure for the CI job that owns one.
//
// The count's definition is the registry's own: ONE row per `.php` file in the
// vendored `Illuminate/Support/Facades` — `facade_facade` (the abstract base)
// counts like any other, so the number is the directory as-is.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireApp = process.argv.includes('--require') || process.env.LW_FACADE_REQUIRE === '1';
const appRoot = process.env.LW_APP_ROOT || '';

const FACADES = join('vendor', 'laravel', 'framework', 'src', 'Illuminate', 'Support', 'Facades');

if (!appRoot || !existsSync(join(appRoot, FACADES))) {
  if (requireApp) {
    console.error(
      'facade-count: FAIL - no Laravel app (LW_APP_ROOT unset or without vendor/), ' +
        'but this run REQUIRES the oracle (--require / LW_FACADE_REQUIRE=1). ' +
        'tools/constructs.json meta.facade_total was NOT audited.',
    );
    process.exit(1);
  }
  console.log(
    'facade-count: SKIP - no app (set LW_APP_ROOT=<laravel-app>); the facade total was not audited here',
  );
  process.exit(0);
}

const files = readdirSync(join(appRoot, FACADES), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.php'))
  .map((e) => e.name);
const actual = files.length;

const data = JSON.parse(readFileSync(join(ROOT, 'tools', 'constructs.json'), 'utf8'));
const declared = Number(data.meta && data.meta.facade_total);
const rows = (data.constructs || []).filter((c) => String(c.id || '').startsWith('facade_')).length;

const problems = [];
if (!Number.isFinite(declared)) {
  problems.push('constructs.json has no meta.facade_total');
} else if (declared !== actual) {
  problems.push(
    `meta.facade_total is ${declared} but the app ships ${actual} facades — ` +
      'add the missing row(s) and update the total',
  );
}
if (rows !== actual) {
  problems.push(`there are ${rows} facade_ rows but ${actual} facades — every facade needs exactly one row`);
}

if (problems.length) {
  for (const p of problems) process.stderr.write(`facade-count FAIL: ${p}\n`);
  process.exit(1);
}
console.log(`facade-count OK: ${actual} facades, ${rows} rows, meta.facade_total=${declared}`);
