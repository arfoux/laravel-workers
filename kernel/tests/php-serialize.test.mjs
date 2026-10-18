// kernel/tests/php-serialize.test.mjs — PHP serialize()/unserialize() parity.
//
// Proves byte-for-byte parity against PHP 8.3 (the oracle runs real
// serialize()/unserialize()) for the session payload subset, in both
// directions:
//   A. phpSerialize(value) === PHP serialize(same value)
//   B. phpSerialize(phpUnserialize(phpString)) === phpString   (PHP → JS → bytes)
//   C. PHP serialize(PHP unserialize(jsString)) === jsString   (JS → PHP → bytes)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phpSerialize, phpUnserialize, PhpSerializeError } from '../php-serialize.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const oraclePath = path.resolve(testsDir, '..', '..', 'tools', 'php-serialize-oracle.php');
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
  ['float -0', -0],
  ['float 0.1', 0.1],
  ['float 1.5', 1.5],
  ['float -2.75', -2.75],
  ['float 4.35', 4.35],
  ['float 2.675', 2.675],
  ['float 1.5e16 plain integral', 1.5e16],
  ['float 1e17 scientific', 1e17],
  ['float 1e20 scientific', 1e20],
  ['float 9.999999999999999e16 rounds to 1e17', 9.999999999999999e16],
  ['float 0.0001 plain small', 0.0001],
  ['float 0.000123 plain small', 0.000123],
  ['float 1e-5 scientific small', 1e-5],
  ['float -1e-5', -1e-5],
  ['float 1e100', 1e100],
  ['float min normal', 2.2250738585072014e-308],
  ['float min subnormal', 5e-324],
  ['float max', 1.7976931348623157e308],
  ['float 0.1+0.2', 0.1 + 0.2],
  ['float 123456789.123456', 123456789.123456],
  ['float 1.2345678901234568e20', 1.2345678901234568e20],
  ['float 9.999999999999999e22', 9.999999999999999e22],
  ['NaN', NaN],
  ['+Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['empty string', ''],
  ['string abc', 'abc'],
  ['string unicode', 'héllo😀'],
  ['string quote', 'a"b'],
  ['string backslash', 'back\\slash'],
  ['string newline', 'nl\n'],
  ['string NUL', '\u0000'],
  ['empty array', []],
  ['list', [1, 2, 3]],
  ['list nested', ['a', { b: [null, true, 2.5] }]],
  ['empty assoc', {}],
  ['assoc', { a: 1 }],
  ['assoc order', { b: 1, a: 2 }],
  ['assoc int-like keys', { 5: 'five', '007': 'x', '-5': 'neg', 0: 'zero' }],
  ['assoc key -0 stays string', { '-0': 'negzero' }],
  ['assoc key +0 stays string', { '+0': 'pluszero' }],
  ['assoc key 00 stays string', { '00': 'zeros' }],
  [
    'session shape',
    { _token: 'abcDEF123', _flash: { old: [], new: ['k'] }, login_web_x: 7 },
  ],
  ['previous url shape', { _previous: { url: 'https://example.com/a?b=1' } }],
];

const j = (v) => JSON.stringify(v);

test('A: phpSerialize matches PHP serialize() byte-for-byte', () => {
  const results = runOracle('encode', { values: PARITY.map(([, v]) => tag(v)) });
  for (let i = 0; i < PARITY.length; i++) {
    const [label, value] = PARITY[i];
    const php = results[i];
    assert.ok(!php.err, `${label}: oracle error ${php.err}`);
    assert.equal(phpSerialize(value), php.out, `encode mismatch: ${label}`);
  }
});

test('B: PHP bytes decode and re-encode back to the same bytes', () => {
  const results = runOracle('encode', { values: PARITY.map(([, v]) => tag(v)) });
  for (let i = 0; i < PARITY.length; i++) {
    const [label] = PARITY[i];
    const php = results[i];
    assert.ok(!php.err, `${label}: oracle error ${php.err}`);
    assert.equal(phpSerialize(phpUnserialize(php.out)), php.out, `round-trip mismatch: ${label}`);
  }
});

test('C: PHP reads our bytes and re-serializes to the same bytes', () => {
  const strings = PARITY.map(([, v]) => phpSerialize(v));
  const results = runOracle('roundtrip', { strings });
  for (let i = 0; i < PARITY.length; i++) {
    const [label] = PARITY[i];
    const php = results[i];
    assert.ok(!php.err, `${label}: oracle error ${php.err}`);
    assert.equal(php.reserialized, strings[i], `php round-trip mismatch: ${label}`);
  }
});

