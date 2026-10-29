// kernel/tests/collections-methods.test.mjs - the Collection methods the port
// gained, checked against PHP's OWN answers.
//
// Ground truth: the vendored Laravel 13 (`Illuminate/Collections/*`) on PHP
// 8.3. Every expectation below is the result of the SAME case run against
// `Illuminate\Support\Collection`, `json_encode()`-d and baked in as a literal
// (the differential harness itself was temporary - the values are what must
// stay). The comparison goes through `phpJsonEncode`, so a `[]`/`{}` shape
// difference (an empty PHP array vs an empty object) FAILS the test: that is
// exactly the difference that changes a response body.
//
// Cases whose PHP side THROWS assert the error CLASS only - PHP's message
// carries the vendor file and line, which the edge cannot reproduce.
//
// NOT covered here (documented limitations, not regressions): `get_class()` of
// a kernel Collection answers `Collection`, PHP says
// `Illuminate\Support\Collection`; `escapeWhenCastingToString()`'s effect on
// `e()`/concatenation lives in the runtime (`rt.e`/`phpToStr`) and is covered by
// compiler/tests instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from '../collections.mjs';
import { phpJsonEncode } from '../php-json.mjs';

const C = Collection;
const make = (v) => new Collection(v);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const group = (c) => c.all();
class PipeTarget {
  constructor(c) { this.c = c; }
  doubled() { return this.c.map((v) => v * 2).all(); }
}

