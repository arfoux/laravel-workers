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

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

// Hand the discovered files to `node --test`, inheriting stdio and the
// environment (the oracle tests read LW_LARAVEL_APP), and exit with its code so
// CI sees a red suite as red.
const res = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(res.status ?? 1);
