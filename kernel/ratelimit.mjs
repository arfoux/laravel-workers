// kernel/ratelimit.mjs — Laravel 13.37 rate limiting for the compiled rung.
//
// Ports, mirroring vendor line-for-line:
//
//   Illuminate\Cache\RateLimiter                        (full)
//   Illuminate\Cache\RateLimiting\Limit / Unlimited     (full)
//   Illuminate\Routing\Middleware\ThrottleRequests      (full)
//   Illuminate\Cache\ArrayStore + Illuminate\Cache\Repository
//       — composed into ArrayCacheStore below: ArrayStore alone has no
//         add()/has(), and Laravel 13's Repository::itemKey() is the identity
//         (no cache prefix), so Repository-level semantics can live in one
//         class. Verified against the vendor sources at 13.37.0.
//   Illuminate\Support\InteractsWithTime (availableAt / currentTime)
//
// Store adapter interface (Repository-level):
//
//   get(key, default?)      Repository::get       (null when missing)
//   has(key)                Repository::has       (! is_null(get))
//   put(key, value, ttl)    Repository::put       (seconds; ttl <= 0 forgets)
//   add(key, value, ttl)    Repository::add       (falls back to get+put)
//   increment(key, amount)  Repository::increment → ArrayStore::increment
//   decrement(key, amount)  Repository::decrement → ArrayStore::decrement
//   forever(key, value)     Repository::forever   (expiresAt 0)
//   forget(key)             Repository::forget
//
// Timing model (matches the vendor exactly):
//   - ArrayStore expiry timestamps are precise-millisecond epoch seconds
//     (Carbon::now()->getPreciseTimestamp(3)/1000 + seconds) and are checked
//     against a precise clock (`>=`).
//   - RateLimiter timers store integer second timestamps
//     (time() == Carbon::now()->getTimestamp()).
//   - Both clocks are injectable; tests pin them to the same fake "now" on
//     both sides of the PHP oracle, making every comparison exact.
//
// Kernel/edge notes (documented divergences):
//   - ThrottleRequests::shouldHashKeys() is a PHP method; here it is the
//     static property ThrottleRequests.shouldHashKeys plus the setter
//     ThrottleRequests.setShouldHashKeys() (JS statics cannot share a name).
//   - Symfony HeaderBag::add() calls set($key, $values) with $replace = true,
//     so when a response already carries X-RateLimit-* the new values REPLACE
//     the old ones (verified against the oracle: two limits yield the second
//     limit's headers only). addHeaders() mirrors that with Headers.set().
//   - user.hasAttribute()/getAuthIdentifier() are taken from the compiled
//     model layer; phpClassName() uses ctor.phpClass (the PHP FQCN) when set.
//   - Limit::none() must be the limiter's sole result: an Unlimited embedded
//     inside a limits array would carry PHP_INT_MAX, which exceeds JS number
//     precision and would leak divergent digits into X-RateLimit-* headers —
//     that case fails loud (RateLimitError) instead.

import { sha1Hex, md5Hex } from './digest.mjs';
import { HTML_ENTITIES } from './html-entities.mjs';

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// ---------------------------------------------------------------------------
// PHP scalar semantics used by the ports.
// ---------------------------------------------------------------------------

const PHP_NUMERIC_RE = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/;
const PHP_INT_PREFIX_RE = /^[ \t\n\r\v\f]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/;

/** PHP is_numeric() (PHP 8 rules: leading/trailing whitespace allowed). */
export function phpIsNumeric(value) {
  if (typeof value === 'number') return true;
  if (typeof value === 'string') return PHP_NUMERIC_RE.test(value);
  return false;
}

/** PHP (int) cast for the value shapes the rate limiter can meet. */
export function phpIntCast(value) {
  if (value === null || value === undefined || value === false) return 0;
  if (value === true) return 1;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0; // PHP 8: (int)NAN/(int)INF == 0
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const m = PHP_INT_PREFIX_RE.exec(value);
    if (!m) return 0;
    const num = /[.eE]/.test(m[1]) ? parseFloat(m[1]) : parseInt(m[1], 10);
    if (!Number.isFinite(num)) return 0;
    return Math.trunc(num);
  }
  throw new RateLimitError(`phpIntCast: unsupported value of type ${typeof value}`);
}

