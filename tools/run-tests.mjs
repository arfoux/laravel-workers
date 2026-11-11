#!/usr/bin/env node
// tools/run-tests.mjs — the `npm test` runner: auto-discover every *.test.mjs
// under the test directories and hand them to `node --test`.
//
// WHY a runner (not a glob in package.json): `node --test` has no negation, and
// ONE file must stay out of the default suite —
//
//   tools/tests/routes-oracle-parity.test.mjs
//
// It boots a real Laravel app and is the CI `parity-oracle` job's whole subject
// (that job runs it explicitly, against its own scan-app). Folding it into
// `npm test` would run it a second time against a different app. So the default
// suite is "every *.test.mjs EXCEPT that one", which a hand-list used to express
// by naming 98 paths by hand — and forgetting a new test file meant it silently
// never ran in CI. Discovery removes that footgun; the exclusion is one line,
// named, and commented.
//
// Two modes on top of the default suite (the flags at the bottom):
//   --coverage  Node's built-in instrument; `npm run test:coverage`, CI runs it
//   --fast      skip the measured-slow files; `npm run test:fast`

import { readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_DIRS = ['compiler/tests', 'kernel/tests', 'tools/tests'];
// The one file that is a CI job of its own, not part of the default suite.
const EXCLUDED = new Set(['routes-oracle-parity.test.mjs']);

const files = [];
for (const dir of TEST_DIRS) {
  const abs = join(ROOT, dir);
  for (const entry of readdirSync(abs)) {
    if (!entry.endsWith('.test.mjs')) continue;
    if (EXCLUDED.has(entry)) continue;
    files.push(join(abs, entry));
  }
}
files.sort();

// --- modes ---------------------------------------------------------------
//
// `--coverage` (`npm run test:coverage`, run by CI) re-runs the suite under
// Node's built-in coverage instrument. It answers a question the shadow
// harness's `coverage` number does NOT answer: which lines does no test ever
// execute (the shadow's `coverage` counts scenario STEPS — see `shadow/run.mjs`).
// ONE file is dropped here: `budget.test.mjs` asserts WALL-CLOCK budgets
// (`p95 ≤ 5 ms` hot, ≤ 30 ms for the encrypter) and the instrument slows every
// line down, so under coverage it would measure the instrument instead of the
// kernel. It still runs in the plain suite.
//
// `--fast` (`npm run test:fast`, the pre-push loop) skips the files measured to
// dominate the suite. Measured 2026-11-11 on a 12-core Windows box:
// `kernel/tests/schedule-utc.test.mjs` alone accounts for ~168 s of the ~245 s
// the suite's files report, so it is the one file worth naming here. The full
// suite (what CI runs) still executes everything.
const argv = process.argv.slice(2);
const COVERAGE_EXCLUDED = new Set(['budget.test.mjs']);
const SLOW = new Set(['schedule-utc.test.mjs']);

let selected = files;
const nodeArgs = ['--test'];

if (argv.includes('--coverage')) {
  nodeArgs.push('--experimental-test-coverage');
  selected = selected.filter((f) => !COVERAGE_EXCLUDED.has(basename(f)));
  console.log(
    `run-tests: coverage mode — ${selected.length} file(s); timing-sensitive excluded: ` +
      `${[...COVERAGE_EXCLUDED].join(', ')} (they assert wall-clock budgets)`
  );
}

if (argv.includes('--fast')) {
  const before = selected.length;
  selected = selected.filter((f) => !SLOW.has(basename(f)));
  console.log(
    `run-tests: fast mode — ${selected.length} file(s); skipped ${before - selected.length} slow file(s): ` +
      `${[...SLOW].join(', ')}`
  );
}

if (!selected.length) {
  console.error('run-tests: no test files selected');
  process.exit(1);
}

// Hand the discovered files to `node --test`, inheriting stdio and the
// environment (the oracle tests read LW_LARAVEL_APP), and exit with its code so
// CI sees a red suite as red.
const res = spawnSync(process.execPath, [...nodeArgs, ...selected], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(res.status ?? 1);
