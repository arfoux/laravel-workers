/**
 * kernel/collections.mjs — Illuminate\Collections\Collection for the edge runtime.
 *
 * WHAT IT COVERS
 *   The inspection / transform / aggregate / mutator surface of Laravel's
 *   Collection and EnumeratesValues traits for *list-shaped* input: all(),
 *   toArray(), count(), isEmpty(), isNotEmpty(), first(), firstOrFail(),
 *   sole(), last(), get(), has(), put(), push(), pop(), pull(), forget(), map(),
 *   filter(), reject(), each(), values(), keys(), merge(), pluck(), implode(),
 *   contains(), every(), some(), sortBy(), sortByDesc(), sum(), avg(), max(),
 *   min(), groupBy(), keyBy(), unique(), flatten(), where(), whereIn(),
 *   whereNotNull(), slice(), take(), skip(), chunk(), reverse(), when(),
 *   unless(), whenEmpty(), whenNotEmpty(), tap(), pipe(), mapWithKeys(),
 *   countBy(), only(), except(), join(), pad(), prepend(), concat(), flip(),
 *   search(), transform(), collapse(), diff(), intersect(), split(), splitIn(),
 *   median(), mode(), dot(), undot(), getOrPut(), hasAny(), nth(), duplicates(),
 *   zip(), combine(), crossJoin(), sort(), sortDesc().
 *
 * REPRESENTATION — WHY A PLAIN ARRAY
 *   `items` is a plain ARRAY, exactly like the runtime's existing Collection
 *   (compiler/runtime/rt-from-context.mjs:1477-1572: `class Collection`,
 *   `this.items = Array.isArray(items) ? items.slice() : []`, and consumers
 *   that read `src.items.slice()`, `src.items.length`, `src.items.map(...)`).
 *   Keeping the same shape means `[...$c]`, `foreach`, `count($c)` and
 *   `{{ $c->count() }}` keep working against a collection built here; a keyed
 *   object shape would force every one of those call sites to learn a second
 *   representation.
 *
 * WHAT IT CANNOT DO (representation limits, stated loudly)
 *   PHP arrays carry keys; a JS list does not. Therefore:
 *     - keys() is always 0..n-1 (Laravel would return the PHP keys);
 *     - keyBy()/groupBy() drop the string keys but keep Laravel's *value*
 *       semantics: groupBy nests the groups as Collections in first-seen order,
 *       keyBy keeps one value per key (last wins, first position wins);
 *     - get()/has()/put()/pull()/forget() address list positions only; an
 *       associative key such as 'name' cannot be resolved;
 *     - forget() reindexes the list (PHP would leave a hole in the keys);
 *     - filter() reindexes (PHP preserves the surviving keys).
 *   Call ->values() where the PHP result's keys matter. These are shape limits,
 *   not value limits: for list input every method returns the value Laravel
 *   returns (values baked in kernel/tests/collections.test.mjs, probed against
 *   the vendored laravel/framework).
 *
 * MUTATORS
 *   put/push/pop/pull/forget/each/tap/prepend/transform/getOrPut mutate
 *   `this.items` and return `$this`, because that is Laravel's own contract
 *   (Collection::push/pop/put/pull/prepend/transform/getOrPut return $this).
 *   Every OTHER method answers a NEW Collection and leaves the receiver
 *   untouched — Laravel's immutability for transforms.
 *
 * Unsupported inputs fail loud: an unknown where() operator throws instead of
 * silently filtering everything out (the runtime's law: identical value or a
 * precise error).
 */

const IS_COLLECTION = Symbol.for('lw.collection');

/** PHP array-key coercion for the list case: '1' and 1 are the same key. */
const normKey = (k) =>
  typeof k === 'string' && /^-?\d+$/.test(k) ? Number(k) : k;

/** PHP string cast for implode()/group keys: null and false are '', true is '1'. */
const phpStr = (v) => {
  if (v === null || v === undefined) return '';
  if (v === true) return '1';
  if (v === false) return '';
  if (Array.isArray(v)) return 'Array';
  if (v instanceof Collection) return 'Array';
  if (typeof v === 'object') return 'Object';
  return String(v);
};

/** True for values PHP compares as numbers (numbers plus numeric strings). */
const isNumeric = (v) =>
  typeof v === 'number' ||
  (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)));

/**
 * PHP 8 loose equality for scalars (`in_array($v, $items)` without strict).
 * Objects are never loosely equal to scalars (PHP 8).
 */
const looseEq = (a, b) => {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  if (typeof a === 'object' || typeof b === 'object') return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return Boolean(a) === Boolean(b);
  }
  if (isNumeric(a) && isNumeric(b)) return Number(a) === Number(b);
  if (isNumeric(a) !== isNumeric(b)) return false;
  return String(a) === String(b);
};

/**
 * PHP 8 spaceship for sortBy()/max()/min()/where(): numeric when both sides are
 * numeric, else string comparison (PHP 8 compares number-to-non-numeric-string
 * as strings).
 */
const phpCompare = (a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  if (isNumeric(a) && isNumeric(b)) return Number(a) < Number(b) ? -1 : 1;
  if (isNumeric(a) !== isNumeric(b)) return isNumeric(a) ? -1 : 1;
  return String(a) < String(b) ? -1 : 1;
};

/** Laravel's `$callback ? $callback($item, $key) : $item`, plus property access. */
// Laravel's `data_get($item, $value)`: for an Eloquent model that goes through
// `__get` -> `getAttribute()`, so `$collection->pluck('title')` reads the
// model's ATTRIBUTE, not a JS property (the edge keeps them in `attributes`).
const readProp = (item, key) => {
  if (item === null || item === undefined) return null;
  if (typeof item.get === 'function' && item.attributes && typeof item.attributes === 'object') {
    return item.get(key);
  }
  return item[key];
};
const valueOf = (spec, item, key) => {
  if (typeof spec === 'function') return spec(item, key);
  if (spec === null || spec === undefined) return item;
  return readProp(item, spec);
};

/** PHP array_slice() on a list (negative offset/length clamp from the end). */
const phpSlice = (items, offset, length) => {
  const n = items.length;
  let off = Number(offset) | 0;
  if (off < 0) off = Math.max(n + off, 0);
  else if (off > n) off = n;
  if (length === undefined || length === null) return items.slice(off);
  const len = Number(length) | 0;
  const end = len < 0 ? Math.max(n + len, off) : off + len;
  return items.slice(off, end);
};

/**
 * Stable sort (PHP 8's uasort is stable), PHP's array KEYS preserved.
 *
 * Laravel's Collection::sortBy() builds `$results` keyed by the ORIGINAL key and
 * returns `newInstance($results)` (Collection.php:1601-1625), so
 * `collect(['a' => 3, 'b' => 1])->sortBy(fn ($v) => $v)->all()` is
 * `['b' => 1, 'a' => 3]` - NOT a reindexed list (probed with Laravel 13).
 * The keys come back with the items so the caller can rebuild the collection.
 */
const sortBySpec = (items, keys, spec, descending) => {
  const source = keys || items.map((_, index) => index);
  const decorated = items.map((item, index) => ({
    item,
    index,
    key: valueOf(spec, item, source[index]),
  }));
  decorated.sort((a, b) => {
    const cmp = phpCompare(a.key, b.key);
    if (cmp === 0) return a.index - b.index;
    return descending ? -cmp : cmp;
  });
  return {
    items: decorated.map((entry) => entry.item),
    // A LIST stays a list (no keys to carry): only a keyed collection keeps
    // its keys, exactly like PHP's array.
    keys: keys ? decorated.map((entry) => source[entry.index]) : null,
  };
};

