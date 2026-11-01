// kernel/tests/php-json-ordered.test.mjs — PHP json_decode($s, true) parity.
//
// Proves kernel/php-json-ordered.mjs reproduces PHP 8.3's DECODE, not just its
// values: INSERTION ORDER (non-enumerable `__lwOrder`), BYTE-STRING values
// (latin1, so `"\u00ff"` is the two bytes 0xc3 0xbf), 64-bit integer precision
// (BigInt, or a loud LW006), and NULL on invalid UTF-8 - all compared against a
// live PHP oracle (tools/php-json-decode-oracle.php).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phpJsonDecodeOrdered, lwNotRepresentable } from '../php-json-ordered.mjs';
import { bytesFromByteString } from '../php-bytes.mjs';
import { phpArrayKey } from '../php-loose-eq.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const oraclePath = path.resolve(testsDir, '..', '..', 'tools', 'php-json-decode-oracle.php');
const PHP = process.env.PHP_BIN || 'php';

const hexOf = (bs) => [...bytesFromByteString(bs)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Mirror of tools/php-json-decode-oracle.php::lw_dump(). */
function dump(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'bool(true)' : 'bool(false)';
  if (typeof v === 'bigint') return 'num(' + v.toString() + ')';
  if (typeof v === 'number') return 'num(' + String(v) + ')';
  if (typeof v === 'string') return 'str:' + hexOf(v);
  if (Array.isArray(v)) {
    return (
      'array[' +
      v.map((item, i) => 'int(' + i + ')=>' + dump(item)).join(',') +
      ']'
    );
  }
  if (typeof v === 'object') {
    const order = Array.isArray(v.__lwOrder) ? v.__lwOrder : Object.keys(v);
    return (
      'array[' +
      order
        .map((key) => {
          const k = phpArrayKey(key);
          const kk = typeof k === 'number' ? 'int(' + k + ')' : 'str:' + hexOf(k);
          return kk + '=>' + dump(v[key]);
        })
        .join(',') +
      ']'
    );
  }
  return 'other';
}

function runOracle(docs) {
  const res = spawnSync(PHP, [oraclePath], {
    input: JSON.stringify({ cases: docs.map((d) => Buffer.from(d, 'latin1').toString('base64')) }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(
      `PHP oracle failed to start (${res.error.message}). Install PHP 8.3 or set PHP_BIN.`
    );
  }
  if (res.status !== 0) throw new Error(`PHP oracle exited ${res.status}: ${res.stderr}`);
  return res.stdout.replace(/\n$/, '').split('\n');
}

// The documents are given as raw BYTES (the wire truth), never as JS text.
const CASES = [
  ['{"a":1,"b":2,"2":"x","c":null}', {}],
  ['{"-1":"m","0":"n"}', {}],
  ['{"01":"z"}', {}],
  ['9223372036854775807', { bigint: true }],
  ['1.0', {}],
  ['1e3', {}],
  ['0.5', {}],
  ['"\\u00ff"', {}],
  ['"\\u00e9\\ud83d\\ude00"', {}],
  ['"\\u0000\\u001f"', {}],
  ['[1,2,3]', {}],
  ['{"nested":{"z":1,"a":2}}', {}],
  ['{"a":{"b":[{"c":1}]}}', {}],
  ['  {"spaced" : 1 } ', {}],
  ['{"a":1,}', {}], // trailing comma -> NULL
  ['true', {}],
  ['null', {}],
];

test('phpJsonDecodeOrdered matches json_decode($s, true) byte-for-byte', () => {
  const docs = CASES.map(([d]) => d);
  const expected = runOracle(docs);
  CASES.forEach(([doc, opts], i) => {
    const got = dump(phpJsonDecodeOrdered(Buffer.from(doc, 'latin1'), opts));
    assert.equal(got, expected[i], `case ${i}: ${doc}`);
  });
});

test('invalid UTF-8 in the document answers NULL, like PHP', () => {
  const expected = runOracle([Buffer.from([0x22, 0xff, 0x22]).toString('latin1')]);
  const got = dump(phpJsonDecodeOrdered(new Uint8Array([0x22, 0xff, 0x22])));
  assert.equal(got, expected[0]);
  assert.equal(got, 'NULL');
});

test('order marker is non-enumerable and carries document order', () => {
  const v = phpJsonDecodeOrdered('{"a":1,"b":2,"2":"x","c":null}');
  assert.deepEqual(Object.keys(v), ['2', 'a', 'b', 'c']); // JS enumeration is wrong...
  assert.deepEqual(v.__lwOrder, ['a', 'b', '2', 'c']); // ...the marker has PHP's order
  assert.equal(Object.prototype.propertyIsEnumerable.call(v, '__lwOrder'), false);
});

test('string values are latin1 byte-strings (PHP bytes, not JS code points)', () => {
  const v = phpJsonDecodeOrdered('"\\u00ff"');
  assert.equal(v.length, 2); // two UTF-8 bytes
  assert.equal(hexOf(v), 'c3bf');
});

test('an out-of-safe-range integer fails loud by default, exact with bigint', () => {
  assert.throws(() => phpJsonDecodeOrdered('9223372036854775807'), (e) => e.code === 'LW006');
  assert.equal(phpJsonDecodeOrdered('9223372036854775807', { bigint: true }), 9223372036854775807n);
  assert.ok(lwNotRepresentable('x').code === 'LW006');
});

// TEXT mode is the wired path: the kernel's wire convention is JS text, so the
// reader's ONLY additions over `JSON.parse` are PHP's key ORDER and its integer
// rule. Values must stay indistinguishable from `JSON.parse`'s.
test('text mode: PHP key order with JSON.parse-equal values', () => {
  const json = '{"b":1,"2":"x","a":2,"c":[1,{"z":0,"9":1}]}';
  const out = phpJsonDecodeOrdered(json, { text: true });
  // PHP: json_decode($json, true) walks ["b","2","a","c"] - a JS object does not.
  assert.deepEqual(out.__lwOrder, ['b', '2', 'a', 'c']);
  assert.deepEqual(out.c[1].__lwOrder, ['z', '9']);
  assert.deepEqual({ ...out, c: out.c.map((v) => (typeof v === 'object' ? { ...v } : v)) }, JSON.parse(json));
});

test('text mode: escapes, raw non-ASCII and lone surrogates stay JS text', () => {
  // JSON.parse parity: `\u00e9` is ONE code unit, the raw character is copied,
  // a surrogate pair is the two-unit character and a LONE surrogate survives.
  assert.equal(phpJsonDecodeOrdered('{"a":"\\u00e9"}', { text: true }).a, '\u00e9');
  assert.equal(phpJsonDecodeOrdered('{"a":"é"}', { text: true }).a, 'é');
  assert.equal(phpJsonDecodeOrdered('{"a":"\\ud83d\\ude00"}', { text: true }).a, '😀');
  assert.equal(phpJsonDecodeOrdered('{"a":"\\ud800"}', { text: true }).a, '\ud800');
  // Raw invalid UTF-8 BYTES are NULL, exactly like PHP (JSON.parse accepts them).
  const badBytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  assert.equal(phpJsonDecodeOrdered(badBytes, { text: true }), null);
});

test('text mode: only a LOSSY 64-bit integer fails loud', () => {
  // A double that carries the literal exactly keeps PHP's bytes: PHP prints
  // 10000000000000000 / 1152921504606846976 and so does our number.
  assert.equal(phpJsonDecodeOrdered('10000000000000000', { text: true }), 10000000000000000);
  assert.equal(phpJsonDecodeOrdered('1152921504606846976', { text: true }), 1152921504606846976);
  // 9223372036854775807 has no exact double - PHP holds it, so we stop loudly.
  assert.throws(() => phpJsonDecodeOrdered('9223372036854775807', { text: true }), (e) => e.code === 'LW006');
  assert.equal(
    phpJsonDecodeOrdered('9223372036854775807', { text: true, bigint: true }).toString(),
    '9223372036854775807'
  );
  // Beyond int64 PHP itself overflows to float, so the number is PHP's answer.
  assert.equal(phpJsonDecodeOrdered('99999999999999999999', { text: true }), 1e20);
});

test('text mode: PHP depth rule counts an EMPTY container', () => {
  // PHP 8.3: json_decode('[]', true, 1) is NULL while json_decode('1', true, 1) is 1.
  assert.equal(phpJsonDecodeOrdered('[]', { text: true, depth: 1 }), null);
  assert.equal(phpJsonDecodeOrdered('1', { text: true, depth: 1 }), 1);
  assert.deepEqual(phpJsonDecodeOrdered('[]', { text: true, depth: 2 }), []);
  assert.equal(phpJsonDecodeOrdered('{"a":{}}', { text: true, depth: 2 }), null);
});
