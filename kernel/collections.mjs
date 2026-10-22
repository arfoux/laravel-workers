/**
 * kernel/collections.mjs — Illuminate\Collections\Collection for the edge runtime.
 *
 * WHAT IT COVERS
 *   The inspection / transform / aggregate / mutator surface of Laravel's
 *   Collection and EnumeratesValues traits for *list-shaped* input: all(),
 *   toArray(), count(), isEmpty(), isNotEmpty(), first(), last(), get(), has(),
 *   put(), push(), pop(), pull(), forget(), map(), filter(), reject(), each(),
 *   values(), keys(), merge(), pluck(), implode(), contains(), every(), some(),
 *   sortBy(), sortByDesc(), sum(), avg(), max(), min(), groupBy(), keyBy(),
 *   unique(), flatten(), where(), whereIn(), whereNotNull(), slice(), take(),
 *   skip(), chunk(), reverse(), when(), unless(), whenEmpty(), whenNotEmpty(),
 *   tap(), pipe().
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
 *   put/push/pop/pull/forget/each/tap mutate `this.items` and return `$this`,
 *   because that is Laravel's own contract (Collection::push/pop/put/pull/
 *   forget return $this). Every OTHER method answers a NEW Collection and
 *   leaves the receiver untouched — Laravel's immutability for transforms.
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

/** Stable sort (PHP 8's uasort is stable), keys replaced by positions. */
const sortBySpec = (items, spec, descending) => {
  const decorated = items.map((item, index) => ({ item, index, key: valueOf(spec, item, index) }));
  decorated.sort((a, b) => {
    const cmp = phpCompare(a.key, b.key);
    if (cmp === 0) return a.index - b.index;
    return descending ? -cmp : cmp;
  });
  return decorated.map((entry) => entry.item);
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

export class Collection {
  constructor(items = [], keys = null) {
    // A plain object is a PHP array with keys: keep them (a keyed collection
    // answers `all()` as the same object and `has('a')` is true).
    let sourceKeys = keys;
    if (items !== null && items !== undefined && !Array.isArray(items) && !(items instanceof Collection) && typeof items === 'object') {
      sourceKeys = sourceKeys || Object.keys(items);
    }
    this.items = items === null || items === undefined
      ? []
      : Array.isArray(items)
        ? items
        : items instanceof Collection
          ? items.items.slice()
          : Object.values(items);
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

  // ---- transforms (new Collection) --------------------------------------
  map(callback) {
    return new Collection(this.items.map((item, key) => callback(item, key)));
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
    return new Collection(sortBySpec(this.items, callback, false));
  }

  sortByDesc(callback) {
    return new Collection(sortBySpec(this.items, callback, true));
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
