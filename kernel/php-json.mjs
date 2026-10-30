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
  // A date attribute READ is a Carbon value (JsonSerializable), and the
  // runtime's `now()`/`today()` stub is the same PHP kind (DateTimeInterface):
  // `json_encode($post->created_at)` / `json_encode(now())` answer the ISO8601
  // string with microseconds and a `Z` (Carbon/Converter.php:442-455), not an
  // object - this branch must come BEFORE the plain-object branch (the value's
  // methods live on the prototype, so `isPlainObject` would otherwise write
  // them).
  if (
    value && typeof value === 'object' &&
    (value.__lwDateValue === true || value._d instanceof Date) &&
    typeof value.toJSON === 'function'
  ) {
    writeValue(value.toJSON(), out, opts);
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

// ---------------------------------------------------------------------------
// json_encode($value, $flags, $depth): the option constants PHP defines
// (php.net/json.constants, read off the PHP 8.3 oracle). They are fixed
// integers, so the transpiler can fold a bare `JSON_UNESCAPED_SLASHES` to 64.
// ---------------------------------------------------------------------------
export const JSON_HEX_TAG = 1;
export const JSON_HEX_AMP = 2;
export const JSON_HEX_APOS = 4;
export const JSON_HEX_QUOT = 8;
export const JSON_FORCE_OBJECT = 16;
export const JSON_UNESCAPED_SLASHES = 64;
export const JSON_PRETTY_PRINT = 128;
export const JSON_UNESCAPED_UNICODE = 256;
export const JSON_THROW_ON_ERROR = 4194304;
const JSON_HEX_FLAGS = JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT;
// The flags with a byte-exact answer at the edge. The rest (NUMERIC_CHECK,
// PARTIAL_OUTPUT_ON_ERROR, PRESERVE_ZERO_FRACTION, INVALID_UTF8_*, ...) would
// answer a different body, so they fail loud instead of diverging silently.
const JSON_SUPPORTED_FLAGS =
  JSON_HEX_FLAGS |
  JSON_FORCE_OBJECT |
  JSON_UNESCAPED_SLASHES |
  JSON_PRETTY_PRINT |
  JSON_UNESCAPED_UNICODE |
  JSON_THROW_ON_ERROR;
// A PHP array: a JS array, or a plain object that is not a tagged stdClass
// (`__lwObject`). Mirrors the runtime's isPhpArray for the depth walk.
function isPhpArrayForDepth(v) {
  if (Array.isArray(v)) return true;
  if (v === null || typeof v !== 'object') return false;
  if (v.__lwObject === true) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
// The HEX flags rewrite the characters INSIDE the encoded JSON: `<`, `>`, `&`
// and `'` are not JSON syntax, so a literal one in the output can only come
// from a string. The `"` is the ESCAPED one (`\"` inside a string) - the string
// delimiters are bare quotes.
function jsonHexEncode(json, flags) {
  if (!flags) return json;
  let out = '';
  let i = 0;
  while (i < json.length) {
    const c = json[i];
    if (c !== '"') {
      out += c;
      i++;
      continue;
    }
    out += '"';
    i++;
    while (i < json.length) {
      const ch = json[i];
      if (ch === '\\') {
        const next = json[i + 1];
        if (next === '"' && flags & JSON_HEX_QUOT) {
          out += '\\u0022';
          i += 2;
          continue;
        }
        // \\ \/ \b \t \n \f \r \u - the hex digits of a \u escape are copied as
        // they are (they are never one of the flagged characters).
        out += ch + next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        out += '"';
        i++;
        break;
      }
      if (flags & JSON_HEX_TAG) {
        if (ch === '<') {
          out += '\\u003C';
          i++;
          continue;
        }
        if (ch === '>') {
          out += '\\u003E';
          i++;
          continue;
        }
      }
      if (flags & JSON_HEX_AMP && ch === '&') {
        out += '\\u0026';
        i++;
        continue;
      }
      if (flags & JSON_HEX_APOS && ch === "'") {
        out += '\\u0027';
        i++;
        continue;
      }
      out += ch;
      i++;
    }
  }
  return out;
}
// PHP's json_encode() pretty printer (ext/json/json.c: php_json_pretty_print):
// four spaces per level, a newline after every brace/comma, `": "` after a
// key and `[]`/`{}` for an empty container (no newline inside it).
function jsonPrettyPrint(json) {
  let out = '';
  let depth = 0;
  const pad = () => '    '.repeat(depth);
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += json[i + 1] || '';
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      if (json[i + 1] === close) {
        out += c + close;
        i++;
        continue;
      }
      depth++;
      out += c + '\n' + pad();
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      out += '\n' + pad() + c;
      continue;
    }
    if (c === ',') {
      out += ',\n' + pad();
      continue;
    }
    if (c === ':') {
      out += ': ';
      continue;
    }
    out += c;
  }
  return out;
}
// The value JSON_FORCE_OBJECT produced, encoded as an OBJECT (keys quoted, in
// the map's own order). JSON_FORCE_OBJECT is documented as forcing a PHP
// object, so every level of the map is written the same way.
function phpJsonEncodeMapAsObject(v, opts) {
  if (v === null || typeof v !== 'object') return phpJsonEncode(v, opts);
  const keys = Object.keys(v);
  return (
    '{' +
    keys.map((k) => phpJsonEncode(String(k)) + ':' + phpJsonEncodeMapAsObject(v[k], opts)).join(',') +
    '}'
  );
}
// JSON_FORCE_OBJECT: every ARRAY becomes an object (the depth walk keeps the
// value shape, the keys become 0..n-1).
function jsonForceObject(v) {
  if (Array.isArray(v)) {
    const o = {};
    for (let i = 0; i < v.length; i++) o[String(i)] = jsonForceObject(v[i]);
    return o;
  }
  if (v !== null && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = jsonForceObject(v[k]);
    return o;
  }
  return v;
}
// PHP's json_encode() depth: the nesting of the arrays/objects (a scalar is no
// level). PHP returns false past it ("Maximum stack depth exceeded").
function jsonDepth(v) {
  if (Array.isArray(v)) {
    let deepest = 0;
    for (const item of v) {
      const d = jsonDepth(item);
      if (d > deepest) deepest = d;
    }
    return 1 + deepest;
  }
  if (isPhpArrayForDepth(v)) {
    let deepest = 0;
    for (const k of Object.keys(v)) {
      const d = jsonDepth(v[k]);
      if (d > deepest) deepest = d;
    }
    return 1 + deepest;
  }
  return 0;
}
/**
 * PHP `json_encode($value, $flags = 0, $depth = 512)` for the flag subset the
 * edge honours. One implementation is shared by the runtime's `rt.json_encode`,
 * `Collection::toJson($options)` and `JsonResource::toJson($options)` - all
 * three are literally `json_encode($v, $options)` in Laravel, so they must write
 * the same bytes. A flag outside the subset (NUMERIC_CHECK, PRESERVE_ZERO_
 * FRACTION, PARTIAL_OUTPUT_ON_ERROR, INVALID_UTF8_*, ...) throws instead of
 * diverging silently; the depth overflow answers `false` (or a JsonException
 * under JSON_THROW_ON_ERROR), exactly like PHP.
 */
