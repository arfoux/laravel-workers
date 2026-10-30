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
 *   min(), groupBy(), keyBy(), unique(), uniqueStrict(), flatten(), where(),
 *   whereIn(), whereInStrict(), whereNotIn(), whereNotInStrict(), whereStrict(),
 *   whereNull(), whereNotNull(), slice(), take(), skip(), chunk(), reverse(),
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
 *   PHP arrays carry keys; a JS list does not, so this kernel keeps the PHP
 *   KEYS beside the values (`phpKeys`) on every collection it builds: `all()`,
 *   `toArray()` and `toJson()` answer an OBJECT as soon as the keys are not
 *   exactly 0..n-1 in order, which is what json_encode would answer.
 *   The limits that REMAIN:
 *     - a KEYED receiver (groupBy/keyBy/pluck($v, $k)/only/except) does not
 *       keep every key through the MUTATORS: push()/put()/pop()/pull()/
 *       prepend() do not maintain `phpKeys`, and forget() reindexes the
 *       remaining keys instead of leaving PHP's hole;
 *     - diff()/intersect()/flatten()/collapse() keep their own key rules but
 *       take the receiver's keys from `phpKeys` only where they compute them;
 *     - keyBy()/groupBy() drop the keys INSIDE each group (Laravel's
 *       `$preserveKeys` argument is not part of the signature) and a callback
 *       answering an ARRAY does not file the item under several groups;
 *     - an Eloquent model as a group/key/index key is not an "Illegal offset
 *       type" error here (PHP 8 throws), it is coerced through phpStr().
 *   These are shape limits on KEYED receivers only: for list input every method
 *   returns the value Laravel returns (values baked in
 *   kernel/tests/collections.test.mjs, probed against the vendored
 *   laravel/framework 13.37).
 *
 * MUTATORS
 *   put/push/pop/pull/forget/each/tap/prepend/transform/getOrPut mutate
 *   `this.items` and return `$this`, because that is Laravel's own contract
 *   (Collection::push/pop/put/pull/prepend/transform/getOrPut return $this).
 *   Every OTHER method answers a NEW Collection and leaves the receiver
 *   untouched — Laravel's immutability for transforms.
 *
 * The `where()` operator set is Laravel's operatorForWhere() (EnumeratesValues.php:1138-1165) verbatim,
 * INCLUDING its `default:` fall-through to a loose `==`: an operator the vendor does not enumerate
 * (even `like` — the Collections traits have no LIKE case) answers the same rows as PHP here, instead
 * of throwing. The spaceship `<=>` is supported; its -1/0/1 answer is truthiness-filtered exactly
 * like PHP's `filter(operatorForWhere(...))`.
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
// Laravel's `data_get($item, $key)` step by step, simplified for the two item
// shapes the compiled side sees: a MODEL (ArrayAccess -> getAttribute, its
// attributes live in `attributes`) and a plain JS object/array. `$key` is
// `explode('.', $key)` first, so a dotted key NESTS (data_get never reads a
// literal dotted key).
const readProp = (item, key) => {
  if (item === null || item === undefined) return null;
  // `data_get($item, null)` answers the TARGET itself, which is what
  // `Arr::pluck()` relies on: `->pluck(null)` is the items themselves and
  // `->pluck(null, 'id')` keys the whole item by its id (a probe on Laravel 13).
  if (key === null || key === undefined) return item;
  const segments = Array.isArray(key) ? key : String(key).split('.');
  let target = item;
  for (const segment of segments) {
    if (target === null || target === undefined) return null;
    if (typeof target.get === 'function' && target.attributes && typeof target.attributes === 'object') {
      target = target.get(segment);
    } else if (typeof target === 'object') {
      target = target[segment];
    } else {
      return null;
    }
  }
  return target;
};
const valueOf = (spec, item, key) => {
  if (typeof spec === 'function') return spec(item, key);
  if (spec === null || spec === undefined) return item;
  return readProp(item, spec);
};

/**
 * `data_get($item, $key)` as the `where()` family reads it: a NULL key answers
 * the ITEM itself (Laravel's `data_get()` returns `$target` when the key is
 * null - `whereNull()` with no argument filters the null ITEMS), and a key that
 * is not there answers NULL (PHP has no `undefined`; a missing segment is
 * `$default` = null, which is what `whereNull('missing')` matches).
 */
const valueForKey = (item, key) => {
  if (key === null || key === undefined) return item;
  const value = readProp(item, key);
  return value === undefined ? null : value;
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
 * `array_slice($items, $offset, $length, true)` - the PHP keys travel with the
 * values. Laravel's slice()/take()/skip() all pass `preserve_keys = true`
 * (Collection::slice(), :1290-1300), so a slice of a keyed collection stays
 * keyed and a slice that does NOT start at 0 answers an OBJECT from `all()`
 * (a probe: `collect([1,2,3])->slice(1)->all()` is `{"1":2,"2":3}`); only the
 * keys 0..n-1 in order read back as a list, which `phpArray()` already
 * normalizes.
 */
const phpSliceEntries = (items, keys, offset, length) => {
  const n = items.length;
  let off = Number(offset) | 0;
  if (off < 0) off = Math.max(n + off, 0);
  else if (off > n) off = n;
  let end = n;
  if (length !== undefined && length !== null) {
    const len = Number(length) | 0;
    end = len < 0 ? Math.max(n + len, off) : off + len;
  }
  return { values: items.slice(off, end), keys: keys.slice(off, end) };
};

/**
 * PHP 8's `==` - `array_unique(SORT_REGULAR)` and `in_array()` without strict
 * compare this way. `looseEq()` above covers scalars; OBJECTS compare equal
 * only to objects of the SAME class with equal properties (a probe: two
 * `(object) ['a' => 1]` answer one unique item, `(object) ['a' => 2]` answers
 * two). A MODEL compares through its attributes, which is where the row's
 * value lives at the edge (the compiler keeps them in `attributes`).
 */
const phpClassTag = (v) => {
  if (Array.isArray(v)) return 'Array';
  const name = v && v.constructor && v.constructor.name;
  return typeof name === 'string' && name !== 'Object' ? name : 'Object';
};
const phpLooseEquals = (a, b) => {
  if (a === b) return true;
  const aObj = a !== null && typeof a === 'object';
  const bObj = b !== null && typeof b === 'object';
  if (aObj || bObj) {
    if (!aObj || !bObj) return false;
    if (phpClassTag(a) !== phpClassTag(b)) return false;
    if (a instanceof Collection || b instanceof Collection) return a === b;
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

/** PHP's `is_object()`: a plain object or a model - an ARRAY is NOT an object. */
const isPhpObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * The vendor's string bucket (EnumeratesValues.php:1160-1166):
 * `is_string($value) || $value instanceof \Stringable`. The edge's only
 * Stringable is a Collection (`__toString()` answers its JSON).
 */
const isStringish = (v) => typeof v === 'string' || v instanceof Collection;
/** A PHP object's property table - a MODEL reads `attributes` (where the row is). */
const phpObjectProps = (v) => (v.attributes && typeof v.attributes === 'object' ? v.attributes : v);
const phpObjectPropKeys = (v) => Object.keys(phpObjectProps(v)).filter((k) => !k.startsWith('_'));
/** `phpCompare()` with PHP's object rules: an object outranks a non-object, and
 * two objects go through `phpObjectCompare()`. */
const phpCompareDeep = (a, b) => {
  const aObj = isPhpObject(a);
  const bObj = isPhpObject(b);
  if (aObj && bObj) {
    const cmp = phpObjectCompare(a, b);
    return cmp === null ? 1 : cmp;
  }
  if (aObj || bObj) return aObj ? 1 : -1;
  return phpCompare(a, b);
};
/**
 * PHP's `$a <=> $b` for two OBJECTS (probes: `(object)['n'=>1] <=> (object)['n'=>2]`
 * is -1, the same properties answer 0). The SAME class compares its property
 * table - fewer properties first, then key by key, then value by value (nested
 * objects recurse). A DIFFERENT class is UNCOMPARABLE and answers `null`, which
 * the callers turn into PHP's own answers (false for `<`/`>`/`<=`/`>=`, 1 for
 * `<=>` - a probe: `new stdClass() <=> new DateTime()` is 1 both ways).
 */
const phpObjectCompare = (a, b) => {
  if (phpClassTag(a) !== phpClassTag(b)) return null;
  const ka = phpObjectPropKeys(a);
  const kb = phpObjectPropKeys(b);
  if (ka.length !== kb.length) return ka.length < kb.length ? -1 : 1;
  const pa = phpObjectProps(a);
  const pb = phpObjectProps(b);
  for (let i = 0; i < ka.length; i += 1) {
    const keyCmp = phpCompare(ka[i], kb[i]);
    if (keyCmp !== 0) return keyCmp;
    const valueCmp = phpCompareDeep(pa[ka[i]], pb[kb[i]]);
    if (valueCmp !== 0) return valueCmp;
  }
  return 0;
};
/**
 * `operatorForWhere()`'s comparison (EnumeratesValues.php:1156-1190): the
 * operator switch over `data_get($item, $key)` and the value - with PHP's
 * OBJECT rules first, because PHP's `==` compares two objects of the same class
 * by their PROPERTIES and refuses to compare an object with a non-object.
 *
 * 1. Exactly ONE side is an object and fewer than two sides are strings or
 *    Stringables (`:1168-1170`): PHP answers `in_array($operator, ['!=', '<>',
 *    '!=='])` - nothing else is ever comparable across an object boundary
 *    (a probe: `where('x', '>', new stdClass())` is EMPTY, `!=` keeps every row).
 * 2. Two objects: `==`/`!=` compare property sets (name based, recursive -
 *    `phpLooseEquals()`), `===`/`!==` are identity, and the ordering operators
 *    go through `phpObjectCompare()`.
 * 3. Anything else is the scalar switch (a `<=>` answers -1/0/1 and `filter()`
 *    keeps the truthy ones - a probe: `where('n','<=>',2)` keeps n != 2). An
 *    operator the switch does not enumerate (including `like`: the Collections
 *    traits have no LIKE case at all) falls through to the loose `==`.
 */
const whereCompare = (op, a, b) => {
  const aObj = isPhpObject(a);
  const bObj = isPhpObject(b);
  if (aObj !== bObj && (isStringish(a) ? 1 : 0) + (isStringish(b) ? 1 : 0) < 2) {
    return op === '!=' || op === '<>' || op === '!==';
  }
  if (aObj && bObj) {
    const cmp = op === '<' || op === '>' || op === '<=' || op === '>=' || op === '<=>' ? phpObjectCompare(a, b) : 0;
    switch (op) {
      case '===':
        return a === b;
      case '!==':
        return a !== b;
      case '<':
        return cmp !== null && cmp < 0;
      case '>':
        return cmp !== null && cmp > 0;
      case '<=':
        return cmp !== null && cmp <= 0;
      case '>=':
        return cmp !== null && cmp >= 0;
      case '<=>':
        return cmp === null ? 1 : cmp;
      case '!=':
      case '<>':
        return !phpLooseEquals(a, b);
      default:
        return phpLooseEquals(a, b);
    }
  }
  switch (op) {
    case '===':
      return a === b;
    case '!==':
      return a !== b;
    case '!=':
    case '<>':
      return !phpLooseEquals(a, b);
    case '<':
      return phpCompare(a, b) < 0;
    case '>':
      return phpCompare(a, b) > 0;
    case '<=':
      return phpCompare(a, b) <= 0;
    case '>=':
      return phpCompare(a, b) >= 0;
    case '<=>':
      return phpCompare(a, b);
    default:
      return phpLooseEquals(a, b);
  }
};

const operatorForWhere = (operator) => (a, b) => whereCompare(String(operator), a, b);

/**
 * The `filter(operatorForWhere(...))` predicate shared by contains()/every()/
 * some()/sole()/firstOrFail() - `$key $operator $value` with the vendor's
 * two-argument shorthand (`$key = $operator`) and its data_get read. A callable
 * first argument is returned UNCHANGED, extra arguments and all
 * (EnumeratesValues.php:1140-1142).
 */
const whereFilter = (key, operator, value, argCount) => {
  if (typeof key === 'function') return key;
  // operatorForWhere() (:1144-1154): ONE argument means `$value = true,
  // $operator = '='`, TWO mean `$value = $operator, $operator = '='`.
  const test = operatorForWhere(argCount <= 2 ? '=' : String(operator));
  const expected = argCount === 1 ? true : argCount === 2 ? operator : value;
  return (item) => test(valueForKey(item, key), expected);
};

/**
 * The filter of `hasSole()`/`hasMany()` (EnumeratesValues.php:346-357): no
 * argument (or a null one) means NO filter (`unless($filter == null)`), several
 * arguments are a `where()` filter, and a single NON-callable argument is
 * passed to `filter()` - a TypeError in PHP (a probe: `hasSole('a')` throws
 * "Argument #1 ($callback) must be of type ?callable, string given").
 */
const soleFilterFor = (key, operator, value, argCount) => {
  if (argCount === 0 || key === null || key === undefined) return null;
  if (argCount > 1) return whereFilter(key, operator, value, argCount);
  if (typeof key === 'function') return key;
  throw new TypeError(
    'Collection::filter(): Argument #1 ($callback) must be of type ?callable, ' + phpTypeName(key) + ' given'
  );
};

/** Values of an arrayable-ish argument: Collection, array, object or scalar. */
import { phpJsonEncode, phpJsonEncodeWithFlags } from './php-json.mjs';

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

/** PHP's `gettype()` - used by the reduceSpread error message. */
const phpTypeName = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'double';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  return 'object';
};

/**
 * PHP 8's `get_debug_type()` - the name `ensure()` reports. A compiled class
 * answers its FQCN (the runtime marks an instance with `__lwClass`), a plain
 * object answers `stdClass`, a closure answers `Closure`. LIMITATION: the
 * kernel Collection itself answers `Collection` where PHP says
 * `Illuminate\Support\Collection` (the two cannot be told apart here).
 */
const phpDebugType = (v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'function') return 'Closure';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') {
    if (typeof v.__lwClass === 'string') return v.__lwClass;
    if (v[IS_COLLECTION] === true) return 'Illuminate\\Support\\Collection';
    const name = v.constructor && v.constructor.name;
    return name && name !== 'Object' ? name : 'stdClass';
  }
  return 'string';
};