/** PHP truthiness for the value shapes the rate limiter can meet. */
export function phpFalsy(value) {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === 'number') return value === 0 || Number.isNaN(value);
  if (typeof value === 'string') return value === '' || value === '0';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** PHP value() helper (closures are invoked). */
function phpValue(value) {
  return typeof value === 'function' ? value() : value;
}

/** PHP UnitEnum|string → string (Illuminate\Support\enum_value). */
function resolveLimiterName(name) {
  if (name && typeof name === 'object') {
    if ('value' in name) return String(name.value);
    if ('name' in name) return String(name.name);
  }
  return String(name);
}

/** Best-effort PHP class name for exception messages (compiled models set ctor.phpClass). */
function phpClassName(object) {
  const ctor = object && object.constructor;
  if (ctor && typeof ctor.phpClass === 'string') return ctor.phpClass;
  if (ctor && typeof ctor.name === 'string' && ctor.name) return ctor.name;
  return 'stdClass';
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * RateLimiter::cleanRateLimiterKey() — byte-identical to
 *
 *     preg_replace('/&([a-z])[a-z]+;/i', '$1', htmlentities($key))
 *
 * with PHP 8.1+ htmlentities() defaults. The HTML entity table is baked from
 * PHP 8.3 (tools/make-html-entities.mjs); encode per code point, then collapse
 * letter entities ("&eacute;" → "e", "&frac12;" stays, "&#039;" stays).
 */
export function cleanRateLimiterKey(key) {
  const str = String(key);
  if (LONE_SURROGATE_RE.test(str)) {
    throw new RateLimitError(
      'cleanRateLimiterKey: string contains a lone surrogate (PHP htmlentities would substitute U+FFFD)'
    );
  }
  let encoded = '';
  for (const ch of str) encoded += HTML_ENTITIES[ch] ?? ch;
  return encoded.replace(/&([a-z])[a-z]+;/gi, '$1');
}

// ---------------------------------------------------------------------------
// Repository-over-ArrayStore cache store (Laravel 13.37 semantics).
// ---------------------------------------------------------------------------

export class ArrayCacheStore {
  /**
   * @param {object} [options]
   * @param {() => number} [options.clock] precise epoch seconds (fractional ok)
   */
  constructor(options = {}) {
    /** @type {Map<string, {value: unknown, expiresAt: number}>} */
    this.storage = new Map();
    this._clock = typeof options.clock === 'function' ? options.clock : () => Date.now() / 1000;
  }

  /** Carbon::now()->getPreciseTimestamp(3)/1000 */
  _nowPrecise() {
    return this._clock();
  }

  // ArrayStore::get + Repository::get composition:
  // store miss → null; stored null → null; expiration check uses precise now.
  // Repository::get then substitutes the default when the value is null.
  get(key, defaultValue = null) {
    let value = null;
    if (this.storage.has(key)) {
      const item = this.storage.get(key);
      const expiresAt = item.expiresAt ?? 0;
      if (expiresAt !== 0 && this._nowPrecise() >= expiresAt) {
        this.forget(key); // ArrayStore::get forgets expired keys
      } else {
        value = item.value;
      }
    }
    return value === null ? phpValue(defaultValue) : value;
  }

  /** Repository::has — ! is_null(get(key)). */
  has(key) {
    return this.get(key) !== null;
  }

  /** Repository::put(key, value, ttl) — null ttl = forever, ttl <= 0 forgets. */
  put(key, value, ttl = null) {
    if (ttl === null || ttl === undefined) return this.forever(key, value);
    const seconds = this._getSeconds(ttl);
    if (seconds <= 0) return this.forget(key); // Repository::put: seconds <= 0 → forget
    this.storage.set(key, { value, expiresAt: this._nowPrecise() + seconds });
    return true;
  }

  /**
   * Repository::add(key, value, ttl) — ArrayStore has no atomic add(), so the
   * Repository falls back to: get() nothing → put(); handled here directly.
   */
  add(key, value, ttl = null) {
    let seconds = null;
    if (ttl !== null && ttl !== undefined) {
      seconds = this._getSeconds(ttl);
      if (seconds <= 0) return false; // Repository::add: seconds <= 0 → false
    }
    if (this.get(key) === null) return this.put(key, value, seconds);
    return false;
  }

  /** ArrayStore::increment — cast existing to int, expiry stays untouched. */
  increment(key, amount = 1) {
    const existing = this.get(key);
    if (existing !== null) {
      const incremented = phpIntCast(existing) + amount;
      this.storage.get(key).value = incremented;
      return incremented;
    }
    this.forever(key, amount);
    return amount;
  }

  /** ArrayStore::decrement — increment(key, amount * -1). */
  decrement(key, amount = 1) {
    return this.increment(key, amount * -1);
  }

  /** ArrayStore::forever — put(key, value, 0) → expiresAt 0. */
  forever(key, value) {
    this.storage.set(key, { value, expiresAt: 0 });
    return true;
  }

  /** ArrayStore::forget — array_key_exists() check. */
  forget(key) {
    if (this.storage.has(key)) {
      this.storage.delete(key);
      return true;
    }
    return false;
  }

  /** ArrayStore::flush. */
  flush() {
    this.storage.clear();
    return true;
  }

  /** ArrayStore::all($unserialize = false) — raw storage snapshot (oracle parity). */
  all() {
    const out = {};
    for (const [key, item] of this.storage) {
      out[key] = { value: item.value, expiresAt: item.expiresAt ?? 0 };
    }
    return out;
  }

  /** Repository::getSeconds — int seconds of a ttl (DateTime => ceil diff). */
  _getSeconds(ttl) {
    if (ttl instanceof Date) {
      const ms = ttl.getTime() - this._nowPrecise() * 1000;
      if (!Number.isFinite(ms)) throw new RateLimitError('ArrayCacheStore: non-finite DateTime ttl');
      return Math.max(0, Math.ceil(ms / 1000));
    }
    if (typeof ttl === 'number') {
      if (Number.isNaN(ttl)) return 0; // (int)(NaN > 0 ? NaN : 0) == 0
      if (!Number.isFinite(ttl)) throw new RateLimitError('ArrayCacheStore: non-finite ttl');
      return Math.max(0, Math.trunc(ttl));
    }
    throw new RateLimitError(
      `ArrayCacheStore: unsupported ttl type ${typeof ttl} (RateLimiter passes integer seconds)`
    );
  }
}

// ---------------------------------------------------------------------------
// RateLimiter (Illuminate\Cache\RateLimiter, 13.37).
// ---------------------------------------------------------------------------

export class RateLimiter {
  /**
   * @param {ArrayCacheStore|object} cache Repository-level cache adapter
   * @param {object} [options]
   * @param {() => number} [options.clock] epoch-seconds clock (integer use only)
   */
  constructor(cache, options = {}) {
    if (!cache || typeof cache.get !== 'function' || typeof cache.add !== 'function' || typeof cache.increment !== 'function' || typeof cache.has !== 'function') {
      throw new RateLimitError('RateLimiter: cache adapter must implement get/has/put/add/increment/forget');
    }
    this.cache = cache;
    /** @type {Map<string, (request: unknown) => unknown>} */
    this.limiters = new Map();
    this._clock = typeof options.clock === 'function' ? options.clock : () => Date.now() / 1000;
  }

  /** InteractsWithTime::currentTime() — Carbon::now()->getTimestamp() (int). */
  currentTime() {
    return Math.floor(this._clock());
  }

  /** InteractsWithTime::availableAt($delay) — floor of precise now + delay. */
  availableAt(delay = 0) {
    if (delay instanceof Date) return Math.floor(delay.getTime() / 1000);
    if (typeof delay !== 'number' || !Number.isFinite(delay)) {
      throw new RateLimitError('RateLimiter::availableAt: unsupported delay');
    }
    return Math.floor(this._clock() + delay);
  }

  /** Register a named rate limiter (resolveLimiterName applied). */
  for(name, callback) {
    this.limiters.set(resolveLimiterName(name), callback);
    return this;
  }

  /**
   * Get the named limiter wrapper — resolves duplicate Limit keys to
   * fallbackKey() exactly like the vendor (Collection::duplicates loose-ish).
   */
  limiter(name) {
    const limiter = this.limiters.get(resolveLimiterName(name));
    if (typeof limiter !== 'function') return null;
    return async (...args) => {
      const result = await limiter(...args);
      if (!Array.isArray(result)) return result;
      const keys = result.map((limit) => limit.key);
      const duplicateIndexes = [];
      for (let i = 0; i < keys.length; i++) {
        for (let j = 0; j < i; j++) {
          if (phpLooseEquals(keys[i], keys[j])) {
            duplicateIndexes.push(i);
            break;
          }
        }
      }
      if (duplicateIndexes.length === 0) return result;
      const duplicates = duplicateIndexes.map((i) => keys[i]);
      for (const limit of result) {
        if (duplicates.some((value) => phpLooseEquals(value, limit.key))) {
          limit.key = limit.fallbackKey();
        }
      }
      return result;
    };
  }

  /** RateLimiter::attempt — null result becomes true; hit after the callback. */
  async attempt(key, maxAttempts, callback, decaySeconds = 60) {
    if (this.tooManyAttempts(key, maxAttempts)) return false;
    let result = await callback();
    if (result === null || result === undefined) result = true;
    this.hit(key, decaySeconds);
    return result;
  }

  /** RateLimiter::tooManyAttempts — >= max and timer alive; else reset counter. */
  tooManyAttempts(key, maxAttempts) {
    if (this.attempts(key) >= maxAttempts) {
      if (this.cache.has(cleanRateLimiterKey(key) + ':timer')) return true;
      this.resetAttempts(key);
    }
    return false;
  }

  /** RateLimiter::hit == increment(key, decaySeconds). */
  hit(key, decaySeconds = 60) {
    return this.increment(key, decaySeconds);
  }

  /** RateLimiter::increment — timer add, counter add, increment, race fixup. */
  increment(key, decaySeconds = 60, amount = 1) {
    key = cleanRateLimiterKey(key);

    this.cache.add(key + ':timer', this.availableAt(decaySeconds), decaySeconds);

    const added = this.cache.add(key, 0, decaySeconds);

    const hits = phpIntCast(this.cache.increment(key, amount));

    if (!added && hits == amount) {
      // @phpstan-ignore-next-line
      this.cache.put(key, amount, decaySeconds);
    }

    return hits;
  }

  /** RateLimiter::decrement — increment(key, decaySeconds, amount * -1). */
  decrement(key, decaySeconds = 60, amount = 1) {
    return this.increment(key, decaySeconds, amount * -1);
  }

  /** RateLimiter::attempts == cache->get(key, 0). */
  attempts(key) {
    return this.cache.get(cleanRateLimiterKey(key), 0);
  }

  /** RateLimiter::resetAttempts == cache->forget(clean(key)). */
  resetAttempts(key) {
    return this.cache.forget(cleanRateLimiterKey(key));
  }

  /** RateLimiter::remaining — max(0, maxAttempts - attempts). */
  remaining(key, maxAttempts) {
    key = cleanRateLimiterKey(key);
    const attempts = this.attempts(key);
    return Math.max(0, maxAttempts - attempts);
  }

  /** RateLimiter::retriesLeft == remaining. */
  retriesLeft(key, maxAttempts) {
    return this.remaining(key, maxAttempts);
  }

  /** RateLimiter::clear — resetAttempts + forget timer. */
  clear(key) {
    key = cleanRateLimiterKey(key);
    this.resetAttempts(key);
    this.cache.forget(key + ':timer');
  }

  /** RateLimiter::availableIn — max(0, timer - currentTime()) (int). */
  availableIn(key) {
    key = cleanRateLimiterKey(key);
    const timer = this.cache.get(key + ':timer');
    return Math.max(0, (timer === null ? 0 : phpIntCast(timer)) - this.currentTime());
  }
}

/** PHP loose equality for the shapes limiter keys take (int/string/null). */
function phpLooseEquals(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if ((typeof a === 'number' || typeof b === 'number') && phpIsNumeric(a) && phpIsNumeric(b)) {
    return Number(a) === Number(b);
  }
  if (typeof a === 'string' && typeof b === 'string' && phpIsNumeric(a) && phpIsNumeric(b)) {
    return Number(a) === Number(b);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Limit / Unlimited (Illuminate\Cache\RateLimiting).
// ---------------------------------------------------------------------------

export class Limit {
  constructor(key = '', maxAttempts = 60, decaySeconds = 60) {
    this.key = key;
    this.maxAttempts = maxAttempts;
    this.decaySeconds = decaySeconds;
    this.afterCallback = null;
    this.responseCallback = null;
  }

  static perSecond(maxAttempts, decaySeconds = 1) {
    return new this('', maxAttempts, decaySeconds);
  }

  static perMinute(maxAttempts, decayMinutes = 1) {
    return new this('', maxAttempts, 60 * decayMinutes);
  }

  static perMinutes(decayMinutes, maxAttempts) {
    return new this('', maxAttempts, 60 * decayMinutes);
  }

  static perHour(maxAttempts, decayHours = 1) {
    return new this('', maxAttempts, 60 * 60 * decayHours);
  }

  static perDay(maxAttempts, decayDays = 1) {
    return new this('', maxAttempts, 60 * 60 * 24 * decayDays);
  }

  static none() {
    return new Unlimited();
  }

  by(key) {
    this.key = key;
    return this;
  }

  after(callback) {
    this.afterCallback = callback;
    return this;
  }

  response(callback) {
    this.responseCallback = callback;
    return this;
  }

  fallbackKey() {
    const prefix = phpFalsy(this.key) ? '' : `${this.key}:`;
    return `${prefix}attempts:${this.maxAttempts}:decay:${this.decaySeconds}`;
  }
}

export class Unlimited extends Limit {
  constructor() {
    // PHP_INT_MAX in PHP; MAX_SAFE_INTEGER here (the value is only consulted
    // when an Unlimited is embedded inside a limits array — the top-level
    // Unlimited short-circuits in ThrottleRequests::handleRequestUsingNamedLimiter).
    super('', Number.MAX_SAFE_INTEGER, 60);
  }
}

// ---------------------------------------------------------------------------
// ThrottleRequests (Illuminate\Routing\Middleware\ThrottleRequests, 13.37).
// ---------------------------------------------------------------------------

export class ThrottleRequestsError extends Error {
  constructor(message, headers = {}) {
    super(message);
    this.name = 'ThrottleRequestsError';
    this.status = 429;
    this.headers = headers;
  }
}

/** HttpResponseException — the pipeline must return `.response` as-is. */
export class HttpResponseError extends Error {
  constructor(response) {
    // Vendor HttpResponseException::__construct() sets the message to
    // previous?->getMessage() ?? '' — empty when Laravel builds it for a
    // response callback. Kept empty for oracle parity.
    super('');
    this.name = 'HttpResponseError';
    this.response = response;
  }
}

export class MissingRateLimiterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingRateLimiterError';
  }
}

function isHttpResponse(value) {
  if (typeof Response !== 'undefined' && value instanceof Response) return true;
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.status === 'number' &&
      value.headers &&
      typeof value.headers.get === 'function'
  );
}

