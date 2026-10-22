// kernel/tests/collections.test.mjs — Laravel's Collection at the edge.
//
// Ground truth: the vendored Laravel 13 (`Illuminate/Collections/Collection.php`,
// `EnumeratesValues.php`), probed with PHP 8.3. Every expected value below is
// PHP's own answer, quoted from the probe in the comment above the assertion.
//
// What the edge keeps: `items` is a real JS ARRAY (the runtime iterates it with
// `.slice()` / `.length` / `.map()`), and a KEYED collection (groupBy, keyBy,
// pluck($value, $key), chunk) carries its PHP keys in a separate non-enumerable
// `keys` list, so `all()`/`toArray()` answer the keyed OBJECT Laravel answers
// while the iteration still sees a list.
//
// What the edge does NOT do: the higher-order proxy (`->sum->price()`), the
// lazy collections, the macros. A method Laravel does not have does not exist
// here — calling it is a TypeError, never a plausible answer.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Collection } from '../collections.mjs';

const collect = (items) => new Collection(items);

test('the array surface: all/toArray/count/isEmpty/first/last/get/has', () => {
  // A probe: all() = [1,2], count() = 2, first() = 1, last() = 2.
  assert.deepEqual(collect([1, 2]).all(), [1, 2]);
  assert.equal(collect([1, 2]).count(), 2);
  assert.equal(collect([1, 2]).first(), 1);
  assert.equal(collect([1, 2]).last(), 2);
  assert.equal(collect([]).isEmpty(), true);
  assert.equal(collect([1]).isNotEmpty(), true);
  // first(callback) answers the first MATCH (a probe: 2 for `> 1`).
  assert.equal(collect([1, 2, 3]).first((v) => v > 1), 2);
  // get() with a fallback (a probe: 'def').
  assert.equal(collect({ a: 1 }).get('b', 'def'), 'def');
  assert.equal(collect({ a: 1 }).has('a'), true);
});

test('map/filter/reject/each answer Laravel values', () => {
  // A probe: map(*2) = [2,4]; filter() drops 0, null and '' = [1,2];
  // reject(> 1) = [1].
  assert.deepEqual(collect([1, 2]).map((v) => v * 2).all(), [2, 4]);
  assert.deepEqual(collect([0, 1, null, 2, '']).filter().values().all(), [1, 2]);
  assert.deepEqual(collect([1, 2, 3]).reject((v) => v > 1).values().all(), [1]);
});

test('sortBy/sortByDesc/sum/avg/max/min', () => {
  // A probe: sortBy = [1,2,3], sortByDesc = [3,2,1], sum = 6, avg = 2,
  // max = 9, min = 3.
  assert.deepEqual(collect([3, 1, 2]).sortBy((v) => v).values().all(), [1, 2, 3]);
  assert.deepEqual(collect([3, 1, 2]).sortByDesc((v) => v).values().all(), [3, 2, 1]);
  assert.equal(collect([1, 2, 3]).sum(), 6);
  assert.equal(collect([1, 2, 3]).avg(), 2);
  assert.equal(collect([1, 9, 3]).max(), 9);
  assert.equal(collect([4, 9, 3]).min(), 3);
  // sum with a key (a probe: 5 for [{v:2},{v:3}]).
  assert.equal(collect([{ v: 2 }, { v: 3 }]).sum('v'), 5);
});

test('groupBy and keyBy answer KEYED arrays (Laravel\'s own shape)', () => {
  // A probe: groupBy('t') on [a:1, b:2, a:3] answers
  // {"a":[{"t":"a","v":1},{"t":"a","v":3}],"b":[{"t":"b","v":2}]}
  assert.deepEqual(collect([{ t: 'a', v: 1 }, { t: 'b', v: 2 }, { t: 'a', v: 3 }]).groupBy('t').toArray(), {
    a: [{ t: 'a', v: 1 }, { t: 'a', v: 3 }],
    b: [{ t: 'b', v: 2 }],
  });
  // A probe: keyBy('id') answers {"1":{...},"2":{...}}.
  assert.deepEqual(collect([{ id: 1, n: 'a' }, { id: 2, n: 'b' }]).keyBy('id').toArray(), {
    1: { id: 1, n: 'a' },
    2: { id: 2, n: 'b' },
  });
  // The keys are the PHP keys (a probe: ['a','b']).
  assert.deepEqual(collect([{ t: 'a' }, { t: 'b' }]).groupBy('t').keys().all(), ['a', 'b']);
});