/**
 * `data_has($target, $key)` = `Arr::has()` (a dot path; an ArrayAccess/model
 * target asks `offsetExists`, which for a Model means "the attribute is not
 * null"). A JS array/plain object asks `array_key_exists` (a null VALUE still
 * exists - a probe: `collect([['a' => null]])->value('a', 'D')` answers NULL).
 */
const dataHasProp = (target, key) => {
  if (target === null || target === undefined) return false;
  if (key === null || key === undefined) return true;
  const segments = Array.isArray(key) ? key : String(key).split('.');
  let current = target;
  for (const segment of segments) {
    if (current === null || current === undefined) return false;
    if (typeof current.get === 'function' && current.attributes && typeof current.attributes === 'object') {
      // Model::offsetExists(): `! is_null($this->getAttribute($offset))`.
      const value = current.get(segment);
      if (value === null || value === undefined) return false;
      current = value;
      continue;
    }
    if (typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return false;
      current = current[segment];
      continue;
    }
    return false;
  }
  return true;
};

/** `htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE)` (Laravel's `e()`). */
const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

/**
 * `new $class(...$args)` for the two shapes the edge can name: a constructor
 * reference (the kernel classes) or an FQCN STRING (a compiled app/model class
 * - the transpiler only makes `SomeClass::class` available for a registered
 * model, and the runtime resolves it through `Collection.__lwNewClass`).
 */
const constructClass = (className, args) => {
  if (typeof className === 'function') {
    // PHP's `Collection::__construct(array $items = [])` ignores the second
    // argument: `new Collection($value, $key)` must NOT set the PHP keys.
    if (className.__lwCollection === true) return new className(args[0]);
    return new className(...args);
  }
  if (typeof className === 'string' && typeof Collection.__lwNewClass === 'function') {
    return Collection.__lwNewClass(className, args);
  }
  const err = new Error(
    'the class ' + String(className) + ' cannot be constructed at the edge (a compiled class is named by its FQCN string, a kernel class by its constructor)'
  );
  err.name = 'Error';
  throw err;
};

/**
 * PHP's `round($value, $places)` (HALF_UP, i.e. half AWAY FROM ZERO).
 *
 * A plain `Math.round(value * 10 ** places)` is NOT the same: PHP pre-rounds
 * the value to the precision a double can hold (14 - log10|value| decimals)
 * before scaling, so `round(1.005, 2)` is 1.01 and `round(2.675, 2)` is 2.68
 * while JS would answer 1 and 2.67. `_php_math_round()` (math.c) is ported
 * step by step and verified against PHP 8.3 on 10,525 probed values (both
 * directions of the pre-round, negative `$places`, half cases) - 0 mismatches.
 */
const halfAwayRound = (v) => (v >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5));
// `_php_math_round_helper($value, HALF_UP, $places)`: scale by 10^places, round
// half away from zero, divide it back out.
const phpRoundHelper = (v, places) => {
  const p = Math.pow(10, places);
  return halfAwayRound(v * p) / p;
};
const phpRound = (value, places = 0) => {
  if (!Number.isFinite(value) || value === 0) return value;
  const low = -2147483647;
  const decimals = places < low ? low : places;
  const precisionPlaces = 14 - Math.floor(Math.log10(Math.abs(value)));
  let scaledValue = value;
  if (precisionPlaces > decimals && precisionPlaces - 15 < decimals) {
    scaledValue = phpRoundHelper(value, precisionPlaces < low ? low : precisionPlaces);
  }
  const factor = Math.pow(10, Math.abs(decimals));
  let tmp = decimals < 0 ? scaledValue / factor : scaledValue * factor;
  if (Math.abs(tmp) >= 1e15) return scaledValue;
  tmp = phpRoundHelper(tmp, 14 - Math.floor(Math.log10(Math.abs(tmp))));
  tmp = halfAwayRound(tmp);
  return decimals < 0 ? tmp * factor : tmp / factor;
};

/**
 * `json_encode($value, JSON_PRETTY_PRINT)`: PHP's pretty printer - FOUR-space
 * indentation and `"key": value`, not JSON.stringify's two spaces. Verified
 * byte for byte against PHP 8.3 on lists, keyed arrays, empty array/object,
 * nested depth, escaped slashes and unicode.
 */
const phpJsonPretty = (value, depth = 0) => {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const pad = '    '.repeat(depth + 1);
    return '[\n' + value.map((item) => pad + phpJsonPretty(item, depth + 1)).join(',\n') + '\n' + '    '.repeat(depth) + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const pad = '    '.repeat(depth + 1);
    return (
      '{\n' +
      keys.map((key) => pad + phpJsonEncode(key) + ': ' + phpJsonPretty(value[key], depth + 1)).join(',\n') +
      '\n' + '    '.repeat(depth) + '}'
    );
  }
  return phpJsonEncode(value);
};

/**
 * PHP 8's `+` for one operand pair — the fold of EnumeratesValues::sum()/avg().
 * Probed against PHP 8.3 for the hub oracle:
 *   - a FULLY numeric string is its number, and so is a LEADING-numeric one:
 *     `0 + "5abc"` is 5, `0 + "1_000"` is 1, `0 + "0x1A"` is 0 (the prefix is
 *     the number, a warning PHP emits and the edge does not), and the honoured
 *     prefixes are decimal only — `0 + "abc"` is a TypeError;
 *   - null is 0, true is 1, false is 0;
 *   - an array or an object is a TypeError.
 */
const phpNumeric = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') {
    // PHP's numeric string allows only ASCII whitespace around the literal
    // (`' 5 '` is numeric, `'5\u00a0'` is not) - JS `trim()` would also eat
    // NBSP/FEFF/BOM and answer 5 without the warning below.
    const trimmed = v.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, '');
    const match = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(trimmed);
    if (match) {
      // PHP 8 accepts a numeric string whole (`'5'`, `' 5 '`), but a string with
      // only a numeric PREFIX walks a different path: `'5a'` raises
      // E_WARNING "A non-numeric value encountered" and adds the prefix, and
      // Laravel's error handler promotes that warning to ErrorException - so
      // `collect(['5a'])->sum()` is a 500, not 5. Probed on PHP 8.3:
      // ['5a'] -> ErrorException, ['abc'] -> the TypeError below.
      if (match[0].length !== trimmed.length) {
        const err = new Error('A non-numeric value encountered');
        err.name = 'ErrorException';
        err.phpClass = 'ErrorException';
        throw err;
      }
      return Number(match[0]);
    }
    const err = new Error('Unsupported operand types: int + string');
    err.name = 'TypeError';
    err.phpClass = 'TypeError';
    throw err;
  }
  const err = new Error('Unsupported operand types: int + ' + typeof v);
  err.name = 'TypeError';
  err.phpClass = 'TypeError';
  throw err;
};

const phpAdd = (a, b) => a + phpNumeric(b);

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

/** A PHP integer key (the coerced `arrayKey()` number). */
const isIntKey = (key) => typeof arrayKey(key) === 'number';

/**
 * PHP's `array_shift()`/`array_unshift()`/`array_splice()` RENUMBER the integer
 * keys in place (string keys keep their names, a probe:
 * `[5 => 'a', 'k' => 'b']` after a shift answers `{'k' => 'b'}`, and
 * `[3 => 'c']->unshift('a')` answers `{0:'a', 1:'c'}`).
 */
const reindexIntKeys = (collection) => {
  if (!collection.phpKeys) return;
  let next = 0;
  collection.phpKeys = collection.phpKeys.map((key) =>
    typeof arrayKey(key) === 'number' ? next++ : arrayKey(key)
  );
};

/** A PHP array value (list -> JS array, keyed -> plain object) from entries. */
const phpArrayFrom = (values, keys) => {
  if (keys.every((key, index) => normKey(key) === index)) return values.slice();
  const out = {};
  keys.forEach((key, index) => { out[String(arrayKey(key))] = values[index]; });
  return out;
};

/** True for a value PHP treats as an array (a JS array or a PHP-array object). */
const isArrayLike = (v) =>
  Array.isArray(v) || (v !== null && typeof v === 'object' && !(v instanceof Collection) && typeof v.get !== 'function' && Object.getPrototypeOf(v) === Object.prototype);

/**
 * `array_replace_recursive($left, $right)` as `{values, keys}`: every key of
 * `$right` replaces the matching one, recursing when BOTH sides are arrays.
 */
