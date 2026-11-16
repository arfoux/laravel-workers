// kernel/tests/own-key.mjs — direct coverage of own-property access for keys
// that arrive from untrusted client strings. A `__proto__`, `constructor` or
// `toString` name must stay ordinary DATA; an ordinary `obj[k] = v` write would
// run Object.prototype's setter / read an inherited function instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ownSet,
  ownGet,
  ownHas,
  assignOwn,
  copyOwn,
  newOrderedBag,
  orderedKeys,
  orderedSet,
  isPlainObject,
} from '../own-key.mjs';

const DANGEROUS = ['__proto__', 'constructor', 'toString'];

test('ownSet/ownGet/ownHas round-trip dangerous keys as own data', () => {
  for (const key of DANGEROUS) {
    const target = {};
    assert.equal(ownHas(target, key), false, key);
    assert.equal(ownGet(target, key), undefined, key);
    assert.equal(ownSet(target, key, 'stored'), 'stored', key);
    assert.equal(ownHas(target, key), true, key);
    assert.equal(ownGet(target, key), 'stored', key);
    assert.equal(Object.prototype.hasOwnProperty.call(target, key), true, key);
    // Inherited lookups must not be mistaken for own data.
    assert.equal(Object.prototype.hasOwnProperty.call({}, key), false, key);
  }
});

test('ownSet never pollutes Object.prototype, including for __proto__', () => {
  for (const key of DANGEROUS) {
    const target = {};
    ownSet(target, key, { polluted: true });
    assert.equal(({}).polluted, undefined, key);
    assert.equal(Object.prototype.polluted, undefined, key);
    assert.equal(Object.getPrototypeOf(target), Object.prototype, key);
    assert.equal(ownGet({}, key), undefined, key);
  }
  assert.equal(({}).polluted, undefined);
});

test('assignOwn/copyOwn copy dangerous own keys without the __proto__ setter', () => {
  // JSON.parse creates a REAL own "__proto__" property; an object literal would
  // not, so it could not detect the setter trap.
  const src = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"c","toString":"t","plain":1}'
  );
  const target = assignOwn({}, src);
  assert.equal(ownGet(target, '__proto__').polluted, true);
  assert.equal(ownGet(target, 'constructor'), 'c');
  assert.equal(ownGet(target, 'toString'), 't');
  assert.equal(ownGet(target, 'plain'), 1);
  assert.equal(Object.getPrototypeOf(target), Object.prototype);
  assert.equal(({}).polluted, undefined);

  const copy = copyOwn(src, { plain: 2, toString: 'override' });
  assert.equal(ownGet(copy, 'plain'), 2);
  assert.equal(ownGet(copy, 'toString'), 'override');
  assert.equal(ownGet(copy, '__proto__').polluted, true);
  assert.equal(({}).polluted, undefined);
});

test('ordered bags keep first-insertion order for integer-like and dangerous keys', () => {
  const bag = newOrderedBag();
  assert.deepEqual(orderedKeys(bag), []);
  orderedSet(bag, '2', 'two');
  orderedSet(bag, '__proto__', { polluted: true });
  orderedSet(bag, '0', 'zero');
  orderedSet(bag, '2', 'TWO');
  assert.deepEqual(orderedKeys(bag), ['2', '__proto__', '0']);
  assert.equal(ownGet(bag, '2'), 'TWO');
  assert.equal(Object.prototype.hasOwnProperty.call(bag, '__order'), true);
  assert.equal(Object.keys(bag).includes('__order'), false);
  assert.equal(({}).polluted, undefined);
});

test('isPlainObject distinguishes PHP-array containers from leaves', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(new Uint8Array(1)), false);
  assert.equal(isPlainObject(new Date()), false);
  assert.equal(isPlainObject(new (class X {})()), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);
});
