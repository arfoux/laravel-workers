// tools/tests/inflect.test.mjs — Str::singular()/Str::plural() against the PHP
// oracle (Laravel 13.37 + doctrine/inflector 2.x).
//
// The fixture is a dump of the real Pluralizer over ~180 words x {word, word+s,
// UPPER, Capitalized}; every entry must match byte for byte, which is what
// `Route::resource()` relies on for its wildcard names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { singular, plural } from '../inflect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const oracle = JSON.parse(readFileSync(join(here, 'fixtures', 'inflect-oracle.json'), 'utf8'));

test('inflect: singular matches the PHP oracle for every fixture word', () => {
  const bad = [];
  for (const [word, expected] of Object.entries(oracle.singular)) {
    const got = singular(word);
    if (got !== expected) bad.push(`${JSON.stringify(word)}: php=${JSON.stringify(expected)} js=${JSON.stringify(got)}`);
  }
  assert.deepEqual(bad, []);
});

test('inflect: plural matches the PHP oracle for every fixture word', () => {
  const bad = [];
  for (const [word, expected] of Object.entries(oracle.plural)) {
    const got = plural(word);
    if (got !== expected) bad.push(`${JSON.stringify(word)}: php=${JSON.stringify(expected)} js=${JSON.stringify(got)}`);
  }
  assert.deepEqual(bad, []);
});

test('inflect: the resource-wildcard cases and the count guard', () => {
  // Route::resource('people', ...) -> /people/{person}
  assert.equal(singular('people'), 'person');
  assert.equal(singular('categories'), 'category');
  assert.equal(singular('children'), 'child');
  // `plural($v, 1)` answers the word unchanged (Pluralizer::plural()).
  assert.equal(plural('post', 1), 'post');
  assert.equal(plural('post', 0), 'posts');
  // An uncountable word stays put.
  assert.equal(plural('related'), 'related');
  assert.equal(singular('series'), 'series');
  // A word that does not end in a word character is left alone.
  assert.equal(plural('post!'), 'post!');
});
