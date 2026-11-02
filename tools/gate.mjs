#!/usr/bin/env node
// tools/gate.mjs - the docs gate.
//
// The checks, one command, one flag:
//   1. tools/docs-check.mjs    - the coverage index (105/105), the format, the
//                                code <-> MAP parity (the fail-loud codes).
//   2. tools/construct-audit.mjs - the construct audit: every construct an app
//                                can meet is probed against the real compiler,
//                                and the generated table in COMPILED.md must
//                                match the code.
//   3. tools/docs-counts.mjs    - the README counts (constructs, corpus, docs)
//                                are generated from the code, so the README
//                                cannot drift from what it describes.
//   4. tools/validation-messages-check.mjs - the generated message table vs the
//                                framework's own lang/en/validation.php (#353).
//   5. tools/ascii-map-check.mjs - the generated portable-ascii table vs the
//                                app's vendor copy (#294).
//
// WHERE THIS SITS (audit #431): this file is the DOCS layer. The CI command
// `npm run gate:ci` is the outer layer - `npm test` (an explicit subset of the
// test files: the ones that need no built fixture or oracle) + `test:corpus` +
// this gate (`--strict`) + `tools/bench.mjs` + `tools/check-syntax.mjs` +
// `tools/pack-gate.mjs`. The dev-only scripts (`test:shadow`, `test:pack`) are
// not part of it: they need a prepared Laravel app. `tools/cpu-gate.mjs`
// (`npm run gate:cpu`) is deliberately outside too - it deploys a probe worker
// and reads `cpuTime`/`outcome` back through `wrangler tail`, so it needs a
// logged-in Cloudflare account (CI has none).
//
// The flags are forwarded to every check (e.g. `--strict` turns the warnings
// into failures); `--require` is forwarded only to the two oracle checks, whose
// app-less run is a skip unless it is asked for. The gate stops at the first
// failure.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);

function run(script, args) {
  const res = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    console.error(`gate FAIL: ${script} ${args.join(' ')}`);
    process.exit(res.status === null ? 1 : res.status);
  }
}

run('tools/docs-check.mjs', flags);
run('tools/construct-audit.mjs', ['--check', ...flags]);
run('tools/docs-counts.mjs', ['--check']);
// The generated validation-messages module vs the framework's own file (#353).
// Skips (exit 0) unless LW_APP_ROOT points at a Laravel app with a PHP binary;
// `--require` makes the no-app case fatal so the module cannot pass unaudited
// (#429 - the CI e2e job owns the app and passes it).
run('tools/validation-messages-check.mjs', flags.filter((f) => f === '--require'));
// The generated portable-ascii table vs the app's vendor copy (#294). Same
// skip/require contract: it needs LW_APP_ROOT, and the CI e2e job passes
// `--require` so the table cannot go green unaudited.
run('tools/ascii-map-check.mjs', flags.filter((f) => f === '--require'));
console.log('gate PASS: the docs and the construct audit match the code');