const replaceRecursiveEntries = (leftValues, leftKeys, rightEntries) => {
  const values = leftValues.slice();
  const keys = leftKeys.slice();
  for (const entry of rightEntries) {
    const k = arrayKey(entry.key);
    const at = keys.findIndex((key) => String(arrayKey(key)) === String(k));
    if (at !== -1 && isArrayLike(values[at]) && isArrayLike(entry.value)) {
      const leftEntries = entriesOf(values[at]);
      const rightSub = entriesOf(entry.value);
      const merged = replaceRecursiveEntries(
        leftEntries.map((e) => e.value),
        leftEntries.map((e) => e.key),
        rightSub
      );
      values[at] = phpArrayFrom(merged.values, merged.keys);
    } else if (at !== -1) {
      values[at] = entry.value;
    } else {
      keys.push(k);
      values.push(entry.value);
    }
  }
  return { values, keys };
};

const phpArrayReplaceRecursive = (left, right) => {
  const leftEntries = entriesOf(left) || [];
  const rightEntries = entriesOf(right) || [];
  const merged = replaceRecursiveEntries(
    leftEntries.map((e) => e.value),
    leftEntries.map((e) => e.key),
    rightEntries
  );
  return phpArrayFrom(merged.values, merged.keys);
};

/**
 * `array_merge_recursive($left, $right)`: integer keys are renumbered and
 * appended, a duplicate STRING key with an array on both sides merges
 * recursively, and otherwise the two values become `[old, new]` (probes:
 * `['a' => 1] + ['a' => 2]` is `['a' => [1, 2]]`, `['a' => [1]] + ['a' => 2]`
 * is `['a' => [1, 2]]`).
 */
const phpArrayMergeRecursive = (left, right) => {
  const leftEntries = entriesOf(left) || [];
  const rightEntries = entriesOf(right) || [];
  const values = [];
  const keys = [];
  const positions = new Map();
  for (const entry of leftEntries) {
    const k = arrayKey(entry.key);
    const stored = typeof k === 'number' ? null : k;
    values.push(entry.value);
    keys.push(stored === null ? values.length - 1 : stored);
    if (stored !== null) positions.set(String(stored), values.length - 1);
  }
  for (const entry of rightEntries) {
    const k = arrayKey(entry.key);
    const at = typeof k === 'number' ? -1 : positions.has(String(k)) ? positions.get(String(k)) : -1;
    if (at === -1) {
      values.push(entry.value);
      keys.push(typeof k === 'number' ? values.length - 1 : k);
      if (typeof k !== 'number') positions.set(String(k), values.length - 1);
      continue;
    }
    const current = values[at];
    if (isArrayLike(current) && isArrayLike(entry.value)) {
      values[at] = phpArrayMergeRecursive(current, entry.value);
    } else {
      const head = isArrayLike(current) ? toList(current) : [current];
      const tail = isArrayLike(entry.value) ? toList(entry.value) : [entry.value];
      values[at] = [...head, ...tail];
    }
  }
  return phpArrayFrom(values, keys);
};

/** `Arr::exists($item, $key)` for the shapes the edge sees (array, object, model). */
const selectHasKey = (item, key) => {
  if (item === null || item === undefined) return false;
  if (Array.isArray(item)) {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < item.length;
  }
  if (typeof item === 'object') {
    if (item.attributes && typeof item.get === 'function') {
      return Object.prototype.hasOwnProperty.call(item.attributes, String(key));
    }
    return Object.prototype.hasOwnProperty.call(item, String(key));
  }
  return false;
};

