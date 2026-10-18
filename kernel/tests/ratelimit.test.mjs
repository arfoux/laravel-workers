// kernel/tests/ratelimit.test.mjs — rate limiting parity vs PHP 8.3 oracle.
//
// Spawns tools/php-ratelimit-oracle.php against a real Laravel app (set
// LW_LARAVEL_APP, or the dev-machine default) and proves:
//   - sha1()/md5() (kernel/digest.mjs) byte-identical to PHP on UTF-8 +
//     block-boundary vectors
//   - cleanRateLimiterKey() byte-identical to htmlentities()+preg_replace
//   - RateLimiter op replay: return values, callback events, raw ArrayStore
//     dumps (value + expiresAt) after every op, on an exactly frozen clock
//     (fractional seconds included)
//   - ThrottleRequests e2e: status/body/rate-limit headers or the thrown
//     exception (class/message/status/headers/response), named limiters
//     (hashed and unhashed keys, duplicates->fallbackKey, Unlimited, Response
//     short-circuit), user-attribute maxAttempts, `5|10` splits, prefixes and
//     the X-RateLimit-Remaining guard, all against real Symfony Requests
//     handled by the real Laravel middleware.
//
// The oracle freezes Carbon::setTestNow to a precise-millisecond clock; the JS
// side runs an injectable clock advancing in lockstep, so every comparison is
// exact — no tolerances anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RateLimiter,
  Limit,
  Unlimited,
  ThrottleRequests,
  ArrayCacheStore,
  cleanRateLimiterKey,
  RateLimitError,
  ThrottleRequestsError,
  HttpResponseError,
  MissingRateLimiterError,
} from '../ratelimit.mjs';
import { sha1Hex, md5Hex } from '../digest.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const oraclePath = path.resolve(testsDir, '..', '..', 'tools', 'php-ratelimit-oracle.php');
const PHP = process.env.PHP_BIN || 'php';
const APP_ROOT =
  process.env.LW_LARAVEL_APP ||
  'C:\\Users\\HP\\AppData\\Local\\Temp\\opencode\\lw-fresh-e2e\\fresh-app';

const NOW = 1792336827; // fixture timestamp shared with session tests

