// kernel/csrf.mjs — compiled-rung CSRF middleware.
//
// Byte-for-byte port of Illuminate\Foundation\Http\Middleware\PreventRequestForgery
// (laravel/framework 13.37) plus the Request/Str helpers it depends on:
//
//   handle()            pass order: isReading || runningUnitTests || inExceptArray
//                       || hasValidOrigin || tokensMatch
//   getTokenFromRequest _token input ?: X-CSRF-TOKEN header, else X-XSRF-TOKEN
//                       decrypted (unserialize=false) + CookieValuePrefix::remove
//   tokensMatch         is_string(session token) && is_string(token) && hash_equals
//   addCookieToResponse XSRF-TOKEN cookie, availableAt(60 * session.lifetime)
//   except()/useOriginOnly()/allowSameSite()/flushState()  static state
//   Str::is             preg_quote port (escape set probed against PHP 8.3)
//   Request::is/fullUrlIs/decodedPath/path/url/fullUrl/getQueryString
//   Symfony Request::normalizeQueryString (HeaderUtils::parseQuery + ksort +
//   http_build_query RFC3986)
//
// PHP oracle: tools/php-csrf-oracle.php. Tests: kernel/tests/csrf.test.mjs.
//
// Verified vendor facts (13.37):
//   - EncryptCookies::serialized($name) returns static::$serialize for every
//     cookie (no XSRF-TOKEN special case in this version); $serialize = false
//     by default and there is no setter → decrypt(..., false).
//   - PreventRequestForgery::serialized() delegates to EncryptCookies.
//   - newCookie() passes $config['secure'] directly (null allowed) and
//     $config['same_site'] ?? null / $config['partitioned'] ?? false.
//   - except() = array_values(array_unique(array_merge($neverVerify, Arr::wrap($uris))))
//     (array_unique default SORT_STRING comparison).
//
// Documented divergences (fail-loud where PHP behavior cannot be reproduced):
//   - normalizeQueryString supports flat parameters and single-level bracket
//     keys (base[idx] / base[]). Deeper/malformed brackets throw CsrfError;
//     PHP's parse_str orthography for those is not implemented.
//   - Percent-decoding is strict UTF-8: byte sequences PHP would keep raw
//     (invalid UTF-8, lone surrogates) throw instead of silently diverging.
//   - Non-BMP top-level query keys throw (PHP byte-order vs JS UTF-16 sort).
//   - strIs ignoreCase uses JS toLowerCase (contextual final sigma differs from
//     mb_strtolower); CSRF never passes ignoreCase.
//   - addCookieToResponse needs a response with a `.cookies` ResponseCookies
//     store; the worker pipeline attaches it (PHP uses $response->headers).
//   - runningUnitTests() is a constant false in the worker runtime.

import { makeCookie, cookieValuePrefixRemove, rawUrlEncode } from './cookies.mjs';
import { decryptString, timingSafeEqual } from './encrypter.mjs';
import { phpFalsy, phpIsNumeric } from './ratelimit.mjs';

/** Configuration/programming errors in the CSRF port (never swallowed). */
export class CsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsrfError';
  }
}

/** Illuminate\Session\TokenMismatchException. */
export class TokenMismatchError extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'TokenMismatchError';
  }
}

/** Illuminate\Http\Exceptions\OriginMismatchException. */
export class OriginMismatchError extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'OriginMismatchError';
  }
}

// ---------------------------------------------------------------------------
// PHP scalar helpers used by this port.
// ---------------------------------------------------------------------------

/** PHP (string) cast for the value shapes this port meets (scalars only). */
function phpStrCast(value) {
  if (value === null || value === undefined) return '';
  if (value === true) return '1';
  if (value === false) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  throw new CsrfError(
    'phpStrCast: unsupported non-scalar value (PHP would emit "Array to string conversion")'
  );
}

// ---------------------------------------------------------------------------
// Str::is / preg_quote.
// ---------------------------------------------------------------------------

