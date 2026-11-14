#!/usr/bin/env node
// compiler/tests/rt-url.test.mjs — route()/url() absolute targets.
//
// The ground truth is Laravel 13.37 on PHP 8.3 (a probe against the framework's
// UrlGenerator with a request on http://localhost):
//   url('/')              -> "http://localhost"      (no trailing slash)
//   url('')               -> "http://localhost"
//   url('/masuk')         -> "http://localhost/masuk"
//   url('masuk/')         -> "http://localhost/masuk" (trailing slash trimmed)
//   route('home')         -> "http://localhost"
//   route('profile.index')-> "http://localhost/profil"
// A root route is stored as '' in the build's route map, so the naive
// `origin + '/' + path` answered "http://localhost/" and every link to `/`
// diverged from PHP (found on a real app's dashboard: the nav's home link).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRt } from '../runtime/rt-from-context.mjs';

const ORIGIN = 'http://localhost';
const ROUTE_MAP = {
  home: '/',
  'profile.index': 'profil',
  'posts.show': 'posts/{post}',
  'crud.show': 'crud/{post}',
  'routing.optional': 'routing/optional/{id?}',
  'routing.wild': 'routing/wild/{path?}',
};

const makeRt = () =>
  buildRt({ urls: {} }, { strict: false, runtime: true, origin: ORIGIN, routeMap: ROUTE_MAP });

test('rt-url: route() answers the bare root for `/`, exactly like UrlGenerator::to()', () => {
  const rt = makeRt();
  assert.equal(rt.route('home'), 'http://localhost');
  assert.equal(rt.route('profile.index'), 'http://localhost/profil');
  assert.equal(rt.route('posts.show', 7), 'http://localhost/posts/7');
});

test('rt-url: url() trims the root and the trailing slash', () => {
  const rt = makeRt();
  assert.equal(rt.url('/'), 'http://localhost');
  assert.equal(rt.url('/masuk'), 'http://localhost/masuk');
  assert.equal(rt.url('/masuk/'), 'http://localhost/masuk');
});

test('rt-url: a relative target answers the captured build-time value', () => {
  // Without a leading slash `url()` is a lookup of what the build captured from
  // PHP (the exact string the app answered), never a re-assembly.
  const rt = buildRt({ urls: { '/masuk?x=1': 'http://localhost/masuk?x=1' } }, { strict: false, runtime: true, origin: ORIGIN });
  assert.equal(rt.url('/masuk?x=1'), 'http://localhost/masuk?x=1');
});

// The shapes below are the ones the transpiler emits for Laravel's own idioms
// and the answers are PHP 8.3's (Laravel 13.37), one probe each - the same
// probes docs/EVIDENCE.md finding 1 ran on the live app, where the associative
// form answered /crud/%5Bobject%20Object%5D.

test('rt-url: route() reads an associative array BY NAME and a list positionally', () => {
  const rt = makeRt();
  // what the compiler emits for route('crud.show', ['post' => $id])
  assert.equal(rt.route('crud.show', { post: 1 }), 'http://localhost/crud/1');
  assert.equal(rt.route('crud.show', [1]), 'http://localhost/crud/1');
  assert.equal(rt.route('crud.show', { post: 0 }), 'http://localhost/crud/0');
});

test('rt-url: a map key the URI does not consume becomes the query string, in map order', () => {
  const rt = makeRt();
  assert.equal(rt.route('crud.show', { post: 1, z: '1', utm: '2' }), 'http://localhost/crud/1?z=1&utm=2');
  assert.equal(rt.route('crud.show', { post: 1, q: null }), 'http://localhost/crud/1');
  assert.equal(rt.route('crud.show', { post: 1, b: true, c: false }), 'http://localhost/crud/1?b=1&c=0');
  assert.equal(rt.route('crud.show', { post: 1, f: { a: 'b' } }), 'http://localhost/crud/1?f%5Ba%5D=b');
  assert.equal(rt.route('crud.show', { post: 1, q: '' }), 'http://localhost/crud/1?q=');
  assert.equal(rt.route('crud.show', { post: 1, q: 'a b' }), 'http://localhost/crud/1?q=a%20b');
});

test('rt-url: a required parameter that is absent or null throws what PHP throws', () => {
  const rt = makeRt();
  const want = 'Missing required parameter for [Route: crud.show] [URI: crud/{post}] [Missing parameter: post].';
  const calls = [
    () => rt.route('crud.show'),
    () => rt.route('crud.show', { post: null }),
    () => rt.route('crud.show', [null]),
    () => rt.route('crud.show', { other: 1 }),
  ];
  for (const call of calls) assert.throws(call, (e) => e.message === want);
});

test('rt-url: an absent {x?} drops its segment instead of leaving an empty one', () => {
  const rt = makeRt();
  assert.equal(rt.route('routing.optional'), 'http://localhost/routing/optional');
  assert.equal(rt.route('routing.optional', { id: null }), 'http://localhost/routing/optional');
  assert.equal(rt.route('routing.optional', { id: 5 }), 'http://localhost/routing/optional/5');
});

test('rt-url: a parameter is rawurlencode()d, so %2F survives a wildcard', () => {
  const rt = makeRt();
  assert.equal(rt.route('routing.wild', { path: 'a/b' }), 'http://localhost/routing/wild/a/b');
  assert.equal(rt.route('crud.show', { post: 'a b/c' }), 'http://localhost/crud/a%20b/c');
  assert.equal(rt.route('crud.show', { post: "a!'()*b" }), 'http://localhost/crud/a%21%27%28%29%2Ab');
});

test('rt-url: the third PHP argument (absolute: false) answers a relative URL', () => {
  const rt = makeRt();
  assert.equal(rt.route('crud.show', { post: 1 }, false), '/crud/1');
  assert.equal(rt.route('crud.show', { post: 1 }, true), 'http://localhost/crud/1');
});

test('rt-url: a list with more values than the route has parameters drops the extras (documented gap)', () => {
  // PHP answers /crud/1?2 for route('crud.show', [1, 2]); the compiler never
  // emits the shape (PHP's signature takes one array) and "?2" is unpinned, so
  // this stays a gap rather than a guess - see genUrl's comment.
  const rt = makeRt();
  assert.equal(rt.route('crud.show', [1, 2]), 'http://localhost/crud/1');
});

