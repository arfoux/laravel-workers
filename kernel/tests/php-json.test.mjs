// kernel/tests/php-json.test.mjs — PHP json_encode() parity.
//
// Proves byte-for-byte parity against PHP 8.3 (default flags,
// serialize_precision=-1) for the session payload subset, in both directions:
//   A. phpJsonEncode(value) === PHP json_encode(same value)
//   B. phpJsonEncode(JSON.parse(phpString)) === phpString   (PHP → JS → bytes)
//   C. PHP json_encode(json_decode(jsString, true)) === jsString  (JS → PHP → bytes)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phpJsonEncode, phpJsonDecode, PhpJsonError } from '../php-json.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const oraclePath = path.resolve(testsDir, '..', '..', 'tools', 'php-json-oracle.php');
const PHP = process.env.PHP_BIN || 'php';

function runOracle(mode, payload) {
  const res = spawnSync(PHP, [oraclePath], {
    input: JSON.stringify({ mode, ...payload }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(
      `PHP oracle failed to start (${res.error.message}). Install PHP 8.3 or set PHP_BIN.`
    );
  }
  if (res.status !== 0) {
    throw new Error(`PHP oracle exited ${res.status}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout).results;
}

function tag(v) {
  if (v === null) return { t: 'n' };
  if (typeof v === 'boolean') return { t: 'b', v };
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { t: 'd', v: 'NAN' };
    if (v === Infinity) return { t: 'd', v: 'INF' };
    if (v === -Infinity) return { t: 'd', v: '-INF' };
    if (Object.is(v, -0)) return { t: 'd', v: '-0' };
    if (Number.isInteger(v) && Number.isSafeInteger(v)) return { t: 'i', v: String(v) };
    return { t: 'd', v: String(v) };
  }
  if (typeof v === 'string') return { t: 's', v };
  if (Array.isArray(v)) return { t: 'a', v: v.map(tag) };
  return { t: 'a', v: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tag(x)])) };
}

const PARITY = [
  ['null', null],
  ['true', true],
  ['false', false],
  ['int 0', 0],
  ['int 1', 1],
  ['int -1', -1],
  ['int max-safe', 9007199254740991],
  ['int min-safe', -9007199254740991],
  ['float 0.5', 0.5],
  ['float 2.5', 2.5],
  ['float 0.1', 0.1],
  ['float 0.1+0.2', 0.1 + 0.2],
  ['float third', 1 / 3],
  ['float 123.456', 123.456],
  ['float 1e6 plain', 1e6],
  ['float 1e15 plain', 1e15],
  ['float 1e16 plain', 1e16],
  ['float 1.5e16 plain', 1.5e16],
  ['float 9.9e16 plain', 9.9e16],
  ['float 1e17 scientific', 1e17],
  ['float 1e18 scientific', 1e18],
  ['float 1e20 scientific', 1e20],
  ['float 1e21 scientific', 1e21],
  ['float 1e-4 plain', 1e-4],
  ['float 1e-5 scientific', 1e-5],
  ['float 1e-6 scientific', 1e-6],
  ['float 1e-7 scientific', 1e-7],
  ['float min subnormal', 5e-324],
  ['float min normal', 2.2250738585072014e-308],
  ['float max', 1.7976931348623157e308],
  ['float 1.2345678901234567e-17', 1.2345678901234567e-17],
  ['empty string', ''],
  ['string abc', 'abc'],
  ['string quote', 'a"b'],
  ['string backslash', 'a\\b'],
  ['string slash', 'a/b'],
  ['string newline', 'a\nb'],
  ['string cr', 'a\rb'],
  ['string tab', 'a\tb'],
  ['string backspace', 'a\x08b'],
  ['string formfeed', 'a\x0cb'],
  ['string vertical tab', 'a\x0bb'],
  ['string NUL', 'a\x00b'],
  ['string ctrl 01', '\x01'],
  ['string ctrl 1f', '\x1f'],
  ['string DEL raw', 'a\x7fb'],
  ['string nbsp', 'a\u00a0b'],
  ['string e acute', 'é'],
  ['string emoji', '😀'],
  ['string u2028 u2029', '\u2028\u2029'],
  ['string html', '<>&'],
  ['string single quote', "a'b"],
  ['string json-ish', '{"data":"x","expires":1}'],
  ['string percent', 'a%20b'],
  ['empty array', []],
  ['list', [1, 2, 3]],
  ['list nested', ['a', { b: [null, true, 2.5] }]],
  ['empty assoc', {}],
  ['assoc', { a: 1 }],
  ['assoc order', { b: 1, a: 2 }],
  ['assoc int-like keys', { 5: 'five', '007': 'x', '-5': 'neg', 0: 'zero' }],
  ['key -0', { '-0': 'negzero' }],
  ['key +0', { '+0': 'pluszero' }],
  ['key 00', { '00': 'zeros' }],
  ['key beyond int64', { '9223372036854775808': 'over' }],
  ['key with slash and unicode', { 'a/b': 1, 'é': 2, '😀': 3 }],
  [
    'session shape',
    {
      _token: 'AbC123xyz',
      _previous: { url: 'http://localhost/__probe/session', route: null },
      _flash: { old: [], new: [] },
      counter: 3,
      items: ['a', 'b'],
      flags: { on: true, off: false },
    },
  ],
  ['previous url shape', { _previous: { url: 'https://example.com/a?b=1' } }],
];

test('A: phpJsonEncode matches PHP json_encode() byte-for-byte', () => {
  const results = runOracle('encode', { values: PARITY.map(([, v]) => tag(v)) });
  for (let i = 0; i < PARITY.length; i++) {
    const [label, value] = PARITY[i];
    const php = results[i];
    assert.ok(!php.err, `${label}: oracle error ${php.err}`);
    assert.equal(phpJsonEncode(value), php.out, `encode mismatch: ${label}`);
  }
});

test('B: PHP bytes decode and re-encode back to the same bytes', () => {
  const results = runOracle('encode', { values: PARITY.map(([, v]) => tag(v)) });
  for (let i = 0; i < PARITY.length; i++) {
    const [label] = PARITY[i];
    const php = results[i];
    assert.ok(!php.err, `${label}: oracle error ${php.err}`);
    assert.equal(
      phpJsonEncode(phpJsonDecode(php.out)),
      php.out,
      `round-trip mismatch: ${label}`
    );
  }
});

test('C: PHP reads our bytes and re-serializes to the same bytes', () => {
  const strings = PARITY.map(([, v]) => phpJsonEncode(v));
  const results = runOracle('roundtrip', { strings });
  for (let i = 0; i < PARITY.length; i++) {
    const [label] = PARITY[i];
    const php = results[i];
    assert.ok(!php.err, `${label}: oracle error ${php.err}`);
    assert.equal(php.reencoded, strings[i], `php round-trip mismatch: ${label}`);
  }
});

test('calibrated formatting matches PHP 8.3 exactly', () => {
  // Integral doubles print without a fraction under default json_encode flags.
  assert.equal(phpJsonEncode(1.0), '1');
  assert.equal(phpJsonEncode(12.0), '12');
  assert.equal(phpJsonEncode(-0), '-0');
  assert.equal(phpJsonEncode(1.5e16), '15000000000000000');
  assert.equal(phpJsonEncode(1e17), '1.0e+17');
  assert.equal(phpJsonEncode(1e20), '1.0e+20');
  assert.equal(phpJsonEncode(1e-4), '0.0001');
  assert.equal(phpJsonEncode(1e-5), '1.0e-5');
  assert.equal(phpJsonEncode(5e-324), '5.0e-324');
  assert.equal(phpJsonEncode(1.7976931348623157e308), '1.7976931348623157e+308');
  assert.equal(phpJsonEncode(1 / 3), '0.3333333333333333');
  assert.equal(phpJsonEncode('a/b'), '"a\\/b"');
  assert.equal(phpJsonEncode('é'), '"\\u00e9"');
  assert.equal(phpJsonEncode('😀'), '"\\ud83d\\ude00"');
  assert.equal(phpJsonEncode('\u2028'), '"\\u2028"');
  assert.equal(phpJsonEncode('a\x00b'), '"a\\u0000b"');
  assert.equal(phpJsonEncode('a\x7fb'), '"a\x7fb"');
  assert.equal(phpJsonEncode('a\x08b'), '"a\\bb"');
});

test('session cookie envelope payload re-encodes byte-for-byte', () => {
  const attrs = {
    _token: 'AbC123xyz',
    _previous: { url: 'http://localhost/__probe/session', route: null },
    _flash: { old: [], new: [] },
    counter: 3,
    items: ['a', 'b'],
    flags: { on: true, off: false },
  };
  const data = phpJsonEncode(attrs);
  assert.equal(
    data,
    '{"_token":"AbC123xyz","_previous":{"url":"http:\\/\\/localhost\\/__probe\\/session","route":null},"_flash":{"old":[],"new":[]},"counter":3,"items":["a","b"],"flags":{"on":true,"off":false}}'
  );
  const envelope = phpJsonEncode({ data, expires: 1792337099 });
  const escapedData = data
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\//g, '\\/');
  assert.equal(envelope, '{"data":"' + escapedData + '","expires":1792337099}');
  assert.equal(JSON.parse(envelope).data, data);
});

test('NAN/INF fail loud like PHP json_encode returns false', () => {
  const results = runOracle('encode', { values: [{ t: 'd', v: 'NAN' }, { t: 'd', v: 'INF' }] });
  assert.match(results[0].err, /NaN cannot be JSON encoded/);
  assert.match(results[1].err, /NaN cannot be JSON encoded/);
  assert.throws(() => phpJsonEncode(NaN), PhpJsonError);
  assert.throws(() => phpJsonEncode(Infinity), PhpJsonError);
  assert.throws(() => phpJsonEncode(-Infinity), PhpJsonError);
});

test('unsupported values fail loud', () => {
  assert.throws(() => phpJsonEncode(undefined), PhpJsonError);
  assert.throws(() => phpJsonEncode(10n), PhpJsonError);
  assert.throws(() => phpJsonEncode(new Date(0)), PhpJsonError);
  assert.throws(() => phpJsonEncode({ a: new Set([1]) }), PhpJsonError);
  assert.throws(() => phpJsonEncode('\ud800'), PhpJsonError);
  assert.throws(() => phpJsonEncode('\udc00'), PhpJsonError);
});

test('documented normalization: integers beyond 2^53 encode as the double', () => {
  assert.equal(phpJsonEncode(9223372036854775807), '"9.223372036854776e+18"'.slice(1, -1));
});

test('documented divergence: PHP json_decode loses -0 on decode', () => {
  // PHP's encoder emits -0 for float -0.0, but its decoder maps the JSON
  // token -0 back to int 0 (PHP is not round-trip stable here). JSON.parse
  // keeps -0; the encode direction still matches PHP byte-for-byte.
  assert.equal(phpJsonEncode(-0), '-0');
  const results = runOracle('roundtrip', { strings: ['[-0]'] });
  assert.ok(!results[0].err, results[0].err);
  assert.equal(results[0].reencoded, '[0]');
  assert.ok(Object.is(phpJsonDecode('[-0]')[0], -0));
});

test('phpJsonDecode reads PHP-produced payloads', () => {
  assert.deepEqual(phpJsonDecode('{"a":[1,2],"b":{"c":null}}'), { a: [1, 2], b: { c: null } });
  assert.deepEqual(phpJsonDecode('[]'), []);
});
