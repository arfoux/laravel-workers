// kernel/php-json-ordered.mjs — a PHP-faithful JSON reader.
//
// `JSON.parse` is not a drop-in for `json_decode($s, true)`:
//
//   1. ORDER. JSON documents preserve key order; a JS object does not (an
//      integer-like key enumerates first). `{"a":1,"b":2,"2":"x"}` parses to an
//      object whose `Object.keys()` is `["2","a","b"]` where PHP walks
//      `["a","b","2"]`. The reader records the document order in the same
//      non-enumerable `__lwOrder` marker `rt.assoc()`/`Collection` already use.
//
//   2. BYTES. PHP strings are bytes (see kernel/php-bytes.mjs). A string value
//      is answered as a latin1 byte-string, so `"\u00ff"` is the two bytes
//      `0xc3 0xbf` - exactly what PHP hands back - instead of the JS code point
//      U+00FF (one code unit) that `JSON.parse` produces.
//
//   3. INTEGERS. `json_decode('9223372036854775807')` is the 64-bit int
//      9223372036854775807; a JS number rounds it to 9223372036854775808. A
//      literal a double CAN carry exactly (10^16, 2^60) stays a number - PHP's
//      int and our number print the same bytes - and only a genuinely lossy one
//      keeps the exact value as a BigInt (opt-in) or fails loud (LW006) rather
//      than answering a silently wrong number.
//
//   4. INVALID UTF-8. `json_decode("\"\xff\"")` is NULL (a warning); PHP's JSON
//      only carries valid UTF-8. The reader answers NULL too.

import {
  byteStringFromUtf8,
  toByteString,
  isValidUtf8,
  appendCodePoint,
  utf8FromByteString,
} from './php-bytes.mjs';

/** The coded error for a value PHP can hold but the edge cannot. */
export function lwNotRepresentable(detail) {
  const err = new Error(
    'LW006: ' + detail + ' cannot be represented at the edge - port this route or widen the runtime'
  );
  err.name = 'NotRepresentableError';
  err.code = 'LW006';
  return err;
}

const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

class JsonFailure extends Error {}

/**
 * `json_decode($text, true)` with PHP's ordering, byte-string values and 64-bit
 * integer precision. Mirrors `rt.json_decode`'s contract: a parse failure (an
 * invalid document, invalid UTF-8, or a depth overflow) answers `null`.
 *
 * @param {Uint8Array|string} input  the JSON document (bytes or a byte-string)
 * @param {{ depth?: number, bigint?: boolean|'throw' }} [opts]
 *   `bigint`: what to do with an integer outside the JS safe range.
 *     `false` (default) throws `LW006` (fail loud, never a wrong number);
 *     `'throw'` is the same; `true` answers the exact value as a BigInt.
 */
export function phpJsonDecodeOrdered(input, opts = {}) {
  // TEXT mode: the input is a JS text string and the answer keeps JS text
  // values (the kernel's wire convention after the byte-program revert), so
  // the ONLY thing this reader adds over `JSON.parse` is PHP's key ORDER and
  // its integer rule. The document's UTF-8 bytes are still validated - that is
  // what PHP validates - and the scan runs over the decoded text so `\uXXXX`
  // escapes stay JS code units (JSON.parse's answer).
  const text = opts.text === true;
  let src;
  if (text) {
    const bytes = ArrayBuffer.isView(input) ? toByteString(input) : byteStringFromUtf8(String(input));
    if (!isValidUtf8(bytes)) return null;
    src = utf8FromByteString(bytes);
  } else {
    src = toByteString(input);
    // PHP's decoder only carries valid UTF-8; anything else is a failure.
    if (!isValidUtf8(src)) return null;
  }
  const depth = opts.depth === undefined || opts.depth === null ? 512 : Number(opts.depth);
  if (!(depth > 0)) {
    const err = new Error('json_decode(): Argument #3 ($depth) must be greater than 0');
    err.name = 'ValueError';
    err.phpClass = 'ValueError';
    throw err;
  }
  const bigint = opts.bigint === true;
  const state = { s: src, i: 0, n: src.length, depth, bigint, text };
  try {
    skipWs(state);
    const value = parseValue(state, 1);
    skipWs(state);
    if (state.i !== state.n) throw new JsonFailure('trailing data');
    // PHP's container rule (probed on 8.3, same as rt.json_decode): a container
    // costs a level, so an EMPTY container still counts - `json_decode('[]',
    // true, 1)` is NULL, `json_decode('1', true, 1)` is not.
    if (jsonDecodeLevels(value) + 1 > depth) throw new JsonFailure('depth');
    return value;
  } catch (e) {
    if (e instanceof JsonFailure) {
      if (opts.throwOnError) {
        const err = new Error('Syntax error');
        err.name = 'JsonException';
        err.phpClass = 'JsonException';
        throw err;
      }
      return null;
    }
    throw e;
  }
}

