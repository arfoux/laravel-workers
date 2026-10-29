// kernel/tests/collections-where.test.mjs - the `where()` family against PHP's
// OWN answers: operator semantics, the key each item is read from, and PHP's
// OBJECT rules.
//
// Ground truth: the vendored Laravel 13 (`Illuminate/Collections/*`) on PHP 8.3,
// driven by a differential probe (`Collection` + `json_encode()`); every
// expectation below is that probe's recorded answer, so the file survives the
// harness. The comparison goes through `phpJsonEncode()`: a `[]`/`{}` SHAPE
// difference fails, which is the difference a response body shows.
//
// Object rules covered here (EnumeratesValues.php:1156-1190): `==` on two
// objects of the same class compares their PROPERTIES (recursively); comparing
// an object with a non-object answers `in_array($op, ['!=', '<>', '!=='])`;
// two objects of DIFFERENT classes are uncomparable (`<`/`>`/`<=`/`>=` false,
// `<=>` 1 both ways). `<`/`>` between two same-class objects compare property
// by property.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from '../collections.mjs';
import { phpJsonEncode } from '../php-json.mjs';

const C = Collection;
const make = (v) => new C(v);
class Other { constructor() { this.z = 1; } }
const a = { n: 1 };
const b = { n: 2 };
const c = { n: 1 };
const d = new Other();

const EXPECTED_WHERE = {
  "map_keyed": {
    "ok": true,
    "value": {
      "a": "a=1",
      "b": "b=2"
    }
  },
  "map_int_keyed": {
    "ok": true,
    "value": {
      "5": "5=x",
      "k": "k=y"
    }
  },
  "filter_keyed": {
    "ok": true,
    "value": {
      "b": 2
    }
  },
  "reject_keyed": {
    "ok": true,
    "value": {
      "a": 1
    }
  },
  "each_keyed": {
    "ok": true,
    "value": [
      "a=1",
      "b=2"
    ]
  },
  "contains_operator": {
    "ok": true,
    "value": true
  },
  "contains_key_value": {
    "ok": true,
    "value": true
  },
  "contains_two_scalars": {
    "ok": true,
    "value": true
  },
  "every_operator": {
    "ok": true,
    "value": true
  },
  "every_operator_false": {
    "ok": true,
    "value": false
  },
  "some_operator": {
    "ok": true,
    "value": true
  },
  "unknown_operator": {
    "ok": true,
    "value": [
      {
        "a": 1
      }
    ]
  },
  "spaceship_where": {
    "ok": true,
    "value": {
      "1": {
        "a": 2
      }
    }
  },
  "unique_numeric_strings": {
    "ok": true,
    "value": [
      "1.0"
    ]
  },
  "unique_strict_numeric_strings": {
    "ok": true,
    "value": [
      "1.0",
      1
    ]
  },
  "unique_key_strict": {
    "ok": true,
    "value": [
      {
        "a": 1
      },
      {
        "a": "1"
      }
    ]
  },
  "unique_key_loose": {
    "ok": true,
    "value": [
      {
        "a": 1
      }
    ]
  },
  "flatten_depth_1": {
    "ok": true,
    "value": [
      1,
      2,
      [
        3
      ]
    ]
  },
  "flatten_depth_2": {
    "ok": true,
    "value": [
      1,
      2,
      3
    ]
  },
  "flatten_full": {
    "ok": true,
    "value": [
      1,
      2,
      3
    ]
  },
  "merge_string_keys": {
    "ok": true,
    "value": {
      "a": 2,
      "b": 3
    }
  },
  "merge_numeric_keys": {
    "ok": true,
    "value": [
      "x",
      "y"
    ]
  },
  "merge_mixed": {
    "ok": true,
    "value": {
      "k": "z",
      "0": "y",
      "1": "w"
    }
  },
  "sum_leading_numeric": {
    "ok": true,
    "value": 5
  },
  "sum_string_numeric": {
    "ok": true,
    "value": 3
  },
  // `collect(['5a'])->sum()`: the string has a numeric PREFIX, so PHP's
  // arithmetic warns ("A non-numeric value encountered") and uses the prefix.
  // Under a BOOTED Laravel app (the fixture app's bootstrap/app.php, the probe
  // this file compares against) Illuminate\Foundation\Bootstrap\
  // HandleExceptions::handleError() promotes that E_WARNING to an
  // ErrorException - the raw-script answer 5 is NOT what an app sees, so the
  // expectation is the throw.
  "sum_non_numeric": {
    "ok": false,
    "value": "ErrorException: A non-numeric value encountered"
  },
  "avg_non_numeric": {
    "ok": false,
    "value": "ErrorException: A non-numeric value encountered"
  },
  "sum_float_strings": {
    "ok": true,
    "value": 4
  },
  "concat_keyed": {
    "ok": true,
    "value": {
      "a": 1,
      "0": 2
    }
  },
  "transform_keyed": {
    "ok": true,
    "value": {
      "a": "a1",
      "b": "b2"
    }
  },
  "filter_closure_arity0": {
    "ok": true,
    "value": [
      1,
      2
    ]
  },
  "sort_by_string": {
    "ok": true,
    "value": [
      "a",
      "b"
    ]
  },
  "first_where_1arg": {
    "ok": true,
    "value": {
      "x": 1
    }
  },
  "first_where_2arg": {
    "ok": true,
    "value": {
      "x": 5
    }
  },
  "first_where_missing": {
    "ok": true,
    "value": null
  },
  "first_where_lt": {
    "ok": true,
    "value": {
      "x": 1
    }
  },
  "where_obj_ne": {
    "ok": true,
    "value": [
      {
        "x": 1
      },
      {
        "x": 2
      }
    ]
  },
  "where_obj_gt": {
    "ok": true,
    "value": []
  },
  "where_obj_eq": {
    "ok": true,
    "value": 1
  },
  "where_obj_strict": {
    "ok": true,
    "value": []
  },
  "where_str_vs_obj": {
    "ok": true,
    "value": []
  },
  "contains_obj_ne": {
    "ok": true,
    "value": true
  },
  "where_two_objs": {
    "ok": true,
    "value": 1
  },
  "first_where_operator": {
    "ok": true,
    "value": {
      "x": 5
    }
  }
};