function resolveUser(request) {
  const user = typeof request.user === 'function' ? request.user() : request.user;
  return user ?? null;
}

function resolveRoute(request) {
  const route = typeof request.route === 'function' ? request.route() : request.route;
  return route ?? null;
}

function routeDomain(route) {
  if (typeof route.domain === 'function') return route.domain();
  if (route.domain !== undefined) return route.domain ?? null;
  if (typeof route.getDomain === 'function') return route.getDomain();
  return null;
}

function resolveIp(request) {
  if (typeof request.ip === 'function') return request.ip();
  if (typeof request.ip === 'string') return request.ip;
  throw new RateLimitError('ThrottleRequests: request.ip (string) is required to resolve the request signature');
}

function authIdentifier(user) {
  if (typeof user.getAuthIdentifier === 'function') return user.getAuthIdentifier();
  throw new RateLimitError('ThrottleRequests: user must implement getAuthIdentifier()');
}

function userHasAttribute(user, key) {
  if (typeof user.hasAttribute === 'function') return Boolean(user.hasAttribute(key));
  return Object.prototype.hasOwnProperty.call(user, key);
}

export class ThrottleRequests {
  /** self::$shouldHashKeys (static). Use setShouldHashKeys() to change. */
  static shouldHashKeys = true;

  /** ThrottleRequests::shouldHashKeys(bool $shouldHashKeys = true) */
  static setShouldHashKeys(shouldHashKeys = true) {
    ThrottleRequests.shouldHashKeys = shouldHashKeys;
  }

