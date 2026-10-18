#!/usr/bin/env node
// compiler/tests/rt-str.test.mjs — standalone probe for str_* helpers (str_starts_with/str_ends_with/str_is).
// Run: node compiler/tests/rt-str.test.mjs
// Not wired into package.json test enumerator (intentional — see task notes). Use `node --test` directly or run standalone.
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

console.log('rt-str: PASS (' + 30 + ' assertions)');