test('float formatting: calibrated against PHP 8.3 strings', () => {
  // JS has no int/float split: 1.0 === 1 encodes as i:1; (documented).
  assert.equal(phpSerialize(1.0), 'i:1;');
  assert.equal(phpSerialize(0.0), 'i:0;');
  assert.equal(phpSerialize(-0), 'd:-0;');
  assert.equal(phpSerialize(1.5e16), 'd:15000000000000000;');
  assert.equal(phpSerialize(1e17), 'd:1.0E+17;');
  assert.equal(phpSerialize(1e20), 'd:1.0E+20;');
  assert.equal(phpSerialize(1.2345678901234568e20), 'd:1.2345678901234568E+20;');
  assert.equal(phpSerialize(0.0001), 'd:0.0001;');
  assert.equal(phpSerialize(1e-5), 'd:1.0E-5;');
  assert.equal(phpSerialize(-1e-5), 'd:-1.0E-5;');
  assert.equal(phpSerialize(5e-324), 'd:5.0E-324;');
  assert.equal(phpSerialize(2.2250738585072014e-308), 'd:2.2250738585072014E-308;');
  assert.equal(phpSerialize(1.7976931348623157e308), 'd:1.7976931348623157E+308;');
  assert.equal(phpSerialize(0.1 + 0.2), 'd:0.30000000000000004;');
  assert.equal(phpSerialize(NaN), 'd:NAN;');
  assert.equal(phpSerialize(Infinity), 'd:INF;');
  assert.equal(phpSerialize(-Infinity), 'd:-INF;');
});

test('string byte lengths count UTF-8 bytes, not code units', () => {
  assert.equal(phpSerialize('héllo😀'), 's:10:"héllo😀";');
  assert.equal(phpSerialize('✓'), 's:3:"✓";');
  assert.equal(phpUnserialize('s:10:"héllo😀";'), 'héllo😀');
});

test('documented normalization: integral doubles decode to int', () => {
  assert.equal(phpUnserialize('d:1;'), 1);
  assert.equal(phpSerialize(phpUnserialize('d:1;')), 'i:1;');
  assert.equal(phpSerialize(1), 'i:1;');
});

test('decode preserves -0 and NaN/INF round-trips', () => {
  assert.ok(Object.is(phpUnserialize('d:-0;'), -0));
  assert.ok(Number.isNaN(phpUnserialize('d:NAN;')));
  assert.equal(phpUnserialize('d:INF;'), Infinity);
  assert.equal(phpUnserialize('d:-INF;'), -Infinity);
});

test('unsupported values fail loud', () => {
  assert.throws(() => phpSerialize(new Date(0)), PhpSerializeError);
  assert.throws(() => phpSerialize(new Map()), PhpSerializeError);
  assert.throws(() => phpSerialize(undefined), PhpSerializeError);
  assert.throws(() => phpSerialize(10n), PhpSerializeError);
  assert.throws(() => phpSerialize({ a: new Set([1]) }), PhpSerializeError);
});

test('documented normalization: integers beyond 2^53 encode as float', () => {
  // JS cannot hold PHP int64 >= 2^53; the double is what it is, so it encodes
  // as the double (matching what a PHP float with that value would produce).
  assert.equal(phpSerialize(9223372036854775807), 'd:9.223372036854776E+18;');
  assert.equal(phpSerialize(1e20), 'd:1.0E+20;');
});

test('unsupported PHP constructs fail loud on decode', () => {
  assert.throws(() => phpUnserialize('O:8:"stdClass":0:{}'), /outside the subset/);
  assert.throws(() => phpUnserialize('C:3:"foo":0:{}'), /outside the subset/);
  assert.throws(() => phpUnserialize('a:1:{i:0;r:1;}'), /references/);
  assert.throws(() => phpUnserialize('a:1:{i:0;R:1;}'), /references/);
  assert.throws(() => phpUnserialize('i:9223372036854775807;'), /safe range/);
  assert.throws(() => phpUnserialize('i:1;trailing'), /trailing/);
  assert.throws(() => phpUnserialize('s:2:"hé";'), /unterminated|expected byte/i);
  assert.throws(() => phpUnserialize('a:2:{i:0;s:1:"a";}'), /unknown type marker|unexpected end|expected/);
  assert.throws(() => phpUnserialize('b:2;'), /invalid bool/);
  assert.throws(() => phpUnserialize(''), /input|unexpected/);
});