/** The literal `$item[$key]` read (Arr::select never uses data_get). */
const selectReadKey = (item, key) => {
  if (item.attributes && typeof item.get === 'function') return item.get(key);
  const value = item[key];
  return value === undefined ? null : value;
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
  // `Illuminate\Contracts\Support\Jsonable::jsonSerialize()` -> `all()`:
  // php-json.mjs writes a Collection as its underlying array (PHP's
  // `json_encode(new Collection([...]))`), so a JSON cast of a `collection`
  // attribute and `response()->json($collection)` store the same bytes.
  static __lwCollection = true;
  /**
   * The runtime's FQCN constructor (`rt.newClass`), injected by
   * compiler/runtime/rt-from-context.mjs: `mapInto()`/`pipeInto()` may name a
   * COMPILED class (`SomeModel::class` compiles to its FQCN string), which only
   * the runtime can build (its constructor takes the dependency bundle).
   */
  static __lwNewClass = null;

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
      // Coerced like PHP's array keys: a JSON `{"5":"x"}` is the INT key 5,
      // so `push()` appends at 6, not at 0.
      sourceKeys = sourceKeys || Object.keys(items).map((k) => arrayKey(k));
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

  /**
   * `Collection::toJson($options = 0)` (Collection.php:1180-1183):
   * `json_encode($this->all(), $options)` - PHP's bytes. The flags are honoured
   * through the shared engine, so `->toJson(JSON_UNESCAPED_UNICODE)` writes the
   * same bytes PHP does (before, the argument was ignored - a silent divergence).
   */
  toJson(options = 0) {
    return phpJsonEncodeWithFlags(this.all(), options);
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
    // `firstWhere()` IS `first($this->operatorForWhere(...func_get_args()))`
    // (EnumeratesValues::firstWhere(), :333-336), so EVERY form the where
    // filter supports works here: one argument means `$key = true`, two mean
    // `$key = $operator`, three are `$key $operator $value` - and each item's
    // key is read with `data_get()` (models through their attributes).
    return this.first(whereFilter(key, operator, value, arguments.length));
  }

  first(predicate = null, fallback = null) {
    if (typeof predicate !== 'function') {
      return this.items.length > 0 ? this.items[0] : fallback;
    }
    const index = this.items.findIndex((item, i) => predicate(item, keyAt(this, i)));
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
        const actual = entry === null || entry === undefined ? null : readProp(entry, key);
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
      : this.items.filter((item, index) => predicate(item, keyAt(this, index)));
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
  /** `put($key, $value)` -- `offsetSet()` on the underlying array: an EXISTING
   *  key (normKey-compared) is overwritten in place, a NEW key is APPENDED and
   *  the array stops being a list as soon as a non-sequential key appears
   *  (`collect(['a'])->put('x', 'y')->all()` is `[0 => 'a', 'x' => 'y']`). */
  put(key, value) {
    // `offsetSet(null, $v)` is `$items[] = $v` (ArrayAccess) - an APPEND.
    if (key === null || key === undefined) return this.push(value);
    const at = this.indexOfKey(normKey(key));
    if (at !== -1) {
      this.items[at] = value;
      return this;
    }
    const phpKeys = currentKeys(this);
    phpKeys.push(normKey(key));
    this.items.push(value);
    this.phpKeys = phpKeys;
    return this;
  }

  /** `push(...$values)` -- `$this->items[] = $value` per value (Collection.php
   *  :1079-1086): the key is PHP's next free INTEGER (`max(int keys) + 1`), so
   *  `collect(['a' => 1])->push('x')` answers `['a' => 1, 0 => 'x']` and a
   *  sequence grows to n+1. */
  push(...values) {
    if (values.length === 0) return this;
    const phpKeys = currentKeys(this);
    for (const value of values) {
      phpKeys.push(nextIntKey(phpKeys));
      this.items.push(value);
    }
    this.phpKeys = phpKeys;
    return this;
  }

  /** `pop($count = 1)` (Collection.php:1030-1070): one value, or a NEW
   *  collection of the last `$count` (an empty collection for `$count < 1`).
   *  The old signature answered the value and DROPPED the argument, so
   *  `pop(2)` answered the last element where PHP answers `[3, 2]`. */
  pop(count = 1) {
    if (count < 1) return new Collection();
    if (count === 1) {
      if (this.items.length === 0) return null;
      const value = this.items.pop();
      if (this.phpKeys) this.phpKeys.pop();
      return value;
    }
    // `array_pop()` per value: the result is the popped values in POP order
    // (`[1,2,3]->pop(2)` is `[3, 2]`) and always a plain list - the source keys
    // are gone with the values.
    const popped = [];
    for (let i = 0; i < count && this.items.length > 0; i++) {
      popped.push(this.items.pop());
      if (this.phpKeys) this.phpKeys.pop();
    }
    return new Collection(popped);
  }

  pull(key) {
    const value = this.get(key, null);
    this.forget(key);
    return value;
  }

  /** `forget($keys)` (Collection.php:475-482): each key through
   *  `offsetUnset()` -- a plain `unset($items[$key])` (Collection.php:2020).
   *  A LIST therefore keeps a HOLE (`collect([1,2,3])->forget(1)->all()` is
   *  `[0 => 1, 2 => 3]`), which `splice()` used to close; the key may also be
   *  an ARRAY of keys, and a dotted key is NOT split (the literal `'a.b'` key
   *  is the one removed). */
  forget(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      const at = this.indexOfKey(normKey(key));
      if (at === -1) continue;
      // The hole needs the keys to exist: a plain list gets them first, so the
      // remaining positions stay 0..n-1 MINUS the removed one (PHP's `unset`).
      if (!this.phpKeys) this.phpKeys = this.items.map((_, index) => index);
      this.items.splice(at, 1);
      this.phpKeys.splice(at, 1);
    }
    return this;
  }

  /** `each(callable $callback)` (Collection::each(), :628-645): the callback
   *  takes `($item, $key)` with the PHP KEY (a keyed collection hands out its
   *  real keys), and the collection is returned. */
  each(callback) {
    this.items.forEach((item, index) => callback(item, keyAt(this, index)));
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
  /**
   * `map(callable $callback)` (Collection::map(): `Arr::map($this->items,
   * $callback)`): the KEYS survive - a keyed collection stays keyed and int
   * keys survive too (a probe: `collect([5 => 'x', 9 => 'y'])->map(fn ($v) =>
   * $v.'!')->all()` is `{"5":"x!","9":"y!"}`). The edge reindexed, so any
   * `->map()` over a keyed collection answered a different JSON payload.
   */
  map(callback) {
    return new Collection(this.items.map((item, index) => callback(item, keyAt(this, index))), currentKeys(this));
  }

  /**
   * `filter($callback = null)` (Collection::filter(): `Arr::where()` /
   * `array_filter()`): the surviving items keep their KEYS (a probe:
   * `[1, 2, 3]->filter(fn ($v) => $v > 1)->all()` is `{"1":2,"2":3}`). Without
   * a callback array_filter() drops the FALSY items ('' / '0' / 0 / null /
   * false / [] are all false in PHP, which `phpTruthy()` mirrors).
   */
  filter(callback = null) {
    const values = [];
    const keys = [];
    this.items.forEach((item, index) => {
      const keep = typeof callback === 'function' ? callback(item, keyAt(this, index)) : phpTruthy(item);
      if (keep) {
        values.push(item);
        keys.push(keyAt(this, index));
      }
    });
    return new Collection(values, keys);
  }

  /** `reject($callback)` (Collection::reject()): `filter()` negated, keys kept. */
  reject(callback) {
    const values = [];
    const keys = [];
    this.items.forEach((item, index) => {
      if (!callback(item, keyAt(this, index))) {
        values.push(item);
        keys.push(keyAt(this, index));
      }
    });
    return new Collection(values, keys);
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

  values() {
    return new Collection(this.items.slice());
  }

  keys() {
    // `keys()` answers the array's keys: the indexes for a list, the PHP keys
    // for a keyed collection.
    return new Collection(this.phpKeys ? this.phpKeys.slice() : this.items.map((_, index) => index));
  }

  /**
   * `merge($items)` (Collection::merge(), :893-896): `array_merge($this->items,
   * getArrayableItems($items))` - NUMERIC keys (ints and canonical int strings)
   * are renumbered from 0 in order, STRING keys are kept and overwrite in
   * place. The edge concatenated, which dropped every string key (a probe:
   * `['a' => 1]->merge(['b' => 2])->all()` is `{"a":1,"b":2}` where the edge
   * answered `[1,2]`).
   */
  merge(items) {
    const source = items instanceof Collection
      ? items.items.map((value, index) => ({ key: items.phpKeys ? items.phpKeys[index] : index, value }))
      : Array.isArray(items)
        ? items.map((value, index) => ({ key: index, value }))
        : items !== null && items !== undefined && typeof items === 'object'
          ? Object.entries(items).map(([key, value]) => ({ key: arrayKey(key), value }))
          : [{ key: 0, value: items }];
    const sequence = this.items
      .map((value, index) => ({ key: keyAt(this, index), value }))
      .concat(source);
    const values = [];
    const keys = [];
    const stringPositions = new Map();
    let counter = 0;
    for (const entry of sequence) {
      const key = arrayKey(entry.key);
      if (typeof key === 'number') {
        keys.push(counter++);
        values.push(entry.value);
      } else {
        const id = String(key);
        if (stringPositions.has(id)) values[stringPositions.get(id)] = entry.value;
        else {
          stringPositions.set(id, values.length);
          keys.push(key);
          values.push(entry.value);
        }
      }
    }
    return new Collection(values, keys);
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
      if (strict ? item === value : phpLooseEquals(item, value)) return keyAt(this, i);
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
      const duplicate = seen.some((entry) => (strict ? entry === value : phpLooseEquals(entry, value)));
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

  /**
   * `implode($value, $glue = null)` (Collection::implode(), :642-655): a
   * CALLABLE first argument is mapped first; when the FIRST item is an array or
   * an object that is not Stringable (a model, a collection) the values are
   * `pluck($value)`ed and joined with `$glue ?? ''`; only a list of scalars
   * joins the items themselves with `$value ?? ''`.
   *
   * The edge joined the raw items with the first argument whenever the glue was
   * missing, so `->implode('n')` over arrays answered "ObjectnObject" where
   * Laravel answers "ab" (a probe), i.e. the key-only form - the one used for
   * `['a', 'b']->implode(', ')` AND for `$rows->implode('title')` - was wrong
   * for every non-scalar collection.
   */
  implode(value = '', glue = null) {
    if (typeof value === 'function') {
      return this.items
        .map((item, index) => value(item, keyAt(this, index)))
        .map(phpStr)
        .join(String(glue === null || glue === undefined ? '' : glue));
    }
    const first = this.items.length > 0 ? this.items[0] : null;
    if (first !== null && typeof first === 'object') {
      const plucked = this.pluck(value);
      return plucked.items.map(phpStr).join(String(glue === null || glue === undefined ? '' : glue));
    }
    return this.items.map(phpStr).join(String(value === null || value === undefined ? '' : value));
  }

  /**
   * `contains($key, $operator = null, $value = null)` (Collection::contains(),
   * :1305-1316): ONE argument is `array_any($items, $key)` for a callable (the
   * PHP TRUTHINESS of the answer — a callback answering '0' is false) and a
   * LOOSE `in_array` for a plain value; MORE arguments are a `where()` filter
   * (`contains(operatorForWhere(...))`), so `contains('price', '>', 100)` and
   * `contains('price', 100)` filter. The edge ignored the extra arguments, so
   * the operator form answered "no" for every collection.
   */
  contains(key, operator = null, ...rest) {
    if (arguments.length === 1) {
      if (typeof key === 'function') {
        return this.items.some((item, index) => phpTruthy(key(item, keyAt(this, index))));
      }
      return this.items.some((item) => phpLooseEquals(item, key));
    }
    return this.contains(whereFilter(key, operator, arguments.length === 2 ? null : rest[0], arguments.length));
  }

  /**
   * `every($key, $operator = null, $value = null)` (EnumeratesValues::every(),
   * :1139-1150): ONE argument goes through `valueRetriever()`, so a STRING is
   * a `data_get` key and the test is the VALUE's PHP truthiness - `every()`
   * (nothing) and `every($callback)` were the only forms the edge knew, and
   * `every('active')` threw instead of testing the column. MORE arguments are
   * a `where()` filter.
   */
  every(key, operator = null, ...rest) {
    if (arguments.length === 1) {
      if (typeof key === 'function') {
        return this.items.every((item, index) => phpTruthy(key(item, keyAt(this, index))));
      }
      return this.items.every((item) => phpTruthy(readProp(item, key)));
    }
    return this.every(whereFilter(key, operator, arguments.length === 2 ? null : rest[0], arguments.length));
  }

  /** `some($key, $operator = null, $value = null)` (EnumeratesValues::some(),
   *  :1157-1160): `contains(...func_get_args())`. */
  some(...args) {
    return this.contains(...args);
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
  // `sum($callback = null)` (EnumeratesValues::sum(), :1206-1212):
  // `reduce(fn ($result, $item, $key) => $result + $callback($item, $key), 0)`.
  // PHP's `+` is not Number(): '5a' is leading-numeric (5), null/true/false
  // coerce to 0/1/0, and a NON-numeric string or an array is a TypeError
  // (a probe: `collect(['abc'])->sum()` throws "Unsupported operand types:
  // int + string"). Number() answered NaN for both.
  sum(callback = null) {
    return this.items.reduce((total, item, key) => phpAdd(total, valueOf(callback, item, key)), 0);
  }
  // `avg($callback = null)` (EnumeratesValues::avg(), :1298-1312): NULL values
  // are SKIPPED and do not count toward the divisor (a probe: avg([1, null]) is
  // 1 and avg([1, null, 3]) is 2 - the edge divided by the full length, 0.5 /
  // 1.33), and an empty (or all-null) collection answers null.
  avg(callback = null) {
    let total = 0;
    let count = 0;
    this.items.forEach((item, key) => {
      const value = valueOf(callback, item, key);
      if (value === null || value === undefined) return;
      total = phpAdd(total, value);
      count += 1;
    });
    return count ? total / count : null;
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
  /**
   * `groupBy($groupBy, $preserveKeys = false)` (Collection::groupBy(),
   * :530-570): the group keys use PHP's ARRAY KEY coercion - `is_bool` becomes
   * `(int)`, a null/Stringable becomes a string, and a numeric string becomes
   * an INT key (a probe: `groupBy(fn ($v) => $v)->keys()->all()` over `[1, 2]`
   * is `[1, 2]`, the ints, where the edge answered `['1', '2']` - a DIFFERENT
   * JSON payload for `->keys()`).
   *
   * MODELLED: `$preserveKeys = true` keeps the SOURCE keys inside each group
   * (`{"x":["a","b"],"y":{"2":"c","3":"d"}}`), a callback that answers an ARRAY
   * puts the item into SEVERAL groups (one per element), and an ARRAY first
   * argument is the multi-LEVEL form: the first spec groups, the rest runs on
   * each group (`->groupBy(['account_id', 'year'])`).
   */
  groupBy(callback, preserveKeys = false) {
    // `groupBy([$inner, $outer...], $preserveKeys)` groups by the FIRST spec and
    // runs the rest on each group (Collection.php:530-570); a bare KEY/Closure
    // is one spec.
    // `useAsCallable($v)` is false for an array (PHP), so a bare array is a
    // LIST OF SPECS, not a callback.
    const specs = Array.isArray(callback) ? callback.slice() : [callback];
    const primary = specs.shift();
    const order = [];
    const groups = new Map();
    this.items.forEach((item, key) => {
      // `offsetSet(null)` on a LIST appends, so a list source keeps no keys
      // unless `$preserveKeys` asks for them.
      const sourceKey = arrayKey(keyAt(this, key));
      const groupKeysRaw = valueOf(primary, item, key);
      const groupKeys = Array.isArray(groupKeysRaw) ? groupKeysRaw : [groupKeysRaw];
      for (const raw of groupKeys) {
        const groupKey = arrayKey(raw);
        const id = String(groupKey);
        if (!groups.has(id)) {
          groups.set(id, { items: [], keys: [] });
          order.push(groupKey);
        }
        const group = groups.get(id);
        group.items.push(item);
        if (preserveKeys) group.keys.push(sourceKey);
      }
    });
    const grouped = new Collection(
      order.map((groupKey) => {
        const group = groups.get(String(groupKey));
        return new Collection(group.items, group.keys.length ? group.keys : null);
      }),
      order
    );
    if (specs.length === 0) return grouped;
    return grouped.map((group) => group.groupBy(specs, preserveKeys));
  }

  keyBy(callback) {
    // `keyBy($keyBy)` (Collection.php:1922-1948): the LAST item for a duplicate
    // key wins (`$results[$resolvedKey] = $item`) while the KEY keeps its first
    // position (PHP's in-place overwrite); no status assignment here.
    const order = [];
    const byKey = new Map();
    this.items.forEach((item, key) => {
      const groupKey = arrayKey(valueOf(callback, item, key));
      const id = String(groupKey);
      if (!byKey.has(id)) order.push(groupKey);
      byKey.set(id, item);
    });
    return new Collection(order.map((groupKey) => byKey.get(String(groupKey))), order);
  }

  /**
   * `unique($key = null, $strict = false)` (Collection::unique(),
   * :1859-1876). With no key and `$strict === false` it is
   * `array_unique($items, SORT_REGULAR)` - PHP's `==`, where two objects are
   * equal when their CLASS and properties match. The edge compared
   * `phpStr($value)`, which answered 'Object' for EVERY object, so
   * `$posts->unique()` collapsed a whole collection of DIFFERENT rows into one
   * item (a probe: two equal objects answer 1, two objects with different
   * attributes answer 2). With a key (or `$strict`) Laravel rejects an item
   * whose value is already in `$exists`, compared with `in_array(...)`. The
   * surviving items keep their KEYS (`reject()` preserves them).
   */
  unique(callback = null, strict = false) {
    const values = [];
    const keys = [];
    const seen = [];
    const isDuplicate = strict
      ? (value) => seen.some((entry) => entry === value)
      : (value) => seen.some((entry) => phpLooseEquals(value, entry));
    this.items.forEach((item, index) => {
      const value =
        callback === null || callback === undefined ? item : valueOf(callback, item, keyAt(this, index));
      if (isDuplicate(value)) return;
      seen.push(value);
      values.push(item);
      keys.push(keyAt(this, index));
    });
    return new Collection(values, keys);
  }

  /** `uniqueStrict($key = null)` (Enumerable.php:1247): `unique($key, true)`. */
  uniqueStrict(callback = null) {
    return this.unique(callback, true);
  }

  /**
   * `flatten($depth = INF)` (Collection::flatten(), :1053-1056 →
   * Arr::flatten(), :285-303). The edge recursed ALL the way down whatever the
   * depth, so `flatten(1)` answered a different SHAPE than Laravel (a probe:
   * `[[1, [2]], 3]->flatten(1)` is `[1, [2], 3]` in PHP, `[1, 2, 3]` here).
   * On a nested Collection the vendor takes `$item->all()` and keeps the SAME
   * depth rung for it.
   */
  flatten(depth = Infinity) {
    const out = [];
    const walk = (value, remaining) => {
      const item = value instanceof Collection ? value.items.slice() : value;
      if (!Array.isArray(item)) {
        out.push(item);
        return;
      }
      if (remaining === 1) {
        item.forEach((entry) => out.push(entry));
        return;
      }
      item.forEach((entry) => walk(entry, remaining - 1));
    };
    this.items.forEach((item) => walk(item, depth));
    return new Collection(out);
  }

  // ---- where ------------------------------------------------------------
  /**
   * `where($key, $operator = null, $value = null)`
   * (EnumeratesValues::where(), :657-660 → filter(operatorForWhere(...))): the
   * item is read with `data_get($item, $key)`, so a DOTTED key walks nested
   * arrays and a MODEL answers through `getAttribute()` (a probe:
   * `collect([['a' => ['b' => 2]]])->where('a.b', 2)` answers one item, and the
   * edge's raw `$item['a.b']` answered none). One argument tests `= true`.
   *
   * operatorForWhere() (:1138-1142) answers the CALLABLE ITSELF when the key is
   * one, so `where(fn ($v) => $v > 1)` is `filter($fn)` - the edge used to read
   * the closure as a key and answer nothing.
   */
  where(key, operator, value) {
    if (typeof key === 'function') return this.filter(key);
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
    return this.filter((item) => test(valueForKey(item, key), expected));
  }

  /**
   * `whereIn($key, $values, $strict = false)` (EnumeratesValues::whereIn():
   * :704-709 → `filter(fn ($item) => in_array(data_get($item, $key), ...))`).
   * `$strict` was ignored before, so `whereIn('id', ['1'], true)` matched the
   * int 1 (a probe: PHP answers 0 matches, `==` answers 1). Delegate to
   * `filter()`: the surviving items keep their KEYS (a probe:
   * `collect(['a'=>1,'b'=>2])->whereIn('x', [1])->all()` is `{"a":1}`).
   */
  whereIn(key, values, strict = false) {
    const candidates = toList(values);
    return this.filter((item) =>
      candidates.some((candidate) => (strict ? valueForKey(item, key) === candidate : phpLooseEquals(valueForKey(item, key), candidate)))
    );
  }

  /** `whereInStrict($key, $values)` (EnumeratesValues): `whereIn(..., true)`. */
  whereInStrict(key, values) {
    return this.whereIn(key, values, true);
  }

  /** `whereNotIn($key, $values, $strict = false)`: `! in_array(data_get(...))`. */
  whereNotIn(key, values, strict = false) {
    const candidates = toList(values);
    return this.filter((item) =>
      !candidates.some((candidate) => (strict ? valueForKey(item, key) === candidate : phpLooseEquals(valueForKey(item, key), candidate)))
    );
  }

  /** `whereNotInStrict($key, $values)` (EnumeratesValues): `whereNotIn(..., true)`. */
  whereNotInStrict(key, values) {
    return this.whereNotIn(key, values, true);
  }

  /** `whereStrict($key, $value)` (EnumeratesValues): `where($key, '===', $value)`. */
  whereStrict(key, value) {
    return this.where(key, '===', value);
  }

  /**
   * `whereNull($key = null)` (EnumeratesValues, :668-671):
   * `whereStrict($key, null)`. With NO argument the key is null, and
   * `data_get($item, null)` answers the ITEM itself - so `whereNull()` filters
   * the null ITEMS (the edge read the undefined key and kept everything).
   */
  whereNull(key = null) {
    return this.whereStrict(key, null);
  }

  /** `whereNotNull($key = null)` (EnumeratesValues, :679-682): `where($key, '!==', null)`. */
  whereNotNull(key = null) {
    return this.where(key, '!==', null);
  }

  // ---- slicing ----------------------------------------------------------
  /**
   * `slice($offset, $length = null)` (Collection::slice(), :1290-1300):
   * `array_slice($this->items, $offset, $length, true)` - the KEYS are
   * PRESERVED, so a slice answers an object from `all()` unless the surviving
   * keys are exactly 0..n-1 (a probe: `[1,2,3]->slice(1)->all()` is
   * `{"1":2,"2":3}`).
   */
  slice(offset, length) {
    const cut = phpSliceEntries(this.items, currentKeys(this), offset, length);
    return new Collection(cut.values, cut.keys);
  }

  /** `take($limit)`: `$limit < 0` slices from the END, both preserve keys. */
  take(limit) {
    const count = Number(limit) | 0;
    return count < 0
      ? this.slice(count, Math.abs(count))
      : this.slice(0, count);
  }

  /** `skip($count)`: `slice($count)` - keys preserved. */
  skip(count) {
    return this.slice(Number(count) | 0);
  }

  chunk(size) {
    const n = Number(size) | 0;
    if (n <= 0) return new Collection();
    const entries = this.items.map((value, index) => ({ key: keyAt(this, index), value }));
    const chunks = [];
    for (let i = 0; i < entries.length; i += n) {
      // PHP's array_chunk() PRESERVES the keys (a probe: a 5-item collection
      // chunked by 2 answers `[[1, 2], [3, 4], {4: 5}]`), and a keyed one
      // answers `[{"a":1,"b":2}, {"c":3}]` - the positional index is wrong
      // for a keyed collection.
      const slice = entries.slice(i, i + n);
      chunks.push(new Collection(slice.map((entry) => entry.value), slice.map((entry) => entry.key)));
    }
    return new Collection(chunks);
  }

  /**
   * `reverse()` (Collection::reverse(), :1543-1553): `array_reverse($items,
   * true)` - the KEYS are PRESERVED and travel the other way (a probe:
   * `[1,2,3]->reverse()->all()` is `{"2":3,"1":2,"0":1}`, and on a keyed
   * collection `{"c":3,"b":2,"a":1}`), so the reversed list is NOT a list
   * unless the original keys were 0..n-1.
   */
  reverse() {
    return new Collection(this.items.slice().reverse(), currentKeys(this).slice().reverse());
  }

  // ---- aggregation ------------------------------------------------------
  /**
   * `reduce(callable $callback, $initial = null)`
   * (EnumeratesValues::reduce(), :845-854): fold with `($carry, $value,
   * $key)` - the PHP key, not the position. `reduceWithKeys()` is the same
   * method under a second name (:911-914).
   */
  reduce(callback, initial = null) {
    let result = initial;
    this.items.forEach((item, index) => {
      result = callback(result, item, keyAt(this, index));
    });
    return result;
  }

  reduceWithKeys(callback, initial = null) {
    return this.reduce(callback, initial);
  }

  /**
   * `reduceInto($initial, callable $callback)` (:865-872): the callback MUTATES
   * `$initial` (`call_user_func_array` style is not used here) and the initial
   * is answered as it is - a probe: `into = []; reduceInto(into, fn (&$c,$v) =>
   * $c[] = $v)` answers the same array object.
   */
  reduceInto(initial, callback) {
    this.items.forEach((item, index) => {
      callback(initial, item, keyAt(this, index));
    });
    return initial;
  }

  /**
   * `reduceSpread(callable $callback, ...$initial)` (:883-899): `$initial`
   * spreads into the callback and the answer feeds the next call; a
   * non-array answer is an `UnexpectedValueException`.
   */
  reduceSpread(callback, ...initial) {
    let result = initial;
    this.items.forEach((item, index) => {
      result = callback(...result, item, keyAt(this, index));
      const isArrayLike = Array.isArray(result) || (result !== null && typeof result === 'object' && Object.getPrototypeOf(result) === Object.prototype);
      if (!isArrayLike) {
        const err = new Error(
          'Collection::reduceSpread expects reducer to return an array, but got a \'' + phpTypeName(result) + '\' instead.'
        );
        err.name = 'UnexpectedValueException';
        err.phpClass = 'UnexpectedValueException';
        throw err;
      }
    });
    return result;
  }

  /** `average($callback)` (:226-229): the `avg()` alias. */
  average(callback = null) {
    return this.avg(callback);
  }

  /**
   * `percentage(callable $callback, int $precision = 2)` (:564-574): the share
   * of items the callback accepts, in percent, rounded to `$precision`; an
   * EMPTY collection answers NULL (not 0).
   */
  percentage(callback, precision = 2) {
    if (this.isEmpty()) return null;
    return phpRound((this.filter(callback).count() / this.count()) * 100, precision);
  }

  /**
   * `partition($key, $operator = null, $value = null)` (:546-555): two
   * collections, the accepted and the rejected ones, KEYS PRESERVED in both
   * (`Arr::partition()` writes `$passed[$key] = $item`). One argument is a
   * callback/key retriever, more are a `where()` filter.
   */
  partition(key, operator = null, value = null) {
    const retriever =
      arguments.length === 1 && typeof key !== 'function'
        ? (item, k) => valueOf(key, item, k)
        : typeof key === 'function' && arguments.length === 1
          ? key
          : whereFilter(key, operator, value, arguments.length);
    const passed = [];
    const passedKeys = [];
    const failed = [];
    const failedKeys = [];
    this.items.forEach((item, index) => {
      const k = keyAt(this, index);
      if (phpTruthy(retriever(item, k))) {
        passed.push(item);
        passedKeys.push(k);
      } else {
        failed.push(item);
        failedKeys.push(k);
      }
    });
    return new Collection([new Collection(passed, passedKeys), new Collection(failed, failedKeys)]);
  }

  /**
   * `multiply(int $multiplier)` (Collection::multiply(), :917-926): the items
   * repeated `$multiplier` times through `push(...)`, so the answer is a LIST
   * even when the receiver was keyed (a probe: `['a'=>1]->multiply(2)->all()`
   * is `[1,1]`).
   */
  multiply(multiplier) {
    const out = [];
    for (let i = 0; i < Number(multiplier); i += 1) out.push(...this.items);
    return new Collection(out);
  }

  // ---- spread callbacks & keyed maps ------------------------------------
  /**
   * `eachSpread(callable $callback)` (:291-298): each item (an array) spreads
   * into the callback with the item's KEY appended. Answers the receiver
   * (`each()`).
   */
  eachSpread(callback) {
    return this.each((item, key) => callback(...toList(item), key));
  }

  /**
   * `mapSpread(callable $callback)` (:430-437): `map()` whose callback receives
   * the item's elements spread, with the item's KEY appended.
   */
  mapSpread(callback) {
    return this.map((item, key) => callback(...toList(item), key));
  }

  /**
   * `mapInto($class)` (:479-486): each item becomes `new $class($item, $key)`
   * (a backed enum takes `$class::from($item)`).
   */
  mapInto(className) {
    return this.map((item, key) => {
      if (typeof className === 'function' && className.__lwBackedEnum === true && typeof className.from === 'function') {
        return className.from(item);
      }
      return constructClass(className, [item, key]);
    });
  }

  /**
   * `value($key, $default = null)` (EnumeratesValues.php:368-374): the KEY's
   * value from the FIRST item that HAS the key (`data_has`), read with
   * `data_get` - a MISSING key answers `$default` (a closure default is
   * called), while an item that exists with a NULL value answers NULL (a
   * probe: `collect([['a' => null]])->value('a', 'D')` is NULL).
   */
  value(key, def = null) {
    const fallback = () => (typeof def === 'function' ? def() : def);
    const hit = this.items.find((item) => dataHasProp(item, key));
    if (hit === undefined || hit === null) return fallback();
    const read = readProp(hit, key);
    return read === undefined ? fallback() : read;
  }

  /**
   * `ensure($type)` (EnumeratesValues.php:387-404): every item must be of the
   * type (a class name, or `'int'`/`'string'`/... as `get_debug_type()`
   * answers), otherwise an `UnexpectedValueException` names the first offender
   * and its POSITION (the PHP key). Answers the receiver (`each()`).
   */
  ensure(type) {
    const allowed = Array.isArray(type) ? type : [type];
    this.items.forEach((item, index) => {
      const observed = phpDebugType(item);
      const ok = allowed.some((candidate) => {
        if (typeof candidate === 'function') return item instanceof candidate;
        const name = String(candidate);
        if (name === observed) return true;
        // A compiled class is named by its FQCN string: a model answers
        // `__lwClass`, the kernel classes their constructor name.
        return item !== null && typeof item === 'object' &&
          (item.__lwClass === name || (item.constructor && item.constructor.name === name));
      });
      if (!ok) {
        const err = new Error(
          'Collection should only include [' + allowed.map(String).join(', ') + "] items, but '" +
            observed + "' found at position " + keyAt(this, index) + '.'
        );
        err.name = 'UnexpectedValueException';
        err.phpClass = 'UnexpectedValueException';
        throw err;
      }
    });
    return this;
  }

  /** `collect()` (EnumeratesValues.php:999-1002): `new static($this)` - a copy. */
  collect() {
    return this.toBase();
  }

  /** `toBase()` (Collection.php:1971-1974): a base `Collection` of the items. */
  toBase() {
    return new Collection(this.items.slice(), currentKeys(this));
  }

  /** `pipeInto($class)` (EnumeratesValues.php:816-819): `new $class($this)`. */
  pipeInto(className) {
    return constructClass(className, [this]);
  }

  /**
   * `pipeThrough($callbacks)` (:827-833): each callable takes the running value
   * (`reduce()`), the receiver first; a callable that needs `await` is out of
   * scope for the compiled edge.
   */
  pipeThrough(callbacks) {
    return toList(callbacks).reduce((carry, callback) => callback(carry), this);
  }

  /**
   * `escapeWhenCastingToString($escape = true)` (:1082-1087): the flag
   * `__toString()` honours (Laravel's default is FALSE, a probe:
   * `(string) collect(['<b>'])` answers `["<b>"]`, not the escaped form).
   */
  escapeWhenCastingToString(escape = true) {
    Object.defineProperty(this, '__lwEscape', {
      value: !!escape,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    return this;
  }

  /**
   * `__toString()` (:1074-1079): `e($this->toJson())` when the flag is set,
   * otherwise `toJson()`. This is what `(string)$collection` and a string
   * concatenation answer in PHP (`'x' . collect([1, 2])` is `x[1,2]`).
   */
  toString() {
    const json = this.toJson();
    return this.__lwEscape === true ? escapeHtml(json) : json;
  }

  /**
   * `mapToDictionary(callable $callback)` (Collection::mapToDictionary(),
   * :848-867): the callback answers ONE `[key => value]` pair, and the values
   * gather under that key in a LIST - the first key/value of the answer is
   * used (`key()`/`reset()`), extra pairs are dropped.
   */
  mapToDictionary(callback) {
    const values = [];
    const keys = [];
    const positions = new Map();
    this.items.forEach((item, index) => {
      const pair = entriesOf(callback(item, keyAt(this, index)));
      if (pair === null || pair.length === 0) return;
      const k = arrayKey(pair[0].key);
      if (typeof k !== 'number' && typeof k !== 'string') {
        throw new TypeError('Collection.mapToDictionary(): illegal offset type — array keys are integers or strings');
      }
      if (positions.has(k)) {
        values[positions.get(k)].push(pair[0].value);
      } else {
        positions.set(k, values.length);
        values.push([pair[0].value]);
        keys.push(k);
      }
    });
    return new Collection(values, keys);
  }

  /**
   * `mapToGroups(callable $callback)` (:450-455): `mapToDictionary()` then each
   * group becomes a Collection (`map($this->make(...))`), so the answer is a
   * KEYED collection of Collections.
   */
  mapToGroups(callback) {
    return this.mapToDictionary(callback).map((group) => new Collection(group));
  }

  /** `flatMap(callable $callback)` (:466-469): `map($callback)->collapse()`. */
  flatMap(callback) {
    return this.map(callback).collapse();
  }

  // ---- statics ----------------------------------------------------------
  /** `Collection::make($items = [], ...$args)` (:121-124). */
  static make(items = []) {
    return new Collection(items);
  }

  /**
   * `Collection::times($number, ?callable $callback = null)`
   * (EnumeratesValues::times(), :174-183): a list 1..$number, mapped when a
   * callback is given; `$number < 1` answers an EMPTY collection.
   */
  static times(number, callback = null) {
    if (Number(number) < 1) return new Collection([]);
    const numbers = [];
    for (let i = 1; i <= Number(number); i += 1) numbers.push(i);
    const collection = new Collection(numbers);
    return callback === null || callback === undefined ? collection : collection.map(callback);
  }

  /** `Collection::range($from, $to, $step = 1)` (Collection::range(), :67-70). */
  static range(from, to, step = 1) {
    const start = Number(from);
    const end = Number(to);
    const stride = Number(step) === 0 ? 1 : Math.abs(Number(step));
    const out = [];
    if (start <= end) {
      for (let i = start; i <= end; i += stride) out.push(i);
    } else {
      for (let i = start; i >= end; i -= stride) out.push(i);
    }
    return new Collection(out);
  }

  /** `Collection::unwrap($value)` (:150-153): an Enumerable -> `all()`. */
  static unwrap(value) {
    return value instanceof Collection ? value.all() : value;
  }

  /** `Collection::fromJson($json, $depth = 512, $flags = 0)` (:193-196). */
  static fromJson(json) {
    return new Collection(JSON.parse(json));
  }

  /**
   * `toPrettyJson(int $options = 0)` (:1048-1051): `toJson(JSON_PRETTY_PRINT |
   * $options)` - PHP's pretty printer, i.e. FOUR-space indentation and
   * `"key": value` (not JSON.stringify's two spaces).
   */
  toPrettyJson() {
    return phpJsonPretty(this.all());
  }

  // ---- slicing, mutation, windowing -------------------------------------
  /**
   * `shift($count = 1)` (Collection::shift(), :1281-1308): one item (the value,
   * not a collection) or, for `$count > 1`, a collection of them. PHP's
   * `array_shift()` RENUMBERS the integer keys left behind (a probe:
   * `collect([5 => 'a', 'k' => 'b'])->shift()` leaves `{'k' => 'b'}`), so the
   * keyed tail is rebuilt here.
   */
  shift(count = 1) {
    const n = Number(count);
    if (n < 0) {
      const err = new Error('Number of shifted items may not be less than zero.');
      err.name = 'InvalidArgumentException';
      err.phpClass = 'InvalidArgumentException';
      throw err;
    }
    if (n === 0) return new Collection([]);
    if (n === 1) {
      if (!this.items.length) return null;
      const value = this.items.shift();
      // PHP's `array_shift()` renumbers the receiver's remaining integer keys.
      if (this.phpKeys) {
        this.phpKeys.shift();
        reindexIntKeys(this);
      }
      return value;
    }
    if (this.isEmpty()) return new Collection([]);
    const taken = [];
    const take = Math.min(n, this.items.length);
    for (let i = 0; i < take; i += 1) {
      taken.push(this.items.shift());
      if (this.phpKeys) this.phpKeys.shift();
    }
    if (this.phpKeys) reindexIntKeys(this);
    return new Collection(taken);
  }

  /**
   * `unshift(...$values)` (Collection::unshift(), :1096-1101): `array_unshift()`
   * PREPENDS and renumbers the integer keys (a probe: `[3 => 'c']->unshift('a')`
   * answers `{0:'a', 1:'c'}`, while a string key keeps its name).
   */
  unshift(...values) {
    if (values.length === 0) return this;
    const entries = this.items.map((value, index) => ({ key: keyAt(this, index), value }));
    const merged = [...values.map((value) => ({ key: null, value })), ...entries];
    let next = 0;
    for (const entry of merged) {
      if (entry.key === null || typeof entry.key === 'number' || (typeof entry.key === 'string' && /^-?\d+$/.test(entry.key))) {
        entry.key = next;
      }
      if (typeof entry.key === 'number' && entry.key >= next) next = entry.key + 1;
    }
    this.items = merged.map((entry) => entry.value);
    this.phpKeys = merged.map((entry) => entry.key);
    return this;
  }

  /**
   * `splice($offset, $length = null, $replacement = [])`
   * (Collection::splice(), :1768-1775): `array_splice()` - the removed items
   * are answered as a collection and the receiver keeps the rest; BOTH lose
   * their integer keys (PHP renumbers them), while string keys survive.
   */
  splice(offset, length = null, replacement = []) {
    const oneArg = arguments.length === 1;
    const start = phpSlice([...Array(this.items.length).keys()], offset, oneArg ? undefined : length);
    const removeAt = new Set(start);
    const removed = [];
    const kept = [];
    this.items.forEach((value, index) => {
      const key = keyAt(this, index);
      if (removeAt.has(index)) removed.push({ key, value });
      else kept.push({ key, value });
    });
    const inserted = oneArg ? [] : toList(replacement).map((value) => ({ key: null, value }));
    // The insertion point: the position in `kept` where the removed run began.
    const at = start.length === 0 ? kept.length : (start[0] === 0 ? 0 : start[0] - [...removeAt].filter((i) => i < start[0]).length);
    const merged = [...kept.slice(0, at), ...inserted, ...kept.slice(at)];
    let next = 0;
    for (const entry of merged) {
      if (entry.key === null || isIntKey(entry.key)) entry.key = next;
      if (typeof entry.key === 'number' && entry.key >= next) next = entry.key + 1;
    }
    this.items = merged.map((entry) => entry.value);
    this.phpKeys = merged.map((entry) => entry.key);
    // PHP renumbers the integer keys of the REMOVED run too (a probe:
    // `[5 => 'a']` spliced out answers `[0 => 'a']`, i.e. a list), while a
    // string key keeps its name.
    let removedNext = 0;
    const removedCollection = new Collection(
      removed.map((entry) => entry.value),
      removed.map((entry) => (isIntKey(entry.key) ? removedNext++ : entry.key))
    );
    return removedCollection;
  }

  /**
   * `union($items)` (Collection::union(), :947-950): the PHP `+` operator - the
   * RECEIVER's keys win, and the extra entries append after them.
   */
  union(items) {
    const other = entriesOf(items);
    if (other === null) return new Collection(this.items.slice(), currentKeys(this));
    const values = this.items.slice();
    const keys = currentKeys(this);
    const seen = new Set(keys.map((key) => String(arrayKey(key))));
    for (const entry of other) {
      const k = arrayKey(entry.key);
      if (seen.has(String(k))) continue;
      seen.add(String(k));
      values.push(entry.value);
      keys.push(k);
    }
    return new Collection(values, keys);
  }

  /** `replace($items)` (Collection::replace(), :1183-1186): `array_replace()`. */
  replace(items) {
    const other = entriesOf(items);
    if (other === null) return new Collection(this.items.slice(), currentKeys(this));
    const values = this.items.slice();
    const keys = currentKeys(this).map(arrayKey);
    for (const entry of other) {
      const k = arrayKey(entry.key);
      const at = keys.findIndex((key) => String(key) === String(k));
      if (at === -1) {
        keys.push(k);
        values.push(entry.value);
      } else {
        values[at] = entry.value;
      }
    }
    return new Collection(values, keys);
  }

  /**
   * `replaceRecursive($items)` (Collection::replaceRecursive(), :1194-1197):
   * `array_replace_recursive()` - nested arrays merge key by key, the second
   * array's scalar wins (a probe: `['a' => ['b' => 1, 'c' => 2]]` replaced with
   * `['a' => ['b' => 9]]` answers `['a' => ['b' => 9, 'c' => 2]]`).
   */
  replaceRecursive(items) {
    const other = entriesOf(items);
    if (other === null) return new Collection(this.items.slice(), currentKeys(this));
    const left = this.phpArray();
    const right = items instanceof Collection ? items.phpArray() : items;
    return new Collection(phpArrayReplaceRecursive(left, right));
  }

  /**
   * `mergeRecursive($items)` (Collection::mergeRecursive(), :906-909):
   * `array_merge_recursive()` - duplicate string keys become an ARRAY of the
   * values, duplicate integer keys append (a probe: `['a' => 1]` merged with
   * `['a' => 2]` answers `['a' => [1, 2]]`).
   */
  mergeRecursive(items) {
    const left = this.phpArray();
    const right = items instanceof Collection ? items.phpArray() : items;
    if (right === null || right === undefined || typeof right !== 'object' && !Array.isArray(right)) {
      return new Collection(this.items.slice(), currentKeys(this));
    }
    return new Collection(phpArrayMergeRecursive(left, right));
  }

  /**
   * `random($number = null, $preserveKeys = false)` (Collection::random(),
   * :1164-1175; `Arr::random()`): one random item, or a collection of
   * `$number` random items. Asking for MORE than there are is an
   * `InvalidArgumentException`; an empty collection answers NULL (no number)
   * or an empty collection.
   */
  random(number = null, preserveKeys = false) {
    const count = this.count();
    const requested = number === null || number === undefined ? 1 : typeof number === 'function' ? number(this) : Number(number);
    if (requested > count) {
      const err = new Error('You requested ' + requested + ' items, but there are only ' + count + ' items available.');
      err.name = 'InvalidArgumentException';
      err.phpClass = 'InvalidArgumentException';
      throw err;
    }
    if (count === 0 || (number !== null && number !== undefined && requested <= 0)) {
      return number === null || number === undefined ? null : new Collection([]);
    }
    const positions = [...Array(count).keys()];
    for (let i = positions.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    const picked = positions.slice(0, requested);
    if (number === null || number === undefined) return this.items[picked[0]];
    if (preserveKeys) {
      return new Collection(picked.map((i) => this.items[i]), picked.map((i) => keyAt(this, i)));
    }
    return new Collection(picked.map((i) => this.items[i]));
  }

  /** `shuffle()` (Collection::shuffle(), :1315-1318): `Arr::shuffle()` - a random ORDER, renumbered keys. */
  shuffle() {
    const positions = [...Array(this.count()).keys()];
    for (let i = positions.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    return new Collection(positions.map((i) => this.items[i]));
  }

  /**
   * `select($keys)` (Collection::select(), :1009-1022; `Arr::select()`): each
   * item becomes a small array holding only `$keys` that EXIST in it, in the
   * order of `$keys` - the receiver's keys travel (a probe:
   * `collect([['a'=>1,'b'=>2],['a'=>3]])->select('b')` answers
   * `[{'b':2},{}]`). A NULL `$keys` answers the collection as it is.
   */
  select(keys) {
    if (keys === null || keys === undefined) return new Collection(this.items.slice(), currentKeys(this));
    const wanted = keys instanceof Collection ? keys.all() : Array.isArray(keys) ? keys : [...arguments];
    const wantedList = Array.isArray(wanted) ? wanted : Object.values(wanted);
    return this.map((item) => {
      const out = {};
      let any = false;
      for (const key of wantedList) {
        // `Arr::accessible($item) && Arr::exists($item, $key)` - the key must
        // EXIST (a null value counts), and the read is the literal `$item[$key]`
        // (no dotted data_get).
        if (!selectHasKey(item, key)) continue;
        out[String(key)] = selectReadKey(item, key);
        any = true;
      }
      // `Arr::select()` builds a PHP array - an item without any of the keys
      // answers an EMPTY array, which json_encode writes as `[]`, not `{}`.
      return any ? out : [];
    });
  }

  /** `add($item)` (Collection::add(), :1959-1964): appends and answers the receiver. */
  add(item) {
    if (this.phpKeys) {
      this.phpKeys.push(nextIntKey(this.phpKeys));
    } else {
      this.phpKeys = this.items.map((_, index) => index);
      this.phpKeys.push(this.items.length);
    }
    this.items.push(item);
    return this;
  }

  /**
   * `before($value, $strict = false)` (Collection::before(), :1232-1247): the
   * item BEFORE the first match, or NULL when there is none / the match is
   * first.
   */
  before(value, strict = false) {
    const at = this.search(value, strict);
    if (at === false) return null;
    const position = currentKeys(this).findIndex((key) => normKey(key) === normKey(at));
    if (position <= 0) return null;
    return this.items[position - 1];
  }

  /** `after($value, $strict = false)` (Collection::after(), :1256-1271): the item AFTER the first match. */
  after(value, strict = false) {
    const at = this.search(value, strict);
    if (at === false) return null;
    const position = currentKeys(this).findIndex((key) => normKey(key) === normKey(at));
    if (position === -1 || position === this.items.length - 1) return null;
    return this.items[position + 1];
  }

  /** `forPage($page, $perPage)` (:531-536): `slice(max(0, ($page - 1) * $perPage), $perPage)` with keys preserved. */
  forPage(page, perPage) {
    const offset = Math.max(0, (Number(page) - 1) * Number(perPage));
    return this.slice(offset, Number(perPage));
  }

  /**
   * `skipWhile($value)` (Collection::skipWhile(), :1370-1373 via
   * LazyCollection): drop the LEADING items while the callback (or the
   * `$item == $value` test) holds, then take the rest - keys preserved.
   */
  skipWhile(value) {
    const test = typeof value === 'function' ? value : (item) => phpLooseEquals(item, value);
    let at = 0;
    while (at < this.items.length && test(this.items[at], keyAt(this, at))) at += 1;
    return new Collection(this.items.slice(at), currentKeys(this).slice(at));
  }

  /** `skipUntil($value)` (:1359-1362): `skipWhile()` with the test negated. */
  skipUntil(value) {
    const test = typeof value === 'function' ? value : (item) => phpLooseEquals(item, value);
    return this.skipWhile((item, key) => !test(item, key));
  }

  /** `takeWhile($value)` (:1809-1812): the LEADING items while the test holds, keys preserved. */
  takeWhile(value) {
    const test = typeof value === 'function' ? value : (item) => phpLooseEquals(item, value);
    let at = 0;
    while (at < this.items.length && test(this.items[at], keyAt(this, at))) at += 1;
    return new Collection(this.items.slice(0, at), currentKeys(this).slice(0, at));
  }

  /** `takeUntil($value)` (:1798-1801): `takeWhile()` with the test negated. */
  takeUntil(value) {
    const test = typeof value === 'function' ? value : (item) => phpLooseEquals(item, value);
    return this.takeWhile((item, key) => !test(item, key));
  }

  /**
   * `chunkBy($key)` (:939-946): runs of ADJACENT items whose `$key` compares
   * LOOSELY equal (`==`) - a chunk ends as soon as the retrieved key changes.
   */
  chunkBy(key) {
    const retriever = (item, k) => valueOf(key, item, k);
    return this.chunkWhile((item, k, chunk) => {
      const last = chunk.last();
      if (last === null || last === undefined) return true;
      const lastKey = chunk.count() === 0 ? null : currentKeys(chunk)[chunk.count() - 1];
      return phpLooseEquals(retriever(item, k), retriever(last, lastKey));
    });
  }

  /**
   * `chunkWhile(callable $callback)` (Collection::chunkWhile(), :1554-1559 via
   * LazyCollection): groups adjacent items while `$callback($value, $key,
   * $chunk)` holds, where `$chunk` is the group being built; the answer is a
   * collection of collections (each group renumbered - PHP builds them with
   * `$chunk[] = $value`).
   */
  chunkWhile(callback) {
    const chunks = [];
    let current = null;
    this.items.forEach((item, index) => {
      const key = keyAt(this, index);
      if (current === null || !callback(item, key, current)) {
        current = new Collection([], []);
        chunks.push(current);
      }
      // The chunk keeps the ORIGINAL keys (a probe: `[1, 1, 2, 2, 3]` chunked
      // by value answers `[[1,1], {"2":2,"3":2}, {"4":3}]` - the LazyCollection
      // builds each chunk with `$chunk[$key] = $value`).
      current.items.push(item);
      current.phpKeys.push(key);
    });
    return new Collection(chunks);
  }

  /**
   * `collapseWithKeys()` (Collection::collapseWithKeys(), :163-186): flattens
   * one level keeping the keys, LATER entries overwriting earlier ones
   * (`array_replace(...$results)`); non-array items are skipped.
   */
  collapseWithKeys() {
    const merged = {};
    const keys = [];
    let anyValues = false;
    for (const item of this.items) {
      const entries = entriesOf(item);
      if (entries === null) continue;
      anyValues = true;
      for (const entry of entries) {
        const k = arrayKey(entry.key);
        const asString = String(k);
        const at = keys.findIndex((key) => String(key) === asString);
        if (at === -1) {
          keys.push(k);
          merged[asString] = entry.value;
        } else {
          merged[asString] = entry.value;
        }
      }
    }
    if (!anyValues) return new Collection([]);
    // `array_replace()` writes INT keys in place and appends new STRING keys -
    // the resulting PHP array is a list when its keys are exactly 0..n-1.
    const listKeys = keys.every((key, index) => normKey(key) === index);
    if (listKeys) {
      return new Collection(keys.map((key) => merged[String(key)]));
    }
    return new Collection(keys.map((key) => merged[String(key)]), keys);
  }

  /**
   * `sliding($size = 2, $step = 1)` (Collection::sliding(), :1329-1340):
   * overlapping windows of `$size` items every `$step`; `$size`/`$step` below 1
   * throw an `InvalidArgumentException`.
   */
  sliding(size = 2, step = 1) {
    const windowSize = Number(size);
    const stride = Number(step);
    if (windowSize < 1) {
      const err = new Error('Size value must be at least 1.');
      err.name = 'InvalidArgumentException';
      err.phpClass = 'InvalidArgumentException';
      throw err;
    }
    if (stride < 1) {
      const err = new Error('Step value must be at least 1.');
      err.name = 'InvalidArgumentException';
      err.phpClass = 'InvalidArgumentException';
      throw err;
    }
    const chunks = Math.floor((this.count() - windowSize) / stride) + 1;
    if (chunks < 1) return new Collection([]);
    const windows = [];
    for (let i = 1; i <= chunks; i += 1) windows.push(this.slice((i - 1) * stride, windowSize));
    return new Collection(windows);
  }

  /**
   * `sortKeys($options = SORT_REGULAR, $descending = false)`
   * (Collection::sortKeys(), :1722-1732): `ksort()`/`krsort()` - the KEYS are
   * sorted, values travel with them.
   */
  sortKeys(options = null, descending = false) {
    const compare = (a, b) => phpSortCompare(arrayKey(a), arrayKey(b));
    const entries = this.items.map((value, index) => ({ key: keyAt(this, index), value, index }));
    entries.sort((a, b) => {
      const cmp = compare(a.key, b.key);
      return cmp === 0 ? a.index - b.index : descending ? -cmp : cmp;
    });
    return new Collection(entries.map((entry) => entry.value), entries.map((entry) => entry.key));
  }

  /** `sortKeysDesc($options = SORT_REGULAR)` (:1740-1743). */
  sortKeysDesc(options = null) {
    return this.sortKeys(options, true);
  }

  /** `sortKeysUsing(callable $callback)` (:1751-1758): `uksort()` - the callback compares KEYS. */
  sortKeysUsing(callback) {
    const entries = this.items.map((value, index) => ({ key: keyAt(this, index), value, index }));
    entries.sort((a, b) => {
      const cmp = Number(callback(a.key, b.key)) || 0;
      return cmp === 0 ? a.index - b.index : cmp;
    });
    return new Collection(entries.map((entry) => entry.value), entries.map((entry) => entry.key));
  }

  // ---- diff / intersect (keys preserved) --------------------------------
  /**
   * `diffKeys($items)` (Collection::diffKeys(), :323-326): `array_diff_key()` -
   * the entries whose KEY is absent from `$items` (a probe: `[1, 2, 3]`
   * minus keys `[1]` answers `{0:1, 2:3}`).
   */
  diffKeys(items) {
    const other = new Set((entriesOf(items) || []).map((entry) => String(arrayKey(entry.key))));
    const values = [];
    const keys = [];
    this.items.forEach((value, index) => {
      const key = keyAt(this, index);
      if (!other.has(String(arrayKey(key)))) {
        values.push(value);
        keys.push(key);
      }
    });
    return new Collection(values, keys);
  }

  /**
   * `diffAssoc($items)` (Collection::diffAssoc(), :300-303):
   * `array_diff_assoc()` - the entries whose key AND value are absent
   * (the value compared through PHP's string cast, like `diff()`).
   */
  diffAssoc(items) {
    const other = (entriesOf(items) || []).map((entry) => ({
      key: String(arrayKey(entry.key)),
      value: phpStr(entry.value),
    }));
    const values = [];
    const keys = [];
    this.items.forEach((value, index) => {
      const key = keyAt(this, index);
      const match = other.some((entry) => entry.key === String(arrayKey(key)) && entry.value === phpStr(value));
      if (!match) {
        values.push(value);
        keys.push(key);
      }
    });
    return new Collection(values, keys);
  }

  /** `diffAssocUsing($items, $callback)` (:312-315): `array_diff_uassoc()` - the callback compares KEYS. */
  diffAssocUsing(items, callback) {
    const other = (entriesOf(items) || []).map((entry) => ({
      key: arrayKey(entry.key),
      value: phpStr(entry.value),
    }));
    const values = [];
    const keys = [];
    this.items.forEach((value, index) => {
      const key = keyAt(this, index);
      const match = other.some(
        (entry) =>
          Number(callback(arrayKey(key), entry.key)) === 0 && phpStr(value) === entry.value
      );
      if (!match) {
        values.push(value);
        keys.push(key);
      }
    });
    return new Collection(values, keys);
  }

  /** `diffKeysUsing($items, $callback)` (:335-338): `array_diff_ukey()` - the callback compares KEYS. */
  diffKeysUsing(items, callback) {
    const other = (entriesOf(items) || []).map((entry) => arrayKey(entry.key));
    const values = [];
    const keys = [];
    this.items.forEach((value, index) => {
      const key = keyAt(this, index);
      const match = other.some((entry) => Number(callback(arrayKey(key), entry)) === 0);
      if (!match) {
        values.push(value);
        keys.push(key);
      }
    });
    return new Collection(values, keys);
  }

  /** `diffUsing($items, $callback)` (:289-292): `array_udiff()` - the callback compares VALUES. */
  diffUsing(items, callback) {
    const other = toList(items).map((value) => value);
    const values = [];
    const keys = [];
    this.items.forEach((value, index) => {
      const key = keyAt(this, index);
      const match = other.some((entry) => Number(callback(value, entry)) === 0);
      if (!match) {
        values.push(value);
        keys.push(key);
      }
    });
    return new Collection(values, keys);
  }

  /** `intersectByKeys($items)` (Collection::intersectByKeys(), :709-714): `array_intersect_key()`. */
  intersectByKeys(items) {
    const other = new Set((entriesOf(items) || []).map((entry) => String(arrayKey(entry.key))));
    const values = [];
    const keys = [];
    this.items.forEach((value, index) => {
      const key = keyAt(this, index);
      if (other.has(String(arrayKey(key)))) {
        values.push(value);
        keys.push(key);
      }
    });
    return new Collection(values, keys);
  }

  /** `intersectAssoc($items)` (Collection::intersectAssoc(), :686-689): `array_intersect_assoc()` (key and value). */
  intersectAssoc(items) {
    const other = (entriesOf(items) || []).map((entry) => ({
      key: String(arrayKey(entry.key)),
      value: phpStr(entry.value),
    }));
    const values = [];
    const keys = [];
    this.items.forEach((value, index) => {
      const key = keyAt(this, index);
      const match = other.some((entry) => entry.key === String(arrayKey(key)) && entry.value === phpStr(value));
      if (match) {
        values.push(value);
        keys.push(key);
      }
    });
    return new Collection(values, keys);
  }

  /** `intersectAssocUsing($items, $callback)` (:698-701): `array_intersect_uassoc()` - the callback compares KEYS. */
  intersectAssocUsing(items, callback) {
    const other = (entriesOf(items) || []).map((entry) => ({
      key: arrayKey(entry.key),
      value: phpStr(entry.value),
    }));
    const values = [];
    const keys = [];
    this.items.forEach((value, index) => {
      const key = keyAt(this, index);
      const match = other.some(
        (entry) =>
          Number(callback(arrayKey(key), entry.key)) === 0 && phpStr(value) === entry.value
      );
      if (match) {
        values.push(value);
        keys.push(key);
      }
    });
    return new Collection(values, keys);
  }

  /** `intersectUsing($items, $callback)` (:675-678): `array_uintersect()` - the callback compares VALUES. */
  intersectUsing(items, callback) {
    const other = toList(items);
    const values = [];
    const keys = [];
    this.items.forEach((value, index) => {
      const key = keyAt(this, index);
      const match = other.some((entry) => Number(callback(value, entry)) === 0);
      if (match) {
        values.push(value);
        keys.push(key);
      }
    });
    return new Collection(values, keys);
  }

  // ---- strict membership & shape filters --------------------------------
  /**
   * `containsStrict($key, $value = null)` (Collection::containsStrict(),
   * :216-227): two arguments are a `data_get($item, $key) === $value` test,
   * one callable is a predicate, and anything else is `in_array($key,
   * $items, true)` - a STRICT comparison (a probe: `[1]->containsStrict('1')`
   * is false while `contains('1')` is true).
   */
  containsStrict(key, value = null) {
    if (arguments.length === 2) {
      return this.items.some((item) => valueForKey(item, key) === value);
    }
    if (typeof key === 'function') {
      return this.items.some((item, index) => phpTruthy(key(item, keyAt(this, index))));
    }
    return this.items.some((item) => item === key);
  }

  /** `doesntContain(...)` (Collection::doesntContain(), :237-240): `contains()` negated. */
  doesntContain(key, operator = null, value = null) {
    return !this.contains(...arguments);
  }

  /** `doesntContainStrict(...)` (Collection::doesntContainStrict(), :250-253). */
  doesntContainStrict(key, value = null) {
    return !this.containsStrict(...arguments);
  }

  /** `duplicatesStrict($callback = null)` (Collection::duplicatesStrict(), :378-381). */
  duplicatesStrict(callback = null) {
    return this.duplicates(callback, true);
  }

  /**
   * `hasSole($key = null, $operator = null, $value = null)`
   * (Collection::hasSole(), :1487-1497): exactly ONE item passes the filter
   * (all of them when no filter is given).
   */
  hasSole(key = null, operator = null, value = null) {
    const filter = soleFilterFor(key, operator, value, arguments.length);
    return filter === null ? this.count() === 1 : this.filter(filter).count() === 1;
  }

  /** `containsOneItem($callback = null)` (Collection::containsOneItem(), :740-743). */
  containsOneItem(callback = null) {
    return callback === null || callback === undefined ? this.count() === 1 : this.hasSole(callback);
  }

  /** `hasMany($key = null, $operator = null, $value = null)` (:346-357): at least TWO items pass. */
  hasMany(key = null, operator = null, value = null) {
    const filter = soleFilterFor(key, operator, value, arguments.length);
    return filter === null ? this.take(2).count() === 2 : this.filter(filter).take(2).count() === 2;
  }

  /** `containsManyItems($callback = null)` (Collection::containsManyItems(), :753-756). */
  containsManyItems(callback = null) {
    return callback === null || callback === undefined ? this.take(2).count() === 2 : this.hasMany(callback);
  }

  /** `whereBetween($key, $values)` (:730-733): `>= first` AND `<= last`. */
  whereBetween(key, values) {
    const list = toList(values);
    return this.where(key, '>=', list[0]).where(key, '<=', list[list.length - 1]);
  }

  /**
   * `whereNotBetween($key, $values)` (:742-747): the items OUTSIDE the range -
   * `filter()` with a raw `<`/`>` comparison (keys preserved).
   */
  whereNotBetween(key, values) {
    const list = toList(values);
    const low = list[0];
    const high = list[list.length - 1];
    return this.filter((item) => {
      const actual = valueForKey(item, key);
      return phpCompare(actual, low) < 0 || phpCompare(actual, high) > 0;
    });
  }

  /**
   * `whereInstanceOf($type)` (:784-793): the items that are instances of
   * `$type` (a list of types passes when any matches).
   */
  whereInstanceOf(type) {
    const types = Array.isArray(type) ? type : [type];
    return this.filter((value) =>
      types.some((classType) => {
        if (typeof classType === 'function') return value instanceof classType;
        if (typeof classType === 'string' && value !== null && typeof value === 'object') {
          // A compiled class instance carries its FQCN in the non-enumerable
          // `__lwClass` (rt-from-context.mjs:743) — `Post::class` compiles to
          // that FQCN string, so the string rung must read it, not `phpClass`
          // (which only the built-in exception shims set).
          return (
            value.constructor?.name === classType ||
            value.__lwClass === classType ||
            value.phpClass === classType
          );
        }
        return false;
      })
    );
  }

  /** `unlessEmpty($callback)` (`whenNotEmpty()`): the callback runs when the collection is NOT empty. */
  unlessEmpty(callback, fallback = null) {
    return this.whenNotEmpty(callback, fallback);
  }

  /** `unlessNotEmpty($callback)` (`whenEmpty()`): the callback runs when the collection IS empty. */
  unlessNotEmpty(callback, fallback = null) {
    return this.whenEmpty(callback, fallback);
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
