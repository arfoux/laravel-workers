// compiler/tests/ctx-gated-helpers.test.mjs — the diagnostic for the Laravel
// helpers that only compile inside a controller/view context.
//
// `transpile()` runs WITHOUT a compile context (CTX). The helpers Laravel
// defines globally (view/abort/compact/redirect/session/cache/...) are only
// wired when the build sets CTX; without it the old code answered the generic
// LW001 "unknown function view" — false, the function IS known, it just has no
// compile context. The refusal must name the real reason (LW002), so a reader
// does not chase a nonexistent typo. Same for PHP named arguments: they used
// to fall through to "unsupported expression kind namedargument".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transpile, CTX_GATED_HELPERS } from '../src/transpiler.mjs';

const errOf = (src) => {
  const r = transpile(src, {});
  assert.equal(r.code, null, 'expected a refusal');
  assert.equal(r.errors.length, 1);
  return r.errors[0];
};

const EXPECTED = new Set(['view', 'abort', 'compact', 'redirect', 'session', 'cache', 'old', 'csrf_token', 'csrf_field', 'request']);

test('the gated set is exactly the known helpers', () => {
  assert.deepEqual([...CTX_GATED_HELPERS].sort(), [...EXPECTED].sort());
});

test('every context-gated helper refuses with LW002, not the generic LW001', () => {
  for (const name of CTX_GATED_HELPERS) {
    const e = errOf(`<?php ${name}();`);
    assert.equal(e.code, 'LW002', `${name}() should be a compile-context refusal`);
    assert.match(e.message, new RegExp(`${name}\\(\\) is only available inside a compiled controller`));
    assert.doesNotMatch(e.message, /unknown function/);
  }
});

test('named arguments refuse with a specific message', () => {
  const e = errOf('<?php foo(bar: 1);');
  assert.equal(e.code, 'LW002');
  assert.match(e.message, /named argument \(bar: \.\.\.\) are not compiled/);
  assert.doesNotMatch(e.message, /unsupported expression kind/);
  // several keywords are listed together, and the refusal is specific.
  const e2 = errOf('<?php foo(a: 1, b: 2);');
  assert.equal(e2.code, 'LW002');
  assert.match(e2.message, /\(a: \.\.\., b: \.\.\.\)/);
});

test('a truly unknown function still answers the generic LW001', () => {
  const e = errOf('<?php frobnicate(1);');
  assert.equal(e.code, 'LW001');
  assert.match(e.message, /unknown function frobnicate/);
});