  /** ThrottleRequests::using($name) */
  static using(name) {
    return `Illuminate\\Routing\\Middleware\\ThrottleRequests:${resolveLimiterName(name)}`;
  }

  /** ThrottleRequests::with(...$args) — func_get_args() implode(',') semantics. */
  static with(...args) {
    return `Illuminate\\Routing\\Middleware\\ThrottleRequests:${args.map(String).join(',')}`;
  }

  constructor(limiter) {
    this.limiter = limiter;
  }

  /**
   * handle($request, Closure $next, $maxAttempts = 60, $decayMinutes = 1, $prefix = '')
   * `params` are the middleware arguments as written in the route string;
   * PHP's func_num_args() === 3 corresponds to params.length === 1.
   */
  async handle(request, next, ...params) {
    const maxAttempts = params.length > 0 ? params[0] : 60;

    if (typeof maxAttempts === 'string' && params.length === 1) {
      const limiter = this.limiter.limiter(maxAttempts);
      if (limiter !== null) {
        return this.handleRequestUsingNamedLimiter(request, next, maxAttempts, limiter);
      }
    }

    const decayMinutes = params.length > 1 ? params[1] : 1;
    const prefix = params.length > 2 ? params[2] : '';

    return this.handleRequest(request, next, [
      {
        key: prefix + this.resolveRequestSignature(request),
        maxAttempts: this.resolveMaxAttempts(request, maxAttempts),
        decaySeconds: 60 * decayMinutes,
        afterCallback: null,
        responseCallback: null,
      },
    ]);
  }

