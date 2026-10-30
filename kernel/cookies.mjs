// kernel/cookies.mjs — Laravel 13.37 cookie layer, byte-compatible.
//
// Ports these vendor behaviours exactly (verified against PHP 8.3 oracles in
// kernel/tests/cookies.test.mjs):
//
//   - Symfony\Component\HttpFoundation\Cookie::__toString() (serialization)
//   - PHP cookie request parsing (percent-decoding, no plus-to-space)
//   - Illuminate\Cookie\CookieValuePrefix (sha1 HMAC prefix)
//   - Illuminate\Cookie\Middleware\EncryptCookies
//   - Symfony\Component\HttpFoundation\ResponseHeaderBag::setCookie() ordering
//
// Crypto (AES-256-CBC payloads) comes from kernel/encrypter.mjs (async via
// WebCrypto). Everything else is synchronous and workerd-compatible.

import { encryptString, decryptString, DecryptError } from './encrypter.mjs';
import { ownSet, ownGet, ownHas } from './own-key.mjs';

export class CookieError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CookieError';
  }
}

// ---------------------------------------------------------------------------
// PHP rawurlencode / rawurldecode (byte-wise).
// ---------------------------------------------------------------------------

const UNRESERVED = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~'.split('')
);

const HEX = '0123456789ABCDEF';

/** PHP rawurlencode(): encodes every byte outside [A-Za-z0-9-_.~]. */
export function rawUrlEncode(str) {
  const bytes = new TextEncoder().encode(String(str));
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const ch = String.fromCharCode(b);
    if (b < 0x80 && UNRESERVED.has(ch)) {
      out += ch;
    } else {
      out += '%' + HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
    }
  }
  return out;
}

/** PHP rawurldecode(): tolerant percent-decoding, '+' is kept literally. */
export function rawUrlDecode(str) {
  const s = String(str);
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x25 /* % */ && i + 2 < s.length) {
      // PHP's rawurldecode() (ext/standard/url.c): BOTH characters must be
      // hex digits, otherwise the '%' stays literal. parseInt() alone accepts
      // the prefix of an invalid pair ("%1x" -> 0x01, "%z1" -> 0x01), which
      // decoded attacker-controlled Cookie headers to different bytes.
      const hex = /^[0-9a-fA-F]{2}$/;
      const pair = s.slice(i + 1, i + 3);
      if (hex.test(pair)) {
        bytes.push(parseInt(pair, 16));
        i += 2;
        continue;
      }
    }
    if (c < 0x100) {
      bytes.push(c);
    } else {
      // Non-ASCII char in the source string: UTF-8 encode it (PHP strings are
      // byte arrays; the wire value is what matters).
      for (const b of new TextEncoder().encode(String.fromCharCode(c))) bytes.push(b);
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}

// ---------------------------------------------------------------------------
// PHP gmdate('D, d M Y H:i:s T')
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n) => String(n).padStart(2, '0');

/** PHP gmdate('D, d M Y H:i:s', ts) . ' GMT' with an integer unix timestamp. */
export function gmdateCookie(ts) {
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) throw new CookieError(`gmdateCookie: invalid timestamp ${ts}`);
  return (
    `${WEEKDAYS[d.getUTCDay()]}, ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ` +
    `${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} GMT`
  );
}

// ---------------------------------------------------------------------------
// Symfony Cookie value object + serialization.
// ---------------------------------------------------------------------------

const RESERVED_CHARS_FROM = ['=', ',', ';', ' ', '\t', '\r', '\n', '\v', '\f'];
const RESERVED_CHARS_TO = ['%3D', '%2C', '%3B', '%20', '%09', '%0D', '%0A', '%0B', '%0C'];

/**
 * Build a cookie value object matching Symfony's Cookie defaults used by
 * Laravel (Illuminate\Cookie\CookieJar + StartSession + CSRF middleware).
 *
 * expires: unix seconds; 0 = no Expires attribute (session cookie).
 */
