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
test('firstOrFail answers the first item, or fails loud when none matches', () => {
  // Probes: collect([1,2])->firstOrFail() = 1; firstOrFail(fn ($v) => $v > 1) = 2;
  // collect([0,1])->firstOrFail(fn ($v) => $v === 0) = 0 (a falsy hit IS a hit);
  // collect([null])->firstOrFail() = null (a null hit is a hit);
  // collect(['x'=>1])->firstOrFail() = 1;
  // collect([['name'=>'a'],['name'=>'b']])->firstOrFail('name', 'b') = {"name":"b"};
  // ->firstOrFail('name', '=', 'a') = {"name":"a"}; ->firstOrFail('n', '!=', 1) = {"n":2}.
  assert.equal(collect([1, 2]).firstOrFail(), 1);
  assert.equal(collect([1, 2, 3]).firstOrFail((v) => v > 1), 2);
  assert.equal(collect([0, 1]).firstOrFail((v) => v === 0), 0);
  assert.equal(collect([null]).firstOrFail(), null);
  assert.equal(collect({ x: 1 }).firstOrFail(), 1);
  const rows = [{ name: 'a' }, { name: 'b' }];
  assert.deepEqual(collect(rows).firstOrFail('name', 'b'), { name: 'b' });
  assert.deepEqual(collect(rows).firstOrFail('name', '=', 'a'), { name: 'a' });
  assert.deepEqual(collect([{ n: 1 }, { n: 2 }]).firstOrFail('n', '!=', 1), { n: 2 });
  // A miss throws PHP's ItemNotFoundException, whose message is EMPTY (a probe:
  // msg=[]). An empty message names nothing at the edge, so the error names the
  // failure: the item, or the key that was looked up.
  assert.throws(() => collect([]).firstOrFail(), { name: 'Error', message: 'Item not found.' });
  assert.throws(() => collect([1, 2]).firstOrFail((v) => v > 9), { message: 'Item not found.' });
  assert.throws(() => collect([]).firstOrFail('name', 'z'), {
    message: 'Item with key `name` not found.',
  });
  assert.throws(() => collect(rows).firstOrFail('name', '=', 'z'), {
    message: 'Item with key `name` not found.',
  });
  // A single NON-callable argument is PHP's TypeError (a probe), not a silent
  // "first item" (which is what first('name') would answer).
  assert.throws(() => collect(rows).firstOrFail('name'), TypeError);
});

test('sole answers the only item, or throws the none / multiple error', () => {
  // Probes: collect([1])->sole() = 1; collect([null])->sole() = null;
  // collect([0])->sole() = 0 (a falsy item is still an item);
  // collect(['a'=>1])->sole() = 1.
  assert.equal(collect([1]).sole(), 1);
  assert.equal(collect([null]).sole(), null);
  assert.equal(collect([0]).sole(), 0);
  assert.equal(collect({ a: 1 }).sole(), 1);
  // collect([1,2,3])->sole(fn ($v) => $v > 2) = 3;
  // collect([0,1])->sole(fn ($v) => $v === 0) = 0;
  // collect([null,1])->sole(fn ($v) => $v === null) = null.
  assert.equal(collect([1, 2, 3]).sole((v) => v > 2), 3);
  assert.equal(collect([0, 1]).sole((v) => v === 0), 0);
  assert.equal(collect([null, 1]).sole((v) => v === null), null);
  // Two arguments mean `$key = $operator`, three mean `$key $operator $value`
  // (probes: sole('name', 'b') = {"name":"b"}; sole('name', '=', 'a') =
  // {"name":"a"}; sole('name', '!=', 'a') = {"name":"b"}).
  const rows = [{ name: 'a' }, { name: 'b' }];
  assert.deepEqual(collect(rows).sole('name', 'b'), { name: 'b' });
  assert.deepEqual(collect(rows).sole('name', '=', 'a'), { name: 'a' });
  assert.deepEqual(collect(rows).sole('name', '!=', 'a'), { name: 'b' });
  // No match throws PHP's ItemNotFoundException, whose message is EMPTY (a
  // probe: msg=[]); the edge names the failure. More than one match throws
  // MultipleItemsFoundException with its own "<count> items were found."
  // message (probes: 2 and 3 items).
  assert.throws(() => collect([]).sole(), { name: 'Error', message: 'Item not found.' });
  assert.throws(() => collect([1, 2, 3]).sole((v) => v > 9), { message: 'Item not found.' });
  assert.throws(() => collect([1, 2]).sole(), { name: 'Error', message: '2 items were found.' });
  assert.throws(() => collect([1, 2, 3]).sole((v) => v > 1), { message: '2 items were found.' });
  assert.throws(() => collect([1, 2, 3]).sole(), { message: '3 items were found.' });
  // A single nullish argument filters nothing (probes: null, false, 0 and ''
  // all reach the count check); a single non-callable, non-nullish argument is
  // PHP's TypeError (probes: 'name', '0', 1 and a non-empty array).
  for (const arg of [null, false, 0, '']) {
    assert.throws(() => collect([1, 2]).sole(arg), { message: '2 items were found.' });
  }
  assert.throws(() => collect([1, 2]).sole([]), { message: '2 items were found.' });
  assert.throws(() => collect(rows).sole('name'), TypeError);
  assert.throws(() => collect([1]).sole('0'), TypeError);
});

