#!/usr/bin/env node
// compiler/tests/rt-semantics.test.mjs — the transpiler's silent-wrong cases.
//
// The audit (M47) found PHP constructs that compiled to a DIFFERENT result
// than Laravel: the foreach by reference lost the write-back, the array
// spread became a nested array, and match() lost the int/float distinction.
// The expectations come from PHP 8.3 itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitController } from '../src/controller.mjs';

function compile(body) {
  const src =
    '<?php\nnamespace App\\Http\\Controllers;\nclass C {\n    public function demo()\n    {\n' +
    body +
    '\n        return response("ok");\n    }\n}\n';
  return emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
}

test('rt-semantics: a foreach by reference fails loud (PHP writes back into the array)', () => {
  // PHP: $a=[1,2,3]; foreach ($a as &$v) { $v = 9; } => [9,9,9]. A by-value
  // loop would answer [1,2,3] - a silent wrong answer.
  const res = compile('        $a = [1, 2, 3];\n        foreach ($a as &$v) { $v = 9; }');
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /foreach by reference/);
});

test('rt-semantics: the array spread keeps the values (not a nested array)', () => {
  // PHP: [...$a, ...$b] => [1,2,3] (the keys are dropped).
  const res = compile('        $a = [1, 2];\n        $b = [3];\n        $c = [...$a, ...$b];');
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /rt\.spread\(/);
  assert.doesNotMatch(res.code, /\[\s*v_a\s*,\s*v_b\s*\]/);
});

test('rt-semantics: a float literal stays a float (match() is strict)', () => {
  // PHP: match(1) { 1.0 => "A", default => "B" } => B (1 !== 1.0).
  const res = compile('        $x = 1;\n        $y = match ($x) { 1.0 => "A", default => "B" };');
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  // The float literal must not be flattened to an int.
  assert.match(res.code, /1\.0/);
});

test('rt-semantics: the null default inlines (a `?string $b = null` signature)', () => {
  const res = compile('        $b = null;\n        $c = $b;');
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /null/);
});
