#!/usr/bin/env node
// compiler/tests/rt-str.test.mjs — standalone probe for str_* helpers (str_starts_with/str_ends_with/str_is).
// Run: node --test compiler/tests/rt-str.test.mjs (it IS part of `npm test`, which enumerates this file
// explicitly — as plain `node` it drives the same assertions through the file's own bottom block).
import assert from 'node:assert/strict';
import { buildRt } from '../runtime/rt-from-context.mjs';

const rt = buildRt({}, { strict: false });

// str_starts_with — basic
assert.equal(rt.str_starts_with('foobar', 'foo'), true);
assert.equal(rt.str_starts_with('foobar', 'bar'), false);
assert.equal(rt.str_starts_with('foobar', ''), true);
assert.equal(rt.str_starts_with('', 'foo'), false);
assert.equal(rt.str_starts_with('', ''), true);
// caseInsensitive
assert.equal(rt.str_starts_with('Foobar', 'foo', true), true);
assert.equal(rt.str_starts_with('Foobar', 'foo', false), false);
assert.equal(rt.str_starts_with('Foobar', 'FOO', true), true);

// str_ends_with — basic
assert.equal(rt.str_ends_with('foobar', 'bar'), true);
assert.equal(rt.str_ends_with('foobar', 'foo'), false);
assert.equal(rt.str_ends_with('foobar', ''), true);
assert.equal(rt.str_ends_with('', ''), true);
// caseInsensitive
assert.equal(rt.str_ends_with('foobar', 'BAR', true), true);
assert.equal(rt.str_ends_with('foobar', 'BAR', false), false);

// str_contains already existed — also test ci path
assert.equal(rt.str_contains('foobar', 'ooba'), true);
assert.equal(rt.str_contains('Foobar', 'OOBA', true), true);
assert.equal(rt.str_contains('Foobar', 'OOBA', false), false);

