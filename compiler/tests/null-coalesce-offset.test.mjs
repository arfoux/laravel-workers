#!/usr/bin/env node
// compiler/tests/null-coalesce-offset.test.mjs — `??` over an offset read with a
// null/undefined base.
//
// PHP: `$category['label'] ?? ''` answers '' when $category is null (the read
// is part of the `??` expression, so PHP suppresses the warning). The compiler
// used to emit the plain JS bracket read `v_category["label"] ?? ""`, which
// throws `TypeError: Cannot read properties of null (reading 'label')`.
//
// The fix emits an optional-chained read for offset links on the LEFT of `??`
// only. The right arm stays a native `??` operand, so PHP's short-circuit and
// single evaluation of the base are preserved, and unrelated TypeErrors (plain
// reads outside `??`) are not masked. Property reads already go through
// rt.prop(null, ...), which answers null — covered here as a no-regression case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transpile } from '../src/transpiler.mjs';
import { buildRt } from '../runtime/rt-from-context.mjs';

// Compile the same way rt-blade.test.mjs does: transpile, lift the body of
// main(), and run it against a runtime seeded with the view data.
function runView(php, data) {
  const { code, errors } = transpile(php, {});
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const inner = code.replace(/^export default function main\(rt\)\s*\{\n?/, '').replace(/\n\}\n?$/, '');
  const rt = buildRt({}, { strict: false, data: data || {} });
  new Function('rt', inner)(rt);
  return rt.__output;
}

const NULL_BASE = '<?php echo $category["label"] ?? "DEFAULT"; ?>';

test('null-coalesce-offset: the compiled expression is null-safe but keeps native ??', () => {
  const { code, errors } = transpile(NULL_BASE, {});
  assert.equal(errors.length, 0, JSON.stringify(errors));
  // Before: ((v_category["label"] ?? "DEFAULT"))
  // After:  (((v_category)?.["label"] ?? "DEFAULT"))
  assert.match(code, /\(\(v_category\)\?\.\["label"\] \?\? "DEFAULT"\)/);
  assert.doesNotMatch(code, /v_category\["label"\] \?\?/);
});

test('null-coalesce-offset: null and undefined bases answer the fallback', () => {
  assert.equal(runView(NULL_BASE, { category: null }), 'DEFAULT');
  // An undeclared view variable is undefined on the JS side; PHP treats it as
  // null, so `??` must answer the fallback rather than throw.
  assert.equal(runView(NULL_BASE, {}), 'DEFAULT');
});

test('null-coalesce-offset: a set base returns its value, a null value falls back', () => {
  assert.equal(runView(NULL_BASE, { category: { label: 'Hi' } }), 'Hi');
  assert.equal(runView(NULL_BASE, { category: { label: null } }), 'DEFAULT');
});

test('null-coalesce-offset: the fallback is not evaluated when the left is set', () => {
  const php =
    '<?php $i = 0; echo $category["label"] ?? $i++; echo "|"; echo $i; ?>';
  // Left set: `v_i++` (a side effect) must not run.
  assert.equal(runView(php, { category: { label: 'Hi' } }), 'Hi|0');
  // Left null: it runs exactly once (`$i++` echoes the pre-increment value 0).
  assert.equal(runView(php, { category: null }), '0|1');
});

test('null-coalesce-offset: a nested offset chain short-circuits at the first null', () => {
  const php = '<?php echo $a["b"]["c"] ?? "D"; ?>';
  assert.equal(runView(php, { a: null }), 'D');
  assert.equal(runView(php, { a: { b: null } }), 'D');
  assert.equal(runView(php, { a: { b: { c: 'v' } } }), 'v');
});

test('null-coalesce-offset: property reads stay null-safe (no regression)', () => {
  const php = '<?php echo $x->k ?? "D"; ?>';
  assert.equal(runView(php, { x: null }), 'D');
  assert.equal(runView(php, { x: { k: 'v' } }), 'v');
});

test('null-coalesce-offset: a plain read outside ?? is not silently null-safe', () => {
  const php = '<?php echo $category["label"]; ?>';
  const { code, errors } = transpile(php, {});
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.match(code, /v_category\["label"\]/);
  assert.doesNotMatch(code, /v_category\)\?\.\[/);
  const inner = code.replace(/^export default function main\(rt\)\s*\{\n?/, '').replace(/\n\}\n?$/, '');
  const rt = buildRt({}, { strict: false, data: { category: null } });
  assert.throws(() => new Function('rt', inner)(rt), TypeError);
});