export function makeCookie(name, value = null, expires = 0, opts = {}) {
  const {
    path = '/',
    domain = null,
    secure = false,
    httpOnly = true,
    raw = false,
    sameSite = null,
    partitioned = false,
  } = opts;
  if (raw) {
    for (const c of RESERVED_CHARS_FROM) {
      if (String(name).includes(c)) {
        throw new CookieError(
          `Cookie name "${name}" contains reserved character ${JSON.stringify(c)} (raw cookie)`
        );
      }
    }
  }
  return { name, value, expires, path, domain, secure, httpOnly, raw, sameSite, partitioned };
}

/**
 * Symfony Cookie::__toString().
 *
 * `now` is the current unix timestamp (seconds) used for the "deleted" branch
 * and the derived Max-Age value (Symfony recomputes max-age at render time).
 * Laravel renders cookies within the same second they are built, so passing
 * the request time reproduces byte-identical output.
 */
export function serializeCookie(cookie, now = Math.floor(Date.now() / 1000)) {
  const { name, value, expires, path, domain, secure, httpOnly, raw, sameSite, partitioned } =
    cookie;

  let str;
  if (raw) {
    str = name;
  } else {
    str = String(name);
    for (let i = 0; i < RESERVED_CHARS_FROM.length; i++) {
      str = str.split(RESERVED_CHARS_FROM[i]).join(RESERVED_CHARS_TO[i]);
    }
  }

  str += '=';

  if (String(value ?? '') === '') {
    // Symfony: empty value is rendered as a deletion cookie.
    str += `deleted; expires=${gmdateCookie(now - 31536001)}; Max-Age=0`;
  } else {
    str += raw ? String(value) : rawUrlEncode(String(value));

    if (expires !== 0) {
      const maxAge = Math.max(0, expires - now);
      str += `; expires=${gmdateCookie(expires)}; Max-Age=${maxAge}`;
    }
  }

  if (path) str += `; path=${path}`;
  if (domain) str += `; domain=${domain}`;
  if (secure) str += '; secure';
  if (httpOnly) str += '; httponly';
  if (sameSite !== null && sameSite !== undefined) str += `; samesite=${sameSite}`;
  if (partitioned) str += '; partitioned';

  return str;
}

/**
 * Parse a serialized Set-Cookie string back into a cookie object.
 * Max-Age is intentionally ignored: Symfony derives it from `expires` at
 * render time, so it is not part of the cookie state.
 */
export function parseSetCookie(header) {
  const parts = String(header).split(';');
  const first = parts.shift() ?? '';
  const eq = first.indexOf('=');
  if (eq === -1) throw new CookieError(`parseSetCookie: missing "=" in ${JSON.stringify(header)}`);

  const name = first.slice(0, eq).trim();
  const rawValue = first.slice(eq + 1).trim();
  // Parsed wire values must round-trip missing attributes as absent — the
  // Symfony constructor defaults (path=/, httpOnly=true) would add attributes
  // the server never sent.
  const cookie = makeCookie(name, rawValue === 'deleted' ? '' : rawUrlDecode(rawValue), 0, {
    path: null,
    httpOnly: false,
  });

  let expiresSeen = false;
  for (const attr of parts) {
    const trimmed = attr.trim();
    const idx = trimmed.indexOf('=');
    const key = (idx === -1 ? trimmed : trimmed.slice(0, idx)).trim().toLowerCase();
    const val = idx === -1 ? null : trimmed.slice(idx + 1).trim();
    if (key === 'expires' && val) {
      const ts = Math.floor(Date.parse(val) / 1000);
      if (Number.isNaN(ts)) throw new CookieError(`parseSetCookie: bad expires ${val}`);
      cookie.expires = ts;
      expiresSeen = true;
      // Symfony renders "deleted" only when the value is empty; keep value ''.
    } else if (key === 'max-age') {
      // Derived attribute; ignore. If this is a deletion cookie without
      // expires (Symfony always emits expires for deletions), keep ''.
    } else if (key === 'path') cookie.path = val;
    else if (key === 'domain') cookie.domain = val;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = val.toLowerCase();
    else if (key === 'partitioned') cookie.partitioned = true;
  }
  void expiresSeen;
  return cookie;
}

