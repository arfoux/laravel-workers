import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeToPatterns, buildRoutesJson } from '../../tools/routes-json.mjs';

// Cloudflare accepts at most ONE `*` per rule and only as its LAST character
// (an invalid rule makes the platform ignore the WHOLE `_routes.json`, so every
// request reaches the Worker). Every pattern this module emits must obey that.
const assertPlatformValid = (patterns) => {
  for (const p of patterns) {
    assert.match(p, /^\//, `a rule starts with "/": ${p}`);
    const stars = (p.match(/\*/g) || []).length;
    assert.ok(stars <= 1, `at most one "*" per rule: ${p}`);
    if (stars === 1) assert.ok(p.endsWith('*'), `the "*" must be the last character: ${p}`);
    assert.ok(p.length <= 100, `a rule stays under 100 characters: ${p}`);
  }
};

test('routeToPatterns maps static, dynamic, optional and catch-all segments', () => {
  assert.deepEqual(routeToPatterns('/'), ['/']);
  assert.deepEqual(routeToPatterns('about'), ['/about']);
  // A static multi-segment route keeps its exact path.
  assert.deepEqual(routeToPatterns('about/team/contact'), ['/about/team/contact']);
  assert.deepEqual(routeToPatterns('/storage/{path}'), ['/storage/*']);
  // `/users/*/posts/*` would be an INVALID rule (two wildcards) and would make
  // Cloudflare drop the whole file: the pattern is the single-wildcard prefix.
  assert.deepEqual(routeToPatterns('/users/{user}/posts/{post}'), ['/users/*']);
  assert.deepEqual(routeToPatterns('/files/{path*}'), ['/files/*']);
  // A variable need not fill the segment: the rule keeps the literal text
  // before it, so the real request path is inside the rule. The old code emitted
  // the literal rule `/enc-suffix-{id}`, which no request path ever matches —
  // Cloudflare then served the route from static assets (404) and the Worker
  // never ran.
  assert.deepEqual(routeToPatterns('/enc-suffix-{id}'), ['/enc-suffix-*']);
  assert.deepEqual(routeToPatterns('/a/{id}-{slug}'), ['/a/*']);
  // A variable in a segment that is not the last one cannot be spelled (one
  // trailing `*`, no mid-rule wildcard): the rule widens to the literal text
  // before it, which still contains every real path of the route.
  assert.deepEqual(routeToPatterns('/a{id}/b'), ['/a*']);
  assert.deepEqual(routeToPatterns('/{id}b'), ['/*']);
});

test('routeToPatterns covers an optional segment at any position', () => {
  // `/posts` is a path of its own (the segment may be absent) and `/posts/x`
  // needs the wildcard — Laravel 13's router answers both.
  assert.deepEqual(routeToPatterns('/posts/{page?}'), ['/posts', '/posts/*']);
  // A MEDIAN optional: `/a/b/d` (absent) and `/a/b/x/d` (present). The old code
  // answered only `/a/b/*/d`, so `/a/b/d` was served from static assets (404).
  assert.deepEqual(routeToPatterns('/a/b/{c?}/d'), ['/a/b', '/a/b/*']);
  // `/{any?}` answers `/` and `/x`.
  assert.deepEqual(routeToPatterns('/{any?}'), ['/', '/*']);
  // Many optionals do not explode into 2^N rules.
  for (let n = 1; n <= 9; n++) {
    const uri = '/' + Array.from({ length: n }, (_, i) => '{a' + i + '?}').join('/');
    assert.ok(routeToPatterns(uri).length <= 3, `optional route ${uri} stays minimal`);
  }
});

test('routeToPatterns obeys the Cloudflare rule shape', () => {
  for (const uri of [
    '/',
    'about',
    '/a/b/c',
    '/storage/{path}',
    '/users/{user}/posts/{post}',
    '/posts/{page?}',
    '/files/{path*}',
    '/{any?}',
    '/a/b/{c?}/d',
    '/t/{a?}/b/{c?}',
    '/x/{a}/{b}/{c}/{d}/{e}',
  ]) {
    assertPlatformValid(routeToPatterns(uri));
  }
});

test('buildRoutesJson includes only dynamic routes (+ extras) and excludes asset dirs', () => {
  const table = [
    { uri: '/', kind: 'snapshot' },
    { uri: '/about', kind: 'view' },
    { uri: '/api/posts/{id}', kind: 'port' },
    { uri: '/ignored', kind: 'ignore' },
  ];
  const out = buildRoutesJson(table, { publicDirs: ['build'], extraInclude: ['/health'] });
  assert.equal(out.version, 1);
  assert.deepEqual(out.include, ['/about', '/api/posts/*', '/health']);
  assert.deepEqual(out.exclude, ['/build/*']);
  assertPlatformValid([...(out.include || []), ...(out.exclude || [])]);
});

test('buildRoutesJson omits empty sections and enforces the Cloudflare limits', () => {
  const out = buildRoutesJson([], {});
  assert.deepEqual(out, { version: 1 });
  // 101 rules in ONE list is over the cap.
  const many = Array.from({ length: 101 }, (_, i) => ({ uri: '/r' + i, kind: 'view' }));
  assert.throws(() => buildRoutesJson(many, {}), /rules combined/);
  // The cap is COMBINED: 60 include + 60 exclude is 120 and Cloudflare refuses
  // the file (it used to pass the build and then be ignored in production).
  const sixty = Array.from({ length: 60 }, (_, i) => ({ uri: '/r' + i, kind: 'view' }));
  const dirs = Array.from({ length: 60 }, (_, i) => 'd' + i);
  assert.throws(() => buildRoutesJson(sixty, { publicDirs: dirs }), /rules combined/);
});