test('mapWithKeys: the callback pairs are the keys, a later key wins', () => {
  // A probe: ['a'=>1,'b'=>2] with `[$k.'!' => $v]` answers
  // ['a!'=>1,'b!'=>2]; [1,2,3] with `['x' => $v]` answers ['x'=>3];
  // [1,2] with `[$k*2 => $v]` answers [0=>1,2=>2].
  assert.deepEqual(
    collect({ a: 1, b: 2 }).mapWithKeys((v, k) => ({ [k + '!']: v })).all(),
    { 'a!': 1, 'b!': 2 }
  );
  assert.deepEqual(collect([1, 2, 3]).mapWithKeys((v) => ({ x: v })).all(), { x: 3 });
  assert.deepEqual(collect([1, 2]).mapWithKeys((v, k) => ({ [k * 2]: v })).all(), { 0: 1, 2: 2 });
  // A probe: '1' is the int key 1 and '01' stays a string key.
  assert.deepEqual(collect([1]).mapWithKeys(() => ({ 1: 'x', '01': 'y' })).all(), { 1: 'x', '01': 'y' });
  // A probe: the callback may answer a Collection instead of an array.
  assert.deepEqual(collect([1]).mapWithKeys((v) => collect({ a: v })).all(), { a: 1 });
  assert.throws(() => collect([1]).mapWithKeys(() => 1), TypeError);
});

test('countBy: a keyed count of the values', () => {
  // A probe: [1,2,2,3,3,3] answers [1=>1,2=>2,3=>3]; ['1','01',1] answers
  // [1=>2,'01'=>1]; ['a','b','c'] with a callback answers ['x'=>1,'y'=>2].
  assert.deepEqual(collect([1, 2, 2, 3, 3, 3]).countBy().all(), { 1: 1, 2: 2, 3: 3 });
  assert.deepEqual(collect(['1', '01', 1]).countBy().all(), { 1: 2, '01': 1 });
  assert.deepEqual(collect(['a', 'b', 'c']).countBy((v) => (v === 'a' ? 'x' : 'y')).all(), { x: 1, y: 2 });
  assert.deepEqual(collect([]).countBy().all(), []);
  // A probe: the callback receives the PHP key.
  assert.deepEqual(collect({ a: 1, b: 1 }).countBy((v, k) => k).all(), { a: 1, b: 1 });
});

test('only/except take an array or variadic keys, keeping the original order', () => {
  // A probe: only(['c','a']) answers ['a'=>1,'c'=>3]; only('a','c') is the
  // same; except(['b']) answers ['a'=>1,'c'=>3]; only([0,2]) on a list keeps
  // positions 0 and 2; only(null) answers a copy.
  assert.deepEqual(collect({ a: 1, b: 2, c: 3 }).only(['a', 'c']).all(), { a: 1, c: 3 });
  assert.deepEqual(collect({ a: 1, b: 2, c: 3 }).only('a', 'c').all(), { a: 1, c: 3 });
  assert.deepEqual(collect({ a: 1, b: 2, c: 3 }).only(['c', 'a']).all(), { a: 1, c: 3 });
  assert.deepEqual(collect([10, 20, 30]).only([0, 2]).all(), { 0: 10, 2: 30 });
  assert.deepEqual(collect([10, 20, 30]).only(['0', '2']).all(), { 0: 10, 2: 30 });
  assert.deepEqual(collect({ a: 1 }).only(['a', 'z']).all(), { a: 1 });
  assert.deepEqual(collect({ a: 1 }).only(null).all(), { a: 1 });
  assert.deepEqual(collect({ a: 1, b: 2, c: 3 }).except(['b']).all(), { a: 1, c: 3 });
  assert.deepEqual(collect({ a: 1, b: 2 }).except('a').all(), { b: 2 });
  assert.deepEqual(collect([10, 20, 30]).except([1]).all(), { 0: 10, 2: 30 });
  // A probe: only() flips the keys, so a non-string/non-int key is an error.
  assert.throws(() => collect([1, 2]).only([true]), /array_flip/);
});

