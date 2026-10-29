// kernel/arr.mjs — the Illuminate\Support\Arr surface the compiled rung needs.
//
// Why this exists: Blade itself compiles @include/@extends/@includeWhen/… into
// `Arr::except(get_defined_vars(), ['__data', '__path'])` on Laravel 11.0–11.42
// (v11.43.0 switched to array_diff_key), so without this helper NO view of an
// app on those versions can even transpile — the compiler answers LW003 and
// the build fails before anything else.

// The surface the compiler allows (Arr::x() -> rt.Arr.x()).
export const ARR_METHODS = new Set(['except', 'wrap', 'get', 'has', 'only', 'first', 'last', 'dot']);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Delete one key from a copy of `node`, cloning the level it touches. */
function forgetCopy(input, key) {
  if (input === null || typeof input !== 'object') return input;
  const raw = String(key);
  // Arr::forget() answers an exact key first (literal 'a.b' beats a dot path),
  // then walks the dot path — every level it descends into is cloned, because
  // PHP receives the array by value and the CALLER's nested arrays must not
  // change (`unset` keeps later keys; holes stay holes in a JS array too).
  if (hasOwn(input, raw)) {
    if (Array.isArray(input)) { const out = input.slice(); delete out[raw]; return out; }
    const out = { ...input }; delete out[raw]; return out;
  }
  const path = raw.split('.');
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object') return node;
    const k = path[depth];
    if (depth === path.length - 1) {
      if (!hasOwn(node, k)) return node;
      if (Array.isArray(node)) { const c = node.slice(); delete c[k]; return c; }
      const c = { ...node }; delete c[k]; return c;
    }
    if (!hasOwn(node, k)) return node;
    const child = walk(node[k], depth + 1);
    if (Array.isArray(node)) { const c = node.slice(); c[k] = child; return c; }
    return { ...node, [k]: child };
  };
  return walk(input, 0);
}

// An array-ish value the compiled side holds: a JS array, a plain object, a
// kernel Collection (rt.collect -> { items }) or a value with a hash surface.
// Mirrors Arr::accessible() (Arr.php:28) as far as the compiled model allows.
const isArrLike = (v) =>
  (v !== null && typeof v === 'object') || typeof v === 'function';
// The keys of a value in PHP order (a list's indices, an assoc array's insertion
// order, a Collection's items).
function keysOf(v) {
  if (Array.isArray(v)) return v.map((_, i) => i);
  if (v !== null && typeof v === 'object') {
    if (Array.isArray(v.__lwOrder)) return v.__lwOrder.slice();
    if (Array.isArray(v.items) && typeof v.all === 'function') return v.items.map((_, i) => i);
    return Object.keys(v);
  }
  return [];
}
const itemAt = (v, k) => (Array.isArray(v) || (v !== null && typeof v === 'object') ? v[k] : undefined);
/** `Arr::has($array, $keys)` — Arr.php:533 (dot notation, ALL keys required). */
function hasKey(array, keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  if (!array || list.length === 0) return false;
  for (const raw of list) {
    const key = String(raw);
    if (existsKey(array, key)) continue;
    let sub = array;
    let ok = true;
    for (const segment of key.split('.')) {
      if (isArrLike(sub) && existsKey(sub, segment)) {
        sub = sub[segment];
      } else {
        ok = false;
        break;
      }
    }
    if (!ok) return false;
  }
  return true;
}
/** Arr::exists() (Arr.php:264): a plain key check with the numeric-string cast. */
function existsKey(array, key) {
  if (Array.isArray(array)) return Number.isInteger(+key) && +key >= 0 && +key < array.length && String(+key) === String(key);
  if (array !== null && typeof array === 'object') return Object.prototype.hasOwnProperty.call(array, key);
  return false;
}
/** `Arr::get($array, $key, $default)` — Arr.php:497 (dot notation, null key = the array). */
function getKey(array, key, def = null) {
  if (!isArrLike(array)) return typeof def === 'function' ? def() : def;
  if (key === null || key === undefined) return array;
  const k = String(key);
  if (existsKey(array, k)) return array[k];
  if (!k.includes('.')) return typeof def === 'function' ? def() : def;
  let cur = array;
  for (const segment of k.split('.')) {
    if (isArrLike(cur) && existsKey(cur, segment)) cur = cur[segment];
    else return typeof def === 'function' ? def() : def;
  }
  return cur;
}

