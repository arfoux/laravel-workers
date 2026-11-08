// kernel/php-loose-eq.mjs — PHP 8's `==` (`in_array()` without strict,
// `array_unique(SORT_REGULAR)`, `where($k, '=', $v)`) over the values an edge
// application sees.
//
// ONE definition, two consumers: `kernel/collections.mjs` (`contains()`,
// `search()`, `unique()`, `duplicates()`, `where()`) and `kernel/validator.mjs`
// (`in`, `contains`, `distinct`). The validator used to carry its own copy that
// had no array branch at all, so `distinct` over array values and `in` against
// an array parameter answered the opposite of Laravel.
//
// The rules are PHP 8's, verified pair by pair against the 8.3 oracle:
//   - a BOOL on either side casts BOTH to `(bool)` (`[] == false` is true,
//     `[1] == true` is true, `'0' == false` is true);
//   - null against a string is `$string === ''` (NOT `'0'`: `null == '0'` is
//     FALSE in PHP 8), against anything else it is `(bool) $other`;
//   - an ARRAY never equals a scalar (`[] == 0`, `[] == ''`, `[1] == 1`,
//     `[1] == 'a'`, `[] == (object) []` are all false) but equals
//     `''`-empty/false by the bool rule; two arrays compare STRUCTURALLY with
//     loose values and keys coerced as PHP array keys (`[1] == [true]`);
//   - an OBJECT never equals a scalar except the number `1` (PHP casts the
//     object to int with a warning; `(int) $anyObject === 1`);
//   - two objects compare equal when the same class has loosely-equal
//     properties;
//   - two numeric strings compare NUMERICALLY (`'1e2' == '100'`), otherwise
//     strings compare byte-wise.
//
// `isCollection` lets the caller supply its own Collection test (the kernel
// Collection lives in collections.mjs, which imports this file, so it cannot be
// imported back here). It defaults to "not a Collection".

/** True for values PHP compares as numbers (numbers plus numeric strings). */
export const isNumericForLooseEq = (v) =>
  typeof v === 'number' ||
  (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)));

/**
 * PHP's `(bool)` cast: the falsy strings are exactly `''` and `'0'`, `-0.0` is
 * false, **NAN is TRUE** (`(bool) NAN === true`, which JS's `!!` gets wrong),
 * `(bool) []` is FALSE and any non-empty array is TRUE.
 */
export const phpBool = (v, isCollection = () => false) => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return !(v === 0);
  if (typeof v === 'string') return !(v === '' || v === '0');
  if (Array.isArray(v)) return v.length > 0;
  if (isCollection(v)) return v.count() > 0;
  return true;
};

/** PHP's class name for `==` on objects (`get_class()` of a plain object is `stdClass`). */
export const phpClassTag = (v) => {
  if (Array.isArray(v)) return 'Array';
  const name = v && v.constructor && v.constructor.name;
  return typeof name === 'string' && name !== 'Object' ? name : 'Object';
};

