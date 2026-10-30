// kernel/own-key.mjs — own-property access for UNTRUSTED keys.
//
// Why this exists (security): PHP arrays have no prototype chain, so a key like
// `__proto__`, `constructor` or `toString` is ordinary data to `parse_str()` /
// `$_COOKIE` (measured on PHP 8.3: `parse_str('x[__proto__][p]=2')` answers
// `{"x":{"__proto__":{"p":"2"}}}`). A JS object literal does NOT behave that way:
// `obj.__proto__ = v` runs the Object.prototype setter and mutates the PROTOTYPE
// (global state), `obj[k]` on a missing key answers an inherited function, and
// `'k' in obj` is true for `toString`. Any map the edge builds from a client
// string (query, form body, JSON body, Cookie header, session payload, dot-path
// keys) must therefore write and read own properties only — otherwise a crafted
// request pollutes `Object.prototype` for the whole isolate.
//
// `Object.defineProperty` writes an OWN property even for `__proto__` (the
// setter is on Object.prototype, and a defineProperty write does not run it), so
// the value round-trips like PHP's data key instead of vanishing into the
// prototype.
export function ownSet(target, key, value) {
  Object.defineProperty(target, String(key), {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return value;
}

export function ownGet(target, key) {
  const k = String(key);
  return Object.prototype.hasOwnProperty.call(target, k) ? target[k] : undefined;
}

export function ownHas(target, key) {
  return Object.prototype.hasOwnProperty.call(target, String(key));
}

/** `Object.assign(target, ...sources)` without the `__proto__` setter trap. */
export function assignOwn(target, ...sources) {
  for (const src of sources) {
    if (src === null || src === undefined) continue;
    for (const k of Object.keys(src)) ownSet(target, k, src[k]);
  }
  return target;
}

/** `Object.assign({}, ...sources)`: a fresh own-key copy. */
export function copyOwn(...sources) {
  return assignOwn({}, ...sources);
}

/** An empty map that keeps PHP's insertion order (integer-like keys included). */
export function newOrderedBag() {
  const bag = {};
  Object.defineProperty(bag, '__order', { value: [], writable: true, enumerable: false, configurable: true });
  return bag;
}

export function orderedKeys(node) {
  return ownHas(node, '__order') ? node.__order : Object.keys(node);
}

/** Assign, recording insertion order (PHP keeps a key's first position). */
export function orderedSet(node, key, value) {
  if (!ownHas(node, key)) orderedKeys(node).push(String(key));
  return ownSet(node, key, value);
}

export default { ownSet, ownGet, ownHas, assignOwn, newOrderedBag, orderedKeys, orderedSet };