// ---------------------------------------------------------------------------
// Request cookie parsing (PHP SAPI semantics).
// ---------------------------------------------------------------------------
//
// PHP decodes %XX escapes in cookie values (no '+' to space) and supports
// bracket-style names ("a[b]=c") creating nested arrays. Duplicate names:
// later assignments overwrite earlier ones.

/**
 * PHP's `$arr[] = $v` index: the highest INTEGER key + 1, or 0 when the array
 * holds none. A numeric-looking key with a leading zero ("05") is a STRING key
 * in PHP and does not count.
 */
function nextBracketIndex(node) {
  let max = null;
  for (const key of Object.keys(node)) {
    if (!/^(?:0|-?[1-9]\d*)$/.test(key)) continue;
    const n = Number(key);
    if (max === null || n > max) max = n;
  }
  return max === null ? '0' : String(max + 1);
}

function assignBracketValue(target, name, value) {
  const m = /^([^\[]+)((?:\[[^\]]*\])*)$/.exec(name);
  if (!m) {
    ownSet(target, name, value);
    return;
  }
  const base = m[1];
  const indices = [];
  const re = /\[([^\]]*)\]/g;
  let match;
  while ((match = re.exec(m[2])) !== null) indices.push(match[1]);

  if (indices.length === 0) {
    ownSet(target, base, value);
    return;
  }
  // A cookie NAME is attacker-controlled (the raw Cookie header), so every
  // step is an own-property read/write: PHP's $_COOKIE has no prototype chain,
  // and `node['__proto__'] = {}` on a JS object would poison the prototype.
  if (!ownHas(target, base) || typeof ownGet(target, base) !== 'object' || ownGet(target, base) === null) {
    ownSet(target, base, {});
  }
  let node = ownGet(target, base);
  for (let i = 0; i < indices.length - 1; i++) {
    const key = indices[i] === '' ? nextBracketIndex(node) : indices[i];
    if (typeof ownGet(node, key) !== 'object' || ownGet(node, key) === null) ownSet(node, key, {});
    node = ownGet(node, key);
  }
  const last = indices[indices.length - 1];
  const finalKey = last === '' ? nextBracketIndex(node) : last;
  ownSet(node, finalKey, value);
}

/**
 * Parse a raw Cookie request header into a map of name -> decoded string
 * (or nested objects for bracket names). Values that appear multiple times
 * keep the last occurrence (PHP behaviour).
 */
export function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const pair of String(header).split(';')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = rawUrlDecode(trimmed.slice(0, eq).trim());
    const value = rawUrlDecode(trimmed.slice(eq + 1));
    assignBracketValue(out, name, value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CookieValuePrefix
// ---------------------------------------------------------------------------

const KEY_CACHE = new Map();

async function getHmacKey(keyBytes) {
  // The cache key is the WHOLE key: it used to be `length + first 8 bytes`, so
  // two app keys that agreed on their length and first eight bytes shared one
  // imported CryptoKey and a cookie signed under one key verified under the
  // other (an APP_KEY rotation is exactly the case those bytes differ in last).
  const cacheKey = bytesToHex(keyBytes);
  let key = KEY_CACHE.get(cacheKey);
  if (!key) {
    key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, [
      'sign',
    ]);
    KEY_CACHE.set(cacheKey, key);
  }
  return key;
}

function bytesToHex(bytes) {
  let h = '';
  for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, '0');
  return h;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** CookieValuePrefix::create($name, $key) — hex sha1 HMAC of "<name>v2" + "|". */
export async function cookieValuePrefix(name, keyBytes) {
  const hmac = await getHmacKey(keyBytes);
  const sig = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`${name}v2`));
  return bytesToHex(new Uint8Array(sig)) + '|';
}

/** CookieValuePrefix::remove($value) — strips the first 41 characters. */
export function cookieValuePrefixRemove(value) {
  return String(value).slice(41);
}

/**
 * CookieValuePrefix::validate($name, $value, $keys) — returns value without
 * prefix when one of the keys matches, otherwise null.
 */
export async function cookieValuePrefixValidate(name, value, keys) {
  const str = String(value);
  for (const key of keys) {
    const prefix = await cookieValuePrefix(name, key);
    if (str.startsWith(prefix)) return cookieValuePrefixRemove(str);
  }
  return null;
}

