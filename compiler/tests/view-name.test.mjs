// compiler/tests/view-name.test.mjs — direct coverage of the view name ->
// compiled file name mapping. Expected strings mirror tools/compile-view.php's
// $viewFileName: preg_replace('/[^A-Za-z0-9._-]/', '-', $name), leading dots ->
// '_', then '' -> '_'. The module-level collision guard is exercised last, so
// the names used by the earlier assertions stay unique.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewFileName } from '../src/view-name.mjs';

test('viewFileName sanitizes a namespaced pagination view', () => {
  assert.equal(viewFileName('pagination::tailwind'), 'pagination--tailwind');
});

test('viewFileName maps every illegal character to "-" like compile-view.php', () => {
  const cases = [
    ['lt<gt>', 'lt-gt-'],
    ['colon:name', 'colon-name'],
    ['quote"name', 'quote-name'],
    ['slash/name', 'slash-name'],
    ['back\\slash', 'back-slash'],
    ['pipe|name', 'pipe-name'],
    ['q?mark', 'q-mark'],
    ['star*name', 'star-name'],
    ['amp&name', 'amp-name'],
    ['space name', 'space-name'],
    ['tilde~name', 'tilde-name'],
    ['naïve', 'na-ve'],
    ['ctl\x01', 'ctl-'],
    ['ctl2\x1f', 'ctl2-'],
  ];
  for (const [view, expected] of cases) {
    assert.equal(viewFileName(view), expected, JSON.stringify(view));
  }
});

test('viewFileName hides leading dots and uses "_" for an empty name', () => {
  assert.equal(viewFileName('..hidden'), '_hidden');
  assert.equal(viewFileName(''), '_');
  assert.equal(viewFileName(null), '_');
  assert.equal(viewFileName(undefined), '_');
});

test('viewFileName rejects two distinct names that collide case-insensitively', () => {
  assert.equal(viewFileName('Posts.Index'), 'Posts.Index');
  assert.equal(viewFileName('Posts.Index'), 'Posts.Index'); // same name is idempotent
  assert.throws(
    () => viewFileName('posts.index'),
    /two view names sanitize to the same compiled file name "posts\.index" \(case-insensitively\)/
  );
});

test('viewFileName rejects an exact collision after sanitizing', () => {
  assert.equal(viewFileName('alpha/beta'), 'alpha-beta');
  assert.throws(
    () => viewFileName('alpha-beta'),
    /two view names sanitize to the same compiled file name "alpha-beta"/
  );
});
