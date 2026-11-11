// compiler/tests/request-call-consistency.test.mjs — the `$request->…()` tables
// the transpiler's request-call path uses.
//
// The audit (#894/#895) flagged this file's membership assertions
// (`assert.equal(REQUEST_CALL.has('date'), false)`) as tests of the TABLE, not
// of the compiler: they fail on an intended re-classification and pass even if
// the transpiler stops consulting the table at all. Where a verdict is cheap to
// observe, the test now ASKS THE COMPILER instead, and the tables keep only the
// cross-table invariants the emitter relies on.
//
// The runtime consequence of a table entry (what the compiled call actually
// answers at request time) is covered where the compiled code runs:
// `kernel/tests/request.test.mjs` and `compiler/tests/controller.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from '../../kernel/http.mjs';
import { emitController } from '../../compiler/src/controller.mjs';
import { REQUEST_CALL, REQUEST_NO_CHAIN, REQUEST_ASYNC, REQUEST_DENY } from '../../compiler/src/transpiler.mjs';

function compileRequestCall(body) {
  const src =
    '<?php\nnamespace App\\Http\\Controllers;\nclass C {\n' +
    '    public function demo(\\Illuminate\\Http\\Request $request)\n    {\n' +
    body +
    '\n        return response("ok");\n    }\n}\n';
  return emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
}

test('REQUEST_CALL is subset of kernel Request methods (no drift)', () => {
  const req = buildRequest({ method: 'GET', url: 'http://localhost/x?foo=bar', headers: {} });
  for (const m of REQUEST_CALL) {
    assert.equal(typeof req[m], 'function', `kernel Request missing method: ${m}`);
  }
});

test('a kernel-backed Request call compiles; one the kernel lacks fails loud', () => {
  const supported = compileRequestCall('        $v = $request->str();');
  assert.equal(supported.errors.length, 0, JSON.stringify(supported.errors));

  const refused = compileRequestCall('        $v = $request->date();');
  assert.equal(refused.errors.length, 1, JSON.stringify(refused.errors));
  assert.equal(refused.errors[0].code, 'LW002');
  assert.match(refused.errors[0].message, /unsupported \$request->date\(\)/);

  // The chain and async paths are NOT REQUEST_CALL: both still compile.
  assert.equal(compileRequestCall('        $v = $request->route()->getName();').errors.length, 0);
  assert.equal(compileRequestCall('        $v = $request->user();').errors.length, 0);
});

test('the tables agree on which methods take the chain, async and denied paths', () => {
  // NO_CHAIN ⊆ CALL: a non-chainable method is still one the compiler calls.
  for (const m of REQUEST_NO_CHAIN) {
    assert.equal(REQUEST_CALL.has(m), true, `${m} in NO_CHAIN but not REQUEST_CALL`);
  }
  // CALL minus NO_CHAIN is the CHAINABLE set: the three methods that answer an
  // OBJECT (`$request->route()->getName()`, `$request->session()->get()`,
  // `$request->file('x')->store()`).
  assert.deepEqual(
    [...REQUEST_CALL].filter((m) => !REQUEST_NO_CHAIN.has(m)).sort(),
    ['file', 'route', 'session']
  );
  // The async and denied methods take their own paths: never REQUEST_CALL.
  for (const m of [...REQUEST_ASYNC, ...REQUEST_DENY]) {
    assert.equal(REQUEST_CALL.has(m), false, `${m} is async/denied but also REQUEST_CALL`);
  }
});