test('join: 0, 1, 2 and 3+ items, and the final glue', () => {
  // A probe: join(', ') answers '', 'a', 'a, b', 'a, b, c'. With a final glue
  // 0 answers '', 1 answers the ITEM itself (the int 1, not '1'), 2 answers
  // 'a and b' (the final glue IS used with 2), 3 answers 'a, b and c'.
  assert.equal(collect([]).join(', '), '');
  assert.equal(collect(['a']).join(', '), 'a');
  assert.equal(collect(['a', 'b']).join(', '), 'a, b');
  assert.equal(collect(['a', 'b', 'c']).join(', '), 'a, b, c');
  assert.equal(collect([]).join(', ', ' and '), '');
  assert.equal(collect(['a']).join(', ', ' and '), 'a');
  assert.equal(collect([1]).join(', ', ' and '), 1);
  assert.equal(collect(['a', 'b']).join(', ', ' and '), 'a and b');
  assert.equal(collect(['a', 'b', 'c']).join(', ', ' and '), 'a, b and c');
  // A probe: join() does not mutate the collection.
  const items = collect(['a', 'b', 'c']);
  items.join(', ', ' and ');
  assert.deepEqual(items.all(), ['a', 'b', 'c']);
});

test('pad: a negative size pads at the front', () => {
  // A probe: [1,2]->pad(4,0) = [1,2,0,0]; pad(-4,0) = [0,0,1,2];
  // pad(2,0) and pad(0,0) answer a copy; ['a'=>1]->pad(3,0) =
  // ['a'=>1,0=>0,1=>0]; pad(-3,0) = [0=>0,1=>0,'a'=>1].
  assert.deepEqual(collect([1, 2]).pad(4, 0).all(), [1, 2, 0, 0]);
  assert.deepEqual(collect([1, 2]).pad(-4, 0).all(), [0, 0, 1, 2]);
  assert.deepEqual(collect([1, 2]).pad(2, 0).all(), [1, 2]);
  assert.deepEqual(collect([1, 2, 3]).pad(2, 0).all(), [1, 2, 3]);
  assert.deepEqual(collect({ a: 1 }).pad(3, 0).all(), { a: 1, 0: 0, 1: 0 });
  assert.deepEqual(collect({ a: 1 }).pad(-3, 0).all(), { 0: 0, 1: 0, a: 1 });
});

test('prepend mutates and returns the same instance', () => {
  // A probe: $c->prepend(0) === $c, and the collection is [0,1,2].
  const items = collect([1, 2]);
  assert.equal(items.prepend(0), items);
  assert.deepEqual(items.all(), [0, 1, 2]);
  // A probe: [1]->prepend(0, 5) = [5=>0,0=>1]; ['a'=>1] with key 'a' =
  // ['a'=>0] (the existing key is replaced and moves to the front);
  // ['a'=>1,'b'=>2]->prepend(0) = [0=>0,'a'=>1,'b'=>2].
  assert.deepEqual(collect([1]).prepend(0, 5).all(), { 5: 0, 0: 1 });
  assert.deepEqual(collect({ a: 1 }).prepend(0, 'a').all(), { a: 0 });
  assert.deepEqual(collect({ a: 1, b: 2 }).prepend(0).all(), { 0: 0, a: 1, b: 2 });
});

