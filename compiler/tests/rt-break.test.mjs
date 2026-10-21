#!/usr/bin/env node
// compiler/tests/rt-break.test.mjs — a `break` breaks the innermost loop.
//
// The audit found the switch's break label leaking into a nested loop, so a
// `break` inside the loop broke the SWITCH (the code after the loop was
// skipped). PHP: a break inside a loop breaks the loop.
//
// PHP: foreach ([1] as $x) { switch ($x) { case 1: foreach ([7,8] as $y) { if
// ($y==8) { break; } echo $y; } echo 'A'; break; } echo 'L'; } => 7AL
// (the inner break leaves the inner foreach only).
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

test('rt-break: a break inside a loop nested in a switch breaks the loop', () => {
  const res = compile(
    '        $out = "";\n' +
      '        foreach ([1] as $x) {\n' +
      '            switch ($x) {\n' +
      '                case 1:\n' +
      '                    foreach ([7, 8] as $y) {\n' +
      '                        if ($y == 8) { break; }\n' +
      '                        $out = $out . $y;\n' +
      '                    }\n' +
      '                    $out = $out . "A";\n' +
      '                    break;\n' +
      '            }\n' +
      '            $out = $out . "L";\n' +
      '        }'
  );
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  // The inner break leaves the inner foreach: the "A" echo still runs.
  assert.match(res.code, /break __l\d+/);
  // The loop carries its own label (not the switch's).
  const labels = [...res.code.matchAll(/(__l\d+): for/g)].map((m) => m[1]);
  assert.ok(labels.length >= 2, 'each loop has its own label: ' + JSON.stringify(labels));
});