const likeMatch = (actual, pattern) => {
  if (actual === null || actual === undefined) return false;
  const escaped = phpStr(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp('^' + escaped.replace(/%/g, '.*').replace(/_/g, '.') + '$', 's');
  return rx.test(String(actual));
};

const operatorForWhere = (operator) => {
  switch (operator) {
    case '=':
    case '==':
      return (a, b) => looseEq(a, b);
    case '===':
      return (a, b) => a === b;
    case '!=':
    case '<>':
      return (a, b) => !looseEq(a, b);
    case '!==':
      return (a, b) => a !== b;
    case '<':
      return (a, b) => phpCompare(a, b) < 0;
    case '>':
      return (a, b) => phpCompare(a, b) > 0;
    case '<=':
      return (a, b) => phpCompare(a, b) <= 0;
    case '>=':
      return (a, b) => phpCompare(a, b) >= 0;
    case 'like':
      return (a, b) => likeMatch(a, b);
    default:
      throw new Error(
        'Collection.where(): operator "' + String(operator) + '" is not supported at the edge — ' +
          'the supported operators are =, ==, ===, !=, <>, !==, <, >, <=, >=, like'
      );
  }
};

/** Values of an arrayable-ish argument: Collection, array, object or scalar. */
import { phpJsonEncode } from './php-json.mjs';

export const toList = (input) => {
  if (input instanceof Collection) return input.items.slice();
  if (Array.isArray(input)) return input.slice();
  if (input === null || input === undefined) return [];
  if (typeof input === 'object') return Object.values(input);
  return [input];
};

/**
 * PHP's array-key coercion for a KEYED result (`mapWithKeys`, `countBy`,
 * `flip`, `undot`). Only a CANONICAL decimal integer string becomes an int -
 * a probe: `['1' => 'x', '01' => 'y']` keeps BOTH keys ('1' is 1, '01' stays
 * a string), and '+1', '-0', '1.0', ' 1' and integers beyond PHP_INT_MAX stay
 * strings too. null is '', true is 1, false is 0, a float truncates (a probe:
 * `[1.7 => 'x']` answers `[1 => 'x']`).
 */
const arrayKey = (v) => {
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

/** The PHP key at a list position (the index itself for a plain list). */
const keyAt = (collection, index) =>
  collection.phpKeys ? collection.phpKeys[index] : index;

/** The collection's PHP keys as a fresh list. */
const currentKeys = (collection) =>
  collection.phpKeys ? collection.phpKeys.slice() : collection.items.map((_, index) => index);

/** `{key, value}` entries of a Collection, array or PHP-array-shaped object. */
const entriesOf = (value) => {
  if (value instanceof Collection) {
    const array = value.phpArray();
    if (Array.isArray(array)) return array.map((item, index) => ({ key: index, value: item }));
    return Object.entries(array).map(([key, item]) => ({ key: arrayKey(key), value: item }));
  }
  if (Array.isArray(value)) return value.map((item, index) => ({ key: index, value: item }));
  if (value !== null && value !== undefined && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => ({ key: arrayKey(key), value: item }));
  }
  return null;
};

/** PHP's next `$array[]` key: the largest integer key + 1, or 0 (a probe:
 *  `[5 => 'x']` followed by `push('y')` answers `[5 => 'x', 6 => 'y']`). */
const nextIntKey = (keys) => {
  let max = null;
  for (const key of keys) {
    const k = arrayKey(key);
    if (typeof k === 'number' && (max === null || k > max)) max = k;
  }
  return max === null ? 0 : max + 1;
};

/** PHP's bool cast, for the boolean rung of SORT_REGULAR ('0' and '' are false). */
const phpTruthy = (v) =>
  !(v === null || v === undefined || v === false || v === 0 || v === '' || v === '0');

const phpStrCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * PHP 8's SORT_REGULAR comparison, i.e. `asort()`/`arsort()` without flags.
 * Probed pairwise; it is NOT `phpCompare()` above:
 *   - a boolean on either side casts BOTH to bool, so `false == null == 0`
 *     and `true == 2 == 'a'` (both compare 0);
 *   - null against a number is 0, against a string is '';
 *   - a number against a non-numeric string compares as STRINGS (`0 > ''`);
 *   - two numeric strings compare NUMERICALLY (`'9' < '10'`);
 *   - otherwise strings compare byte-wise (`'B' < 'a' < '_'`).
 */
const phpSortCompare = (a, b) => {
  if (a === b) return 0;
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const x = typeof a === 'boolean' ? a : phpTruthy(a);
    const y = typeof b === 'boolean' ? b : phpTruthy(b);
    return x === y ? 0 : x ? 1 : -1;
  }
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    if (aNull) {
      if (typeof b === 'string') return phpStrCmp('', b);
      if (typeof b === 'number') return b === 0 ? 0 : b > 0 ? -1 : 1;
      return -1;
    }
    if (typeof a === 'string') return phpStrCmp(a, '');
    if (typeof a === 'number') return a === 0 ? 0 : a > 0 ? 1 : -1;
    return 1;
  }
  const aNum = typeof a === 'number';
  const bNum = typeof b === 'number';
  if (aNum && bNum) return a < b ? -1 : a > b ? 1 : 0;
  if (aNum || bNum) {
    const num = aNum ? a : b;
    const str = aNum ? b : a;
    if (typeof str !== 'string') return phpStrCmp(String(a), String(b));
    if (isNumeric(str)) {
      const left = aNum ? a : Number(a);
      const right = aNum ? Number(b) : b;
      return left < right ? -1 : left > right ? 1 : 0;
    }
    const order = phpStrCmp(String(num), str);
    return aNum ? order : -order;
  }
  if (isNumeric(a) && isNumeric(b)) {
    const left = Number(a);
    const right = Number(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return phpStrCmp(String(a), String(b));
};

/** Stable sort over `{key, value}` entries; keys travel with their values. */
const sortEntries = (collection, compare) => {
  const entries = collection.items.map((value, index) => ({
    key: keyAt(collection, index),
    value,
    index,
  }));
  entries.sort((a, b) => {
    const cmp = compare(a.value, b.value);
    return cmp === 0 ? a.index - b.index : cmp;
  });
  return new Collection(entries.map((entry) => entry.value), entries.map((entry) => entry.key));
};

export class Collection {
  /**
   * `Collection::wrap($value)` (`EnumeratesValues::wrap()` +
   * `Arr::wrap()`, Illuminate/Collections/Traits/EnumeratesValues.php:134 and
   * Illuminate/Collections/Arr.php:1336):
   *
   *   an Enumerable -> its items;  null -> [];  an array -> as it is;
   *   anything else -> a ONE-ELEMENT array.
   *
   * This is NOT `collect()`: `collect()` runs getArrayableItems(), which turns
   * an Arrayable (a model) into its attributes, while `wrap()` keeps the object
   * as the single item. `Collection::wrap($post)->count()` is 1, and
   * `collect($post)->count()` is the number of attributes.
   */
  static wrap(value) {
    if (value === null || value === undefined) return new Collection([]);
    if (value instanceof Collection) return new Collection(value);
    if (Array.isArray(value)) return new Collection(value);
    // A PHP ASSOC array is a plain JS object at the edge, and Arr::wrap keeps
    // it keyed - wrapping it as one item would turn `['a' => 1]` into
    // `[{a: 1}]` (key 0), so `keys()` and `get('a')` would diverge. A model or
    // a resource is a class instance, so it still becomes the single item
    // (`$model instanceof Enumerable` is false in PHP too).
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return new Collection(value);
    }
    return new Collection([value]);
  }

  constructor(items = [], keys = null) {
    // A plain object is a PHP array with keys: keep them (a keyed collection
    // answers `all()` as the same object and `has('a')` is true).
    let sourceKeys = keys;
    if (items !== null && items !== undefined && !Array.isArray(items) && !(items instanceof Collection) && typeof items === 'object') {
      sourceKeys = sourceKeys || Object.keys(items);
    }
    // `Enumerable::getArrayableItems()` (EnumeratesValues.php) ends with
    // `(array) $items`, so a SCALAR wraps into a one-element array:
    // `collect(5)` answers `[5]` and `collect('ab')` answers `['ab']` in
    // Laravel (measured). The constructor used `Object.values()` there,
    // which turned a string into its CHARACTERS and a number into `[]` -
    // a silently wrong count for `collect($n)->count()`.
    this.items = items === null || items === undefined
      ? []
      : Array.isArray(items)
        ? items
        : items instanceof Collection
          ? items.items.slice()
          : typeof items === 'object'
            ? Object.values(items)
            : [items];
    // PHP's array KEYS. A list has none (the index is the key); a keyed
    // collection (`groupBy`, `keyBy`, `pluck($v, $k)`) carries them, and
    // Laravel's `all()`/`toArray()`/json_encode answer an OBJECT for it.
    // Non-enumerable: the runtime's iteration reads `items` only.
    Object.defineProperty(this, 'phpKeys', {
      value: sourceKeys || null,
      enumerable: false,
      writable: true,
    });
    this[IS_COLLECTION] = true;
  }

  /** The index of a PHP key, or -1 when the key is absent. */
  indexOfKey(key) {
    const k = normKey(key);
    if (this.phpKeys) {
      for (let i = 0; i < this.phpKeys.length; i++) {
        if (normKey(this.phpKeys[i]) === k) return i;
      }
      return -1;
    }
    if (Number.isInteger(k)) return k >= 0 && k < this.items.length ? k : -1;
    return Object.prototype.hasOwnProperty.call(this.items, k) ? k : -1;
  }

  /** The PHP array this collection IS: a list, or a keyed object. */
  phpArray() {
    if (!this.phpKeys) return this.items.slice();
    // A keyed array whose keys are exactly 0..n-1 in order IS a list in PHP
    // (`array_chunk()`'s first chunk, for example) - json_encode and `all()`
    // both answer the list.
    if (this.phpKeys.every((key, index) => normKey(key) === index)) return this.items.slice();
    const out = {};
    this.phpKeys.forEach((key, index) => {
      out[String(key)] = this.items[index];
    });
    return out;
  }

  // ---- inspection -------------------------------------------------------
  all() {
    // Laravel's `all()` answers the underlying array - a keyed one stays keyed
    // (groupBy/keyBy/pluck($value, $key)).
    if (this.phpKeys) {
      if (this.phpKeys.every((key, index) => normKey(key) === index)) return this.items.slice();
      const out = {};
      this.phpKeys.forEach((key, index) => { out[String(key)] = this.items[index]; });
      return out;
    }
    return this.items.slice();
  }

  /** `Collection::toJson()`: json_encode($this->all()) - PHP's bytes. */
  toJson() {
    return phpJsonEncode(this.all());
  }

  toArray() {
    if (this.phpKeys && this.phpKeys.every((key, index) => normKey(key) === index)) {
      return this.items.map((item) =>
        item instanceof Collection
          ? item.toArray()
          : item !== null && typeof item === 'object' && typeof item.toArray === 'function'
            ? item.toArray()
            : item
      );
    }
    if (this.phpKeys) {
      const out = {};
      this.phpKeys.forEach((key, index) => {
        const item = this.items[index];
        out[String(key)] =
          item instanceof Collection
            ? item.toArray()
            : item !== null && typeof item === 'object' && typeof item.toArray === 'function'
              ? item.toArray()
              : item;
      });
      return out;
    }
    return this.items.map((item) => {
      if (item instanceof Collection) return item.toArray();
      if (item !== null && typeof item === 'object' && typeof item.toArray === 'function') {
        return item.toArray();
      }
      return item;
    });
  }

  count() {
    return this.items.length;
  }

  isEmpty() {
    return this.items.length === 0;
  }

  isNotEmpty() {
    return this.items.length > 0;
  }

  /**
   * `firstWhere($key, $operator, $value)` (EnumeratesValues::firstWhere(),
   * :370-390): the first item whose `$key` matches - with two arguments the
   * operator is `=` and the second argument IS the value.
   */
  firstWhere(key, operator, value) {
    const twoArgs = arguments.length === 2;
    const op = twoArgs ? '=' : String(operator);
    const wanted = twoArgs ? operator : value;
    for (const item of this.items) {
      if (item === null || item === undefined) continue;
      const actual = typeof item === 'object' ? item[key] : item;
      const hit =
        op === '=' || op === '==' ? looseEq(actual, wanted) : op === '!=' ? !looseEq(actual, wanted) : false;
      if (hit) return item;
    }
    return null;
  }

  first(predicate = null, fallback = null) {
    if (typeof predicate !== 'function') {
      return this.items.length > 0 ? this.items[0] : fallback;
    }
    const index = this.items.findIndex((item, key) => predicate(item, key));
    return index === -1 ? fallback : this.items[index];
  }

  /**
   * `firstOrFail($key = null, $operator = null, $value = null)`
   * (Collection::firstOrFail(), :1509-1524): the first item, or a thrown
   * `ItemNotFoundException`. More than one argument is a `where()` filter
   * (`operatorForWhere()`: two arguments mean `$key = $operator`, three mean
   * `$key $operator $value`); one argument is a callback, and a NON-callable
   * there is a TypeError in PHP (a probe), never a silent "first item".
   *
   * PHP's exception carries an EMPTY message (a probe: `msg=[]`, code 0), which
   * names nothing at the edge, so the thrown error names the failure instead.
   */
  firstOrFail(key = null, operator = null, value = null) {
    const placeholder = Symbol('Collection.firstOrFail');
    const filtered = arguments.length > 1 && typeof key !== 'function';
    let item;
    if (filtered) {
      const test = operatorForWhere(arguments.length === 2 ? '=' : String(operator));
      const expected = arguments.length === 2 ? operator : value;
      item = this.first((entry) => {
        const actual = entry === null || entry === undefined ? null : entry[key];
        return test(actual, expected);
      }, placeholder);
    } else {
      if (key !== null && key !== undefined && typeof key !== 'function') {
        throw new TypeError(
          'Collection.firstOrFail(): a single argument must be a callback (Laravel calls first($callback) here) — ' +
            'pass a key and a value for a key lookup'
        );
      }
      item = this.first(key, placeholder);
    }
    if (item === placeholder) {
      throw new Error(filtered ? 'Item with key `' + String(key) + '` not found.' : 'Item not found.');
    }
    return item;
  }

  /**
   * `sole($key = null, $operator = null, $value = null)`
   * (Collection::sole(), :1458-1477): the only item, or a thrown
   * `ItemNotFoundException` / `MultipleItemsFoundException`. More than one
   * argument is a `where()` filter (`operatorForWhere()`: two arguments mean
   * `$key = $operator`, three mean `$key $operator $value`); a callable is a
   * filter callback; a nullish single argument filters nothing. A single
   * non-callable, non-nullish argument is PHP's TypeError (a probe), never a
   * silent "first item".
   * PHP's ItemNotFoundException carries an EMPTY message (a probe: `msg=[]`),
   * which names nothing at the edge, so the thrown error names the failure.
   * MultipleItemsFoundException's own message is "<count> items were found."
   * (a probe).
   */
  sole(key = null, operator = null, value = null) {
    let predicate = null;
    if (typeof key === 'function') {
      // operatorForWhere() returns a callable first argument unchanged, even
      // when more arguments follow (a probe: sole($fn, 'x', 'y') filters $fn).
      predicate = key;
    } else if (arguments.length > 1) {
      const test = operatorForWhere(arguments.length === 2 ? '=' : String(operator));
      const expected = arguments.length === 2 ? operator : value;
      predicate = (item) => {
        const actual = key === null || key === undefined ? item : readProp(item, key);
        return test(actual, expected);
      };
    } else if (!(key === null || key === undefined || key === false || key === 0 || key === '' ||
      (Array.isArray(key) && key.length === 0))) {
      // `$filter == null` is false for these, so Laravel calls filter($key) -
      // which is typed ?callable and throws (a probe: sole('name') is a TypeError).
      throw new TypeError(
        'Collection.sole(): a single argument must be a callback (Laravel calls filter($callback) here) — ' +
          'pass a key and a value for a key lookup'
      );
    }
    const items = predicate === null
      ? this.items
      : this.items.filter((item, index) => predicate(item, index));
    if (items.length === 0) throw new Error('Item not found.');
    if (items.length > 1) throw new Error(items.length + ' items were found.');
    return items[0];
  }

  last(predicate = null, fallback = null) {
    if (typeof predicate !== 'function') {
      return this.items.length > 0 ? this.items[this.items.length - 1] : fallback;
    }
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (predicate(this.items[i], i)) return this.items[i];
    }
    return fallback;
  }

  get(key, fallback = null) {
    const index = this.indexOfKey(key);
    return index === -1 ? fallback : this.items[index];
  }

  has(key) {
    if (Array.isArray(key)) return key.every((k) => this.has(k));
    return this.indexOfKey(key) !== -1;
  }

  /**
   * `hasAny($key)` (Collection::hasAny(), :624-633): true when ANY of the
   * keys is present; an array OR variadic arguments (a probe:
   * `hasAny('a', 'b')` works), false on an empty collection, and PHP key
   * coercion (a probe: `hasAny(['0'])` finds position 0 of a list).
   */
  hasAny(keys) {
    if (this.items.length === 0) return false;
    const list = Array.isArray(keys) ? keys : Array.from(arguments);
    const present = new Set(currentKeys(this).map((key) => String(arrayKey(key))));
    return list.some((key) => present.has(String(arrayKey(key))));
  }

  // ---- mutators (Laravel returns $this) ---------------------------------
  put(key, value) {
    this.items[normKey(key)] = value;
    return this;
  }

  push(...values) {
    this.items.push(...values);
    return this;
  }

  pop() {
    return this.items.length > 0 ? this.items.pop() : null;
  }

  pull(key) {
    const value = this.get(key, null);
    this.forget(key);
    return value;
  }

  forget(key) {
    const k = normKey(key);
    if (Number.isInteger(k)) {
      if (k >= 0 && k < this.items.length) this.items.splice(k, 1);
    } else {
      delete this.items[k];
    }
    return this;
  }

  each(callback) {
    this.items.forEach((item, key) => callback(item, key));
    return this;
  }

  /**
   * `prepend($value, $key = null)` (Collection::prepend(), :1064-1069): MUTATES
   * and returns `$this` (a probe: `$c->prepend(0) === $c`).
   * Without a key this is `array_unshift()`: integer keys are renumbered from
   * 0, string keys survive (a probe: `['a' => 1]` prepended answers
   * `[0 => 0, 'a' => 1]`). With a key it is `[$key => $value] + $array`, so an
   * EXISTING key is replaced and moves to the front (a probe: prepending 0
   * with key 'a' answers `['a' => 0]`).
   */
  prepend(value, key = null) {
    const entries = this.items.map((item, index) => ({ key: keyAt(this, index), value: item }));
    if (arguments.length > 1) {
      const k = arrayKey(key);
      const kept = entries.filter((entry) => String(arrayKey(entry.key)) !== String(k));
      const next = [{ key: k, value }, ...kept];
      this.items = next.map((entry) => entry.value);
      this.phpKeys = next.map((entry) => entry.key);
    } else {
      const next = [{ key: null, value }, ...entries];
      let counter = 0;
      const keys = next.map((entry) => {
        if (entry.key === null) return counter++;
        const k = arrayKey(entry.key);
        return typeof k === 'number' ? counter++ : k;
      });
      this.items = next.map((entry) => entry.value);
      this.phpKeys = keys;
    }
    return this;
  }

  /**
   * `transform(callable $callback)` (Collection::transform(), :1824-1829):
   * `$this->items = $this->map($callback)->all()`, so it MUTATES in place and
   * answers the SAME instance (a probe: `$c->transform($fn) === $c`), keeping
   * the keys (a probe: `['a' => 1]` stays `['a' => 2]`).
   */
  transform(callback) {
    this.items = this.items.map((item, index) => callback(item, keyAt(this, index)));
    return this;
  }

  /**
   * `getOrPut($key, $value)` (Collection::getOrPut(), :515-524): the existing
   * value, or the value (a closure is CALLED, `value()`) STORED and returned -
   * so it mutates (a probe: `collect(['a' => 1])->getOrPut('b', 2)` leaves
   * `['a' => 1, 'b' => 2]`). A stored null/false IS present (a probe:
   * `['a' => null]` answers null, never the default).
   */
  getOrPut(key, value) {
    const k = arrayKey(key);
    const index = currentKeys(this).findIndex((entry) => String(arrayKey(entry)) === String(k));
    if (index !== -1) return this.items[index];
    const resolved = typeof value === 'function' ? value() : value;
    const keys = currentKeys(this);
    keys.push(k);
    this.items = this.items.concat([resolved]);
    this.phpKeys = keys;
    return resolved;
  }

  // ---- transforms (new Collection) --------------------------------------
  map(callback) {
    return new Collection(this.items.map((item, key) => callback(item, key)));
  }

  /**
   * `mapWithKeys(callable $callback)` (Collection::mapWithKeys(), :880-883;
   * `Arr::mapWithKeys()`): the callback answers `[key => value]` pairs (one or
   * many), and a LATER key wins - a probe: `['a' => 1, 'b' => 2]` mapped to
   * `[$k.'!' => $v]` answers `['a!' => 1, 'b!' => 2]`, and mapping `[1, 2, 3]`
   * to `['x' => $v]` answers `['x' => 3]`. Keys follow PHP's array-key
   * coercion (a probe: `'1'` is 1, `'01'` stays `'01'`). The callback gets the
   * PHP key, and may answer a Collection instead of an array (a probe: it is
   * iterated the same way).
   */
  mapWithKeys(callback) {
    const values = [];
    const keys = [];
    const positions = new Map();
    this.items.forEach((item, index) => {
      const pairs = entriesOf(callback(item, keyAt(this, index)));
      if (pairs === null) {
        throw new TypeError(
          'Collection.mapWithKeys(): the callback must return an array or a Collection — ' +
            'Laravel iterates the result with foreach()'
        );
      }
      for (const pair of pairs) {
        const k = arrayKey(pair.key);
        if (typeof k !== 'number' && typeof k !== 'string') {
          throw new TypeError('Collection.mapWithKeys(): illegal offset type — array keys are integers or strings');
        }
        const id = String(k);
        if (positions.has(id)) values[positions.get(id)] = pair.value;
        else {
          positions.set(id, values.length);
          values.push(pair.value);
          keys.push(k);
        }
      }
    });
    return new Collection(values, keys);
  }

  filter(callback = null) {
    return new Collection(
      typeof callback === 'function'
        ? this.items.filter((item, key) => callback(item, key))
        : this.items.filter((item) => !!item)
    );
  }

  reject(callback) {
    return new Collection(this.items.filter((item, key) => !callback(item, key)));
  }

  values() {
    return new Collection(this.items.slice());
  }

  keys() {
    // `keys()` answers the array's keys: the indexes for a list, the PHP keys
    // for a keyed collection.
    return new Collection(this.phpKeys ? this.phpKeys.slice() : this.items.map((_, index) => index));
  }

  merge(items) {
    return new Collection(this.items.concat(toList(items)));
  }

  /**
   * `only($keys)` (Collection::only(), :988-1001; `Arr::only()`): array OR
   * variadic keys, ORIGINAL order kept (a probe: `only(['c', 'a'])` answers
   * `['a' => 1, 'c' => 3]`), missing keys dropped, and a null argument answers
   * a copy. Keys use PHP's coercion (a probe: `only(['0', '2'])` on a list
   * keeps positions 0 and 2).
   */
  only(keys) {
    if (keys === null || keys === undefined) {
      return new Collection(this.items.slice(), this.phpKeys ? this.phpKeys.slice() : null);
    }
    const list = keys instanceof Collection
      ? keys.items
      : Array.isArray(keys)
        ? keys
        : Array.from(arguments);
    const wanted = new Set();
    for (const key of list) {
      // `Arr::only()` flips the keys, and array_flip() rejects a bool, float,
      // null, array or object BEFORE coercion (a probe: `only([true])` is an
      // ErrorException, not an empty result).
      if (typeof key !== 'string' && !(typeof key === 'number' && Number.isInteger(key))) {
        throw new Error('Collection.only(): array_flip() can only flip string and integer values, entry skipped');
      }
      wanted.add(String(key));
    }
    const values = [];
    const outKeys = [];
    this.items.forEach((item, index) => {
      const key = keyAt(this, index);
      if (wanted.has(String(arrayKey(key)))) {
        values.push(item);
        outKeys.push(key);
      }
    });
    return new Collection(values, outKeys);
  }

  /**
   * `except($keys)` (Collection::except(), :404-417; `Arr::except()`): array
   * OR variadic keys, ORIGINAL order kept (a probe: `except(['b'])` answers
   * `['a' => 1, 'c' => 3]`), a null argument answers a copy.
   */
  except(keys) {
    if (keys === null || keys === undefined) {
      return new Collection(this.items.slice(), this.phpKeys ? this.phpKeys.slice() : null);
    }
    const list = keys instanceof Collection
      ? keys.items
      : Array.isArray(keys)
        ? keys
        : Array.from(arguments);
    const unwanted = new Set(list.map((key) => String(arrayKey(key))));
    const values = [];
    const outKeys = [];
    this.items.forEach((item, index) => {
      const key = keyAt(this, index);
      if (!unwanted.has(String(arrayKey(key)))) {
        values.push(item);
        outKeys.push(key);
      }
    });
    return new Collection(values, outKeys);
  }

  /**
   * `concat($source)` (Collection::concat(), :1112-1121): a NEW collection
   * holding this collection's entries, then each source VALUE pushed with
   * `$array[]`. The receiver's keys survive, the SOURCE's keys do NOT (a
   * probe: `['a' => 1]->concat(['b' => 2])` answers `['a' => 1, 0 => 2]`, and
   * `[5 => 'x']->concat(['y'])` answers `[5 => 'x', 6 => 'y']`).
   */
  concat(source) {
    const values = this.items.slice();
    const keys = currentKeys(this);
    for (const item of toList(source)) {
      keys.push(nextIntKey(keys));
      values.push(item);
    }
    return new Collection(values, keys);
  }

  /**
   * `flip()` (Collection::flip(), :464-467): `array_flip()` - values become
   * keys and keys become values (a probe: `['a' => 1, 'b' => 2]` answers
   * `[1 => 'a', 2 => 'b']`). A repeated value keeps its first position and
   * the LAST key wins (a probe: `[1, 1, 2]` answers `[1 => 1, 2 => 2]`).
   * array_flip() rejects other value types (a probe: a bool/float/null value
   * is an ErrorException), so this throws instead of guessing.
   */
  flip() {
    const values = [];
    const keys = [];
    const positions = new Map();
    this.items.forEach((item, index) => {
      // array_flip() takes only integers and strings; a bool, float, null,
      // array or object is rejected BEFORE any coercion (a probe: a bool value
      // is an ErrorException, and 1.7 is not flipped to 1).
      if (typeof item !== 'string' && !(typeof item === 'number' && Number.isInteger(item))) {
        throw new Error('Collection.flip(): array_flip() can only flip string and integer values, entry skipped');
      }
      const k = item;
      const id = String(k);
      const originalKey = keyAt(this, index);
      if (positions.has(id)) values[positions.get(id)] = originalKey;
      else {
        positions.set(id, values.length);
        values.push(originalKey);
        keys.push(k);
      }
    });
    return new Collection(values, keys);
  }

  /**
   * `search($value, $strict = false)` (Collection::search(), :1216-1223): the
   * key of the first match, or `false`. Without `$strict` the comparison is
   * PHP's `==` (a probe: `[1, 2]->search('2')` answers 1, and
   * `[0, 1]->search(false)` answers 0). A callable searches with the callback
   * (a probe: `search(fn ($v, $k) => $k === 'b')` answers 'b').
   */
  search(value, strict = false) {
    if (typeof value === 'function') {
      for (let i = 0; i < this.items.length; i++) {
        // array_find_key() tests the callback result with PHP's bool cast
        // (a probe: '0' is false there, unlike JS).
        if (phpTruthy(value(this.items[i], keyAt(this, i)))) return keyAt(this, i);
      }
      return false;
    }
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (strict ? item === value : looseEq(item, value)) return keyAt(this, i);
    }
    return false;
  }

  /**
   * `join($glue, $finalGlue = '')` (Collection::join(), :765-786): with no
   * final glue this is `implode($glue)`. With one, 0 items answer '', ONE item
   * answers the item ITSELF (a probe: the int 1, not '1'), and 2+ items join
   * all but the last with `$glue`, then `$finalGlue`, then the last - so the
   * final glue IS used with 2 items (a probe: `['a', 'b']` answers
   * `'a and b'`) and 3 answer `'a, b and c'`.
   */
  join(glue, finalGlue = '') {
    if (finalGlue === '') return this.implode(glue);
    const count = this.items.length;
    if (count === 0) return '';
    if (count === 1) return this.items[0];
    const head = this.items.slice(0, -1).map(phpStr).join(String(glue));
    return head + String(finalGlue) + phpStr(this.items[count - 1]);
  }

  /**
   * `collapse()` (Collection::collapse(), :153-156; `Arr::collapse()`): one
   * level of arrays and Collections, `array_merge`-style - numeric keys are
   * renumbered from 0, string keys are kept with a LATER value winning (a
   * probe: `[['a' => 1], ['a' => 2, 'b' => 3]]` answers
   * `['a' => 2, 'b' => 3]`). Non-arrayable items are skipped (a probe:
   * `[[1], 'x', [2]]` answers `[1, 2]`).
   */
  collapse() {
    const values = [];
    const keys = [];
    const stringPositions = new Map();
    for (const item of this.items) {
      const entries = entriesOf(item);
      if (entries === null) continue;
      for (const entry of entries) {
        const k = arrayKey(entry.key);
        if (typeof k === 'number') {
          values.push(entry.value);
          keys.push(values.length - 1);
        } else if (stringPositions.has(k)) {
          values[stringPositions.get(k)] = entry.value;
        } else {
          stringPositions.set(k, values.length);
          values.push(entry.value);
          keys.push(k);
        }
      }
    }
    return new Collection(values, keys);
  }

  /**
   * `dot()` (Collection::dot(), :1837-1840; `Arr::dot()`): flattens nested
   * ARRAYS into dot keys (a probe: `['a' => ['b' => 1]]` answers
   * `['a.b' => 1]`). An empty array stays a value (a probe: `['a' => []]`
   * answers `['a' => []]`), and a Collection value is NOT recursed (a probe:
   * it stays the Collection).
   */
  dot() {
    const values = [];
    const keys = [];
    const walk = (entries, prefix) => {
      for (const entry of entries) {
        const newKey = prefix + String(entry.key);
        const value = entry.value;
        const isList = Array.isArray(value);
        const isKeyed = value !== null && typeof value === 'object' && !(value instanceof Collection);
        const empty = isList ? value.length === 0 : isKeyed ? Object.keys(value).length === 0 : false;
        if ((isList || isKeyed) && !empty) {
          walk(entriesOf(value), newKey + '.');
        } else {
          keys.push(arrayKey(newKey));
          values.push(value);
        }
      }
    };
    walk(this.items.map((item, index) => ({ key: keyAt(this, index), value: item })), '');
    return new Collection(values, keys);
  }

  /**
   * `undot()` (Collection::undot(), :1847-1850; `Arr::undot()`/`Arr::set()`):
   * the inverse of dot(), numeric segments become integer keys (a probe:
   * `['0.a' => 1, '1' => 3]` answers `[0 => ['a' => 1], 1 => 3]`).
   */
  undot() {
    const root = {};
    this.items.forEach((item, index) => {
      const parts = String(keyAt(this, index)).split('.');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const segment = String(arrayKey(parts[i]));
        const existing = node[segment];
        // `Arr::set()`: a missing/null/non-array node becomes an array. A
        // Collection is an OBJECT in PHP, so it is replaced too.
        if (
          existing === null ||
          existing === undefined ||
          typeof existing !== 'object' ||
          existing instanceof Collection
        ) {
          node[segment] = {};
        }
        node = node[segment];
      }
      node[String(arrayKey(parts[parts.length - 1]))] = item;
    });
    return new Collection(root);
  }

  /**
   * `pad($size, $value)` (Collection::pad(), :1917-1920; `array_pad()`): a
   * NEGATIVE size pads at the FRONT (a probe: `[1, 2]->pad(-4, 0)` answers
   * `[0, 0, 1, 2]`), a size within the count answers a copy. Integer keys are
   * renumbered in result order, string keys survive (a probe:
   * `['a' => 1]->pad(-3, 0)` answers `[0 => 0, 1 => 0, 'a' => 1]`).
   */
  pad(size, value) {
    const total = Math.trunc(Number(size));
    const count = this.items.length;
    if (!Number.isFinite(total) || total === 0 || Math.abs(total) <= count) {
      return new Collection(this.items.slice(), this.phpKeys ? this.phpKeys.slice() : null);
    }
    const padCount = Math.abs(total) - count;
    const entries = this.items.map((item, index) => ({ key: keyAt(this, index), value: item }));
    const padding = Array.from({ length: padCount }, () => ({ key: null, value }));
    const next = total > 0 ? entries.concat(padding) : padding.concat(entries);
    let counter = 0;
    const keys = next.map((entry) => {
      if (entry.key === null) return counter++;
      const k = arrayKey(entry.key);
      return typeof k === 'number' ? counter++ : k;
    });
    return new Collection(next.map((entry) => entry.value), keys);
  }

  /**
   * `nth($step, $offset = 0)` (Collection::nth(), :961-980): every `$step`th
   * item from `$offset`, REINDEXED (a probe: `[1..5]->nth(2)` answers `[1, 3,
   * 5]`, `nth(2, 1)` answers `[2, 4]`). A step below 1 throws (a probe:
   * "Step value must be at least 1.").
   */
  nth(step, offset = 0) {
    const stride = Number(step);
    if (!(stride >= 1)) throw new Error('Step value must be at least 1.');
    const source = phpSlice(this.items, offset, undefined);
    const out = [];
    source.forEach((item, position) => {
      if (position % stride === 0) out.push(item);
    });
    return new Collection(out);
  }

  /**
   * `split($numberOfGroups)` (Collection::split(), :1395-1428): the first
   * `count % groups` groups get one extra item (a probe: 7 items into 3
   * answers `[[1, 2, 3], [4, 5], [6, 7]]`; 3 into 5 answers three groups of
   * one). `array_slice()` semantics: numeric keys are reindexed, string keys
   * survive. Fewer than 1 group throws (a probe: "Number of groups must be at
   * least 1.").
   */
  split(numberOfGroups) {
    const groups = Number(numberOfGroups);
    if (!(groups >= 1)) throw new Error('Number of groups must be at least 1.');
    if (this.items.length === 0) return new Collection();
    const entries = this.items.map((item, index) => ({ key: keyAt(this, index), value: item }));
    const groupSize = Math.floor(entries.length / groups);
    const remain = entries.length % groups;
    const chunks = [];
    let start = 0;
    for (let i = 0; i < groups; i++) {
      const size = groupSize + (i < remain ? 1 : 0);
      if (size === 0) continue;
      const slice = entries.slice(start, start + size);
      let counter = 0;
      const keys = slice.map((entry) => {
        const k = arrayKey(entry.key);
        return typeof k === 'number' ? counter++ : k;
      });
      chunks.push(new Collection(slice.map((entry) => entry.value), keys));
      start += size;
    }
    return new Collection(chunks);
  }

  /**
   * `splitIn($numberOfGroups)` (Collection::splitIn(), :1438-1445): NOT the
   * same keys as split() - it is `chunk(ceil(count / groups))`, and `chunk()`
   * PRESERVES keys (a probe: 5 items into 2 answers `[[1, 2, 3], [3 => 4,
   * 4 => 5]]`). Fewer than 1 group throws.
   */
  splitIn(numberOfGroups) {
    const groups = Number(numberOfGroups);
    if (!(groups >= 1)) throw new Error('Number of groups must be at least 1.');
    const size = Math.ceil(this.items.length / groups);
    if (size <= 0) return new Collection();
    const entries = this.items.map((item, index) => ({ key: keyAt(this, index), value: item }));
    const chunks = [];
    for (let start = 0; start < entries.length; start += size) {
      const slice = entries.slice(start, start + size);
      chunks.push(new Collection(slice.map((entry) => entry.value), slice.map((entry) => entry.key)));
    }
    return new Collection(chunks);
  }

  /**
   * `duplicates($callback = null, $strict = false)` (Collection::duplicates(),
   * :349-368): the items whose value (or callback value) already appeared,
   * KEYED by the original key (a probe: `[1, 2, 1, 2, 3]` answers
   * `[2 => 1, 3 => 2]`, and `['a' => 1, 'b' => 1]` answers `['b' => 1]`).
   * Without `$strict` the comparison is `==` (a probe: `[1, '1']` answers
   * `[1 => '1']`; with strict it answers nothing).
   */
  duplicates(callback = null, strict = false) {
    const values = [];
    const keys = [];
    const seen = [];
    this.items.forEach((item, index) => {
      const value = valueOf(callback, item, keyAt(this, index));
      const duplicate = seen.some((entry) => (strict ? entry === value : looseEq(entry, value)));
      if (duplicate) {
        values.push(value);
        keys.push(keyAt(this, index));
      } else {
        seen.push(value);
      }
    });
    return new Collection(values, keys);
  }

  /**
   * `diff($items)` (Collection::diff(), :277-280; `array_diff()`): keeps the
   * items absent from `$items`, KEYS PRESERVED (a probe: `[1, 2, 3]->diff([2])`
   * answers `[0 => 1, 2 => 3]`). The comparison is PHP's STRING cast, not
   * `==` (a probe: `[1, 2]->diff(['1'])` answers `[1 => 2]`, and
   * `[null, 0]->diff([''])` answers `[1 => 0]`). Only the FIRST argument is
   * used - a probe: `diff([1], [3])` still keeps 3.
   */
  diff(items) {
    const unwanted = new Set(toList(items).map(phpStr));
    const values = [];
    const keys = [];
    this.items.forEach((item, index) => {
      if (!unwanted.has(phpStr(item))) {
        values.push(item);
        keys.push(keyAt(this, index));
      }
    });
    return new Collection(values, keys);
  }

  /**
   * `intersect($items)` (Collection::intersect(), :663-666;
   * `array_intersect()`): keeps the items present in `$items`, KEYS PRESERVED
   * (a probe: `[1, 2, 3]->intersect([2])` answers `[1 => 2]`), compared by
   * PHP's STRING cast (a probe: `[1, 2]->intersect(['1'])` answers
   * `[0 => 1]`, and `[null, 0]->intersect([''])` answers `[0 => null]`). Only
   * the FIRST argument is used (a probe: `intersect([3], [1])` answers
   * `[2 => 3]`).
   */
  intersect(items) {
    const wanted = new Set(toList(items).map(phpStr));
    const values = [];
    const keys = [];
    this.items.forEach((item, index) => {
      if (wanted.has(phpStr(item))) {
        values.push(item);
        keys.push(keyAt(this, index));
      }
    });
    return new Collection(values, keys);
  }

  /**
   * `zip(...$arrays)` (Collection::zip(), :1899-1906): each result row is a
   * Collection of the values at that position, `array_map()`-style NULL padding
   * for shorter inputs (a probe: `[1, 2, 3]->zip([4])` answers
   * `[[1, 4], [2, null], [3, null]]`, and `[]->zip([1])` answers `[[null, 1]]`).
   */
  zip(...arrays) {
    const lists = arrays.map((array) => toList(array));
    const length = Math.max(this.items.length, ...lists.map((list) => list.length));
    const rows = [];
    for (let i = 0; i < length; i++) {
      const row = [i < this.items.length ? this.items[i] : null];
      for (const list of lists) row.push(i < list.length ? list[i] : null);
      rows.push(new Collection(row));
    }
    return new Collection(rows);
  }

  /**
   * `combine($values)` (Collection::combine(), :936-939; `array_combine()`):
   * this collection's VALUES become the keys (a probe:
   * `[10, 20]->combine(['x', 'y'])` answers `[10 => 'x', 20 => 'y']`).
   * Unequal counts throw (a probe: "array_combine(): Argument #1 ($keys) and
   * argument #2 ($values) must have the same number of elements").
   */
  combine(values) {
    const list = toList(values);
    if (list.length !== this.items.length) {
      throw new Error(
        'array_combine(): Argument #1 ($keys) and argument #2 ($values) must have the same number of elements'
      );
    }
    return new Collection(list, this.items.map(arrayKey));
  }

  /**
   * `crossJoin(...$lists)` (Collection::crossJoin(), :264-269;
   * `Arr::crossJoin()`): the cartesian product as plain ARRAYS, this
   * collection first (a probe: `[1, 2]->crossJoin(['a', 'b'])` answers
   * `[[1, 'a'], [1, 'b'], [2, 'a'], [2, 'b']]`). Any empty list empties the
   * result (a probe: `[1]->crossJoin([])` answers `[]`).
   */
  crossJoin(...lists) {
    const arrays = [this.items, ...lists.map((list) => toList(list))];
    let products = [[]];
    arrays.forEach((array, index) => {
      const next = [];
      for (const product of products) {
        for (const item of array) {
          const row = product.slice();
          row[index] = item;
          next.push(row);
        }
      }
      products = next;
    });
    return new Collection(products);
  }

  /**
   * `sort($callback = null)` (Collection::sort(), :1567-1576): a NEW
   * collection, KEYS PRESERVED (`asort()`; a probe: `[3, 1, 2]` answers
   * `[1 => 1, 2 => 2, 0 => 3]`). Without a callback the comparison is PHP's
   * SORT_REGULAR, NOT JS's: numeric strings compare numerically (`'9' <
   * '10'`), a number before a non-numeric string (`2 < 'B'`), and strings
   * byte-wise (`'B' < 'a' < '_'`) - a probe: `['10', '9', 'a', 'B', 2, '_']`
   * answers `[2, '9', '10', 'B', '_', 'a']`.
   */
  sort(callback = null) {
    if (typeof callback === 'function') {
      return sortEntries(this, (a, b) => {
        const cmp = Number(callback(a, b));
        return cmp === 0 ? 0 : cmp < 0 ? -1 : 1;
      });
    }
    if (callback !== null && callback !== undefined && callback !== 0) {
      // SORT_REGULAR (0) is the default; the other flags are not modelled.
      throw new Error(
        'Collection.sort(): sort flags other than SORT_REGULAR are not supported at the edge — pass a callback or null'
      );
    }
    return sortEntries(this, phpSortCompare);
  }

  /**
   * `sortDesc($options = SORT_REGULAR)` (Collection::sortDesc(), :1584-1591):
   * a NEW collection, KEYS PRESERVED (`arsort()`; a probe: `[3, 1, 2]`
   * answers `[0 => 3, 2 => 2, 1 => 1]`).
   *
   * Laravel 13's sortDesc() takes sort FLAGS, not a callback - a probe:
   * `sortDesc($fn)` is a TypeError ("arsort(): Argument #2 ($flags) must be of
   * type int, Closure given"). The edge answers that TypeError instead of
   * silently reversing with a comparator Laravel would reject.
   */
  sortDesc(options = null) {
    if (typeof options === 'function') {
      throw new TypeError('Collection.sortDesc(): Laravel 13 sortDesc() takes sort flags, not a callback');
    }
    if (options !== null && options !== undefined && options !== 0) {
      throw new Error(
        'Collection.sortDesc(): sort flags other than SORT_REGULAR are not supported at the edge'
      );
    }
    return sortEntries(this, (a, b) => -phpSortCompare(a, b));
  }

  pluck(key, indexKey = null) {
    // `pluck($value, $key)` (EnumeratesValues::pluck(), :1040-1078): with a
    // second argument the result is keyed by it.
    if (indexKey !== null) {
      const keys = [];
      const values = this.items.map((item) => {
        keys.push(readProp(item, indexKey));
        return readProp(item, key);
      });
      return new Collection(values, keys);
    }
    return new Collection(this.items.map((item) => readProp(item, key)));
  }

  implode(value = '', glue = null) {
    // EnumeratesValues::implode() (:1710-1728): `implode($value, $glue)` - the
    // FIRST argument is the item key (or a separator for a list), the SECOND
    // is the glue. The edge's old signature was `(glue, key)`, which answered
    // "n" for `->implode('n', '-')` where Laravel answers "a-b".
    let items = this.items;
    let separator = '';
    if (glue === null) {
      separator = String(value);
    } else {
      separator = String(glue);
      items = this.items.map((item) => (item === null || item === undefined ? null : item[value]));
    }
    return items.map(phpStr).join(separator);
  }

  contains(value) {
    if (typeof value === 'function') return this.items.some((item, key) => value(item, key));
    return this.items.some((item) => looseEq(item, value));
  }

  every(callback) {
    return this.items.every((item, key) => callback(item, key));
  }

  some(callback) {
    return this.items.some((item, key) => callback(item, key));
  }

  sortBy(callback) {
    const sorted = sortBySpec(this.items, this.phpKeys, callback, false);
    return new Collection(sorted.items, sorted.keys);
  }

  sortByDesc(callback) {
    const sorted = sortBySpec(this.items, this.phpKeys, callback, true);
    return new Collection(sorted.items, sorted.keys);
  }

  // ---- aggregation ------------------------------------------------------
  sum(callback = null) {
    return this.items.reduce((total, item, key) => total + Number(valueOf(callback, item, key)), 0);
  }

  avg(callback = null) {
    if (this.items.length === 0) return null;
    return this.sum(callback) / this.items.length;
  }

  max(callback = null) {
    if (this.items.length === 0) return null;
    const values = typeof callback === 'function'
      ? this.items.map((item, key) => callback(item, key))
      : this.items;
    return values.reduce((best, item) => (best === null || phpCompare(item, best) > 0 ? item : best), null);
  }

  min(callback = null) {
    if (this.items.length === 0) return null;
    const values = typeof callback === 'function'
      ? this.items.map((item, key) => callback(item, key))
      : this.items;
    return values.reduce((best, item) => (best === null || phpCompare(item, best) < 0 ? item : best), null);
  }

  /**
   * `countBy($callback = null)` (Collection::countBy(), :1946-1949 ->
   * `LazyCollection::countBy()`): a Collection KEYED by the counted value
   * (or callback value) with integer counts, in first-seen order - a probe:
   * `[1, 2, 2, 3, 3, 3]` answers `[1 => 1, 2 => 2, 3 => 3]` and
   * `['1', '01', 1]` answers `[1 => 2, '01' => 1]` (PHP's key coercion).
   */
  countBy(callback = null) {
    const counts = new Map();
    this.items.forEach((item, index) => {
      const k = arrayKey(valueOf(callback, item, keyAt(this, index)));
      const id = String(k);
      if (!counts.has(id)) counts.set(id, { key: k, count: 0 });
      counts.get(id).count++;
    });
    const entries = [...counts.values()];
    return new Collection(entries.map((entry) => entry.count), entries.map((entry) => entry.key));
  }

  /**
   * `median($key = null)` (Collection::median(), :98-119): nulls are rejected,
   * the rest sorted, the middle item for an ODD count (a probe: `[5, 3, 1]`
   * answers 3) and the average of the two middle items for an EVEN one (a
   * probe: `[4, 1, 3, 2]` answers 2.5); an empty collection answers null (a
   * probe: `median()` on `[]` is null).
   */
  median(key = null) {
    const source = key !== null && key !== undefined ? this.pluck(key) : this;
    const values = source.items.filter((item) => item !== null && item !== undefined);
    if (values.length === 0) return null;
    const sorted = values.slice().sort(phpSortCompare);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[middle];
    return (Number(sorted[middle - 1]) + Number(sorted[middle])) / 2;
  }

  /**
   * `mode($key = null)` (Collection::mode(), :127-146): the most frequent
   * value(s) as a plain ARRAY, in first-seen order - a probe: `[1, 1, 2, 3, 3]`
   * answers `[1, 3]`, `[1, 1, 2, 2, 3]` answers `[1, 2]`, every value once
   * answers all of them, and an empty collection answers null. Keys follow
   * PHP's coercion (a probe: `[1.5, 1.5, 2]` answers `[1]`).
   */
  mode(key = null) {
    const source = key !== null && key !== undefined ? this.pluck(key) : this;
    const values = source.items.filter((item) => item !== null && item !== undefined);
    if (values.length === 0) return null;
    const counts = new Map();
    for (const value of values) {
      const k = arrayKey(value);
      const id = String(k);
      if (!counts.has(id)) counts.set(id, { key: k, count: 0 });
      counts.get(id).count++;
    }
    const entries = [...counts.values()];
    const highest = entries.reduce((best, entry) => Math.max(best, entry.count), 0);
    return entries.filter((entry) => entry.count === highest).map((entry) => entry.key);
  }

  // ---- grouping ---------------------------------------------------------
  groupBy(callback) {
    const order = [];
    const groups = new Map();
    this.items.forEach((item, key) => {
      const groupKey = phpStr(valueOf(callback, item, key));
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
        order.push(groupKey);
      }
      groups.get(groupKey).push(item);
    });
    return new Collection(
      order.map((groupKey) => new Collection(groups.get(groupKey))),
      order
    );
  }

  keyBy(callback) {
    const order = [];
    const byKey = new Map();
    this.items.forEach((item, key) => {
      const groupKey = phpStr(valueOf(callback, item, key));
      if (!byKey.has(groupKey)) order.push(groupKey);
      byKey.set(groupKey, item);
    });
    return new Collection(order.map((groupKey) => byKey.get(groupKey)), order);
  }

  unique(callback = null) {
    const seen = new Set();
    const out = [];
    this.items.forEach((item, key) => {
      const groupKey = phpStr(valueOf(callback, item, key));
      if (!seen.has(groupKey)) {
        seen.add(groupKey);
        out.push(item);
      }
    });
    return new Collection(out);
  }

  flatten() {
    const out = [];
    const walk = (value) => {
      if (value instanceof Collection) value.items.forEach(walk);
      else if (Array.isArray(value)) value.forEach(walk);
      else out.push(value);
    };
    this.items.forEach(walk);
    return new Collection(out);
  }

  // ---- where ------------------------------------------------------------
  where(key, operator, value) {
    let op = operator;
    let expected = value;
    if (arguments.length <= 1) {
      op = '=';
      expected = true;
    } else if (arguments.length === 2) {
      op = '=';
      expected = operator;
    }
    const test = operatorForWhere(op);
    return new Collection(
      this.items.filter((item) => {
        const actual = item === null || item === undefined ? null : item[key];
        return test(actual, expected);
      })
    );
  }

  whereIn(key, values) {
    const candidates = toList(values);
    return new Collection(
      this.items.filter((item) => {
        const actual = item === null || item === undefined ? null : item[key];
        return candidates.some((candidate) => looseEq(actual, candidate));
      })
    );
  }

  whereNotNull(key) {
    return new Collection(
      this.items.filter((item) => {
        const actual = item === null || item === undefined ? null : item[key];
        return actual !== null && actual !== undefined;
      })
    );
  }

  // ---- slicing ----------------------------------------------------------
  slice(offset, length) {
    return new Collection(phpSlice(this.items, offset, length));
  }

  take(limit) {
    const count = Number(limit) | 0;
    return count < 0
      ? new Collection(phpSlice(this.items, count, Math.abs(count)))
      : new Collection(phpSlice(this.items, 0, count));
  }

  skip(count) {
    const n = Number(count) | 0;
    return new Collection(phpSlice(this.items, n));
  }

  chunk(size) {
    const n = Number(size) | 0;
    if (n <= 0) return new Collection();
    const chunks = [];
    for (let i = 0; i < this.items.length; i += n) {
      const slice = this.items.slice(i, i + n);
      // PHP's array_chunk() PRESERVES the keys (the last chunk of a 5-item
      // collection chunked by 2 is `{4: 5}`, not `[5]` - a probe).
      const keys = slice.map((_, offset) => i + offset);
      chunks.push(new Collection(slice, keys));
    }
    return new Collection(chunks);
  }

  reverse() {
    return new Collection(this.items.slice().reverse());
  }

  // ---- control flow -----------------------------------------------------
  when(condition, callback, fallback = null) {
    const test = typeof condition === 'function' ? condition(this) : condition;
    if (test) return typeof callback === 'function' ? callback(this) : callback;
    return typeof fallback === 'function' ? fallback(this) : this;
  }

  unless(condition, callback, fallback = null) {
    const test = typeof condition === 'function' ? condition(this) : condition;
    if (!test) return typeof callback === 'function' ? callback(this) : callback;
    return typeof fallback === 'function' ? fallback(this) : this;
  }

  whenEmpty(callback, fallback = null) {
    return this.isEmpty() ? callback(this) : typeof fallback === 'function' ? fallback(this) : this;
  }

  whenNotEmpty(callback, fallback = null) {
    return this.isNotEmpty() ? callback(this) : typeof fallback === 'function' ? fallback(this) : this;
  }

  tap(callback) {
    callback(this);
    return this;
  }

  pipe(callback) {
    return callback(this);
  }
}

export default Collection;