/** The container cost rule `rt.json_decode` probes on PHP 8.3: a container
 *  costs a level, a scalar none (`json_decode('[]', true, 1)` is NULL). */
function jsonDecodeLevels(v) {
  if (v === null || typeof v !== 'object') return 0;
  let deepest = 0;
  for (const k of Object.keys(v)) {
    const d = jsonDecodeLevels(v[k]);
    if (d > deepest) deepest = d;
  }
  return 1 + deepest;
}

function skipWs(st) {
  const { s } = st;
  while (st.i < st.n) {
    const c = s.charCodeAt(st.i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) st.i++;
    else break;
  }
}

function parseValue(st, level) {
  if (st.i >= st.n) throw new JsonFailure('eof');
  const c = st.s[st.i];
  if (c === '{') return parseObject(st, level);
  if (c === '[') return parseArray(st, level);
  if (c === '"') return parseString(st);
  if (c === 't') return literal(st, 'true', true);
  if (c === 'f') return literal(st, 'false', false);
  if (c === 'n') return literal(st, 'null', null);
  return parseNumber(st);
}

function literal(st, word, value) {
  if (st.s.slice(st.i, st.i + word.length) !== word) throw new JsonFailure('literal');
  st.i += word.length;
  return value;
}

function parseObject(st, level) {
  if (level > st.depth) throw new JsonFailure('depth');
  st.i++; // {
  const out = {};
  const order = [];
  skipWs(st);
  if (st.s[st.i] === '}') {
    st.i++;
    Object.defineProperty(out, '__lwOrder', { value: order, enumerable: false });
    return out;
  }
  for (;;) {
    skipWs(st);
    if (st.s[st.i] !== '"') throw new JsonFailure('key');
    const key = parseString(st);
    skipWs(st);
    if (st.s[st.i] !== ':') throw new JsonFailure('colon');
    st.i++;
    skipWs(st);
    const value = parseValue(st, level + 1);
    if (!Object.prototype.hasOwnProperty.call(out, key)) order.push(key);
    out[key] = value;
    skipWs(st);
    const ch = st.s[st.i];
    if (ch === ',') {
      st.i++;
      continue;
    }
    if (ch === '}') {
      st.i++;
      break;
    }
    throw new JsonFailure('object');
  }
  Object.defineProperty(out, '__lwOrder', { value: order, enumerable: false });
  return out;
}

function parseArray(st, level) {
  if (level > st.depth) throw new JsonFailure('depth');
  st.i++; // [
  const out = [];
  skipWs(st);
  if (st.s[st.i] === ']') {
    st.i++;
    return out;
  }
  for (;;) {
    skipWs(st);
    out.push(parseValue(st, level + 1));
    skipWs(st);
    const ch = st.s[st.i];
    if (ch === ',') {
      st.i++;
      continue;
    }
    if (ch === ']') {
      st.i++;
      break;
    }
    throw new JsonFailure('array');
  }
  return out;
}

/** A JSON string value as a PHP byte-string. Raw bytes are copied verbatim
 *  (they are already UTF-8 from the validation above); `\uXXXX` escapes are
 *  UTF-8 encoded so the answer is byte-identical to PHP. */