test('concat: the receiver keys survive, the source keys do not', () => {
  // A probe: ['a'=>1]->concat(['b'=>2]) = ['a'=>1,0=>2];
  // [5=>'x']->concat(['y']) = [5=>'x',6=>'y']; [1,2]->concat([3,4]) =
  // [1,2,3,4]. concat() answers a NEW collection.
  assert.deepEqual(collect({ a: 1 }).concat({ b: 2 }).all(), { a: 1, 0: 2 });
  assert.deepEqual(collect({ 5: 'x' }).concat(['y']).all(), { 5: 'x', 6: 'y' });
  assert.deepEqual(collect([1, 2]).concat([3, 4]).all(), [1, 2, 3, 4]);
  const items = collect([1]);
  const joined = items.concat([2]);
  assert.notEqual(joined, items);
  assert.deepEqual(items.all(), [1]);
});

test('flip swaps keys and values', () => {
  // A probe: ['a'=>1,'b'=>2] answers [1=>'a',2=>'b']; [1,1,2] answers
  // [1=>1,2=>2] (the last key wins, the first position stays).
  assert.deepEqual(collect({ a: 1, b: 2 }).flip().all(), { 1: 'a', 2: 'b' });
  assert.deepEqual(collect([1, 1, 2]).flip().all(), { 1: 1, 2: 2 });
  // A probe: array_flip() rejects a bool/float value.
  assert.throws(() => collect([true]).flip(), /array_flip/);
});

test('search answers the first key, or false', () => {
  // Probes: ['a'=>1,'b'=>2]->search(2) = 'b'; [1,2]->search('2') = 1 (loose);
  // search('2', true) = false; a miss = false; [0,1]->search(false) = 0;
  // search($callback) answers the key ('b' for `$k === 'b'`).
  assert.equal(collect({ a: 1, b: 2 }).search(2), 'b');
  assert.equal(collect([1, 2]).search('2'), 1);
  assert.equal(collect([1, 2]).search('2', true), false);
  assert.equal(collect([1]).search(9), false);
  assert.equal(collect([0, 1]).search(false), 0);
  assert.equal(collect({ a: 1, b: 2 }).search((v, k) => k === 'b'), 'b');
  // A probe: the callback result is tested with PHP's bool cast ('0' and 0
  // are false, 'a' is true).
  assert.equal(collect([1, 2]).search(() => '0'), false);
  assert.equal(collect([1, 2]).search(() => 'a'), 0);
});

test('transform mutates in place and returns the same instance', () => {
  // A probe: $c->transform($fn) === $c and the items become [2,4];
  // ['a'=>1,'b'=>2] becomes ['a'=>2,'b'=>4] (keys survive).
  const items = collect([1, 2]);
  assert.equal(items.transform((v) => v * 2), items);
  assert.deepEqual(items.all(), [2, 4]);
  const keyed = collect({ a: 1, b: 2 });
  keyed.transform((v) => v * 2);
  assert.deepEqual(keyed.all(), { a: 2, b: 4 });
});

test('collapse merges one level of arrays and collections', () => {
  // Probes: [[1,2],[3,4]] = [1,2,3,4]; [collect([1,2]),collect([3])] =
  // [1,2,3]; [['a'=>1],['a'=>2,'b'=>3]] = ['a'=>2,'b'=>3] (array_merge);
  // [[1],'x',[2]] = [1,2] (scalars skipped).
  assert.deepEqual(collect([[1, 2], [3, 4]]).collapse().all(), [1, 2, 3, 4]);
  assert.deepEqual(collect([collect([1, 2]), collect([3])]).collapse().all(), [1, 2, 3]);
  assert.deepEqual(collect([{ a: 1 }, { a: 2, b: 3 }]).collapse().all(), { a: 2, b: 3 });
  assert.deepEqual(collect([[1], 'x', [2]]).collapse().all(), [1, 2]);
});

test('diff/intersect keep the keys and compare as strings', () => {
  // Probes: [1,2,3]->diff([2]) = [0=>1,2=>3]; diff(['1']) on [1,2] =
  // [1=>2]; [null,0]->diff(['']) = [1=>0]; intersect([2]) = [1=>2];
  // intersect(['1']) on [1,2] = [0=>1]; a second argument is IGNORED
  // (diff([1],[3]) keeps 3).
  assert.deepEqual(collect([1, 2, 3]).diff([2]).all(), { 0: 1, 2: 3 });
  assert.deepEqual(collect([1, 2]).diff(['1']).all(), { 1: 2 });
  assert.deepEqual(collect([null, 0]).diff(['']).all(), { 1: 0 });
  assert.deepEqual(collect([1, 2, 3]).diff([1], [3]).all(), { 1: 2, 2: 3 });
  assert.deepEqual(collect([1, 2, 3]).intersect([2]).all(), { 1: 2 });
  assert.deepEqual(collect([1, 2]).intersect(['1']).all(), [1]);
  assert.deepEqual(collect([null, 0]).intersect(['']).all(), [null]);
  assert.deepEqual(collect([1, 2, 3]).intersect([3], [1]).all(), { 2: 3 });
});