// The helpers, named to mirror kernel/str.mjs (`import { str as strHelpers }`).
export const arr = {
  /** `Arr::except($array, $keys)` — Arr.php:150: forget() on a value, return it. */
  except(array, keys) {
    let out = array && typeof array === 'object'
      ? (Array.isArray(array) ? array.slice() : { ...array })
      : {};
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) out = forgetCopy(out, k);
    return out;
  },
  /** `Arr::wrap($value)` — Arr.php:1336 (null -> [], array -> itself, else [v]). */
  wrap(value) {
    if (value === null || value === undefined) return [];
    // A plain object IS a PHP array (an assoc array) on the compiled side, so
    // only a scalar wraps: `Arr::wrap(['a'=>1])` answers the array itself.
    return Array.isArray(value) || typeof value === 'object' ? value : [value];
  },
  /** `Arr::get($array, $key, $default)` — Arr.php:497. */
  get(array, key, def = null) {
    return getKey(array, key, def);
  },
  /** `Arr::has($array, $keys)` — Arr.php:533. */
  has(array, keys) {
    return hasKey(array, keys);
  },
  /** `Arr::only($array, $keys)` — Arr.php:752 (array_intersect_key + order of $array). */
  only(array, keys) {
    const wanted = new Set((Array.isArray(keys) ? keys : [keys]).map(String));
    const out = {};
    const order = [];
    for (const k of keysOf(array)) {
      if (wanted.has(String(k))) {
        order.push(String(k));
        out[k] = itemAt(array, k);
      }
    }
    Object.defineProperty(out, '__lwOrder', { value: order, enumerable: false });
    return out;
  },
  /** `Arr::first($array, $callback, $default)` — Arr.php:293 (no callback = first value). */
  first(array, callback = null, def = null) {
    const ks = keysOf(array);
    if (callback === null || callback === undefined) {
      if (ks.length === 0) return typeof def === 'function' ? def() : def;
      return itemAt(array, ks[0]);
    }
    for (const k of ks) {
      if (callback(itemAt(array, k), k)) return itemAt(array, k);
    }
    return typeof def === 'function' ? def() : def;
  },
  /** `Arr::last($array, $callback, $default)` — Arr.php:340 (reverse, first match). */
  last(array, callback = null, def = null) {
    const ks = keysOf(array).slice().reverse();
    if (callback === null || callback === undefined) {
      if (ks.length === 0) return typeof def === 'function' ? def() : def;
      return itemAt(array, ks[0]);
    }
    for (const k of ks) {
      if (callback(itemAt(array, k), k)) return itemAt(array, k);
    }
    return typeof def === 'function' ? def() : def;
  },
  /** `Arr::dot($array, $prepend, $depth)` — Arr.php:185 (flatten with dots). */
  dot(array, prepend = '', depth = Infinity) {
    const results = {};
    const order = [];
    const flatten = (data, prefix, currentDepth) => {
      for (const k of keysOf(data)) {
        const value = itemAt(data, k);
        const newKey = prefix + k;
        if (value !== null && typeof value === 'object' && keyCount(value) > 0 && currentDepth < depth) {
          flatten(value, newKey + '.', currentDepth + 1);
        } else {
          if (!Object.prototype.hasOwnProperty.call(results, newKey)) order.push(newKey);
          results[newKey] = value;
        }
      }
    };
    flatten(array, prepend, 0);
    Object.defineProperty(results, '__lwOrder', { value: order, enumerable: false });
    return results;
  },
};
function keyCount(v) {
  return keysOf(v).length;
}

export default { arr, ARR_METHODS };
