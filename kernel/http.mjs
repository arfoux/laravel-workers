// kernel/http.mjs — compiled HTTP kernel: Laravel-shaped Request + the `web` pipeline.
//
// Mirrors the parts of Illuminate's HTTP kernel / `web` middleware group that the
// compiled rung supports, in vendor order:
//
//   EncryptCookies
//   AddQueuedCookiesToResponse        (response phase)
//   StartSession
//   ShareErrorsFromSession            (view share — handled by the view layer)
//   PreventRequestForgery             (ValidateCsrfToken)
//   SubstituteBindings                (router dispatch)
//   route middleware: auth / guest / throttle
//   action
//
// Response-side unwinding is preserved: [XSRF-TOKEN][session cookie][queued cookies]
// then EncryptCookies encrypts every value in place.
//
// Anything the rung cannot honour fails loud (HttpError / thrown error) — never a
// silently-degraded response.
//
// Config is a FLAT dotted map (`config.generated.mjs`), the same shape the compiled
// AuthManager consumes (`auth.defaults.guard`, `session.driver`, ...).

import { match, dispatch, routeKey, allowedMethods } from './router.mjs';
import { imageInfo } from './image.mjs';
import { ownSet, ownGet, ownHas, assignOwn, copyOwn } from './own-key.mjs';
// The PHP variable-registration bag + `parse_str()` subset live in php-bag.mjs
// (the multipart parser registers its field names through the same code).
import { parsePhpQuery } from './php-bag.mjs';
// http.mjs's public surface keeps `parsePhpQuery` (kernel/tests/http.test.mjs and
// the default export below both read it from here).
export { parsePhpQuery };
import {
  makeCookie,
  parseCookieHeader,
  serializeCookie,
  createCookieEncryptor,
  ResponseCookies,
} from './cookies.mjs';
import {
  PhpSessionStore,
  CookieSessionHandler,
  DatabaseSessionHandler,
  CookieJar,
  phpRandomString,
} from './session.mjs';
import {
  PreventRequestForgery,
  TokenMismatchError,
  normalizeQueryString,
  requestIs,
  requestFullUrlIs,
  requestPath,
  requestDecodedPath,
  requestUrl,
  requestFullUrl,
} from './csrf.mjs';
import {
  RateLimiter,
  ThrottleRequests,
  ThrottleRequestsError,
  HttpResponseError,
  phpIntCast,
} from './ratelimit.mjs';
import {
  Authenticate,
  RedirectIfAuthenticated,
  AuthenticationException,
  BcryptHasher,
  createAuthManager,
  requestExpectsJson,
  requestAjax,
  requestPjax,
  requestWantsJson,
  acceptsAnyContentType,
  applyAuthenticatable,
} from './auth.mjs';
import {
  phpJsonDecode,
  phpJsonEncode,
  phpJsonEncodeWithFlags,
  JSON_PRETTY_PRINT,
  JSON_UNESCAPED_SLASHES,
} from './php-json.mjs';
import { strIs } from './csrf.mjs';
import { parseMultipart } from './multipart.mjs';
import {
  ValidationException,
  installValidation,
  sessionErrorBag,
  DEFAULT_DONT_FLASH,
} from './validation.mjs';
// Illuminate\Support\Str::trim() (Str.php:1717-1726): the DEFAULT character
// set is " \n\r\t\x0B\0" (not JavaScript's WhiteSpace+LineTerminator, which
// also strips \f and U+00A0) and the invisible characters (INVISIBLE_CHARACTERS,
// Str.php:33) are trimmed too; the fallback when the Unicode pass fails is
// a plain trim() over that same default set.
const STR_TRIM_DEFAULT = ' \n\r\t\u000B\u0000';
const STR_TRIM_INVISIBLE = new Set([
  ...[0x0009, 0x0020, 0x00a0, 0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x2000,
    0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x200b, 0x200c,
    0x200d, 0x200e, 0x200f, 0x202f, 0x205f, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2065, 0x206a,
    0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0x3000, 0x2800, 0x3164, 0xfeff, 0xffa0, 0x1d159,
    0x1d173, 0x1d174, 0x1d175, 0x1d176, 0x1d177, 0x1d178, 0x1d179, 0x1d17a, 0xe0020],
].map((c) => String.fromCodePoint(c)));
const isStrTrimSpace = (ch) => {
  if (STR_TRIM_DEFAULT.includes(ch)) return true;
  // `\s` in the source regex (PCRE without /u beyond the explicit list below).
  if (/\s/.test(ch)) return true;
  return STR_TRIM_INVISIBLE.has(ch);
};
/** Illuminate\Support\Str::trim($value) — no charlist argument. */
export function phpTrim(value) {
  const chars = String(value).split('');
  let i = 0;
  let j = chars.length;
  while (i < j && isStrTrimSpace(chars[i])) i += 1;
  while (j > i && isStrTrimSpace(chars[j - 1])) j -= 1;
  // A lone surrogate cannot survive a UTF-8 round trip on the edge.
  return chars
    .slice(i, j)
    .join('')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

export class HttpError extends Error {
  constructor(message, status = 500, headers = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    // Optional response headers (e.g. the 401 `WWW-Authenticate` challenge of
    // Symfony's UnauthorizedHttpException).
    if (headers && typeof headers === 'object') this.headers = headers;
  }
}

// ---------------------------------------------------------------------------
// scalar helpers (Vue-free, dependency-free)
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function resolveDefault(def) {
  return typeof def === 'function' ? def() : def;
}

// ---------------------------------------------------------------------------
// Illuminate\Support\Traits\InteractsWithData — `$request->filled()`,
// `->boolean()`, `->only()`, ... The accessors are allow-listed by the
// transpiler (REQUEST_CALL), so the kernel has to implement the same set or
// compiled controllers would blow up at the edge.
// ---------------------------------------------------------------------------

/** Arr::has / data_get miss sentinel (distinct from a stored `null`). */
const ARR_MISSING = Symbol('arr-missing');

/** `is_array($keys) ? $keys : func_get_args()` for a rest-arg list. */
function phpKeyList(args) {
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
}

/** filter_var($v, FILTER_VALIDATE_BOOLEAN) — true for 1/true/on/yes. */
function phpFilterVarBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'object') return false; // arrays/objects never coerce
  const s = String(value).toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

const PHP_FLOAT_PREFIX_RE = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;

/** (float) cast — numeric string prefix, 0.0 otherwise. A value PHP holds as
 *  INF stays INF (`(float) '1e400'` is INF on 8.3.30; `(int)` is the cast that
 *  answers 0) — an INF reaching the JSON rung throws there, exactly like
 *  `json_encode` (#821). */
function phpFloatCast(value) {
  if (value === null || value === undefined || value === false) return 0;
  if (value === true) return 1;
  if (typeof value === 'number') return value;
  const m = PHP_FLOAT_PREFIX_RE.exec(String(value));
  return m ? parseFloat(m[0]) : 0;
}

/** Arr::set($target, $key, $value) subset (dot notation); `forget` deletes. */
function arrSetRef(target, key, value, forget) {
  const segments = String(key).split('.');
  let current = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    // Own-property walk: a key the client sent (`__proto__`, `constructor`) is
    // DATA to PHP, never a step into the prototype chain.
    if (!isPlainObject(ownGet(current, seg))) ownSet(current, seg, {});
    current = ownGet(current, seg);
  }
  const last = segments[segments.length - 1];
  if (forget) delete current[last];
  else ownSet(current, last, value);
  return target;
}


/** Arr::get() / data_get() subset: exact key first, then dot segments. */
export function dataGet(target, key, def = null) {
  if (key === null || key === undefined) return target;
  const k = String(key);
  if (isPlainObject(target) && Object.prototype.hasOwnProperty.call(target, k)) return target[k];
  const segments = k.split('.');
  let current = target;
  for (const seg of segments) {
    if (isPlainObject(current) && Object.prototype.hasOwnProperty.call(current, seg)) {
      current = current[seg];
    } else if (Array.isArray(current) && /^\d+$/.test(seg) && Number(seg) < current.length) {
      current = current[Number(seg)];
    } else {
      return resolveDefault(def);
    }
  }
  return current === undefined ? resolveDefault(def) : current;
}

/**
 * `data_get()` over the REQUEST's own arrays (the uploaded-file tree, the input
 * union): PHP's arrays are all one type, so a dotted key descends into the list
 * a `name[]`/`name[0]` field built exactly like into a map - `k.0` and `post`
 * both work. `dataGet()` above owns the general rung (a JS array only takes a
 * numeric in-range segment), so the PHP-array walk lives here.
 */
function dataGetPhpArray(target, key) {
  const k = String(key == null ? '' : key);
  if (ownHas(target, k)) return ownGet(target, k);
  let current = target;
  for (const seg of k.split('.')) {
    if (!ownHas(current, seg)) return ARR_MISSING;
    current = ownGet(current, seg);
  }
  return current === undefined ? ARR_MISSING : current;
}

/** A PHP array as JS holds it: a JS list, or the plain-object MAP of a name. */
function isPhpArray(v) {
  return Array.isArray(v) || isPlainObject(v);
}

/**
 * `array_replace_recursive()` (Arr.php): every key of a later source replaces the
 * matching one, recursing when BOTH sides are PHP arrays. A replaced key keeps
 * the FIRST source's position, and a key only a later source has is appended -
 * that is the order `Request::all()` answers in (probed: the input's `post`
 * comes first with its `title`, and the file's `image` follows inside it).
 */
function arrayReplaceRecursive(...sources) {
  const out = {};
  for (const src of sources) {
    if (src === null || src === undefined) continue;
    for (const key of Object.keys(src)) {
      const value = src[key];
      if (ownHas(out, key) && isPhpArray(ownGet(out, key)) && isPhpArray(value)) {
        ownSet(out, key, arrayReplaceRecursive(ownGet(out, key), value));
      } else {
        ownSet(out, key, value);
      }
    }
  }
  return out;
}

