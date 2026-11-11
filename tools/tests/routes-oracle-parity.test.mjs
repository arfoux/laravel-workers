// tools/tests/routes-oracle-parity.test.mjs — the route scan is a TOTAL function.
//
// tools/routes-dump.mjs is the pure-JS port of tools/routes-dump.php: the build
// runs the port (build.mjs calls tools/routes-dump.mjs), and the port's answer
// is what the compiled router and the coverage report are derived from. A route
// the scan does not see is not reported anywhere — it simply does not exist for
// the edge. That is the silent-wrong-serve failure class, and it already shipped
// once: `health: '/up'` is registered by `ApplicationBuilder::withRouting()`
// (framework code, not a route file), so the scan could not see it and `GET /up`
// answered 404 on the edge where PHP answers 200 (CHANGELOG, "the app's health
// route is reported, not silently missing").
//
// unit tests pin the individual Router helpers. THIS test pins the property that
// actually matters: run BOTH the scan and the real `route:list --json` oracle on
// the same app and assert the two sets are EQUAL. A route the scan silently
// drops — from any helper, any Laravel version — fails here, not in production.
//
// The oracle answers a superset: Laravel registers routes the scan deliberately
// does not own (the health endpoint, the vendor file server). Those are named in
// the allowlist below WITH their framework source; anything else the oracle
// knows and the scan does not is a failure. The allowlist is not a place to
// hide a gap: the reasoning is in this file and in `CHANGELOG.md` (0.4.7, "#628 —
// the scan is now proven TOTAL"), and the build's own output prints the note.
// (`docs/AUDIT-REAL-APPS.md` was cited here until #749; it never stated the two.)
//
// Needs a real Laravel app (PHP 8.3 + vendor/): LW_LARAVEL_APP, or the
// conventional `parity-app` / `e2e-app` directories at the repo root. Without
// one it SKIPS with the reason (the repo's convention for oracle tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oracleAppRoot } from '../../kernel/tests/oracle-app.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(testsDir, '..', '..');
const SCAN = path.join(pkgDir, 'tools', 'routes-dump.mjs');
const ORACLE = path.join(pkgDir, 'tools', 'routes-dump.php');
const PHP = process.env.PHP_BIN || 'php';

const APP = oracleAppRoot();

// Laravel routes the scan does not own, each with the framework file that
// registers it. A scan that starts seeing one of these is fine (it must then be
// REMOVED from here — the keyed check below is what makes this a real bound);
// a scan that misses anything ELSE is the failure this test exists for.
const FRAMEWORK_ONLY = [
  {
    why: 'vendor file server, registered by FilesystemServiceProvider::serveFiles()',
    file: 'Illuminate/Filesystem/FilesystemServiceProvider.php',
    match: (r) => r.uri === 'storage/{path}',
  },
];

function runScanner(app) {
  const out = execFileSync(process.execPath, [SCAN], {
    cwd: app,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return JSON.parse(out);
}

function runOracle(app) {
  const out = execFileSync(PHP, [ORACLE], {
    cwd: app,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return JSON.parse(out);
}

// One row per (method, uri, domain); the oracle and the scan agree on this key.
const keyOf = (r) => `${(r.method || '').toUpperCase()} ${(r.uri || '').replace(/^\//, '')}#${r.domain || ''}`;
const byKey = (rows) => new Map(rows.map((r) => [keyOf(r), r]));

test('the route scan is TOTAL: its set equals route:list, minus the framework-only routes', { skip: !APP && 'no Laravel app (set LW_LARAVEL_APP)' }, () => {
  const scanned = runScanner(APP);
  const oracle = runOracle(APP);
  assert.ok(Array.isArray(scanned) && scanned.length, 'the scan produced no routes');
  assert.ok(Array.isArray(oracle) && oracle.length, 'the oracle produced no routes');

  const S = byKey(scanned);
  const O = byKey(oracle);

  // 1. Only the named framework-only routes may be missing from the scan.
  const missing = [...O.keys()].filter((k) => !S.has(k));
  const unexplained = missing.filter((k) => !FRAMEWORK_ONLY.some((f) => f.match(O.get(k))));
  assert.deepEqual(
    unexplained,
    [],
    `the scan silently dropped route(s) the oracle knows: ${unexplained.join(', ')}\n` +
      'A route the scan cannot see does not exist for the edge. Either teach the scan the ' +
      'helper that registers it, or add it to FRAMEWORK_ONLY with its framework source.',
  );

  // 2. The allowlist is a BOUND, not a hiding place: every entry must still be a
  //    route the scan genuinely does not see (a captured route means the entry is
  //    stale and must go).
  for (const f of FRAMEWORK_ONLY) {
    const covered = [...O.values()].filter((r) => f.match(r));
    for (const r of covered) {
      assert.ok(
        !S.has(keyOf(r)),
        `FRAMEWORK_ONLY entry is stale: the scan now sees ${keyOf(r)} (${f.why}) — remove it`,
      );
    }
  }

  // 3. The scan may not invent a route the oracle does not have.
  const extra = [...S.keys()].filter((k) => !O.has(k));
  assert.deepEqual(extra, [], `the scan invented route(s) the oracle does not have: ${extra.join(', ')}`);

  // 4. Shared routes must agree on the name (a wrong name is a wrong URL).
  const nameDiffs = [...S.keys()]
    .filter((k) => O.has(k) && (S.get(k).name ?? null) !== (O.get(k).name ?? null))
    .map((k) => `${k}: scan=${S.get(k).name} oracle=${O.get(k).name}`);
  assert.deepEqual(nameDiffs, [], `route name mismatch:\n${nameDiffs.join('\n')}`);
});
