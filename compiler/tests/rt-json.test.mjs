#!/usr/bin/env node
// compiler/tests/rt-json.test.mjs — the JSON bytes are PHP's.
//
// Laravel's json_encode() escapes the slashes ("a\/b") and the non-ASCII as
// \uXXXX (the surrogate pairs too). A plain JSON.stringify answers a
// different body - a silent divergence on every JSON response with a URL or
// a non-ASCII character. The expectations come from PHP 8.3 itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRt } from '../runtime/rt-from-context.mjs';
import * as CollectionModule from '../../kernel/collections.mjs';
import { phpJsonEncode } from '../../kernel/php-json.mjs';

const rt = buildRt({}, { strict: false });

test('rt-json: the response helper writes PHP json_encode bytes', () => {
  // PHP: json_encode("a/b") => "a\/b"
  const slash = rt.json('a/b');
  assert.equal(slash.status, 200);
  assert.equal(slash.headers['content-type'], 'application/json');
  assert.equal(slash.body, '"a\\/b"');
  // PHP: json_encode("héllo") => "h\u00e9llo"
  assert.equal(rt.json('héllo').body, '"h\\u00e9llo"');
  // PHP: json_encode("a😀b") => "a\ud83d\ude00b"
  assert.equal(rt.json('a😀b').body, '"a\\ud83d\\ude00b"');
  // PHP: json_encode(["a" => 1, "b" => "x/y"]) => {"a":1,"b":"x\/y"}
  assert.equal(rt.json({ a: 1, b: 'x/y' }).body, '{"a":1,"b":"x\\/y"}');
  // PHP: json_encode(["a/b" => 1]) => {"a\/b":1} (the key too)
  assert.equal(rt.json({ 'a/b': 1 }).body, '{"a\\/b":1}');
});

test('rt-json: the numbers and the shapes are PHP\'s', () => {
  // PHP: json_encode(1.0) => 1 ; json_encode(1.5) => 1.5 ; 0.1+0.2 => 0.30000000000000004
  assert.equal(rt.json(1.0).body, '1');
  assert.equal(rt.json(1.5).body, '1.5');
  assert.equal(rt.json(0.1 + 0.2).body, '0.30000000000000004');
  assert.equal(rt.json(42).body, '42');
  // PHP: json_encode([]) => [] ; json_encode(null) => null. But a RESPONSE is
  // Symfony's JsonResponse, whose ctor does `$data ??= new \ArrayObject()`
  // (JsonResponse.php:47): `response()->json(null)` answers "{}" (probed), and
  // `response()->json()` answers the `$data = []` default, "[]".
  assert.equal(rt.json([]).body, '[]');
  assert.equal(rt.json(null).body, '{}');
  assert.equal(rt.json().body, '[]');
  // PHP's json_encode() RECURSES into an array: a Collection or a model nested
  // in an assoc array is serialised too (probed:
  // response()->json(['data' => collect([['id'=>1,'n'=>'a']]), 'n' => 2])
  // answers {"data":[{"id":1,"n":"a"}],"n":2}). Without the recursion the
  // encoder threw "unsupported value (Collection)" - a 500 on the most common
  // JSON shape there is.
  const { Collection } = CollectionModule;
  assert.equal(
    rt.json({ data: new Collection([{ id: 1, n: 'a' }]), n: 2 }).body,
    '{"data":[{"id":1,"n":"a"}],"n":2}'
  );
  // json_encode(null) stays "null" (only the JsonResponse wrapper turns a null
  // body into "{}").
  assert.equal(phpJsonEncode(null), 'null');
  assert.equal(rt.json({ a: null }).body, '{"a":null}');
});

test('rt-json: json_encode() writes the same bytes', () => {
  assert.equal(rt.json_encode('a/b'), '"a\\/b"');
  assert.equal(rt.json_encode('héllo'), '"h\\u00e9llo"');
  assert.equal(rt.json_encode({ a: 1, b: 'x/y' }), '{"a":1,"b":"x\\/y"}');
  assert.equal(rt.json_encode(null), 'null');
});

test('rt-json: json_decode() answers PHP, not a thrown SyntaxError', () => {
  // PHP 8.3 (probed): invalid JSON answers NULL (a warning, no exception), and
  // JSON_THROW_ON_ERROR turns it into JsonException("Syntax error"). The old
  // one-liner let `JSON.parse` throw, so a controller reading a form field
  // (`json_decode($request->input('payload'))`) answered 500 where Laravel
  // answered null - `''` (an empty field) included.
  assert.equal(rt.json_decode('{bad'), null);
  assert.equal(rt.json_decode('bad'), null);
  assert.equal(rt.json_decode(''), null);
  assert.equal(rt.json_decode(null), null);
  assert.equal(rt.json_decode('null'), null);
  assert.deepEqual(rt.json_decode('{"a":1}'), { a: 1 });
  assert.deepEqual(rt.json_decode('[1,2]'), [1, 2]);
  assert.deepEqual(rt.json_decode('{"a":{"b":[1,2]}}'), { a: { b: [1, 2] } });
  assert.equal(rt.json_decode('5'), 5);
  assert.equal(rt.json_decode('1.0'), 1);
  assert.equal(rt.json_decode('true'), true);
  assert.throws(
    () => rt.json_decode('{bad', true, 512, 4194304),
    (e) => e.name === 'JsonException' && /Syntax error/.test(e.message)
  );
});
test('rt-json: json_decode() honours the depth budget like PHP', () => {
  // PHP 8.3 (probed): a container costs a level, so `json_decode('[1]', true, 1)`
  // is NULL and `json_decode('[]', true, 1)` is NULL too, while a scalar needs
  // none (`'1'` with depth 1 answers 1) and `{"a":{"b":1}}` needs 3.
  assert.equal(rt.json_decode('[1]', true, 1), null);
  assert.equal(rt.json_decode('[]', true, 1), null);
  assert.deepEqual(rt.json_decode('[1]', true, 2), [1]);
  assert.equal(rt.json_decode('1', true, 1), 1);
  assert.equal(rt.json_decode('{"a":1}', true, 1), null);
  assert.deepEqual(rt.json_decode('{"a":1}', true, 2), { a: 1 });
  assert.equal(rt.json_decode('{"a":{"b":1}}', true, 2), null);
  assert.deepEqual(rt.json_decode('{"a":{"b":1}}', true, 3), { a: { b: 1 } });
  // depth <= 0 is a ValueError in PHP, whatever the input.
  assert.throws(
    () => rt.json_decode('1', true, 0),
    (e) => e.name === 'ValueError' && /\$depth\) must be greater than 0/.test(e.message)
  );
  // The throw-on-error flag reports the exceeded depth instead of null.
  assert.throws(
    () => rt.json_decode('[[1]]', true, 2, 4194304),
    (e) => e.name === 'JsonException' && /Maximum stack depth exceeded/.test(e.message)
  );
});
