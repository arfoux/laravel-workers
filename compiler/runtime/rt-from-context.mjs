// compiler/runtime/rt-from-context.mjs — Runtime helpers (context → rt)
import { validationExceptionWithMessages, sessionErrorBag, DEFAULT_DONT_FLASH } from '../../kernel/validation.mjs';
import * as hashMod from '../../kernel/hash.mjs';

// env() -> the config key: the build-time config dump is the padanan for env()
// at the edge (there is no .env there). Keep in sync with tools/config-dump.php.
const ENV_CONFIG_KEYS = {
  APP_ENV: 'app.env',
  APP_DEBUG: 'app.debug',
  APP_KEY: 'app.key',
  APP_URL: 'app.url',
};
export function buildRt(context, opts = {}) {
  const strict = !!(opts && opts.strict);
  const ctx = context || {};
  const warnings = [];

  const rt = { __warnings: warnings, __strict: strict, __output: '' };

  // ---- helpers for legacy/enriched compat ----
  const has = (k) => Object.prototype.hasOwnProperty.call(ctx, k) && ctx[k] != null;

  // app
  let appCtx = has('app') ? ctx.app : null;
  if (!appCtx && has('app_version')) {
    appCtx = { version: ctx.app_version, locale: 'en' };
    warnings.push('app: derived from app_version (legacy shape)');
  }
  if (!appCtx) {
    appCtx = { version: '', locale: 'en' };
    warnings.push('app: missing, using empty fallback');
  }

  // files / vfs
  let filesCtx = has('files') ? ctx.files : null;
  if (!filesCtx && has('vfs')) {
    filesCtx = ctx.vfs;
    warnings.push('files: derived from vfs (legacy shape)');
  }
  if (!filesCtx) {
    filesCtx = {};
    warnings.push('files: missing, using empty fallback');
  }

  // vite
  let viteCtx = has('vite') ? ctx.vite : null;
  if (!viteCtx) {
    viteCtx = { fonts: '', invoke: '' };
    warnings.push('vite: missing, fonts/invoke default to empty');
  }

  // auth
  let authCtx = has('auth') ? ctx.auth : null;
  if (!authCtx) {
    authCtx = { check: false };
    warnings.push('auth: missing, check defaults to false');
  }

  // urls
  let urlsCtx = has('urls') ? ctx.urls : null;
  if (!urlsCtx) {
    urlsCtx = {};
    warnings.push('urls: missing, url()/route() will throw when called');
  }

  // route_names
  let routeNames = has('route_names') ? ctx.route_names : null;
  if (!routeNames && Array.isArray(ctx.routes)) {
    routeNames = ctx.routes.map((r) => r && r.name).filter((n) => n != null);
    warnings.push('route_names: derived from routes (legacy shape)');
  }
  if (!Array.isArray(routeNames)) {
    routeNames = [];
    warnings.push('route_names: missing, using empty');
  }

  // config
  // A compiled controller calls buildRt(null, { ... http: ctx }) - the config
  // lives on the HTTP context the kernel hands down (the flat dotted map).
  let configCtx = has('config') ? ctx.config : null;
  if (!configCtx && opts && opts.http && opts.http.config) configCtx = opts.http.config;
  if (!configCtx) configCtx = {};

  // ---- phpNumStr (PHP-style float formatting) ----
  const phpNumStr = (v) => {
    if (Number.isInteger(v)) return String(v);
    const s = v.toPrecision(14);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  };

  // ---- rt.echo (PHP echo semantics) ----
  rt.echo = (v) => {
    if (v instanceof Promise) {
      throw new Error('unresolved promise rendered — await the query in a single chain (Post::where(...)->get())');
    }
    let s;
    if (v === null || v === undefined) s = '';
    else if (v === true) s = '1';
    else if (v === false) s = '';
    else if (typeof v === 'number') s = phpNumStr(v);
    else s = String(v);
    rt.__output += s;
    return s;
  };

  // ---- rt.e (htmlspecialchars) ----
  rt.e = (v) => {
    let s;
    if (v === null || v === undefined) s = '';
    else if (v === true) s = '1';
    else if (v === false) s = '';
    else if (typeof v === 'number') s = phpNumStr(v);
    else if (Array.isArray(v)) s = 'Array';
    else if (typeof v === 'object') s = 'Object';
    else s = String(v);
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  // ---- rt.str_replace ----
  rt.str_replace = (a, b, s) => {
    const needle = String(a);
    const subject = String(s);
    if (needle === '') return subject;
    return subject.split(needle).join(String(b));
  };

  // ---- rt.add (PHP arithmetic +) ----
  const phpToNum = (v) => {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return v;
    const n = Number(String(v).trim());
    return isNaN(n) ? 0 : n;
  };
  rt.add = (a, b) => phpToNum(a) + phpToNum(b);

  // ---- rt.concat (PHP string cast + concat) ----
  const phpToStr = (v) => {
    if (v === null || v === undefined) return '';
    if (v === true) return '1';
    if (v === false) return '';
    if (typeof v === 'number') return phpNumStr(v);
    if (Array.isArray(v)) return 'Array';
    if (typeof v === 'object') return 'Object';
    return String(v);
  };
  rt.concat = (a, b) => phpToStr(a) + phpToStr(b);

  // ---- rt.config ----
  rt.config = (k, d) => {
    if (Object.prototype.hasOwnProperty.call(configCtx, k)) return configCtx[k];
    if (arguments.length >= 2) return d;
    throw new Error('config: missing key ' + JSON.stringify(k) + ' with no default');
  };

  // ---- rt.app ----
  rt.app = (name) => {
    if (name === undefined) {
      return {
        version: () => appCtx.version,
        getLocale: () => appCtx.locale,
      };
    }
    const key = String(name);
    if (key.indexOf('Illuminate\\Foundation\\Vite') !== -1 || key.indexOf('Illuminate/Foundation/Vite') !== -1) {
      const invoke = viteCtx.invoke;
      const fonts = viteCtx.fonts;
      const shim = (entries) => invoke;
      shim.fonts = () => fonts;
      return shim;
    }
    throw new Error('app: unsupported service ' + JSON.stringify(name));
  };

  // ---- rt.public_path ----
  rt.public_path = (p) => p;

  // ---- rt.file_exists ----
  rt.file_exists = (p) => {
    const key = String(p);
    if (Object.prototype.hasOwnProperty.call(filesCtx, key)) return !!filesCtx[key];
    throw new Error('file_exists: unknown path ' + JSON.stringify(key));
  };

  // ---- rt.Route ----
  rt.Route = { has: (n) => routeNames.indexOf(n) !== -1 };

  // ---- rt.session / rt.request / rt.auth (compiled HTTP context) ----
  // `opts.http` is the request context handed down by the HTTP kernel
  // (`{ request, session, auth, user, route, routeParams }`). When it is
  // present these helpers read the live session/guard; when it is absent
  // (static snapshot or build-time evaluation) they fall back to the captured
  // context and the session/request helpers fail loud rather than invent state.
  const liveSession = (opts && opts.http && opts.http.session) ? opts.http.session : null;
  const liveRequest = (opts && opts.http && opts.http.request) ? opts.http.request : null;
  const liveAuth = (opts && opts.http && opts.http.auth) ? opts.http.auth : null;
  const liveCache = (opts && opts.http && opts.http.cache) ? opts.http.cache : null;
  // The request clock (integer seconds) — the model timestamps follow it.
  const requestClock =
    opts && opts.http && typeof opts.http.clock === 'function' ? opts.http.clock : null;
  // The service adapters the worker hands down (storage/mail/queue).
  const liveStorage = (opts && opts.http && opts.http.storage) ? opts.http.storage : null;
  // The log sink the platform hands down (the worker: the Workers console).
  const liveLog =
    (opts && opts.http && typeof opts.http.log === 'function') ? opts.http.log : null;
  const liveMail = (opts && opts.http && opts.http.mail) ? opts.http.mail : null;
  const liveQueue = (opts && opts.http && opts.http.queue) ? opts.http.queue : null;

  const noHttp = (fn) => {
    throw new Error(fn + '(): no HTTP context (static snapshot / build-time evaluation)');
  };
  rt.request = () => (liveRequest || noHttp('request'));
  rt.session = () => (liveSession || noHttp('session'));
  // back(): the session's url.previous, else the Referer, else the fallback.
  rt.back = (fallback = '/') => {
    const previous =
      liveSession && typeof liveSession.previousUrl === 'function' ? liveSession.previousUrl() : null;
    const referer =
      liveRequest && typeof liveRequest.header === 'function' ? liveRequest.header('referer') : null;
    return rt.redirect(previous || referer || fallback);
  };
  // data_get(): the dot/array access (the `*` wildcard is not ported).
  rt.dataGet = (target, key, def = null) => {
    if (key === null || key === undefined) return target;
    const parts = String(key).split('.');
    let cur = target;
    for (const part of parts) {
      if (cur === null || cur === undefined) return def;
      if (Array.isArray(cur)) {
        const idx = Number(part);
        if (!Number.isInteger(idx)) return def;
        cur = cur[idx];
        continue;
      }
      if (typeof cur !== 'object') return def;
      if (!Object.prototype.hasOwnProperty.call(cur, part)) return def;
      cur = cur[part];
    }
    return cur === undefined ? def : cur;
  };
  // tap(): the value through a closure (Laravel returns the value).
  rt.tap = (value, callback) => {
    if (typeof callback === 'function') callback(value);
    return value;
  };
  // report(): the platform log (it does not answer the exception).
  rt.report = (error) => {
    const message = error && error.message ? String(error.message) : String(error);
    if (liveLog) liveLog('error', message);
    return null;
  };
  // env(): the build-time config dump is the padanan (there is no .env at the edge).
  rt.env = (key, def = null) => {
    const cfgKey = ENV_CONFIG_KEYS[String(key)];
    if (!cfgKey) {
      throw new Error(
        'env(' + key + ') has no compiled counterpart - use config() (the build-time config dump is the padanan)'
      );
    }
    const value = rt.config(cfgKey);
    return value === undefined || value === null ? def : value;
  };
  rt.cache = () => {
    if (liveCache) return liveCache;
    if (opts && opts.http) throw new Error('cache(): no cache store configured (cache.driver !== "database" or no D1 binding)');
    return noHttp('cache');
  };
  // Storage:: — the object store (the padanan for the app's local disk): R2
  // when the app binds it, else the D1 blob store. Without either this fails
  // loud: a silent in-memory store would lose the writes at the end of the
  // isolate.
  rt.storage = () => {
    if (liveStorage) return liveStorage;
    if (opts && opts.http) throw new Error('storage(): no object store — bind R2 (env.R2) or D1 (env.DB); Storage:: needs object storage at the edge');
    return noHttp('storage');
  };
  // `new SomeException('msg')` - the PHP built-in exceptions. The compiled
  // side throws an error with the same class name and message; the handler
  // answers the same status (500) as Laravel.
  rt.newError = (className, message, code) => {
    const e = new Error(message === undefined || message === null ? '' : String(message));
    e.name = String(className);
    e.phpClass = String(className);
    if (code !== undefined && code !== null) e.code = Number(code);
    return e;
  };
  // throw_if()/throw_unless(): they throw the given error when the condition
  // says so, and answer null otherwise (like Laravel).
  rt.throwIf = (condition, error) => {
    if (condition) throw error;
    return null;
  };
  rt.throwUnless = (condition, error) => {
    if (!condition) throw error;
    return null;
  };
  // Log:: — the padanan is the platform log (the Workers console); the sink
  // comes from the HTTP context.
  rt.log = (level, message, context) => {
    if (liveLog) return liveLog(level, message, context);
    return null;
  };
  // Mail:: — the mailer (log/noop/resend).
  rt.mail = () => {
    if (liveMail) return liveMail;
    if (opts && opts.http) throw new Error('mail(): no mailer configured');
    return noHttp('mail');
  };
  // Queue:: — the queue (CF Queues or the in-memory fallback).
  rt.queue = () => {
    if (liveQueue) return liveQueue;
    if (opts && opts.http) throw new Error('queue(): no queue binding configured');
    return noHttp('queue');
  };
  // Laravel's old($key, $default) -> session()->getOldInput($key, $default).
  rt.old = (key, def = null) => (liveSession ? liveSession.getOldInput(key, def) : noHttp('old'));
  rt.csrf_token = () => rt.session().token();
  // Illuminate\Foundation\helpers.php csrf_field(): no escaping (the token is
  // Str::random(40), alphanumeric) — kept byte-exact.
  rt.csrf_field = () =>
    '<input type="hidden" name="_token" value="' + String(rt.session().token()) + '" autocomplete="off">';

  // Illuminate\Validation\ValidationException::withMessages([...]) — the compiled
  // kernel catches the same class instance (kernel/validation.mjs) and renders the
  // 302-back / 422 response, so `throw` works exactly like the PHP throw.
  rt.validationExceptionWithMessages = (messages, o) => validationExceptionWithMessages(messages, o);

  rt.auth = (name) => {
    if (liveAuth) {
      return {
        check: (n) => liveAuth.check(n ?? name),
        guest: (n) => liveAuth.guest(n ?? name),
        user: (n) => liveAuth.user(n ?? name),
        id: (n) => liveAuth.id(n ?? name),
        guard: (n) => liveAuth.guard(n ?? name),
        attempt: (c, r, n) => liveAuth.guard(n ?? name).attempt(c, r),
        once: (c, n) => liveAuth.guard(n ?? name).once(c),
        login: (u, r, n) => liveAuth.guard(n ?? name).login(u, r),
        logout: (n) => liveAuth.guard(n ?? name).logout(),
      };
    }
    const unsupported = (m) => () => {
      throw new Error(
        'auth()->' + m + '() needs the request context (compiled controller) — not available during static/build-time evaluation'
      );
    };
    return {
      check: () => !!authCtx.check,
      guest: () => !authCtx.check,
      user: unsupported('user'),
      id: unsupported('id'),
      attempt: unsupported('attempt'),
      once: unsupported('once'),
      login: unsupported('login'),
      logout: unsupported('logout'),
      guard: () => ({ check: () => !!authCtx.check, user: unsupported('guard()->user') }),
    };
  };

  // ---- rt.url / rt.route ----
  const runtime = !!(opts && opts.runtime);
  const origin = (opts && typeof opts.origin === 'string' && opts.origin) ? String(opts.origin).replace(/\/+$/, '') : '';
  const routeMap = (opts && opts.routeMap && typeof opts.routeMap === 'object') ? opts.routeMap : null;
  const modelRouteKey = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') {
      if (typeof v.get === 'function' && v.attributes) return v.get('id');
      if (v.id !== undefined) return v.id;
    }
    return v;
  };
  // Runtime route() generation: name → uri pattern (built at build time). Only used
  // when args are passed or when the captured build-time value does not apply.
  const genUrl = (name, args) => {
    if (!routeMap || !Object.prototype.hasOwnProperty.call(routeMap, name)) return null;
    const uri = String(routeMap[name]);
    let i = 0;
    const path = uri.split('/').map((seg) => {
      const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\??\}$/.exec(seg);
      if (!m) return seg;
      const raw = modelRouteKey(args[i++]);
      return encodeURIComponent(raw == null ? '' : String(raw));
    }).join('/');
    return origin + '/' + path;
  };
  const lookupUrl = (key) => {
    if (!Object.prototype.hasOwnProperty.call(urlsCtx, key)) {
      throw new Error('url/route: uncaptured ' + JSON.stringify(key));
    }
    const v = urlsCtx[key];
    if (v && typeof v === 'object' && v.error) throw new Error('url/route: ' + v.error);
    return v;
  };
  rt.url = (p) => {
    const s = String(p);
    if (runtime && s.startsWith('/')) return origin + s;
    return lookupUrl(s);
  };
  rt.route = (n, ...rest) => {
    const key = String(n);
    if (rest.length > 0) {
      const g = genUrl(key, rest);
      if (g != null) return g;
      throw new Error('route: uncaptured extra args');
    }
    if (runtime) {
      const g = genUrl(key, []);
      if (g != null) return g;
    }
    return lookupUrl(key);
  };

  // ---- builtins (flat on rt) ----
  rt.isset = (...args) => {
    // isset(var) — for our purposes, check args defined & not null
    if (args.length === 0) return false;
    for (const a of args) if (a === undefined || a === null) return false;
    return true;
  };
  rt.empty = (v) => {
    if (v === null || v === undefined) return true;
    if (typeof v === 'boolean') return v === false;
    if (typeof v === 'number') return v === 0;
    if (typeof v === 'string') return v === '' || v === '0';
    if (Array.isArray(v)) return v.length === 0;
    return false;
  };
  rt.unset = () => {}; // no-op in emitted code (variables are lets; M1 has none)
  rt.count = (v) => (Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0));
  rt.in_array = (needle, haystack, strict) => {
    const arr = Array.isArray(haystack) ? haystack : [];
    if (strict) return arr.some((x) => x === needle && typeof x === typeof needle);
    return arr.some((x) => x == needle); // eslint-disable-line eqeqeq
  };
  const isObj = (v) => v !== null && typeof v === 'object';
  const arrValues = (v) => (Array.isArray(v) ? v.slice() : (isObj(v) ? Object.keys(v).map((k) => v[k]) : []));
  rt.implode = (glue, arr) => arrValues(arr).map((x) => (x == null ? '' : String(x))).join(glue == null ? '' : String(glue));
  rt.explode = (delim, str, limit) => String(str).split(String(delim));
  rt.array_key_exists = (k, arr) => (isObj(arr) ? Object.prototype.hasOwnProperty.call(arr, k) : false);
  rt.array_keys = (arr) => (isObj(arr) ? Object.keys(arr).map((k) => (/^\d+$/.test(k) ? Number(k) : k)) : []);
  rt.array_values = (arr) => arrValues(arr);
  rt.array_merge = (...arrs) => {
    if (arrs.every((a) => Array.isArray(a))) {
      const out = [];
      for (const a of arrs) for (const v of a) out.push(v);
      return out;
    }
    const out = {};
    for (const a of arrs) if (isObj(a)) for (const k of Object.keys(a)) out[k] = a[k];
    return out;
  };
  rt.sprintf = (fmt, ...args) => {
    let i = 0;
    // collapse %% -> % first (PHP: literal percent)
    const withPlaceholders = String(fmt).replace(/%%/g, '\u0000');
    const out = withPlaceholders.replace(/%[sdu]/g, (m) => {
      const a = args[i++];
      if (m === '%d' || m === '%u') return String(parseInt(a, 10));
      return String(a == null ? '' : a);
    });
    return out.replace(/\u0000/g, '%');
  };
  rt.strtolower = (s) => String(s).toLowerCase();
  rt.strtoupper = (s) => String(s).toUpperCase();
  rt.trim = (s) => String(s).trim();

  // ---- byte-oriented string helpers (PHP length semantics) ----
  const utf8 = new TextEncoder();
  const utf8d = new TextDecoder();
  const byteLen = (s) => utf8.encode(String(s)).length;
  rt.strlen = (s) => (s == null ? 0 : byteLen(s));
  rt.substr = (s, start, len) => {
    const bytes = utf8.encode(s == null ? '' : String(s));
    const n = bytes.length;
    let st = Number(start) | 0;
    if (st < 0) st = Math.max(n + st, 0);
    if (st > n) st = n;
    let end = n;
    if (len !== undefined && len !== null) {
      const l = Number(len) | 0;
      end = l < 0 ? n + l : st + l;
    }
    if (end < st) end = st;
    if (end > n) end = n;
    return utf8d.decode(bytes.slice(st, end));
  };
  rt.str_repeat = (s, n) => String(s == null ? '' : s).repeat(Math.max(0, Number(n) | 0));
  rt.str_contains = (h, n, ci) => {
    const hay = String(h == null ? '' : h);
    const needle = String(n);
    if (needle === '') return true;
    if (ci) return hay.toLowerCase().includes(needle.toLowerCase());
    return hay.includes(needle);
  };
  rt.str_starts_with = (h, n, ci) => {
    const hay = String(h == null ? '' : h);
    const needle = String(n);
    if (needle === '') return true;
    if (ci) return hay.toLowerCase().startsWith(needle.toLowerCase());
    return hay.startsWith(needle);
  };
  rt.str_ends_with = (h, n, ci) => {
    const hay = String(h == null ? '' : h);
    const needle = String(n);
    if (needle === '') return true;
    if (ci) return hay.toLowerCase().endsWith(needle.toLowerCase());
    return hay.endsWith(needle);
  };
  rt.str_is = (pattern, value) => {
    const p = String(pattern == null ? '' : pattern);
    const v = String(value == null ? '' : value);
    // Laravel Str::is: * wildcard, case-sensitive, full-string match
    // Escape regex specials except *, then * -> .*
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$').test(v);
  };
  rt.ucfirst = (s) => {
    const x = String(s == null ? '' : s);
    return x === '' ? '' : x[0].toUpperCase() + x.slice(1);
  };
  rt.lcfirst = (s) => {
    const x = String(s == null ? '' : s);
    return x === '' ? '' : x[0].toLowerCase() + x.slice(1);
  };
  rt.str_pad = (s, len, pad, type) => {
    const x = String(s == null ? '' : s);
    const target = Math.max(0, Number(len) | 0);
    const cur = byteLen(x);
    if (cur >= target) return x;
    let p = pad === undefined || pad === null || pad === '' ? ' ' : String(pad);
    const need = target - cur;
    const fill = (count) => p.repeat(Math.ceil(count / p.length)).slice(0, count);
    const t = type === undefined ? 1 : Number(type);
    if (t === 0) return fill(need) + x; // STR_PAD_LEFT
    if (t === 2) {
      const left = Math.floor(need / 2);
      return fill(left) + x + fill(need - left); // STR_PAD_BOTH
    }
    return x + fill(need); // STR_PAD_RIGHT (default)
  };

  // ---- PHP truthiness / logic ----
  rt.truthy = (v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v !== '' && v !== '0';
    if (Array.isArray(v)) return v.length !== 0;
    if (typeof v === 'object') return Object.keys(v).length !== 0;
    return true;
  };
  rt.not = (v) => !rt.truthy(v);
  rt.and = (fa, fb) => (rt.truthy(fa()) ? rt.truthy(fb()) : false);
  rt.or = (fa, fb) => (rt.truthy(fa()) ? true : rt.truthy(fb()));

  // ---- PHP comparison semantics ----
  const isNumericStr = (s) => /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(s);
  const tagOf = (v) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return 'num';
    if (typeof v === 'string') return 'str';
    return 'arr';
  };
  const arrEmpty = (v) => (Array.isArray(v) ? v.length === 0 : (v && typeof v === 'object' ? Object.keys(v).length === 0 : true));

  rt.looseEq = (a, b) => {
    const ta = tagOf(a), tb = tagOf(b);
    if (ta === 'null' && tb === 'null') return true;
    if (ta === 'bool' || tb === 'bool') return rt.truthy(a) === rt.truthy(b);
    if (ta === 'null') {
      if (tb === 'num') return Number(b) === 0;
      if (tb === 'str') return b === '';
      if (tb === 'arr') return arrEmpty(b);
      return false;
    }
    if (tb === 'null') return rt.looseEq(b, a);
    if (ta === 'num' && tb === 'num') return a === b;
    if (ta === 'str' && tb === 'str') {
      if (isNumericStr(a) && isNumericStr(b)) return Number(a) === Number(b);
      return a === b;
    }
    if (ta === 'num' && tb === 'str') return isNumericStr(b) ? a === Number(b) : String(a) === String(b);
    if (ta === 'str' && tb === 'num') return isNumericStr(a) ? Number(a) === b : String(a) === String(b);
    return a === b;
  };
  rt.looseNe = (a, b) => !rt.looseEq(a, b);

  rt.strictEq = (a, b, la, lb) => {
    const na = a === undefined ? null : a;
    const nb = b === undefined ? null : b;
    const ta = tagOf(na), tb = tagOf(nb);
    if (ta !== tb) return false;
    if (ta === 'num' && (!!la !== !!lb)) return false;
    return na === nb;
  };
  rt.strictNe = (a, b, la, lb) => !rt.strictEq(a, b, la, lb);

  const numVal = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && isNumericStr(v) ? Number(v) : null));
  const relPair = (a, b) => {
    const na = numVal(a), nb = numVal(b);
    if (na !== null && nb !== null) return [na, nb];
    return [phpToStr(a), phpToStr(b)];
  };
  rt.lt = (a, b) => { const p = relPair(a, b); return p[0] < p[1]; };
  rt.gt = (a, b) => { const p = relPair(a, b); return p[0] > p[1]; };
  rt.lte = (a, b) => { const p = relPair(a, b); return p[0] <= p[1]; };
  rt.gte = (a, b) => { const p = relPair(a, b); return p[0] >= p[1]; };

  // ---- PHP arithmetic ----
  rt.sub = (a, b) => phpToNum(a) - phpToNum(b);
  rt.mul = (a, b) => phpToNum(a) * phpToNum(b);
  rt.div = (a, b) => phpToNum(a) / phpToNum(b);
  rt.mod = (a, b) => phpToNum(a) % phpToNum(b);
  rt.pow = (a, b) => Math.pow(phpToNum(a), phpToNum(b));

  // ---- null coalescing ----
  rt.coalesce = (a, b) => (a === null || a === undefined ? b : a);
  rt.coalesceAssign = (get, set, val) => { const cur = get(); if (cur === null || cur === undefined) set(val); return get(); };

  // ---- match (strict) ----
  rt.match = (v, ...arms) => {
    let dflt;
    for (const a of arms) {
      const conds = a[0], body = a[1];
      if (conds === null) { dflt = body; continue; }
      for (const c of conds) if (rt.strictEq(v, c, false, false)) return body();
    }
    if (dflt) return dflt();
    throw new Error('match: unhandled value');
  };

  // ---- foreach over PHP arrays/objects ----
  rt.entries = (src) => {
    if (src && typeof src === 'object') {
      const keyOf = (k) => (/^\d+$/.test(k) ? Number(k) : k);
      return Object.keys(src).map((k) => [keyOf(k), src[k]]);
    }
    return [];
  };

  // ---- type predicates ----
  const isNum = (v) => (typeof v === 'number' && !Number.isNaN(v)) || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)));
  rt.is_null = (v) => v === null || v === undefined;
  rt.is_bool = (v) => typeof v === 'boolean';
  rt.is_int = (v) => typeof v === 'number' && Number.isInteger(v);
  rt.is_float = (v) => typeof v === 'number' && !Number.isInteger(v);
  rt.is_string = (v) => typeof v === 'string';
  rt.is_array = (v) => Array.isArray(v) || isObj(v);
  rt.is_object = (v) => isObj(v) && !Array.isArray(v);
  rt.is_numeric = isNum;
  rt.is_callable = (v) => typeof v === 'function';
  rt.is_countable = (v) => Array.isArray(v) || isObj(v);
  rt.is_boolean = rt.is_bool;
  rt.is_integer = rt.is_int;
  rt.is_long = rt.is_int;
  rt.is_double = rt.is_float;
  rt.is_real = rt.is_float;

  // ---- numbers ----
  rt.abs = (v) => Math.abs(Number(v));
  const phpRound = (x, p) => {
    const m = Math.pow(10, p);
    const v = x * m;
    return (v < 0 ? -Math.round(-v) : Math.round(v)) / m;
  };
  rt.round = (v, p) => phpRound(Number(v), p == null ? 0 : Number(p) | 0);
  rt.floor = (v) => Math.floor(Number(v));
  rt.ceil = (v) => Math.ceil(Number(v));
  rt.intval = (v, base) => {
    if (typeof v === 'number') return Math.trunc(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    const s = String(v == null ? '' : v).trim();
    const b = base == null ? 10 : Number(base) || 10;
    const re = b === 16 ? /^[+-]?(0x)?[0-9a-f]+/i : b === 8 ? /^[+-]?[0-7]+/ : /^[+-]?\d+/;
    const m = s.match(re);
    return m ? parseInt(m[0], b) : 0;
  };
  rt.floatval = (v) => {
    if (typeof v === 'number') return v;
    const m = String(v == null ? '' : v).trim().match(/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  };
  const maxMin = (dir, a) => {
    const vals = a.length === 1 && Array.isArray(a[0]) ? a[0] : a;
    let best = vals[0];
    for (const v of vals) if (dir > 0 ? Number(v) > Number(best) : Number(v) < Number(best)) best = v;
    return best;
  };
  rt.max = (...a) => maxMin(1, a);
  rt.min = (...a) => maxMin(-1, a);

  // ---- strings (continued) ----
  const PHP_WS = ' \t\n\r\u0000\u000B';
  const trimChars = (s, chars, dir) => {
    const set = new Set(chars.split(''));
    const a = String(s == null ? '' : s).split('');
    let i = 0, j = a.length;
    if (dir !== 'r') while (i < j && set.has(a[i])) i++;
    if (dir !== 'l') while (j > i && set.has(a[j - 1])) j--;
    return a.slice(i, j).join('');
  };
  rt.ltrim = (s, chars) => trimChars(s, chars == null ? PHP_WS : String(chars), 'l');
  rt.rtrim = (s, chars) => trimChars(s, chars == null ? PHP_WS : String(chars), 'r');
  rt.ucwords = (s) => String(s == null ? '' : s).replace(/(^|[ \t\r\n\f\u000B])(\S)/g, (m, p, c) => p + c.toUpperCase());
  rt.strrev = (s) => String(s == null ? '' : s).split('').reverse().join('');
  rt.strpos = (h, n, off) => {
    const i = String(h == null ? '' : h).indexOf(String(n), off == null ? 0 : Number(off) | 0);
    return i < 0 ? false : i;
  };
  rt.strrpos = (h, n, off) => {
    const s = String(h == null ? '' : h);
    const from = off == null ? s.length : Number(off) | 0;
    const i = s.lastIndexOf(String(n), from);
    return i < 0 ? false : i;
  };
  rt.substr_count = (h, n, off, len) => {
    const s = String(h == null ? '' : h).slice(off == null ? 0 : Number(off) | 0);
    const needle = String(n);
    if (needle === '') return 0;
    let count = 0, i = 0;
    for (;;) {
      const at = s.indexOf(needle, i);
      if (at < 0) break;
      count++;
      i = at + needle.length;
    }
    return count;
  };
  rt.strip_tags = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '');
  rt.htmlspecialchars = (s) => (s == null ? '' : rt.e(s));

  // ---- json ----
  rt.json_encode = (v) => JSON.stringify(v == null ? null : v).replace(/\//g, '\\/');
  rt.json_decode = (s, assoc) => JSON.parse(String(s));

  // ---- more array helpers ----
  rt.array_sum = (arr) => arrValues(arr).reduce((s, x) => s + Number(x), 0);
  rt.array_slice = (arr, offset, length) => {
    const a = arrValues(arr);
    const off = Number(offset) | 0;
    const o = off < 0 ? Math.max(a.length + off, 0) : off;
    if (length === undefined || length === null) return a.slice(o);
    return a.slice(o, o + Math.max(0, Number(length) | 0));
  };
  rt.array_reverse = (arr) => arrValues(arr).slice().reverse();
  rt.array_unique = (arr) => {
    const out = [];
    for (const v of arrValues(arr)) if (!out.some((x) => phpToStr(x) === phpToStr(v))) out.push(v);
    return out;
  };
  rt.array_count_values = (arr) => {
    const o = {};
    for (const v of arrValues(arr)) {
      const k = phpToStr(v);
      o[k] = (o[k] || 0) + 1;
    }
    return o;
  };
  rt.array_flip = (arr) => {
    const o = {};
    if (isObj(arr)) for (const k of Object.keys(arr)) o[phpToStr(arr[k])] = /^\d+$/.test(k) ? Number(k) : k;
    return o;
  };
  rt.array_filter = (arr, cb) => arrValues(arr).filter((v) => (cb ? !!cb(v) : !!v));
  rt.array_map = (cb, arr) => arrValues(arr).map((v) => cb(v));

  rt.str = phpToStr;
  rt.optional = (value, cb = null) => {
    if (typeof cb === 'function') return value == null ? null : cb(value);
    if (value == null) {
      const fn = () => null;
      fn.toString = () => '';
      fn.valueOf = () => null;
      return new Proxy(fn, {
        get(t, prop) {
          if (prop === 'toString' || prop === 'valueOf' || prop === Symbol.toPrimitive) return t[prop];
          return fn;
        },
      });
    }
    return value;
  };

  rt.number_format = (n, dec = 0, dp = '.', ts = ',') => {
    const x = Number(n);
    const s = Math.abs(x).toFixed(dec);
    const [ip, fp] = s.split('.');
    const grouped = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ts);
    return (x < 0 ? '-' : '') + grouped + (fp ? dp + fp : '');
  };
  rt.nl2br = (s) => String(s == null ? '' : s).replace(/\r\n|\r|\n/g, '<br />\n');

  // ---- Collection wrapper (rt.collect) ----
  class Collection {
    constructor(items) {
      this.items = Array.isArray(items) ? items.slice() : [];
    }
    count() { return this.items.length; }
    isEmpty() { return this.items.length === 0; }
    isNotEmpty() { return this.items.length !== 0; }
    first(pred) {
      if (typeof pred === 'function') {
        for (const v of this.items) if (pred(v)) return v;
        return null;
      }
      return this.items.length ? this.items[0] : null;
    }
    last(pred) {
      if (typeof pred === 'function') {
        for (let i = this.items.length - 1; i >= 0; i--) if (pred(this.items[i])) return this.items[i];
        return null;
      }
      return this.items.length ? this.items[this.items.length - 1] : null;
    }
    firstWhere(key, val) {
      for (const v of this.items) {
        if (v != null && typeof v === 'object' && v[key] == val) return v;
        if (v != null && v[key] === val) return v;
      }
      return null;
    }
    get(idx, def) {
      const i = Number(idx);
      if (Number.isInteger(i) && i >= 0 && i < this.items.length) return this.items[i];
      if (Object.prototype.hasOwnProperty.call(this.items, idx)) return this.items[idx];
      return def === undefined ? null : def;
    }
    pluck(key) {
      return new Collection(this.items.map((v) => (v == null ? null : v[key])));
    }
    filter(fn) {
      if (typeof fn === 'function') return new Collection(this.items.filter(fn));
      return new Collection(this.items.filter((v) => !!v));
    }
    map(fn) { return new Collection(this.items.map(fn)); }
    each(fn) { this.items.forEach(fn); return this; }
    take(n) {
      const c = Number(n);
      if (!Number.isFinite(c)) return new Collection(this.items.slice());
      if (c < 0) return new Collection(this.items.slice(c));
      return new Collection(this.items.slice(0, c));
    }
    slice(s, n) {
      const start = Number(s) | 0;
      if (n === undefined || n === null) return new Collection(this.items.slice(start));
      const len = Number(n) | 0;
      return new Collection(this.items.slice(start, start + len));
    }
    contains(valOrFn) {
      if (typeof valOrFn === 'function') return this.items.some(valOrFn);
      return this.items.includes(valOrFn);
    }
    has(key) {
      const k = Number(key);
      if (Number.isInteger(k)) return k >= 0 && k < this.items.length;
      return Object.prototype.hasOwnProperty.call(this.items, key);
    }
    sum(key) {
      const vals = key == null ? this.items : this.items.map((v) => (v == null ? 0 : v[key]));
      let s = 0;
      for (const v of vals) {
        const num = Number(v);
        if (v != null && !Number.isNaN(num)) s += num;
      }
      return s;
    }
    avg(key) {
      if (this.items.length === 0) return null;
      const vals = key == null ? this.items : this.items.map((v) => (v == null ? null : v[key]));
      let s = 0;
      let c = 0;
      for (const v of vals) {
        if (v == null) continue;
        const num = Number(v);
        if (!Number.isNaN(num)) { s += num; c++; }
      }
      if (c === 0) return null;
      return s / c;
    }
    keys() { return new Collection(this.items.map((_, i) => i)); }
    values() { return new Collection(this.items.slice()); }
    toArray() { return this.items.slice(); }
    toJson() { return JSON.stringify(this.items); }
    all() { return this.items.slice(); }
  }
  rt.collect = (arr) => new Collection(Array.isArray(arr) ? arr : arr == null ? [] : [arr]);
  rt.Collection = Collection;

  // ---- rt.now() minimal Carbon stub (UTC) ----
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad4 = (n) => String(n).padStart(4, '0');
  function makeCarbon(date) {
    const d = new Date(date.getTime());
    const api = {
      _d: d,
      format(fmt) {
        const Y = pad4(d.getUTCFullYear());
        const m = pad2(d.getUTCMonth() + 1);
        const dd = pad2(d.getUTCDate());
        const H = pad2(d.getUTCHours());
        const i = pad2(d.getUTCMinutes());
        const s = pad2(d.getUTCSeconds());
        const n = String(d.getUTCMonth() + 1);
        const j = String(d.getUTCDate());
        const G = String(d.getUTCHours());
        const g0 = d.getUTCHours() % 12 || 12;
        const g = String(g0);
        const a = d.getUTCHours() < 12 ? 'am' : 'pm';
        const A = d.getUTCHours() < 12 ? 'AM' : 'PM';
        const U = String(Math.floor(d.getTime() / 1000));
        return String(fmt).replace(/Y|m|d|H|i|s|n|j|G|g|a|A|U/g, (ch) => {
          switch (ch) {
            case 'Y': return Y;
            case 'm': return m;
            case 'd': return dd;
            case 'H': return H;
            case 'i': return i;
            case 's': return s;
            case 'n': return n;
            case 'j': return j;
            case 'G': return G;
            case 'g': return g;
            case 'a': return a;
            case 'A': return A;
            case 'U': return U;
            default: return ch;
          }
        });
      },
      toDateString() { return pad4(d.getUTCFullYear()) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); },
      toDateTimeString() { return pad4(d.getUTCFullYear()) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()); },
      get timestamp() { return Math.floor(d.getTime() / 1000); },
      getTimestamp() { return Math.floor(d.getTime() / 1000); },
      addDays(n) { const nd = new Date(d.getTime()); nd.setUTCDate(nd.getUTCDate() + Number(n)); return makeCarbon(nd); },
      subDays(n) { const nd = new Date(d.getTime()); nd.setUTCDate(nd.getUTCDate() - Number(n)); return makeCarbon(nd); },
      addHours(n) { const nd = new Date(d.getTime()); nd.setUTCHours(nd.getUTCHours() + Number(n)); return makeCarbon(nd); },
      subHours(n) { const nd = new Date(d.getTime()); nd.setUTCHours(nd.getUTCHours() - Number(n)); return makeCarbon(nd); },
      copy() { return makeCarbon(new Date(d.getTime())); },
      clone() { return makeCarbon(new Date(d.getTime())); },
      toString() { return pad4(d.getUTCFullYear()) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()); },
      valueOf() { return d.getTime(); },
    };
    return api;
  }
  // The request clock (integer seconds): the oracle freezes Carbon, so the
  // compiled side must read the same instant - the wall clock diverges.
  const clockDate = () => (requestClock ? new Date(requestClock() * 1000) : new Date());
  rt.now = () => makeCarbon(clockDate());
  rt.today = () => {
    const d = clockDate();
    d.setUTCHours(0, 0, 0, 0);
    return makeCarbon(d);
  };

  // ---- controller runtime (view data, models, responses) ----
  // rt.var reads runtime view data (injected by controller renders). When no data is
  // present the value is `undefined` — byte-identical to pre-data-injection behavior.
  const dataCtx = (opts && opts.data && typeof opts.data === 'object') ? opts.data : {};

  // Blade's compiled @foreach bookkeeping calls $__env->addLoop() /
  // incrementLoopIndices() / getLastLoop() / popLoop(). Provide a per-rt loop
  // stack that mirrors Illuminate\View\Concerns\ManagesLoops so compiled views
  // with loops render at runtime.
  const loopsStack = [];
  const bladeEnv = {
    addLoop(dataSrc) {
      let length = null;
      if (Array.isArray(dataSrc)) length = dataSrc.length;
      else if (dataSrc instanceof Map) length = dataSrc.size;
      else if (dataSrc && typeof dataSrc === 'object') {
        length = typeof dataSrc.length === 'number' ? dataSrc.length : Object.keys(dataSrc).length;
      }
      const parent = loopsStack.length ? { ...loopsStack[loopsStack.length - 1] } : null;
      loopsStack.push({
        iteration: 0,
        index: 0,
        remaining: length,
        count: length,
        first: true,
        last: length === null ? null : length === 1,
        odd: false,
        even: true,
        depth: loopsStack.length + 1,
        parent,
      });
    },
    incrementLoopIndices() {
      const loop = loopsStack[loopsStack.length - 1];
      if (!loop) return;
      const iteration = loop.iteration;
      loop.iteration = iteration + 1;
      loop.index = iteration;
      loop.first = iteration === 0;
      loop.odd = !loop.odd;
      loop.even = !loop.even;
      const hasCount = loop.count !== null && loop.count !== undefined;
      loop.remaining = hasCount ? loop.remaining - 1 : null;
      loop.last = hasCount ? iteration === loop.count - 1 : null;
    },
    popLoop() {
      loopsStack.pop();
    },
    getLastLoop() {
      return loopsStack.length ? loopsStack[loopsStack.length - 1] : null;
    },
    getLoopStack() {
      return loopsStack;
    },
  };

  rt.var = (k) => {
    if (Object.prototype.hasOwnProperty.call(dataCtx, k)) return dataCtx[k];
    if (k === '__env') return bladeEnv;
    return undefined;
  };

  // rt.prop: PHP `->` property access on models (attributes via get()), plain
  // objects and arrays. Missing values become null (PHP null-ish read).
  rt.prop = (obj, key) => {
    if (obj === null || obj === undefined) return null;
    if (obj instanceof Promise) {
      throw new Error('unresolved promise — await the query in a single chain before reading ->' + key);
    }
    if (typeof obj.get === 'function' && obj.attributes && typeof obj.attributes === 'object') {
      const v = obj.get(key);
      return v === undefined ? null : v;
    }
    if (typeof obj === 'object') return obj[key] === undefined ? null : obj[key];
    return null;
  };

  // rt.propSet: PHP `$model->attribute = $value` (Eloquent::setAttribute). The
  // Model#set() path applies the casts (and the `hashed` cast hashes at
  // set-time, like Eloquent); plain objects/arrays get a plain assignment.
  rt.propSet = (obj, key, value) => {
    if (obj === null || obj === undefined) {
      throw new Error('cannot set ->' + key + ' on null');
    }
    if (typeof obj.set === 'function' && obj.attributes && typeof obj.attributes === 'object') {
      obj.set(key, value);
      return value;
    }
    if (typeof obj === 'object') {
      obj[key] = value;
      return value;
    }
    throw new Error('cannot set ->' + key + ' on ' + typeof obj);
  };

  const statusErr = (status, message) => {
    const e = new Error(message == null ? '' : String(message));
    e.status = Number(status) || 500;
    return e;
  };
  rt.statusErr = statusErr;
  rt.abort = (code, message) => { throw statusErr(code, message || ('HTTP ' + code)); };
  // Laravel's abort_if()/abort_unless(): they answer null unless they abort.
  rt.abortIf = (condition, code, message) => {
    if (condition) rt.abort(code, message);
    return null;
  };
  rt.abortUnless = (condition, code, message) => {
    if (!condition) rt.abort(code, message);
    return null;
  };
  rt.errorResponse = (e) => ({
    status: (e && e.status) || 500,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: (e && e.message) ? String(e.message) : ('HTTP ' + (((e && e.status) || 500))),
  });
  rt.json = (value, status) => ({
    status: Number(status) || 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value == null ? null : value),
  });
  // The redirect, with Laravel's flash modifiers. The flash lives in the
  // session (it is read by the *next* request), exactly like Laravel's
  // RedirectResponse::with()/withInput()/withErrors().
  rt.redirect = (location, status) => {
    const res = {
      status: Number(status) || 302,
      headers: { location: String(location == null ? '' : location) },
      body: '',
    };
    res.with = (key, value) => {
      const session = liveSession;
      if (session) {
        if (key !== null && typeof key === 'object' && !Array.isArray(key)) {
          for (const [k, v] of Object.entries(key)) session.flash(k, v);
        } else {
          session.flash(key, value === undefined ? true : value);
        }
      }
      return res;
    };
    res.withInput = (input) => {
      const session = liveSession;
      if (session) {
        const source =
          input !== undefined && input !== null
            ? input
            : liveRequest && typeof liveRequest.all === 'function'
              ? liveRequest.all()
              : {};
        const clean = Object.assign({}, source);
        for (const key of DEFAULT_DONT_FLASH) delete clean[key];
        if (typeof session.flashInput === 'function') session.flashInput(clean);
        else session.flash('_old_input', clean);
      }
      return res;
    };
    res.withErrors = (errors) => {
      const session = liveSession;
      if (session) {
        const bag =
          liveRequest && typeof liveRequest.input === 'function'
            ? liveRequest.input('_error_bag', 'default')
            : 'default';
        session.flash('errors', sessionErrorBag(bag, errors || {}));
      }
      return res;
    };
    return res;
  };

  // rt.param: route parameter → PHP method argument coercion (Laravel matches by position;
  // controllers bind after checking the route segment name).
  rt.param = (params, name, type, hasDefault, def) => {
    const v = params && typeof params === 'object' ? params[name] : undefined;
    if (v === undefined || v === null) return hasDefault ? def : null;
    if (type === 'int') return rt.intval(v);
    if (type === 'float') return rt.floatval(v);
    if (type === 'bool') return rt.truthy(v);
    if (type === 'raw') return v;
    return String(v);
  };

  // rt.db: the D1 binding the compiled controller writes through
  // (Eloquent's model writes need the connection).
  rt.db = () => {
    const binding = (opts && opts.db) || null;
    if (!binding) throw new Error('rt.db: no database binding (env.DB) available');
    return binding;
  };

  // rt.hash: the Hash facade (bcrypt). The rounds come from the app config
  // (hashing.bcrypt.rounds), baked in at build time.
  const hashRounds = Number((opts && opts.hashRounds) || 12);
  rt.hash = {
    make: (value) => hashMod.make(String(value), { rounds: hashRounds }),
    check: (value, hashed) => hashMod.check(String(value), hashed),
    needsRehash: (hashed) => hashMod.needsRehash(hashed, { rounds: hashRounds }),
    isHashed: (value) => hashMod.isHashed(value),
  };

  // ---- model facades (rt.model) ----
  const modelsMap = (opts && opts.models && typeof opts.models === 'object') ? opts.models : {};
  const viewsMap = (opts && opts.views && typeof opts.views === 'object') ? opts.views : {};
  const db = (opts && opts.db) || null;

  const wrapBuilder = (b) => {
    if (b && typeof b.firstOrFail !== 'function') {
      b.firstOrFail = async () => {
        const r = await b.first();
        if (r === null || r === undefined) throw statusErr(404, 'not found');
        return r;
      };
    }
    return b;
  };
  const facadeCache = new Map();
  const makeFacade = (M) => {
    if (facadeCache.has(M)) return facadeCache.get(M);
    if (!db) throw new Error('rt.model: no database binding (env.DB) available');
    // The model timestamps follow the request clock (a frozen clock in the
    // parity tests), so a write carries the same `created_at` as the PHP side.
    if (requestClock && typeof M.clock !== 'undefined') M.clock = requestClock;
    const name = M.name || 'Model';
    const facade = {
      find: (id) => M.find(db, id),
      findOrFail: async (id) => {
        const row = await M.find(db, id);
        if (row === null || row === undefined) throw statusErr(404, name + ' not found');
        return row;
      },
      all: () => M.all(db),
      where: (...a) => wrapBuilder(M.query(db).where(...a)),
      whereIn: (...a) => wrapBuilder(M.query(db).whereIn(...a)),
      // Eloquent::create() — a new model, filled (fillable-guarded) and saved.
      create: async (attributes) => {
        const m = new M();
        if (attributes && typeof attributes === 'object') m.fill(attributes);
        await m.save(db);
        return m;
      },
    };
    facadeCache.set(M, facade);
    return facade;
  };
  rt.model = (name) => {
    const key = String(name);
    const M = modelsMap[key];
    if (!M) throw new Error('rt.model: unknown model ' + JSON.stringify(key));
    return makeFacade(M);
  };

  // rt.view: render a compiled Blade view with runtime data.
  rt.view = (name, data) => {
    const key = String(name);
    const entry = viewsMap[key];
    if (!entry || typeof entry.main !== 'function') {
      throw new Error('view not compiled: ' + JSON.stringify(key) + ' — write a port for this route');
    }
    const d = data == null ? {} : data;
    for (const k of Object.keys(d)) {
      if (d[k] instanceof Promise) {
        throw new Error('view data ' + JSON.stringify(k) + ' is an unresolved promise — await the query in a single chain');
      }
    }
    const sub = buildRt(entry.context || {}, {
      strict: strict,
      runtime: runtime,
      data: d,
      db: db,
      models: modelsMap,
      views: viewsMap,
      origin: origin,
      routeMap: routeMap,
    });
    entry.main(sub);
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: sub.__output };
  };

  return rt;
}
export default buildRt;
