// tools/deep-merge.mjs — `array_replace_recursive` in JS, on its own so the
// merge can be unit-tested without running the config dump.
//
// `tools/config-dump.mjs` merges the framework's translation group with the
// app's, and the PHP oracle merges with `array_replace_recursive`. Putting the
// merge in a side-effect-free module keeps `config-dump.mjs` a script (it reads
// the app and writes the dump on import) while a test can import just this.

/** Deep merge in the spirit of array_replace_recursive (later wins, both ears). */
export function deepMerge(a, b) {
  // PHP's array_replace_recursive replaces per KEY, and a list-array's keys are
  // its indices: `['x','y','z']` merged with `['y2']` answers `['y2','y','z']`,
  // not `['y2']` (the overridden group loses nothing). Merging two keyed
  // collections key-by-key reproduces that at every depth - including the case
  // where the same index holds an array on both sides, which is why the check
  // here must accept arrays, not only plain objects.
  if (isMergeable(a) && isMergeable(b)) {
    const out = Array.isArray(a) ? a.slice() : { ...a };
    const entries = Array.isArray(b) ? b.map((v, i) => [i, v]) : Object.entries(b);
    for (const [k, v] of entries) {
      out[k] = isMergeable(out[k]) && isMergeable(v) ? deepMerge(out[k], v) : v;
    }
    return out;
  }
  return b;
}

/** A keyed collection (a PHP array in either shape), as opposed to a scalar. */
function isMergeable(v) {
  return !!v && typeof v === 'object';
}