function runOracle(payload) {
  if (!existsSync(path.join(APP_ROOT, 'vendor', 'autoload.php'))) {
    throw new Error(
      `ratelimit.test: no Laravel app at ${APP_ROOT} (vendor/autoload.php missing). ` +
        'Point LW_LARAVEL_APP at a Laravel 11+/13.x app to run the oracle.'
    );
  }
  const res = spawnSync(PHP, [oraclePath], {
    input: JSON.stringify({ app_root: APP_ROOT, ...payload }),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`php-ratelimit-oracle exited ${res.status}:\n${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

/** Deep-normalize a JS value through JSON (undefined -> null). */
function jsonRoundTrip(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

/** Oracle fields that are JSON strings emitted by PHP's json_encode. */
function parsePhpJson(text) {
  return text === null || text === undefined ? null : JSON.parse(text);
}

/**
 * Store dumps: an empty PHP array encodes as `[]`, the JS storage object as
 * `{}` — normalize the empty case (all real stores are string-keyed assoc
 * arrays, i.e. JSON objects).
 */
function parsePhpStore(text) {
  const value = parsePhpJson(text);
  return Array.isArray(value) ? {} : value;
}

// ---------------------------------------------------------------------------
// Fakes shared by both sides (PHP classes live in the oracle; keep names equal
// so MissingRateLimiterException user-class messages match).
// ---------------------------------------------------------------------------

class LWFakeUser {
  constructor(id, attrs = {}) {
    this._authId = id;
    for (const [key, value] of Object.entries(attrs)) this[key] = value;
  }

  getAuthIdentifier() {
    return this._authId;
  }

  hasAttribute(key) {
    return Object.prototype.hasOwnProperty.call(this, key);
  }
}

class LWFakeRoute {
  constructor(domain) {
    this._domain = domain;
  }

  getDomain() {
    return this._domain;
  }
}

/** Fresh ArrayStore+RateLimiter on a mutable millisecond clock. */
function makeHarness(startMs) {
  const ref = { value: startMs };
  const clock = () => ref.value / 1000;
  const store = new ArrayCacheStore({ clock });
  const limiter = new RateLimiter(store, { clock });
  return { ref, store, limiter };
}

function buildLimitsFromSpec(limits) {
  return limits.map((spec) => {
    const limit = new Limit(spec.key ?? '', spec.max_attempts, spec.decay_seconds ?? 60);
    if (spec.after) limit.after(() => true);
    if (spec.response) {
      limit.response((request, headers) => {
        const flat = {};
        for (const [name, value] of Object.entries(headers)) flat[name] = String(value);
        return new Response('CUSTOM', { status: 429, headers: flat });
      });
    }
    return limit;
  });
}

/** Mirrors the oracle's limiter_spec kinds. */
function limiterFromSpec(spec) {
  const kind = spec?.kind ?? 'limits';
  if (kind === 'unlimited') return Limit.none();
  if (kind === 'response') return new Response('limiter-response', { status: 403 });
  if (kind === 'single') return buildLimitsFromSpec([spec.limit])[0];
  return buildLimitsFromSpec(spec?.limits ?? []);
}

// ---------------------------------------------------------------------------
// Mode: hash — sha1/md5/cleanRateLimiterKey vectors.
// ---------------------------------------------------------------------------

test('ratelimit: sha1/md5/cleanRateLimiterKey vectors match PHP 8.3', () => {
  const strings = [
    'abc',
    '',
    'caf\u00e9',
    '\u65e5\u672c\u8a9e',
    'a\nb',
    '\u{1F680} rocket',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(65),
    'x'.repeat(1000),
  ];
  const cleanKeys = [
    'tests@x.io',
    'caf\u00e9',
    'a<b>c',
    "it's",
    'a&b',
    '\u00bd',
    '&frac12;',
    'a&amp;b',
    'a b',
    '\u65e5\u672c',
    '',
    '<>&"',
    '0',
    '1',
    'a\u00a9b',
    '\u20ac100',
    'example.com|127.0.0.1',
  ];

  const oracle = runOracle({ mode: 'hash', strings, clean_keys: cleanKeys });

  strings.forEach((value, i) => {
    assert.equal(sha1Hex(value), oracle.sha1[i], `sha1[${i}] ${JSON.stringify(value)}`);
    assert.equal(md5Hex(value), oracle.md5[i], `md5[${i}] ${JSON.stringify(value)}`);
  });
  cleanKeys.forEach((value, i) => {
    assert.equal(
      cleanRateLimiterKey(value),
      oracle.clean[i],
      `clean[${i}] ${JSON.stringify(value)}`
    );
  });
});

test('ratelimit: cleanRateLimiterKey fails loud on lone surrogates', () => {
  assert.throws(() => cleanRateLimiterKey('a\uD800b'), /lone surrogate/);
  assert.throws(() => cleanRateLimiterKey('\uDC00'), /lone surrogate/);
});

// ---------------------------------------------------------------------------
// Mode: ratelimiter — flat op replay.
// ---------------------------------------------------------------------------

const RATE_LIMITER_SCRIPTS = [
  {
    name: 'hit/expiry/tooManyAttempts lifecycle',
    now: NOW,
    ops: [
      ['now'],
      ['hit', 'k', 60],
      ['hit', 'k', 60],
      ['attempts', 'k'],
      ['remaining', 'k', 5],
      ['retriesLeft', 'k', 5],
      ['availableIn', 'k'],
      ['tooManyAttempts', 'k', 5],
      ['advance', 30],
      ['availableIn', 'k'],
      ['hit', 'k', 60],
      ['attempts', 'k'],
      ['advance', 30],
      ['attempts', 'k'],
      ['tooManyAttempts', 'k', 5],
      ['advance', 1],
      ['attempts', 'k'],
      ['availableIn', 'k'],
    ],
  },
  {
    name: 'increment/decrement with amounts and decay 0',
    now: NOW,
    ops: [
      ['increment', 'x', 120, 3],
      ['increment', 'x', 120, 2],
      ['decrement', 'x', 120, 1],
      ['attempts', 'x'],
      ['availableIn', 'x'],
      ['advance', 119],
      ['availableIn', 'x'],
      ['attempts', 'x'],
      ['advance', 1],
      ['attempts', 'x'],
      ['availableIn', 'x'],
      ['hit', 'zero', 0],
      ['attempts', 'zero'],
      ['availableIn', 'zero'],
      ['tooManyAttempts', 'zero', 1],
    ],
  },
  {
    name: 'attempt callback/null/limited/expiry',
    now: NOW,
    ops: [
      ['attempt', 'a', 2, 42, 60],
      ['attempts', 'a'],
      ['attempt', 'a', 2, null, 60],
      ['attempts', 'a'],
      ['attempt', 'a', 2, 'x', 60],
      ['attempt', 'a', 2, false, 60],
      ['attempts', 'a'],
      ['advance', 60],
      ['attempt', 'a', 2, 'y', 60],
      ['attempts', 'a'],
      ['advance', 61],
      ['attempt', 'a', 2, false, 60],
      ['attempts', 'a'],
    ],
  },
  {
    name: 'tooManyAttempts reset path when the timer died first',
    now: NOW,
    ops: [
      ['hit', 'rp', 60],
      ['advance', 10],
      ['resetAttempts', 'rp'],
      ['hit', 'rp', 60],
      ['attempts', 'rp'],
      ['advance', 55],
      ['tooManyAttempts', 'rp', 1],
      ['attempts', 'rp'],
      ['availableIn', 'rp'],
      ['tooManyAttempts', 'rp', 1],
    ],
  },
  {
    name: 'clear/resetAttempts on missing keys',
    now: NOW,
    ops: [
      ['hit', 'c1', 60],
      ['hit', 'c1', 60],
      ['clear', 'c1'],
      ['attempts', 'c1'],
      ['availableIn', 'c1'],
      ['resetAttempts', 'c1'],
      ['clear', 'c2'],
    ],
  },
  {
    name: 'fractional clock: counter/timer desync at sub-second precision',
    now: NOW + 0.5,
    ops: [
      ['hit', 'f', 60],
      ['attempts', 'f'],
      ['advance', 0.25],
      ['availableIn', 'f'],
      ['advance', 59.25],
      ['attempts', 'f'],
      ['availableIn', 'f'],
    ],
  },
  {
    name: 'clean keys flow through ops',
    now: NOW,
    ops: [
      ['increment', ' spaced  key ', 60, 2],
      ['attempts', ' spaced  key '],
      ['cleanKey', 'a<b>&amp;c'],
      ['cleanKey', 'caf\u00e9\u00bd'],
      ['hit', 'exam&ple.com|127.0.0.1', 60],
      ['attempts', 'examaple.com|127.0.0.1'],
    ],
  },
  {
    name: 'named limiter duplicate fallbackKey resolution',
    now: NOW,
    ops: [
      [
        'defineLimiter',
        'api',
        {
          limits: [
            { key: 'user:1', max_attempts: 5, decay_seconds: 60 },
            { key: 'user:1', max_attempts: 2, decay_seconds: 30 },
          ],
        },
      ],
      ['limiterResolve', 'api'],
      [
        'defineLimiter',
        'three',
        {
          limits: [
            { key: 'a', max_attempts: 1, decay_seconds: 10 },
            { key: 'b', max_attempts: 2, decay_seconds: 20 },
            { key: 'a', max_attempts: 3, decay_seconds: 30 },
          ],
        },
      ],
      ['limiterResolve', 'three'],
      [
        'defineLimiter',
        'loose',
        {
          limits: [
            { key: 1, max_attempts: 1, decay_seconds: 10 },
            { key: '1', max_attempts: 2, decay_seconds: 20 },
          ],
        },
      ],
      ['limiterResolve', 'loose'],
      [
        'defineLimiter',
        'zeros',
        {
          limits: [
            { key: '0', max_attempts: 1, decay_seconds: 10 },
            { key: '0', max_attempts: 2, decay_seconds: 20 },
          ],
        },
      ],
      ['limiterResolve', 'zeros'],
      ['limiterResolve', 'missing'],
      ['defineLimiter', 'single', { kind: 'single', limit: { key: 'g', max_attempts: 9, decay_seconds: 45 } }],
      ['limiterResolve', 'single'],
      ['defineLimiter', 'unlim', { kind: 'unlimited' }],
      ['limiterResolve', 'unlim'],
      ['defineLimiter', 'resp', { kind: 'response' }],
      ['limiterResolve', 'resp'],
    ],
  },
];

/** PHP FQCN -> JS kernel class name for limiterResolve payloads. */
const LIMIT_CLASS_MAP = {
  'Illuminate\\Cache\\RateLimiting\\Limit': 'Limit',
  'Illuminate\\Cache\\RateLimiting\\Unlimited': 'Unlimited',
  'Symfony\\Component\\HttpFoundation\\Response': 'Response',
};

function normalizeLimitOut(entry) {
  const out = { ...entry, class: LIMIT_CLASS_MAP[entry.class] ?? entry.class };
  if (out.class === 'Unlimited') {
    // PHP_INT_MAX max_attempts / fallback digits exceed JS number precision.
    // The embedded-Unlimited case fails loud in ThrottleRequests (asserted
    // below), so those fields are unreachable response bytes; skip them.
    delete out.max_attempts;
    delete out.fallback_key;
  }
  return out;
}

function normalizeResolveRet(ret) {
  if (ret === null) return null;
  if (Array.isArray(ret)) return ret.map(normalizeLimitOut);
  if (typeof ret === 'object' && 'single' in ret) {
    return { single: normalizeLimitOut(ret.single) };
  }
  return ret;
}

function jsLimitOut(limit) {
  if (limit instanceof Limit) {
    return {
      class: limit instanceof Unlimited ? 'Unlimited' : 'Limit',
      key: limit.key,
      max_attempts: limit.maxAttempts,
      decay_seconds: limit.decaySeconds,
      fallback_key: limit.fallbackKey(),
    };
  }
  if (limit instanceof Response) {
    return { class: 'Response', status: limit.status, body: 'limiter-response' };
  }
  return { class: limit?.constructor?.name ?? typeof limit };
}

/** Replays one oracle op on the JS side; returns { hasRet, ret, events }. */
async function applyRateLimiterOp(harness, op) {
  const [name, ...args] = op;

  switch (name) {
    case 'advance':
      harness.ref.value += Math.round(args[0] * 1000);
      return { hasRet: false, ret: null, events: [] };
    case 'hit':
      return { hasRet: true, ret: harness.limiter.hit(...args), events: [] };
    case 'increment':
      return { hasRet: true, ret: harness.limiter.increment(...args), events: [] };
    case 'decrement':
      return { hasRet: true, ret: harness.limiter.decrement(...args), events: [] };
    case 'attempts':
      return { hasRet: true, ret: harness.limiter.attempts(...args), events: [] };
    case 'resetAttempts':
      return { hasRet: true, ret: harness.limiter.resetAttempts(...args), events: [] };
    case 'remaining':
      return { hasRet: true, ret: harness.limiter.remaining(...args), events: [] };
    case 'retriesLeft':
      return { hasRet: true, ret: harness.limiter.retriesLeft(...args), events: [] };
    case 'tooManyAttempts':
      return { hasRet: true, ret: harness.limiter.tooManyAttempts(...args), events: [] };
    case 'availableIn':
      return { hasRet: true, ret: harness.limiter.availableIn(...args), events: [] };
    case 'clear':
      harness.limiter.clear(...args);
      return { hasRet: false, ret: null, events: [] };
    case 'cleanKey':
      return { hasRet: true, ret: cleanRateLimiterKey(...args), events: [] };
    case 'attempt': {
      const [key, maxAttempts, callbackRet, decaySeconds = 60] = args;
      let called = false;
      const ret = await harness.limiter.attempt(
        key,
        maxAttempts,
        () => {
          called = true;
          return callbackRet ?? null;
        },
        decaySeconds
      );
      return { hasRet: true, ret, events: [['attempt_callback', called]] };
    }
    case 'defineLimiter': {
      const [limiterName, spec] = args;
      harness.limiter.for(limiterName, () => limiterFromSpec(spec));
      return { hasRet: false, ret: null, events: [] };
    }
    case 'limiterResolve': {
      const wrapper = harness.limiter.limiter(args[0]);
      if (wrapper === null) return { hasRet: true, ret: null, events: [] };
      const result = await wrapper(null);
      const ret = Array.isArray(result)
        ? result.map(jsLimitOut)
        : { single: jsLimitOut(result) };
      return { hasRet: true, ret, events: [] };
    }
    case 'now':
      return { hasRet: true, ret: harness.ref.value / 1000, events: [] };
    default:
      throw new Error(`ratelimit.test: unknown op ${name}`);
  }
}

function assertStep(oracleStep, jsStep, label) {
  assert.equal(jsStep.hasRet, oracleStep.has_ret, `${label}: has_ret`);
  if (oracleStep.has_ret) {
    const jsRet = jsonRoundTrip(jsStep.ret);
    const phpRet = parsePhpJson(oracleStep.ret);
    if (oracleStep.op === 'limiterResolve') {
      assert.deepEqual(normalizeResolveRet(jsRet), normalizeResolveRet(phpRet), `${label}: ret`);
    } else {
      assert.deepEqual(jsRet, phpRet, `${label}: ret`);
    }
  }
  assert.deepEqual(jsStep.events, oracleStep.events, `${label}: events`);
  assert.deepEqual(jsonRoundTrip(jsStep.store), parsePhpStore(oracleStep.store), `${label}: store`);
  assert.deepEqual(jsonRoundTrip(jsStep.now), oracleStep.now, `${label}: now`);
}

for (const script of RATE_LIMITER_SCRIPTS) {
  test(`ratelimiter: ${script.name}`, async () => {
    const oracle = runOracle({ mode: 'ratelimiter', now: script.now, ops: script.ops });
    const harness = makeHarness(Math.round(script.now * 1000));

    assert.equal(oracle.steps.length, script.ops.length, 'oracle step count');

    for (let i = 0; i < script.ops.length; i++) {
      const op = script.ops[i];
      const outcome = await applyRateLimiterOp(harness, op);
      const jsStep = {
        hasRet: outcome.hasRet,
        ret: outcome.ret,
        events: outcome.events,
        store: harness.store.all(),
        now: harness.ref.value / 1000,
      };
      assertStep(oracle.steps[i], jsStep, `${script.name} op#${i} ${op[0]}`);
    }

    assert.deepEqual(
      jsonRoundTrip(harness.store.all()),
      parsePhpStore(oracle.store),
      `${script.name}: final store`
    );
    assert.deepEqual(jsonRoundTrip(harness.ref.value / 1000), oracle.final_now, 'final now');
  });
}

