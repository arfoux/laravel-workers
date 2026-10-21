// kernel/tests/paginator.test.mjs — the LengthAwarePaginator (the port).
//
// The values are the ones the real Laravel answered (Laravel 13.37, the
// constructs fixture): the total, the pages, the items and the URLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LengthAwarePaginator, urlWindow } from '../paginator.mjs';

const items = [{ id: 3, title: 'Hello Edge' }, { id: 2, title: 'Second Post' }];

test('paginator: the data (the total, the pages, the items)', () => {
  const p = new LengthAwarePaginator(items, 3, 2, 1, { path: 'http://localhost/posts-paginated' });
  assert.equal(p.total(), 3);
  assert.equal(p.perPage(), 2);
  assert.equal(p.currentPage(), 1);
  assert.equal(p.lastPage(), 2);
  assert.equal(p.count(), 2);
  assert.equal(p.firstItem(), 1);
  assert.equal(p.lastItem(), 2);
  assert.equal(p.isEmpty(), false);
  assert.equal(p.isNotEmpty(), true);
  assert.deepEqual(p.items().map((i) => i.id), [3, 2]);
});

test('paginator: the pages (hasMorePages, onFirstPage, hasPages)', () => {
  const first = new LengthAwarePaginator(items, 3, 2, 1, { path: '/posts' });
  assert.equal(first.hasMorePages(), true);
  assert.equal(first.onFirstPage(), true);
  assert.equal(first.hasPages(), true);
  const last = new LengthAwarePaginator(items, 3, 2, 2, { path: '/posts' });
  assert.equal(last.hasMorePages(), false);
  assert.equal(last.onFirstPage(), false);
  assert.equal(last.onLastPage(), true);
  // An empty page: the items are gone, the first/last item are null.
  const empty = new LengthAwarePaginator([], 0, 2, 1, { path: '/posts' });
  assert.equal(empty.firstItem(), null);
  assert.equal(empty.lastItem(), null);
  assert.equal(empty.isEmpty(), true);
  assert.equal(empty.lastPage(), 1);
});

test('paginator: the URLs (the page, the query string)', () => {
  const p = new LengthAwarePaginator(items, 3, 2, 1, { path: 'http://localhost/posts-paginated' });
  assert.equal(p.url(1), 'http://localhost/posts-paginated?page=1');
  assert.equal(p.url(3), 'http://localhost/posts-paginated?page=3');
  // A page <= 0 is page 1 (Laravel's url()).
  assert.equal(p.url(0), 'http://localhost/posts-paginated?page=1');
  assert.equal(p.previousPageUrl(), null);
  assert.equal(p.nextPageUrl(), 'http://localhost/posts-paginated?page=2');
  // The query string (appends) and the fragment.
  const q = new LengthAwarePaginator(items, 3, 2, 1, { path: '/posts' });
  q.appends('sort', 'title');
  assert.equal(q.url(2), '/posts?sort=title&page=2');
  // Laravel's fragment() takes the fragment WITHOUT the '#' (buildFragment()
  // adds it: `return $this->fragment ? '#'.$this->fragment : '';`).
  q.fragment('list');
  assert.equal(q.url(2), '/posts?sort=title&page=2#list');
  // The RFC3986 encoding (a space is %20, not +).
  const enc = new LengthAwarePaginator(items, 3, 2, 1, { path: '/posts' });
  enc.appends('q', 'a b');
  assert.equal(enc.url(1), '/posts?q=a%20b&page=1');
});

test('paginator: the URL window (the elements the pagination view renders)', () => {
  // 3 pages, 2 per page: the small slider (1..2).
  const p = new LengthAwarePaginator(items, 3, 2, 1, { path: '/posts' });
  assert.deepEqual(p.elements(), [{ 1: '/posts?page=1', 2: '/posts?page=2' }]);
  // 20 pages, 3 on each side: the "Google style" slider.
  const big = new LengthAwarePaginator(items, 60, 2, 10, { path: '/posts' });
  const elements = big.elements();
  assert.equal(elements[0][1], '/posts?page=1');
  assert.equal(elements[0][2], '/posts?page=2');
  assert.equal(elements[1], '...');
  assert.equal(elements[2][7], '/posts?page=7');
  assert.equal(elements[2][13], '/posts?page=13');
  assert.equal(elements[3], '...');
  assert.equal(elements[4][29], '/posts?page=29');
  assert.equal(elements[4][30], '/posts?page=30');
  // The window near the beginning: the first pages + the last two.
  const near = new LengthAwarePaginator(items, 60, 2, 1, { path: '/posts' });
  const nearElements = near.elements();
  assert.equal(Object.keys(nearElements[0]).length, 10);
  assert.equal(nearElements[1], '...');
  assert.deepEqual(Object.keys(nearElements[2]), ['29', '30']);
});

test('paginator: the URL window helper (the slider)', () => {
  const p = new LengthAwarePaginator(items, 3, 2, 1, { path: '/posts' });
  const w = urlWindow(p);
  assert.deepEqual(w.slider, null);
  assert.deepEqual(Object.keys(w.first), ['1', '2']);
});
