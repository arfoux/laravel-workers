// kernel/php-bytes.mjs — the PHP string representation for the compiled rung.
//
// PHP strings are BYTE sequences, not text: `strlen("\xff\xfe")` is 2, `ord()`
// answers 255, `substr()` counts bytes and a regex without `/u` matches single
// BYTES. JavaScript strings are UTF-16 code-unit sequences, so the two only
// agree on valid ASCII/UTF-8 text.
//
// The kernel's invariant: **a PHP string is carried as a JS string in which one
// code unit == one byte** (a "latin1 byte-string"). Under that mapping every
// native JS string operation IS the PHP one:
//
//   length            -> strlen()      (byte count)
//   charCodeAt(i)     -> ord($s[$i])   (0..255)
//   slice(a, b)       -> substr()
//   indexOf(x)        -> strpos()
//   /x/ (no /u)       -> PCRE byte semantics
//
// The ONLY conversions that may touch the encoding are at the real boundaries:
//   * entering PHP from raw bytes  -> `byteStringFromBytes(bytes)`   (1:1 copy)
//   * entering PHP from JS TEXT    -> `byteStringFromUtf8(text)`     (UTF-8 encode)
//   * leaving PHP to JS text/HTML  -> `utf8FromByteString(bs)`       (UTF-8 decode)
//   * leaving PHP to raw bytes     -> `bytesFromByteString(bs)`      (1:1 copy)
//
// `TextEncoder`/`TextDecoder` must NEVER be called on a value that is already a
// PHP string: they re-encode each byte as UTF-8, which is exactly the silent
// corruption this module exists to remove (byte 0xff became 0xc3 0xbf).

/** A JS string with one code unit per byte. Throws if `s` is not representable
 *  (a code unit > 255 means the caller handed in JS TEXT, not a PHP string). */
export function assertByteString(s, where = 'php-bytes') {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) {
      const err = new Error(
        `${where}: string contains a code unit > 0xFF (U+${s.charCodeAt(i).toString(16).toUpperCase()}) - ` +
          'this is JS text, not a PHP byte-string; convert it with byteStringFromUtf8() first'
      );
      err.name = 'TypeError';
      err.phpClass = 'TypeError';
      throw err;
    }
  }
  return s;
}

/** Raw bytes -> PHP string (1:1, byte-preserving, no decoding). */
export function byteStringFromBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return out;
}

/** PHP string -> raw bytes (1:1, the inverse of byteStringFromBytes). */
export function bytesFromByteString(bs) {
  assertByteString(bs);
  const out = new Uint8Array(bs.length);
  for (let i = 0; i < bs.length; i++) out[i] = bs.charCodeAt(i);
  return out;
}

/** JS TEXT (UTF-16) -> PHP string: UTF-8 encode the text, carry the bytes 1:1.
 *  Used where a JS-native literal/JSON text enters PHP (a route segment from
 *  `URL`, a config value written in JS, a `fetch` body typed as text). */
export function byteStringFromUtf8(text) {
  return byteStringFromBytes(new TextEncoder().encode(String(text)));
}

/** Coerce a value that reaches a PHP-string boundary into a PHP string.
 *  Raw bytes are copied 1:1 (they ARE the PHP bytes). A JS string is already a
 *  byte-string unless it carries a code unit > 255: only JS TEXT can have one,
 *  so such a value is UTF-8 encoded - PHP's own bytes for that literal/JSON
 *  text - instead of being silently re-read as latin1 bytes. (A JS text string
 *  whose code units are ALL <= 255 is indistinguishable from a byte-string and
 *  is taken as one; that is the documented caveat of the representation.) */
export function toByteString(input) {
  if (input instanceof Uint8Array) return byteStringFromBytes(input);
  if (ArrayBuffer.isView(input)) {
    return byteStringFromBytes(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  }
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return byteStringFromUtf8(s);
  }
  return s;
}

/** PHP string -> JS TEXT (UTF-16): UTF-8 decode. Where PHP's bytes must become
 *  a JS-native string (an error message, a URL, a template literal). */
export function utf8FromByteString(bs) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytesFromByteString(bs));
}

/** PHP's UTF-8 validity (`json_encode()`/`json_decode()` answer false/NULL on
 *  invalid UTF-8; `preg_*` with `/u` fails). Validates the raw bytes. */
export function isValidUtf8(bs) {
  const b = bytesFromByteString(bs);
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i];
    if (c < 0x80) {
      i++;
      continue;
    }
    let extra;
    let min;
    let cp;
    if (c >= 0xc2 && c <= 0xdf) {
      extra = 1;
      min = 0x80;
      cp = c & 0x1f;
    } else if (c >= 0xe0 && c <= 0xef) {
      extra = 2;
      min = 0x800;
      cp = c & 0x0f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      extra = 3;
      min = 0x10000;
      cp = c & 0x07;
    } else {
      return false;
    }
    if (i + extra >= n) return false;
    for (let k = 1; k <= extra; k++) {
      const cc = b[i + k];
      if ((cc & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (cc & 0x3f);
    }
    if (cp < min) return false; // overlong
    if (cp > 0x10ffff) return false;
    if (cp >= 0xd800 && cp <= 0xdfff) return false; // surrogate
    i += extra + 1;
  }
  return true;
}

/** One Unicode code point -> its UTF-8 bytes, appended to a PHP string. */
export function appendCodePoint(out, cp) {
  if (cp < 0x80) return out + String.fromCharCode(cp);
  if (cp < 0x800) {
    return out + String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  }
  if (cp < 0x10000) {
    return (
      out + String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    );
  }
  return (
    out +
    String.fromCharCode(
      0xf0 | (cp >> 18),
      0x80 | ((cp >> 12) & 0x3f),
      0x80 | ((cp >> 6) & 0x3f),
      0x80 | (cp & 0x3f)
    )
  );
}

/** PHP's `strlen()`: the byte count of a PHP string. */
export const byteLen = (bs) => assertByteString(bs).length;

export default {
  assertByteString,
  byteStringFromBytes,
  bytesFromByteString,
  byteStringFromUtf8,
  toByteString,
  utf8FromByteString,
  isValidUtf8,
  appendCodePoint,
  byteLen,
};
