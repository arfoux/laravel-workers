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
} from './auth.mjs';
import { phpJsonDecode } from './php-json.mjs';

export class HttpError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
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

  let cookies = {};
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

function middlewareStages(list, ctx) {
  const stages = [];
  for (const raw of list || []) {
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

function buildChain(stages, core) {
  return stages.reduceRight((next, stage) => (req) => stage(req, next), core);
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
  if (error instanceof TokenMismatchError) {
    // Laravel renders 419 through the exception handler: JSON for expectsJson
    // (`{"message":"CSRF token mismatch."}`), the app's errors/419 view otherwise.
    // The compiled rung ships no error views, so the HTML body is a plain stub.
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
    return new HttpResponse({
      status: error.status,
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
      body: error.message,
    });
  }
  throw error;
}

// ---------------------------------------------------------------------------
// redirect rendering (Symfony RedirectResponse)
// ---------------------------------------------------------------------------

// Symfony\Component\HttpFoundation\Response::isRedirect()
const REDIRECT_STATUSES = new Set([201, 301, 302, 303, 307, 308]);

// Symfony\Component\HttpFoundation\RedirectResponse::setTargetUrl() renders the
// target URL into an HTML body with `htmlspecialchars($url, ENT_QUOTES, 'UTF-8')`
// (LF newlines, matching the vendor template byte for byte).
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
    routeRegistry,
    redirectFactory,
    limiterFactory: limiterFor,
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
          auth,
          user: () => auth.guard().user(),
          route: matched.route,
          routeParams: matched.params,
        },
      }
    );
    return toHttpResponse(res);
  };
  const chain = buildChain(stages, core);

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
    response.body = symfonyRedirectBody(response.headers.location);
    response.headers['content-type'] = 'text/html; charset=utf-8';
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