  async handleRequestUsingNamedLimiter(request, next, limiterName, limiter) {
    const limiterResponse = await limiter(request);

    if (isHttpResponse(limiterResponse)) {
      return limiterResponse;
    }
    if (limiterResponse instanceof Unlimited) {
      return next(request);
    }

    const list = Array.isArray(limiterResponse) ? limiterResponse : [limiterResponse];
    const limits = list.map((limit) => {
      if (!(limit instanceof Limit)) {
        throw new RateLimitError(
          `ThrottleRequests: limiter [${limiterName}] must return a Limit, a list of Limits, an Unlimited, or a Response`
        );
      }
      if (limit instanceof Unlimited) {
        // Fail loud instead of silently diverging: embedded Unlimited carries
        // PHP_INT_MAX (9223372036854775807), which exceeds Number precision and
        // would leak into X-RateLimit-Limit/Remaining/fallbackKey bytes.
        // Return the Unlimited as the whole limiter result instead.
        throw new RateLimitError(
          `ThrottleRequests: Limit::none() embedded in a limits array of limiter [${limiterName}] is not supported ` +
            '(PHP_INT_MAX exceeds JS number precision) — return the Unlimited as the sole limiter result'
        );
      }
      return {
        key: ThrottleRequests.shouldHashKeys ? md5Hex(limiterName + limit.key) : limiterName + ':' + limit.key,
        maxAttempts: limit.maxAttempts,
        decaySeconds: limit.decaySeconds,
        afterCallback: limit.afterCallback,
        responseCallback: limit.responseCallback,
      };
    });

    return this.handleRequest(request, next, limits);
  }