test('split/splitIn: uneven groups, different key rules', () => {
  // A probe: 7 items into 3 = [[1,2,3],[4,5],[6,7]]; 3 items into 5 = three
  // groups of one; split() reindexes integer keys but keeps string keys.
  assert.deepEqual(collect([1, 2, 3, 4, 5, 6, 7]).split(3).toArray(), [[1, 2, 3], [4, 5], [6, 7]]);
  assert.deepEqual(collect([1, 2, 3]).split(5).toArray(), [[1], [2], [3]]);
  assert.deepEqual(collect({ a: 1, b: 2, c: 3 }).split(2).toArray(), [{ a: 1, b: 2 }, { c: 3 }]);
  // A probe: splitIn() is chunk(ceil(count/groups)), and chunk() PRESERVES
  // the keys - [1..5]->splitIn(2) = [[1,2,3],[3=>4,4=>5]].
  assert.deepEqual(collect([1, 2, 3, 4, 5]).splitIn(2).toArray(), [[1, 2, 3], { 3: 4, 4: 5 }]);
  assert.deepEqual(collect({ a: 1, b: 2, c: 3 }).splitIn(2).toArray(), [{ a: 1, b: 2 }, { c: 3 }]);
  // A probe: fewer than 1 group is "Number of groups must be at least 1."
  assert.throws(() => collect([1]).split(0), /at least 1/);
  assert.throws(() => collect([1]).splitIn(0), /at least 1/);
});

test('median/mode: odd, even, ties and empty', () => {
  // Probes: median([5,3,1]) = 3; median([4,1,3,2]) = 2.5; median([]) = null;
  // median([1,null,3]) = 2 (nulls rejected); median('v') = 3.
  assert.equal(collect([5, 3, 1]).median(), 3);
  assert.equal(collect([4, 1, 3, 2]).median(), 2.5);
  assert.equal(collect([]).median(), null);
  assert.equal(collect([1, null, 3]).median(), 2);
  assert.equal(collect([{ v: 1 }, { v: 5 }, { v: 3 }]).median('v'), 3);
  // Probes: mode([1,1,2,3,3]) = [1,3]; mode([1,1,2,2,3]) = [1,2];
  // mode([1,2,3]) = [1,2,3]; mode([]) = null; mode('v') = [1].
  assert.deepEqual(collect([1, 1, 2, 3, 3]).mode(), [1, 3]);
  assert.deepEqual(collect([1, 1, 2, 2, 3]).mode(), [1, 2]);
  assert.deepEqual(collect([1, 2, 3]).mode(), [1, 2, 3]);
  assert.equal(collect([]).mode(), null);
  assert.deepEqual(collect([{ v: 1 }, { v: 1 }, { v: 2 }]).mode('v'), [1]);
});

test('dot/undot flatten and rebuild', () => {
  // Probes: ['a'=>['b'=>1,'c'=>['d'=>2]],'e'=>3] answers
  // ['a.b'=>1,'a.c.d'=>2,'e'=>3]; [[1,2],[3]] answers
  // ['0.0'=>1,'0.1'=>2,'1.0'=>3]; ['a'=>[]] keeps the empty array; a
  // Collection value is NOT recursed. undot() inverts it, numeric segments
  // become integer keys (['0.a'=>1,'1'=>3] = [0=>['a'=>1],1=>3]).
  assert.deepEqual(collect({ a: { b: 1, c: { d: 2 } }, e: 3 }).dot().all(), {
    'a.b': 1,
    'a.c.d': 2,
    e: 3,
  });
  assert.deepEqual(collect([[1, 2], [3]]).dot().all(), { '0.0': 1, '0.1': 2, '1.0': 3 });
  assert.deepEqual(collect({ a: [] }).dot().all(), { a: [] });
  const dotted = collect({ a: collect([1, 2]) }).dot();
  assert.deepEqual(dotted.get('a').all(), [1, 2]);
  assert.deepEqual(collect({ 'a.b': 1, 'a.c': 2, d: 3 }).undot().all(), { a: { b: 1, c: 2 }, d: 3 });
  assert.deepEqual(collect({ '0.a': 1, '0.b': 2, 1: 3 }).undot().all(), [{ a: 1, b: 2 }, 3]);
});

