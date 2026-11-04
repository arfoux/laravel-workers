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
const ROUTE_MAP = { home: '/', 'profile.index': 'profil', 'posts.show': 'posts/{post}' };

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
