// compiler/runtime/rt-from-context.mjs — Runtime helpers (context → rt)
import { validationExceptionWithMessages, sessionErrorBag, DEFAULT_DONT_FLASH } from '../../kernel/validation.mjs';
import { Validator } from '../../kernel/validator.mjs';
import * as hashMod from '../../kernel/hash.mjs';
import { str as strHelpers } from '../../kernel/str.mjs';
import { arr as arrHelpers } from '../../kernel/arr.mjs';
import { LengthAwarePaginator } from '../../kernel/paginator.mjs';
import { phpJsonEncode } from '../../kernel/php-json.mjs';
import { Mailable } from '../../kernel/mailable.mjs';
import { setModelRuntime, setModelTimezone, phpDateString } from '../../kernel/model.mjs';
import { FormRequest } from '../../kernel/form-request.mjs';
import { JsonResource, resourceResponse } from '../../kernel/resources.mjs';
import { setRequestProvider } from '../../kernel/request-scope.mjs';
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
    else if (typeof v === 'object') {
      // `e($v)` is `htmlspecialchars((string) $v)`: a Collection stringifies
      // through its own __toString() first (a probe: `e(collect(['<b>']))` is
      // `[&quot;&lt;b&gt;&quot;]` - the cast escapes once, e() again).
      s = typeof v.toString === 'function' && typeof v.toJson === 'function' && typeof v.all === 'function'
        ? v.toString()
        : 'Object';
    } else s = String(v);
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
      // The PHP key ORDER has to survive: `Object.keys` enumerates an
      // integer-like key first and the result needs the `__lwOrder` marker, or
      // `json_encode`/`foreach` answer a different order than PHP for a union
      // that mixes int and string keys.
      const out = {};
      const order = [];
      for (const k of rt.phpKeys(a)) {
        if (Object.prototype.hasOwnProperty.call(out, k)) continue;
        out[k] = a[k];
        order.push(k);
      }
      for (const k of rt.phpKeys(b)) {
        if (Object.prototype.hasOwnProperty.call(out, k)) continue;
        out[k] = b[k];
        order.push(k);
      }
      Object.defineProperty(out, '__lwOrder', { value: order, enumerable: false });
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
    if (typeof v === 'object') {
      // `(string)$collection` goes through Collection::__toString() = its
      // toJson() (escaped only when escapeWhenCastingToString() asked for it) -
      // a probe: `'x' . collect([1, 2])` answers `x[1,2]`.
      if (typeof v.toString === 'function' && typeof v.toJson === 'function' && typeof v.all === 'function') {
        return v.toString();
      }
      return 'Object';
    }
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
  // The D1 binding, captured WITHOUT throwing: `rt.db()` raises when it is
  // missing, and the FormRequest lifecycle must not raise for a request whose
  // rules never touch the database. `unique`/`exists` check it themselves
  // (kernel/validator.mjs).
  const liveDb = (opts && opts.db) || null;
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
  // Laravel's `app('request')`: the ambient request a JsonResource resolves
  // through at json_encode() time (JsonResource::jsonSerialize() ->
  // resolve($request = null)). Each buildRt() republishes it, so a view's own
  // rt or a static snapshot never leaves a stale request behind - without an
  // HTTP context the lookup fails loud, exactly like the container would.
  setRequestProvider(() => (liveRequest || noHttp('request')));
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
    // The connection is OPTIONAL: only `unique`/`exists` read it, and the
    // validator raises its own precise error for them when it is missing
    // (kernel/validator.mjs - "validation rule unique needs opts.db"). Calling
    // rt.db() here threw for EVERY FormRequest, so a route whose rules are all
    // `required`/`string`/`max` answered 500 on a worker without a D1 binding
    // where Laravel answers 200.
    const validator = new Validator(data, opts.rules || {}, opts.messages || {}, {
      db: liveDb,
      attributes: opts.attributes || {},
      defaultMessages: defaultValidationMessages(),
    });
    if (hooks.includes('withValidator')) {
      await instance.withValidator(rt, validator);
    }
    if (hooks.includes('after')) {
      // Laravel registers the hook's RETURN VALUE on the validator
      // (FormRequest.php:114): `$validator->after($this->after(...))`, and it
      // calls the hook through the container with `['validator' => $validator]`
      // (FormRequest.php:112-115) - so `after(Validator $v)` receives it.
      // Without the argument the compiled hook's `$v` was undefined and the
      // request died with a TypeError where Laravel answers 422.
      const callback = await instance.after(rt, validator);
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
  // Arr::except() is what Blade's own view-data filter compiles to on Laravel
  // 11.0–11.42, so every view of an app on those versions needs rt.Arr.
  rt.Arr = arrHelpers;
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
    // config('app.fallback_locale'): Laravel's stock value is 'en', and a
    // config dumped before the key existed must still fall back there (the
    // fallback is what answers a key the locale file does not carry).
    const fallback = configCtx['app.fallback_locale'] || 'en';
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
          : entry.base === 'resource'
            ? // `Illuminate\Http\Resources\Json\JsonResource::__construct($resource)`
              // is INHERITED by the app's resource (a resource declares only
              // toArray()), so the wrapped value is the first constructor
              // argument - the compiled class has no constructor of its own.
              Object.assign(new JsonResource(Array.isArray(args) ? args[0] : undefined), built)
            : built;
    // The runtime: a mailable renders its view through it (`__lwMail`).
    Object.defineProperty(obj, '__rt', { value: rt, enumerable: false, configurable: true });
    // The class of the instance (the dispatch needs it) — not enumerable, so a
    // JSON answer does not show it.
    Object.defineProperty(obj, '__lwClass', { value: String(fqcn), enumerable: false });
    for (const [name, fn] of Object.entries(entry.methods || {})) {
      // A RESOURCE's methods are called by the base (JsonResource::resolve ->
      // toArray($request)), so the runtime binds `rt` itself: the compiled
      // signature is `(rt, ...args)` and the caller only supplies the args.
      // A resource's `with($request)` is a METHOD in Laravel while the base
      // carries the `with` ARRAY (the extra top-level keys); JS cannot keep the
      // two apart under one name, so the compiled method lands on `withData` -
      // the name the payload already reads (`resource.withData()`).
      const key = entry.base === 'resource' && name === 'with' ? 'withData' : name;
      obj[key] = entry.base === 'resource' ? (...a) => fn.call(obj, rt, ...a) : fn.bind(obj);
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

  // ---- the queue: `Job::dispatch()` writes a D1 row ----
  //
  // Laravel's `database` queue driver writes a row into `jobs` and a worker
  // consumes it later; `sync` runs the job inline. The edge has no long-lived
  // worker, so the row goes into `lw_jobs` and the CRON TRIGGER drains it
  // (`scheduled()` in src/worker.mjs) - the job runs AFTER the response, which
  // is the `database` behaviour. The build refuses the push when the worker has
  // no cron trigger (the job would never run).
  const QUEUE_TABLE = 'lw_jobs';
  const queueReady = new WeakMap();
  async function ensureQueueTable(db) {
    let ready = queueReady.get(db);
    if (!ready) {
      ready = (async () => {
        try {
          await db.prepare('SELECT 1 FROM "' + QUEUE_TABLE + '" LIMIT 1').first();
        } catch {
          await db
            .prepare(
              'CREATE TABLE IF NOT EXISTS "' + QUEUE_TABLE + '" (' +
                '"id" INTEGER PRIMARY KEY AUTOINCREMENT, "job" TEXT NOT NULL, ' +
                '"payload" TEXT NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0, ' +
                '"available_at" INTEGER NOT NULL, "created_at" TEXT NOT NULL)'
            )
            .run();
        }
      })();
      queueReady.set(db, ready);
    }
    return ready;
  }
  rt.queuePush = async (fqcn, args) => {
    const db = opts && opts.db ? opts.db : null;
    if (!db) throw new Error('Job::dispatch(): no database binding (env.DB) — the queue row has nowhere to go');
    await ensureQueueTable(db);
    const now = clockDate();
    const res = await db
      .prepare(
        'INSERT INTO "' + QUEUE_TABLE + '" ("job", "payload", "attempts", "available_at", "created_at") ' +
          'VALUES (?, ?, 0, ?, ?)'
      )
      .bind(String(fqcn), JSON.stringify(args || []), Math.floor(now.getTime() / 1000), phpDateString(now))
      .run();
    // Laravel's `dispatch()` answers the pending dispatch (an object), not a
    // boolean; the compiled call sites only ever chain `->onQueue()` etc.,
    // which the build refuses, so the id is the honest answer.
    return Number((res && res.meta && res.meta.last_row_id) || 0);
  };
  // The consumer: run up to `limit` due rows through the compiled job classes.
  // `handlers` maps a job FQCN to `{ ctor, handle }` (the compiled class).
  rt.queueDrain = async (db, handlers, limit = 10) => {
    if (!db || !handlers) return { ran: 0, failed: 0 };
    await ensureQueueTable(db);
    const nowS = Math.floor(clockDate().getTime() / 1000);
    const rows = await db
      .prepare('SELECT "id", "job", "payload", "attempts" FROM "' + QUEUE_TABLE + '" WHERE "available_at" <= ? ORDER BY "id" LIMIT ?')
      .bind(nowS, Number(limit) || 10)
      .all();
    let ran = 0;
    let failed = 0;
    for (const row of (rows && rows.results) || []) {
      const entry = handlers[String(row.job)];
      if (!entry) {
        // An unknown job cannot run: drop it (a row that never runs would block
        // the queue forever) and count it as failed.
        await db.prepare('DELETE FROM "' + QUEUE_TABLE + '" WHERE "id" = ?').bind(row.id).run();
        failed++;
        continue;
      }
      try {
        const args = JSON.parse(String(row.payload || '[]'));
        const instance = await entry.build(rt, args);
        await instance.handle();
        await db.prepare('DELETE FROM "' + QUEUE_TABLE + '" WHERE "id" = ?').bind(row.id).run();
        ran++;
      } catch (e) {
        failed++;
        const attempts = Number(row.attempts || 0) + 1;
        if (attempts >= 3) {
          await db.prepare('DELETE FROM "' + QUEUE_TABLE + '" WHERE "id" = ?').bind(row.id).run();
        } else {
          // The retry backoff is Laravel's default (0): the row is due again
          // immediately, with the attempt counted.
          await db
            .prepare('UPDATE "' + QUEUE_TABLE + '" SET "attempts" = ?, "available_at" = ? WHERE "id" = ?')
            .bind(attempts, nowS, row.id)
            .run();
        }
      }
    }
    return { ran, failed };
  };

  // ---- rt.gateGlobal: a Gate::define('x', 'Class@method') ability ----
  // The dump records the definition (the class + method + the guest rule), and
  // the build compiled the class; the kernel's Gate runs it in Laravel's order
  // (before -> the ability -> after, Gate.php:428-453). A CLOSURE never
  // reaches here: the build refuses it.
  const gateDefinitions = (opts && opts.gateDefinitions && typeof opts.gateDefinitions === 'object')
    ? opts.gateDefinitions
    : {};
  rt.gateGlobal = async (ability, subject) => {
    const def = gateDefinitions[String(ability)];
    if (!def) {
      throw new Error('gate: no definition for the ability ' + String(ability) + ' — the build did not dump it');
    }
    const user = (await rt.auth().user()) ?? null;
    // canBeCalledWithUser(): a guest reaches the callback only when its first
    // parameter allows it.
    if (user === null && def.guestAllowed === false) return false;
    const [cls, method] = String(def.callback).split('@');
    // The compiled class registry (`opts.classes`): the same map `newClass`
    // reads. The instance is built through it (the ctor's deps included).
    if (!classesMap[String(cls)]) {
      throw new Error('gate: the class ' + cls + ' is not compiled — the build did not include it');
    }
    const instance = await rt.newClass(cls, []);
    const fn = instance[method || '__invoke'];
    if (typeof fn !== 'function') {
      throw new Error('gate: ' + cls + ' has no method ' + (method || '__invoke') + '()');
    }
    // The compiled methods take `rt` as their FIRST argument (the class
    // compiler emits `async function (rt, $user, ...)`), so the gate hands it
    // over before the user - otherwise `rt` is the user and every `rt.*` call
    // inside the ability throws.
    const result = await fn.call(
      instance,
      rt,
      user,
      ...(subject === null || subject === undefined ? [] : [subject])
    );
    return rt.truthy(result);
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
    if (strict) return arr.some((x) => phpIdentical(x, needle));
    return arr.some((x) => rt.looseEq(x, needle));
  };
  const isObj = (v) => v !== null && typeof v === 'object';
  const arrValues = (v) => (Array.isArray(v) ? v.slice() : (isObj(v) ? rt.phpKeys(v).map((k) => v[k]) : []));
  rt.implode = (glue, arr) => arrValues(arr).map((x) => (x == null ? '' : String(x))).join(glue == null ? '' : String(glue));
  // PHP explode(): the third argument caps the split. Positive N keeps N-1
  // separators (the tail stays whole), 0 is treated as 1, and a negative N
  // drops the last -N components. PHP 8 throws ValueError on an empty
  // separator; an unmatched separator always yields the whole string.
  rt.explode = (delim, str, limit) => {
    const d = String(delim);
    const s = String(str);
    if (d === '') {
      const err = new Error('explode(): Argument #1 ($separator) cannot be empty');
      err.name = 'ValueError';
      err.phpClass = 'ValueError';
      throw err;
    }
    if (limit === undefined || limit === null) return s.split(d);
    const n = Number(limit) | 0;
    if (n === 0) return [s];
    const parts = s.split(d);
    if (parts.length <= 1) return parts;
    if (n > 0) {
      if (parts.length <= n) return parts;
      const head = parts.slice(0, n - 1);
      head.push(parts.slice(n - 1).join(d));
      return head;
    }
    return parts.slice(0, Math.max(parts.length + n, 0));
  };
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
  // PHP's sprintf() (ext/standard/formatted_print.c): the full format is
  // `%[argnum$][flags][width][.precision]specifier` with the flags `-`, `+`,
  // ` `, `0` and `'<pad>`, a `*` width/precision, and the specifiers
  // `b c d e E f F g G o s u x X %`. The old code only understood `%s`/`%d`/`%u`
  // and ignored flags/width/precision/argnum, so `sprintf('%05d', 42)`
  // answered '42' where PHP answers '00042' - silently wrong output.
  const sprintfInt = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === null || v === undefined) return 0;
    // PHP casts an array/object to int as 1 (0 when empty), NOT through its
    // string form - a probe: sprintf('%d', [5]) is 1 in PHP 8.3.
    if (typeof v === 'object') return Object.keys(v).length ? 1 : 0;
    const m = /^[+-]?\d+/.exec(String(v).trim());
    return m ? parseInt(m[0], 10) : 0;
  };
  const sprintfFloat = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === null || v === undefined) return 0;
    const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(String(v).trim());
    return m ? parseFloat(m[0]) : 0;
  };
  const unsigned64 = (n) => BigInt.asUintN(64, BigInt(n));
  const padTo = (body, width, opts, signPrefix) => {
    if (width <= body.length) return body;
    const fill = width - body.length;
    const padChar = opts.padChar;
    if (opts.left) return body + padChar.repeat(fill);
    if (prepadZeroable(opts)) {
      // `%05d` pads between the sign/prefix and the digits: '-00042' (the
      // sign is already part of `body`, so it is not written twice).
      return signPrefix + '0'.repeat(fill) + body.slice(signPrefix.length);
    }
    return padChar.repeat(fill) + body;
  };
  const prepadZeroable = (opts) => opts.zero && !opts.left && opts.padChar === ' ';
  // PHP 8.3's ' ' flag is a FILLER selector (pad with spaces, the default),
  // not a positive-sign flag: a probe shows sprintf('% d', 42) === '42' and
  // sprintf('% f', 3.5) === '3.500000'. Only '+' forces a sign.
  const sprintfSign = (neg, opts) => (neg ? '-' : opts.plus ? '+' : '');
  rt.sprintf = (fmt, ...args) => {
    const f = String(fmt);
    let out = '';
    let slot = 0;
    let needed = 0;
    const takeArg = (index) => {
      const at = index === null ? slot++ : index;
      needed = Math.max(needed, at + 1);
      if (at >= args.length) {
        const err = new Error(`${needed + 1} arguments are required, ${args.length + 1} given`);
        err.name = 'ArgumentCountError';
        err.phpClass = 'ArgumentCountError';
        throw err;
      }
      return args[at];
    };
    for (let i = 0; i < f.length; i++) {
      if (f[i] !== '%') {
        out += f[i];
        continue;
      }
      i += 1;
      if (f[i] === '%') {
        out += '%';
        continue;
      }
      let argIndex = null;
      const mArg = /^(\d+)\$/.exec(f.slice(i));
      if (mArg) {
        argIndex = Number(mArg[1]) - 1;
        i += mArg[0].length;
      }
      const opts = { left: false, plus: false, space: false, zero: false, padChar: ' ' };
      for (;;) {
        const c = f[i];
        if (c === '-') opts.left = true;
        else if (c === '+') opts.plus = true;
        else if (c === ' ') opts.space = true;
        else if (c === '0') opts.zero = true;
        else if (c === "'") {
          opts.padChar = f[i + 1] === undefined ? ' ' : f[i + 1];
          i += 1;
        } else break;
        i += 1;
      }
      let width = 0;
      if (f[i] === '*') {
        width = Math.abs(sprintfInt(takeArg(argIndex)) | 0);
        if (argIndex !== null) argIndex += 0;
        i += 1;
      } else {
        const mW = /^\d+/.exec(f.slice(i));
        if (mW) {
          width = Number(mW[0]);
          i += mW[0].length;
        }
      }
      let prec = null;
      if (f[i] === '.') {
        i += 1;
        if (f[i] === '*') {
          prec = Math.abs(sprintfInt(takeArg(argIndex)) | 0);
          i += 1;
        } else {
          const mP = /^\d*/.exec(f.slice(i));
          prec = mP[0] === '' ? 0 : Number(mP[0]);
          i += mP[0].length;
        }
      }
      const spec = f[i];
      const value = spec === undefined ? undefined : takeArg(argIndex);
      let body;
      let sign = '';
      switch (spec) {
        case 's': {
          // PHP's string cast: true -> '1', false/null -> '', an array ->
          // 'Array' (phpToStr matches; String(true) would answer 'true').
          body = value === null || value === undefined ? '' : phpToStr(value);
          if (prec !== null) body = body.slice(0, prec);
          break;
        }
        case 'd':
        case 'u': {
          const n = sprintfInt(value);
          sign = sprintfSign(n < 0 && spec === 'd', opts);
          body = String(Math.abs(n));
          if (spec === 'u') {
            body = unsigned64(n).toString();
            sign = '';
          }
          break;
        }
        case 'b': {
          const n = sprintfInt(value);
          body = unsigned64(n).toString(2);
          break;
        }
        case 'o': {
          body = unsigned64(sprintfInt(value)).toString(8);
          break;
        }
        case 'x':
        case 'X': {
          body = unsigned64(sprintfInt(value)).toString(16);
          if (spec === 'X') body = body.toUpperCase();
          break;
        }
        case 'c': {
          body = String.fromCodePoint(sprintfInt(value) & 0x10ffff);
          break;
        }
        case 'f':
        case 'F': {
          const n = sprintfFloat(value);
          sign = sprintfSign(n < 0 || Object.is(n, -0), opts);
          body = Math.abs(n).toFixed(prec === null ? 6 : prec);
          break;
        }
        case 'e':
        case 'E': {
          const n = sprintfFloat(value);
          sign = sprintfSign(n < 0, opts);
          body = Math.abs(n).toExponential(prec === null ? 6 : prec);
          // PHP writes `1.000000e+1`; JS writes `1.000000e+1` too - only the
          // exponent's width differs (`e+1` vs PHP's `e+1`), so nothing to fix.
          if (spec === 'E') body = body.toUpperCase();
          break;
        }
        case 'g':
        case 'G': {
          const n = sprintfFloat(value);
          sign = sprintfSign(n < 0, opts);
          const abs = Math.abs(n);
          const p = Math.max(prec === null ? 6 : prec, 1);
          if (abs === 0 || !Number.isFinite(abs)) {
            body = abs === 0 ? '0' : phpToStr(abs);
            break;
          }
          // PHP's %g (php_conv_fp with 'G'): scientific when the exponent is
          // below -4 or at/above the precision, otherwise fixed - then the
          // trailing zeros go, but the scientific form always keeps '.0'
          // ('%g' of 1000000 is '1.0e+6', not '1e+6').
          const exp = Math.floor(Math.log10(abs));
          if (exp < -4 || exp >= p) {
            let s = abs.toExponential(p - 1);
            if (!s.includes('.')) s = s.replace('e', '.0e');
            s = s.replace(/\.(\d*?)0+e/, (m, d) => (d ? '.' + d + 'e' : '.0e'));
            body = s;
          } else {
            let s = abs.toFixed(Math.max(p - 1 - exp, 0));
            if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
            body = s;
          }
          if (spec === 'G') body = body.toUpperCase();
          break;
        }
        default: {
          const err = new Error(`Unknown format specifier "${spec === undefined ? '' : spec}"`);
          err.name = 'ValueError';
          err.phpClass = 'ValueError';
          throw err;
        }
      }
      out += padTo(sign + body, width, opts, sign);
    }
    return out;
  };
  rt.strtolower = (s) => String(s).toLowerCase();
  rt.strtoupper = (s) => String(s).toUpperCase();
  // rt.trim/ltrim/rtrim are defined with the string helpers below — PHP's trim
  // family takes a charlist (with '..' ranges) and its own default character
  // set, which JavaScript's String.prototype.trim() does not reproduce.

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
  // Str::is() / the global str_is() helper: delegate to the kernel (the same
  // rule, and it honors Laravel 11's third `$ignoreCase` argument).
  rt.str_is = (pattern, value, ignoreCase) => strHelpers.is(pattern, value, !!ignoreCase);
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

  // PHP's array keys: a canonical decimal integer string IS the int key
  // ('0' and 0 are one key; '01' and '+1' stay strings).
  const phpArrayKey = (k) => {
    const s = String(k);
    return /^(?:0|-?[1-9]\d*)$/.test(s) ? Number(s) : s;
  };
  /** A PHP array's `[key, value]` pairs, in PHP order (a list is one too). */
  const arrayEntries = (v) => {
    const out = [];
    if (Array.isArray(v)) v.forEach((x, i) => out.push([i, x]));
    else for (const k of rt.phpKeys(v)) out.push([phpArrayKey(k), v[k]]);
    return out;
  };
  /**
   * PHP's `==` on two arrays: the same KEY/VALUE pairs, the values compared
   * LOOSELY and the key ORDER irrelevant (order matters only for `===`). The
   * old code fell through to `a === b`, so `[1,2] == ['0'=>1,'1'=>2]` and
   * `['a'=>1,'b'=>2] == ['b'=>2,'a'=>1]` answered false where PHP answers true
   * (a probe: both true, while `[1,2] == [2,1]` is false - the same keys with
   * different values).
   */
  const looseArrayEq = (a, b) => {
    const ea = arrayEntries(a);
    const eb = arrayEntries(b);
    if (ea.length !== eb.length) return false;
    return ea.every(([ka, va]) => {
      const hit = eb.find(([kb]) => kb === ka);
      return hit !== undefined && rt.looseEq(va, hit[1]);
    });
  };
  /**
   * PHP's `===` on two arrays: the same pairs IN THE SAME ORDER, the values
   * identical (a probe: `[1,2] === [1,2]` true, the same pairs reordered
   * false), and `in_array([1,2], [[1,2]], true)` is true - the old `strict`
   * path only compared scalars (`x === needle`), so an array needle never
   * matched.
   */
  const phpIdentical = (a, b) => {
    if (a === b) return true;
    const ta = tagOf(a);
    if (ta !== tagOf(b) || ta !== 'arr') return false;
    const ea = arrayEntries(a);
    const eb = arrayEntries(b);
    if (ea.length !== eb.length) return false;
    for (let i = 0; i < ea.length; i++) {
      if (ea[i][0] !== eb[i][0]) return false;
      if (!phpIdentical(ea[i][1], eb[i][1])) return false;
    }
    return true;
  };

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
    if (ta === 'arr' && tb === 'arr') return looseArrayEq(a, b);
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
    if (Array.isArray(src)) return src.slice();
    if (typeof src === 'object' && src !== null) {
      if (Array.isArray(src.__items)) return src.__items.slice();
      // A Collection spreads its ITEMS (PHP: [...collect([1,2])] => [1,2] -
      // Illuminate\Collections\Collection::getIterator()).
      if (isCollection(src)) return src.items.slice();
      return Object.keys(src).map((k) => src[k]);
    }
    // PHP: "Only arrays and Traversables can be unpacked" - a scalar or null
    // is a fatal Error, not a silent one-element list.
    const err = new Error('Only arrays and Traversables can be unpacked');
    err.name = 'Error';
    err.phpClass = 'Error';
    throw err;
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
    // PHP 8's max()/min() (ext/standard/array.c): the comparison is the
    // standard `<`/`>` - numeric when BOTH operands are numeric, else a string
    // compare - so `Number()` answered 'a' for `max(['a','b'])` (NaN compares
    // false, the first element stuck) where PHP answers 'b', and an EMPTY list
    // answered `undefined` where PHP throws ValueError (a fatal error, i.e. a
    // Laravel 500).
    if (vals.length === 0) {
      const err = new Error((dir > 0 ? 'max' : 'min') + '(): Argument #1 ($value) must contain at least one element');
      err.name = 'ValueError';
      err.phpClass = 'ValueError';
      throw err;
    }
    let best = vals[0];
    for (let i = 1; i < vals.length; i++) {
      const v = vals[i];
      if (dir > 0 ? rt.gt(v, best) : rt.lt(v, best)) best = v;
    }
    return best;
  };
  rt.max = (...a) => maxMin(1, a);
  rt.min = (...a) => maxMin(-1, a);

  // ---- strings (continued) ----
  // PHP's trim()/ltrim()/rtrim() share one charlist parser (php_charmask,
  // ext/standard/string.c): the default charlist is " \t\n\r\0\x0B" — NOT
  // JavaScript's WhiteSpace+LineTerminator set — and an explicit charlist may
  // hold '..' ranges (`trim($s, 'a..z')`). A malformed range stays literal
  // (PHP also raises a warning the compiled rung cannot print).
  const PHP_WS = ' \t\n\r\u0000\u000B';
  const charMask = (chars) => {
    const set = new Set();
    const s = String(chars);
    for (let i = 0; i < s.length; i += 1) {
      if (s[i + 1] === '.' && s[i + 2] === '.' && i + 3 < s.length) {
        const from = s.charCodeAt(i);
        const to = s.charCodeAt(i + 3);
        if (from <= to) {
          for (let c = from; c <= to; c += 1) set.add(String.fromCharCode(c));
          i += 3;
          continue;
        }
      }
      set.add(s[i]);
    }
    return set;
  };
  const trimWith = (s, chars, dir) => {
    const mask = charMask(chars);
    const a = String(s == null ? '' : s).split('');
    let i = 0;
    let j = a.length;
    if (dir !== 'r') while (i < j && mask.has(a[i])) i += 1;
    if (dir !== 'l') while (j > i && mask.has(a[j - 1])) j -= 1;
    return a.slice(i, j).join('');
  };
  rt.trim = (s, chars) => trimWith(s, chars == null ? PHP_WS : chars, 'lr');
  rt.ltrim = (s, chars) => trimWith(s, chars == null ? PHP_WS : chars, 'l');
  rt.rtrim = (s, chars) => trimWith(s, chars == null ? PHP_WS : chars, 'r');
  rt.ucwords = (s) => String(s == null ? '' : s).replace(/(^|[ \t\r\n\f\u000B])(\S)/g, (m, p, c) => p + c.toUpperCase());
  rt.strrev = (s) => String(s == null ? '' : s).split('').reverse().join('');
  // PHP 8's strpos()/strrpos() offset rules (ext/standard/string.c): a NEGATIVE
  // offset counts from the end (strpos('abca','a',-2) is 3, strpos('abc','a',
  // -1) is false), an offset past the haystack is a ValueError - and the old
  // code clamped a negative offset to 0 (`Number(off)|0` + JS indexOf), so it
  // answered 0 where PHP answers false, or searched the whole string.
  const phpOffset = (name, off, len) => {
    const n = off == null ? 0 : Number(off) | 0;
    if (n > len || -n > len) {
      const err = new Error(name + '(): Argument #3 ($offset) must be contained in argument #1 ($haystack)');
      err.name = 'ValueError';
      err.phpClass = 'ValueError';
      throw err;
    }
    return n;
  };
  rt.strpos = (h, n, off) => {
    const s = String(h == null ? '' : h);
    const raw = phpOffset('strpos', off, s.length);
    const start = raw < 0 ? s.length + raw : raw;
    const i = s.indexOf(String(n), start);
    return i < 0 ? false : i;
  };
  rt.strrpos = (h, n, off) => {
    const s = String(h == null ? '' : h);
    const needle = String(n);
    const raw = phpOffset('strrpos', off, s.length);
    if (raw >= 0) {
      // A zero/positive offset skips the first `$offset` bytes: the last
      // occurrence must not start before it (strrpos('abc','c',3) is false).
      const i = s.lastIndexOf(needle);
      return i < raw ? false : i;
    }
    // A negative offset skips the last `-$offset` bytes, so the needle's START
    // must be at or before `len + $offset` (strrpos('abca','a',-1) is 3,
    // strrpos('abca','a',-2) is 0 - the search region is shorter, not offset).
    const i = s.slice(0, s.length + raw + 1).lastIndexOf(needle);
    return i < 0 ? false : i;
  };
  // PHP 8's substr_count($h, $needle, $offset = 0, $length = null): the needle
  // cannot be empty (ValueError), a NEGATIVE offset counts from the end and a
  // NEGATIVE length excludes that many characters from the end, both must be
  // "contained in the haystack" (ValueError when not) - and the old code
  // ignored `$length` entirely and let a negative offset clamp to 0, so
  // substr_count('aaa','a',1,1) answered 2 where PHP answers 1.
  rt.substr_count = (h, n, off, len) => {
    const s = String(h == null ? '' : h);
    const needle = String(n);
    if (needle === '') {
      const err = new Error('substr_count(): Argument #2 ($needle) cannot be empty');
      err.name = 'ValueError';
      err.phpClass = 'ValueError';
      throw err;
    }
    const rawOff = phpOffset('substr_count', off, s.length);
    const start = rawOff < 0 ? s.length + rawOff : rawOff;
    let region = s.slice(start);
    if (len !== undefined && len !== null) {
      const l = Number(len) | 0;
      // The length must be contained in the REMAINING region (PHP 8 checks
      // `$offset + $length`, so -3 is fine at offset 1 of a 4-char haystack
      // only while it stays inside it).
      if (l > region.length || -l > region.length) {
        const err = new Error('substr_count(): Argument #4 ($length) must be contained in argument #1 ($haystack)');
        err.name = 'ValueError';
        err.phpClass = 'ValueError';
        throw err;
      }
      region = l < 0 ? region.slice(0, region.length + l) : region.slice(0, l);
    }
    let count = 0;
    let i = 0;
    for (;;) {
      const at = region.indexOf(needle, i);
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
  // The json_encode() flags with a byte-exact answer at the edge. PHP's values:
  // JSON_HEX_TAG 1, JSON_HEX_AMP 2, JSON_HEX_APOS 4, JSON_HEX_QUOT 8,
  // JSON_FORCE_OBJECT 16, JSON_UNESCAPED_SLASHES 64, JSON_UNESCAPED_UNICODE 256,
  // JSON_PRETTY_PRINT 128, JSON_THROW_ON_ERROR 4194304 (a 32-bit int in PHP, so
  // the JS bit mask must not truncate it).
  const JSON_FORCE_OBJECT = 16;
  const JSON_UNESCAPED_SLASHES = 64;
  const JSON_PRETTY_PRINT = 128;
  const JSON_UNESCAPED_UNICODE = 256;
  const JSON_THROW_ON_ERROR = 4194304;
  const JSON_SUPPORTED_FLAGS =
    JSON_HEX_FLAGS | JSON_FORCE_OBJECT | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR;
  // PHP's json_encode() pretty printer (ext/json/json.c: php_json_pretty_print):
  // four spaces per level, a newline after every brace/comma, `": "` after a
  // key and `[]`/`{}` for an empty container (no newline inside it).
  const jsonPrettyPrint = (json) => {
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
        // An empty container stays on one line.
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
  };
  // The value JSON_FORCE_OBJECT produced, encoded as an OBJECT (keys quoted,
  // in the map's own order). JSON_FORCE_OBJECT is documented as forcing a
  // PHP object, so every level of the map is written the same way.
  const phpJsonEncodeMapAsObject = (v) => {
    if (v === null || typeof v !== 'object') return phpJsonEncode(v);
    const keys = Object.keys(v);
    return '{' + keys.map((k) => phpJsonEncode(String(k)) + ':' + phpJsonEncodeMapAsObject(v[k])).join(',') + '}';
  };
  // JSON_FORCE_OBJECT: every ARRAY becomes an object (the depth walk keeps the
  // value shape, the keys become 0..n-1).
  const jsonForceObject = (v) => {
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
  };
  rt.json_encode = (v, flags, depth) => {
    const f = flags == null ? 0 : Number(flags);
    const d = depth == null ? 512 : Number(depth) | 0;
    if (f & ~JSON_SUPPORTED_FLAGS) {
      throw new Error(
        'json_encode() flags ' + f + ' are not supported at the edge — PHP would write a different ' +
          'body with them (the ported ones are JSON_HEX_TAG|JSON_HEX_AMP|JSON_HEX_APOS|JSON_HEX_QUOT, ' +
          'JSON_FORCE_OBJECT, JSON_UNESCAPED_SLASHES, JSON_PRETTY_PRINT, JSON_UNESCAPED_UNICODE, ' +
          'JSON_THROW_ON_ERROR) — drop the flags or write a port'
      );
    }
    const value = v == null ? null : v;
    // JSON_FORCE_OBJECT shapes an ARRAY into an OBJECT here, but a PHP object
    // is a JS object already, so phpJsonEncode() would write it as `{...}` -
    // and an EMPTY array must print `{}` too. The map is converted to its
    // ordered PAIRS before encoding so the empty case survives.
    const shaped = f & JSON_FORCE_OBJECT ? jsonForceObject(value) : value;
    if (jsonDepth(shaped) > d) {
      // PHP returns false; with JSON_THROW_ON_ERROR it throws JsonException.
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
        if (shaped !== null && typeof shaped === 'object') json = phpJsonEncodeMapAsObject(shaped);
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
  };
  // PHP's json_decode(): invalid JSON answers NULL (only a warning) unless
  // JSON_THROW_ON_ERROR is passed, which raises JsonException("Syntax error")
  // (ext/json/parser). `JSON.parse` throws on every invalid input, so the old
  // one-liner turned a controller's `json_decode($request->input('x'))` into an
  // uncaught SyntaxError (a 500) where PHP answered null - and `''` was one of
  // those inputs. The depth budget is PHP's too: `json_decode('[1]', true, 1)`
  // is NULL / JsonException("Maximum stack depth exceeded") because a container
  // costs a level (`json_decode('[]', true, 1)` is already NULL, probed on PHP
  // 8.3), while a scalar needs none, and `$depth <= 0` is a ValueError.
  // `assoc` does not change the JS shape (a plain object is this runtime's PHP
  // array - see the documented object/array ambiguity).
  const jsonDecodeLevels = (v) => {
    if (v === null || typeof v !== 'object') return 0;
    let deepest = 0;
    for (const k of Object.keys(v)) {
      const d = jsonDecodeLevels(v[k]);
      if (d > deepest) deepest = d;
    }
    return 1 + deepest;
  };
  rt.json_decode = (s, _assoc, depth, flags) => {
    const budget = depth === undefined || depth === null ? 512 : Number(depth);
    if (!(budget > 0)) {
      const err = new Error('json_decode(): Argument #3 ($depth) must be greater than 0');
      err.name = 'ValueError';
      err.phpClass = 'ValueError';
      throw err;
    }
    const throwOnError = Number(flags || 0) & JSON_THROW_ON_ERROR;
    let out;
    try {
      out = JSON.parse(String(s == null ? '' : s));
    } catch (e) {
      if (throwOnError) {
        const err = new Error('Syntax error');
        err.name = 'JsonException';
        err.phpClass = 'JsonException';
        throw err;
      }
      return null;
    }
    if (jsonDecodeLevels(out) + 1 > budget) {
      if (throwOnError) {
        const err = new Error('Maximum stack depth exceeded');
        err.name = 'JsonException';
        err.phpClass = 'JsonException';
        throw err;
      }
      return null;
    }
    return out;
  };

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
  // PHP's array_filter(): the surviving items KEEP their keys (a list with a
  // gap encodes as an object - not reindexed), the default predicate is
  // PHP truthiness ('' / '0' / 0 / null / [] are dropped - JS `!!` would keep
  // "0"), and ARRAY_FILTER_USE_KEY (mode 2) / ARRAY_FILTER_USE_BOTH (mode 1)
  // change the callback's arguments. The result is built as an order-marked
  // object so rt.phpKeys/the encoder keep PHP's insertion order and emit a
  // JSON array when the keys turn out to be 0..n-1.
  rt.array_filter = (arr, cb, mode) => {
    const isList = Array.isArray(arr);
    const keys = isList ? arr.map((_, i) => i) : isObj(arr) ? rt.phpKeys(arr) : [];
    const out = {};
    const order = [];
    for (const k of keys) {
      const v = arr[k];
      const phpKey = isList || /^\d+$/.test(String(k)) ? Number(k) : k;
      let keep;
      if (typeof cb === 'function') {
        if (mode === 2) keep = rt.truthy(cb(phpKey));
        else if (mode === 1) keep = rt.truthy(cb(v, phpKey));
        else keep = rt.truthy(cb(v));
      } else {
        keep = rt.truthy(v);
      }
      if (keep) {
        order.push(String(k));
        out[k] = v;
      }
    }
    Object.defineProperty(out, '__lwOrder', { value: order, enumerable: false });
    return out;
  };
  // PHP's array_map(): with exactly ONE array the keys are preserved (a list
  // returns a list, an assoc array returns an assoc array of the same keys);
  // with TWO OR MORE arrays the keys are dropped (a list) and the shorter
  // arrays are padded with null. A `null` callback (the zip form) returns the
  // tuples. The old `arrValues(...).map()` dropped every key and reindexed.
  rt.array_map = (cb, ...arrs) => {
    if (arrs.length <= 1) {
      const a = arrs[0];
      if (Array.isArray(a)) return a.map((v) => (cb ? cb(v) : v));
      if (isObj(a)) {
        const out = {};
        const order = [];
        for (const k of rt.phpKeys(a)) {
          order.push(String(k));
          out[k] = cb ? cb(a[k]) : a[k];
        }
        Object.defineProperty(out, '__lwOrder', { value: order, enumerable: false });
        return out;
      }
      return [];
    }
    const lists = arrs.map(arrValues);
    const n = lists.reduce((m, l) => Math.max(m, l.length), 0);
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const vals = lists.map((l) => (i < l.length ? l[i] : null));
      out.push(cb ? cb(...vals) : vals);
    }
    return out;
  };

  rt.str = phpToStr;
  rt.strval = phpToStr;
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
  // `Collection::wrap($value)` is NOT `collect($value)`: wrap() applies
  // Arr::wrap (a non-array becomes ONE item), while collect() runs
  // getArrayableItems() (an Arrayable becomes its attributes).
  rt.collectionWrap = (value) => Collection.wrap(value);
  rt.Collection = Collection;
  // `mapInto(SomeModel::class)`/`pipeInto(SomeModel::class)`: `SomeModel::class`
  // compiles to the FQCN STRING (only a registered model can be named at the
  // edge), and a compiled class is built by the registry - its constructor
  // takes the dependency bundle, not the plain arguments.
  Collection.__lwNewClass = (fqcn, args) => rt.newClass(fqcn, args);

  // ---- rt.now() minimal Carbon stub ----
  //
  // Laravel sets PHP's default timezone from `config('app.timezone')` and every
  // Carbon date renders in it, so a date in a body is the APP's local time -
  // not UTC. The stub renders in the same zone: `Intl` is the only timezone
  // database a Worker has (it ships the full IANA set), and the parts are
  // cached per zone. A UTC app takes the fast path (the `getUTC*` accessors).
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad4 = (n) => String(n).padStart(4, '0');
  const APP_TZ = String(configCtx['app.timezone'] || 'UTC');
  const TZ_IS_UTC = APP_TZ === 'UTC' || APP_TZ === 'Etc/UTC' || APP_TZ === 'GMT';
  const tzFormatters = new Map();
  function zoneFormatter(tz) {
    let f = tzFormatters.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      tzFormatters.set(tz, f);
    }
    return f;
  }
  /** The wall-clock parts of `d` in `tz` (a timezone the app configured). */
  function zoneParts(d, tz) {
    if (tz === null || tz === undefined || TZ_IS_UTC) {
      return {
        Y: d.getUTCFullYear(),
        m: d.getUTCMonth() + 1,
        d: d.getUTCDate(),
        H: d.getUTCHours(),
        i: d.getUTCMinutes(),
        s: d.getUTCSeconds(),
      };
    }
    const parts = {};
    for (const part of zoneFormatter(tz).formatToParts(d)) {
      if (part.type !== 'literal') parts[part.type] = part.value;
    }
    // `hour12: false` renders midnight as 24 in some engines; PHP's `H` is 00.
    const hour = Number(parts.hour) % 24;
    return {
      Y: Number(parts.year),
      m: Number(parts.month),
      d: Number(parts.day),
      H: hour,
      i: Number(parts.minute),
      s: Number(parts.second),
    };
  }
  function makeCarbon(date, tz = APP_TZ) {
    const d = new Date(date.getTime());
    const api = {
      _d: d,
      _tz: tz,
      format(fmt) {
        const p = zoneParts(d, tz);
        const Y = pad4(p.Y);
        const m = pad2(p.m);
        const dd = pad2(p.d);
        const H = pad2(p.H);
        const i = pad2(p.i);
        const s = pad2(p.s);
        const n = String(p.m);
        const j = String(p.d);
        const G = String(p.H);
        const g0 = p.H % 12 || 12;
        const g = String(g0);
        const a = p.H < 12 ? 'am' : 'pm';
        const A = p.H < 12 ? 'AM' : 'PM';
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
      // The date in the APP's timezone (Carbon renders in its own zone, and
      // Laravel's is `config('app.timezone')`).
      toDateString() {
        const p = zoneParts(d, tz);
        return pad4(p.Y) + '-' + pad2(p.m) + '-' + pad2(p.d);
      },
      toDateTimeString() {
        const p = zoneParts(d, tz);
        return pad4(p.Y) + '-' + pad2(p.m) + '-' + pad2(p.d) + ' ' + pad2(p.H) + ':' + pad2(p.i) + ':' + pad2(p.s);
      },
      get timezoneName() { return tz; },
      getTimezone() { return tz; },
      get timestamp() { return Math.floor(d.getTime() / 1000); },
      getTimestamp() { return Math.floor(d.getTime() / 1000); },
      addDays(n) { const nd = new Date(d.getTime()); nd.setUTCDate(nd.getUTCDate() + Number(n)); return makeCarbon(nd, tz); },
      subDays(n) { const nd = new Date(d.getTime()); nd.setUTCDate(nd.getUTCDate() - Number(n)); return makeCarbon(nd, tz); },
      addHours(n) { const nd = new Date(d.getTime()); nd.setUTCHours(nd.getUTCHours() + Number(n)); return makeCarbon(nd, tz); },
      subHours(n) { const nd = new Date(d.getTime()); nd.setUTCHours(nd.getUTCHours() - Number(n)); return makeCarbon(nd, tz); },
      copy() { return makeCarbon(new Date(d.getTime()), tz); },
      clone() { return makeCarbon(new Date(d.getTime()), tz); },
      toString() { return api.toDateTimeString(); },
      valueOf() { return d.getTime(); },
    };
    return api;
  }
  // The request clock (integer seconds): the oracle freezes Carbon, so the
  // compiled side must read the same instant - the wall clock diverges.
  const clockDate = () => (requestClock ? new Date(requestClock() * 1000) : new Date());
  rt.now = () => makeCarbon(clockDate());
  // `today()` is midnight in the APP's timezone (Carbon::today() uses the
  // default zone), so the UTC instant is the zone's midnight converted back.
  rt.today = () => {
    const d = clockDate();
    const p = zoneParts(d, APP_TZ);
    const utcMidnight = Date.UTC(p.Y, p.m - 1, p.d, 0, 0, 0);
    // The zone's offset at that instant: the parts of the UTC midnight tell it.
    const asUtc = Date.UTC(p.Y, p.m - 1, p.d, p.H, p.i, p.s);
    const offset = asUtc - Math.floor(d.getTime() / 1000) * 1000;
    return makeCarbon(new Date(utcMidnight - offset));
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
  // `$a?->b` — the nullsafe property read. A null/undefined receiver answers
  // null; the chain's LATER `->` links then propagate it (rt.prop(null, k)
  // answers null), which is PHP's whole-chain short-circuit.
  rt.nsprop = (obj, key) => (obj === null || obj === undefined ? null : rt.prop(obj, key));
  // `$a?->m(args)` — the nullsafe method call. A null/undefined receiver
  // answers null; a real method is invoked against its own receiver.
  rt.nsmethod = (obj, name, args) => {
    if (obj === null || obj === undefined) return null;
    const fn = obj[name];
    return typeof fn === 'function' ? fn.apply(obj, args) : null;
  };
  // `(object) $x` — PHP's cast to stdClass (probed on PHP 8.3). A list becomes
  // an object keyed by the stringified indices; an object (a model, a
  // stdClass, an assoc array) is answered AS-IS (PHP's identity for an
  // object); null becomes the empty object; a scalar wraps under `scalar`.
  rt.objectCast = (v) => {
    if (v === null || v === undefined) return {};
    if (Array.isArray(v)) {
      const out = {};
      for (let i = 0; i < v.length; i += 1) out[String(i)] = v[i];
      return out;
    }
    if (typeof v === 'object') return v;
    return { scalar: v };
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
  // PHP's json_encode() honours JsonSerializable::jsonSerialize(): a Model
  // answers its toArray() (`{"id":1,"name":"a"}`) and an Eloquent Collection
  // answers an ARRAY of them. Without this the raw object reached the encoder
  // and threw "unsupported value (Function)" - a 500 where Laravel answers the
  // model's JSON.
  const jsonSerializable = (value) => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(jsonSerializable);
    // A kernel Collection: `toArray()` (its `toJSON()` is a JSON STRING, like
    // Laravel's toJson(), so it must not be used here).
    if (typeof value.toArray === 'function' && typeof value.all === 'function') {
      return value.toArray();
    }
    // A model: `toJSON()` is its toArray() (the kernel's own shape).
    if (typeof value.toJSON === 'function') return value.toJSON();
    // Any other JsonSerializable (`jsonSerialize()` - a paginator answers its
    // toArray(), which is the body `response()->json($paginator)` sends) or
    // Arrayable (`toArray()`).
    if (typeof value.jsonSerialize === 'function') return value.jsonSerialize();
    if (typeof value.toArray === 'function') return value.toArray();
    // A plain PHP array (an assoc array is a JS object here): PHP's
    // json_encode() recurses into it, so a Collection or a model nested in it
    // is serialised too. Without this `response()->json(['data' => $posts])` -
    // the most common JSON shape there is - threw "unsupported value".
    const out = {};
    for (const key of Object.keys(value)) out[key] = jsonSerializable(value[key]);
    return out;
  };
  rt.json = function (value, status) {
    // `json($data = [])`: no argument at all is an empty ARRAY ("[]"), while an
    // explicit null is Symfony's `$data ??= new \ArrayObject()` -> "{}"
    // (JsonResponse.php:47).
    const noArg = arguments.length === 0;
    return {
      status: Number(status) || 200,
      headers: { 'content-type': 'application/json' },
      // PHP's json_encode bytes: the slashes are escaped ("a\/b"), the
      // non-ASCII as \uXXXX (the surrogate pairs too). A plain JSON.stringify
      // would answer a different body (Laravel's bytes are the parity).
      body: noArg ? '[]' : value == null ? '{}' : phpJsonEncode(jsonSerializable(value)),
    };
  };
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
    // A resource returned from a controller: Laravel's Router::prepareResponse
    // wraps it in a ResourceResponse (the `data` key, the `with` and the
    // `additional` of the resource - ResourceResponse.php:31-52). The marker
    // (`__lwResource`) is what identifies it: the kernel's base replaces the
    // instance's prototype with a property proxy, so `instanceof` is false.
    if (value && value.__lwResource === true) return resourceResponse(value, rt.request());
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
  // PHP 8's coercive typing for a SCALAR parameter (a route segment arrives as
  // a string): a numeric string converts, and anything else is a TypeError -
  // a 500 - not a silent 0. Probed against PHP 8.3:
  //   int('12') = 12, int('12.5') = 12 (a deprecation, not an error),
  //   int(' 7 ') = 7, int('abc')/int('12abc')/int('') = TypeError,
  //   float('abc') = TypeError, string('abc') = 'abc'.
  const PHP_NUMERIC_STRING = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;
  const phpTypeError = (name, type, value) =>
    new TypeError(
      'Argument #1 ($' + name + ') must be of type ' + type + ', string given: the route segment ' +
        JSON.stringify(value) + ' is not ' + (type === 'int' ? 'an integer' : 'a number') +
        ' (PHP 8 throws a TypeError here, so Laravel answers 500)'
    );
  rt.param = (params, name, type, hasDefault, def, nullable) => {
    const v = params && typeof params === 'object' ? params[name] : undefined;
    // A missing segment takes the default (Laravel's own rule: the route would
    // not match without the segment). A NULL value is different: PHP passes it
    // to the parameter, so a non-nullable scalar type throws a TypeError
    // (`f(null)` for `int $n` is "must be of type int, null given") - the
    // compiled rung used to answer null, a 200 where Laravel answers 500.
    if (v === undefined) return hasDefault ? def : null;
    if (v === null) {
      if (nullable) return null;
      if (type === 'int' || type === 'float' || type === 'string') {
        throw new TypeError(
          'Argument #1 ($' + name + ') must be of type ' + type + ', null given (PHP 8 throws a ' +
            'TypeError here, so Laravel answers 500)'
        );
      }
      return hasDefault ? def : null;
    }
    if (type === 'int' || type === 'float') {
      if (typeof v === 'number') return type === 'int' ? Math.trunc(v) : v;
      const s = String(v);
      if (!PHP_NUMERIC_STRING.test(s)) throw phpTypeError(name, type, v);
      const n = Number(s);
      return type === 'int' ? Math.trunc(n) : n;
    }
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
    // The app's timezone: the model writes/renders its timestamps in it
    // (Laravel sets PHP's default from config('app.timezone') and
    // freshTimestampString()/serializeDate() follow it).
    if (typeof setModelTimezone === 'function') setModelTimezone(APP_TZ);
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
  // A DECLARED relation read as a property (`$post->comments`): Eloquent's
  // Model::getRelationValue() answers the CACHED relation and otherwise queries
  // the database - the kernel's Model::related() does exactly that (it loads
  // through the model's own `static relations` and caches the result).
  rt.modelRelation = async (model, name) => {
    if (!model || typeof model.related !== 'function') {
      throw new Error('rt.modelRelation: ' + JSON.stringify(name) + ' needs a model instance');
    }
    if (!db) {
      throw new Error(
        'rt.modelRelation: the relation "' +
          String(name) +
          '" needs the database binding (env.DB) — the edge cannot load it'
      );
    }
    return model.related(db, name);
  };

  // The runtime the compiled model ACCESSORS run against (`getXAttribute` is a
  // compiled `function (rt, value)`; the kernel's Model::get() calls it).
  setModelRuntime(rt);

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