test('getOrPut stores the default and returns it', () => {
  // Probes: ['a'=>1]->getOrPut('a',2) = 1; getOrPut('b',2) = 2 and leaves
  // ['a'=>1,'b'=>2]; a closure is called; a stored null/false IS present.
  assert.equal(collect({ a: 1 }).getOrPut('a', 2), 1);
  assert.equal(collect({ a: 1 }).getOrPut('b', 2), 2);
  assert.equal(collect({ a: 1 }).getOrPut('b', () => 2), 2);
  assert.equal(collect({ a: null }).getOrPut('a', 2), null);
  assert.equal(collect({ a: false }).getOrPut('a', 2), false);
  const items = collect({ a: 1 });
  items.getOrPut('b', 2);
  assert.deepEqual(items.all(), { a: 1, b: 2 });
});

test('hasAny answers whether any key is present', () => {
  // Probes: ['a'=>1]->hasAny(['a','b']) = true; hasAny(['b','c']) = false;
  // hasAny('a','b') works variadically; [1,2]->hasAny([0,5]) = true;
  // hasAny([]) = false; the keys use PHP's coercion ('0' finds position 0).
  assert.equal(collect({ a: 1 }).hasAny(['a', 'b']), true);
  assert.equal(collect({ a: 1 }).hasAny(['b', 'c']), false);
  assert.equal(collect({ a: 1 }).hasAny('a', 'b'), true);
  assert.equal(collect([1, 2]).hasAny([0, 5]), true);
  assert.equal(collect([1]).hasAny([]), false);
  assert.equal(collect([10, 20]).hasAny(['0']), true);
});

test('nth takes every nth item from the offset', () => {
  // Probes: [1..5]->nth(2) = [1,3,5]; nth(2,1) = [2,4]; nth(2,3) = [];
  // nth(0) throws "Step value must be at least 1.".
  assert.deepEqual(collect([1, 2, 3, 4, 5]).nth(2).all(), [1, 3, 5]);
  assert.deepEqual(collect([1, 2, 3, 4, 5]).nth(2, 1).all(), [2, 4]);
  assert.deepEqual(collect([1, 2, 3]).nth(2, 3).all(), []);
  assert.throws(() => collect([1]).nth(0), /at least 1/);
});

test('duplicates keep the later keys', () => {
  // Probes: [1,2,1,2,3]->duplicates() = [2=>1,3=>2]; ['a'=>1,'b'=>1] =
  // ['b'=>1]; [1,'1'] without strict = [1=>'1'], with strict = [];
  // duplicates('v') = [1=>1].
  assert.deepEqual(collect([1, 2, 1, 2, 3]).duplicates().all(), { 2: 1, 3: 2 });
  assert.deepEqual(collect({ a: 1, b: 1 }).duplicates().all(), { b: 1 });
  assert.deepEqual(collect([1, '1']).duplicates().all(), { 1: '1' });
  assert.deepEqual(collect([1, '1']).duplicates(null, true).all(), []);
  assert.deepEqual(collect([{ v: 1 }, { v: 1 }, { v: 2 }]).duplicates('v').all(), { 1: 1 });
});

test('zip/combine/crossJoin', () => {
  // Probes: [1,2,3]->zip([4,5,6]) = [[1,4],[2,5],[3,6]]; zip([4]) pads with
  // null = [[1,4],[2,null],[3,null]]; []->zip([1]) = [[null,1]]; the rows are
  // Collections. combine() makes the VALUES keys; unequal counts throw.
  assert.deepEqual(collect([1, 2, 3]).zip([4, 5, 6]).toArray(), [[1, 4], [2, 5], [3, 6]]);
  assert.deepEqual(collect([1, 2, 3]).zip([4]).toArray(), [[1, 4], [2, null], [3, null]]);
  assert.deepEqual(collect([]).zip([1]).toArray(), [[null, 1]]);
  assert.deepEqual(collect([1, 2]).zip([3, 4], [5, 6]).toArray(), [[1, 3, 5], [2, 4, 6]]);
  assert.deepEqual(collect(['a', 'b']).combine([1, 2]).all(), { a: 1, b: 2 });
  assert.deepEqual(collect([10, 20]).combine(['x', 'y']).all(), { 10: 'x', 20: 'y' });
  assert.throws(() => collect(['a']).combine([1, 2]), /same number of elements/);
  // Probes: [1,2]->crossJoin(['a','b']) = [[1,'a'],[1,'b'],[2,'a'],[2,'b']];
  // an empty list empties the result; no list answers one row per item.
  assert.deepEqual(collect([1, 2]).crossJoin(['a', 'b']).toArray(), [
    [1, 'a'],
    [1, 'b'],
    [2, 'a'],
    [2, 'b'],
  ]);
  assert.deepEqual(collect([1]).crossJoin([]).toArray(), []);
  assert.deepEqual(collect([1, 2]).crossJoin().toArray(), [[1], [2]]);
});