const WHERE_CASES = {
  map_keyed: () => make({ a: 1, b: 2 }).map((v, k) => `${k}=${v}`).all(),
  map_int_keyed: () => make({ 5: 'x', k: 'y' }).map((v, k) => `${k}=${v}`).all(),
  filter_keyed: () => make({ a: 1, b: 2 }).filter((v, k) => k === 'b').all(),
  reject_keyed: () => make({ a: 1, b: 2 }).reject((v, k) => k === 'b').all(),
  each_keyed: () => { const seen = []; make({ a: 1, b: 2 }).each((v, k) => { seen.push(`${k}=${v}`); }); return seen; },
  contains_operator: () => make([{ x: 2 }, { x: 5 }]).contains('x', '>', 3),
  contains_key_value: () => make([{ x: 2 }]).contains('x', 2),
  contains_two_scalars: () => make([1, 2, 3]).contains(2),
  every_operator: () => make([{ x: 2 }, { x: 5 }]).every('x', '>=', 2),
  every_operator_false: () => make([{ x: 2 }, { x: 5 }]).every('x', '>', 2),
  some_operator: () => make([{ x: 2 }, { x: 5 }]).some('x', '>', 3),
  unknown_operator: () => make([{ a: 1 }, { a: 2 }]).where('a', '~~', 1).all(),
  spaceship_where: () => make([{ a: 1 }, { a: 2 }]).where('a', '<=>', 1).all(),
  unique_numeric_strings: () => make(['1.0', 1]).unique().values().all(),
  unique_strict_numeric_strings: () => make(['1.0', 1]).uniqueStrict().values().all(),
  unique_key_strict: () => make([{ a: 1 }, { a: '1' }]).unique('a', true).values().all(),
  unique_key_loose: () => make([{ a: 1 }, { a: '1' }]).unique('a', false).values().all(),
  flatten_depth_1: () => make([1, [2, [3]]]).flatten(1).all(),
  flatten_depth_2: () => make([1, [2, [3]]]).flatten(2).all(),
  flatten_full: () => make([1, [2, [3]]]).flatten().all(),
  merge_string_keys: () => make({ a: 1 }).merge({ a: 2, b: 3 }).all(),
  merge_numeric_keys: () => make({ 5: 'x' }).merge({ 9: 'y' }).all(),
  merge_mixed: () => make({ k: 'x', 4: 'y' }).merge({ k: 'z', 4: 'w' }).all(),
  sum_leading_numeric: () => make(['5']).sum(),
  sum_string_numeric: () => make(['1', '2']).sum(),
  sum_non_numeric: () => make(['5a']).sum(),
  avg_non_numeric: () => make(['5a', '7b']).avg(),
  sum_float_strings: () => make(['1.5', '2.5']).sum(),
  concat_keyed: () => make({ a: 1 }).concat({ b: 2 }).all(),
  transform_keyed: () => make({ a: 1, b: 2 }).transform((v, k) => `${k}${v}`).all(),
  filter_closure_arity0: () => make([1, 2]).filter(() => true).all(),
  sort_by_string: () => make(['b', 'a']).sort().values().all(),
  first_where_1arg: () => make([{ x: 1 }, { x: 0 }]).firstWhere('x'),
  first_where_2arg: () => make([{ x: 1 }, { x: 5 }]).firstWhere('x', 5),
  first_where_missing: () => make([{ a: 1 }]).firstWhere('x'),
  first_where_lt: () => make([{ x: 1 }, { x: 5 }]).firstWhere('x', '<', 3),
  where_obj_ne: () => make([{ x: 1 }, { x: 2 }]).where('x', '!=', {}).all(),
  where_obj_gt: () => make([{ x: 1 }, { x: 2 }]).where('x', '>', {}).all(),
  where_obj_eq: () => make([{ x: { a: 1 } }, { x: 2 }]).where('x', '=', { a: 1 }).count(),
  where_obj_strict: () => make([{ x: 1 }]).where('x', '===', {}).all(),
  where_str_vs_obj: () => make([{ x: { a: 1 } }]).where('x', '=', 'foo').all(),
  contains_obj_ne: () => make([{ x: 1 }]).contains('x', '!=', {}),
  where_two_objs: () => make([{ x: { a: 1 } }]).where('x', '=', { a: 1 }).count(),
  first_where_operator: () => make([{ x: 1 }, { x: 5 }]).firstWhere('x', '>', 2),
};

