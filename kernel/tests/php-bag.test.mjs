// kernel/tests/php-bag.mjs — direct coverage of PHP's variable-registration
// bag (parse_str() / $_POST / $_FILES naming). The expected shapes are PHP 8.3
// answers; `__proto__` must be an own DATA key, never a prototype write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhpQuery, bagPut, newBag, normalizePhpArrays } from '../php-bag.mjs';

test('parsePhpQuery shapes a[b], c[], 0[] and x[__proto__][p] like PHP', () => {
  const out = parsePhpQuery('a[b]=1&c[]=2&0[]=3&x[__proto__][p]=4');
  assert.deepEqual(JSON.parse(JSON.stringify(out)), {
    a: { b: '1' },
    c: ['2'],
    0: ['3'],
    x: JSON.parse('{"__proto__":{"p":"4"}}'),
  });
  assert.equal(Object.getPrototypeOf(out.x), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(out.x, '__proto__'), true);
});

test('parsePhpQuery never pollutes Object.prototype with dangerous keys', () => {
  const out = parsePhpQuery(
    [
      'x[__proto__][p]=4',
      '__proto__[polluted]=1',
      'constructor[prototype][polluted]=2',
      'toString=polluted',
    ].join('&')
  );
  assert.equal(({}).p, undefined);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  assert.equal(typeof ({}).toString, 'function');
  // The names are stored as ordinary own data instead.
  assert.equal(Object.prototype.hasOwnProperty.call(out, '__proto__'), true);
  assert.equal(out.__proto__.polluted, '1');
  assert.equal(out.toString, 'polluted');
  assert.equal(Object.getPrototypeOf(out.x), Object.prototype);
  assert.equal(out.x.__proto__.p, '4');
});

test('bagPut nests, appends and overwrites scalars through the PHP rule', () => {
  const bag = newBag();
  bagPut(bag, 'a[b]', '1');
  bagPut(bag, 'a[c]', '2');
  bagPut(bag, 'list[]', 'x');
  bagPut(bag, 'list[]', 'y');
  bagPut(bag, 'flat', 'first');
  bagPut(bag, 'flat', 'last');
  bagPut(bag, 'flat[deep]', 'z'); // a scalar in an array's place is replaced
  assert.deepEqual(JSON.parse(JSON.stringify(normalizePhpArrays(bag))), {
    a: { b: '1', c: '2' },
    list: ['x', 'y'],
    flat: { deep: 'z' },
  });
});

test('parsePhpQuery maps dots/spaces in base names and decodes + and %XX', () => {
  const out = parsePhpQuery('a.b=1&a+b=2&msg=hello+world%21&u=%E2%9C%93');
  assert.deepEqual(JSON.parse(JSON.stringify(out)), {
    a_b: '2',
    msg: 'hello world!',
    u: '✓',
  });
});

test('parsePhpQuery keeps list promotion honest for non-sequential integer keys', () => {
  const sparse = parsePhpQuery('c[]=1&c[2]=x&c[]=3');
  assert.deepEqual(JSON.parse(JSON.stringify(sparse)), { c: { 0: '1', 2: 'x', 3: '3' } });
  const sequential = parsePhpQuery('c[]=1&c[]=2');
  assert.deepEqual(JSON.parse(JSON.stringify(sequential)), { c: ['1', '2'] });
});
