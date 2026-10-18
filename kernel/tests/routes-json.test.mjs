import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeToPatterns, buildRoutesJson } from '../../tools/routes-json.mjs';

test('routeToPatterns maps static, required, optional and catch-all segments', () => {
  assert.deepEqual(routeToPatterns('/'), ['/']);
  assert.deepEqual(routeToPatterns('about'), ['/about']);
  assert.deepEqual(routeToPatterns('/storage/{path}'), ['/storage/*']);
  assert.deepEqual(routeToPatterns('/users/{user}/posts/{post}'), ['/users/*/posts/*']);
  assert.deepEqual(routeToPatterns('/posts/{page?}'), ['/posts', '/posts/*']);
  assert.deepEqual(routeToPatterns('/files/{path*}'), ['/files/*']);
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
});

test('buildRoutesJson omits empty sections and enforces Cloudflare limits', () => {
  const out = buildRoutesJson([], {});
  assert.deepEqual(out, { version: 1 });
  const many = Array.from({ length: 101 }, (_, i) => ({ uri: '/r' + i, kind: 'view' }));
  assert.throws(() => buildRoutesJson(many, {}), /exceeds Cloudflare limit/);
});
