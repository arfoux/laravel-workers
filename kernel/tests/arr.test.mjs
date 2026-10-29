// kernel/tests/arr.test.mjs - the Arr family, verified against the real
// Laravel (the oracle: the fixture app's vendor, PHP 8.3). The expected values
// are PHP's, not ours. `Arr::except` is the reason this module exists (Blade's
// own view-data filter on Laravel 11.0-11.42); the rest are the helpers the
// sample apps call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arr, ARR_METHODS } from '../arr.mjs';

test('Arr: every allowlisted name exists on the kernel arr', () => {
  const missing = [...ARR_METHODS].filter((name) => typeof arr[name] !== 'function');
  assert.deepEqual(missing, [], `kernel arr has no ${missing.join(', ')}()`);
  assert.ok(ARR_METHODS.has('except'), 'Arr::except() must be allowed: Blade emits it');
});

test('Arr::except / wrap — Arr.php:150, :1336', () => {
  assert.deepEqual(arr.except({ a: 1, b: 2, c: 3 }, ['a', 'c']), { b: 2 });
  // the CALLER's nested arrays do not change (PHP passes by value).
  const nested = { a: { b: 1, c: 2 } };
  assert.deepEqual(arr.except(nested, ['a.b']), { a: { c: 2 } });
  assert.deepEqual(nested, { a: { b: 1, c: 2 } });
  assert.deepEqual(arr.wrap(null), []);
  assert.deepEqual(arr.wrap('x'), ['x']);
  assert.deepEqual(arr.wrap({ a: 1 }), { a: 1 });
});

test('Arr::get / has — Arr.php:497, :533 (dot notation, exact key first)', () => {
  const a = { user: { name: 'Ada', roles: ['admin', 'dev'] }, id: 7 };
  assert.equal(arr.get(a, 'user.name'), 'Ada');
  assert.equal(arr.get(a, 'user.age', 'def'), 'def');
  assert.equal(arr.get(a, null), a); // a null key answers the array
  assert.equal(arr.get({ 'a.b': 1 }, 'a.b'), 1); // the literal key beats the path
  assert.equal(arr.has(a, 'user.roles'), true);
  assert.equal(arr.has(a, ['user.name', 'id']), true);
  assert.equal(arr.has(a, 'user.age'), false);
  assert.equal(arr.has(a, []), false);
});

test('Arr::only / first / last — Arr.php:752, :293, :340', () => {
  assert.deepEqual(arr.only({ id: 1, name: 2, x: 3 }, ['id', 'x']), { id: 1, x: 3 });
  assert.deepEqual(arr.only({ id: 1 }, ['id', 'nope']), { id: 1 });
  assert.equal(arr.first([10, 20, 30], (v) => v > 15), 20);
  assert.equal(arr.first([1, 2], (v) => v > 5, 'none'), 'none');
  assert.equal(arr.first({ a: 1, b: 2 }), 1);
  assert.equal(arr.first([], null, 'e'), 'e');
  assert.equal(arr.last([10, 20, 30], (v) => v < 25), 20);
  assert.equal(arr.last([1, 2, 3]), 3);
});

test('Arr::dot — Arr.php:185 (flatten with dots, prepend, depth)', () => {
  assert.deepEqual({ ...arr.dot({ a: { b: 1, c: { d: 2 } }, e: 3 }) }, {
    'a.b': 1,
    'a.c.d': 2,
    e: 3,
  });
  assert.deepEqual({ ...arr.dot({ a: 1 }, 'p.') }, { 'p.a': 1 });
  assert.deepEqual({ ...arr.dot({ a: { b: { c: 1 } } }, '', 1) }, { 'a.b': { c: 1 } });
});