function parseString(st) {
  st.i++; // opening quote
  let out = '';
  const { s, n } = st;
  while (st.i < n) {
    const c = s.charCodeAt(st.i);
    if (c === 0x22) {
      st.i++;
      return out;
    }
    if (c === 0x5c) {
      st.i++;
      const e = s[st.i];
      switch (e) {
        case '"': out += '"'; st.i++; break;
        case '\\': out += '\\'; st.i++; break;
        case '/': out += '/'; st.i++; break;
        case 'b': out += '\b'; st.i++; break;
        case 'f': out += '\f'; st.i++; break;
        case 'n': out += '\n'; st.i++; break;
        case 'r': out += '\r'; st.i++; break;
        case 't': out += '\t'; st.i++; break;
        case 'u': {
          st.i++;
          let cp = hex4(st);
          // A surrogate pair is combined and UTF-8 encoded as one code point.
          if (cp >= 0xd800 && cp <= 0xdbff && s[st.i] === '\\' && s[st.i + 1] === 'u') {
            const save = st.i;
            st.i += 2;
            const lo = hex4(st);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
              cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
            } else {
              st.i = save;
            }
          }
          if (st.text) {
            // JS TEXT (the kernel's wire convention): a lone surrogate stays a
            // code unit and a combined pair is the two-unit character - exactly
            // what JSON.parse answers.
            out += cp > 0xffff ? String.fromCodePoint(cp) : String.fromCharCode(cp);
          } else {
            out = appendCodePoint(out, cp);
          }
          break;
        }
        default:
          throw new JsonFailure('escape');
      }
      continue;
    }
    if (c < 0x20) throw new JsonFailure('control'); // unescaped control char
    out += s[st.i];
    st.i++;
  }
  throw new JsonFailure('unterminated string');
}

function hex4(st) {
  const h = st.s.slice(st.i, st.i + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new JsonFailure('\\u');
  st.i += 4;
  return parseInt(h, 16);
}

function parseNumber(st) {
  const start = st.i;
  const { s, n } = st;
  if (s[st.i] === '-') st.i++;
  if (s[st.i] === '0') {
    st.i++;
  } else if (s[st.i] >= '1' && s[st.i] <= '9') {
    while (st.i < n && s[st.i] >= '0' && s[st.i] <= '9') st.i++;
  } else {
    throw new JsonFailure('number');
  }
  let isFloat = false;
  if (s[st.i] === '.') {
    isFloat = true;
    st.i++;
    if (!(s[st.i] >= '0' && s[st.i] <= '9')) throw new JsonFailure('fraction');
    while (st.i < n && s[st.i] >= '0' && s[st.i] <= '9') st.i++;
  }
  if (s[st.i] === 'e' || s[st.i] === 'E') {
    isFloat = true;
    st.i++;
    if (s[st.i] === '+' || s[st.i] === '-') st.i++;
    if (!(s[st.i] >= '0' && s[st.i] <= '9')) throw new JsonFailure('exponent');
    while (st.i < n && s[st.i] >= '0' && s[st.i] <= '9') st.i++;
  }
  const lit = s.slice(start, st.i);
  if (isFloat) return Number(lit);
  // PHP answers a 64-bit int; keep the exact value, never a rounded number.
  const exact = BigInt(lit);
  const asNumber = Number(lit);
  if (exact < INT64_MIN || exact > INT64_MAX) return asNumber; // PHP overflows to float
  // `Number.isSafeInteger` is conservative: a double ABOVE 2^53 can still carry
  // the literal's exact value (10^16, 2^60), and then PHP's int and our number
  // round-trip to the same bytes. Only a LOSSY conversion is a wrong number.
  if (BigInt(asNumber) === exact) return asNumber;
  if (st.bigint) return exact;
  throw lwNotRepresentable(
    `the integer ${lit} cannot be held exactly (PHP holds it exactly; a JS number would round it to ${String(asNumber)})`
  );
}

export default { phpJsonDecodeOrdered, lwNotRepresentable };
