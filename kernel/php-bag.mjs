// kernel/php-bag.mjs — PHP's variable-registration bag.
//
// `parse_str()`/`$_GET`/`$_POST`/`$_FILES` all build PHP ARRAYS: `a[b][c]` nests,
// `a[]` appends, and a key named `__proto__` is ordinary DATA
// (`parse_str('x[__proto__][p]=2')` answers `{"x":{"__proto__":{"p":"2"}}}` — measured
// on PHP 8.3). A JS object literal is not that: an own-property write via
// `Object.defineProperty` is required, or a crafted query string mutates
// Object.prototype for the whole isolate (kernel/own-key.mjs explains the
// mechanism). Both the query-string parser (kernel/http.mjs) and the multipart
// parser (kernel/multipart.mjs) register their names through here, so the rule
// lives once.
import { ownSet, ownGet, ownHas, newOrderedBag, orderedKeys, orderedSet } from './own-key.mjs';

/** urldecode() with `+` → space and %XX bytes decoded as UTF-8. */
function urldecodePlus(input) {
  const s = String(input ?? '').replace(/\+/g, ' ');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      const bytes = [];
      while (s[i] === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 3;
      }
      i--;
      try {
        out += new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
      } catch {
        out += '?';
      }
    } else {
      out += s[i];
    }
  }
  return out;
}

/** parse_str() base-name rule: spaces and dots become underscores. */
function phpBaseKey(name) {
  return String(name).replace(/[.\s]/g, '_');
}

function parseNameSegments(name) {
  const open = name.indexOf('[');
  if (open === -1) return { base: phpBaseKey(name), segs: null };
  const base = phpBaseKey(name.slice(0, open));
  const segs = [];
  let rest = name.slice(open);
  while (rest.length) {
    if (rest[0] !== '[') return { base, segs: null };
    const close = rest.indexOf(']');
    if (close === -1) return { base, segs: null };
    segs.push(rest.slice(1, close));
    rest = rest.slice(close + 1);
  }
  return { base, segs };
}

/** Canonical PHP integer-string key (matches the Repository::itemKey() rule). */
const PHP_INT_KEY = /^(?:0|[1-9][0-9]*)$/;

/**
 * A parse container: a plain object plus a hidden insertion-order log.
 *
 * PHP's parse_str() keeps insertion order even for integer keys, and json_encode()
 * emits a JSON *list* only when the keys are exactly 0..n-1 in that order (an object
 * otherwise). JS objects re-order integer-like keys, so the order is tracked here and
 * the containers PHP would have stored as lists are promoted in normalizePhpArrays().
 */
function newBag() {
  return newOrderedBag();
}

function isBag(node) {
  return node !== null && typeof node === 'object' && !Array.isArray(node);
}

function bagOrder(node) {
  return orderedKeys(node);
}

/** Assign, recording insertion order (PHP keeps a key's first position). */
function bagSet(node, key, value) {
  return orderedSet(node, key, value);
}

/** The key `$a[]` uses: the next free integer index (max int key + 1, else 0). */
function appendKey(node) {
  let max = -1;
  for (const k of bagOrder(node)) if (PHP_INT_KEY.test(k)) max = Math.max(max, Number(k));
  return String(max + 1);
}

/** Ensure a nested container at `key` (PHP replaces a scalar with an array). */
function ensureBag(node, key) {
  const cur = ownGet(node, key);
  if (!isBag(cur)) bagSet(node, key, newBag());
  return ownGet(node, key);
}

function setNested(node, segs, value) {
  const seg = segs[0] === '' ? null : segs[0];
  if (segs.length === 1) {
    if (seg === null) bagSet(node, appendKey(node), value);
    else bagSet(node, seg, value);
    return;
  }
  if (seg === null) {
    // `a[][x]`: every `[]` appends a NEW container (PHP does not reuse).
    const child = newBag();
    bagSet(node, appendKey(node), child);
    setNested(child, segs.slice(1), value);
    return;
  }
  setNested(ensureBag(node, seg), segs.slice(1), value);
}

/** Promote the containers PHP would have stored as lists (keys exactly 0..n-1). */
function normalizePhpArrays(node) {
  if (!isBag(node)) return node;
  const order = bagOrder(node);
  for (const k of order) ownSet(node, k, normalizePhpArrays(ownGet(node, k)));
  if (order.length > 0 && order.every((k, i) => PHP_INT_KEY.test(k) && Number(k) === i)) {
    return order.map((k) => ownGet(node, k));
  }
  return node;
}

/**
 * One PHP variable registration: `php_register_variable_ex()` — the rule both
 * `parse_str()` (query strings, urlencoded bodies) and the multipart parser
 * (`rfc1867.c`, `$_POST`/`$_FILES`) apply to a name. `a[b][c]` nests, `a[]`
 * appends at the next free integer index, a duplicate scalar is last-wins, a
 * scalar in an array's place is replaced.
 */
export function bagPut(out, name, value) {
  const { base, segs } = parseNameSegments(name);
  if (!segs || segs.length === 0) {
    bagSet(out, base, value);
    return out;
  }
  if (!ownHas(out, base) || !isBag(ownGet(out, base))) bagSet(out, base, newBag());
  setNested(ownGet(out, base), segs, value);
  return out;
}

/**
 * PHP parse_str() subset used for query strings and urlencoded form bodies.
 * Supported: flat keys, `a[b]`, `a[b][c]`, `a[]` list append (next free integer
 * index), duplicate scalar last-wins, scalar→array overwrite, and list promotion
 * for integer-keyed sequences. Exotic conflicts (scalar vs array on the same key)
 * follow the common shape rather than every PHP warning path — covered by
 * kernel/tests/http.test.mjs against a live PHP oracle.
 */
export function parsePhpQuery(input) {
  const out = newBag();
  const s = input == null ? '' : String(input);
  if (s === '') return out;
  for (const pair of s.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const name = urldecodePlus(eq === -1 ? pair : pair.slice(0, eq));
    const value = urldecodePlus(eq === -1 ? '' : pair.slice(eq + 1));
    bagPut(out, name, value);
  }
  return normalizePhpArrays(out);
}

export { newBag, normalizePhpArrays, bagPut as registerVariable };
