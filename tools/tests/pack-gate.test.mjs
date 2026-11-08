// tools/pack-gate.mjs — the walk that decides what the published tarball must
// carry (audit #804).
//
// The gate used to compare a hand-written 23-name list against `npm pack`. That
// list was not closed under the import graph (38 of the 61 modules the build
// reaches were absent), so it could only ever confirm what somebody had already
// remembered: a module `build.mjs` imports but `package.json.files` excludes
// sailed through as "23 build/CLI modules shipped". These pin the walk itself,
// which is what makes those missing entries impossible to forget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { runtimeFiles } = await import('../pack-gate.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const write = (root, rel, content = '') => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lw-pack-gate-'));
  // A real file one level ABOVE the package root: reachable by a specifier, and
  // still not something the tarball could ship.
  const outside = join(dirname(root), `lw-pack-gate-outside-${Date.now().toString(36)}.mjs`);
  writeFileSync(outside, 'export const outside = 1;\n');
  // The fixture sources live in TEMPLATE literals: `tools/check-syntax.mjs`
  // blanks those when it resolves this file's own specifiers, so a sample
  // `import` inside the sample code is not mistaken for a real one.
  write(
    root,
    'a.mjs',
    `
import { b } from './sub/b.mjs';
import './c/d.mjs';
import { readFileSync } from 'node:fs';            // a bare specifier is not ours to ship
const helper = join(pkgDir, 'tools', 'helper.php');
const gone = join(pkgDir, 'tools', 'missing.php'); // named but absent: not a requirement
const optional = existsSync(join(pkgDir, 'tools', 'optional.php'));
const gitignore = join(appDir, '.gitignore');      // the USER's file, not the package's
const dynamic = join(pkgDir, 'tools', name);       // not literal: cannot be judged
const escaped = join(pkgDir, '..', '${outside.split(/[/\\]/).pop()}');
`,
  );
  write(root, 'sub/b.mjs', `
import { k } from '../kernel/k.mjs';
export const b = k;
`);
  write(root, 'kernel/k.mjs', 'export const k = 1;\n');
  write(root, 'c/d.mjs', 'export const d = 1;\n');
  write(root, 'tools/helper.php', `
<?php
require_once __DIR__ . '/_root.php';
`);
  write(root, 'tools/_root.php', '<?php\n');
  write(root, 'tools/optional.php', '<?php\n');
  write(root, '.gitignore', 'node_modules\n');
  return { root, outside };
}

const clean = (root, outside) => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { force: true });
};

test('the walk follows imports, then the paths a reached file runs', () => {
  const { root, outside } = fixture();
  try {
    assert.deepEqual(runtimeFiles(root, ['a.mjs']), [
      'a.mjs',
      'c/d.mjs',
      'kernel/k.mjs',
      'sub/b.mjs',
      'tools/_root.php',
      'tools/helper.php',
    ]);
  } finally {
    clean(root, outside);
  }
});

test('a named path is a requirement only when it is the package\'s and is there', () => {
  const { root, outside } = fixture();
  try {
    const files = runtimeFiles(root, ['a.mjs']);
    // `existsSync(...)` is a probe: deploy/doctor run their fixtures if the repo
    // has them, which is the opposite of shipping them.
    assert.ok(!files.includes('tools/optional.php'), 'an existence probe is not a requirement');
    assert.ok(!files.includes('tools/missing.php'), 'a literal that names no file is not one either');
    // `join(appDir, '.gitignore')` writes into the user's app.
    assert.ok(!files.includes('.gitignore'), 'another app\'s file is not ours to ship');
    assert.ok(!files.some((f) => f.startsWith('..')), 'a path above the root is not shippable');
    assert.ok(!files.some((f) => f.includes('undefined')), 'a non-literal segment must not be joined');
  } finally {
    clean(root, outside);
  }
});

test('the walk over this repo reaches the build\'s deep dependencies', () => {
  const files = new Set(runtimeFiles(repoRoot));
  // One module per layer the old list under-reported: a kernel helper, a
  // compiler source, a tool only reachable through another tool, and the PHP
  // helpers the build's metadata phase pulls in with `require_once __DIR__`.
  for (const f of [
    'build.mjs',
    'bin/laravel-workers.mjs',
    'kernel/str.mjs',
    'compiler/src/transpiler.mjs',
    'compiler/blade.mjs',
    'tools/order-json.mjs',
    'tools/metadata-phase.php',
    'tools/model-dump.php',
    'tools/policy-dump.php',
    'tools/schema-compile.php',
    'package.json',
  ]) {
    assert.ok(files.has(f), `${f} is loaded at runtime and should be required to ship`);
  }
  // The walk reports paths, not guesses: everything it names exists in the repo.
  const invented = [...files].filter((f) => !existsSync(join(repoRoot, f)));
  assert.deepEqual(invented, [], 'the walk must not invent paths that are not there');
});
