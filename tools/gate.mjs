#!/usr/bin/env node
// tools/gate.mjs - the docs gate.
//
// Two checks, one command, one flag:
//   1. tools/docs-check.mjs    - the coverage index (105/105), the format, the
//                                code <-> MAP parity (the fail-loud codes).
//   2. tools/construct-audit.mjs - the construct audit: every construct an app
//                                can meet is probed against the real compiler,
//                                and the generated table in COMPILED.md must
//                                match the code.
//   3. tools/docs-counts.mjs    - the README counts (constructs, corpus, docs)
//                                are generated from the code, so the README
//                                cannot drift from what it describes.
//
// The flags are forwarded to both (e.g. `--strict` turns the warnings into
// failures). The gate stops at the first failure.

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
console.log('gate PASS: the docs and the construct audit match the code');
