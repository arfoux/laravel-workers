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
import { phpJsonEncode } from '../../kernel/php-json.mjs';

const rt = buildRt({}, { strict: false });
test('rt-semantics2: the Carbon stub is JsonSerializable and compares by instant', () => {
  // PHP: json_encode(now()) => "2026-10-30T07:06:17.205115Z" — a JSON STRING
  // (Carbon implements JsonSerializable), never an object; the nested form is
  // the same string. `today()` is the app-timezone midnight, so its wall clock
  // ends in 00:00:00.
  const n = rt.now();
  const json = phpJsonEncode(n);
  assert.match(json, /^"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z"$/);
  assert.equal(phpJsonEncode({ at: n }), '{"at":' + json + '}');
  assert.match(phpJsonEncode(rt.today()), /^"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z"$/);
  assert.match(rt.today().toDateTimeString(), / 00:00:00$/);
  // PHP: $n == $n->toDateTimeString() => true (Carbon's __toString), and two
  // DateTimeInterface values compare BY INSTANT: $n > $n->subHour() => true.
  assert.equal(rt.looseEq(n, n.toString()), true);
  assert.equal(rt.gt(n, n.subHours(1)), true);
  assert.equal(rt.gte(n, n), true);
  assert.equal(rt.lt(n.subDays(1), n), true);
  assert.equal(rt.gt(n, n.addDays(1)), false);
});

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
  // PHP: '1.5' == '1.50' => true (the same number).
  assert.equal(rt.looseEq('1.5', '1.50'), true);
});