const EXPECTED = {
  "reduce": {
    "ok": true,
    "value": "[0:1][1:2][2:3]"
  },
  "reduce_keys": {
    "ok": true,
    "value": "ab"
  },
  "reduceInto": {
    "ok": true,
    "value": [
      "0=1",
      "1=2"
    ]
  },
  "reduceSpread": {
    "ok": true,
    "value": [
      12,
      21
    ]
  },
  "reduceSpread_err": {
    "ok": true,
    "value": "UnexpectedValueException: Collection::reduceSpread expects reducer to return an array, but got a 'string' instead."
  },
  "average": {
    "ok": true,
    "value": 3
  },
  "average_cb": {
    "ok": true,
    "value": 3
  },
  "percentage_empty": {
    "ok": true,
    "value": null
  },
  "percentage": {
    "ok": true,
    "value": 50
  },
  "percentage_p0": {
    "ok": true,
    "value": 67
  },
  "percentage_third": {
    "ok": true,
    "value": 33.3333
  },
  "partition_cb": {
    "ok": true,
    "value": [
      {
        "2": 3,
        "3": 4
      },
      [
        1,
        2
      ]
    ]
  },
  "partition_key": {
    "ok": true,
    "value": [
      [
        {
          "a": 1
        }
      ],
      {
        "1": {
          "a": 0
        }
      }
    ]
  },
  "partition_where": {
    "ok": true,
    "value": [
      {
        "1": {
          "a": 2
        },
        "2": {
          "a": 3
        }
      },
      [
        {
          "a": 1
        }
      ]
    ]
  },
  "partition_keyed": {
    "ok": true,
    "value": [
      {
        "k": "y"
      },
      {
        "5": "x"
      }
    ]
  },
  "multiply": {
    "ok": true,
    "value": [
      1,
      2,
      1,
      2,
      1,
      2
    ]
  },
  "multiply_keyed": {
    "ok": true,
    "value": [
      1,
      1
    ]
  },
  "eachSpread": {
    "ok": true,
    "value": [
      "0:1-2",
      "1:3-4"
    ]
  },
  "mapSpread": {
    "ok": true,
    "value": [
      "0:1+2",
      "1:3+4"
    ]
  },
  "mapInto": {
    "ok": true,
    "value": [
      [
        1
      ],
      [
        2
      ]
    ]
  },
  "mapToDictionary": {
    "ok": true,
    "value": {
      "1": [
        "a",
        "b"
      ],
      "2": [
        "c"
      ]
    }
  },
  "mapToGroups": {
    "ok": true,
    "value": {
      "1": [
        "a",
        "b"
      ],
      "2": [
        "c"
      ]
    }
  },
  "flatMap": {
    "ok": true,
    "value": [
      1,
      2,
      3
    ]
  },
  "flatMap_keys": {
    "ok": true,
    "value": [
      1,
      2,
      3
    ]
  },
  "times": {
    "ok": true,
    "value": [
      1,
      2,
      3
    ]
  },
  "times_cb": {
    "ok": true,
    "value": [
      2,
      4,
      6
    ]
  },
  "times_zero": {
    "ok": true,
    "value": []
  },
  "range_up": {
    "ok": true,
    "value": [
      1,
      2,
      3,
      4
    ]
  },
  "range_step": {
    "ok": true,
    "value": [
      1,
      4,
      7,
      10
    ]
  },
  "range_down": {
    "ok": true,
    "value": [
      3,
      2,
      1
    ]
  },
  "fromJson": {
    "ok": true,
    "value": {
      "a": 1,
      "b": [
        2,
        3
      ]
    }
  },
  "fromJson_list": {
    "ok": true,
    "value": [
      1,
      2,
      3
    ]
  },
  "unwrap": {
    "ok": true,
    "value": {
      "a": 1
    }
  },
  "unwrap_plain": {
    "ok": true,
    "value": 5
  },
  "toPrettyJson": {
    "ok": true,
    "value": "{\n    \"a\": 1,\n    \"b\": [\n        1,\n        2\n    ],\n    \"c\": {\n        \"d\": \"e\"\n    }\n}"
  },
  "shift": {
    "ok": true,
    "value": 1
  },
  "shift1": {
    "ok": true,
    "value": [
      1,
      [
        2,
        3
      ]
    ]
  },
  "shift2": {
    "ok": true,
    "value": [
      [
        1,
        2
      ],
      [
        3
      ]
    ]
  },
  "shift_over": {
    "ok": true,
    "value": [
      1,
      2
    ]
  },
  "shift_zero": {
    "ok": true,
    "value": [
      [],
      [
        1,
        2
      ]
    ]
  },
  "shift_keyed": {
    "ok": true,
    "value": [
      "a",
      {
        "k": "b",
        "0": "c"
      }
    ]
  },
  "shift_neg": {
    "ok": true,
    "value": "InvalidArgumentException: Number of shifted items may not be less than zero."
  },
  "unshift": {
    "ok": true,
    "value": [
      "a",
      "b",
      "c"
    ]
  },
  "unshift_keyed": {
    "ok": true,
    "value": {
      "0": "a",
      "k": "v"
    }
  },
  "splice1": {
    "ok": true,
    "value": [
      [
        2,
        3,
        4
      ],
      [
        1
      ]
    ]
  },
  "splice2": {
    "ok": true,
    "value": [
      [
        2,
        3
      ],
      [
        1,
        4
      ]
    ]
  },
  "splice3": {
    "ok": true,
    "value": [
      [
        2,
        3
      ],
      [
        1,
        "a",
        "b",
        "c",
        4
      ]
    ]
  },
  "splice_keyed": {
    "ok": true,
    "value": [
      {
        "b": 2
      },
      {
        "a": 1,
        "0": "x",
        "c": 3
      }
    ]
  },
  "splice_neg": {
    "ok": true,
    "value": [
      [
        3,
        4
      ],
      [
        1,
        2
      ]
    ]
  },
  "union": {
    "ok": true,
    "value": {
      "a": 1,
      "b": 2,
      "c": 3
    }
  },
  "union_int": {
    "ok": true,
    "value": [
      1,
      2
    ]
  },
  "replace": {
    "ok": true,
    "value": {
      "a": 1,
      "b": 9,
      "c": 3
    }
  },
  "replace_int": {
    "ok": true,
    "value": [
      1,
      "x",
      3
    ]
  },
  "replaceRecursive": {
    "ok": true,
    "value": {
      "a": {
        "b": 9,
        "c": 2
      }
    }
  },
  "replaceRecursive_int": {
    "ok": true,
    "value": [
      1,
      9,
      3
    ]
  },
  "mergeRecursive": {
    "ok": true,
    "value": {
      "a": [
        1,
        2
      ],
      "b": 2,
      "c": 3
    }
  },
  "mergeRecursive_arr": {
    "ok": true,
    "value": {
      "a": [
        1,
        2,
        3
      ]
    }
  },
  "mergeRecursive_scalar_arr": {
    "ok": true,
    "value": {
      "a": [
        1,
        2
      ]
    }
  },
  "mergeRecursive_int": {
    "ok": true,
    "value": [
      1,
      2,
      3,
      4
    ]
  },
  "select_str": {
    "ok": true,
    "value": [
      {
        "b": 2
      },
      []
    ]
  },
  "select_arr": {
    "ok": true,
    "value": [
      {
        "c": 3,
        "a": 1
      }
    ]
  },
  "select_null": {
    "ok": true,
    "value": [
      1,
      2
    ]
  },
  "select_multi": {
    "ok": true,
    "value": [
      {
        "a": 1,
        "b": 2
      }
    ]
  },
  "add": {
    "ok": true,
    "value": {
      "k": "v",
      "0": "x"
    }
  },
  "add_int": {
    "ok": true,
    "value": {
      "5": "a",
      "6": "b"
    }
  },
  "before": {
    "ok": true,
    "value": "a"
  },
  "before_first": {
    "ok": true,
    "value": null
  },
  "before_missing": {
    "ok": true,
    "value": null
  },
  "after": {
    "ok": true,
    "value": "c"
  },
  "after_last": {
    "ok": true,
    "value": null
  },
  "after_keyed": {
    "ok": true,
    "value": "c"
  },
  "forPage": {
    "ok": true,
    "value": {
      "2": 3,
      "3": 4
    }
  },
  "forPage_page0": {
    "ok": true,
    "value": [
      1,
      2
    ]
  },
  "skipWhile": {
    "ok": true,
    "value": {
      "2": 3,
      "3": 1
    }
  },
  "skipWhile_val": {
    "ok": true,
    "value": {
      "1": 2,
      "2": 3,
      "3": 1
    }
  },
  "skipUntil": {
    "ok": true,
    "value": {
      "2": 3,
      "3": 1
    }
  },
  "skipUntil_val": {
    "ok": true,
    "value": {
      "2": 3,
      "3": 1
    }
  },
  "takeWhile": {
    "ok": true,
    "value": [
      1,
      2
    ]
  },
  "takeUntil": {
    "ok": true,
    "value": [
      1,
      2
    ]
  },
  "takeUntil_val": {
    "ok": true,
    "value": [
      1,
      2
    ]
  },
  "takeWhile_keyed": {
    "ok": true,
    "value": {
      "a": 1,
      "b": 2
    }
  },
  "chunkBy": {
    "ok": true,
    "value": [
      [
        1,
        1
      ],
      {
        "2": 2,
        "3": 2
      },
      {
        "4": 3
      }
    ]
  },
  "chunkBy_key": {
    "ok": true,
    "value": [
      [
        {
          "t": "a"
        },
        {
          "t": "a"
        }
      ],
      {
        "2": {
          "t": "b"
        }
      }
    ]
  },
  "chunkWhile": {
    "ok": true,
    "value": [
      [
        1,
        2,
        4,
        8
      ]
    ]
  },
  "chunkWhile_keyed": {
    "ok": true,
    "value": [
      {
        "a": 1,
        "b": 2
      },
      {
        "c": 9
      }
    ]
  },
  "collapseWithKeys": {
    "ok": true,
    "value": {
      "a": 3,
      "b": 2
    }
  },
  "collapseWithKeys_flat": {
    "ok": true,
    "value": [
      3,
      2
    ]
  },
  "collapseWithKeys_skip": {
    "ok": true,
    "value": {
      "a": 1
    }
  },
  "sliding": {
    "ok": true,
    "value": [
      [
        1,
        2
      ],
      {
        "1": 2,
        "2": 3
      },
      {
        "2": 3,
        "3": 4
      }
    ]
  },
  "sliding_step": {
    "ok": true,
    "value": [
      [
        1,
        2,
        3
      ],
      {
        "2": 3,
        "3": 4,
        "4": 5
      }
    ]
  },
  "sliding_large": {
    "ok": true,
    "value": []
  },
  "sliding_keyed": {
    "ok": true,
    "value": [
      {
        "a": 1,
        "b": 2
      },
      {
        "b": 2,
        "c": 3
      }
    ]
  },
  "sliding_err": {
    "ok": true,
    "value": "InvalidArgumentException: Size value must be at least 1."
  },
  "sortKeys": {
    "ok": true,
    "value": {
      "a": 2,
      "b": 1
    }
  },
  "sortKeys_int": {
    "ok": true,
    "value": {
      "2": "y",
      "10": "x"
    }
  },
  "sortKeysDesc": {
    "ok": true,
    "value": {
      "b": 1,
      "a": 2
    }
  },
  "sortKeysUsing": {
    "ok": true,
    "value": {
      "a": 2,
      "b": 1
    }
  },
  "diffKeys": {
    "ok": true,
    "value": {
      "1": 2,
      "2": 3
    }
  },
  "diffKeys_str": {
    "ok": true,
    "value": {
      "b": 2
    }
  },
  "diffAssoc": {
    "ok": true,
    "value": {
      "b": 2
    }
  },
  "diffAssoc_int": {
    "ok": true,
    "value": {
      "1": 2
    }
  },
  "diffAssocUsing": {
    "ok": true,
    "value": {
      "a": 1,
      "b": 2
    }
  },
  "diffKeysUsing": {
    "ok": true,
    "value": {
      "a": 1,
      "b": 2
    }
  },
  "diffUsing": {
    "ok": true,
    "value": {
      "0": 1,
      "2": 3
    }
  },
  "intersectByKeys": {
    "ok": true,
    "value": {
      "b": 2
    }
  },
  "intersectAssoc": {
    "ok": true,
    "value": {
      "b": 2
    }
  },
  "intersectAssoc_str": {
    "ok": true,
    "value": []
  },
  "intersectAssocUsing": {
    "ok": true,
    "value": []
  },
  "intersectUsing": {
    "ok": true,
    "value": {
      "1": 2,
      "2": 3
    }
  },
  "containsStrict_true": {
    "ok": true,
    "value": false
  },
  "containsStrict_false": {
    "ok": true,
    "value": true
  },
  "containsStrict_kv": {
    "ok": true,
    "value": true
  },
  "containsStrict_kv_loose": {
    "ok": true,
    "value": false
  },
  "containsStrict_cb": {
    "ok": true,
    "value": true
  },
  "containsStrict_cb_phpfalse": {
    "ok": true,
    "value": false
  },
  "containsStrict_cb_phpfalse2": {
    "ok": true,
    "value": false
  },
  "containsStrict_cb_phptrue": {
    "ok": true,
    "value": true
  },
  "doesntContain": {
    "ok": true,
    "value": false
  },
  "doesntContainStrict": {
    "ok": true,
    "value": false
  },
  "duplicatesStrict": {
    "ok": true,
    "value": {
      "2": 1
    }
  },
  "hasSole": {
    "ok": true,
    "value": true
  },
  "hasSole_cb": {
    "ok": true,
    "value": true
  },
  "hasSole_key": {
    "ok": false,
    "value": "TypeError: Illuminate\\Support\\Collection::filter(): Argument #1 ($callback) must be of type ?callable, string given, called in C:\\Users\\HP\\AppData\\Local\\Temp\\opencode\\lw-fresh-e2e\\fresh-app\\vendor\\laravel\\framework\\src\\Illuminate\\Conditionable\\HigherOrderWhenProxy.php on line 105"
  },
  "hasMany": {
    "ok": true,
    "value": true
  },
  "hasMany_cb": {
    "ok": true,
    "value": true
  },
  "containsOneItem": {
    "ok": true,
    "value": true
  },
  "containsOneItem_cb": {
    "ok": true,
    "value": true
  },
  "containsManyItems": {
    "ok": true,
    "value": true
  },
  "whereBetween": {
    "ok": true,
    "value": [
      {
        "a": 2
      },
      {
        "a": 3
      }
    ]
  },
  "whereNotBetween": {
    "ok": true,
    "value": [
      {
        "a": 1
      }
    ]
  },
  "whereBetween_keyed": {
    "ok": true,
    "value": {
      "x": {
        "a": 2
      }
    }
  },
  "whereInstanceOf": {
    "ok": true,
    "value": 2
  },
  "whereInstanceOf_fqcn": {
    "ok": true,
    "value": 2
  },
  "whereInstanceOf_fqcn_list": {
    "ok": true,
    "value": 2
  },
  "unlessEmpty": {
    "ok": true,
    "value": "yes"
  },
  "unlessEmpty_empty": {
    "ok": true,
    "value": "fallback"
  },
  "unlessNotEmpty": {
    "ok": true,
    "value": "yes"
  },
  "value_hit": {
    "ok": true,
    "value": 1
  },
  "value_miss": {
    "ok": true,
    "value": null
  },
  "value_miss_default": {
    "ok": true,
    "value": "D"
  },
  "value_miss_closure": {
    "ok": true,
    "value": "D"
  },
  "value_null_item": {
    "ok": true,
    "value": null
  },
  "value_null_item_default": {
    "ok": true,
    "value": null
  },
  "value_dot": {
    "ok": true,
    "value": 5
  },
  "value_dot_miss": {
    "ok": true,
    "value": "D"
  },
  "value_keyed": {
    "ok": true,
    "value": 7
  },
  "value_scalar_items": {
    "ok": true,
    "value": "D"
  },
  "ensure_ok": {
    "ok": true,
    "value": [
      1,
      2
    ]
  },
  "ensure_bad": {
    "ok": false,
    "value": "UnexpectedValueException: Collection should only include [int] items, but 'string' found at position 1."
  },
  "ensure_multi": {
    "ok": true,
    "value": [
      1,
      "a"
    ]
  },
  "ensure_array": {
    "ok": true,
    "value": [
      [
        1
      ]
    ]
  },
  "ensure_bool": {
    "ok": true,
    "value": [
      true
    ]
  },
  "pipe_into": {
    "ok": true,
    "value": [
      2,
      4
    ]
  },
  "pipe_through": {
    "ok": true,
    "value": 5
  },
  "pipe_through_empty": {
    "ok": true,
    "value": [
      1
    ]
  },
  "to_base": {
    "ok": true,
    "value": {
      "a": 1
    }
  },
  "collect_copy": {
    "ok": true,
    "value": {
      "a": 1
    }
  },
  "escape_default_to_string": {
    "ok": true,
    "value": "[\"<b>\"]"
  },
  "escape_false_to_string": {
    "ok": true,
    "value": "[\"<b>\"]"
  },
  "escape_true_to_string": {
    "ok": true,
    "value": "[&quot;&lt;b&gt;&quot;]"
  },
  "escape_chain_flags": {
    "ok": true,
    "value": "[1]"
  }
};