// PHP 8.3 preg_quote() escape set (probed empirically, delimiter excluded):
//   ! # $ ( ) * + - . : < = > ? [ \ ] ^ { | }
// NUL is escaped as the four characters \000.
const PREG_QUOTE_CHARS = new Set([
  '!', '#', '$', '(', ')', '*', '+', '-', '.', ':',
  '<', '=', '>', '?', '[', '\\', ']', '^', '{', '|', '}',
]);

/** PHP preg_quote($pattern, $delimiter). */
export function pregQuote(pattern, delimiter = '#') {
  let out = '';
  for (const ch of String(pattern)) {
    if (ch === '\0') out += '\\000';
    else if (ch === delimiter || PREG_QUOTE_CHARS.has(ch)) out += '\\' + ch;
    else out += ch;
  }
  return out;
}

// JS regexes compiled with the 'u' flag reject identity escapes for every
// character that is not a JS syntax character, but preg_quote() prefixes
// each PCRE-special character with a backslash (\!, \#, \:, \=, \<, \>, \-)
// and renders NUL as the octal escape \000 (forbidden under 'u'). A quoted
// character is just that character, so convert the quoted pattern into
// 'u'-safe source: NUL → \x00, drop the backslashes JS does not accept,
// keep the ones it does.
const JS_KEEP_ESCAPE = new Set([
  '^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/',
]);