  async handleRequest(request, next, limits) {
    for (const limit of limits) {
      if (this.limiter.tooManyAttempts(limit.key, limit.maxAttempts)) {
        throw this.buildException(request, limit.key, limit.maxAttempts, limit.responseCallback);
      }
    }

    for (const limit of limits) {
      if (!limit.afterCallback) {
        this.limiter.hit(limit.key, limit.decaySeconds);
      }
    }

    let response = await next(request);

    for (const limit of limits) {
      if (limit.afterCallback && (await limit.afterCallback(response))) {
        this.limiter.hit(limit.key, limit.decaySeconds);
      }

      response = this.addHeaders(
        response,
        limit.maxAttempts,
        this.calculateRemainingAttempts(limit.key, limit.maxAttempts)
      );
    }

    return response;
  }

  resolveMaxAttempts(request, maxAttempts) {
    if (String(maxAttempts).includes('|')) {
      const pipe = String(maxAttempts).indexOf('|');
      const parts = [String(maxAttempts).slice(0, pipe), String(maxAttempts).slice(pipe + 1)];
      maxAttempts = parts[resolveUser(request) ? 1 : 0];
    }

    const user = resolveUser(request);

    if (!phpIsNumeric(maxAttempts) && user !== null && userHasAttribute(user, maxAttempts)) {
      maxAttempts = user[maxAttempts];
    }

    if (!phpIsNumeric(maxAttempts)) {
      if (user === null) {
        throw new MissingRateLimiterError(`Rate limiter [${maxAttempts}] is not defined.`);
      }
      throw new MissingRateLimiterError(`Rate limiter [${phpClassName(user)}::${maxAttempts}] is not defined.`);
    }

    return phpIntCast(maxAttempts);
  }