const CASES = new Map(Object.entries({

  reduce: () => make([1, 2, 3]).reduce((c, v, k) => c + '[' + k + ':' + v + ']', ''),
  reduce_keys: () => make({ a: 1, b: 2 }).reduceWithKeys((c, v, k) => c + k, ''),
  reduceInto: () => make([1, 2]).reduceInto([], (a, v, k) => { a.push(`${k}=${v}`); }),
  reduceSpread: () => make([1, 2]).reduceSpread((a, b, v, k) => [b + v, a], 10, 20),
  reduceSpread_err: () => { try { make([1]).reduceSpread((a, v) => 'x', 1); return 'no-error'; } catch (e) { return e.name + ': ' + e.message; } },
  average: () => make([2, 4]).average(),
  average_cb: () => make([{ n: 2 }, { n: 4 }]).average((i) => i.n),
  percentage_empty: () => make([]).percentage(() => true),
  percentage: () => make([1, 2, 3, 4]).percentage((v) => v % 2 === 0),
  percentage_p0: () => make([1, 2, 3]).percentage((v) => v > 1, 0),
  percentage_third: () => make([1, 2, 3]).percentage((v) => v > 2, 4),
  partition_cb: () => make([1, 2, 3, 4]).partition((v) => v > 2).map(group).all(),
  partition_key: () => make([{ a: 1 }, { a: 0 }]).partition('a').map(group).all(),
  partition_where: () => make([{ a: 1 }, { a: 2 }, { a: 3 }]).partition('a', '>', 1).map(group).all(),
  partition_keyed: () => make({ 5: 'x', k: 'y' }).partition((v) => v === 'y').map(group).all(),
  multiply: () => make([1, 2]).multiply(3).all(),
  multiply_keyed: () => make({ a: 1 }).multiply(2).all(),
  eachSpread: () => { const out = []; make([[1, 2], [3, 4]]).eachSpread((a, b, k) => { out.push(`${k}:${a}-${b}`); }); return out; },
  mapSpread: () => make([[1, 2], [3, 4]]).mapSpread((a, b, k) => `${k}:${a}+${b}`).all(),
  mapInto: () => make([1, 2]).mapInto(C).map((c) => c.all()).all(),
  mapToDictionary: () => make([[1, 'a'], [1, 'b'], [2, 'c']]).mapToDictionary((i) => ({ [i[0]]: i[1] })).all(),
  mapToGroups: () => make([[1, 'a'], [1, 'b'], [2, 'c']]).mapToGroups((i) => ({ [i[0]]: i[1] })).map(group).all(),
  flatMap: () => make([[1, 2], [3]]).flatMap((i) => i).all(),
  flatMap_keys: () => make({ a: [1, 2], b: [3] }).flatMap((i) => i).all(),
  times: () => C.times(3).all(),
  times_cb: () => C.times(3, (n) => n * 2).all(),
  times_zero: () => C.times(0).all(),
  range_up: () => C.range(1, 4).all(),
  range_step: () => C.range(1, 10, 3).all(),
  range_down: () => C.range(3, 1).all(),
  fromJson: () => C.fromJson('{"a":1,"b":[2,3]}').all(),
  fromJson_list: () => C.fromJson('[1,2,3]').all(),
  unwrap: () => C.unwrap(make({ a: 1 })),
  unwrap_plain: () => C.unwrap(5),
  toPrettyJson: () => make({ a: 1, b: [1, 2], c: { d: 'e' } }).toPrettyJson(),
  shift: () => make([1, 2, 3]).shift(),
  shift1: () => { const c = make([1, 2, 3]); const v = c.shift(); return [v, c.all()]; },
  shift2: () => { const c = make([1, 2, 3]); const v = c.shift(2); return [v.all(), c.all()]; },
  shift_over: () => { const c = make([1, 2]); return c.shift(5).all(); },
  shift_zero: () => { const c = make([1, 2]); return [c.shift(0).all(), c.all()]; },
  shift_keyed: () => { const c = new C(['a', 'b', 'c'], [5, 'k', 9]); const v = c.shift(); return [v, c.all()]; },
  shift_neg: () => { try { make([1]).shift(-1); return 'no-error'; } catch (e) { return e.name + ': ' + e.message; } },
  unshift: () => { const c = make({ 3: 'c' }); c.unshift('a', 'b'); return c.all(); },
  unshift_keyed: () => { const c = make({ k: 'v' }); c.unshift('a'); return c.all(); },
  splice1: () => { const c = make([1, 2, 3, 4]); return [c.splice(1).all(), c.all()]; },
  splice2: () => { const c = make([1, 2, 3, 4]); return [c.splice(1, 2).all(), c.all()]; },
  splice3: () => { const c = make([1, 2, 3, 4]); return [c.splice(1, 2, ['a', 'b', 'c']).all(), c.all()]; },
  splice_keyed: () => { const c = make({ a: 1, b: 2, c: 3 }); return [c.splice(1, 1, ['x']).all(), c.all()]; },
  splice_neg: () => { const c = make([1, 2, 3, 4]); return [c.splice(-2).all(), c.all()]; },
  union: () => make({ a: 1, b: 2 }).union({ b: 9, c: 3 }).all(),
  union_int: () => make([1, 2]).union([9, 8]).all(),
  replace: () => make({ a: 1, b: 2 }).replace({ b: 9, c: 3 }).all(),
  replace_int: () => make([1, 2, 3]).replace({ 1: 'x' }).all(),
  replaceRecursive: () => make({ a: { b: 1, c: 2 } }).replaceRecursive({ a: { b: 9 } }).all(),
  replaceRecursive_int: () => make([1, 2, 3]).replaceRecursive({ 1: 9 }).all(),
  mergeRecursive: () => make({ a: 1, b: 2 }).mergeRecursive({ a: 2, c: 3 }).all(),
  mergeRecursive_arr: () => make({ a: [1] }).mergeRecursive({ a: [2, 3] }).all(),
  mergeRecursive_scalar_arr: () => make({ a: 1 }).mergeRecursive({ a: [2] }).all(),
  mergeRecursive_int: () => make([1, 2]).mergeRecursive([3, 4]).all(),
  select_str: () => make([{ a: 1, b: 2 }, { a: 3 }]).select('b').all(),
  select_arr: () => make([{ a: 1, b: 2, c: 3 }]).select(['c', 'a']).all(),
  select_null: () => make([1, 2]).select(null).all(),
  select_multi: () => make([{ a: 1, b: 2 }]).select('a', 'b').all(),
  add: () => { const c = make({ k: 'v' }); return c.add('x') === c ? c.all() : 'not-same'; },
  add_int: () => { const c = make({ 5: 'a' }); c.add('b'); return c.all(); },
  before: () => make(['a', 'b', 'c']).before('b'),
  before_first: () => make(['a', 'b']).before('a'),
  before_missing: () => make(['a', 'b']).before('z'),
  after: () => make(['a', 'b', 'c']).after('b'),
  after_last: () => make(['a', 'b']).after('b'),
  after_keyed: () => make({ x: 'a', y: 'b', z: 'c' }).after('b'),
  forPage: () => make([1, 2, 3, 4, 5]).forPage(2, 2).all(),
  forPage_page0: () => make([1, 2, 3]).forPage(0, 2).all(),
  skipWhile: () => make([1, 2, 3, 1]).skipWhile((v) => v < 3).all(),
  skipWhile_val: () => make([1, 2, 3, 1]).skipWhile(1).all(),
  skipUntil: () => make([1, 2, 3, 1]).skipUntil((v) => v === 3).all(),
  skipUntil_val: () => make([1, 2, 3, 1]).skipUntil(3).all(),
  takeWhile: () => make([1, 2, 3, 1]).takeWhile((v) => v < 3).all(),
  takeUntil: () => make([1, 2, 3, 1]).takeUntil((v) => v === 3).all(),
  takeUntil_val: () => make([1, 2, 3, 1]).takeUntil(3).all(),
  takeWhile_keyed: () => make({ a: 1, b: 2, c: 3 }).takeWhile((v) => v < 3).all(),
  chunkBy: () => make([1, 1, 2, 2, 3]).chunkBy((v) => v).map(group).all(),
  chunkBy_key: () => make([{ t: 'a' }, { t: 'a' }, { t: 'b' }]).chunkBy('t').map(group).all(),
  chunkWhile: () => make([1, 2, 4, 8]).chunkWhile((v, k, chunk) => v === chunk.last() * 2).map(group).all(),
  chunkWhile_keyed: () => make({ a: 1, b: 2, c: 9 }).chunkWhile((v, k, chunk) => v === chunk.last() * 2).map(group).all(),
  collapseWithKeys: () => make([{ a: 1 }, { b: 2 }, { a: 3 }]).collapseWithKeys().all(),
  collapseWithKeys_flat: () => make([[1, 2], [3]]).collapseWithKeys().all(),
  collapseWithKeys_skip: () => make([{ a: 1 }, 5, 'x']).collapseWithKeys().all(),
  sliding: () => make([1, 2, 3, 4]).sliding(2).map(group).all(),
  sliding_step: () => make([1, 2, 3, 4, 5]).sliding(3, 2).map(group).all(),
  sliding_large: () => make([1, 2]).sliding(5).map(group).all(),
  sliding_keyed: () => make({ a: 1, b: 2, c: 3 }).sliding(2).map(group).all(),
  sliding_err: () => { try { make([1]).sliding(0); return 'no-error'; } catch (e) { return e.name + ': ' + e.message; } },
  sortKeys: () => make({ b: 1, a: 2 }).sortKeys().all(),
  sortKeys_int: () => make({ 10: 'x', 2: 'y' }).sortKeys().all(),
  sortKeysDesc: () => make({ b: 1, a: 2 }).sortKeysDesc().all(),
  sortKeysUsing: () => make({ b: 1, a: 2 }).sortKeysUsing((a, b) => cmp(String(a), String(b))).all(),
  diffKeys: () => make([1, 2, 3]).diffKeys([1]).all(),
  diffKeys_str: () => make({ a: 1, b: 2 }).diffKeys({ a: 9 }).all(),
  diffAssoc: () => make({ a: 1, b: 2 }).diffAssoc({ a: 1, b: 9 }).all(),
  diffAssoc_int: () => make([1, 2]).diffAssoc([1]).all(),
  diffAssocUsing: () => make({ a: 1, b: 2 }).diffAssocUsing({ A: 1 }, (a, b) => cmp(String(a), String(b))).all(),
  diffKeysUsing: () => make({ a: 1, b: 2 }).diffKeysUsing({ A: 1 }, (a, b) => cmp(String(a), String(b))).all(),
  diffUsing: () => make([1, 2, 3]).diffUsing([2], (a, b) => cmp(a, b)).all(),
  intersectByKeys: () => make({ a: 1, b: 2 }).intersectByKeys({ b: 9 }).all(),
  intersectAssoc: () => make({ a: 1, b: 2 }).intersectAssoc({ b: 2, a: 9 }).all(),
  intersectAssoc_str: () => make([1, 2]).intersectAssoc({ 1: 1 }).all(),
  intersectAssocUsing: () => make({ a: 1 }).intersectAssocUsing({ A: 1 }, (a, b) => cmp(String(a), String(b))).all(),
  intersectUsing: () => make([1, 2, 3]).intersectUsing([2, 3], (a, b) => cmp(a, b)).all(),
  containsStrict_true: () => make([1]).containsStrict('1'),
  containsStrict_false: () => make([1]).containsStrict(1),
  containsStrict_kv: () => make([{ a: 1 }]).containsStrict('a', 1),
  containsStrict_kv_loose: () => make([{ a: 1 }]).containsStrict('a', '1'),
  containsStrict_cb: () => make([1, 2]).containsStrict((v) => v > 1),
  // PHP casts the predicate's return with array_any()'s bool cast: '0' and ''
  // are FALSE (JS Boolean() would say true).
  containsStrict_cb_phpfalse: () => make([1, 2]).containsStrict(() => '0'),
  containsStrict_cb_phpfalse2: () => make([1, 2]).containsStrict(() => ''),
  containsStrict_cb_phptrue: () => make([1, 2]).containsStrict(() => '1'),
  doesntContain: () => make([1]).doesntContain('1'),
  doesntContainStrict: () => make([1]).doesntContainStrict(1),
  duplicatesStrict: () => make([1, '1', 1]).duplicatesStrict().all(),
  hasSole: () => make([1]).hasSole(),
  hasSole_cb: () => make([1, 2]).hasSole((v) => v > 1),
  hasSole_key: () => make([{ a: 1 }, { a: 1 }]).hasSole('a'),
  hasMany: () => make([1, 2]).hasMany(),
  hasMany_cb: () => make([1, 2, 3]).hasMany((v) => v > 1),
  containsOneItem: () => make([1]).containsOneItem(),
  containsOneItem_cb: () => make([1, 2]).containsOneItem((v) => v > 1),
  containsManyItems: () => make([1, 2]).containsManyItems(),
  whereBetween: () => make([{ a: 1 }, { a: 2 }, { a: 3 }]).whereBetween('a', [2, 3]).values().all(),
  whereNotBetween: () => make([{ a: 1 }, { a: 2 }, { a: 3 }]).whereNotBetween('a', [2, 3]).values().all(),
  whereBetween_keyed: () => make({ x: { a: 2 }, y: { a: 5 } }).whereBetween('a', [1, 3]).all(),
  whereInstanceOf: () => make([make([]), [1], make([2])]).whereInstanceOf(C).count(),
  // `Model::class` compiles to the FQCN STRING, so the string rung must read the
  // compiled class marker (`__lwClass`) - a probe of a real compiled instance.
  whereInstanceOf_fqcn: () => {
    const inst = (fqcn) => {
      const o = {};
      Object.defineProperty(o, '__lwClass', { value: fqcn, enumerable: false });
      return o;
    };
    return make([inst('Foo'), inst('Bar'), inst('Foo')]).whereInstanceOf('Foo').count();
  },
  whereInstanceOf_fqcn_list: () => {
    const inst = (fqcn) => {
      const o = {};
      Object.defineProperty(o, '__lwClass', { value: fqcn, enumerable: false });
      return o;
    };
    return make([inst('Foo'), inst('Bar')]).whereInstanceOf(['Foo', 'Bar']).count();
  },
  unlessEmpty: () => make([1]).unlessEmpty(() => 'yes'),
  unlessEmpty_empty: () => make([]).unlessEmpty(() => 'yes', () => 'fallback'),
  unlessNotEmpty: () => make([]).unlessNotEmpty(() => 'yes'),
}));