// ---------------------------------------------------------------------------
// Mode: throttle — end-to-end ThrottleRequests::handle() cases.
// ---------------------------------------------------------------------------

const THROTTLE_CASES = [
  {
    name: 'guest signature + headers',
    now: NOW,
    route: { domain: 'example.com' },
    middleware: [60, 1],
  },
  {
    name: 'default params (no middleware args)',
    now: NOW,
    route: { domain: 'example.com' },
    middleware: [],
  },
  {
    name: 'single numeric string falls through to numeric path',
    now: NOW,
    route: { domain: 'example.com' },
    middleware: ['60'],
  },
  {
    name: '5|10 split uses guest side',
    now: NOW,
    route: { domain: 'example.com' },
    middleware: ['5|10', '1'],
  },
  {
    name: '5|10 split uses user side',
    now: NOW,
    route: { domain: 'example.com' },
    user: { id: 42, attrs: {} },
    middleware: ['5|10', '1'],
  },
  {
    name: 'user attribute maxAttempts',
    now: NOW,
    route: { domain: 'example.com' },
    user: { id: 7, attrs: { daily: 3 } },
    middleware: ['daily', '1'],
  },
  {
    name: 'user attribute missing throws MissingRateLimiterException',
    now: NOW,
    route: { domain: 'example.com' },
    user: { id: 7, attrs: {} },
    middleware: ['daily', '1'],
  },
  {
    name: 'unknown named limiter throws for guest',
    now: NOW,
    route: { domain: 'example.com' },
    middleware: ['unknown'],
  },
  {
    name: 'no route throws signature error',
    now: NOW,
    middleware: [60, 1],
  },
  {
    name: 'prefix parameter',
    now: NOW,
    route: { domain: 'example.com' },
    middleware: ['60', '1', 'pre:'],
  },
  {
    name: 'unhashed signature stores the raw domain|ip',
    now: NOW,
    route: { domain: 'example.com' },
    should_hash_keys: false,
    middleware: [60, 1],
  },
  {
    name: 'cleaned signature with entity chars',
    now: NOW,
    route: { domain: 'exam&ple.com' },
    middleware: [60, 1],
  },
  {
    name: 'named limiter single limit hashed keys',
    now: NOW,
    route: { domain: 'example.com' },
    limiter_name: 'api',
    limiter_spec: { kind: 'single', limit: { key: 'per-ip', max_attempts: 5, decay_seconds: 60 } },
    middleware: ['api'],
  },
  {
    name: 'named limiter unhashed keys',
    now: NOW,
    route: { domain: 'example.com' },
    should_hash_keys: false,
    limiter_name: 'api2',
    limiter_spec: { kind: 'single', limit: { key: 'per-ip', max_attempts: 5, decay_seconds: 60 } },
    middleware: ['api2'],
  },
  {
    name: 'named limiter multi limits replace headers (last limit wins)',
    now: NOW,
    route: { domain: 'example.com' },
    limiter_name: 'multi',
    limiter_spec: {
      kind: 'limits',
      limits: [
        { key: 'l1', max_attempts: 5, decay_seconds: 60 },
        { key: 'l2', max_attempts: 3, decay_seconds: 60 },
      ],
    },
    middleware: ['multi'],
  },
  {
    name: 'named limiter duplicate keys resolve fallbackKey',
    now: NOW,
    route: { domain: 'example.com' },
    limiter_name: 'dupli',
    limiter_spec: {
      kind: 'limits',
      limits: [
        { key: 'dup', max_attempts: 5, decay_seconds: 60 },
        { key: 'dup', max_attempts: 2, decay_seconds: 30 },
      ],
    },
    middleware: ['dupli'],
  },
  {
    name: 'named limiter Unlimited short-circuits',
    now: NOW,
    route: { domain: 'example.com' },
    limiter_name: 'none',
    limiter_spec: { kind: 'unlimited' },
    middleware: ['none'],
  },
  {
    name: 'named limiter Response short-circuits',
    now: NOW,
    route: { domain: 'example.com' },
    limiter_name: 'resp',
    limiter_spec: { kind: 'response' },
    middleware: ['resp'],
  },
  {
    name: 'named limiter after callback hits after next',
    now: NOW,
    route: { domain: 'example.com' },
    limiter_name: 'after',
    limiter_spec: { kind: 'single', limit: { key: 'a', max_attempts: 5, decay_seconds: 60, after: true } },
    middleware: ['after'],
  },
  {
    name: '429 on second handle with retry headers',
    now: NOW,
    route: { domain: 'example.com' },
    middleware: ['1', '1'],
    repeat: 2,
  },
  {
    name: 'custom response callback wraps HttpResponseException',
    now: NOW,
    route: { domain: 'example.com' },
    limiter_name: 'custom',
    limiter_spec: {
      kind: 'single',
      limit: { key: 'c', max_attempts: 1, decay_seconds: 60, response: true },
    },
    middleware: ['custom'],
    repeat: 2,
  },
  {
    name: 'pre-set remaining 100 is replaced by throttle headers',
    now: NOW,
    route: { domain: 'example.com' },
    pre_headers: { 'X-RateLimit-Remaining': '100' },
    middleware: [60, 1],
  },
  {
    name: 'pre-set remaining 0 suppresses throttle headers',
    now: NOW,
    route: { domain: 'example.com' },
    pre_headers: { 'X-RateLimit-Remaining': '0' },
    middleware: [60, 1],
  },
];

