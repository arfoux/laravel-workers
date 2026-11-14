// tools/tests/snapshot-paths.test.mjs — the names a prerendered page is written under.
//
// The rule decides which files exist on the edge, so these are the cases that put a
// page at a URL: the root, a route, a nested route, an operator-named `static` entry
// in both spellings, and a non-HTML file (which gets no twin - there is no
// `/feed/` spelling of an XML feed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFiles } from '../snapshot-paths.mjs';

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
