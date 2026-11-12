import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// `src/worker.mjs` imports generated files that only exist in `dist/`, so it
// cannot be imported by a unit test — but `node --check` still parses it and
// catches duplicate declarations (a real bug that shipped once) and syntax
// errors before deploy.
const FILES = [
  'src/worker.mjs',
  'build.mjs',
  'kernel/http.mjs',
  'kernel/model.mjs',
  'kernel/validator.mjs',
  'compiler/runtime/rt-from-context.mjs',
  'compiler/src/controller.mjs',
  'compiler/src/transpiler.mjs',
];

test('source modules parse (node --check)', () => {
  for (const rel of FILES) {
    const file = path.join(pkgDir, rel);
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${rel}\n${res.stderr || res.stdout}`);
  }
});