function jsRegexSource(quoted) {
  let out = '';
  for (let i = 0; i < quoted.length; i++) {
    const ch = quoted[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = quoted[i + 1];
    if (next === undefined) {
      // preg_quote() never leaves a trailing backslash; escape defensively.
      out += '\\\\';
      continue;
    }
    if (next === '0' && quoted.startsWith('000', i + 1)) {
      out += '\\x00';
      i += 3;
      continue;
    }
    if (JS_KEEP_ESCAPE.has(next)) {
      out += '\\' + next;
      i += 1;
      continue;
    }
    out += next;
    i += 1;
  }
  return out;
}

/**
 * Illuminate\Support\Str::is($pattern, $value, $ignoreCase = false).
 *
 *   if ($pattern === '*' || $pattern === $value) return true;
 *   if ($ignoreCase && mb_strtolower($pattern) === mb_strtolower($value)) return true;
 *   $pattern = preg_quote($pattern, '#');
 *   $pattern = str_replace('\*', '.*', $pattern);
 *   preg_match('#^'.$pattern.'\z#'.($ignoreCase ? 'isu' : 'su'), $value) === 1
 *
 * JS `$` (no m flag) matches only at end of input, equivalent to PCRE \z.
 */
export function strIs(pattern, value, ignoreCase = false) {
  const subject = phpStrCast(value);
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  for (const rawPattern of patterns) {
    const p = phpStrCast(rawPattern);
    if (p === '*' || p === subject) return true;
    if (ignoreCase && p.toLowerCase() === subject.toLowerCase()) return true;
    const regex = jsRegexSource(pregQuote(p, '#').replace(/\\\*/g, '.*'));
    let re;
    try {
      re = new RegExp('^' + regex + '$', ignoreCase ? 'isu' : 'su');
    } catch (e) {
      throw new CsrfError(`strIs: invalid pattern ${JSON.stringify(p)} (${e.message})`);
    }
    if (re.test(subject)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Percent decoding (PHP urldecode / rawurldecode, strict UTF-8).
// ---------------------------------------------------------------------------

const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function hexVal(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

/**
 * PHP percent-decoding on UTF-8 text. PHP returns raw bytes; this port decodes
 * to a JS string and fails loud on lone surrogates / invalid UTF-8 byte runs
 * (PHP would keep them as-is and diverge from any JS string representation).
 *
 * @param {string} input
 * @param {boolean} plusAsSpace  urldecode() semantics ('+' → ' ')
 */
export function percentDecodeUtf8(input, plusAsSpace = false) {
  let s = String(input);
  if (LONE_SURROGATE_RE.test(s)) {
    throw new CsrfError('percent-decode: input contains a lone surrogate');
  }
  if (plusAsSpace) s = s.replace(/\+/g, ' ');
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x25 /* % */ && i + 2 < s.length) {
      const h1 = hexVal(s[i + 1]);
      const h2 = hexVal(s[i + 2]);
      if (h1 >= 0 && h2 >= 0) {
        bytes.push((h1 << 4) | h2);
        i += 2;
        continue;
      }
      bytes.push(0x25);
      continue;
    }
    if (c < 0x80) {
      bytes.push(c);
      continue;
    }
    const cp = s.codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new CsrfError(
      'percent-decode: bytes are not valid UTF-8 (PHP would keep the raw bytes)'
    );
  }
}

/** PHP urldecode(): '+' → ' ', then %XX. */
export function phpUrldecode(input) {
  return percentDecodeUtf8(input, true);
}

// ---------------------------------------------------------------------------
// Symfony Request::normalizeQueryString (HeaderUtils::parseQuery + ksort +
// http_build_query with PHP_QUERY_RFC3986).
// ---------------------------------------------------------------------------

const PHP_INT_KEY_RE = /^(0|-?[1-9][0-9]*)$/;
const PHP_INT_MIN_BIG = -9223372036854775808n;
const PHP_INT_MAX_BIG = 9223372036854775807n;
const JS_SAFE_BIG = 9007199254740991n;

/** PHP array key casting: canonical decimal strings become int keys. */
function phpCastArrayKey(str) {
  if (PHP_INT_KEY_RE.test(str)) {
    const big = BigInt(str);
    if (big >= PHP_INT_MIN_BIG && big <= PHP_INT_MAX_BIG) {
      if (big > JS_SAFE_BIG || big < -JS_SAFE_BIG) {
        throw new CsrfError(
          `normalizeQueryString: integer key "${str}" exceeds the JS safe integer range`
        );
      }
      return { type: 'int', value: Number(big) };
    }
  }
  return { type: 'str', value: str };
}

function keyTag(key) {
  return key.type === 'int' ? 'i:' + key.value : 's:' + key.value;
}

/**
 * PHP ksort($arr, SORT_REGULAR) comparison (PHP 8 semantics):
 *   - int vs int, numeric-string vs numeric-string, int vs numeric-string:
 *     numeric comparison
 *   - otherwise: byte comparison (int renders as its decimal string)
 * JS string `<` compares UTF-16 code units; for BMP characters this equals
 * UTF-8 byte order, so non-BMP top-level keys fail loud before sorting.
 */
function sortRegularCompare(a, b) {
  const numeric = (key) => {
    if (key.type === 'int') return key.value;
    if (phpIsNumeric(key.value)) return Number(key.value);
    return null;
  };
  const an = numeric(a);
  const bn = numeric(b);
  if (an !== null && bn !== null) return an < bn ? -1 : an > bn ? 1 : 0;
  const as = a.type === 'int' ? String(a.value) : a.value;
  const bs = b.type === 'int' ? String(b.value) : b.value;
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/**
 * Symfony\Component\HttpFoundation\Request::normalizeQueryString($qs).
 *
 * Flat parameters and single-level bracket keys (base[idx] / base[]) are
 * supported with PHP parse_str semantics; anything deeper fails loud.
 */
export function normalizeQueryString(qs) {
  if (qs === null || qs === undefined || qs === '') return '';
  /** @type {Map<string, {kind: 'scalar'|'array', key: object, value?: string, entries?: Map, next?: number}>} */
  const top = new Map();

  for (let segment of String(qs).split('&')) {
    const segNul = segment.indexOf('\0');
    if (segNul !== -1) segment = segment.slice(0, segNul);
    if (segment === '') continue;

    const eq = segment.indexOf('=');
    let rawKey;
    let rawValue;
    if (eq === -1) {
      rawKey = segment;
      rawValue = '';
    } else {
      rawKey = segment.slice(0, eq);
      rawValue = segment.slice(eq + 1);
    }

    let key = phpUrldecode(rawKey);
    const keyNul = key.indexOf('\0');
    if (keyNul !== -1) key = key.slice(0, keyNul);
    key = key.replace(/^ +/, '');
    if (key === '') continue;

    const bracketAt = key.indexOf('[');
    if (bracketAt === -1) {
      const info = phpCastArrayKey(key);
      top.set(keyTag(info), { kind: 'scalar', key: info, value: phpUrldecode(rawValue) });
      continue;
    }

    const base = key.slice(0, bracketAt);
    if (base === '') continue; // parse_str drops keys starting with '[' ('[]=1', '[x]=1' → '')
    const rest = key.slice(bracketAt);
    const m = /^\[([^\[\]]*)\]$/.exec(rest);
    if (!m) {
      throw new CsrfError(
        `normalizeQueryString: unsupported bracket key ${JSON.stringify(key)} ` +
          '(only single-level "base[idx]" / "base[]" keys are supported)'
      );
    }
    const info = phpCastArrayKey(base);
    const tag = keyTag(info);
    let node = top.get(tag);
    if (!node || node.kind !== 'array') {
      node = { kind: 'array', key: info, entries: new Map(), next: 0 };
      top.set(tag, node);
    }
    const value = phpUrldecode(rawValue);
    const idx = m[1];
    if (idx === '') {
      const innerKey = { type: 'int', value: node.next };
      node.entries.set(keyTag(innerKey), { key: innerKey, value });
      node.next += 1;
    } else {
      const innerKey = phpCastArrayKey(idx);
      node.entries.set(keyTag(innerKey), { key: innerKey, value });
      if (innerKey.type === 'int' && innerKey.value >= node.next) node.next = innerKey.value + 1;
    }
  }

  const nodes = [...top.values()];
  for (const node of nodes) {
    if (node.key.type === 'str' && /[\uD800-\uDFFF]/.test(node.key.value)) {
      throw new CsrfError(
        'normalizeQueryString: non-BMP top-level key ' +
          `(${JSON.stringify(node.key.value)}) — PHP byte order differs from JS UTF-16 order`
      );
    }
  }
  nodes.sort((a, b) => sortRegularCompare(a.key, b.key));

  const parts = [];
  for (const node of nodes) {
    const keyLabel = node.key.type === 'int' ? String(node.key.value) : node.key.value;
    if (node.kind === 'scalar') {
      parts.push(rawUrlEncode(keyLabel) + '=' + rawUrlEncode(node.value));
    } else {
      for (const entry of node.entries.values()) {
        const innerLabel =
          entry.key.type === 'int' ? String(entry.key.value) : entry.key.value;
        parts.push(
          rawUrlEncode(keyLabel + '[' + innerLabel + ']') + '=' + rawUrlEncode(entry.value)
        );
      }
    }
  }
  return parts.join('&');
}

// ---------------------------------------------------------------------------
// Request path/url helpers (Illuminate\Http\Request).
// ---------------------------------------------------------------------------

/** Request::path() — trim(pathInfo, '/'), '' → '/'. */
export function requestPath(pathInfo) {
  const trimmed = String(pathInfo ?? '').replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Request::decodedPath() — rawurldecode(path()). */
export function requestDecodedPath(pathInfo) {
  return percentDecodeUtf8(requestPath(pathInfo), false);
}

/** Request::url() — strips the query string, then rtrims trailing slashes. */
export function requestUrl(uri) {
  return String(uri).replace(/\?[^\n]*/g, '').replace(/\/+$/, '');
}

/**
 * Request::fullUrl():
 *   $query = getQueryString();            // normalizeQueryString(QUERY_STRING); '' → null
 *   $question = getBaseUrl().getPathInfo() === '/' ? '/?' : '?';
 *   $query ? url().$question.$query : url()
 */
export function requestFullUrl(uri, pathInfo, rawQueryString, baseUrl = '') {
  const query = normalizeQueryString(rawQueryString);
  const question = baseUrl + pathInfo === '/' ? '/?' : '?';
  const url = requestUrl(uri);
  return query ? url + question + query : url;
}

/**
 * Request::is(...$patterns) — Str::is per pattern against decodedPath().
 * `patterns` may be a single value or an array (an array element inside the
 * list is treated as an iterable pattern list by strIs, like PHP).
 */
export function requestIs(request, patterns) {
  const path = request.decodedPath();
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.some((p) => strIs(p, path));
}

/** Request::fullUrlIs(...$patterns). */
export function requestFullUrlIs(request, patterns) {
  const url = request.fullUrl();
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.some((p) => strIs(p, url));
}

// ---------------------------------------------------------------------------
// PreventRequestForgery.
// ---------------------------------------------------------------------------

/**
 * Request contract used by the middleware (mirrors Illuminate\Http\Request):
 *   method(): string
 *   input(key): mixed                     // '_token' form/query input
 *   header(name): string|null             // case-insensitive
 *   session(): { token(): string|null }   // Illuminate\Session\Store
 *   decodedPath(): string
 *   fullUrl(): string
 *   is(...patterns): boolean
 *   fullUrlIs(...patterns): boolean
 */
export class PreventRequestForgery {
  /** @type {string[]} */
  static neverVerify = [];
  static allowSameSite = false;
  static originOnly = false;

  /**
   * static except($uris) — array_values(array_unique(array_merge(
   *     $neverVerify, Arr::wrap($uris)))) with SORT_STRING comparison.
   */
  static except(uris) {
    const wrap = Array.isArray(uris) ? uris : uris === null || uris === undefined ? [] : [uris];
    const merged = [...PreventRequestForgery.neverVerify, ...wrap];
    const seen = new Set();
    const out = [];
    for (const uri of merged) {
      const s = phpStrCast(uri);
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(uri);
    }
    PreventRequestForgery.neverVerify = out;
  }

  /** static allowSameSite($allow = true) — renamed: static props can't share. */
  static setAllowSameSite(allow = true) {
    PreventRequestForgery.allowSameSite = allow;
  }

  /** static useOriginOnly($originOnly = true). */
  static useOriginOnly(originOnly = true) {
    PreventRequestForgery.originOnly = originOnly;
  }

  /** static serialized() — EncryptCookies::serialized('XSRF-TOKEN'). */
  static serialized() {
    return false;
  }

  /** static flushState(). */
  static flushState() {
    PreventRequestForgery.neverVerify = [];
    PreventRequestForgery.allowSameSite = false;
    PreventRequestForgery.originOnly = false;
  }

  /**
   * @param {object} [options]
   * @param {string[]} [options.except]        instance-level except list
   * @param {object}   [options.sessionConfig] config('session') snapshot
   * @param {string}   [options.keyBase64]     APP_KEY (base64) for X-XSRF decrypt
   * @param {(payload: string) => Promise<string>} [options.decrypt] custom decrypt
   * @param {() => number} [options.clock]     epoch seconds (fractional ok)
   * @param {boolean}  [options.addHttpCookie]
   */
  constructor(options = {}) {
    this.except = options.except ?? [];
    this.sessionConfig = options.sessionConfig ?? null;
    this.keyBase64 = options.keyBase64 ?? null;
    this.decryptFn = typeof options.decrypt === 'function' ? options.decrypt : null;
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now() / 1000;
    this.addHttpCookie = options.addHttpCookie ?? true;
  }

  /**
   * handle($request, Closure $next):
   *   isReading || runningUnitTests || inExceptArray || hasValidOrigin || tokensMatch
   *   → tap($next($request), add XSRF cookie when shouldAddXsrfTokenCookie())
   *   else throw TokenMismatchException('CSRF token mismatch.')
   */
  async handle(request, next) {
    if (
      this.isReading(request) ||
      this.runningUnitTests() ||
      this.inExceptArray(request) ||
      this.hasValidOrigin(request) ||
      (await this.tokensMatch(request))
    ) {
      const response = await next(request);
      if (this.shouldAddXsrfTokenCookie()) {
        await this.addCookieToResponse(request, response);
      }
      return response;
    }
    throw new TokenMismatchError('CSRF token mismatch.');
  }

  isReading(request) {
    return ['HEAD', 'GET', 'OPTIONS'].includes(request.method());
  }

  runningUnitTests() {
    // $this->app->runningInConsole() && $this->app->runningUnitTests() — never
    // true in the worker runtime. The oracle boots in CLI but does not flag
    // unit tests, so both sides observe false.
    return false;
  }

  inExceptArray(request) {
    for (const rawExcept of this.getExcludedPaths()) {
      let except = rawExcept;
      if (except !== '/') except = phpStrCast(except).replace(/^\/+|\/+$/g, '');
      if (request.fullUrlIs(except) || request.is(except)) return true;
    }
    return false;
  }

  hasValidOrigin(request) {
    const secFetchSite = request.header('Sec-Fetch-Site');
    if (secFetchSite === 'same-origin') return true;
    if (secFetchSite === 'same-site' && PreventRequestForgery.allowSameSite) return true;
    if (PreventRequestForgery.originOnly) throw new OriginMismatchError('Origin mismatch.');
    return false;
  }

  async tokensMatch(request) {
    const token = await this.getTokenFromRequest(request);
    const sessionToken = request.session().token();
    return (
      typeof sessionToken === 'string' &&
      typeof token === 'string' &&
      timingSafeEqual(sessionToken, token)
    );
  }

  async getTokenFromRequest(request) {
    let token = request.input('_token');
    if (phpFalsy(token)) token = request.header('X-CSRF-TOKEN');

    let header;
    if (phpFalsy(token) && (header = request.header('X-XSRF-TOKEN')) && !phpFalsy(header)) {
      try {
        token = cookieValuePrefixRemove(await this.#decryptPayload(header));
      } catch (e) {
        // PHP catches DecryptException only; configuration errors must not be
        // swallowed into a silent ''.
        if (e instanceof CsrfError) throw e;
        token = '';
      }
    }

    return token;
  }

  shouldAddXsrfTokenCookie() {
    if (PreventRequestForgery.originOnly) return false;
    return this.addHttpCookie;
  }

  async addCookieToResponse(request, response) {
    const config = this.sessionConfig;
    if (response && typeof response.toResponse === 'function') {
      // $response instanceof Responsable
      response = await response.toResponse(request);
    }
    const cookies = response && response.cookies;
    if (!cookies || typeof cookies.set !== 'function') {
      throw new CsrfError(
        'PreventRequestForgery: response has no cookie store ' +
          '(the worker pipeline must attach ResponseCookies)'
      );
    }
    cookies.set(this.newCookie(request, config));
    return response;
  }

  /** newCookie($request, $config) — Symfony Cookie with availableAt(60*lifetime). */
  newCookie(request, config) {
    if (!config || typeof config !== 'object') {
      throw new CsrfError('PreventRequestForgery: session config missing (config("session"))');
    }
    return makeCookie(
      'XSRF-TOKEN',
      request.session().token(),
      this.availableAt(60 * config.lifetime),
      {
        path: phpFalsy(config.path) ? '/' : config.path,
        domain: config.domain ?? null,
        secure: config.secure ?? false,
        httpOnly: false,
        raw: false,
        sameSite: config.same_site ?? null,
        partitioned: config.partitioned ?? false,
      }
    );
  }

  /** InteractsWithTime::availableAt($delay) — floor(now + delay). */
  availableAt(delay) {
    return Math.floor(this.clock() + delay);
  }

  getExcludedPaths() {
    return [...this.except, ...PreventRequestForgery.neverVerify];
  }

  async #decryptPayload(payload) {
    if (this.decryptFn) return this.decryptFn(payload);
    if (!this.keyBase64) {
      throw new CsrfError(
        'PreventRequestForgery: keyBase64 (or a decrypt function) is required ' +
          'to decrypt X-XSRF-TOKEN'
      );
    }
    return decryptString(payload, this.keyBase64);
  }
}

export default {
  CsrfError,
  TokenMismatchError,
  OriginMismatchError,
  pregQuote,
  strIs,
  percentDecodeUtf8,
  phpUrldecode,
  normalizeQueryString,
  requestPath,
  requestDecodedPath,
  requestUrl,
  requestFullUrl,
  requestIs,
  requestFullUrlIs,
  PreventRequestForgery,
};
