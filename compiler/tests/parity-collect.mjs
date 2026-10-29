#!/usr/bin/env node
// compiler/tests/parity-collect.mjs — harness for rt.collect() (no PHP needed)
import { buildRt } from '../runtime/rt-from-context.mjs';

const rt = buildRt({}, { strict: false });

let total = 0, passed = 0, failed = 0;

function isEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

function check(name, got, expected) {
  total++;
  const ok = isEqual(got, expected);
  if (ok) { passed++; console.log(`ok ${total} - ${name}`); }
  else {
    failed++;
    console.log(`not ok ${total} - ${name}`);
    console.log(`  ---`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    got:      ${JSON.stringify(got)}`);
    console.log(`  ...`);
  }
}

// freeze array input — also proves immutability/no PHP needed
const frozenSrc = Object.freeze([1, 2, 3]);
const c123 = rt.collect(frozenSrc);
const empty = rt.collect([]);
const objs = Object.freeze([{ a: 1, name: 'alice' }, { a: 2, name: 'bob' }, { a: 1, name: 'carol' }]);

// 1-5 count / isEmpty / isNotEmpty
check('count [1,2,3] === 3', c123.count(), 3);
check('isEmpty false on [1,2,3]', c123.isEmpty(), false);
check('isNotEmpty true on [1,2,3]', c123.isNotEmpty(), true);
check('isEmpty true on []', empty.isEmpty(), true);
check('isNotEmpty false on []', empty.isNotEmpty(), false);
check('count [] === 0', empty.count(), 0);

// 6-7 first / last
check('first() === 1', c123.first(), 1);
check('last() === 3', c123.last(), 3);
check('first() on empty => null', empty.first(), null);
check('last() on empty => null', empty.last(), null);

// 8 firstWhere
check("firstWhere('a',1) finds alice", rt.collect(objs).firstWhere('a', 1), { a: 1, name: 'alice' });
check("firstWhere('a',99) => null", rt.collect(objs).firstWhere('a', 99), null);
// 8b firstWhere's other argument forms (`first(operatorForWhere(...))`):
// one argument is `$key = true`, three are `$key $operator $value`.
check("firstWhere('a','>',1) => bob", rt.collect(objs).firstWhere('a', '>', 1), { a: 2, name: 'bob' });
check("firstWhere('a','<',2) => alice", rt.collect(objs).firstWhere('a', '<', 2), { a: 1, name: 'alice' });
check("firstWhere('name') => alice (truthy value)", rt.collect(objs).firstWhere('name'), { a: 1, name: 'alice' });
check("where('a','>',1) keeps bob", rt.collect(objs).where('a', '>', 1).values().toArray(), [{ a: 2, name: 'bob' }]);
// 8c PHP's OBJECT rules: `==` compares same-class objects by their properties,
// and an object is only ever "not equal" to a non-object.
check('contains(object by properties)', rt.collect([{ a: 1 }]).contains({ a: 1 }), true);
check('where(object) by properties', rt.collect([{ x: { a: 1 } }]).where('x', '=', { a: 1 }).count(), 1);
check('where(object) != scalar keeps the row', rt.collect([{ x: { a: 1 } }]).where('x', '!=', 5).count(), 1);
check('where(object) > scalar is empty', rt.collect([{ x: { a: 1 } }]).where('x', '>', 5).count(), 0);

// 9-10 get
check("get(1,'def') === 2", c123.get(1, 'def'), 2);
check("get(99,'def') === 'def'", c123.get(99, 'def'), 'def');
check("get(99) without default => null", c123.get(99), null);

// 11 pluck
check("pluck('name') => ['alice','bob','carol']", rt.collect(objs).pluck('name').toArray(), ['alice', 'bob', 'carol']);

// 12 filter / 13 map / 14 each / 15 take / 16 slice
// filter() PRESERVES the PHP keys (a PHP probe: json_encode answers
// {"1":2,"3":4}), so the expectation is the keyed object, not the list.
check("filter even => {1:2,3:4}", rt.collect([1, 2, 3, 4]).filter((x) => x % 2 === 0).toArray(), { "1": 2, "3": 4 });
check("filter without fn filters falsy => {1:1,3:2}", rt.collect([0, 1, false, 2, '', null]).filter().toArray(), { "1": 1, "3": 2 });
check("map x*2 => [2,4,6]", c123.map((x) => x * 2).toArray(), [2, 4, 6]);
let eachCount = 0;
const cEach = rt.collect([1, 2, 3]);
const retEach = cEach.each(() => { eachCount++; });
check("each visits 3", eachCount, 3);
check("each returns self", retEach === cEach, true);
check("take(2) => [1,2]", c123.take(2).toArray(), [1, 2]);
check("take(-1) => {2:3}", c123.take(-1).toArray(), { "2": 3 });
check("slice(1,2) => {1:2,2:3}", c123.slice(1, 2).toArray(), { "1": 2, "2": 3 });
check("slice(1) => {1:2,2:3}", c123.slice(1).toArray(), { "1": 2, "2": 3 });

// 17-18 contains
check("contains(val) true", c123.contains(2), true);
check("contains(val) false", c123.contains(99), false);
check("contains(fn) true", c123.contains((x) => x > 2), true);
check("contains(fn) false", c123.contains((x) => x > 10), false);

// 19 has
check("has(1) true", c123.has(1), true);
check("has(99) false", c123.has(99), false);

// 20-21 sum / avg
check("sum() => 6", c123.sum(), 6);
check("sum('v') => 6", rt.collect([{ v: 1 }, { v: 2 }, { v: 3 }]).sum('v'), 6);
check("avg() => 2", c123.avg(), 2);
check("avg('v') => 2", rt.collect([{ v: 1 }, { v: 2 }, { v: 3 }]).avg('v'), 2);
check("avg empty => null", empty.avg(), null);
check("sum empty => 0", empty.sum(), 0);

// 22 keys / values / toArray / toJson
check("keys() => [0,1,2]", c123.keys().toArray(), [0, 1, 2]);
check("values() => [1,2,3]", c123.values().toArray(), [1, 2, 3]);
check("toArray() deep", c123.toArray(), [1, 2, 3]);
check("toJson() === JSON.stringify", c123.toJson(), JSON.stringify([1, 2, 3]));

// 23 chain filter->map->toArray
check("chain filter->map->toArray => {1:4,2:6,3:8}", rt.collect([1, 2, 3, 4]).filter((x) => x > 1).map((x) => x * 2).toArray(), { "1": 4, "2": 6, "3": 8 });

// 24 null/undefined => empty
check("collect(null) count 0", rt.collect(null).count(), 0);
check("collect(undefined) count 0", rt.collect(undefined).count(), 0);
check("collect(null) isEmpty true", rt.collect(null).isEmpty(), true);
check("collect(undefined) toArray []", rt.collect(undefined).toArray(), []);

// 25 frozen array not mutated + still works after ops
const src = [1, 2, 3];
const cSrc = rt.collect(src);
cSrc.map((x) => x * 10);
check("source not mutated after map", src, [1, 2, 3]);
check("frozenSrc still [1,2,3] after collect ops", frozenSrc, [1, 2, 3]);
check("collect(frozenSrc).map works", rt.collect(frozenSrc).map((x) => x * 2).toArray(), [2, 4, 6]);

console.log(`1..${total}`);
console.log(`# passed ${passed}/${total}`);
if (failed) { console.log(`# FAIL ${failed} failed`); process.exit(1); }
else { console.log(`# PASS`); }
