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
//
// The test RUNS the snippet (audit #894). The old form asserted the emitted
// TEXT (`assert.match(res.code, /break __l\d+/)` and "at least two labels"),
// which proved only that a label was printed — never which loop the break left:
// it would still pass if the break left the switch instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPhpSnippet } from './run-php-snippet.mjs';

test('rt-break: a break inside a loop nested in a switch breaks the loop (PHP prints 7AL)', () => {
  const out = runPhpSnippet(
    '<?php\n' +
      '$out = "";\n' +
      'foreach ([1] as $x) {\n' +
      '    switch ($x) {\n' +
      '        case 1:\n' +
      '            foreach ([7, 8] as $y) {\n' +
      '                if ($y == 8) { break; }\n' +
      '                $out = $out . $y;\n' +
      '            }\n' +
      '            $out = $out . "A";\n' +
      '            break;\n' +
      '    }\n' +
      '    $out = $out . "L";\n' +
      '}\n' +
      'echo $out;'
  );
  assert.equal(out, '7AL');
});