test('rt-semantics2: a negative string offset answers the last character (PHP 7.1+)', () => {
  // PHP: $s = 'abc'; echo $s[-1]; => c
  const src =
    '<?php\nnamespace App\\Http\\Controllers;\nclass C {\n    public function demo()\n    {\n' +
    "        $s = 'abc';\n        echo $s[-1];\n" +
    '\n        return response("ok");\n    }\n}\n';
  const res = emitController(src, 'demo', { routeUri: '/x', routeParams: [], models: [], views: [] });
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(res.code, /rt\.strOffset\(/);
  // The runtime helper: the character from the end.
  const rt2 = buildRt({}, { strict: false });
  assert.equal(rt2.strOffset('abc', -1), 'c');
  assert.equal(rt2.strOffset('abc', -3), 'a');
  assert.equal(rt2.strOffset('abc', 0), 'a');
});

test('rt-semantics2: rt.Arr.except matches Arr.php (Laravel 11.34 reference)', () => {
  // Arr::except($array, $keys) = forget() on a value, then return it
  // (vendor/…/Arr.php:150). forget() answers an EXACT key first, then walks the
  // dot path — and because PHP passes arrays by value, the caller's array must
  // never change.
  const data = { __data: 1, __path: 2, keep: 'x', nested: { a: 1, b: 2 } };
  const out = rt.Arr.except(data, ['__data', '__path']);
  assert.deepEqual(out, { keep: 'x', nested: { a: 1, b: 2 } });
  assert.deepEqual(data, { __data: 1, __path: 2, keep: 'x', nested: { a: 1, b: 2 } }, 'the caller keeps its keys');

  // Dot path: gone from the copy, caller's nested array untouched.
  const dot = rt.Arr.except({ nested: { a: 1, b: 2 }, keep: 1 }, ['nested.a']);
  assert.deepEqual(dot, { nested: { b: 2 }, keep: 1 });
  assert.deepEqual(data.nested, { a: 1, b: 2 });

  // A literal top-level key named 'a.b' beats the dot path (Arr::forget order).
  assert.deepEqual(rt.Arr.except({ 'a.b': 1, a: { b: 2 } }, ['a.b']), { a: { b: 2 } });

  // Integer keys: unset keeps later positions — still an ARRAY, with a hole
  // (PHP: $a=[10,20,30]; unset($a[1]); => keys 0 and 2 stay put).
  const intKeyed = rt.Arr.except([10, 20, 30], [1]);
  assert.ok(Array.isArray(intKeyed), 'still an array');
  assert.equal(1 in intKeyed, false, 'the unset key is gone');
  assert.equal(intKeyed[0], 10);
  assert.equal(intKeyed[2], 30);

  // The exact Blade call shape that made this helper necessary.
  const vars = { __data: 'd', __path: 'p', posts: [] };
  assert.deepEqual(rt.Arr.except(vars, ['__data', '__path']), { posts: [] });
});

test('rt-semantics2: === on arrays is by VALUE, on objects by IDENTITY', () => {
  // PHP 8.3 (probed): `[1,2] === [1,2]` is TRUE - two arrays are identical
  // when they hold the same pairs in the same order with identical values.
  // JS compares array/object references, so the compiled `===` answered false.
  assert.equal(rt.strictEq([1, 2], [1, 2]), true);
  assert.equal(rt.strictEq({ a: 1 }, { a: 1 }), true);
  assert.equal(rt.strictEq([[1], [2]], [[1], [2]]), true);
  assert.equal(rt.strictEq([1, 2], [2, 1]), false);
  assert.equal(rt.strictEq([], [1]), false);
  // A list and the same pairs as an int-keyed assoc array are the same array.
  assert.equal(rt.strictEq([1, 2], { 0: 1, 1: 2 }), true);
  assert.equal(rt.strictEq(1, '1'), false);
  // A `(object)` value is a stdClass: `==` compares the properties, `===` is
  // identity, and an array never equals an object.
  const o1 = rt.objectCast({ a: 1 });
  const o2 = rt.objectCast({ a: 1 });
  assert.equal(rt.strictEq({ a: 1 }, o1), false);
  assert.equal(rt.looseEq({ a: 1 }, o1), false);
  assert.equal(rt.looseEq(o1, o2), true);
  assert.equal(rt.strictEq(o1, o2), false);
  assert.equal(rt.strictEq(o1, o1), true);
  assert.equal(rt.looseEq(null, o1), false);
  // in_array(..., true) uses the same identity rule for objects.
  assert.equal(rt.in_array(o1, [o2], true), false);
  assert.equal(rt.in_array(o1, [o1], true), true);
});

test('rt-semantics2: a stdClass is an OBJECT, an assoc array is an ARRAY', () => {
  // PHP 8.3 (probed): is_array((object)[]) is false, is_object(['a'=>1]) is
  // false, is_array(['a'=>1]) is true, and an OBJECT is always truthy while an
  // empty assoc ARRAY is falsy.
  const o = rt.objectCast({ a: 1 });
  assert.equal(rt.is_array(rt.objectCast([])), false);
  assert.equal(rt.is_array({ a: 1 }), true);
  assert.equal(rt.is_array([1]), true);
  assert.equal(rt.is_object({ a: 1 }), false);
  assert.equal(rt.is_object([1]), false);
  assert.equal(rt.is_object(o), true);
  assert.equal(rt.is_countable(rt.objectCast([])), false);
  assert.equal(rt.is_countable({ a: 1 }), true);
  assert.equal(rt.truthy(rt.objectCast([])), true);
  assert.equal(rt.truthy([]), false);
  assert.equal(rt.truthy({ a: 1 }), true);
  // The relational table: an array is greater than a scalar, an object greater
  // than both (PHP 8).
  assert.equal(rt.gt([1, 2], 1), true);
  assert.equal(rt.lt([], 1), false);
  assert.equal(rt.gt(o, []), true);
  assert.equal(rt.lt(o, []), false);
});

test('rt-semantics2: PHP string/array conversions of a stdClass and an array', () => {
  // 'x' . ['a'=>1] answers 'xArray' (PHP warns "Array to string conversion");
  // 'x' . (object)[] raises Error("Object of class stdClass could not be
  // converted to string") in PHP 8.
  assert.equal(rt.concat('x', { a: 1 }), 'xArray');
  assert.equal(rt.concat('x', []), 'xArray');
  assert.equal(rt.str({ a: 1 }), 'Array');
  assert.throws(() => rt.concat('x', rt.objectCast({})), /could not be converted to string/);
  assert.throws(() => rt.strval(rt.objectCast({})), /could not be converted to string/);
  // PHP's own TypeError wording for the array functions.
  const o = rt.objectCast({ a: 1 });
  assert.throws(() => rt.count(o), /count\(\): Argument #1 \(\$value\) must be of type Countable\|array, stdClass given/);
  assert.throws(() => rt.array_keys(o), /array_keys\(\): Argument #1 \(\$array\) must be of type array, stdClass given/);
  assert.throws(() => rt.array_key_exists('a', o), /array_key_exists\(\): Argument #2/);
  assert.throws(() => rt.implode(',', o), /implode\(\): Argument #2 \(\$array\) must be of type \?array, stdClass given/);
  assert.throws(() => rt.array_values(o), /array_values\(\): Argument #1/);
  // implode() converts each value through the string cast: a nested array is
  // 'Array', true is '1' and null is '' (probed on PHP 8.3).
  assert.equal(rt.implode(',', [[1, 2], [3]]), 'Array,Array');
  assert.equal(rt.implode(',', [null, true, 1.5, 'x']), ',1,1.5,x');
  assert.throws(() => rt.implode(',', [rt.objectCast({})]), /could not be converted to string/);
  // The plain array cases still answer.
  assert.equal(rt.count({ a: 1 }), 1);
  assert.deepEqual(rt.array_keys({ a: 1 }), ['a']);
});

test('rt-semantics2: array_sum casts each value the way PHP does', () => {
  // PHP: array_sum([[1]]) is 0 (a nested array contributes 0 - it is not cast
  // to a number), array_sum(['a'=>1,'b'=>[2]]) is 1, and
  // array_sum([true,'3x',null]) is 4.
  assert.equal(rt.array_sum([[1]]), 0);
  assert.equal(rt.array_sum({ a: 1, b: [2] }), 1);
  assert.equal(rt.array_sum([true, '3x', null]), 4);
  assert.equal(rt.array_sum([1.5, 2]), 3.5);
});