/** PHP's array key coercion: a canonical decimal integer string becomes the int. */
export const phpArrayKey = (v) => {
  if (v === null || v === undefined) return '';
  if (v === true) return 1;
  if (v === false) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : v;
  if (typeof v === 'string' && /^(?:0|-?[1-9]\d*)$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  return v;
};

/**
 * A number against a string (`==`) — kept for callers that already use it, but
 * it now DELEGATES to the one canon (`phpScalarEquals`) so it cannot drift from
 * it again. The old body answered `0 == ''` with true; PHP 8 answers false (it
 * only casts a NUMERIC string, and `''` is not one). The kernel itself does not
 * call this helper.
 */
export const phpNumberEquals = (num, str) => typeof num === 'number' && phpScalarEquals(num, str);

/** `{key, value}` entries of an array or a PHP-array-shaped object. */
export const entriesOf = (value, isCollection = () => false) => {
  if (isCollection(value)) {
    const array = value.phpArray();
    if (Array.isArray(array)) return array.map((item, index) => ({ key: index, value: item }));
    return Object.entries(array).map(([key, item]) => ({ key: phpArrayKey(key), value: item }));
  }
  if (Array.isArray(value)) return value.map((item, index) => ({ key: index, value: item }));
  if (value !== null && value !== undefined && typeof value === 'object') {
    // A keyed PHP array carries its INSERTION order in the non-enumerable
    // `__lwOrder` marker (`rt.assoc()`, `Collection::phpArray()`, `Arr::dot()`):
    // JS lists an integer-like key FIRST, so `Object.entries()` alone would walk
    // `{"k":1, 0:2}` as `0, k` where PHP walks `k, 0`.
    const order = Array.isArray(value.__lwOrder) ? value.__lwOrder : null;
    if (order) return order.map((key) => ({ key: phpArrayKey(key), value: value[key] }));
    return Object.entries(value).map(([key, item]) => ({ key: phpArrayKey(key), value: item }));
  }
  return null;
};

/**
 * Two PHP ARRAYS with `==`: the same key set (keys coerced) and each value
 * loosely equal, order-insensitive.
 */
export const phpArrayLooseEquals = (a, b, looseEq, isCollection = () => false) => {
  const ea = entriesOf(a, isCollection);
  const eb = entriesOf(b, isCollection);
  if (!ea || !eb || ea.length !== eb.length) return false;
  const used = new Set();
  for (const entry of ea) {
    let matched = false;
    for (let i = 0; i < eb.length; i += 1) {
      if (used.has(i)) continue;
      if (String(phpArrayKey(eb[i].key)) !== String(phpArrayKey(entry.key))) continue;
      if (!looseEq(entry.value, eb[i].value)) continue;
      used.add(i);
      matched = true;
      break;
    }
    if (!matched) return false;
  }
  return true;
};

/**
 * `make(result, phpBool, isCollection)` returns the flat `looseEq` plus the
 * recursive `phpLooseEquals`. `looseEq` is the caller's scalar primitive (it
 * already owns PHP's numeric-string handling).
 */
export function makeLooseEq({ scalarEq, isCollection = () => false }) {
  const bool = (v) => phpBool(v, isCollection);
  const looseEq = (a, b) => {
    const aNull = a === null || a === undefined;
    const bNull = b === null || b === undefined;
    if (aNull || bNull) {
      const other = aNull ? b : a;
      if (aNull && bNull) return true;
      if (typeof other === 'string') return other === '';
      return bool(other) === false;
    }
    // A BOOL on either side casts BOTH to bool (probed: `[] == false` is true
    // and `[1] == true` is true - the array cast is `count() > 0`), so this
    // branch must come BEFORE the array/object one.
    if (typeof a === 'boolean' || typeof b === 'boolean') return bool(a) === bool(b);
    const aArr = Array.isArray(a) || isCollection(a);
    const bArr = Array.isArray(b) || isCollection(b);
    if (aArr || bArr) {
      // PHP never answers `==` between an array and a scalar (probed: `[] == 0`,
      // `[] == ''`, `[1] == 1`, `[1] == 'a'`, `[] == (object) []` are all
      // false), and two arrays compare structurally with LOOSE values and keys
      // compared as array keys (probed: `[1] == [true]` is true).
      if (aArr && bArr) return phpArrayLooseEquals(a, b, looseEq, isCollection);
      return false;
    }
    if (typeof a === 'object' || typeof b === 'object') {
      // Two objects: the same class with loosely-equal properties (probed:
      // `(object)['x'=>1] == (object)['x'=>1]` is true).
      if (typeof a === 'object' && typeof b === 'object') return phpLooseEquals(a, b);
      // An object against a NUMBER casts the object to int (PHP warns);
      // `(int)` of any object is 1, so only `== 1` answers true (probed:
      // `obj == 1` true, `obj == 1.5` / `obj == 0` / `obj == '1'` false).
      const other = typeof a === 'object' ? b : a;
      return typeof other === 'number' && !Number.isNaN(other) && other === 1;
    }
    return scalarEq(a, b);
  };

  const phpLooseEquals = (a, b) => {
    if (a === b) return true;
    // A PHP ARRAY is compared by its keys and (loosely) its values, never by
    // class or identity: `[1,2] == [1,'2']` is true and `[1] == [true]` is true
    // (probed). Without this branch two Collection items only matched when they
    // were the SAME object.
    const aArr = Array.isArray(a) || isCollection(a);
    const bArr = Array.isArray(b) || isCollection(b);
    if (aArr || bArr) {
      const other = aArr ? b : a;
      // `in_array(null, [[]])` is TRUE in PHP because `null == []` (both falsy
      // via `(bool)`), while `null == [1]` is false - the same rule as
      // `== false`.
      if (other === null || other === undefined || typeof other === 'boolean') {
        return bool(aArr ? a : b) === bool(other);
      }
      return aArr && bArr && phpArrayLooseEquals(a, b, looseEq, isCollection);
    }
    const aObj = a !== null && typeof a === 'object';
    const bObj = b !== null && typeof b === 'object';
    if (aObj || bObj) {
      if (!aObj || !bObj) return false;
      if (phpClassTag(a) !== phpClassTag(b)) return false;
      const attrs = (v) => (v.attributes && typeof v.attributes === 'object' ? v.attributes : null);
      const aAttrs = attrs(a);
      const bAttrs = attrs(b);
      const ka = aAttrs ? Object.keys(aAttrs) : Object.keys(a).filter((k) => !k.startsWith('_'));
      const kb = bAttrs ? Object.keys(bAttrs) : Object.keys(b).filter((k) => !k.startsWith('_'));
      if (ka.length !== kb.length) return false;
      return ka.every((k) =>
        aAttrs
          ? Object.prototype.hasOwnProperty.call(bAttrs, k) && phpLooseEquals(aAttrs[k], bAttrs[k])
          : Object.prototype.hasOwnProperty.call(b, k) && phpLooseEquals(a[k], b[k])
      );
    }
    return looseEq(a, b);
  };

  return { looseEq, phpLooseEquals };
}

/**
 * PHP 8's `==` for two SCALARS (`in_array($v, $items)` without strict, and
 * `where($k, '=', $v)` -> `operatorForWhere()` -> `==`), verified against the
 * 8.3 oracle pair by pair:
 *   - two numeric strings compare NUMERICALLY (`'1e2' == '100'`), otherwise
 *     byte-wise;
 *   - number vs string is numeric when BOTH are numeric, else the number is
 *     cast to string and compared as strings (PHP 8), so `'10a' == 1` is false;
 *   - NAN is never equal to anything, itself included.
 * This is the ONE scalar canon: `collections.mjs` builds its Collection-aware
 * pair from it through `makeLooseEq()` and the validator imports the pair
 * below.
 */
export const phpScalarEquals = (a, b) => {
  if (typeof a === 'string' && typeof b === 'string') {
    if (isNumericForLooseEq(a) && isNumericForLooseEq(b)) return Number(a) === Number(b);
    return a === b;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return a === b;
  }
  const num = typeof a === 'number' ? a : b;
  const str = typeof a === 'string' ? a : b;
  if (Number.isNaN(num)) return false;
  if (isNumericForLooseEq(str)) return Number(str) === num;
  return String(num) === str;
};
/**
 * The kernel-wide loose equality for callers that have no Collection of their
 * own: `kernel/validator.mjs` (`in`, `contains`, `distinct`) and any other
 * scalar/array comparison site. `collections.mjs` calls `makeLooseEq()` again
 * with its own `isCollection` so a Collection counts as a PHP array.
 */
export const { looseEq, phpLooseEquals } = makeLooseEq({ scalarEq: phpScalarEquals });
