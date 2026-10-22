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
  // The query string is PHP's http_build_query (Arr::query()): the booleans
  // become 1/0, an array becomes the bracket form.
  const qs = new LengthAwarePaginator(items, 3, 2, 1, { path: '/posts' });
  qs.appends('flag', true);
  qs.appends('off', false);
  qs.appends('tags', ['a', 'b']);
  assert.equal(qs.url(1), '/posts?flag=1&off=0&tags%5B0%5D=a&tags%5B1%5D=b&page=1');
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

// ---- the serialisation (A84) --------------------------------------------
//
// `response()->json($paginator)`: the paginator IS JsonSerializable
// (LengthAwarePaginator::jsonSerialize() answers toArray(), toArray() answers
// the array below - LengthAwarePaginator.php:206-223). Probed with the
// vendored Laravel 13: `json_encode($paginator)` answers these exact bytes,
// key order included. The edge answered "unsupported value (Function)" (a
// 500) because nothing serialised the paginator.
test('paginator: json_encode() answers Laravel\'s bytes (key order, links, urls)', () => {
  const p = new LengthAwarePaginator(
    [
      { id: 3, title: 'Hello Edge' },
      { id: 2, title: 'Second Post' },
    ],
    3,
    2,
    1,
    { path: 'http://localhost/posts-paginated' }
  );
  assert.equal(
    p.toJson(),
    '{"current_page":1,"data":[{"id":3,"title":"Hello Edge"},{"id":2,"title":"Second Post"}],' +
      '"first_page_url":"http:\\/\\/localhost\\/posts-paginated?page=1","from":1,"last_page":2,' +
      '"last_page_url":"http:\\/\\/localhost\\/posts-paginated?page=2","links":[' +
      '{"url":null,"label":"&laquo; Previous","page":null,"active":false},' +
      '{"url":"http:\\/\\/localhost\\/posts-paginated?page=1","label":"1","page":1,"active":true},' +
      '{"url":"http:\\/\\/localhost\\/posts-paginated?page=2","label":"2","page":2,"active":false},' +
      '{"url":"http:\\/\\/localhost\\/posts-paginated?page=2","label":"Next &raquo;","page":2,"active":false}],' +
      '"next_page_url":"http:\\/\\/localhost\\/posts-paginated?page=2",' +
      '"path":"http:\\/\\/localhost\\/posts-paginated","per_page":2,"prev_page_url":null,"to":2,"total":3}'
  );
});
