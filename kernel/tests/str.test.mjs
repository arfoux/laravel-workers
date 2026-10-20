// kernel/tests/str.test.mjs - the Str family, verified against the real
// Laravel (the oracle: the fixture app's vendor, PHP 8.3). The expected values
// below are PHP's, not ours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { str, ascii } from '../str.mjs';

test('Str: the values match PHP 8.3 / Laravel 13.37', () => {
  // slug
  assert.equal(str.slug('Hello World'), 'hello-world');
  assert.equal(str.slug('H\u00e9llo W\u00f6rld'), 'hello-world');
  assert.equal(str.slug('A  B--c'), 'a-b-c');
  // limit
  assert.equal(str.limit('Hello World', 5), 'Hello...');
  assert.equal(str.limit('Hello', 10), 'Hello');
  assert.equal(str.limit('Hello World', 5, '...'), 'Hello...');
  // upper / lower
  assert.equal(str.upper('hello'), 'HELLO');
  assert.equal(str.lower('HELLO'), 'hello');
  // studly / camel / snake / kebab / title
  assert.equal(str.studly('hello_world'), 'HelloWorld');
  assert.equal(str.camel('hello_world'), 'helloWorld');
  assert.equal(str.snake('HelloWorld'), 'hello_world');
  assert.equal(str.kebab('HelloWorld'), 'hello-world');
  assert.equal(str.title('hello world'), 'Hello World');
  // contains / startsWith / endsWith (case sensitive)
  assert.equal(str.contains('Hello World', 'world'), false);
  assert.equal(str.contains('Hello World', 'World'), true);
  assert.equal(str.startsWith('Hello World', 'Hello'), true);
  assert.equal(str.endsWith('Hello World', 'World'), true);
  // after / before / length
  assert.equal(str.after('Hello World', 'Hello '), 'World');
  assert.equal(str.before('Hello World', ' World'), 'Hello');
  assert.equal(str.length('Hello World'), 11);
  // replace / replaceFirst / replaceLast
  assert.equal(str.replace('Hello World', 'World', 'Edge'), 'Edge');
  assert.equal(str.replaceFirst('Hello World', 'World', 'Edge'), 'Edge');
  assert.equal(str.replaceLast('Hello World', 'l', 'L'), 'L');
  // squish / ucfirst / ucwords / ascii
  assert.equal(str.squish('  Hello   World  '), 'Hello World');
  assert.equal(str.ucfirst('hello world'), 'Hello world');
  assert.equal(str.ucwords('hello world'), 'Hello World');
  assert.equal(str.ascii('H\u00e9llo W\u00f6rld'), 'Hello World');
});