const RATE_HEADER_KEYS = new Set([
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'retry-after',
  'x-ratelimit-reset',
]);

function pickRateHeaders(flat) {
  const out = {};
  for (const [name, value] of Object.entries(flat ?? {})) {
    const lower = name.toLowerCase();
    if (RATE_HEADER_KEYS.has(lower)) out[lower] = String(value);
  }
  return out;
}

function headersProjection(headers) {
  const out = {};
  for (const [name, value] of headers.entries()) out[name] = value;
  return out;
}

const EXCEPTION_CLASS_MAP = {
  'Illuminate\\Http\\Exceptions\\ThrottleRequestsException': 'ThrottleRequestsError',
  'Illuminate\\Http\\Exceptions\\HttpResponseException': 'HttpResponseError',
  'Illuminate\\Routing\\Exceptions\\MissingRateLimiterException': 'MissingRateLimiterError',
  RuntimeException: 'RateLimitError',
};

function normalizeException(phpException) {
  const out = {
    class: EXCEPTION_CLASS_MAP[phpException.class] ?? phpException.class,
    message: phpException.message,
  };
  if (phpException.status !== undefined) out.status = phpException.status;
  if (phpException.headers !== undefined) out.headers = pickRateHeaders(phpException.headers);
  if (phpException.response !== undefined) {
    out.response = {
      status: phpException.response.status,
      body: phpException.response.body,
      headers: pickRateHeaders(phpException.response.headers),
    };
  }
  return out;
}