const MORE_CASES = {

  value_hit: () => make([{ a: 1 }, { a: 2 }]).value('a'),
  value_miss: () => make([{ a: 1 }]).value('b'),
  value_miss_default: () => make([{ a: 1 }]).value('b', 'D'),
  value_miss_closure: () => make([{ a: 1 }]).value('b', () => 'D'),
  value_null_item: () => make([{ a: null }, { a: 2 }]).value('a'),
  value_null_item_default: () => make([{ a: null }]).value('a', 'D'),
  value_dot: () => make([{ a: { b: 5 } }]).value('a.b'),
  value_dot_miss: () => make([{ a: { b: 5 } }]).value('a.c', 'D'),
  value_keyed: () => new C([{ a: 7 }], ['x']).value('a'),
  value_scalar_items: () => make([1, 2]).value('a', 'D'),
  ensure_ok: () => make([1, 2]).ensure('int').all(),
  ensure_bad: () => make([1, 'a']).ensure('int').all(),
  ensure_multi: () => make([1, 'a']).ensure(['int', 'string']).all(),
  ensure_array: () => make([[1]]).ensure('array').all(),
  ensure_bool: () => make([true]).ensure('bool').all(),
  pipe_into: () => make([1, 2]).pipeInto(PipeTarget).doubled(),
  pipe_through: () => make([1, 2]).pipeThrough([(c) => c.map((v) => v + 1), (c) => c.sum()]),
  pipe_through_empty: () => make([1]).pipeThrough([]).all(),
  to_base: () => make({ a: 1 }).toBase().all(),
  collect_copy: () => make({ a: 1 }).collect().all(),
  escape_default_to_string: () => make(['<b>']).toString(),
  escape_false_to_string: () => make(['<b>']).escapeWhenCastingToString(false).toString(),
  escape_true_to_string: () => make(['<b>']).escapeWhenCastingToString(true).toString(),
  escape_chain_flags: () => make([1]).escapeWhenCastingToString(false).escapeWhenCastingToString().toJson(),
};