function headerBag(raw) {
  const map = new Map();
  for (const [k, v] of Object.entries(raw || {})) {
    if (v === undefined) continue;
    map.set(String(k).toLowerCase(), v === null ? null : String(v));
  }
  return {
    get(name, def = null) {
      const v = map.get(String(name).toLowerCase());
      return v === undefined || v === null ? def : v;
    },
    has(name) {
      const v = map.get(String(name).toLowerCase());
      return v !== undefined && v !== null;
    },
    all() {
      return Object.fromEntries(map);
    },
  };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

// Symfony's MimeTypes map (the FIRST extension per mime type) - the extension
// the edge can know: the type the browser declared. Laravel sniffs the
// *content* (finfo); the edge cannot, so `store()`'s name is a documented
// divergence (its name is random anyway).
const MIME_EXTENSIONS = {
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
  'text/xml': 'xml',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/octet-stream': 'bin',
};

// Illuminate\Http\UploadedFile: the metadata + the bytes + the store.
// The file object is what the compiled controller sees (`$request->file('x')`):
//   - getClientOriginalName(): the basename (Symfony's File::getName()),
//   - getClientOriginalExtension(): pathinfo(originalName, EXTENSION),
//   - getClientMimeType(): the type the browser declared,
//   - getSize(): the size in bytes,
//   - isValid(): true (the edge received the whole part),
//   - store()/storeAs(): the object store (the app's default disk).
function makeUploadedFile(desc, storage, defaultDisk, randomString) {
  const filename = String(desc.filename == null ? '' : desc.filename);
  // Symfony's File::getName(): the name after the last '/' (the backslashes
  // are separators too).
  const slashed = filename.replace(/\\/g, '/');
  const slash = slashed.lastIndexOf('/');
  const originalName = slash === -1 ? slashed : slashed.slice(slash + 1);
  // pathinfo($originalName, PATHINFO_EXTENSION): the part after the last dot
  // ('.bashrc' -> 'bashrc', 'a.' -> '', 'noext' -> '').
  const dot = originalName.lastIndexOf('.');
  const extension = dot >= 0 ? originalName.slice(dot + 1) : '';
  const bytes = desc.bytes;
  const file = {
    __uploadedFile: true,
    name: desc.name,
    filename: originalName,
    mime: desc.mime,
    size: desc.size,
    bytes,
    extension,
    getClientOriginalName() { return this.filename; },
    getClientOriginalExtension() { return this.extension; },
    getClientMimeType() { return this.mime; },
    getSize() { return this.size; },
    isValid() { return true; },
    // Illuminate\Http\File::dimensions() (:60-79): `@getimagesize($path)`,
    // which is a HEADER read - so the edge answers the same [width, height],
    // and `false` for bytes getimagesize() would reject. No decoding.
    dimensions() {
      const info = imageInfo(this.bytes);
      return info === null || info.width === null || info.height === null
        ? false
        : [info.width, info.height];
    },
    // Illuminate\Http\UploadedFile::get(): the contents of the file. PHP
    // returns a byte string; the edge returns the bytes (a string would
    // re-encode them, so the compiled surface does not expose this method).
    get() { return this.bytes; },
    // Illuminate\Http\UploadedFile::store(): the name is a random hash (the
    // same 40 characters as Str::random) + the extension.
    async store(path = '', options = {}) {
      const hash = randomString(40);
      const ext = MIME_EXTENSIONS[String(this.mime).toLowerCase()];
      const name = ext ? hash + '.' + ext : hash;
      return this.storeAs(path, name, options);
    },
    // Illuminate\Http\UploadedFile::storeAs(): the path on the disk (the
    // default disk) and the name it is stored under.
    async storeAs(path, name = null, options = {}) {
      // `storeAs('avatars')` (no name) swaps the arguments: the name is the
      // first argument, the path is empty and the options are the (array)
      // second argument.
      let p = path;
      let n = name;
      let o = options;
      if (n === null || n === undefined || Array.isArray(n)) {
        p = '';
        o = n === null || n === undefined ? {} : n;
        n = path;
      }
      // parseOptions(): a string is the disk name.
      const opts = typeof o === 'string' ? { disk: o } : (o || {});
      const disk = opts.disk || null;
      if (disk && disk !== defaultDisk) {
        throw new Error(
          'the uploaded file cannot be stored on the disk "' + disk + '": the compiled side has one ' +
            'object store (the app\'s default disk "' + (defaultDisk || 'local') + '"); a named disk needs ' +
            'a bucket of its own (R2 asks for a credit card)'
        );
      }
      if (!storage) {
        throw new Error(
          'the uploaded file cannot be stored: the compiled side has no object store - bind R2 (env.R2) ' +
            'or D1 (env.DB)'
        );
      }
      // FilesystemAdapter::putFileAs(): the path is trim($path.'/'.$name, '/').
      const key = String(p).replace(/\/+$/, '') + '/' + String(n);
      const trimmed = key.replace(/^\/+/, '').replace(/\/+$/, '');
      const written = await storage.put(trimmed, this.bytes);
      // The write failed -> false (Laravel's FilesystemAdapter::putFileAs).
      return written ? trimmed : false;
    },
  };
  // The file's data is not enumerable: PHP's UploadedFile has no public
  // properties, so json_encode($request->all()) gives {"avatar":{}}.
  for (const key of ['name', 'filename', 'mime', 'size', 'bytes', 'extension', '__uploadedFile']) {
    Object.defineProperty(file, key, { value: file[key], enumerable: false, writable: true });
  }
  return file;
}

export function buildRequest(raw, options = {}) {
  const rawMethod = String((raw && raw.method) || 'GET').toUpperCase();
  const urlString = String((raw && raw.url) || '');
  // The object store (the app's default disk) + the random source: the file
  // object needs them to store the upload.
  const storage = options.storage || null;
  const defaultDisk = options.defaultDisk || null;
  const randomString = options.randomString || ((n) => phpRandomString(n));
  let parsed = null;
  try {
    parsed = new URL(urlString);
  } catch {
    parsed = null;
  }
  const headers = headerBag((raw && raw.headers) || {});
  const cookiesRaw = parseCookieHeader(headers.get('cookie') || '');

  const pathInfo = parsed ? parsed.pathname || '/' : '/';
  const rawQuery = parsed ? parsed.search.replace(/^\?/, '') : '';
  const uri = parsed ? parsed.href : 'http://localhost' + pathInfo;
  const hostHeader = headers.get('host') || (parsed ? parsed.host : null);
  const scheme = parsed ? parsed.protocol.replace(':', '') : 'http';

  const query = parsePhpQuery(rawQuery);

  // The body: a string (the text bodies) or the raw bytes (a multipart upload).
  const rawBody = raw && raw.body != null ? raw.body : '';
  const bodyBytes =
    rawBody instanceof Uint8Array
      ? rawBody
      : rawBody instanceof ArrayBuffer
        ? new Uint8Array(rawBody)
        : null;
  const body = bodyBytes ? '' : String(rawBody);
  // The raw content type: the multipart *boundary* is case-sensitive (RFC).
  const rawContentType = headers.get('content-type') || '';
  const contentType = rawContentType.toLowerCase();
  const contentTypeFormat = contentType.split(';')[0].trim();
  const isJson = contentTypeFormat === 'application/json' || contentTypeFormat.endsWith('+json');
  let post = {};
  let json = null;
  let files = {};
  if ((body !== '' || bodyBytes) && rawMethod !== 'GET' && rawMethod !== 'HEAD') {
    if (isJson) {
      try {
        const decoded = phpJsonDecode(body);
        json = decoded;
        if (isPlainObject(decoded)) post = decoded;
      } catch (e) {
        // LW006 (an integer the edge cannot hold exactly) is loud: never
        // swallow it into a silent `null` body.
        if (e && e.code === 'LW006') throw e;
        json = null;
      }
    } else if (contentTypeFormat === '' || contentTypeFormat === 'application/x-www-form-urlencoded') {
      post = parsePhpQuery(body);
    } else if (contentTypeFormat === 'multipart/form-data') {
      // The uploaded files + the form fields.
      const parsed = parseMultipart(bodyBytes, rawContentType);
      post = parsed.fields;
      files = parsed.files;
    } else {
      throw new HttpError(`unsupported request content-type: ${contentTypeFormat}`, 500);
    }
  }

  // Symfony's getMethod() (http-foundation 7.4, Request.php:1263-1300):
  //   `$method = $this->headers->get('X-HTTP-METHOD-OVERRIDE');`
  //   `if (!$method && $httpMethodParameterOverride)`
  //     `$method = $this->request->get('_method', $this->query->get('_method','POST'));`
  // `$this->request` is the FORM bag - it is filled for a urlencoded or
  // multipart body ONLY - so `_method` in a JSON body is NOT an override
  // (probed on a live PHP 8.3 server: JSON `{"_method":"PUT"}` -> method() =
  // POST; the kernel read the JSON body and answered PUT, so a DIFFERENT route
  // was selected). The form bag beats the query (probed: form PUT + `?_method=
  // PATCH` -> PUT). A non-scalar `_method` (`_method[]=PUT`) makes Symfony's
  // InputBag::get() throw BadRequestException('Input value "_method" contains a
  // non-scalar value.') - a 500 Laravel does not map - and the header uses PHP's
  // `!$method`, so a '0' falls through to the parameter (probed). The override
  // must be A-Z after upper-casing - anything else is a SuspiciousOperationException
  // ('Invalid HTTP method override.'), also a 500.
  let methodOverride = null;
  if (rawMethod === 'POST') {
    // InputBag::get() throws BadRequestException for a non-scalar value, and
    // Symfony evaluates BOTH bags (`$this->request->get('_method',
    // $this->query->get('_method', 'POST'))`) - the query default is built
    // eagerly, so an array in EITHER one is a 500 (probed: `_method=PUT` in the
    // form plus `?_method[]=PUT` throws 'Input value "_method" contains a
    // non-scalar value.').
    const methodParam = (bag) => {
      if (bag == null || !ownHas(bag, '_method')) return null;
      const value = ownGet(bag, '_method');
      if (value !== null && typeof value === 'object') {
        const err = new Error('Input value "_method" contains a non-scalar value.');
        err.name = 'BadRequestException';
        err.phpClass = 'BadRequestException';
        throw err;
      }
      return value;
    };
    const queryParam = methodParam(query);
    const formParam = isJson ? null : methodParam(post);
    const headerOverride = headers.get('x-http-method-override');
    const candidate = formParam ?? queryParam ?? 'POST';
    // PHP falsiness: '' and '0' are falsy, so the header falls through.
    const headerUsable = headerOverride != null && headerOverride !== '' && headerOverride !== '0';
    const chosen = headerUsable ? headerOverride : candidate;
    if (typeof chosen === 'string' && chosen !== '') {
      const up = chosen.toUpperCase();
      if (up.length !== up.replace(/[^A-Z]/g, '').length) {
        throw new HttpError('Invalid HTTP method override.', 500);
      }
      // `$this->method = 'POST'` and the real method are the same, so the
      // kernel's own accessor stays null for a plain POST (it is read by the
      // compiled request snapshot).
      methodOverride = up === 'POST' ? null : up;
    }
  }
  const method = methodOverride || rawMethod;

  // Request cookies as parsed off the wire. EncryptCookies replaces this with the
  // decrypted map before StartSession reads the session id, so this must start as
  // the *raw* set (Symfony fills $request->cookies from the Cookie header too).
  let cookies = cookiesRaw;
  let session = null;
  let route = null;
  let routeParams = {};
  let userResolver = null;
  let ip = options.clientIp
    || headers.get('cf-connecting-ip')
    || String(headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || '127.0.0.1';

  // Laravel's GLOBAL middleware runs before the router and rewrites the input
  // bags in place: TrimStrings then ConvertEmptyStringsToNull
  // (Foundation\Configuration\Middleware::getGlobalMiddleware()). The compiled
  // rung applies the same two passes to the very bags Request reads, so
  // `$request->input()`/`validated()`/`_old_input` see the transformed values.
  //   TransformsRequest::clean(): `$request->query` ALWAYS, then `$request->json`
  //   when the body is JSON, else the `$request->request` bag (the body).
  // TrimStrings::transform(): `Str::is($except, $key)` skips a key and a
  // non-string value is left alone (TrimStrings.php:61-70); then
  // ConvertEmptyStringsToNull maps a lone '' to null (:41-44).
  const transformers = options.transformers || {};
  const trimOn = transformers.trim !== false;
  const emptyToNullOn = transformers.emptyToNull !== false;
  if (trimOn || emptyToNullOn) {
    const except = (transformers.trimExcept || []).map(String);
    // TrimStrings::transform(): the key is checked against the list
    // (`Str::is`, so `password` also covers `password.confirm`) and a
    // non-string value is left alone - nothing else.
    const trimOne = (key, value) => {
      if (typeof value !== 'string') return value;
      if (except.some((pattern) => strIs(pattern, key))) return value;
      return phpTrim(value);
    };
    const convertOne = (value) => (value === '' ? null : value);
    const cleanBag = (node, prefix) => {
      if (Array.isArray(node)) return node.map((v) => cleanBag(v, prefix));
      if (!isPlainObject(node)) return node;
      const out = {};
      for (const key of Object.keys(node)) {
        const path = prefix + key;
        let value = cleanBag(node[key], path + '.');
        if (trimOn) value = trimOne(path, value);
        if (emptyToNullOn) value = convertOne(value);
        ownSet(out, key, value);
      }
      return out;
    };
    const retrim = (node) => {
      if (!isPlainObject(node)) return node;
      const next = cleanBag(node, '');
      for (const key of Object.keys(node)) delete node[key];
      // The bag's own order log (parsePhpQuery) is dropped with the keys; the
      // key order of `next` is the bag order the transformer produced.
      assignOwn(node, next);
      return node;
    };
    if (Object.keys(query).length) retrim(query);
    if (isJson && isPlainObject(json)) retrim(json);
    else if (isPlainObject(post)) retrim(post);
  }
  const inputSource = () => {
    if (isJson && json !== null) return json;
    if (rawMethod === 'GET' || rawMethod === 'HEAD') return query;
    return post;
  };

  // The uploaded files: the descriptors become the file objects (a field with
  // `name[]` is an array of them).
  const makeFile = (desc) => {
    if (Array.isArray(desc)) return desc.map(makeFile);
    // A descriptor of one part (`__part`) becomes a file object; a container
    // (the map of a nested field name) is walked. The keys go through ownSet:
    // a field named `x[__proto__]` is ordinary DATA in PHP
    // (`$_FILES['x']['__proto__']`), and `out[key] = ..` would set the walk's
    // PROTOTYPE instead (kernel/own-key.mjs).
    if (desc && typeof desc === 'object' && !desc.__uploadedFile && !desc.__part) {
      const out = {};
      for (const key of Object.keys(desc)) ownSet(out, key, makeFile(desc[key]));
      return out;
    }
    return makeUploadedFile(desc, storage, defaultDisk, randomString);
  };
  const fileObjects = () => {
    const out = {};
    for (const name of Object.keys(files)) ownSet(out, name, makeFile(files[name]));
    return out;
  };

  // InteractsWithData support (see phpKeyList/phpFilterVarBoolean above).
  // `Request::input()` is `$this->getInputSource()->all() + $this->query->all()`
  // (InteractsWithInput.php:117-124) and `all()` unions the query bag the same
  // way: the SOURCE's keys come first and the source WINS on a shared key.
  // `Object.assign({}, query, source)` answered the same VALUES in the other
  // ORDER, so a body that echoes `$request->all()` (or
  // `json_encode($request->all())`) differed from PHP's byte for byte.
  const inputUnion = () => copyOwn(inputSource(), query);
  // InteractsWithData::isEmptyString(): `$value = $this->data($key)` — `data()`
  // is `input()`, which unions the query bag in (`inputUnion`); oracle:
  // `filled('flag')` is true for `POST /x?flag=1`. A file-only key is absent
  // from the input, so it reads as an empty string (oracle: filled('avatar') =
  // false for a multipart upload).
  const isEmptyString = (key) => {
    const v = dataGet(inputUnion(), key, null);
    return typeof v !== 'boolean' && !Array.isArray(v) && String(v == null ? '' : v).trim() === '';
  };

  const request = {
    realMethod: () => rawMethod,
    method: () => method,
    methodOverride: () => methodOverride,
    header(name, def = null) {
      return headers.get(name, def);
    },
    hasHeader(name) {
      return headers.has(name);
    },
    headersAll() {
      return headers.all();
    },
    host() {
      return hostHeader;
    },
    httpHost() {
      return hostHeader;
    },
    scheme() {
      return scheme;
    },
    schemeAndHttpHost() {
      return `${scheme}://${hostHeader}`;
    },
    ip() {
      return ip;
    },
    setIp(value) {
      ip = value;
      return request;
    },
    pathInfo() {
      return pathInfo;
    },
    path() {
      return requestPath(pathInfo);
    },
    decodedPath() {
      return requestDecodedPath(pathInfo);
    },
    url() {
      return requestUrl(uri);
    },
    fullUrl() {
      return requestFullUrl(uri, pathInfo, rawQuery, '');
    },
    getQueryString() {
      return normalizeQueryString(rawQuery) || '';
    },
    is(...patterns) {
      return requestIs(request, patterns.flat());
    },
    fullUrlIs(...patterns) {
      return requestFullUrlIs(request, patterns.flat());
    },
    ajax() {
      return requestAjax(request);
    },
    pjax() {
      return requestPjax(request);
    },
    wantsJson() {
      return requestWantsJson(request);
    },
    acceptsAnyContentType() {
      return acceptsAnyContentType(request);
    },
    expectsJson() {
      return requestExpectsJson(request);
    },
    // Illuminate\Http\Request::prefetch(): three headers, `strcasecmp` against 'prefetch'.
    prefetch() {
      const isPrefetch = (v) => String(v == null ? '' : v).toLowerCase() === 'prefetch';
      return (
        isPrefetch(request.header('x-moz')) ||
        isPrefetch(request.header('purpose')) ||
        isPrefetch(request.header('sec-purpose'))
      );
    },
    // Illuminate\Http\Concerns\CanBePrecognitive::isPrecognitive() reads the
    // 'precognitive' request attribute set by HandlePrecognitiveRequests, which is
    // not in the `web` group and whose `precognitive` alias the build rejects — so
    // inside the compiled rung it is always false.
    isPrecognitive() {
      return false;
    },
    cookie(name, def = null) {
      return Object.prototype.hasOwnProperty.call(cookies, name) ? cookies[name] : def;
    },
    cookiesRaw() {
      return cookies;
    },
    setCookies(map) {
      cookies = map;
      return request;
    },
    hasCookie(name) {
      return Object.prototype.hasOwnProperty.call(cookies, name) && cookies[name] !== null;
    },
    input(key = null, def = null) {
      const union = inputUnion();
      if (key === null) return union;
      return dataGet(union, key, def);
    },
    // Illuminate\Http\Request::merge() (Request.php:389-401): the new input
    // goes into the request's INPUT SOURCE (the JSON bag, the query bag for
    // GET/HEAD, the post bag otherwise). Every key REPLACES the value (it is
    // not a deep merge) and the dot notation is honoured (Arr::set).
    merge(input) {
      const source = inputSource();
      for (const [key, value] of Object.entries(input || {})) {
        // Arr::set: the dot notation sets a NESTED value and replaces it.
        arrSetRef(source, key, value, false);
      }
      return request;
    },
    query(key = null, def = null) {
      if (key === null) return query;
      return dataGet(query, key, def);
    },
    post(key = null, def = null) {
      if (key === null) return post;
      return dataGet(post, key, def);
    },
    // The uploaded files (a multipart/form-data body).
    // Illuminate\Http\Request::file(): data_get($this->allFiles(), $key, $default).
    file(key = null, def = null) {
      if (key === null) return fileObjects();
      const found = dataGetPhpArray(fileObjects(), key);
      return found === ARR_MISSING ? def : found;
    },
    // allFiles(): every uploaded file (the files of a field with `name[]` are
    // an array).
    allFiles() {
      return fileObjects();
    },
    // InteractsWithInput::hasFile() (:218-236):
    //   `array_any(array_wrap($this->file($key)), fn ($f) => $f instanceof
    //    SplFileInfo && $f->getPath() !== '')`
    // so a MAP of files is true only where its own values are files: a nested
    // name answers TRUE one level above the file and FALSE where a further map
    // sits in between (probed on a live PHP 8.3 server with
    // `$_FILES['a']['b']['c']`: hasFile('a') = false, hasFile('a.b') = true,
    // hasFile('post') = true for `post[image]`, hasFile('post.image') = true,
    // hasFile('nope') = false). `array_wrap()` of a PHP array contributes its
    // VALUES. The kernel called `isValid()` on whatever came back, so the common
    // `$request->hasFile('post')` for a nested file name THREW (#848).
    hasFile(key) {
      const found = dataGetPhpArray(fileObjects(), key);
      if (found === ARR_MISSING || found === null) return false;
      const list = isPhpArray(found) && !found.__uploadedFile ? Object.values(found) : [found];
      return list.some((f) => !!f && f.__uploadedFile === true);
    },
    json(key = null, def = null) {
      if (key === null) return json;
      return dataGet(json ?? {}, key, def);
    },
    // Symfony Request::getContent(): the RAW body string, exactly as it arrived.
    // A webhook verifier HMACs these bytes, and a re-serialised copy is a
    // DIFFERENT message to the provider's signature (`{"id":"a"}` vs
    // `{\n  "id": "a"\n}`), so `json()` must never stand in for it. A multipart
    // body keeps its bytes in `bodyBytes` and answers '' here, matching Laravel
    // for a body it never held as text.
    getContent() {
      return body;
    },
    // The alias the seam ports read (`ctx.request.text()`); the same raw string,
    // awaited so a port written against a fetch `Request` needs no branch.
    text() {
      return Promise.resolve(body);
    },
    // InteractsWithData::has(): `array_all($keys, fn ($v) => Arr::has($data, $v))`
    // over `$this->all()` (input + query + uploaded files). Oracle-verified:
    // `has('nope')` = false, `has(['a','nope'])` = false, `has(['a','title'])` = true.
    has(...args) {
      const keys = phpKeyList(args);
      if (keys.length === 0) return false;
      // A null key is a miss: Arr::exists($array, null) reads the key ''.
      if (keys.some((k) => k === null || k === undefined)) return false;
      const data = request.all();
      return keys.every((k) => dataGet(data, k, ARR_MISSING) !== ARR_MISSING);
    },
    session() {
      return session;
    },
    hasSession() {
      return session !== null;
    },
    setSession(store) {
      session = store;
      return request;
    },
    route() {
      return route;
    },
    setRoute(r, params) {
      route = r;
      routeParams = params || {};
      return request;
    },
    routeParams() {
      return routeParams;
    },
    user() {
      return userResolver ? userResolver() : null;
    },
    setUserResolver(fn) {
      userResolver = fn;
      return request;
    },
    userId() {
      const u = request.user();
      return u && typeof u.getAuthIdentifier === 'function' ? u.getAuthIdentifier() : null;
    },
    all(...args) {
      // Illuminate\Http\Concerns\InteractsWithInput::all($keys = null)
      // (:87-105):
      //   `$input = $this->input();`
      //   `$input = array_replace_recursive($input, $this->allFiles(), $input);`
      // The files merge RECURSIVELY into the input (the input wins last), so
      // `all()['post']` carries BOTH the field and the `post[image]` upload -
      // a shallow union dropped the file whenever the same level had a field
      // (probed on a live PHP 8.3 server: `all()['post']` = title + image; the
      // kernel answered `{title}` only, #849). With arguments it is the
      // `Arr::only`-shaped SUBSET built with `Arr::set`/`Arr::get` - the DOT
      // NOTATION works and an absent key answers null.
      const input = inputUnion();
      const data = arrayReplaceRecursive(input, fileObjects(), input);
      const keys = phpKeyList(args);
      if (keys.length === 0) return data;
      const results = {};
      for (const key of keys) arrSetRef(results, key, dataGet(data, key, null), false);
      return results;
    },
    // --- InteractsWithData (Illuminate\Support\Traits\InteractsWithData) ----
    // `has`/`all` above predate this block; the accessors below mirror the trait
    // exactly (rest args collapse to `$keys` via phpKeyList, which reproduces
    // `is_array($keys) ? $keys : func_get_args()`).
    hasAny(...args) {
      const keys = phpKeyList(args);
      if (keys.length === 0) return false;
      if (keys.some((k) => k === null || k === undefined)) return false;
      const data = request.all();
      return keys.some((k) => dataGet(data, k, ARR_MISSING) !== ARR_MISSING);
    },
    filled(...args) {
      return phpKeyList(args).every((k) => !isEmptyString(k));
    },
    isNotFilled(...args) {
      return phpKeyList(args).every((k) => isEmptyString(k));
    },
    // InteractsWithData::missing(): `! $this->has($keys)` — the same all()
    // source, so a file-only key is present (oracle: missing('avatar') = false).
    missing(...args) {
      return !request.has(...args);
    },
    only(...args) {
      const out = {};
      const data = request.all();
      for (const k of phpKeyList(args)) {
        const v = dataGet(data, k, ARR_MISSING);
        if (v !== ARR_MISSING) arrSetRef(out, k, v, false);
      }
      return out;
    },
    except(...args) {
      const out = request.all();
      for (const k of phpKeyList(args)) arrSetRef(out, k, undefined, true);
      return out;
    },
    // NOTE: Laravel's `string()` returns a Stringable. The compiled rung models
    // it as a plain string (Stringable method chains are not transpiled yet);
    // scalar use (comparison/concatenation/assignment) is byte-identical.
    string(key, def = null) {
      const v = request.input(key, def);
      return v === null || v === undefined || v === false ? '' : String(v);
    },
    str(key, def = null) {
      return request.string(key, def);
    },
    integer(key, def = 0) {
      return phpIntCast(request.input(key, def));
    },
    float(key, def = 0.0) {
      return phpFloatCast(request.input(key, def));
    },
    boolean(key = null, def = false) {
      return phpFilterVarBoolean(request.input(key, def));
    },
    isMethod(method) {
      return request.method() === String(method).toUpperCase();
    },
    headers() {
      return request.headersAll();
    },
    userAgent() {
      return request.header('User-Agent');
    },
    bearerToken() {
      const h = request.header('Authorization');
      if (!h) return null;
      const m = String(h).match(/^Bearer\s+(.+)$/i);
      return m ? m[1].trim() : null;
    },
  };
  return request;
}

// (path / url / is() helpers live in kernel/csrf.mjs — oracle-verified Symfony parity.)

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export class HttpResponse {
  constructor({ status = 200, headers = {}, body = '', cookies = null } = {}) {
    this.status = status;
    this.headers = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (v !== undefined && v !== null) this.headers[String(k).toLowerCase()] = String(v);
    }
    // Symfony's Response constructor always sets Cache-Control
    // (ResponseHeaderBag::computeCacheControlValue) unless one was provided.
    // Track whether THIS constructor injected it: Symfony's RedirectResponse
    // removes exactly the computed default again for a 301 (and must never
    // remove a header the app set itself).
    this.injectedCacheControl = false;
    if (!Object.prototype.hasOwnProperty.call(this.headers, 'cache-control')) {
      this.headers['cache-control'] = 'no-cache, private';
      this.injectedCacheControl = true;
    }
    this.body = body;
    this.cookies = cookies instanceof ResponseCookies ? cookies : new ResponseCookies();
    if (Array.isArray(cookies)) for (const c of cookies) this.cookies.set(c);
  }

  header(name, value) {
    const key = String(name).toLowerCase();
    if (value === undefined) return Object.prototype.hasOwnProperty.call(this.headers, key) ? this.headers[key] : null;
    if (value === null) delete this.headers[key];
    else this.headers[key] = String(value);
    return this;
  }

  withCookie(cookie) {
    this.cookies.set(cookie);
    return this;
  }

  toResponse() {
    return this;
  }
}

export function toHttpResponse(input) {
  if (input instanceof HttpResponse) return input;
  if (input === null || input === undefined) {
    throw new HttpError('middleware returned no response', 500);
  }
  if (typeof input === 'object' && typeof input.status === 'number') {
    const headers = {};
    if (input.headers && typeof input.headers === 'object') {
      for (const [k, v] of Object.entries(input.headers)) headers[k] = v;
    }
    if (input.location && headers.location === undefined) headers.location = input.location;
    return new HttpResponse({ status: input.status, headers, body: input.body ?? '' });
  }
  throw new HttpError('middleware returned an unsupported response shape', 500);
}

// ---------------------------------------------------------------------------
// session + auth factories
// ---------------------------------------------------------------------------

function createHasher(config) {
  const driver = config['hashing.driver'] ?? 'bcrypt';
  if (driver !== 'bcrypt') {
    throw new HttpError(`hashing driver '${driver}' is not supported by the compiled rung (only bcrypt).`, 500);
  }
  return new BcryptHasher({
    rounds: config['hashing.bcrypt.rounds'] ?? 12,
    verify: config['hashing.bcrypt.verify'] ?? true,
    limit: config['hashing.bcrypt.limit'] ?? null,
  });
}

/**
 * auth.providers.*.model is an FQCN string in config; the compiled rung needs the
 * generated Model class from models.generated.mjs. Missing model → fail loud.
 */
function resolveAuthConfig(config, models) {
  const resolved = { ...config };
  for (const key of Object.keys(resolved)) {
    if (!key.startsWith('auth.providers.')) continue;
    const provider = resolved[key];
    if (!provider || provider.driver !== 'eloquent') continue;
    if (typeof provider.model !== 'string') continue;
    const picked = models ? models[provider.model] : undefined;
    if (!picked) {
      throw new HttpError(
        `auth provider "${key.slice('auth.providers.'.length)}" names the model "${provider.model}" but no generated Model class exists for it ` +
          '(the model has to be part of the compiled build).',
        500
      );
    }
    // Authenticatable is a trait the app's model inherits via
    // `Illuminate\Foundation\Auth\User`; a data-only generated class cannot
    // express it, so apply the trait contract here (idempotent, never
    // overwrites methods the compiler emitted).
    applyAuthenticatable(picked);
    resolved[key] = { ...provider, model: picked };
  }
  return resolved;
}

function sessionPersistent(config) {
  const driver = config['session.driver'];
  return !(driver === null || driver === undefined || driver === 'array');
}

function createSessionStore({ config, request, jar, db, clock, randomString, userId = null }) {
  const driver = config['session.driver'];
  if (driver === null || driver === undefined) {
    throw new HttpError('session.driver is not configured in config.generated.mjs', 500);
  }
  if (config['session.encrypt']) {
    throw new HttpError('SESSION_ENCRYPT=true (EncryptedStore) is not supported by the compiled rung yet.', 500);
  }
  const minutes = config['session.lifetime'] ?? 120;
  const cookieName = config['session.cookie'] ?? 'laravel_session';
  const serialization = config['session.serialization'] ?? 'json';

  let handler;
  if (driver === 'database') {
    if (!db) {
      throw new HttpError("session driver 'database' requires the D1 binding (env.DB).", 500);
    }
    handler = new DatabaseSessionHandler({
      db,
      table: config['session.table'] ?? 'sessions',
      minutes,
      clock,
      info: async () => ({
        ip_address: request.ip(),
        user_agent: request.header('User-Agent'),
        user_id: userId ? await userId() : null,
      }),
    });
  } else if (driver === 'cookie') {
    handler = new CookieSessionHandler({
      jar,
      minutes,
      expireOnClose: !!config['session.expire_on_close'],
      clock,
    });
    handler.setRequest(request.cookiesRaw());
  } else if (driver === 'array') {
    throw new HttpError("session driver 'array' has no cross-request state in the compiled worker.", 500);
  } else {
    throw new HttpError(`session driver '${driver}' is not supported by the compiled rung (database/cookie only).`, 500);
  }

  return new PhpSessionStore({
    name: cookieName,
    handler,
    id: request.cookie(cookieName),
    serialization,
    clock,
    randomString,
  });
}

function sessionCookie(config, store, nowS) {
  const expires = config['session.expire_on_close'] ? 0 : nowS() + (config['session.lifetime'] ?? 120) * 60;
  return makeCookie(config['session.cookie'] ?? 'laravel_session', store.getId(), expires, {
    path: config['session.path'] ?? '/',
    domain: config['session.domain'] ?? null,
    secure: config['session.secure'] ?? null,
    httpOnly: config['session.http_only'] ?? true,
    raw: false,
    sameSite: config['session.same_site'] ?? null,
    partitioned: config['session.partitioned'] ?? false,
  });
}

// ---------------------------------------------------------------------------
// route registry + absolute URLs
// ---------------------------------------------------------------------------

export function makeRouteRegistry(table) {
  const names = new Map();
  const byMethod = {};
  for (const r of table || []) {
    if (r.name) names.set(String(r.name), r);
    for (const m of r.methods || []) {
      const key = String(m).toUpperCase();
      if (!byMethod[key]) byMethod[key] = {};
      byMethod[key][String(r.uri || '/').replace(/^\/+|\/+$/g, '')] = r.uri;
    }
  }
  return {
    has: (name) => names.has(String(name)),
    route: (name) => {
      const r = names.get(String(name));
      return r ? r.uri : null;
    },
    get: (method) => byMethod[String(method).toUpperCase()] || {},
  };
}

// UrlGenerator::to() subset - absolute target against the request root, with
// Laravel 13.37's own trimming (measured on PHP 8.3): to('/') and to('')
// answer the bare root (no trailing slash), and to('masuk/') trims the
// trailing slash. A redirect Location must carry the same bytes.
export function absoluteUrl(root, path) {
  const p = String(path ?? '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p;
  const base = String(root).replace(/\/+$/, '');
  const trimmed = p.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return base || '/';
  return (base || '') + '/' + trimmed;
}

// ---------------------------------------------------------------------------
// route middleware
// ---------------------------------------------------------------------------

function splitList(params) {
  const out = [];
  for (const p of params) {
    for (const piece of String(p).split(',')) out.push(piece);
  }
  return out;
}

// Symfony's Request::getUser()/getPassword() read the `Authorization: Basic`
// header: base64("user:password"). A missing header, a non-Basic scheme or a
// payload without a colon yields null credentials (Laravel then answers 401).
function basicCredentials(req) {
  const header = typeof req.header === 'function' ? req.header('authorization') : null;
  if (!header) return null;
  const m = /^\s*Basic\s+(.+)$/i.exec(String(header));
  if (!m) return null;
  let decoded;
  try {
    decoded = atob(m[1].trim());
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  const user = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  if (user === '') return null;
  return { user, password };
}

// Symfony\Component\HttpKernel\Exception\UnauthorizedHttpException('Basic'):
// a 401 with `WWW-Authenticate: Basic` (the challenge is the exception's
// argument — Laravel's `auth.basic` middleware passes 'Basic', not a realm).
function unauthorizedBasic() {
  return new HttpError('Invalid credentials.', 401, { 'www-authenticate': 'Basic' });
}

function middlewareStages(list, ctx) {
  const stages = [];
  // Laravel sorts the route middleware by $middlewarePriority, where
  // ThrottleRequests sits *before* the auth/guest middleware. The compiled rung
  // mirrors that: the rate limiter answers (and adds its X-RateLimit-* headers)
  // even when a later middleware short-circuits the request.
  const priority = { throttle: 0 };
  const ordered = (list || [])
    .map((raw, i) => ({ raw, i }))
    .sort((a, b) => {
      const pa = priority[String(a.raw).split(':')[0]];
      const pb = priority[String(b.raw).split(':')[0]];
      if (pa !== undefined && pb !== undefined) return pa - pb;
      if (pa !== undefined) return -1;
      if (pb !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.raw);
  for (const raw of ordered) {
    const str = String(raw);
    const colon = str.indexOf(':');
    const name = colon === -1 ? str : str.slice(0, colon);
    const params = colon === -1 ? [] : splitList([str.slice(colon + 1)]);
    if (name === 'web' || name === 'api' || name === 'substitute_bindings' || name === 'bindings') {
      continue;
    }
    if (name === 'auth') {
      const mw = new Authenticate(ctx.auth);
      stages.push((req, next) => mw.handle(req, next, ...params));
      continue;
    }
    if (name === 'auth.basic') {
      // Illuminate\Auth\Middleware\AuthenticateWithBasicAuth -> guard->basic($field).
      // An already-authenticated request passes through untouched; otherwise the
      // Basic credentials are verified and the user is logged in (Laravel's
      // SessionGuard::basic() calls attempt(), not onceBasic()). A failure throws
      // Symfony's UnauthorizedHttpException('Basic') -> 401 + WWW-Authenticate.
      stages.push(async (req, next) => {
        const guard = ctx.auth.guard(params[0] ?? null);
        if (await guard.check()) return next(req);
        const credentials = basicCredentials(req);
        if (!credentials) throw unauthorizedBasic();
        const field = params[1] || 'email';
        const ok = await guard.attempt({ [field]: credentials.user, password: credentials.password });
        if (!ok) throw unauthorizedBasic();
        return next(req);
      });
      continue;
    }
    if (name === 'guest') {
      const mw = new RedirectIfAuthenticated(ctx.auth, {
        redirect: ctx.redirectFactory,
        routeRegistry: ctx.routeRegistry,
      });
      stages.push((req, next) => mw.handle(req, next, ...params));
      continue;
    }
    if (name === 'throttle') {
      const mw = new ThrottleRequests(ctx.limiterFactory());
      stages.push(async (req, next) => {
        // Laravel's $request->user() is synchronous, but the compiled guard's
        // user() is async (a D1 read). Resolve it once and hand ThrottleRequests
        // a synchronous view, so its signature / `throttle:<name>` resolution
        // sees the real user (or null) instead of a Promise.
        let resolved = null;
        try {
          resolved = (await ctx.auth.guard().user()) ?? null;
        } catch {
          resolved = null;
        }
        const prevUser = req.user;
        req.user = () => resolved;
        try {
          return await mw.handle(req, next, ...params);
        } finally {
          req.user = prevUser;
        }
      });
      continue;
    }
    throw new HttpError(
      `route middleware [${name}] is not supported by the compiled rung yet (route ${str})`,
      500
    );
  }
  return stages;
}

// Illuminate\Routing\Pipeline::carry() catches a Throwable at *every* level and
// renders it there, so the innermost wrapper is what turns a controller
// exception into a response. Middleware outside the thrower then still run their
// response phase — ThrottleRequests::addHeaders on a thrown ValidationException
// is the observable difference (the rate-limit headers are absent otherwise).
function buildChain(stages, core, render) {
  // `render` is the exception renderer. Rendering itself can fail loud (e.g. the
  // unported ViewErrorBag php-serialization path throws an HttpError); tag that
  // so the outer catch in handleHttp rethrows instead of rendering it *again*
  // into a 500 body — a rejected promise is the fail-loud contract.
  const renderOnce = async (req, e) => {
    if (e && e.lwRenderFailed) throw e;
    try {
      return await render(req, e);
    } catch (renderError) {
      if (renderError && typeof renderError === 'object') renderError.lwRenderFailed = true;
      throw renderError;
    }
  };
  // Illuminate\Routing\Pipeline::prepareDestination() wraps the destination in
  // the same try/catch, so the innermost middleware sees a *rendered* response
  // from `$next()` and can still run its response phase on it.
  let inner = async (req) => {
    try {
      return await core(req);
    } catch (e) {
      return renderOnce(req, e);
    }
  };
  for (let i = (stages || []).length - 1; i >= 0; i -= 1) {
    const stage = stages[i];
    const next = inner;
    inner = async (req) => {
      try {
        return await stage(req, next);
      } catch (e) {
        return renderOnce(req, e);
      }
    };
  }
  return inner;
}

// ---------------------------------------------------------------------------
// exception rendering (subset of Illuminate's ExceptionHandler)
// ---------------------------------------------------------------------------

async function renderException(error, request, ctx) {
  if (error instanceof AuthenticationException) {
    if (requestExpectsJson(request)) {
      return new HttpResponse({
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Unauthenticated.' }),
      });
    }
    const target = error.redirectTo ? error.redirectTo(request) : null;
    // Redirector::guest() stores the intended URL through
    // UrlGenerator::previous() (UrlGenerator.php:162-175): the REFERER first
    // (through to(), so it comes back absolute), then the session's
    // `_previous.url`, then the site root. Probed: referer + session => the
    // referer; session only => the session value; neither => 'http://localhost'.
    const referer = request.header('referer');
    const intended =
      request.method() === 'GET' && request.route() && !requestExpectsJson(request)
        ? request.fullUrl()
        : referer
          ? absoluteUrl(request.schemeAndHttpHost(), referer)
          : (ctx.store.previousUrl() ?? absoluteUrl(request.schemeAndHttpHost(), '/'));
    ctx.store.put('url.intended', intended);
    const uri = target !== null && target !== undefined ? target : ctx.loginUri();
    if (uri === null) {
      throw new HttpError('guest redirect needs a named [login] route (or Authenticate::redirectUsing).', 500);
    }
    return new HttpResponse({
      status: 302,
      headers: { location: absoluteUrl(request.schemeAndHttpHost(), uri) },
    });
  }
  if (error instanceof ValidationException) {
    // Illuminate\Foundation\Exceptions\Handler::invalidJson() for expectsJson,
    // invalid() (redirect back + flash) otherwise.
    if (requestExpectsJson(request)) {
      return new HttpResponse({
        status: error.status,
        headers: { 'content-type': 'application/json' },
        body: phpJsonEncode({ message: error.message, errors: error.errors() }),
      });
    }
    // json sessions store the bag via Store::prepareErrorBagForSerialization();
    // the php-serialization path serializes a ViewErrorBag object (not ported).
    if (String(ctx.config?.['session.serialization'] ?? 'json') !== 'json') {
      throw new HttpError(
        'validation redirects need session.serialization=json (the ViewErrorBag php-serialization path is not ported).',
        500
      );
    }
    // url()->previous(): the Referer (through UrlGenerator::to()) else the
    // flashed previous URL else the request root.
    const referer = request.header('referer');
    const previous = referer
      ? absoluteUrl(request.schemeAndHttpHost(), referer)
      : ctx.store.previousUrl();
    const location =
      error.redirectTo != null
        ? absoluteUrl(request.schemeAndHttpHost(), error.redirectTo)
        : previous ?? absoluteUrl(request.schemeAndHttpHost(), '/');

    // Illuminate\Foundation\Exceptions\Handler::invalid() flashes
    // `Arr::except($request->input(), $this->dontFlash)` - NOT `all()`: the
    // uploaded files live in the separate files bag, so `input()` has no file
    // keys and `_old_input` never carries one (a `foto[]` field is absent, not
    // `[{}, {}]`). The old code flashed `all()` and deleted only the top-level
    // file keys, so a NESTED file field survived as an array of empty objects
    // (audit H1).
    const input = request.input();
    for (const key of DEFAULT_DONT_FLASH) delete input[key];
    ctx.store.flashInput(input);

    // RedirectResponse::withErrors($errors, $request->input('_error_bag', $bag)).
    const bag = request.input('_error_bag', error.errorBag);
    ctx.store.flash('errors', sessionErrorBag(bag, error.errors()));

    return new HttpResponse({ status: 302, headers: { location } });
  }
  if (error instanceof TokenMismatchError) {
    // A compiled error view (ctx.renderErrorView) takes precedence when present,
    // even for JSON requests (the view is the app's chosen 419 representation).
    const rendered419 =
      typeof ctx.renderErrorView === 'function' ? ctx.renderErrorView(419, request, ctx, error) : null;
    if (rendered419 != null) {
      return new HttpResponse({
        status: 419,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: String(rendered419),
      });
    }
    // Laravel renders 419 through the exception handler: JSON for expectsJson
    // (`{"message":"CSRF token mismatch."}`), the app's errors/419 view otherwise.
    if (requestExpectsJson(request)) {
      return new HttpResponse({
        status: 419,
        headers: { 'content-type': 'application/json' },
        body: phpJsonEncode({ message: error.message }),
      });
    }
    return new HttpResponse({
      status: 419,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>419</h1><p>CSRF token mismatch.</p></body></html>',
    });
  }
  if (error instanceof ThrottleRequestsError) {
    return new HttpResponse({ status: error.status, headers: error.headers, body: '' });
  }
  if (error instanceof HttpResponseError) {
    return toHttpResponse(error.response);
  }
  if (error instanceof HttpError) {
    const rendered = typeof ctx.renderErrorView === 'function' ? ctx.renderErrorView(error.status, request, ctx, error) : null;
    if (rendered != null) {
      return new HttpResponse({
        status: error.status,
        headers: { 'content-type': 'text/html; charset=utf-8', ...(error.headers || {}) },
        body: String(rendered),
      });
    }
    // No compiled error view: a status-only HTML page (Laravel renders an HTML
    // error page too — the exact bytes are a framework asset we do not ship).
    return new HttpResponse({
      status: error.status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...(error.headers || {}) },
      body: `<html><body><h1>${error.status}</h1><p>${escapeHtmlText(error.message)}</p></body></html>`,
    });
  }
  // Illuminate\Foundation\Exceptions\Handler::render() (13.37): a Throwable that
  // is not an HTTP exception is *prepared* into a 500 - `prepareException()`
  // wraps it in an HttpException with status 500, `prepareResponse()` then renders
  // the errors/500 view (or, for an expectsJson request, `prepareJsonResponse()`
  // with convertExceptionToArray() answering `['message' => 'Server Error']`
  // outside debug). This branch used to rethrow: the exception escaped
  // handleHttp - and the Worker's fetch, which has no catch of its own - so the
  // platform answered "error code: 1101" where Laravel renders a 500. The
  // fail-loud contract above is for a render that itself failed (lwRenderFailed);
  // an *unrendered* app error is not that case.
  //
  // Illuminate\Foundation\Exceptions\Handler::report() also writes the throwable
  // to the application log before render() answers. The compiled rung answered
  // "Server Error" with nothing recorded anywhere - the same shape as this
  // project's own deploy incident (`wrangler tail` said `outcome=ok` and no line
  // anywhere named the cause). The Worker's log is the console, so the throwable
  // goes there (`wrangler tail`); the response bytes below are untouched: parity
  // is asserted on the response, and this is the only place the cause of a bare
  // 500 can surface.
  {
    const name = (error && error.constructor && error.constructor.name) || typeof error;
    const method = typeof request.method === 'function' ? request.method() : null;
    const path = typeof request.path === 'function' ? request.path() : null;
    const at = [method, path].filter(Boolean).join(' ');
    console.error(
      `laravel-workers: unhandled ${name}${at ? ` on ${at}` : ''}: ${error && error.message ? error.message : String(error)}`
    );
    if (error && error.stack) console.error(String(error.stack).split('\n').slice(0, 8).join('\n'));
  }
  if (requestExpectsJson(request)) {
    return new HttpResponse({
      status: 500,
      headers: { 'content-type': 'application/json' },
      // prepareJsonResponse uses JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES, and
      // the message is the literal 'Server Error' (config('app.debug') is false
      // in the compiled rung - convertExceptionToArray only answers the real
      // message/class/file/line when debug is on).
      body: '{\n    "message": ' + phpJsonEncode('Server Error') + '\n}',
    });
  }
  const rendered500 =
    typeof ctx.renderErrorView === 'function' ? ctx.renderErrorView(500, request, ctx, error) : null;
  return new HttpResponse({
    status: 500,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    // No compiled error view: a status-only HTML page, like the HttpError branch
    // above (Laravel renders the framework's errors/500 view - the exact bytes
    // are a framework asset the build compiles when it can).
    body:
      rendered500 != null
        ? String(rendered500)
        : `<html><body><h1>500</h1><p>${escapeHtmlText('Server Error')}</p></body></html>`,
  });
}

// ---------------------------------------------------------------------------
// redirect rendering (Symfony RedirectResponse)
// ---------------------------------------------------------------------------

// Symfony\Component\HttpFoundation\Response::isRedirect()
const REDIRECT_STATUSES = new Set([201, 301, 302, 303, 307, 308]);

// Symfony's RedirectResponse renders the target URL into an HTML body with
// `htmlspecialchars($url, ENT_QUOTES, 'UTF-8')` (the vendor template, byte for byte).
function escapeHtmlText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function symfonyRedirectBody(url) {
  const escaped = String(url)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  return (
    '<!DOCTYPE html>\n' +
    '<html>\n' +
    '    <head>\n' +
    '        <meta charset="UTF-8" />\n' +
    `        <meta http-equiv="refresh" content="0;url='${escaped}'" />\n` +
    '\n' +
    `        <title>Redirecting to ${escaped}</title>\n` +
    '    </head>\n' +
    '    <body>\n' +
    `        Redirecting to <a href="${escaped}">${escaped}</a>.\n` +
    '    </body>\n' +
    '</html>'
  );
}

// Symfony's ResponseHeaderBag seeds every response with a computed Cache-Control
// (`computeCacheControlValue`). The `Date` header is added by the runtime (Workers),
// not by the compiled rung.
function withDefaultCacheControl(res) {
  if (res.headers['cache-control'] === undefined || res.headers['cache-control'] === '') {
    res.headers['cache-control'] =
      res.headers['last-modified'] !== undefined || res.headers['expires'] !== undefined
        ? 'private, must-revalidate'
        : 'no-cache, private';
  }
  return res;
}

// ---------------------------------------------------------------------------
// handleHttp
// ---------------------------------------------------------------------------

// The app's validation messages (the build dumps the app's lang/ files with the
// translations: the app's own file wins over the framework's copy, exactly
// like Laravel's translator). The app's locale wins over the fallback locale
// (app.fallback_locale, 'en' by default), and the two are merged
// RECURSIVELY - Illuminate\Translation\FileLoader merges its paths with
// `array_replace_recursive` (:134) and Translator::get() falls back per KEY,
// so a locale file that redefines only part of `validation.custom` keeps the
// framework's other keys there. `Object.assign` dropped them wholesale.
function replaceRecursive(base, override) {
  if (base === null || typeof base !== 'object') return override;
  if (override === null || override === undefined) return base;
  if (typeof override !== 'object') return override;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] =
      current !== null && typeof current === 'object' && value !== null && typeof value === 'object'
        ? replaceRecursive(current, value)
        : value;
  }
  return out;
}

export function validationMessagesOf(config) {
  const translations = config && config.translations;
  if (!translations || typeof translations !== 'object') return null;
  const locale = String((config && config['app.locale']) || 'en');
  const fallback = String((config && config['app.fallback_locale']) || 'en');
  const base = translations[fallback] && translations[fallback].validation;
  const local = translations[locale] && translations[locale].validation;
  if (!base && !local) return null;
  return replaceRecursive(base || {}, local || {});
}

/**
 * Run one request through the compiled pipeline.
 *
 * @param {object} raw        { method, url, headers, body }
 * @param {object} options    { table, handlers, config, env, db?, models?, cache?,
 *                              clock?, events?, randomString?, clientIp? }
 * @returns {Promise<object|null>} { status, headers, setCookie, body } or null
 *          when no route matched (the caller falls back to assets).
 */
export async function handleHttp(raw, options = {}) {
  const config = options.config || {};
  const table = options.table || [];
  const handlers = options.handlers || {};
  const env = options.env || {};
  const db = options.db ?? env.DB ?? null;
  const models = options.models || null;
  const cache = options.cache || null;
  const clock = options.clock || (() => Math.floor(Date.now() / 1000));
  const nowS = () => clock();
  const appKey = String(config['app.key'] ?? '').replace(/^base64:/, '');
  if (!appKey) throw new HttpError('app.key is missing from config.generated.mjs', 500);

  const routeRegistry = makeRouteRegistry(table);
  // --- GLOBAL MIDDLEWARE THE COMPILED KERNEL DOES NOT RUN -----------------
  // The app's final stack (bootstrap/app.php `->withMiddleware()`, written by the
  // build as `middleware.prevented`): TrustHosts rejects a host, HandleCors adds
  // headers, PreventRequestsDuringMaintenance answers 503, an app class does
  // anything - none of it runs here, so every request fails loud instead of
  // answering bytes the real app never would.
  const prevented = (Array.isArray(config['middleware.prevented']) ? config['middleware.prevented'] : []).map(String);
  if (prevented.length) {
    throw new HttpError(
      `the app's global middleware stack holds ${prevented.join(', ')} — the compiled rung does not run it, so every response would diverge; add a port`,
      500
    );
  }
  const request = buildRequest(raw, {
    clientIp: options.clientIp,
    // The uploaded file stores itself: the object store + the app's default
    // disk (the name of the disk in `filesystems.default`).
    storage: options.storage || null,
    defaultDisk: config['filesystems.default'] || null,
    // Str::random(40) (the hash of `store()`'s name).
    randomString: options.strRandom || ((n) => phpRandomString(n)),
    // The input transformers the app's global stack runs: the two booleans
    // `transform.trim` / `transform.empty_to_null` come from the app's final
    // stack (a stack that dropped a transformer runs neither pass), and
    // `transform.trim.except` is the full skip list (`TrimStrings::$except` +
    // `TrimStrings::except()`). An older dump without them gets both passes.
    transformers:
      options.transformers ?? {
        trim: config['transform.trim'] !== false,
        emptyToNull: config['transform.empty_to_null'] !== false,
        trimExcept: Array.isArray(config['transform.trim.except'])
          ? config['transform.trim.except']
          : ['current_password', 'password', 'password_confirmation'],
      },
  });
  // $request->validate() / validateWithBag() — compiled controllers call these
  // through rt.request(); the rule engine gets the D1 binding for unique/exists.
  installValidation(request, { db, defaultMessages: validationMessagesOf(config) });

  const matchReq = {
    method: request.realMethod(),
    methodOverride: request.methodOverride() || undefined,
    path: request.pathInfo() + (request.getQueryString() ? '?' + request.getQueryString() : ''),
    host: request.host(),
    headers: request.headersAll(),
  };
  const matched = match(table, matchReq);
  if (!matched) {
    // Laravel's router (AbstractRouteCollection): the URI matches a route but
    // the method does not.
    //   - an OPTIONS request gets the automatic OPTIONS response: 200, an
    //     empty body and the Allow header (the methods the URI accepts);
    //   - any other method raises MethodNotAllowedHttpException: the app
    //     answers 405 when it has an errors/405 view, else the framework's
    //     error renderer answers 500 (the Symfony error page).
    // The router runs BEFORE the route's middleware (the web group: the
    // session, the CSRF), so these answers carry no session cookie — exactly
    // like Laravel's.
    const allowed = allowedMethods(table, matchReq);
    if (!allowed.length) return null; // no route at all: the platform's 404
    if (request.realMethod() === 'OPTIONS') {
      return {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          allow: allowed.join(','),
          'cache-control': 'no-cache, private',
        },
        setCookie: [],
        body: '',
      };
    }
    const has405 = config['errors.405_view'] === true;
    // Laravel keeps the exception's OWN status - 405 - whether or not the app
    // ships an `errors/405` view: `Handler::renderHttpException` renders the
    // view when it exists and `convertExceptionToResponse` otherwise, and that
    // one uses `$e->getStatusCode()` (Laravel 13.37, Handler.php:971-984).
    // Only the BODY follows the view. Probed with the PHP oracle (the fixture
    // app, no errors/405 view, debug off): a JSON request answers 405 with
    // `{"message":"The GET method is not supported for route queue-demo.
    // Supported methods: POST."}`, `Allow: POST` and `cache-control: no-cache,
    // private`; the HTML answer is the framework's error page, never the app's
    // 500 view. (The old rule - "else 500" - came from a Symfony HTML render
    // that could not find its own asset; the status was never 500.)
    const status = 405;
    // Symfony's MethodNotAllowedHttpException header: implode(', ', $allow).
    const allow = allowed.join(', ');
    // Laravel's message (AbstractRouteCollection::requestMethodNotAllowed,
    // :130-137): 'The %s method is not supported for route %s. Supported
    // methods: %s.' - the METHOD as the request sent it, the request's path
    // (no leading slash) and the verbs the URI accepts, `', '`-joined.
    const routePath = String((matchReq.path || '').split('?')[0]).replace(/^\/+/, '');
    const message =
      `The ${matchReq.method} method is not supported for route ${routePath}. ` +
      `Supported methods: ${allow}.`;
    // Laravel renders the error page for this status (the app's errors/405
    // view when it exists, else the framework's own page - a framework asset
    // the build compiles only when the app ships a view). NOTE: `ctx` is built
    // further down (this branch returns before it), so the renderer is read
    // from the options directly.
    const rendered =
      typeof options.renderErrorView === 'function'
        ? options.renderErrorView(status, request, null, { status, message })
        : null;
    if (rendered != null) {
      return {
        status,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          allow,
          'cache-control': 'no-cache, private',
        },
        setCookie: [],
        body: String(rendered),
      };
    }
    // No compiled view: Laravel's own answer for an expectsJson request is
    // `prepareJsonResponse` (the message above, JSON_PRETTY_PRINT - 4 spaces,
    // no trailing newline), else the framework's HTML page. The edge ships a
    // minimal HTML page instead of the framework's bytes (the same rule the
    // HttpError branch below follows).
    if (requestExpectsJson(request)) {
      return {
        status,
        headers: {
          'content-type': 'application/json',
          allow,
          'cache-control': 'no-cache, private',
        },
        setCookie: [],
        body: phpJsonEncodeWithFlags({ message }, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES),
      };
    }
    return {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        allow,
        'cache-control': 'no-cache, private',
      },
      setCookie: [],
      body: '<html><body><h1>405</h1><p>Method Not Allowed</p></body></html>',
    };
  }
  request.setRoute(matched.route, matched.params);

  // Static / snapshot routes have no compiled handler: the prerendered HTML is
  // served straight from the asset bundle, so no session or cookie work happens.
  // (Documented deviation: those responses carry no session cookie.)
  const handlerKey = routeKey(matched.route);
  const hasHandler =
    typeof handlers.get === 'function'
      ? typeof handlers.get(handlerKey) === 'function'
      : Object.prototype.hasOwnProperty.call(handlers, handlerKey);
  if (!hasHandler) return null;

  // Laravel only runs the `web` group (EncryptCookies → StartSession → CSRF) on
  // routes that carry it. Anything else dispatches bare: no session, no cookie
  // wrapping, no CSRF. A route that needs the session would silently diverge, so
  // it fails loud instead.
  const stageNames = (matched.route.middleware || []).map((m) => String(m).split(':')[0]);
  if (!stageNames.includes('web')) {
    const needsSession = stageNames.filter((n) => n === 'auth' || n === 'guest' || n === 'throttle');
    if (needsSession.length) {
      throw new HttpError(
        `route middleware [${needsSession.join(', ')}] needs the session, but ${matched.route.uri} is not in the web group.`,
        500
      );
    }
    const bare = toHttpResponse(
      await dispatch(matchReq, table, handlers, env, {
        db,
        models,
        ctxRequest: request,
        // The compiled handler renders a status error through the compiled
        // error views (`ctx.renderErrorView`); without it the catch answers a
        // status-only text body where Laravel renders the framework's page.
        ctxExtra: { renderErrorView: options.renderErrorView || null },
      })
    );
    withDefaultCacheControl(bare);
    return { status: bare.status, headers: bare.headers, setCookie: [], body: bare.body };
  }

  // --- EncryptCookies (request phase) -------------------------------------
  const encryptor = createCookieEncryptor({
    keyBase64: appKey,
    except: config['cookies.except'] ?? [],
  });
  request.setCookies(await encryptor.decryptRequestCookies(request.cookiesRaw()));

  // --- StartSession -------------------------------------------------------
  const jar = new CookieJar({
    path: config['session.path'] ?? '/',
    domain: config['session.domain'] ?? null,
    secure: config['session.secure'] ?? null,
    sameSite: config['session.same_site'] ?? null,
    clock: nowS,
  });
  let authRef = null;
  const store = createSessionStore({
    config,
    request,
    jar,
    db,
    clock: nowS,
    randomString: options.randomString,
    // Late-bound: the auth manager is built after the store, but the handler's
    // `user_id` column is only read at save() time (like Laravel's
    // DatabaseSessionHandler::userId()).
    userId: async () => (authRef === null ? null : await authRef.guard().id()),
  });
  request.setSession(store);
  await store.start();

  // --- auth manager ------------------------------------------------------
  const auth = createAuthManager({
    config: resolveAuthConfig(config, models),
    db,
    session: store,
    request,
    cookieJar: jar,
    events: options.events ?? null,
    hasher: createHasher(config),
    strRandom: options.strRandom || ((n) => phpRandomString(n)),
    timeboxDuration: config['auth.timebox_duration'] ?? null,
    rehashOnLogin: config['auth.rehash_on_login'] ?? null,
    hashKey: config['auth.hash_key'] ?? null,
    // registry.json → "guards": a driver the app implements in JS is answered
    // through PortedGuard (kernel/auth.mjs) — the `auth:seal` middleware and
    // `auth()->user()` in a compiled controller/view then work unchanged.
    guardPorts: options.guardPorts ?? null,
    env,
    models,
  });
  request.setUserResolver(() => auth.guard().user());
  authRef = auth;
  if (typeof options.onAuth === 'function') options.onAuth(auth, request);

  let limiterInstance = null;
  const limiterFor = () => {
    if (limiterInstance) return limiterInstance;
    if (!cache) {
      throw new HttpError(
        'throttle middleware needs a cache store (options.cache / D1-backed) — not wired yet.',
        500
      );
    }
    limiterInstance = new RateLimiter(cache, { clock: nowS });
    return limiterInstance;
  };

  const redirectFactory = (url) =>
    new HttpResponse({
      status: 302,
      headers: { location: absoluteUrl(request.schemeAndHttpHost(), url) },
    });

  const ctx = {
    auth,
    store,
    config,
    routeRegistry,
    redirectFactory,
    limiterFactory: limiterFor,
    renderErrorView: options.renderErrorView || null,
    loginUri: () => {
      const uri = routeRegistry.route('login');
      return uri === null ? null : uri;
    },
  };

  // --- route middleware stages -------------------------------------------
  const stages = middlewareStages(matched.route.middleware || [], ctx);
  const core = async (req) => {
    const res = await dispatch(
      {
        method: request.realMethod(),
        methodOverride: request.methodOverride() || undefined,
        path: request.pathInfo() + (request.getQueryString() ? '?' + request.getQueryString() : ''),
        host: request.host(),
        headers: request.headersAll(),
      },
      table,
      handlers,
      env,
      {
        db,
        models,
        ctxRequest: request,
        ctxExtra: {
          session: store,
          // The compiled controller reads the config from the HTTP context.
          config,
          cache,
          auth,
          user: () => auth.guard().user(),
          route: matched.route,
          routeParams: matched.params,
          // Named-route resolution (UrlGenerator::route()): the same registry
          // the kernel's own `guest` middleware and `redirect()->route()` use.
          // A port that must build a URL (`route('login')`, `intended()`) reads
          // it here; without it those helpers silently fall back to `/`.
          routeRegistry,
          // The request clock — the compiled model timestamps follow it.
          clock: nowS,
          // The service adapters (storage/mail/queue) the worker hands down.
          storage: options.storage || null,
          // Laravel's CookieJar (AddQueuedCookiesToResponse): the ONLY way a
          // handler sets a cookie that survives this kernel - the response
          // pipeline emits `finalCookies` from the jar, so a raw `set-cookie`
          // header on the returned response is dropped.
          cookieJar: jar,
          log: options.log || null,
          mail: options.mail || null,
          queue: options.queue || null,
          // The compiled error views: a status error caught INSIDE the compiled
          // handler renders the same page the kernel's own renderer would.
          renderErrorView: options.renderErrorView || null,
        },
      }
    );
    return toHttpResponse(res);
  };
  const chain = buildChain(stages, core, (req, e) => renderException(e, req, ctx));

  // --- PreventRequestForgery (request phase) -----------------------------
  // `->withMiddleware(fn (Middleware $m) => $m->preventRequestForgery(
  //      originOnly: true, allowSameSite: true))` sets two STATICS on
  // PreventRequestForgery (Foundation/Configuration/Middleware.php:605-612)
  // which the middleware reads at :151 (allowSameSite) and :155/:205
  // (originOnly). They are process-wide in PHP, so the app's one-shot boot is
  // the same as applying the dumped config here - both dumps wrote
  // `csrf.allow_same_site` / `csrf.origin_only` and nothing read them, so
  // `originOnly: true` silently kept the token check and the XSRF cookie
  // (audit #801).
  PreventRequestForgery.setAllowSameSite(config['csrf.allow_same_site'] === true);
  PreventRequestForgery.useOriginOnly(config['csrf.origin_only'] === true);
  const csrf = new PreventRequestForgery({
    except: config['csrf.except'] ?? [],
    sessionConfig: {
      lifetime: config['session.lifetime'] ?? 120,
      path: config['session.path'] ?? '/',
      domain: config['session.domain'] ?? null,
      secure: config['session.secure'] ?? false,
      http_only: config['session.http_only'] ?? true,
      same_site: config['session.same_site'] ?? null,
    },
    keyBase64: appKey,
    clock: nowS,
  });

  let response;
  let csrfPassed = false;
  try {
    if (
      csrf.isReading(request) ||
      csrf.inExceptArray(request) ||
      csrf.hasValidOrigin(request) ||
      (await csrf.tokensMatch(request))
    ) {
      csrfPassed = true;
      response = toHttpResponse(await chain(request));
    } else {
      throw new TokenMismatchError('CSRF token mismatch.');
    }
  } catch (e) {
    // A render that already failed inside the chain must keep failing loud —
    // re-rendering the HttpError here would downgrade it to a 500 body.
    if (e && e.lwRenderFailed) throw e;
    response = await renderException(e, request, ctx);
  }

  // --- response phases (StartSession → AddQueuedCookiesToResponse → EncryptCookies)
  withDefaultCacheControl(response);
  // Symfony's RedirectResponse removes the computed default Cache-Control for a
  // 301 (RedirectResponse::__construct: `301 == $status && !array_key_exists('cache-control', $headers)`),
  // so the header injected by the constructor has to be told apart from one the
  // app set itself — only the injected one is removed.
  if (response.status === 301 && response.headers.location !== undefined && response.injectedCacheControl) {
    delete response.headers['cache-control'];
  }
  if (csrfPassed && csrf.shouldAddXsrfTokenCookie()) {
    await csrf.addCookieToResponse(request, response);
  }
  // StartSession::storeCurrentUrl (vendor-exact): only a GET that matched a real
  // route, and not an ajax / prefetch / precognitive request.
  if (
    request.method() === 'GET' &&
    request.route() &&
    !request.ajax() &&
    !request.prefetch() &&
    !request.isPrecognitive()
  ) {
    store.setPreviousUrl(request.fullUrl());
    store.setPreviousRoute(request.route().name ?? null);
  }
  // Symfony's RedirectResponse renders the target URL into an HTML body and sets
  // the content type (RedirectResponse::setTargetUrl).
  if (
    response.body === '' &&
    response.headers.location !== undefined &&
    REDIRECT_STATUSES.has(response.status)
  ) {
    // Laravel's Redirector resolves every target through UrlGenerator::to(), so a
    // controller `redirect('/x')` / `redirect()->intended()` still yields an
    // absolute Location (and the Symfony HTML body mirrors it). Idempotent for
    // targets that are already absolute (renderException already resolves those).
    response.headers.location = absoluteUrl(request.schemeAndHttpHost(), response.headers.location);
    response.body = symfonyRedirectBody(response.headers.location);
    response.headers['content-type'] = 'text/html; charset=utf-8';
  }
  // Symfony's Response::prepare() adds the default cache-control to every
  // response that is not a redirect (a redirect carries none).
  if (!REDIRECT_STATUSES.has(response.status)) {
    withDefaultCacheControl(response);
  }
  if (sessionPersistent(config)) {
    response.cookies.set(sessionCookie(config, store, nowS));
  }
  await store.save();
  for (const cookie of jar.getQueuedCookies()) response.cookies.set(cookie);

  const encrypted = await encryptor.encryptResponseCookies(response.cookies.list());
  const finalCookies = new ResponseCookies();
  for (const c of encrypted) finalCookies.set(c);
  response.cookies = finalCookies;

  return {
    status: response.status,
    headers: response.headers,
    setCookie: finalCookies.list().map((c) => serializeCookie(c, nowS())),
    body: response.body,
  };
}

export default {
  HttpError,
  HttpResponse,
  buildRequest,
  parsePhpQuery,
  dataGet,
  handleHttp,
  makeRouteRegistry,
  absoluteUrl,
  toHttpResponse,
};