// ---------------------------------------------------------------------------
// EncryptCookies
// ---------------------------------------------------------------------------

/**
 * Create the EncryptCookies equivalent.
 *
 * @param {object} options
 * @param {string} options.keyBase64         APP_KEY (base64:... already stripped)
 * @param {string[]} [options.previousKeys]  base64 keys for rotation
 * @param {string[]} [options.except]        cookie names never encrypted
 */
export function createCookieEncryptor({ keyBase64, previousKeys = [], except = [] }) {
  if (!keyBase64) throw new CookieError('createCookieEncryptor: keyBase64 is required');
  const keyBytes = base64ToBytes(keyBase64);
  const allKeys = [keyBytes, ...previousKeys.map((k) => base64ToBytes(k))];
  const disabled = new Set(except);

  const isDisabled = (name) => disabled.has(name);

  async function decryptValue(name, value, currentKeyBytes) {
    if (value === null || value === undefined) return null;
    const plaintext = await decryptString(String(value), toB64(currentKeyBytes));
    return cookieValuePrefixValidate(name, plaintext, allKeys);
  }

  return {
    isDisabled,

    /**
     * Incoming request cookies: decrypt + validate prefix.
     * Returns a new map where failed cookies are null (EncryptCookies sets null).
     */
    async decryptRequestCookies(cookies) {
      const out = {};
      for (const [name, value] of Object.entries(cookies)) {
        if (isDisabled(name)) {
          out[name] = value;
          continue;
        }
        try {
          out[name] = await decryptValue(name, value, keyBytes);
        } catch (e) {
          // EncryptCookies::decrypt() swallows DecryptException only; a
          // configuration error (a bad APP_KEY) must not read as "cookie
          // absent" - it would silently log everyone out.
          if (!(e instanceof DecryptError)) throw e;
          out[name] = null;
        }
      }
      return out;
    },

    /** Outgoing Set-Cookie list: prefix + encrypt every non-disabled value. */
    async encryptResponseCookies(cookies) {
      const out = [];
      for (const cookie of cookies) {
        if (isDisabled(cookie.name)) {
          out.push(cookie);
          continue;
        }
        const prefix = await cookieValuePrefix(cookie.name, keyBytes);
        const value = await encryptString(prefix + (cookie.value ?? ''), keyBase64);
        out.push({ ...cookie, value });
      }
      return out;
    },
  };
}

function toB64(keyBytes) {
  let bin = '';
  for (let i = 0; i < keyBytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, keyBytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Response cookie bag (Symfony ResponseHeaderBag::setCookie ordering).
// ---------------------------------------------------------------------------

/**
 * Mirrors Symfony's ResponseHeaderBag cookie storage: cookies are keyed by
 * (domain, path, name); replacing an existing cookie keeps its original
 * position, matching PHP array semantics used by Symfony.
 */
export class ResponseCookies {
  #domains = new Map(); // domain -> Map(path -> Map(name -> cookie))

  set(cookie) {
    const domain = cookie.domain ?? null;
    const path = cookie.path ?? '/';
    let paths = this.#domains.get(domain);
    if (!paths) {
      paths = new Map();
      this.#domains.set(domain, paths);
    }
    let names = paths.get(path);
    if (!names) {
      names = new Map();
      paths.set(path, names);
    }
    names.set(cookie.name, cookie);
    return this;
  }

  has(name) {
    for (const paths of this.#domains.values()) {
      for (const names of paths.values()) {
        if (names.has(name)) return true;
      }
    }
    return false;
  }

  list() {
    const out = [];
    for (const paths of this.#domains.values()) {
      for (const names of paths.values()) {
        for (const cookie of names.values()) out.push(cookie);
      }
    }
    return out;
  }
}

export default {
  CookieError,
  rawUrlEncode,
  rawUrlDecode,
  gmdateCookie,
  makeCookie,
  serializeCookie,
  parseSetCookie,
  parseCookieHeader,
  cookieValuePrefix,
  cookieValuePrefixRemove,
  cookieValuePrefixValidate,
  createCookieEncryptor,
  ResponseCookies,
};
