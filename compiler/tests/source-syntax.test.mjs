import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
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

// `src/worker.mjs` imports the generated registries unconditionally, and the
// build copies that template into `dist/src/` whatever the routes did. A
// registry written only inside the `if (prepared.length)` controller block is
// therefore MISSING on an app whose every route was skipped (or whose dump
// threw), and the bundler answers "Could not resolve ./classes.generated.mjs"
// instead of the build naming the skipped routes. That shipped once.
//
// The contract: every generated module the worker imports is either written
// outside that block, or has a `!existsSync(...)` fallback - so `dist` is
// always bundlable.
test('every generated module the worker imports is always emitted', () => {
  const worker = readFileSync(path.join(pkgDir, 'src', 'worker.mjs'), 'utf8');
  const build = readFileSync(path.join(pkgDir, 'build.mjs'), 'utf8');
  const names = [...worker.matchAll(/from '\.\/([A-Za-z0-9._-]+\.generated\.mjs)'/g)].map((m) => m[1]);
  assert.ok(names.length > 0, 'the worker imports no generated module - the pattern changed');

  // The conditional block's line range (the brace matching the `if`).
  const lines = build.split('\n');
  const open = lines.findIndex((l) => /^\s*if \(prepared\.length\) \{$/.test(l));
  assert.ok(open >= 0, 'the `if (prepared.length)` controller block moved - re-derive this test');
  let depth = 0;
  let close = -1;
  for (let i = open; i < lines.length && close < 0; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        close = i;
        break;
      }
    }
  }
  assert.ok(close > open, 'could not find the end of the controller block');

  for (const name of names) {
    const writes = lines
      .map((l, i) => (l.includes(`'src', '${name}'`) || l.includes(`"src", "${name}"`) ? i : -1))
      .filter((i) => i >= 0);
    const emittedOutside = writes.some((i) => i < open || i > close);
    const fallback = new RegExp(
      "if \\(!existsSync\\(join\\(dist, 'src', '" + name.replace(/\./g, '\\.') + "'\\)\\)\\)"
    ).test(build);
    assert.ok(
      emittedOutside || fallback,
      `${name}: src/worker.mjs imports it unconditionally, but build.mjs only writes it inside ` +
        'the controller block - a build with no compiled controller ships a worker whose imports ' +
        'do not resolve. Emit it outside the block or add an existsSync fallback.'
    );
  }
});
