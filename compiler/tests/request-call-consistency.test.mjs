import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from '../../kernel/http.mjs';
import { REQUEST_CALL, REQUEST_NO_CHAIN, REQUEST_ASYNC, REQUEST_DENY } from '../../compiler/src/transpiler.mjs';

test('REQUEST_CALL is subset of kernel Request methods (no drift)', () => {
  const req = buildRequest({ method: 'GET', url: 'http://localhost/x?foo=bar', headers: {} });
  for (const m of REQUEST_CALL) {
    assert.equal(typeof req[m], 'function', `kernel Request missing method: ${m}`);
  }
});

test('REQUEST_CALL excludes removed "date" (no kernel impl)', () => {
  assert.equal(REQUEST_CALL.has('date'), false);
});

test('REQUEST_CALL includes "str" (kernel parity)', () => {
  assert.equal(REQUEST_CALL.has('str'), true);
});

test('REQUEST_NO_CHAIN excludes route/session/user (chainable)', () => {
  assert.equal(REQUEST_NO_CHAIN.has('route'), false);
  assert.equal(REQUEST_NO_CHAIN.has('session'), false);
  assert.equal(REQUEST_NO_CHAIN.has('user'), false);
});

test('REQUEST_ASYNC contains "user"', () => {
  assert.equal(REQUEST_ASYNC.has('user'), true);
});

test('REQUEST_CALL and REQUEST_NO_CHAIN agree on membership', () => {
  for (const m of REQUEST_NO_CHAIN) {
    assert.equal(REQUEST_CALL.has(m), true, `${m} in NO_CHAIN but not REQUEST_CALL`);
  }
});