test("collection methods: PHP's own answer, case by case", () => {
  const ids = [...CASES.keys(), ...Object.keys(MORE_CASES)];
  assert.equal(ids.length, Object.keys(EXPECTED).length, 'every case has an expectation');
  for (const id of ids) {
    const expected = EXPECTED[id];
    if (!expected) throw new Error('no baked expectation for ' + id);
    const thunk = CASES.has(id) ? CASES.get(id) : MORE_CASES[id];
    let actual;
    let threw = null;
    try {
      actual = thunk();
    } catch (err) {
      threw = err;
    }
    if (expected.ok === false) {
      assert.ok(threw, id + ': PHP threw, the kernel answered ' + phpJsonEncode(actual === undefined ? null : actual));
      assert.equal(threw.name || 'Error', String(expected.value).split(':')[0], id);
      continue;
    }
    if (threw) throw new Error(id + ' threw: ' + threw.name + ': ' + threw.message);
    assert.equal(
      phpJsonEncode(actual === undefined ? null : actual),
      phpJsonEncode(expected.value),
      id
    );
  }
});

test('value()/ensure(): the shapes PHP answers', () => {
  // A null VALUE counts as present (data_has), so the default is NOT used.
  assert.equal(make([{ a: null }]).value('a', 'D'), null);
  assert.equal(make([{ a: null }, { a: 2 }]).value('a'), null);
  assert.equal(make([{ a: 1 }]).value('b', () => 'D'), 'D');
  assert.equal(make([{ a: { b: 5 } }]).value('a.c', 'D'), 'D');
  // ensure() answers the RECEIVER and reports the position as the PHP key.
  const keyed = new Collection([1, 'a'], ['x', 'y']);
  assert.equal(keyed.ensure(['int', 'string']), keyed);
  assert.throws(() => keyed.ensure('int'), (err) => err.name === 'UnexpectedValueException' &&
    /should only include \[int\] items, but 'string' found at position y\./.test(err.message));
});

