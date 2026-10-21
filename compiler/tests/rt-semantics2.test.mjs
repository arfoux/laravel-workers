#!/usr/bin/env node
// compiler/tests/rt-semantics2.test.mjs — the audit's remaining findings.
//
// Three constructs the parallel audit found: in_array() over a PHP assoc array
// (the compiled side walked a JS array, so it was always false), the numeric
// string compare beyond 2^53 (JS's Number() rounds, so two different int64s
// answered "equal"), and the negative string offset ($s[-1] - PHP 7.1+ returns
// the character from the end).
//
// The expectations come from PHP 8.3 itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRt } from '../runtime/rt-from-context.mjs';
import { emitController } from '../src/controller.mjs';

const rt = buildRt({}, { strict: false });

test('rt-semantics2: in_array walks the values of a PHP assoc array', () => {
  // PHP: in_array('1', ['a' => 1]) => true
  assert.equal(rt.in_array('1', { a: 1 }), true);
  assert.equal(rt.in_array('1', [1]), true);
  assert.equal(rt.in_array('2', { a: 1 }), false);
});

test('rt-semantics2: two numeric strings are compared with the int64 precision', () => {
  // PHP: '9007199254740993' == '9007199254740992' => false (JS rounds both to
  // 9007199254740992, so the answer would be true).
  assert.equal(rt.looseEq('9007199254740993', '9007199254740992'), false);
  assert.equal(rt.looseEq('9007199254740993', '9007199254740993'), true);
  // The ordinary cases still hold.
  assert.equal(rt.looseEq('1.0', '1'), true);
  assert.equal(rt.looseEq('1e3', '1000'), true);
  assert.equal(rt.looseEq('abc', 'abc'), true);
  assert.equal(rt.looseEq('abc', 'abd'), false);
});

test('rt-semantics2: a negative string offset fails loud (PHP returns the last character)', () => {
  const src =
    '<?php\nnamespace App\\Http\\Controllers;\nclass C {\n    public function demo()\n    {\n' +
    "        $s = 'abc';\n        echo $s[-1];\n" +
    '\n        return response("ok");\n    }\n}\n';
  const res = emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /negative string offset/);
});
