// kernel/php-json.mjs — PHP json_encode() subset (default flags).
//
// Byte-compatible with PHP 8.3 `json_encode($value)` (serialize_precision=-1)
// — the exact call Illuminate\Session\Store::save() performs when
// session.serialization === "json" (the Laravel 11+/13 scaffold default) and
// the call CookieSessionHandler::write() performs for the
// {"data": ..., "expires": ...} cookie envelope.
// Verified against PHP 8.3 in kernel/tests/php-json.test.mjs
// (oracle: tools/php-json-oracle.php).
//
// Calibrated formatting rules:
//   - "/" is escaped as "\/", non-ASCII as lowercase \uXXXX (surrogate pairs
//     for astral code points); 0x08/09/0a/0c/0d use \b \t \n \f \r; other
//     control chars become \u00xx; DEL (0x7f) stays raw.
//   - Floats: plain decimal when the decimal exponent is in [-4..16];
//     integral doubles print WITHOUT a fraction ("1", "12", but note the
//     PRESERVE_ZERO_FRACTION flag is not set by Laravel); scientific uses
//     lowercase "e" with an explicit sign ("1.0e+17", "1.0e-5", "5.0e-324").
//   - Arrays with keys exactly 0..n-1 in order encode as JSON lists; canonical
//     decimal string keys are cast to ints (PHP semantics; "-0", "+0", "00"
//     stay strings — verified against PHP); an empty UNMARKED object encodes as
//     [] (PHP's empty array), while a value tagged as a stdClass (`(object)`
//     cast, json_decode assoc=false, the `object` model cast) always encodes as
//     an object — `{}` when empty, `{"0":..}` when its names are list indices.
//   - NAN/INF and lone UTF-16 surrogates fail loud (PHP json_encode() returns
//     false with "Inf and NaN cannot be JSON encoded" / "Malformed UTF-8
//     characters").
//
// Known normalization (same caveats as kernel/php-serialize.mjs): JS numbers
// cannot distinguish int from float — invisible here because default
// json_encode() prints integral doubles exactly like ints ("1.0" → "1") — and
// lose precision beyond 2^53 (PHP int64 range).

import { phpFloat } from './php-serialize.mjs';

export class PhpJsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PhpJsonError';
  }
}

