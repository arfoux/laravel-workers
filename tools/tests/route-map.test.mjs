#!/usr/bin/env node
// tools/tests/route-map.test.mjs — the runtime `route()` table carries EVERY name
// a path has, across all verbs.
//
// Found on a real app (lw-showcase): `Route::get('/login')->name('login')` plus
// `Route::post('/login')->name('login.store')`, and a compiled Blade view calling
// `route('login.store')`. The route scan is deduped PER PATH and the old builder
// took only the first named verb's name, so `login.store` never reached the
// runtime table. `route('login.store')` then fell through to the build-time URL
// map, whose value is root-relative (the dev origin is stripped), and the page
// emitted `action="/login"` where PHP emitted `action="http://host/login"` — a
// byte divergence the shadow harness caught on the login form.
//
// App-free on purpose: this is a pure function over the scan output, so it runs in
// the app-less `test` job (a build-level fixture would only run where an app is).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteMap } from '../route-map.mjs';

// The lw-showcase login pair, plus a unique-path POST name and a param route.
const routes = ['/login', '/logout', '/posts/{post}'];
const methodsFor = new Map([
  ['/login', new Set(['GET', 'POST'])],
  ['/logout', new Set(['POST'])],
  ['/posts/{post}', new Set(['GET'])],
]);
const metaFor = new Map([
  ['GET /login', { name: 'login' }],
  ['POST /login', { name: 'login.store' }],
  ['POST /logout', { name: 'logout' }],
  ['GET /posts/{post}', { name: 'posts.show' }],
]);

test('route-map: a path carrying two names contributes BOTH, across verbs', () => {
  const map = buildRouteMap(routes, methodsFor, metaFor);
  assert.equal(map.login, 'login');
  assert.equal(map['login.store'], 'login');
  assert.equal(map.logout, 'logout');
  assert.equal(map['posts.show'], 'posts/{post}');
});

test('route-map: values drop the leading slash so the runtime can prefix the origin', () => {
  const map = buildRouteMap(['/login'], new Map([['/login', new Set(['POST'])]]), new Map([
    ['POST /login', { name: 'login.store' }],
  ]));
  assert.equal(map['login.store'], 'login');
});

test('route-map: an unnamed verb contributes nothing and a repeated name is not clobbered', () => {
  const map = buildRouteMap(['/x'], new Map([['/x', new Set(['GET', 'POST'])]]), new Map([
    ['GET /x', {}], // unnamed: skipped
    ['POST /x', { name: 'x.store' }],
  ]));
  assert.deepEqual(map, { 'x.store': 'x' });

  const dup = buildRouteMap(['/y'], new Map([['/y', new Set(['GET', 'POST'])]]), new Map([
    ['GET /y', { name: 'y' }],
    ['POST /y', { name: 'y' }], // same name on both verbs: first spelling wins
  ]));
  assert.deepEqual(dup, { y: 'y' });
});