async function jsExceptionOut(error) {
  const out = { class: error.constructor.name, message: error.message };
  if (typeof error.status === 'number') out.status = error.status;
  if (error.headers !== undefined) out.headers = pickRateHeaders(error.headers);
  if (error.response instanceof Response) {
    out.response = {
      status: error.response.status,
      body: await error.response.text(),
      headers: pickRateHeaders(headersProjection(error.response.headers)),
    };
  }
  return out;
}

async function runThrottleCase(caseSpec) {
  const harness = makeHarness(
    Math.round((caseSpec.now ?? NOW) * 1000) + Math.round((caseSpec.advance ?? 0) * 1000)
  );

  ThrottleRequests.setShouldHashKeys(caseSpec.should_hash_keys ?? true);

  if (caseSpec.limiter_name !== null && caseSpec.limiter_name !== undefined) {
    harness.limiter.for(caseSpec.limiter_name, () => limiterFromSpec(caseSpec.limiter_spec));
  }

  const user =
    caseSpec.user === null || caseSpec.user === undefined
      ? null
      : new LWFakeUser(caseSpec.user.id ?? null, caseSpec.user.attrs ?? {});
  const route = 'route' in caseSpec ? new LWFakeRoute(caseSpec.route?.domain ?? null) : null;

  const request = {
    ip: caseSpec.ip ?? '127.0.0.1',
    uri: caseSpec.uri ?? '/x',
    method: caseSpec.method ?? 'GET',
    user,
    route,
  };

  let nextCalled = 0;
  const next = async () => {
    nextCalled++;
    const headers = new Headers();
    for (const [name, value] of Object.entries(caseSpec.pre_headers ?? {})) {
      headers.set(name, String(value));
    }
    return new Response(caseSpec.next_body ?? 'OK', {
      status: caseSpec.next_status ?? 200,
      headers,
    });
  };

  const middleware = new ThrottleRequests(harness.limiter);
  const repeat = Math.max(1, caseSpec.repeat ?? 1);
  const results = [];

  for (let i = 0; i < repeat; i++) {
    const out = { ok: true };

    try {
      const response = await middleware.handle(
        request,
        next,
        ...(caseSpec.middleware ?? [60, 1])
      );
      out.status = response.status;
      out.body = await response.text();
      out.headers = headersProjection(response.headers);
    } catch (error) {
      out.ok = false;
      out.exception = await jsExceptionOut(error);
    }

    out.next_called = nextCalled;
    results.push(out);
  }

  return {
    name: caseSpec.name,
    results,
    store: harness.store.all(),
    now: harness.ref.value / 1000,
  };
}

