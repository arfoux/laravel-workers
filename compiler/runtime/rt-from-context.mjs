// compiler/runtime/rt-from-context.mjs — Runtime helpers (context → rt)
import { validationExceptionWithMessages, sessionErrorBag, DEFAULT_DONT_FLASH } from '../../kernel/validation.mjs';
import { Validator } from '../../kernel/validator.mjs';
import * as hashMod from '../../kernel/hash.mjs';
import { str as strHelpers } from '../../kernel/str.mjs';
import { LengthAwarePaginator } from '../../kernel/paginator.mjs';
import { phpJsonEncode } from '../../kernel/php-json.mjs';
import { Mailable } from '../../kernel/mailable.mjs';
import { FormRequest } from '../../kernel/form-request.mjs';
import { Collection } from '../../kernel/collections.mjs';

// The Collection marker: the runtime's Collection class is created per rt (a
// view renders with its OWN rt - buildRt() runs again for it), so an
// `instanceof` check cannot see a Collection that came from another rt (the
// controller's). The marker travels with the instance.
// The registry symbol: the kernel's Collection (kernel/collections.mjs) marks
// its instances with the SAME symbol, so a collection built by the controller's
// rt is still recognised inside a view's own rt.
const IS_COLLECTION = Symbol.for('lw.collection');

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
  // The parent runtime hands its config down (a view renders with the app's
  // config — the translations, the pagination view).
  if (opts && opts.config) configCtx = { ...(configCtx || {}), ...opts.config };
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
    // A view that is capturing a section (@section) sends its output into the
    // section, not into the page.
    if (bladeEnv.capturing()) {
      bladeEnv.capture(s);
      return s;
    }
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
  // PHP 8's arithmetic: a numeric string is a number; a string with a leading
  // numeric part is that part (PHP raises a warning); a non-numeric string (or
  // an array) in an arithmetic operation is a TypeError; a division by zero is
  // a DivisionByZeroError; the modulo truncates its operands to int. The
  // compiled side must not answer something else (a silent wrong answer).
  const phpNum = (v) => {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      if (isNumericStr(v)) return Number(v.trim());
      const lead = /^\s*[+-]?\d+(\.\d*)?([eE][+-]?\d+)?/.exec(v);
      return lead ? Number(lead[0].trim()) : NaN;
    }
    return NaN;
  };
  // A PHP array: a list or a plain object (the compiled side represents an
  // array as an object literal; a model instance is not one).
  const isPhpArray = (v) => {
    if (Array.isArray(v)) return true;
    if (v === null || typeof v !== 'object') return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };
  const phpTypeName = (v) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
    if (typeof v === 'string') return 'string';
    if (isPhpArray(v)) return 'array';
    return 'object';
  };
  const arithOperands = (op, a, b) => {
    const na = phpNum(a);
    const nb = phpNum(b);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      throw new TypeError(
        'Unsupported operand types: ' + phpTypeName(a) + ' ' + op + ' ' + phpTypeName(b)
      );
    }
    return [na, nb];
  };
  rt.add = (a, b) => {
    // PHP 8: array + array is the union (the left keys win); every other
    // combination follows the arithmetic rules. A PHP array is a plain object
    // (the compiled side) or a list.
    if (isPhpArray(a) && isPhpArray(b)) {
      const out = {};
      for (const k of Object.keys(a)) out[k] = a[k];
      for (const k of Object.keys(b)) if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = b[k];
      return out;
    }
    const p = arithOperands('+', a, b);
    return p[0] + p[1];
  };

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

  // ---- the service adapters: the framework services a class can inject ----
  // The edge hands the live service over (the worker: the platform log, the
  // mailer, the queue). The shape is Laravel's, so the compiled class calls
  // it the way the app does.
  const logAdapter = () => {
    if (!liveLog) return null;
    const write = (level) => (message, context) => liveLog(level, message, context);
    return {
      log: (level, message, context) => liveLog(level, message, context),
      debug: write('debug'),
      info: write('info'),
      notice: write('notice'),
      warning: write('warning'),
      warn: write('warning'),
      error: write('error'),
      critical: write('critical'),
      alert: write('alert'),
      emergency: write('emergency'),
    };
  };
  // The queue: Laravel's Queue facade. The edge has no consumer for the
  // binding (the worker exports no queue handler), and the binding carries a
  // JSON body, not a PHP job — so a queued job would never run. It fails loud
  // instead of vanishing.
  const queueAdapter = () => {
    if (!liveQueue) return null;
    const fail = (method) => {
      throw new Error(
        'Queue::' + method + '(): the job would never run at the edge — the worker has no queue handler, so ' +
          'nothing consumes the queue binding, and the binding carries a JSON body, not a PHP job. The paths that ' +
          'work: a Cloudflare Queues binding with a consumer you write (a limited version is on the Workers free plan; the paid plan charges per operation), or a D1 table the cron trigger reads.'
      );
    };
    return {
      push: () => fail('push'),
      pushOn: () => fail('pushOn'),
      later: () => fail('later'),
      bulk: () => fail('bulk'),
    };
  };
  // The service an injected dependency asks for.
  const liveAdapter = (kind) => {
    if (kind === 'mail') return liveMail || null;
    if (kind === 'log') return logAdapter();
    if (kind === 'queue') return queueAdapter();
    return null;
  };

  const noHttp = (fn) => {
    throw new Error(fn + '(): no HTTP context (static snapshot / build-time evaluation)');
  };
  rt.request = () => (liveRequest || noHttp('request'));
  rt.session = () => (liveSession || noHttp('session'));
  // The app's validation messages (the app's own lang file wins over the
  // framework's copy, exactly like Laravel's translator - the same helper the
  // request's validate() uses, kernel/http.mjs:validationMessagesOf).
  const defaultValidationMessages = () => {
    const locale = String(configCtx['app.locale'] || 'en');
    const base = translations.en && translations.en.validation;
    const local = translations[locale] && translations[locale].validation;
    if (!base && !local) return null;
    return Object.assign({}, base || {}, local || {});
  };
  // The FormRequest lifecycle (Illuminate/Validation/ValidatesWhenResolvedTrait
  // ::validateResolved + Illuminate/Foundation/Http/FormRequest
  // ::getValidatorInstance). The order is Laravel's:
  //   1. prepareForValidation()  - the input it prepares is validated
  //   2. authorize()              - false raises the 403
  //      (failedAuthorization -> UnauthorizedException)
  //   3. the validator over validationData() with the app's rules
  //   4. withValidator($validator) - the app registers on the validator
  //   5. after()                 - the callback it RETURNS is registered
  //   6. the rules run; a failure raises the 422 (failedValidation)
  //   7. passedValidation()      - the work after the rules passed
  //
  // The hooks are the COMPILED class's own methods (the class compiler emits
  // them), so the lifecycle calls them on the instance. The validator is the
  // kernel's (the edge has one factory).
  rt.formRequest = async (fqcn, opts = {}) => {
    const hooks = Array.isArray(opts.hooks) ? opts.hooks : [];
    const instance = rt.newClass(fqcn, []);
    if (hooks.includes('prepareForValidation')) {
      await instance.prepareForValidation(rt);
    }
    if (hooks.includes('authorize')) {
      const allowed = await instance.authorize(rt);
      if (!allowed) {
        // Illuminate\Validation\ValidatesWhenResolvedTrait::failedAuthorization
        // throws the UnauthorizedException, and Laravel's Handler turns it into
        // the 403 (AccessDeniedHttpException - "This action is unauthorized.").
        // The error carries the status, so the compiled handler renders it
        // (an expectsJson request gets Laravel's pretty JSON body).
        throw rt.statusErr(403, 'This action is unauthorized.');
      }
    }
    // The data the rules see: the app's validationData() hook, or the whole
    // request (Laravel's default - FormRequest.php:197).
    const data = hooks.includes('validationData')
      ? await instance.validationData(rt)
      : instance.all();
    const validator = new Validator(data, opts.rules || {}, opts.messages || {}, {
      db: rt.db(),
      attributes: opts.attributes || {},
      defaultMessages: defaultValidationMessages(),
    });
    if (hooks.includes('withValidator')) {
      await instance.withValidator(rt, validator);
    }
    if (hooks.includes('after')) {
      // Laravel registers the hook's RETURN VALUE on the validator
      // (FormRequest.php:114): `$validator->after($this->after(...))`.
      const callback = await instance.after(rt);
      if (callback) validator.after(callback);
    }
    instance.setValidator(validator);
    // The rules run (and the after callbacks - the validator runs them at the
    // end of the pass, Validator.php:509-511).
    const ok = await validator.passes();
    if (!ok) {
      instance.failedValidation(validator);
    }
    if (hooks.includes('passedValidation')) {
      await instance.passedValidation(rt);
    }
    return validator.validated();
  };
  // Illuminate\Support\Str - the string helpers (PHP-exact, kernel/str.mjs).
  // (`rt.str` is the PHP (string) cast, so the facade goes to rt.Str.)
  rt.Str = strHelpers;
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
  // ---- rt.__ : the translation helper (Illuminate\Translation) ----
  // The strings are dumped at build time (the app's lang/ files + the
  // framework's fallback). Laravel returns the key itself when a string is
  // missing.
  const translations = configCtx.translations && typeof configCtx.translations === 'object'
    ? configCtx.translations
    : {};
  const translateLine = (key, locale) => {
    const locales = [locale];
    const fallback = configCtx['app.fallback_locale'];
    if (fallback && locales.indexOf(fallback) === -1) locales.push(fallback);
    for (const loc of locales) {
      const groups = translations[loc];
      if (!groups) continue;
      const dot = String(key).indexOf('.');
      const group = dot === -1 ? '*' : String(key).slice(0, dot);
      const item = dot === -1 ? String(key) : String(key).slice(dot + 1);
      const groupStrings = group === '*' ? groups : groups[group];
      if (!groupStrings) continue;
      const line = rt.dataGet(groupStrings, item, null);
      if (line !== null && line !== undefined) return String(line);
    }
    return null;
  };
  // Illuminate\Translation\Translator::makeReplacements(): `:key`, `:KEY`,
  // `:Key` (the longest keys first).
  const makeReplacements = (line, replace) => {
    if (!replace || typeof replace !== 'object') return line;
    const keys = Object.keys(replace).sort((a, b) => b.length - a.length);
    let out = line;
    for (const key of keys) {
      const value = replace[key] === null || replace[key] === undefined ? '' : String(replace[key]);
      const upper = key.toUpperCase();
      const ucfirst = upper.charAt(0) + key.slice(1);
      out = out
        .split(':' + key).join(value)
        .split(':' + upper).join(value.toUpperCase())
        .split(':' + ucfirst).join(value.charAt(0).toUpperCase() + value.slice(1));
    }
    return out;
  };
  rt.__ = (key, replace) => {
    const locale = configCtx['app.locale'] || 'en';
    const line = translateLine(String(key), locale);
    // Laravel applies the replacements to the key too, when the line is
    // missing (`makeReplacements($line ?: $key, $replace)`).
    return makeReplacements(line === null ? String(key) : line, replace);
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
  // Queue:: — the queue facade (it fails loud: nothing consumes the binding).
  rt.queue = () => {
    const adapter = queueAdapter();
    if (adapter) return adapter;
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

  // ---- rt.newClass / rt.event: the compiled classes (the event listeners) ----
  // The classes are compiled at build time (dist/src/classes.generated.mjs):
  // the constructor (the promoted properties) and the public methods. Laravel
  // dispatches an event synchronously, so the edge calls the listeners in the
  // registration order. Laravel's Dispatcher::dispatch(): every listener runs, only
  // an answer of false stops the chain, and the dispatch answers the array of the
  // responses.
  const classesMap = (opts && opts.classes && typeof opts.classes === 'object') ? opts.classes : {};
  const eventListenersMap =
    (opts && opts.eventListeners && typeof opts.eventListeners === 'object') ? opts.eventListeners : {};
  // The dependencies of a constructor: the framework service the edge adapts
  // (the mailer, the logger, the queue) or the app service the edge builds
  // (the compiled class).
  // The classes whose dependencies are being resolved right now: a service A
  // that needs B that needs A would recurse forever (a stack overflow with no
  // cause), so the cycle is named (Laravel: 'Circular dependency detected').
  const resolving = new Set();
  const resolveDeps = (deps, fqcn) => {
    const out = {};
    for (const d of deps || []) {
      if (d.kind === 'adapter') {
        const live = liveAdapter(d.adapter);
        if (!live) {
          throw new Error(
            'newClass: the service ' + d.type + ' is not available at the edge — the request context has no ' +
              d.adapter + ' (the worker hands it down)'
          );
        }
        out[d.param] = live;
        continue;
      }
      out[d.param] = rt.newClass(d.type, []);
    }
    return out;
  };
  rt.newClass = (fqcn, args) => {
    const entry = classesMap[String(fqcn)];
    if (!entry) {
      throw new Error('newClass: the class ' + fqcn + ' is not compiled — the build did not dump it');
    }
    if (resolving.has(String(fqcn))) {
      throw new Error(
        'newClass: circular dependency detected [' + [...resolving, String(fqcn)].join(' -> ') + ']'
      );
    }
    // The dependencies of the constructor: the framework service the edge
    // adapts (the mailer, the logger, the queue) or the app service the edge
    // builds (the compiled class).
    resolving.add(String(fqcn));
    let deps;
    try {
      deps = resolveDeps(entry.deps || [], fqcn);
    } finally {
      resolving.delete(String(fqcn));
    }
    // A mailable extends Laravel's Mailable: the compiled class gets the
    // kernel's base (the fluent surface + the payload).
    const built = entry.ctor(Array.isArray(args) ? args : [], deps);
    const obj =
      entry.base === 'mailable'
        ? Object.assign(new Mailable(), built)
        : entry.base === 'formRequest'
          ? Object.assign(new FormRequest(rt.request()), built)
          : built;
    // The runtime: a mailable renders its view through it (`__lwMail`).
    Object.defineProperty(obj, '__rt', { value: rt, enumerable: false, configurable: true });
    // The class of the instance (the dispatch needs it) — not enumerable, so a
    // JSON answer does not show it.
    Object.defineProperty(obj, '__lwClass', { value: String(fqcn), enumerable: false });
    for (const [name, fn] of Object.entries(entry.methods || {})) {
      obj[name] = fn.bind(obj);
    }
    return obj;
  };
  rt.event = {
    dispatch: async (event) => {
      const fqcn = event && event.__lwClass;
      if (!fqcn) {
        throw new Error('event.dispatch: the event is not an instance of a compiled event class');
      }
      const listeners = eventListenersMap[fqcn] || [];
      // Laravel's Dispatcher::dispatch(): every listener runs, a listener that answers
      // false stops the chain (and its answer is discarded), and the return value is
      // the ARRAY of the responses (not the first answer). Only dispatchUntil() (the
      // halt flag) stops at the first non-null answer.
      const responses = [];
      for (const listenerFqcn of listeners) {
        const entry = classesMap[listenerFqcn];
        if (!entry) {
          throw new Error('event.dispatch: the listener ' + listenerFqcn + ' is not compiled');
        }
        const handle = entry.methods && entry.methods.handle;
        if (!handle) {
          throw new Error('event.dispatch: the listener ' + listenerFqcn + ' has no handle() method');
        }
        const listener = rt.newClass(listenerFqcn, []);
        const answer = await handle.call(listener, rt, event);
        if (answer === false) break;
        responses.push(answer === undefined ? null : answer);
      }
      return responses;
    },
  };

  // ---- rt.gate: the compiled policy check (Illuminate\Auth\Access\Gate) ----
  // The policies are compiled at build time (dist/src/policies.generated.mjs):
  // the abilities, the guest rules and the policy `before()` hook. The guest
  // rules are Laravel's own: a guest the policy does not allow is denied — the
  // method is not called at all (Gate::canBeCalledWithUser).
  const policiesMap = (opts && opts.policies && typeof opts.policies === 'object') ? opts.policies : {};
  rt.gate = async (ability, subject, modelFqcn, deny) => {
    const key = String(modelFqcn);
    const entry = policiesMap[key];
    if (!entry) {
      throw new Error('gate: no compiled policy for ' + key + ' — the build did not dump it');
    }
    const user = (await rt.auth().user()) ?? null;
    const m = (entry.methods || {})[String(ability)];
    let result;
    if (!m) {
      // Laravel skips the whole policy callback when the ability method is not
      // callable — the check is denied and the policy's before() does not run.
      result = false;
    } else {
      if (entry.before && (user !== null || entry.before.guest)) {
        // Laravel hands before() the raw arguments: the ability and the
        // subject (a class-level check passes the class name).
        const beforeArgs =
          subject === null || subject === undefined ? [ability, key] : [ability, subject];
        const r = await entry.before.fn(rt, user, ...beforeArgs);
        if (r !== null && r !== undefined) result = r;
      }
      if (result === undefined) {
        if (user === null && !m.guest) {
          result = false; // a guest the policy does not allow: denied
        } else {
          result = await m.fn(rt, user, ...(subject === null || subject === undefined ? [] : [subject]));
        }
      }
    }
    const allowed = rt.truthy(result);
    return deny ? !allowed : allowed;
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
    // A PHP array is a list OR an assoc array (a plain object on the compiled
    // side) - in_array walks the VALUES of both.
    const arr = Array.isArray(haystack)
      ? haystack
      : haystack !== null && typeof haystack === 'object'
        ? Object.values(haystack)
        : [];
    if (strict) return arr.some((x) => x === needle && typeof x === typeof needle);
    return arr.some((x) => rt.looseEq(x, needle));
  };
  const isObj = (v) => v !== null && typeof v === 'object';
  const arrValues = (v) => (Array.isArray(v) ? v.slice() : (isObj(v) ? rt.phpKeys(v).map((k) => v[k]) : []));
  rt.implode = (glue, arr) => arrValues(arr).map((x) => (x == null ? '' : String(x))).join(glue == null ? '' : String(glue));
  rt.explode = (delim, str, limit) => String(str).split(String(delim));
  rt.array_key_exists = (k, arr) => (isObj(arr) ? Object.prototype.hasOwnProperty.call(arr, k) : false);
  // PHP preserves an array's insertion order; a JS object does not (an
  // integer-like key enumerates first). A literal that mixes both kinds is
  // built by `rt.assoc()`, which records the order in a non-enumerable marker
  // - every key iterator below reads it first.
  rt.phpKeys = (v) =>
    v && typeof v === 'object' && Array.isArray(v.__lwOrder) ? v.__lwOrder : Object.keys(v || {});
  rt.assoc = (pairs) => {
    const out = {};
    const order = [];
    for (const pair of pairs) {
      const key = String(pair[0]);
      if (!Object.prototype.hasOwnProperty.call(out, key)) order.push(key);
      out[key] = pair[1];
    }
    Object.defineProperty(out, '__lwOrder', { value: order, enumerable: false });
    return out;
  };
  rt.array_keys = (arr) => (isObj(arr) ? rt.phpKeys(arr).map((k) => (/^\d+$/.test(k) ? Number(k) : k)) : []);
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
  // `$arr[] = $x` — the PHP append (the next free integer key). It used to
  // compile to `$arr[null] = $x` — a *silent* wrong answer.
  rt.arrayPush = (arr, value) => {
    if (!Array.isArray(arr)) {
      throw new Error(
        'arrayPush: the target is not a list (PHP $a[] = … on a string-keyed array)'
      );
    }
    arr.push(value);
    return arr;
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
  // The elvis operator (`$a ?: $b`): the test is evaluated once, and the
  // else branch runs only when the test is falsy (PHP's semantics).
  rt.elvis = (test, other) => {
    const v = test();
    return rt.truthy(v) ? v : other();
  };
  // PHP 8's increment/decrement: a number grows, a numeric string becomes a
  // number ("19"++ => 20, "19"-- => 18), an alnum string bumps its last byte
  // ("a" -> "b", "z" -> "aa") - and a decrement on a non-numeric string has
  // NO effect (PHP 8 deprecated it).
  rt.inc = (v) => {
    if (typeof v === 'number') return v + 1;
    if (typeof v === 'boolean') return v ? 2 : 1;
    if (v === null || v === undefined) return 1;
    if (typeof v === 'string') {
      if (isNumericStr(v)) return Number(v.trim()) + 1;
      const chars = [...v];
      const last = chars[chars.length - 1];
      const isDigit = last >= '0' && last <= '9';
      const isLower = last >= 'a' && last <= 'z';
      const isUpper = last >= 'A' && last <= 'Z';
      if (!isDigit && !isLower && !isUpper) return v;
      if (isDigit) {
        if (last === '9') {
          let carry = true;
          const out = [...v];
          for (let i = out.length - 1; i >= 0 && carry; i--) {
            const c = out[i];
            if (c >= '0' && c <= '8') { out[i] = String(Number(c) + 1); carry = false; }
            else if (c === '9') { out[i] = '0'; }
            else { return v; }
          }
          return (carry ? '1' : '') + out.join('');
        }
        chars[chars.length - 1] = String(Number(last) + 1);
        return chars.join('');
      }
      if (isLower) {
        if (last === 'z') {
          let i = chars.length - 1;
          while (i >= 0 && chars[i] === 'z') { chars[i] = 'a'; i--; }
          if (i < 0) return 'a'.repeat(chars.length + 1);
          chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
          return chars.join('');
        }
        chars[chars.length - 1] = String.fromCharCode(last.charCodeAt(0) + 1);
        return chars.join('');
      }
      if (last === 'Z') {
        let i = chars.length - 1;
        while (i >= 0 && chars[i] === 'Z') { chars[i] = 'A'; i--; }
        if (i < 0) return 'A'.repeat(chars.length + 1);
        chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
        return chars.join('');
      }
      chars[chars.length - 1] = String.fromCharCode(last.charCodeAt(0) + 1);
      return chars.join('');
    }
    return v;
  };
  rt.dec = (v) => {
    if (typeof v === 'number') return v - 1;
    if (typeof v === 'boolean') return v ? 0 : -1;
    if (v === null || v === undefined) return -1;
    if (typeof v === 'string') {
      // A numeric string becomes a number ("19"-- => 18); a non-numeric one
      // has NO effect (PHP 8 deprecated the decrement on it).
      if (isNumericStr(v)) return Number(v.trim()) - 1;
      return v;
    }
    return v;
  };
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

  // Two numeric strings, compared with the int64 precision PHP uses.
  const numericStringEq = (a, b) => {
    const norm = (s) => {
      const t = s.trim();
      const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(t);
      if (!m) return null;
      const sign = m[1] === '-' ? -1n : 1n;
      const int = m[2] || '0';
      const frac = m[3] || '';
      const exp = m[4] ? parseInt(m[4], 10) : 0;
      return { sign, int, frac, exp };
    };
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    // The same value in decimal: align the exponents, then compare the digits.
    const toDecimal = (n) => {
      const digits = n.int + (n.frac || '');
      const point = n.int.length + n.exp;
      if (point <= 0) return { sign: n.sign, int: '0', frac: '0'.repeat(-point) + digits };
      if (point >= digits.length) return { sign: n.sign, int: digits + '0'.repeat(point - digits.length), frac: '' };
      return { sign: n.sign, int: digits.slice(0, point), frac: digits.slice(point) };
    };
    const dx = toDecimal(x);
    const dy = toDecimal(y);
    const strip = (v) => {
      let int = v.int.replace(/^0+(?=\d)/, '');
      let frac = v.frac.replace(/0+$/, '');
      return { sign: v.sign, int: int || '0', frac };
    };
    const sx = strip(dx);
    const sy = strip(dy);
    if (sx.sign !== sy.sign) return false;
    return sx.int === sy.int && sx.frac === sy.frac;
  };
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
      // Two numeric strings are compared as numbers - with the full int64
      // precision (JS's Number() rounds beyond 2^53, so '9007199254740993' ==
      // '9007199254740992' would answer true where PHP says false).
      if (isNumericStr(a) && isNumericStr(b)) return numericStringEq(a, b);
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
  rt.sub = (a, b) => {
    const p = arithOperands('-', a, b);
    return p[0] - p[1];
  };
  rt.mul = (a, b) => {
    const p = arithOperands('*', a, b);
    return p[0] * p[1];
  };
  rt.div = (a, b) => {
    const p = arithOperands('/', a, b);
    // PHP's DivisionByZeroError (the class name reaches the 500).
    if (p[1] === 0) throw rt.newError('DivisionByZeroError', 'Division by zero');
    return p[0] / p[1];
  };
  rt.mod = (a, b) => {
    const p = arithOperands('%', a, b);
    if (p[1] === 0) throw rt.newError('DivisionByZeroError', 'Modulo by zero');
    return Math.trunc(p[0]) % Math.trunc(p[1]);
  };
  rt.pow = (a, b) => {
    const p = arithOperands('**', a, b);
    return Math.pow(p[0], p[1]);
  };

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
  // A Collection (Illuminate\Collections\Collection): the items live in
  // `items` and the iteration yields them (Collection::getIterator()).
  const isCollection = (v) => v !== null && typeof v === 'object' && v[IS_COLLECTION] === true;
  // The spread (`[...$a]`): the VALUES of the array, in order (PHP drops the
  // keys - the spread builds a list).
  rt.spread = (src) => {
    if (src === null || src === undefined) return [];
    if (Array.isArray(src)) return src.slice();
    if (typeof src === 'object') {
      if (Array.isArray(src.__items)) return src.__items.slice();
      // A Collection spreads its ITEMS (PHP: [...collect([1,2])] => [1,2] -
      // Illuminate\Collections\Collection::getIterator()).
      if (isCollection(src)) return src.items.slice();
      return Object.keys(src).map((k) => src[k]);
    }
    return [src];
  };
  // A string offset (`$s[-1]`): PHP 7.1+ counts from the end (a negative
  // offset), the positive ones from the start.
  rt.strOffset = (s, offset) => {
    const str = String(s == null ? '' : s);
    const off = Number(offset) || 0;
    const at = off < 0 ? str.length + off : off;
    if (at < 0 || at >= str.length) return '';
    return str[at];
  };
  rt.entries = (src) => {
    // A paginator (and a Collection) iterate their items, not their fields.
    if (src && typeof src === 'object' && Array.isArray(src.__items)) {
      return src.__items.map((v, i) => [i, v]);
    }
    // A Collection (Illuminate\Collections\Collection::getIterator()): the
    // ITEMS, keyed by their position - not the fields of the wrapper.
    if (isCollection(src)) {
      return src.items.map((v, i) => [i, v]);
    }
    if (src && typeof src === 'object') {
      const keyOf = (k) => (/^\d+$/.test(k) ? Number(k) : k);
      return rt.phpKeys(src).map((k) => [keyOf(k), src[k]]);
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
  // Illuminate\View\Compilers\Concerns\CompilesJson:12 - Blade's `@json($x)`
  // compiles to `json_encode($x, JSON_HEX_TAG|JSON_HEX_APOS|JSON_HEX_AMP|JSON_HEX_QUOT, 512)`
  // (CompilesJson:28): the four HEX flags escape `<`, `>`, `&`, `'` and `"` as
  // \uXXXX (PHP writes the hex in upper case) and the depth bounds the nesting
  // (PHP's json_encode() returns false past it).
  // The kernel's encoder (kernel/php-json.mjs) writes the DEFAULT flags, so the
  // runtime applies the HEX ones here. The other flags are not ported: they
  // would answer a different body, so they fail loud.
  const JSON_HEX_TAG = 1;
  const JSON_HEX_AMP = 2;
  const JSON_HEX_APOS = 4;
  const JSON_HEX_QUOT = 8;
  const JSON_HEX_FLAGS = JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT;
  // The HEX flags rewrite the characters INSIDE the encoded JSON: `<`, `>`,
  // `&` and `'` are not JSON syntax, so a literal one in the output can only
  // come from a string. The `"` is the ESCAPED one (`\"` inside a string) -
  // the string delimiters are bare quotes.
  const jsonHexEncode = (json, flags) => {
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
          // \\ \/ \b \t \n \f \r \u - the hex digits of a \u escape are copied
          // as they are (they are never one of the flagged characters).
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
  };
  // PHP's json_encode() depth: the nesting of the arrays/objects (a scalar is
  // no level). PHP returns false past it ("Maximum stack depth exceeded").
  const jsonDepth = (v) => {
    if (Array.isArray(v)) {
      let deepest = 0;
      for (const item of v) {
        const d = jsonDepth(item);
        if (d > deepest) deepest = d;
      }
      return 1 + deepest;
    }
    if (isPhpArray(v)) {
      let deepest = 0;
      for (const k of Object.keys(v)) {
        const d = jsonDepth(v[k]);
        if (d > deepest) deepest = d;
      }
      return 1 + deepest;
    }
    return 0;
  };
  rt.json_encode = (v, flags, depth) => {
    const f = flags == null ? 0 : Number(flags) | 0;
    const d = depth == null ? 512 : Number(depth) | 0;
    if (f & ~JSON_HEX_FLAGS) {
      throw new Error(
        'json_encode() flags ' + f + ' are not supported at the edge — PHP would write a different ' +
          'body with them (the ported ones are JSON_HEX_TAG|JSON_HEX_AMP|JSON_HEX_APOS|JSON_HEX_QUOT) — ' +
          'drop the flags or write a port'
      );
    }
    const value = v == null ? null : v;
    if (jsonDepth(value) > d) return false;
    return jsonHexEncode(phpJsonEncode(value), f);
  };
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
  // ONE Collection for the whole edge: the kernel's (probed against Laravel,
  // kernel/collections.mjs). The runtime used to carry a private subset here,
  // so `collect()` inside a compiled route and inside a view were two
  // different classes with two different answers (the inline one had no
  // groupBy/keyBy/where, and its implode()/chunk() disagreed with Laravel).
  rt.collect = (arr) => new Collection(arr == null ? [] : arr);
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
  //
  // The same object carries the **sections** (Illuminate\View\Concerns\ManagesLayouts):
  // a layout is a compiled view that yields the sections of the view that
  // extends it. The env is SHARED with the nested renders (the layout is
  // rendered with the same env), so the sections it yields are the ones the
  // child view pushed.
  const loopsStack = [];
  const sections = {};
  const sectionStack = [];
  const ownEnv = {
    addLoop(dataSrc) {
      let length = null;
      if (Array.isArray(dataSrc)) length = dataSrc.length;
      else if (dataSrc instanceof Map) length = dataSrc.size;
      // A Collection is countable (Illuminate\View\Concerns\ManagesLoops:25 -
      // count($collection) is the number of the items).
      else if (isCollection(dataSrc)) length = dataSrc.items.length;
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
    // ---- the sections (a layout yields them) ----
    // Illuminate\View\Concerns\ManagesLayouts: startSection($name, $content)
    // with a content sets the section; without one it captures the output
    // until stopSection().
    startSection(name, content) {
      const key = String(name);
      if (content !== null && content !== undefined) {
        // Illuminate\View\Concerns\ManagesLayouts:53 - the inline content is
        // escaped (e($content)). The captured block (@section ... @endsection)
        // is raw (stopSection() keeps the output as it is).
        sections[key] = rt.e(content);
        return;
      }
      sectionStack.push({ name: key, buffer: '' });
    },
    stopSection() {
      const s = sectionStack.pop();
      if (s) sections[s.name] = s.buffer;
    },
    yieldContent(name, fallback) {
      const key = String(name);
      if (Object.prototype.hasOwnProperty.call(sections, key)) return sections[key];
      // Illuminate\View\Concerns\ManagesLayouts:157 - the default is escaped
      // (e($default)).
      return fallback === null || fallback === undefined ? '' : rt.e(fallback);
    },
    hasSection(name) {
      return Object.prototype.hasOwnProperty.call(sections, String(name));
    },
    // The echo of a view that is capturing a section goes into the section.
    capturing() {
      return sectionStack.length > 0;
    },
    capture(text) {
      if (!sectionStack.length) return;
      sectionStack[sectionStack.length - 1].buffer += String(text);
    },
    // `make($view, $data)->render()` — the layout the view extends.
    make(name, data) {
      return {
        render: () => {
          const rendered = rt.view(String(name), data || {});
          return rendered && rendered.body != null ? String(rendered.body) : '';
        },
      };
    },
  };

  // The env is shared with the nested renders (a layout is rendered with the
  // env of the view that extends it) — the sections travel with it.
  const bladeEnv = (opts && opts.env) || ownEnv;

  rt.var = (k) => {
    if (Object.prototype.hasOwnProperty.call(dataCtx, k)) return dataCtx[k];
    if (k === '__env') return bladeEnv;
    return undefined;
  };

  // rt.vars(): the variables a compiled view sees (PHP's get_defined_vars()):
  // the data it was given + the locals the view set itself.
  rt.vars = (locals) => {
    const out = Object.assign({}, dataCtx);
    if (locals && typeof locals === 'object') {
      for (const k of Object.keys(locals)) {
        if (locals[k] !== undefined) out[k] = locals[k];
      }
    }
    return out;
  };

  // rt.array_diff_key($a, $b) — the keys of $a that $b does not have.
  rt.array_diff_key = (a, b) => {
    const out = {};
    if (!a || typeof a !== 'object') return out;
    for (const k of Object.keys(a)) {
      if (b && Object.prototype.hasOwnProperty.call(b, k)) continue;
      out[k] = a[k];
    }
    return out;
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
  rt.errorResponse = (e) => {
    const status = (e && e.status) || 500;
    const message = e && e.message ? String(e.message) : 'HTTP ' + status;
    // Illuminate\Foundation\Exceptions\Handler::prepareJsonResponse(): an
    // expectsJson request gets the exception as JSON, and Laravel encodes it
    // with JSON_PRETTY_PRINT (4 spaces) - convertExceptionToArray() answers
    // `['message' => $e->getMessage()]` for an HTTP exception. The bytes are
    // PHP's (the slashes escaped), so the encoder is the kernel's.
    if (liveRequest && typeof liveRequest.expectsJson === 'function' && liveRequest.expectsJson()) {
      return {
        status,
        headers: { 'content-type': 'application/json' },
        body: '{\n    "message": ' + phpJsonEncode(message) + '\n}',
      };
    }
    return {
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: message,
    };
  };
  rt.json = (value, status) => ({
    status: Number(status) || 200,
    headers: { 'content-type': 'application/json' },
    // PHP's json_encode bytes: the slashes are escaped ("a\/b"), the non-ASCII
    // as \uXXXX (the surrogate pairs too). A plain JSON.stringify would answer
    // a different body (Laravel's bytes are the parity).
    body: phpJsonEncode(value == null ? null : value),
  });
  // Laravel's Router::toResponse (Illuminate/Routing/Router.php:929-953): the
  // value a controller returns becomes the response - a string is the body
  // (text/html), an array or an object is JSON, null is an empty 200, and a
  // model that was just created answers 201.
  rt.toResponse = (value) => {
    // A response the controller already built (`view()`, `response()->json()`,
    // `redirect()`) passes through untouched - Laravel's prepareResponse does
    // the same with a Response instance.
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      typeof value.status === 'number' && value.body !== undefined &&
      typeof value.toJSON !== 'function'
    ) {
      return value;
    }
    if (value === null || value === undefined) {
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '' };
    }
    if (typeof value === 'string') {
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: value };
    }
    if (Array.isArray(value)) return rt.json(value);
    if (typeof value === 'object') {
      // A model that was just created: Laravel answers 201 (a JsonResponse).
      if (value.wasRecentlyCreated && typeof value.toJSON === 'function') {
        return rt.json(value.toJSON(), 201);
      }
      // Laravel's Model is Stringable (`__toString()` is `toJson()`), so a
      // model that is returned is its JSON with the text/html type.
      if (typeof value.toJSON === 'function') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: phpJsonEncode(value.toJSON()),
        };
      }
      return rt.json(value);
    }
    // A number or a boolean: Laravel's Response with the value as the body.
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: String(value) };
  };
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
      // Eloquent::paginate() — the LengthAwarePaginator (the page comes from
      // the request, the path from the request's URL).
      paginate: async (perPage, pageName, page) =>
        rt.paginate(M.query(db), perPage, pageName, page),
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

  // ---- rt.paginate: the LengthAwarePaginator (Illuminate\Pagination) ----
  // Laravel's PaginationState: the page comes from the request's input (a
  // valid integer >= 1, else 1), the path from the request's URL (without the
  // query string) and the query string from the request (withQueryString()).
  const phpFilterInt = (v) => {
    if (typeof v === 'number') return Number.isInteger(v) ? v : null;
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!/^[+-]?\d+$/.test(s)) return null;
    return parseInt(s, 10);
  };
  rt.paginate = async (builder, perPage, pageName, page) => {
    const name = pageName ? String(pageName) : 'page';
    const size = Number(perPage) || 15;
    let current = page ? Number(page) : 1;
    if (!page && liveRequest && typeof liveRequest.input === 'function') {
      const fromRequest = phpFilterInt(liveRequest.input(name));
      if (fromRequest !== null && fromRequest >= 1) current = fromRequest;
    }
    const res = await builder.paginate(size, current);
    const path =
      liveRequest && typeof liveRequest.url === 'function' ? liveRequest.url() : '/';
    const query =
      liveRequest && typeof liveRequest.query === 'function' ? liveRequest.query() : {};
    const paginator = new LengthAwarePaginator(res.data, res.total, res.per_page, res.current_page, {
      path,
      pageName: name,
    });
    // withQueryString(): the request's query string (Laravel's resolver).
    paginator.__requestQuery = query && typeof query === 'object' ? { ...query } : {};
    // links(): the pagination view (the compiled `pagination::tailwind`).
    const paginationView = configCtx['pagination.view'] || 'pagination::tailwind';
    paginator.links = () => {
      const rendered = rt.view(paginationView, {
        paginator,
        elements: paginator.elements(),
      });
      return rendered && rendered.body != null ? String(rendered.body) : '';
    };
    return paginator;
  };

  // rt.view: render a compiled Blade view with runtime data.
  rt.view = (name, data, opts) => {
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
      // The app's config (the translations, the pagination view): the view
      // renders with the same config as the controller.
      config: configCtx,
      // The same env: a layout yields the sections of the view that extends it.
      env: bladeEnv,
    });
    entry.main(sub);
    // Illuminate\View\Engines\PhpEngine::evaluatePath() returns
    // ltrim(ob_get_clean()) — a view's output never starts with whitespace.
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      // The response path trims (Laravel's HTTP response); the MAIL path does
      // not (Laravel's View::render() returns the raw output) - so the caller
      // asks for the raw body.
      body:
        opts && opts.raw
          ? String(sub.__output)
          : String(sub.__output).replace(/^[ \t\n\r\0\x0B]+/, ''),
    };
  };

  return rt;
}
export default buildRt;