  resolveRequestSignature(request) {
    const user = resolveUser(request);

    if (user) {
      return this.formatIdentifier(authIdentifier(user));
    }

    const route = resolveRoute(request);

    if (route) {
      return this.formatIdentifier(`${routeDomain(route) ?? ''}|${resolveIp(request)}`);
    }

    throw new RateLimitError('Unable to generate the request signature. Route unavailable.');
  }

  buildException(request, key, maxAttempts, responseCallback = null) {
    const retryAfter = this.getTimeUntilNextRetry(key);

    const headers = this.getHeaders(
      maxAttempts,
      this.calculateRemainingAttempts(key, maxAttempts, retryAfter),
      retryAfter
    );

    if (typeof responseCallback === 'function') {
      const response = responseCallback(request, headers);
      if (response && typeof response.then === 'function') {
        throw new RateLimitError('ThrottleRequests: response callback must be synchronous');
      }
      return new HttpResponseError(response);
    }

    return new ThrottleRequestsError('Too Many Attempts.', headers);
  }

  getTimeUntilNextRetry(key) {
    return this.limiter.availableIn(key);
  }

  /** InteractsWithTime::availableAt($delay) — Carbon::now()->addSeconds($delay)->getTimestamp(). */
  availableAt(delay = 0) {
    return this.limiter.availableAt(delay);
  }

  addHeaders(response, maxAttempts, remainingAttempts, retryAfter = null) {
    const headers = this.getHeaders(maxAttempts, remainingAttempts, retryAfter, response);

    for (const [name, value] of Object.entries(headers)) {
      // Symfony HeaderBag::add() calls set($key, $values) with $replace = true
      // (HeaderBag.php), so an existing value is REPLACED — verified against
      // the PHP oracle: two limits produce the second limit's headers only.
      response.headers.set(name, String(value));
    }

    return response;
  }

  getHeaders(maxAttempts, remainingAttempts, retryAfter = null, response = null) {
    if (response) {
      const existing = response.headers.get('X-RateLimit-Remaining');
      if (existing !== null && phpIntCast(existing) <= phpIntCast(remainingAttempts)) {
        return {};
      }
    }

    const headers = {
      'X-RateLimit-Limit': maxAttempts,
      'X-RateLimit-Remaining': remainingAttempts,
    };

    if (retryAfter !== null) {
      headers['Retry-After'] = retryAfter;
      headers['X-RateLimit-Reset'] = this.availableAt(retryAfter);
    }

    return headers;
  }

  calculateRemainingAttempts(key, maxAttempts, retryAfter = null) {
    return retryAfter === null ? this.limiter.retriesLeft(key, maxAttempts) : 0;
  }

  formatIdentifier(value) {
    const str = String(value); // PHP sha1() coerces scalars
    return ThrottleRequests.shouldHashKeys ? sha1Hex(str) : str;
  }
}

export default {
  RateLimiter,
  Limit,
  Unlimited,
  ThrottleRequests,
  ArrayCacheStore,
  cleanRateLimiterKey,
  phpIntCast,
  phpIsNumeric,
  phpFalsy,
};