test('throttle: ThrottleRequests::handle e2e matches the PHP oracle', async () => {
  try {
    const oracle = runOracle({ mode: 'throttle', cases: THROTTLE_CASES });

    for (const caseSpec of THROTTLE_CASES) {
      const phpCase = oracle.cases.find((entry) => entry.name === caseSpec.name);
      assert.ok(phpCase, `oracle case ${caseSpec.name}`);
      assert.equal(phpCase.results.length, Math.max(1, caseSpec.repeat ?? 1));

      const jsCase = await runThrottleCase(caseSpec);

      phpCase.results.forEach((phpResult, i) => {
        const jsResult = jsCase.results[i];
        const label = `${caseSpec.name}[${i}]`;

        assert.equal(jsResult.ok, phpResult.ok, `${label}: ok`);
        assert.equal(jsResult.next_called, phpResult.next_called, `${label}: next_called`);

        if (phpResult.ok) {
          assert.equal(jsResult.status, phpResult.status, `${label}: status`);
          assert.equal(jsResult.body, phpResult.body, `${label}: body`);
          assert.deepEqual(
            pickRateHeaders(jsResult.headers),
            pickRateHeaders(phpResult.headers),
            `${label}: headers`
          );
        } else {
          assert.deepEqual(
            jsResult.exception,
            normalizeException(phpResult.exception),
            `${label}: exception`
          );
        }
      });

      assert.deepEqual(
        jsonRoundTrip(jsCase.store),
        parsePhpStore(phpCase.store),
        `${caseSpec.name}: store`
      );
      assert.deepEqual(jsonRoundTrip(jsCase.now), phpCase.now, `${caseSpec.name}: now`);
    }
  } finally {
    ThrottleRequests.setShouldHashKeys(true);
  }
});

