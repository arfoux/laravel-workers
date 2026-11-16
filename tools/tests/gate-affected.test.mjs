// tools/tests/gate-affected.test.mjs — deterministic tests for the *selection
// algorithm* only. The helpers are pure: no git, no spawning, no filesystem
// discovery here (the tool builds its graph from the real tree at runtime).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSpecifiers,
  isSourceFile,
  needsFullSuite,
  norm,
  selectTests,
  stemOf,
} from '../gate-affected.mjs';

// A tiny synthetic graph. Each value is the transitive local-file closure of
// the test, including the test file itself.
const graph = new Map([
  ['compiler/tests/a.test.mjs', new Set([
    'compiler/tests/a.test.mjs',
    'compiler/src/a.mjs',
    'compiler/src/shared.mjs',
  ])],
  ['kernel/tests/b.test.mjs', new Set([
    'kernel/tests/b.test.mjs',
    'kernel/b.mjs',
  ])],
  ['tools/tests/tool.test.mjs', new Set([
    'tools/tests/tool.test.mjs',
    'tools/tool.mjs',
  ])],
  ['tools/tests/gate-affected.test.mjs', new Set([
    'tools/tests/gate-affected.test.mjs',
  ])],
]);

test('a transitive import selects its test and is not an untested source', () => {
  const selected = selectTests(['compiler/src/shared.mjs'], graph);
  assert.deepEqual(selected, ['compiler/tests/a.test.mjs']);
  assert.deepEqual(needsFullSuite(['compiler/src/shared.mjs'], selected, graph), []);
});

test('a changed test file selects itself', () => {
  const selected = selectTests(['kernel/tests/b.test.mjs'], graph);
  assert.deepEqual(selected, ['kernel/tests/b.test.mjs']);
  // test-only changes never force the full suite
  assert.deepEqual(needsFullSuite(['kernel/tests/b.test.mjs'], selected, graph), []);
});

test('a basename-stem match selects a test that does not import the source', () => {
  const selected = selectTests(['tools/gate-affected.mjs'], graph);
  assert.deepEqual(selected, ['tools/tests/gate-affected.test.mjs']);
  assert.deepEqual(needsFullSuite(['tools/gate-affected.mjs'], selected, graph), []);
});

test('an untested source file forces the full suite', () => {
  assert.deepEqual(
    needsFullSuite(['compiler/src/unknown.mjs'], [], graph),
    ['compiler/src/unknown.mjs']
  );
  // ...even when some other test was selected for a different change
  assert.deepEqual(
    needsFullSuite(['compiler/src/shared.mjs', 'kernel/new.mjs'], ['compiler/tests/a.test.mjs'], graph),
    ['kernel/new.mjs']
  );
});

test('docs, workflow, fixture and test-only changes do not force full', () => {
  const changed = [
    'docs/CI.md',
    '.github/workflows/ci.yml',
    'compiler/tests/corpus/cases/some.json',
    'kernel/tests/b.test.mjs',
    'README.md',
  ];
  assert.deepEqual(needsFullSuite(changed, selectTests(changed, graph), graph), []);
});

test('an empty change set is a full fallback, never a silent zero-test run', () => {
  assert.deepEqual(needsFullSuite([], [], graph), ['<no changed files>']);
  assert.deepEqual(selectTests([], graph), []);
});

test('selection is sorted, de-duplicated and accepts Windows-style paths', () => {
  const selected = selectTests(
    ['compiler\\src\\shared.mjs', './compiler/src/shared.mjs', 'kernel/b.mjs'],
    graph
  );
  assert.deepEqual(selected, ['compiler/tests/a.test.mjs', 'kernel/tests/b.test.mjs']);
});

test('specifier parsing follows from/import()/require but skips node: and bare', () => {
  const src = `
    import { a } from './a.mjs';
    export { b } from "../b.js";
    const c = await import('./c.mjs');
    const d = require('./d.cjs');
    import './side.mjs';
    import { test } from 'node:test';
    import php from 'php-parser';
    const sample = \`import './not-real.mjs';\`;
  `;
  assert.deepEqual(extractSpecifiers(src).sort(), [
    '../b.js', './a.mjs', './c.mjs', './d.cjs', './side.mjs',
  ]);
});

test('path helpers normalise and classify source vs non-source', () => {
  assert.equal(norm('./kernel\\db.mjs'), 'kernel/db.mjs');
  assert.equal(stemOf('gate-affected.test.mjs'), 'gate-affected');
  assert.equal(stemOf('tools/gate-affected.mjs'), 'gate-affected');
  assert.equal(isSourceFile('kernel/db.mjs'), true);
  assert.equal(isSourceFile('build.mjs'), true);
  assert.equal(isSourceFile('bin/laravel-workers.mjs'), true);
  assert.equal(isSourceFile('kernel/tests/db.test.mjs'), false);
  assert.equal(isSourceFile('tools/tests/helper.mjs'), false);
  assert.equal(isSourceFile('docs/CI.md'), false);
  assert.equal(isSourceFile('compiler/tests/corpus/cases/x.json'), false);
});