const EXPECTED_OBJECT = {
  "contains_object_1arg": {
    "ok": true,
    "value": true
  },
  "contains_object_1arg_no": {
    "ok": true,
    "value": false
  },
  "where_obj_equal": {
    "ok": true,
    "value": 1
  },
  "where_obj_gt_same_class": {
    "ok": true,
    "value": 0
  },
  "where_obj_eq_two_objects": {
    "ok": true,
    "value": 1
  },
  "where_obj_lt_mixed_class": {
    "ok": true,
    "value": 0
  },
  "where_obj_gt_mixed_class": {
    "ok": true,
    "value": 0
  },
  "where_obj_ne_mixed_class": {
    "ok": true,
    "value": 1
  },
  "where_obj_spaceship": {
    "ok": true,
    "value": 1
  },
  "unique_objects": {
    "ok": true,
    "value": 2
  },
  "whereIn_objects": {
    "ok": true,
    "value": 1
  },
  "first_where_obj": {
    "ok": true,
    "value": "item"
  },
  "contains_obj_eq": {
    "ok": true,
    "value": true
  },
  "where_obj_string_vs_obj_ne": {
    "ok": true,
    "value": 1
  },
  "where_obj_bool_vs_obj_eq": {
    "ok": true,
    "value": 0
  },
  "where_obj_null_vs_obj_ne": {
    "ok": true,
    "value": 1
  },
  "where_obj_lt_same_class": {
    "ok": true,
    "value": 1
  },
  "where_obj_le_same_class": {
    "ok": true,
    "value": 1
  },
  "where_obj_ge_other": {
    "ok": true,
    "value": 1
  },
  "where_obj_spaceship_same": {
    "ok": true,
    "value": 0
  },
  "where_obj_second_object_is_not_object": {
    "ok": true,
    "value": 1
  },
  "first_where_obj_lt": {
    "ok": true,
    "value": "null"
  },
  "where_obj_array_vs_obj": {
    "ok": true,
    "value": 0
  }
};

const OBJECT_CASES = {
  contains_object_1arg: () => make([a, b]).contains(c),
  contains_object_1arg_no: () => make([b]).contains(a),
  where_obj_equal: () => make([{ x: a }]).where('x', '=', c).count(),
  where_obj_gt_same_class: () => make([{ x: a }]).where('x', '>', b).count(),
  where_obj_eq_two_objects: () => make([{ x: a }]).where('x', '=', c).count(),
  where_obj_lt_mixed_class: () => make([{ x: a }]).where('x', '<', d).count(),
  where_obj_gt_mixed_class: () => make([{ x: a }]).where('x', '>', d).count(),
  where_obj_ne_mixed_class: () => make([{ x: a }]).where('x', '!=', d).count(),
  where_obj_spaceship: () => make([{ x: a }]).where('x', '<=>', d).count(),
  unique_objects: () => make([a, b, c]).unique().count(),
  whereIn_objects: () => make([{ x: a }]).whereIn('x', [c]).count(),
  first_where_obj: () => (make([{ x: a }, { x: b }]).firstWhere('x', '=', c) === null ? 'null' : 'item'),
  contains_obj_eq: () => make([a]).contains(c),
  where_obj_string_vs_obj_ne: () => make([{ x: 'foo' }]).where('x', '!=', a).count(),
  where_obj_bool_vs_obj_eq: () => make([{ x: true }]).where('x', '=', a).count(),
  where_obj_null_vs_obj_ne: () => make([{ x: null }]).where('x', '!=', a).count(),
  where_obj_lt_same_class: () => make([{ x: a }]).where('x', '<', b).count(),
  where_obj_le_same_class: () => make([{ x: a }]).where('x', '<=', c).count(),
  where_obj_ge_other: () => make([{ x: b }]).where('x', '>=', a).count(),
  where_obj_spaceship_same: () => make([{ x: a }]).where('x', '<=>', c).count(),
  where_obj_second_object_is_not_object: () => make([{ x: a }]).where('x', '!=', 5).count(),
  first_where_obj_lt: () => (make([{ x: b }]).firstWhere('x', '<', a) === null ? 'null' : 'item'),
  where_obj_array_vs_obj: () => make([{ x: [1] }]).where('x', '=', a).count(),
};

