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

import { match, dispatch, routeKey } from './router.mjs';
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
import { phpJsonDecode } from './php-json.mjs';
import {
  ValidationException,
  installValidation,
  sessionErrorBag,
  DEFAULT_DONT_FLASH,
} from './validation.mjs';

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

/** (float) cast — numeric string prefix, 0.0 otherwise. */
function phpFloatCast(value) {
  if (value === null || value === undefined || value === false) return 0;
  if (value === true) return 1;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const m = PHP_FLOAT_PREFIX_RE.exec(String(value));
  if (!m) return 0;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : 0;
}

/** Arr::set($target, $key, $value) subset (dot notation); `forget` deletes. */
function arrSetRef(target, key, value, forget) {
  const segments = String(key).split('.');
  let current = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (!isPlainObject(current[seg])) current[seg] = {};
    current = current[seg];
  }
  const last = segments[segments.length - 1];
  if (forget) delete current[last];
  else current[last] = value;
  return target;
}

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
  const bag = {};
  Object.defineProperty(bag, '__order', { value: [], writable: true, enumerable: false, configurable: true });
  return bag;
}

function isBag(node) {
  return node !== null && typeof node === 'object' && !Array.isArray(node);
}

function bagOrder(node) {
  return Object.prototype.hasOwnProperty.call(node, '__order') ? node.__order : Object.keys(node);
}

/** Assign, recording insertion order (PHP keeps a key's first position). */
function bagSet(node, key, value) {
  if (!Object.prototype.hasOwnProperty.call(node, key)) bagOrder(node).push(key);
  node[key] = value;
}

/** The key `$a[]` uses: the next free integer index (max int key + 1, else 0). */
function appendKey(node) {
  let max = -1;
  for (const k of bagOrder(node)) if (PHP_INT_KEY.test(k)) max = Math.max(max, Number(k));
  return String(max + 1);
}

/** Ensure a nested container at `key` (PHP replaces a scalar with an array). */
function ensureBag(node, key) {
  const cur = node[key];
  if (!isBag(cur)) bagSet(node, key, newBag());
  return node[key];
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
  for (const k of order) node[k] = normalizePhpArrays(node[k]);
  if (order.length > 0 && order.every((k, i) => PHP_INT_KEY.test(k) && Number(k) === i)) {
    return order.map((k) => node[k]);
  }
  return node;
}