test('toBase()/collect(): a copy that keeps the PHP keys', () => {
  const keyed = new Collection(['a'], ['x']);
  assert.deepEqual(keyed.toBase().all(), { x: 'a' });
  assert.deepEqual(keyed.collect().all(), { x: 'a' });
  assert.notEqual(keyed.toBase(), keyed);
});

test('mapInto()/pipeInto(): an FQCN string goes through the runtime registry', () => {
  // `SomeModel::class` compiles to the FQCN string; only the runtime can build
  // a compiled class (its constructor takes the dependency bundle).
  const seen = [];
  const previous = Collection.__lwNewClass;
  Collection.__lwNewClass = (fqcn, args) => {
    seen.push([fqcn, args]);
    return { fqcn, args };
  };
  try {
    assert.deepEqual(make([1, 2]).mapInto('App\\Models\\Post').all(), [
      { fqcn: 'App\\Models\\Post', args: [1, 0] },
      { fqcn: 'App\\Models\\Post', args: [2, 1] },
    ]);
    assert.equal(make([1]).pipeInto('App\\Pipes\\Sum').fqcn, 'App\\Pipes\\Sum');
    assert.equal(seen[2][0], 'App\\Pipes\\Sum');
    // `new $class($this)`: the receiver is the single argument.
    assert.ok(seen[2][1][0] instanceof Collection);
    assert.deepEqual(seen[2][1][0].all(), [1]);
  } finally {
    Collection.__lwNewClass = previous;
  }
  // Without the hook a class STRING is a named failure, not a silent nothing.
  assert.throws(() => make([1]).pipeInto('App\\Nope'), /cannot be constructed at the edge/);
});

test('__toString() honours escapeWhenCastingToString()', () => {
  // A probe: the DEFAULT is unescaped, an explicit true escapes once.
  assert.equal(String(make(['<b>'])), '["<b>"]');
  assert.equal(String(make(['<b>']).escapeWhenCastingToString(false)), '["<b>"]');
  assert.equal(String(make(['<b>']).escapeWhenCastingToString(true)), '[&quot;&lt;b&gt;&quot;]');
  assert.equal(make([1]).escapeWhenCastingToString(false).escapeWhenCastingToString().toJson(), '[1]');
});