// ---------------------------------------------------------------------------
// JS-only invariants (PHP-unverifiable or fail-loud guards).
// ---------------------------------------------------------------------------

test('ratelimit: Limit factories mirror the vendor statics', () => {
  const none = Limit.none();
  assert.ok(none instanceof Unlimited);
  assert.equal(none.key, '');
  assert.equal(none.decaySeconds, 60);

  assert.equal(Limit.perSecond(5).decaySeconds, 1);
  assert.equal(Limit.perMinute(5).decaySeconds, 60);
  assert.equal(Limit.perMinute(5, 2).decaySeconds, 120);
  assert.equal(Limit.perMinutes(2, 5).decaySeconds, 120);
  assert.equal(Limit.perHour(5).decaySeconds, 3600);
  assert.equal(Limit.perHour(5, 2).decaySeconds, 7200);
  assert.equal(Limit.perDay(5).decaySeconds, 86400);
  assert.equal(Limit.perDay(5, 2).decaySeconds, 172800);

  assert.equal(new Limit('api', 5, 30).fallbackKey(), 'api:attempts:5:decay:30');
  assert.equal(new Limit('', 5, 30).fallbackKey(), 'attempts:5:decay:30');
  assert.equal(new Limit('0', 5, 30).fallbackKey(), 'attempts:5:decay:30');
});