export function phpJsonEncodeWithFlags(value, flags = 0, depth = 512) {
  const f = flags == null ? 0 : Number(flags);
  const d = depth == null ? 512 : Number(depth) | 0;
  if (f & ~JSON_SUPPORTED_FLAGS) {
    throw new PhpJsonError(
      'json_encode() flags ' +
        f +
        ' are not supported at the edge — PHP would write a different body with them (the ported ones are ' +
        'JSON_HEX_TAG|JSON_HEX_AMP|JSON_HEX_APOS|JSON_HEX_QUOT, JSON_FORCE_OBJECT, JSON_UNESCAPED_SLASHES, ' +
        'JSON_PRETTY_PRINT, JSON_UNESCAPED_UNICODE, JSON_THROW_ON_ERROR) — drop the flags or write a port'
    );
  }
  const v = value == null ? null : value;
  // JSON_FORCE_OBJECT shapes an ARRAY into an OBJECT here, but a PHP object is
  // a JS object already, so phpJsonEncode() would write it as `{...}` - and an
  // EMPTY array must print `{}` too. The map is converted to its ordered PAIRS
  // before encoding so the empty case survives.
  const shaped = f & JSON_FORCE_OBJECT ? jsonForceObject(v) : v;
  if (jsonDepth(shaped) > d) {
    if (f & JSON_THROW_ON_ERROR) {
      const err = new Error('Maximum stack depth exceeded');
      err.name = 'JsonException';
      err.phpClass = 'JsonException';
      throw err;
    }
    return false;
  }
  let json;
  try {
    json = phpJsonEncode(shaped, { unescapedUnicode: !!(f & JSON_UNESCAPED_UNICODE) });
    if (f & JSON_FORCE_OBJECT) {
      // The encoder writes a key-less map as `[]` and a 0..n-1 map as a list
      // (it cannot see that the value was an ARRAY); PHP's JSON_FORCE_OBJECT
      // writes an OBJECT in both cases, so the forced shape is spelled out.
      if (shaped !== null && typeof shaped === 'object') {
        json = phpJsonEncodeMapAsObject(shaped, { unescapedUnicode: !!(f & JSON_UNESCAPED_UNICODE) });
      }
    }
  } catch (e) {
    // An unencodable value (invalid UTF-8, Inf/NaN) is `false` from PHP's
    // json_encode - `null` positive with JSON_THROW_ON_ERROR, which raises
    // JsonException ("Malformed UTF-8 characters, possibly incorrectly encoded").
    if (f & JSON_THROW_ON_ERROR) {
      const err = new Error(e && e.message ? e.message : 'json_encode() failed');
      err.name = 'JsonException';
      err.phpClass = 'JsonException';
      throw err;
    }
    return false;
  }
  if (f & JSON_UNESCAPED_SLASHES) json = json.replace(/\\\//g, '/');
  let out = jsonHexEncode(json, f & JSON_HEX_FLAGS);
  if (f & JSON_PRETTY_PRINT) out = jsonPrettyPrint(out);
  return out;
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