/**
 * PHP parse_str() subset used for query strings and form bodies.
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
    const { base, segs } = parseNameSegments(name);
    if (!segs) {
      bagSet(out, base, value);
      continue;
    }
    if (segs.length === 0) {
      bagSet(out, base, value);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(out, base) || !isBag(out[base])) {
      bagSet(out, base, newBag());
    }
    setNested(out[base], segs, value);
  }
  return normalizePhpArrays(out);
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

export function buildRequest(raw, options = {}) {
  const rawMethod = String((raw && raw.method) || 'GET').toUpperCase();
  const urlString = String((raw && raw.url) || '');
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

  const body = raw && raw.body != null ? String(raw.body) : '';
  const contentType = (headers.get('content-type') || '').toLowerCase();
  const contentTypeFormat = contentType.split(';')[0].trim();
  const isJson = contentTypeFormat === 'application/json' || contentTypeFormat.endsWith('+json');
  let post = {};
  let json = null;
  if (body !== '' && rawMethod !== 'GET' && rawMethod !== 'HEAD') {
    if (isJson) {
      try {
        const decoded = phpJsonDecode(body);
        json = decoded;
        if (isPlainObject(decoded)) post = decoded;
      } catch {
        json = null;
      }
    } else if (contentTypeFormat === '' || contentTypeFormat === 'application/x-www-form-urlencoded') {
      post = parsePhpQuery(body);
    } else if (contentTypeFormat === 'multipart/form-data') {
      throw new HttpError('multipart/form-data request bodies are not supported by the compiled rung yet.', 500);
    } else {
      throw new HttpError(`unsupported request content-type: ${contentTypeFormat}`, 500);
    }
  }

  // Symfony honours `_method` (body/query) for POST, plus the header form here.
  let methodOverride = null;
  if (rawMethod === 'POST') {
    const candidate = post._method ?? query._method ?? null;
    const headerOverride = headers.get('x-http-method-override');
    const chosen = candidate != null && candidate !== '' ? candidate : headerOverride;
    if (chosen != null && chosen !== '') methodOverride = String(chosen).toUpperCase();
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

  const inputSource = () => {
    if (isJson && json !== null) return json;
    if (rawMethod === 'GET' || rawMethod === 'HEAD') return query;
    return post;
  };

  // InteractsWithData support (see phpKeyList/phpFilterVarBoolean above).
  const inputSourceSafe = () => inputSource();
  const inputHas = (key) => dataGet(inputSourceSafe(), key, ARR_MISSING) !== ARR_MISSING;
  const inputMissing = (key) => dataGet(inputSourceSafe(), key, ARR_MISSING) === ARR_MISSING;
  const isEmptyString = (key) => {
    const v = dataGet(inputSourceSafe(), key, null);
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
      const source = inputSource();
      if (key === null) return source;
      return dataGet(source, key, def);
    },
    query(key = null, def = null) {
      if (key === null) return query;
      return dataGet(query, key, def);
    },
    post(key = null, def = null) {
      if (key === null) return post;
      return dataGet(post, key, def);
    },
    json(key = null, def = null) {
      if (key === null) return json;
      return dataGet(json ?? {}, key, def);
    },
    has(key) {
      const source = inputSource();
      if (Array.isArray(key)) return key.every((k) => dataGet(source, k, undefined) !== undefined);
      return dataGet(source, key, undefined) !== undefined;
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
    all() {
      return Object.assign({}, inputSource());
    },
    // --- InteractsWithData (Illuminate\Support\Traits\InteractsWithData) ----
    // `has`/`all` above predate this block; the accessors below mirror the trait
    // exactly (rest args collapse to `$keys` via phpKeyList, which reproduces
    // `is_array($keys) ? $keys : func_get_args()`).
    hasAny(...args) {
      return phpKeyList(args).some((k) => inputHas(k));
    },
    filled(...args) {
      return phpKeyList(args).every((k) => !isEmptyString(k));
    },
    isNotFilled(...args) {
      return phpKeyList(args).every((k) => isEmptyString(k));
    },
    missing(...args) {
      return !phpKeyList(args).every((k) => !inputMissing(k));
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
    if (!Object.prototype.hasOwnProperty.call(this.headers, 'cache-control')) {
      this.headers['cache-control'] = 'no-cache, private';
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

/** UrlGenerator::to() subset — absolute target against the request root. */
export function absoluteUrl(root, path) {
  const p = String(path ?? '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p;
  const base = String(root).replace(/\/+$/, '');
  if (p === '' || p === '/') return base || '/';
  return base + (p.startsWith('/') ? p : '/' + p);
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
    const intended =
      request.method() === 'GET' && request.route() && !requestExpectsJson(request)
        ? request.fullUrl()
        : ctx.store.previousUrl() || request.header('referer') || null;
    if (intended) ctx.store.put('url.intended', intended);
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
        body: JSON.stringify({ message: error.message, errors: error.errors() }),
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

    // RedirectResponse::withInput() — flash everything except Handler::$dontFlash.
    const input = request.all();
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
        body: JSON.stringify({ message: error.message }),
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
  throw error;
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

function symfonyRedirectBody(url) {
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
  const request = buildRequest(raw, { clientIp: options.clientIp });
  // $request->validate() / validateWithBag() — compiled controllers call these
  // through rt.request(); the rule engine gets the D1 binding for unique/exists.
  installValidation(request, { db });

  const matchReq = {
    method: request.realMethod(),
    methodOverride: request.methodOverride() || undefined,
    path: request.pathInfo() + (request.getQueryString() ? '?' + request.getQueryString() : ''),
    host: request.host(),
    headers: request.headersAll(),
  };
  const matched = match(table, matchReq);
  if (!matched) return null;
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
      await dispatch(matchReq, table, handlers, env, { db, models, ctxRequest: request })
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
          cache,
          auth,
          user: () => auth.guard().user(),
          route: matched.route,
          routeParams: matched.params,
          // The request clock — the compiled model timestamps follow it.
          clock: nowS,
          // The service adapters (storage/mail/queue) the worker hands down.
          storage: options.storage || null,
  log: options.log || null,
          mail: options.mail || null,
          queue: options.queue || null,
        },
      }
    );
    return toHttpResponse(res);
  };
  const chain = buildChain(stages, core, (req, e) => renderException(e, req, ctx));

  // --- PreventRequestForgery (request phase) -----------------------------
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
