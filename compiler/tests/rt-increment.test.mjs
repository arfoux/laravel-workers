#!/usr/bin/env node
// compiler/tests/rt-increment.test.mjs — the increment and the continue.
//
// The audit found three more constructs whose compiled form differed from
// Laravel's: a `continue` inside a switch continued the LOOP (PHP leaves the
// switch), an increment on a property was not a valid JS assignment target
// (a ReferenceError at request time), and the increment on a string answered
// NaN where PHP bumps the last byte.
//
// The expectations come from PHP 8.3 itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitController } from '../src/controller.mjs';
import { buildRt } from '../runtime/rt-from-context.mjs';

function compile(body) {
  const src =
    '<?php\nnamespace App\\Http\\Controllers;\nclass C {\n    public function demo()\n    {\n' +
    body +
    '\n        return response("ok");\n    }\n}\n';
  return emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
}

test('rt-increment: a continue inside a switch leaves the switch (PHP 8: a warning, a break)', () => {
  // PHP: foreach ([1,2] as $x) { switch ($x) { case 1: continue; default: echo 'D'; }
  // echo 'K'; } => KDK - the continue leaves the switch, the loop continues.
  const res = compile(
    '        foreach ([1, 2] as $x) {\n' +
      '            switch ($x) {\n' +
      '                case 1:\n' +
      '                    continue;\n' +
      '                default:\n' +
      '                    $out = $out . "D";\n' +
      '            }\n' +
      '            $out = $out . "K";\n' +
      '        }'
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  // The continue becomes a break of the switch (not a bare JS continue).
  assert.doesNotMatch(res.code, /^\s*continue;/m);
  assert.match(res.code, /break __sw\d+;/);
});

test('rt-increment: an increment on a property fails loud (a ReferenceError at request time)', () => {
  // PHP: $post->views++ increments the attribute. The compiled side would be
  // `rt.prop(post, 'views')++` - not a valid JS assignment target.
  const res = compile('        $post->views++;');
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.equal(res.errors[0].code, 'LW002');
  assert.match(res.errors[0].message, /increment on a property/);
});

test('rt-increment: the increment follows PHP (a number, a string, a bool)', () => {
  const rt = buildRt({}, { strict: false });
  assert.equal(rt.inc(1), 2);
  assert.equal(rt.inc(1.5), 2.5);
  assert.equal(rt.inc(true), 2);
  assert.equal(rt.inc(null), 1);
  // PHP: "a" -> "b", "z" -> "aa", "Az" -> "Ba", "19" -> "20".
  assert.equal(rt.inc('a'), 'b');
  assert.equal(rt.inc('z'), 'aa');
  assert.equal(rt.inc('Az'), 'Ba');
  assert.equal(rt.inc('19'), 20);
  assert.equal(rt.inc('99'), 100);
  // PHP 8: a decrement on a NON-numeric string has no effect (deprecated).
  assert.equal(rt.dec('b'), 'b');
  assert.equal(rt.dec('a'), 'a');
  assert.equal(rt.dec('20'), 19);
  assert.equal(rt.dec(2), 1);
});

test('rt-increment: the statement form uses the PHP increment', () => {
  const res = compile('        $s = "a";\n        $s++;');
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /rt\.inc\(/);
});