test("where()/whereIn()/firstWhere()/contains(): PHP's own answer, case by case", () => {
  for (const [id, thunk] of Object.entries(WHERE_CASES)) {
    const expected = EXPECTED_WHERE[id];
    assert.ok(expected, 'no baked expectation for ' + id);
    let actual;
    let threw = null;
    try {
      actual = thunk();
    } catch (err) {
      threw = err;
    }
    if (expected.ok === false) {
      assert.ok(threw, id + ': PHP threw');
      assert.equal(threw.name || 'Error', String(expected.value).split(':')[0], id);
      continue;
    }
    if (threw) throw new Error(id + ' threw: ' + threw.name + ': ' + threw.message);
    assert.equal(phpJsonEncode(actual === undefined ? null : actual), phpJsonEncode(expected.value), id);
  }
});

test("PHP's OBJECT rules: property equality, incomparable classes, one object", () => {
  for (const [id, thunk] of Object.entries(OBJECT_CASES)) {
    const expected = EXPECTED_OBJECT[id];
    assert.ok(expected, 'no baked expectation for ' + id);
    let actual;
    let threw = null;
    try {
      actual = thunk();
    } catch (err) {
      threw = err;
    }
    if (expected.ok === false) {
      assert.ok(threw, id + ': PHP threw');
      assert.equal(threw.name || 'Error', String(expected.value).split(':')[0], id);
      continue;
    }
    if (threw) throw new Error(id + ' threw: ' + threw.name + ': ' + threw.message);
    assert.equal(phpJsonEncode(actual === undefined ? null : actual), phpJsonEncode(expected.value), id);
  }
});

test('firstWhere(): every argument form reads the item like data_get()', () => {
  // 1 argument is `$key = true` (truthiness of the value, PHP's bool cast),
  // 2 mean `$key = $operator`, 3 are `$key $operator $value`.
  assert.deepEqual(make([{ x: 1 }, { x: 0 }]).firstWhere('x'), { x: 1 });
  assert.equal(make([{ a: 1 }]).firstWhere('x'), null);
  assert.deepEqual(make([{ x: 1 }, { x: 5 }]).firstWhere('x', 5), { x: 5 });
  assert.deepEqual(make([{ x: 1 }, { x: 5 }]).firstWhere('x', '>', 2), { x: 5 });
  assert.deepEqual(make([{ x: 1 }, { x: 5 }]).firstWhere('x', '<', 3), { x: 1 });
  assert.equal(make([{ x: 1 }, { x: 5 }]).firstWhere('x', '>', 9), null);
  // A dotted key NESTS (data_get never reads a literal dotted key).
  assert.deepEqual(make([{ a: { b: 2 } }]).firstWhere('a.b', 2), { a: { b: 2 } });
  // A model answers through its ATTRIBUTES, not a JS property.
  const model = { attributes: { status: 'active' }, get(k) { return this.attributes[k] ?? null; } };
  assert.equal(make([model]).firstWhere('status', 'active'), model);
});

test('contains()/search()/whereIn() compare objects the way PHP does', () => {
  const one = { n: 1 };
  assert.equal(make([one, { n: 2 }]).contains({ n: 1 }), true);
  assert.equal(make([{ n: 2 }]).contains(one), false);
  assert.equal(make([one]).search(one), 0);
  assert.equal(make([{ x: one }]).whereIn('x', [{ n: 1 }]).count(), 1);
  assert.equal(make([{ x: one }]).whereNotIn('x', [{ n: 1 }]).count(), 0);
  // `contains(1)` is PHP's loose in_array, not a key lookup.
  assert.equal(make([1, 2]).contains('1'), true);
});