// str_is — Laravel Str::is with * wildcard, case-sensitive
assert.equal(rt.str_is('foo*', 'foobar'), true);
assert.equal(rt.str_is('foo*', 'barfoo'), false);
assert.equal(rt.str_is('*oo*', 'foobar'), true);
assert.equal(rt.str_is('*oo*', 'bar'), false);
assert.equal(rt.str_is('*', 'anything'), true);
assert.equal(rt.str_is('foo', 'foo'), true);
assert.equal(rt.str_is('foo', 'Foo'), false); // case-sensitive
assert.equal(rt.str_is('*.php', 'index.php'), true);
assert.equal(rt.str_is('*.php', 'index.PHP'), false);
assert.equal(rt.str_is('a*b*c', 'axbxc'), true);
assert.equal(rt.str_is('a*b*c', 'axc'), false);
// regex specials are literal, not regex
assert.equal(rt.str_is('foo.bar', 'foo.bar'), true);
assert.equal(rt.str_is('foo.bar', 'fooXbar'), false);
// Str::is ignoreCase (Laravel 11 third argument) + array patterns
assert.equal(rt.str_is('FOO/*', 'foo/bar'), false);
assert.equal(rt.str_is('FOO/*', 'foo/bar', true), true);
assert.equal(rt.str_is(['a*', 'b*'], 'bar'), true);
// Str::finish / Str::start — oracle: illuminate/support Str.php:496, :1511
import { is as strIs, finish, start, random } from '../../kernel/str.mjs';
assert.equal(strIs('foo/*', 'foo/bar'), true);
assert.equal(finish('abbc', 'c'), 'abbc');
assert.equal(finish('ab', 'bc'), 'abbc');
assert.equal(finish('abbcbc', 'bc'), 'abbc');
assert.equal(finish('abcbbc', 'bc'), 'abcbbc');
assert.equal(finish('abc', ''), 'abc');
assert.equal(start('abbc', 'a'), 'abbc');
assert.equal(start('bc', 'ab'), 'abbc');
assert.equal(start('aabbc', 'a'), 'abbc');
assert.equal(start('abc', ''), 'abc');
// A compiled `Str::x()` is emitted as `rt.Str.x()` (compiler/src/transpiler.mjs):
// probe the DISPATCH and the answer, not the allowlist's membership in itself.
const strDispatch = [
  ['is', ['foo/*', 'foo/bar'], true],
  ['finish', ['ab', 'bc'], 'abbc'],
  ['start', ['bc', 'ab'], 'abbc'],
  ['isUrl', ['https://example.com'], true],
  ['isUuid', ['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 4], true],
];
for (const [name, args, expected] of strDispatch) {
  assert.equal(typeof rt.Str[name], 'function', `rt.Str.${name} must be callable (Str::${name} dispatch)`);
  assert.equal(rt.Str[name](...args), expected, `rt.Str.${name}() must answer the Laravel value`);
}
assert.equal(typeof rt.Str.random, 'function', 'rt.Str.random must be callable (Str::random dispatch)');
const dispatchedRandom = rt.Str.random(24);
assert.equal(dispatchedRandom.length, 24);
assert.match(dispatchedRandom, /^[A-Za-z0-9]{24}$/);
assert.equal(random(40).length, 40);
assert.match(random(40), /^[A-Za-z0-9]{40}$/);
assert.equal(random(0), '');
// Str::isUrl — the Symfony UrlValidator pattern (oracle: Str::isUrl on PHP 8.3)
assert.equal(rt.Str.isUrl('ftp://example.com/file'), true);
assert.equal(rt.Str.isUrl('wss://example.com/socket'), true);
assert.equal(rt.Str.isUrl('example.com'), false);
assert.equal(rt.Str.isUrl('mailto:a@b.c'), false);
// PCRE's `$` (no /D) also matches before a trailing newline, and Laravel compiles the
// pattern with `i` - so a trailing `\n` is a url and the scheme is case-insensitive.
assert.equal(rt.Str.isUrl('http://x.co\n'), true);
assert.equal(rt.Str.isUrl('http://x.co '), false);
assert.equal(rt.Str.isUrl('HTTP://X.CO'), true);
assert.equal(rt.Str.isUrl('http://[::1]/x'), true);
// a custom protocol list replaces Laravel's (Str::isUrl($v, ['ftp']))
assert.equal(rt.Str.isUrl('ftp://x.co', ['ftp']), true);
assert.equal(rt.Str.isUrl('http://x.co', ['ftp']), false);
// Str::isUuid — oracle: Str::isUuid on PHP 8.3 (the canonical form with ANY
// hex in the last two groups when no version is given; ramsey parses the value
// and a version must be an INT whose nibble matches).
const v4u = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
assert.equal(rt.Str.isUuid(v4u), true);
assert.equal(rt.Str.isUuid('018f0c1e-6b1a-7c3d-8e4f-9a0b1c2d3e4f'), true); // v7
assert.equal(rt.Str.isUuid('ffffffff-ffff-ffff-ffff-ffffffffffff'), true);
assert.equal(rt.Str.isUuid('a0eebc99-9c0b-4ef8-0b6d-6bb9bd380a11'), true); // variant 0, no version
assert.equal(rt.Str.isUuid('a0eebc999c0b4ef8bb6d6bb9bd380a11'), false); // no dashes
assert.equal(rt.Str.isUuid(v4u, 4), true);
assert.equal(rt.Str.isUuid('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', 4), true);
assert.equal(rt.Str.isUuid('a0eebc999c0b4ef8bb6d6bb9bd380a11', 4), true); // ramsey reads the 32-char form
assert.equal(rt.Str.isUuid('a0eebc99-9c0b-4ef8-0b6d-6bb9bd380a11', 4), false); // variant outside [89ab]
assert.equal(rt.Str.isUuid(v4u, '4'), false); // a string version never matches an int nibble
assert.equal(rt.Str.isUuid(v4u, 1), false);
assert.equal(rt.Str.isUuid(v4u, 'nil'), false);
assert.equal(rt.Str.isUuid('00000000-0000-0000-0000-000000000000', 'nil'), true);
assert.equal(rt.Str.isUuid('00000000-0000-0000-0000-000000000000', 0), true);
assert.equal(rt.Str.isUuid('ffffffff-ffff-ffff-ffff-ffffffffffff', 'max'), true);
assert.equal(rt.Str.isUuid(v4u, 15), false);
// Arr — the surface the sample apps call (oracle: Arr::* on Laravel 13.37)
import { arr as arrHelpers } from '../../kernel/arr.mjs';
assert.equal(rt.Arr, arrHelpers);
const ad = { user: { name: 'Ada', roles: ['admin', 'dev'] }, id: 7 };
assert.equal(rt.Arr.get(ad, 'user.name'), 'Ada');
assert.equal(rt.Arr.get(ad, 'user.age', 'def'), 'def');
assert.equal(rt.Arr.has(ad, ['user.name', 'id']), true);
assert.equal(rt.Arr.has(ad, 'user.age'), false);
assert.deepEqual(rt.Arr.only({ id: 1, name: 2, x: 3 }, ['id', 'x']), { id: 1, x: 3 });
assert.equal(rt.Arr.first([10, 20, 30], (v) => v > 15), 20);
assert.equal(rt.Arr.last([10, 20, 30], (v) => v < 25), 20);
assert.deepEqual(rt.Arr.wrap('x'), ['x']);
assert.deepEqual(rt.Arr.wrap(null), []);
assert.deepEqual({ ...rt.Arr.dot({ a: { b: 1, c: { d: 2 } }, e: 3 }) }, { 'a.b': 1, 'a.c.d': 2, e: 3 });
// A compiled `Arr::x()` is emitted as `rt.Arr.x()`: call each named method
// through the runtime facade with a known input and check the value returned.
const arrDispatch = [
  ['dot', [{ a: { b: 1 } }], { 'a.b': 1 }],
  ['wrap', ['x'], ['x']],
  ['first', [[10, 20, 30]], 10],
  ['last', [[10, 20, 30]], 30],
  ['get', [ad, 'id'], 7],
  ['only', [{ id: 1, name: 2 }, ['id']], { id: 1 }],
  ['has', [ad, 'user.name'], true],
];
for (const [name, args, expected] of arrDispatch) {
  assert.equal(typeof rt.Arr[name], 'function', `rt.Arr.${name} must be callable (Arr::${name} dispatch)`);
  assert.deepEqual(rt.Arr[name](...args), expected, `rt.Arr.${name}() must answer the Laravel value`);
}

// strtolower/strtoupper/mb_strtolower/mb_strtoupper cast with PHP's (string)
// rules BEFORE case-folding (oracle PHP 8.3.30: null->'', false->'', true->'1',
// 0->'0', 1.5->'1.5'). String() answered 'null'/'false'/'true' - the #6 divergence.
assert.equal(rt.strtolower(null), '');
assert.equal(rt.strtolower(false), '');
assert.equal(rt.strtolower(true), '1');
assert.equal(rt.strtolower(0), '0');
assert.equal(rt.strtolower(1.5), '1.5');
assert.equal(rt.strtolower('ABC'), 'abc');
assert.equal(rt.strtoupper(null), '');
assert.equal(rt.strtoupper(false), '');
assert.equal(rt.strtoupper(true), '1');
assert.equal(rt.strtoupper('abc'), 'ABC');
assert.equal(rt.mb_strtolower(null), '');
assert.equal(rt.mb_strtolower(false), '');
assert.equal(rt.mb_strtolower(true), '1');
assert.equal(rt.mb_strtoupper(null), '');
assert.equal(rt.mb_strtoupper(true), '1');

console.log('rt-str: PASS');