test('ratelimit: ThrottleRequests::using/with compose middleware strings', () => {
  assert.equal(
    ThrottleRequests.using('login'),
    'Illuminate\\Routing\\Middleware\\ThrottleRequests:login'
  );
  assert.equal(
    ThrottleRequests.with(60, 1),
    'Illuminate\\Routing\\Middleware\\ThrottleRequests:60,1'
  );
  assert.equal(
    ThrottleRequests.with('60', '1', 'pre:'),
    'Illuminate\\Routing\\Middleware\\ThrottleRequests:60,1,pre:'
  );
});

test('ratelimit: embedded Unlimited fails loud instead of diverging digits', async () => {
  const harness = makeHarness(NOW * 1000);
  harness.limiter.for('mixed', () => [Limit.perMinute(5), Limit.none()]);

  const middleware = new ThrottleRequests(harness.limiter);
  const request = { ip: '127.0.0.1', user: null, route: new LWFakeRoute('example.com') };

  await assert.rejects(
    () => middleware.handle(request, async () => new Response('OK'), 'mixed'),
    (error) => error instanceof RateLimitError && /embedded in a limits array/.test(error.message)
  );
});

test('ratelimit: exception classes expose the vendor error surface', () => {
  const throttled = new ThrottleRequestsError('Too Many Attempts.', { 'X-RateLimit-Limit': 5 });
  assert.equal(throttled.status, 429);
  assert.deepEqual(throttled.headers, { 'X-RateLimit-Limit': 5 });

  const response = new Response('CUSTOM', { status: 429 });
  const httpError = new HttpResponseError(response);
  assert.equal(httpError.message, '');
  assert.equal(httpError.response, response);

  const missing = new MissingRateLimiterError('Rate limiter [x] is not defined.');
  assert.equal(missing.message, 'Rate limiter [x] is not defined.');
});