test('pluck answers values, or a keyed array with the second argument', () => {
  // A probe: pluck('n') = ["a","b"]; pluck('n','id') = {"1":"a"}.
  assert.deepEqual(collect([{ id: 1, n: 'a' }, { id: 2, n: 'b' }]).pluck('n').all(), ['a', 'b']);
  assert.deepEqual(collect([{ id: 1, n: 'a' }]).pluck('n', 'id').toArray(), { 1: 'a' });
});

test('implode takes ($value, $glue) like Laravel, not (glue, key)', () => {
  // A probe: `->implode('n', '-')` answers "a-b". The edge's old signature
  // read the first argument as the glue and answered "n".
  assert.equal(collect([{ n: 'a' }, { n: 'b' }]).implode('n', '-'), 'a-b');
  // A list: the single argument is the glue (a probe: "1,2").
  assert.equal(collect([1, 2]).implode(','), '1,2');
});

test('chunk keeps PHP\'s keys in the last chunk', () => {
  // A probe: collect([1,2,3,4,5])->chunk(2)->toArray() answers
  // [[1,2],{"2":3,"3":4},{"4":5}] - array_chunk() preserves the keys.
  assert.deepEqual(collect([1, 2, 3, 4, 5]).chunk(2).toArray(), [
    [1, 2],
    { 2: 3, 3: 4 },
    { 4: 5 },
  ]);
});

test('where/whereIn/whereNotNull/unique/flatten/merge/slice', () => {
  // Probes: where('v','>',4) = [{v:5},{v:9}]; whereIn('v',[5]) = [{v:5}];
  // whereNotNull('v') = [{v:1}]; unique = [1,2,3]; flatten = [1,2,3,4];
  // merge([3]) = [1,2,3]; slice(1,2) = [2,3]; take(2) = [1,2];
  // reverse = [3,2,1]; contains(2) = true; every(even) = true.
  const rows = [{ v: 1 }, { v: 5 }, { v: 9 }];
  assert.deepEqual(collect(rows).where('v', '>', 4).values().all(), [{ v: 5 }, { v: 9 }]);
  assert.deepEqual(collect([{ v: 1 }, { v: 5 }]).whereIn('v', [5]).values().all(), [{ v: 5 }]);
  assert.deepEqual(collect([{ v: 1 }, { v: null }]).whereNotNull('v').values().all(), [{ v: 1 }]);
  assert.deepEqual(collect([1, 1, 2, 3, 3]).unique().values().all(), [1, 2, 3]);
  assert.deepEqual(collect([1, [2, [3, 4]]]).flatten().all(), [1, 2, 3, 4]);
  assert.deepEqual(collect([1, 2]).merge([3]).all(), [1, 2, 3]);
  assert.deepEqual(collect([1, 2, 3, 4]).slice(1, 2).values().all(), [2, 3]);
  assert.deepEqual(collect([1, 2, 3, 4]).take(2).values().all(), [1, 2]);
  assert.deepEqual(collect([1, 2, 3]).reverse().values().all(), [3, 2, 1]);
  assert.equal(collect([1, 2]).contains(2), true);
  assert.equal(collect([2, 4]).every((v) => v % 2 === 0), true);
});

test('when/unless/whenEmpty/tap/pipe answer the callback\'s value', () => {
  // A probe: whenEmpty(fn => 'empty') answers 'empty' on an empty collection.
  assert.equal(collect([]).whenEmpty(() => 'empty'), 'empty');
  assert.deepEqual(collect([1]).when(true, (c) => c.push(2)).all(), [1, 2]);
  assert.deepEqual(collect([1]).when(false, (c) => c.push(2)).all(), [1]);
  assert.deepEqual(collect([1]).unless(false, (c) => c.push(2)).all(), [1, 2]);
  assert.deepEqual(collect([1]).tap((c) => c.push(9)).all(), [1, 9]);
  assert.equal(collect([1, 2]).pipe((c) => c.count()), 2);
});

test('a method Laravel does not have does not exist', () => {
  // No silent plausible answer: an unknown method is a TypeError.
  assert.equal(typeof collect([1]).summ, 'undefined');
  assert.throws(() => collect([1]).summ(), TypeError);
});