// PHP casts a string key to int only for canonical decimal ints (no "-0",
// "+0" or leading zeros) that fit in a platform int.
const INT_KEY_RE = /^(?:0|-?[1-9][0-9]*)$/;
// A PHP `stdClass` is not a PHP array: `json_encode(new stdClass)` is `{}` while
// `json_encode([])` is `[]`, and a stdClass whose property names are the list
// indices still encodes as an OBJECT (`(object) [10, 20]` -> `{"0":10,"1":20}`).
// JS cannot tell a plain object that came from a stdClass from one that came
// from an assoc array, so the creating site marks the value (a non-enumerable
// property, invisible to Object.keys/JSON.stringify/the output). rt.objectCast(),
// rt.json_decode() with $assoc = false and the `object` model cast set it.
function defineObjectMarker(value) {
  if (value.__lwObject !== true) {
    Object.defineProperty(value, '__lwObject', {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
}
/** Mark a value as a PHP `stdClass` (a JSON OBJECT, never a JSON list). */
export function tagPhpObject(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) defineObjectMarker(value);
  return value;
}
/** `tagPhpObject` for every object nested inside `value` (json_decode assoc=false). */
export function tagPhpObjectDeep(value) {
  if (Array.isArray(value)) {
    for (const x of value) tagPhpObjectDeep(x);
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  defineObjectMarker(value);
  for (const k of Object.keys(value)) tagPhpObjectDeep(value[k]);
  return value;
}

function isPlainObject(v) {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const HEX4 = (c) => c.toString(16).padStart(4, '0');

function writeString(s, out, opts) {
  const raw = opts.unescapedUnicode;
  out.push('"');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (n < 0xdc00 || n > 0xdfff) {
        throw new PhpJsonError('malformed UTF-16 (lone high surrogate)');
      }
      if (raw) out.push(s.slice(i, i + 2));
      else out.push('\\u', HEX4(c), '\\u', HEX4(n));
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      throw new PhpJsonError('malformed UTF-16 (lone low surrogate)');
    }
    switch (c) {
      case 0x22:
        out.push('\\"');
        break;
      case 0x5c:
        out.push('\\\\');
        break;
      case 0x2f:
        out.push('\\/');
        break;
      case 0x08:
        out.push('\\b');
        break;
      case 0x09:
        out.push('\\t');
        break;
      case 0x0a:
        out.push('\\n');
        break;
      case 0x0c:
        out.push('\\f');
        break;
      case 0x0d:
        out.push('\\r');
        break;
      default:
        if (c < 0x20) out.push('\\u', HEX4(c));
        else if (c <= 0x7f) out.push(String.fromCharCode(c));
        else if (raw) out.push(String.fromCharCode(c));
        else out.push('\\u', HEX4(c));
    }
  }
  out.push('"');
}

function writeValue(value, out, opts) {
  if (value === null) {
    out.push('null');
    return;
  }
  if (value === undefined) {
    throw new PhpJsonError('undefined is not a PHP value');
  }
  const t = typeof value;
  if (t === 'boolean') {
    out.push(value ? 'true' : 'false');
    return;
  }
  if (t === 'number') {
    if (Number.isNaN(value) || value === Infinity || value === -Infinity) {
      throw new PhpJsonError('Inf and NaN cannot be JSON encoded');
    }
    if (Object.is(value, -0)) {
      out.push('-0');
      return;
    }
    if (Number.isSafeInteger(value)) {
      out.push(String(value));
      return;
    }
    out.push(phpFloat(value, 'e'));
    return;
  }
  if (t === 'string') {
    writeString(value, out, opts);
    return;
  }
  if (t === 'bigint') {
    throw new PhpJsonError('bigint is not supported (int64 beyond the JS safe range)');
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',');
      writeValue(value[i], out, opts);
    }
    out.push(']');
    return;
  }
  // A JsonResource is JsonSerializable (`JsonResource::jsonSerialize()` ->
  // `resolve()`), so PHP's `json_encode($resource)` answers the RESOLVED data -
  // and a resource NESTED inside another resource's array is resolved at the
  // same moment, with the request the application is handling
  // (`resolve($request = null)` -> `app('request')`). Without this the encoder
  // failed loud ("unsupported value (UserResource)") for an API that nests
  // resources, which PHP answers 200. `instanceof` cannot be used: the kernel's
  // property proxy replaces the prototype, so the instance carries the marker.
  if (value && value.__lwResource === true) {
    writeValue(value.jsonSerialize(), out, opts);
    return;
  }
  if (isPlainObject(value)) {
    // PHP's json_encode preserves the array's INSERTION order. A JS object
    // enumerates an integer-like key first, so a literal that mixes both
    // kinds carries the PHP order in a non-enumerable marker (rt.assoc).
    const keys = Array.isArray(value.__lwOrder) ? value.__lwOrder : Object.keys(value);
    const norm = [];
    let isList = true;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (INT_KEY_RE.test(key)) {
        const n = Number(key);
        if (Number.isSafeInteger(n)) {
          norm.push(n);
          if (n !== i) isList = false;
          continue;
        }
      }
      norm.push(key);
      isList = false;
    }
    if (isList && value.__lwObject !== true) {
      // Empty object encodes as [] (PHP empty array); keys exactly 0..n-1
      // in order encode as a JSON list. A value tagged as a stdClass
      // (`(object)` cast / json_decode assoc=false) is NOT a PHP array, so it
      // always takes the object branch below (`{}` for the empty one).
      out.push('[');
      for (let i = 0; i < norm.length; i++) {
        if (i > 0) out.push(',');
        writeValue(value[keys[i]], out, opts);
      }
      out.push(']');
      return;
    }
    out.push('{');
    for (let i = 0; i < norm.length; i++) {
      if (i > 0) out.push(',');
      writeString(typeof norm[i] === 'number' ? String(norm[i]) : norm[i], out, opts);
      out.push(':');
      writeValue(value[keys[i]], out, opts);
    }
    out.push('}');
    return;
  }
  // A Model is JsonSerializable: Laravel's json_encode($model) answers the
  // model's toArray() (its toJSON()), not a "PHP object" error. The edge
  // answered a 500 for `response()->json($post)`. Only a MODEL: a Date has a
  // toJSON() too, and PHP's json_encode(new DateTime()) answers '{}'.
  if (
    value && typeof value === 'object' && typeof value.toJSON === 'function' &&
    value.constructor && value.constructor.__lwModel
  ) {
    writeValue(value.toJSON(), out, opts);
    return;
  }
  // A kernel Collection is JsonSerializable too (`jsonSerialize()` -> `all()`),
  // so `json_encode($collection)` writes the underlying array - the same bytes
  // a JSON CAST of a `collection` attribute stores.
  if (value && typeof value === 'object' && value.constructor && value.constructor.__lwCollection) {
    writeValue(value.all(), out, opts);
    return;
  }
  const name = value?.constructor?.name || t;
  throw new PhpJsonError(`unsupported value (${name}) — PHP objects are outside the subset`);
}

export function phpJsonEncode(value, options = undefined) {
  const opts = { unescapedUnicode: !!(options && options.unescapedUnicode) };
  const out = [];
  writeValue(value, out, opts);
  return out.join('');
}

/**
 * PHP json_decode($text, true) equivalent for the session subset.
 *
 * JSON.parse already produces the matching structures: PHP's empty-object →
 * empty-array normalization is invisible to byte output because our encoder
 * writes empty objects back as [] too. Known divergence: PHP's decoder maps
 * the JSON token -0 back to int 0 (PHP is not round-trip stable there; see
 * kernel/tests/php-json.test.mjs), and numbers beyond 2^53 lose precision.
 */
export function phpJsonDecode(text) {
  return JSON.parse(text);
}
