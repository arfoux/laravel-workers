// kernel/arr.mjs — the Illuminate\Support\Arr surface the compiled rung needs.
//
// Why this exists: Blade itself compiles @include/@extends/@includeWhen/… into
// `Arr::except(get_defined_vars(), ['__data', '__path'])` on Laravel 11.0–11.42
// (v11.43.0 switched to array_diff_key), so without this helper NO view of an
// app on those versions can even transpile — the compiler answers LW003 and
// the build fails before anything else.

// The surface the compiler allows (Arr::x() -> rt.Arr.x()).
export const ARR_METHODS = new Set(['except']);

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
};

export default { arr, ARR_METHODS };
