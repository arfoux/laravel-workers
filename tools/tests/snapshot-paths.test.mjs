// tools/tests/snapshot-paths.test.mjs — the names a prerendered page is written under.
//
// The rule decides which files exist on the edge, so these are the cases that put a
// page at a URL: the root, a route, a nested route, an operator-named `static` entry
// in both spellings, and a non-HTML file (which gets no twin - there is no
// `/feed/` spelling of an XML feed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFiles, findSnapshotCollisions, assertNoSnapshotCollisions } from '../snapshot-paths.mjs';

test('snapshot-paths: the root is one file', () => {
  assert.deepEqual(snapshotFiles('/'), ['index.html']);
  assert.deepEqual(snapshotFiles(''), ['index.html']);
  assert.deepEqual(snapshotFiles(undefined), ['index.html']);
});

test('snapshot-paths: a route is written for both spellings it is reachable as', () => {
  assert.deepEqual(snapshotFiles('/about'), ['about.html', 'about/index.html']);
  assert.deepEqual(snapshotFiles('about'), ['about.html', 'about/index.html']);
  // Laravel trims the trailing slash, so `/about/` IS `/about`: one page, one set.
  assert.deepEqual(snapshotFiles('/about/'), ['about.html', 'about/index.html']);
  assert.deepEqual(snapshotFiles('/lab/kitchen'), ['lab/kitchen.html', 'lab/kitchen/index.html']);
});

test('snapshot-paths: an operator-named static entry keeps their name and gains its twin', () => {
  assert.deepEqual(snapshotFiles('/docs/guide', 'docs/guide/index.html'), ['docs/guide.html', 'docs/guide/index.html']);
  assert.deepEqual(snapshotFiles('/docs/guide', 'docs/guide.html'), ['docs/guide.html', 'docs/guide/index.html']);
  assert.deepEqual(snapshotFiles('/docs/guide', '/docs/guide.html'), ['docs/guide.html', 'docs/guide/index.html']);
  assert.deepEqual(snapshotFiles('/', 'index.html'), ['index.html']);
});

test('snapshot-paths: a non-HTML file is written exactly as named, with no folder twin', () => {
  assert.deepEqual(snapshotFiles('/feed', 'feed.xml'), ['feed.xml']);
  assert.deepEqual(snapshotFiles('/robots', 'robots.txt'), ['robots.txt']);
});

test('snapshot-paths: every name is relative, unique and non-empty', () => {
  const sets = [snapshotFiles('/'), snapshotFiles('/a/b'), snapshotFiles('/x', 'x/y.html'), snapshotFiles('/', 'index.html')];
  for (const files of sets) {
    assert.equal(new Set(files).size, files.length, `duplicate name in ${files.join(', ')}`);
    for (const file of files) {
      assert.ok(file.length > 0 && !file.startsWith('/') && !file.includes('//'), `bad name ${file}`);
    }
  }
});

test('snapshot-paths: two distinct routes claiming one output file are reported with both claimants', () => {
  const claims = [
    { route: '/a', files: snapshotFiles('/a', 'shared.html'), label: 'static route /a' },
    { route: '/b', files: snapshotFiles('/b', 'shared.html'), label: 'static route /b' },
  ];
  const collisions = findSnapshotCollisions(claims);
  assert.deepEqual(collisions.map((c) => c.file).sort(), ['shared.html', 'shared/index.html']);
  for (const collision of collisions) {
    assert.deepEqual(collision.claimants, ['static route /a', 'static route /b']);
  }
});

test('snapshot-paths: /index and /404 collide with the reserved root and edge 404 writers', () => {
  const collisions = findSnapshotCollisions([
    { route: '/', files: snapshotFiles('/'), label: 'snapshot /' },
    { route: '/index', files: snapshotFiles('/index'), label: 'snapshot /index' },
    { route: '/404', files: snapshotFiles('/404'), label: 'snapshot /404' },
  ]);
  assert.deepEqual(collisions.map((c) => c.file), ['index.html', '404.html']);
  const root = collisions.find((c) => c.file === 'index.html');
  assert.ok(root.claimants.includes('snapshot /index'));
  assert.ok(root.claimants.some((c) => /root route/.test(c)));
  const notFound = collisions.find((c) => c.file === '404.html');
  assert.deepEqual(notFound.claimants, ['snapshot /404', 'the edge 404 page writer']);
});

test('snapshot-paths: an operator-named 404.html is refused too', () => {
  const collisions = findSnapshotCollisions([
    { route: '/oops', files: snapshotFiles('/oops', '404.html'), label: 'static route /oops' },
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].file, '404.html');
  assert.deepEqual(collisions[0].claimants, ['static route /oops', 'the edge 404 page writer']);
});

test('snapshot-paths: the guard throws a message naming both claimants and the file', () => {
  const claims = [
    { route: '/', files: snapshotFiles('/'), label: 'static route /' },
    { route: '/index', files: snapshotFiles('/index'), label: 'static route /index' },
  ];
  assert.throws(
    () => assertNoSnapshotCollisions(claims),
    (err) => {
      assert.match(err.message, /prerender output-file collision/);
      assert.match(err.message, /public\/index\.html/);
      assert.match(err.message, /static route \/index/);
      assert.match(err.message, /root route \(\/\)/);
      return true;
    }
  );
});

test('snapshot-paths: the guard leaves one writer per file alone', () => {
  const claims = [
    { route: '/', files: snapshotFiles('/') },
    { route: '/', files: snapshotFiles('/', 'index.html') },
    { route: '/about', files: snapshotFiles('/about') },
    { route: '/about/', files: snapshotFiles('/about/'), label: 'snapshot /about/' },
    { route: '/docs/guide', files: snapshotFiles('/docs/guide', 'docs/guide/index.html') },
    { route: '/feed', files: snapshotFiles('/feed', 'feed.xml') },
  ];
  assert.deepEqual(findSnapshotCollisions(claims), []);
  assert.doesNotThrow(() => assertNoSnapshotCollisions(claims));
});