test('sort/sortDesc use PHP order and keep the keys', () => {
  // Probes: [3,1,2]->sort() = [1=>1,2=>2,0=>3]; strings sort byte-wise
  // (['b','A','a','B'] = A,B,a,b); a numeric string compares NUMERICALLY
  // ('9' < '10'); a number comes before a non-numeric string (2 < 'B');
  // ['10','9','a','B',2,'_'] = [2,'9','10','B','_','a'].
  assert.deepEqual(collect([3, 1, 2]).sort().all(), { 1: 1, 2: 2, 0: 3 });
  assert.deepEqual(collect(['banana', 'apple', 'cherry']).sort().all(), {
    1: 'apple',
    0: 'banana',
    2: 'cherry',
  });
  assert.deepEqual(collect(['b', 'A', 'a', 'B']).sort().values().all(), ['A', 'B', 'a', 'b']);
  assert.deepEqual(collect(['10', '9', 'a', 'B', 2, '_']).sort().values().all(), [2, '9', '10', 'B', '_', 'a']);
  assert.deepEqual(collect(['10', '9', 'a', 'B', 2, '_']).sort().keys().all(), [4, 1, 0, 3, 5, 2]);
  // A probe: the sort is STABLE ([2,1,2,1] keeps 1 before 1 and 2 before 2).
  assert.deepEqual(collect([2, 1, 2, 1]).sort().keys().all(), [1, 3, 0, 2]);
  // A probe: sort($callback) is uasort(); keys survive.
  assert.deepEqual(collect([3, 1, 2]).sort((a, b) => b - a).all(), { 0: 3, 2: 2, 1: 1 });
  assert.deepEqual(collect({ a: 3, b: 1, c: 2 }).sort().all(), { b: 1, c: 2, a: 3 });
  // Probes: sortDesc() is arsort() - keys preserved, a NEW collection.
  assert.deepEqual(collect([3, 1, 2]).sortDesc().all(), { 0: 3, 2: 2, 1: 1 });
  const items = collect([2, 1]);
  const sorted = items.sort();
  assert.notEqual(sorted, items);
  assert.deepEqual(items.all(), [2, 1]);
  // A probe: Laravel 13's sortDesc() takes sort FLAGS, so a closure is a
  // TypeError ("arsort(): Argument #2 ($flags) must be of type int, Closure
  // given") - never a silent reverse.
  assert.throws(() => collect([1, 2]).sortDesc((a, b) => a - b), TypeError);
});

// ---- sortBy keeps PHP's keys (probed) -----------------------------------
//
// Laravel's Collection::sortBy() keys `$results` by the ORIGINAL key and
// returns `newInstance($results)` (Collection.php:1601-1625), so a keyed
// collection stays keyed. Probed with the vendored Laravel 13:
//   collect(['a' => 3, 'b' => 1, 'c' => 2])->sortBy(fn ($v) => $v)->all()
//     => {"b":1,"c":2,"a":3}
// A LIST stays a list (there are no keys to carry).
test('collections: sortBy/sortByDesc keep the original keys', () => {
  const keyed = new Collection({ a: 3, b: 1, c: 2 });
  assert.deepEqual(keyed.sortBy((v) => v).all(), { b: 1, c: 2, a: 3 });
  assert.deepEqual(keyed.sortByDesc((v) => v).all(), { a: 3, c: 2, b: 1 });
  assert.deepEqual(new Collection([3, 1]).sortBy((v) => v).all(), [1, 3]);
});
