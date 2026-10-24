<?php
require_once __DIR__ . '/_root.php';

// tools/php-ratelimit-oracle.php — PHP 8.3 oracle for kernel/ratelimit.mjs.
//
// Runs the real Laravel 13.37 rate-limiting stack with a frozen Carbon clock
// and prints every intermediate value so kernel/tests/ratelimit.test.mjs can
// prove 1:1 parity of:
//
//   ratelimiter — flat op replay against RateLimiter + Repository + ArrayStore
//                 (hit / increment / decrement / attempt / tooManyAttempts /
//                 attempts / remaining / retriesLeft / clear / availableIn /
//                 cleanRateLimiterKey + named-limiter duplicate fallbackKey
//                 resolution), capturing the return value, callback events and
//                 a raw ArrayStore dump (value + expiresAt) after every op.
//   throttle    — real ThrottleRequests::handle() against real Requests with a
//                 controllable user / route / ip / response, capturing status,
//                 body, headers or the thrown exception.
//   hash        — sha1()/md5() vectors and RateLimiter::cleanRateLimiterKey()
//                 vectors (htmlentities table + entity collapse).
//
// Input (stdin JSON): { "app_root": "...", "mode": "...", ... }
//   app_root may instead come from env LW_LARAVEL_APP.
//
// ratelimiter mode:
//   {
//     "mode": "ratelimiter",
//     "now": 1792336827,                       // frozen clock start (int)
//     "ops": [["hit", "key", 60], ...]         // flat [op, ...args]
//   }
//   ops: advance(s) / hit(key,decay) / increment(key,decay,amount) /
//        decrement(key,decay,amount) / attempts(key) / resetAttempts(key) /
//        remaining(key,max) / retriesLeft(key,max) / tooManyAttempts(key,max) /
//        availableIn(key) / clear(key) / cleanKey(key) / now /
//        attempt(key,max,retOrNull,decay?) / defineLimiter(name,spec) /
//        limiterResolve(name)
//   output: { "mode", "start", "steps": [{op, has_ret, ret, events, store, now}],
//             "store", "final_now" } — ret/store are JSON strings.
//
// throttle mode:
//   {
//     "mode": "throttle",
//     "cases": [{
//       "name": "...",
//       "now": 1792336827, "advance": 0,       // frozen clock
//       "middleware": ["60", "1"],             // params after request/next
//       "should_hash_keys": true,
//       "limiter_name": null, "limiter_spec": {...},  // named limiter
//       "user": null | {"id": 42, "attrs": {"daily_limit": 3}},
//       "route": {} | {"domain": null} | {"domain": "sub.example.com"},
//                                // absent "route" -> no route (signature error)
//       "ip": "127.0.0.1", "uri": "/x", "method": "GET",
//       "next_body": "OK", "next_status": 200,
//       "pre_headers": {"X-RateLimit-Remaining": "100"},
//       "repeat": 1                            // handle() calls on one store
//     }]
//   }
//   limiter_spec: {"kind": "limits", "limits": [{key, max_attempts,
//                 decay_seconds, after?, response?}]} | {"kind": "unlimited"} |
//                 {"kind": "response"} | {"kind": "single", "limit": {...}}
//   output: { "mode", "cases": [{name, results: [{ok, status?, body?,
//             headers?, next_called, exception?}], store, now}] }
//
// hash mode:
//   { "mode": "hash", "strings": ["..."], "clean_keys": ["..."] }
//   output: { "mode", "sha1": [...], "md5": [...], "clean": [...] }

$input = json_decode((string) stream_get_contents(STDIN), true);

if (!is_array($input)) {
    fwrite(STDERR, "php-ratelimit-oracle: invalid JSON input\n");
    exit(2);
}

$appRoot = $input['app_root'] ?? (getenv('LW_LARAVEL_APP') ?: null);

if (!is_string($appRoot) || !is_file($appRoot . '/bootstrap/app.php') || !lw_has_vendor($appRoot)) {
    fwrite(STDERR, "php-ratelimit-oracle: pass \"app_root\" or set LW_LARAVEL_APP to a Laravel app (a Laravel app root with an autoloader - set LW_VENDOR_DIR to reuse one)\n");
    exit(2);
}

require lw_vendor_autoload_for($appRoot);

use Carbon\Carbon;
use Illuminate\Cache\ArrayStore;
use Illuminate\Cache\RateLimiter;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Cache\Repository;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\Request;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Symfony\Component\HttpFoundation\Response;

class LWFakeUser
{
    public function __construct(
        private int|string|null $id,
        private array $attrs = [],
    ) {
    }

    public function getAuthIdentifier(): int|string|null
    {
        return $this->id;
    }

    public function hasAttribute($key): bool
    {
        return array_key_exists($key, $this->attrs);
    }

    public function __get($key)
    {
        return $this->attrs[$key] ?? null;
    }
}

class LWFakeRoute
{
    public function __construct(private ?string $domain)
    {
    }

    public function getDomain(): ?string
    {
        return $this->domain;
    }
}

$mode = $input['mode'] ?? 'ratelimiter';

function lwJson($value): string
{
    $encoded = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

    if ($encoded === false) {
        fwrite(STDERR, 'php-ratelimit-oracle: json_encode failed: ' . json_last_error_msg() . "\n");
        exit(3);
    }

    return $encoded;
}

/** Freeze the clock at precise milliseconds (fractional seconds supported). */
function lwFreezeMs(int $milliseconds): void
{
    Carbon::setTestNow(Carbon::createFromTimestamp($milliseconds / 1000));
}

/** Precise epoch seconds of the frozen clock (int when on a whole second). */
function lwPrecise(): int|float
{
    return Carbon::now()->getPreciseTimestamp(3) / 1000;
}

/** Seconds (int|float) → milliseconds. */
function lwMs(int|float $seconds): int
{
    return (int) round($seconds * 1000);
}

/** Build Limit objects from a JSON spec (shared by limiter_spec and ops). */
function lwBuildLimits(array $limits): array
{
    $out = [];

    foreach ($limits as $spec) {
        $limit = new Limit($spec['key'] ?? '', $spec['max_attempts'], $spec['decay_seconds'] ?? 60);

        if (! empty($spec['after'])) {
            $limit->after(fn ($response) => true);
        }

        if (! empty($spec['response'])) {
            $limit->response(function ($request, $headers) {
                return new Response('CUSTOM', 429, array_map('strval', $headers));
            });
        }

        $out[] = $limit;
    }

    return $out;
}

/** Flat name => "a, b" header projection (fetch merge projection). */
function lwResponseHeaders(Response $response): array
{
    $out = [];

    foreach ($response->headers->all() as $name => $values) {
        $out[$name] = implode(', ', $values);
    }

    return $out;
}

function lwThrowableOut(Throwable $e): array
{
    $out = ['class' => get_class($e), 'message' => $e->getMessage()];

    if (method_exists($e, 'getStatusCode')) {
        $out['status'] = $e->getStatusCode();
    }

    if (method_exists($e, 'getHeaders')) {
        $out['headers'] = array_map('strval', $e->getHeaders());
    }

    if ($e instanceof HttpResponseException) {
        $response = $e->getResponse();
        $out['response'] = [
            'status' => $response->getStatusCode(),
            'body' => $response->getContent(),
            'headers' => lwResponseHeaders($response),
        ];
    }

    return $out;
}

function lwLimitOut($limit): array
{
    if ($limit instanceof Limit) {
        return [
            'class' => get_class($limit),
            'key' => $limit->key,
            'max_attempts' => $limit->maxAttempts,
            'decay_seconds' => $limit->decaySeconds,
            'fallback_key' => $limit->fallbackKey(),
        ];
    }

    if ($limit instanceof Response) {
        return [
            'class' => get_class($limit),
            'status' => $limit->getStatusCode(),
            'body' => $limit->getContent(),
        ];
    }

    return ['class' => is_object($limit) ? get_class($limit) : gettype($limit)];
}

// ---------------------------------------------------------------------------
// ratelimiter — flat op replay.
// ---------------------------------------------------------------------------

if ($mode === 'ratelimiter') {
    $nowMs = lwMs($input['now'] ?? 1792336827);
    lwFreezeMs($nowMs);

    $store = new ArrayStore();
    $rateLimiter = new RateLimiter(new Repository($store));

    $steps = [];

    foreach ($input['ops'] ?? [] as $op) {
        $name = array_shift($op);
        $args = $op;
        $ret = null;
        $hasRet = true;
        $events = [];

        switch ($name) {
            case 'advance':
                $nowMs += lwMs($args[0]);
                lwFreezeMs($nowMs);
                $hasRet = false;
                break;
            case 'hit':
                $ret = $rateLimiter->hit(...$args);
                break;
            case 'increment':
                $ret = $rateLimiter->increment(...$args);
                break;
            case 'decrement':
                $ret = $rateLimiter->decrement(...$args);
                break;
            case 'attempts':
                $ret = $rateLimiter->attempts(...$args);
                break;
            case 'resetAttempts':
                $ret = $rateLimiter->resetAttempts(...$args);
                break;
            case 'remaining':
                $ret = $rateLimiter->remaining(...$args);
                break;
            case 'retriesLeft':
                $ret = $rateLimiter->retriesLeft(...$args);
                break;
            case 'tooManyAttempts':
                $ret = $rateLimiter->tooManyAttempts(...$args);
                break;
            case 'availableIn':
                $ret = $rateLimiter->availableIn(...$args);
                break;
            case 'clear':
                $rateLimiter->clear(...$args);
                $hasRet = false;
                break;
            case 'cleanKey':
                $ret = $rateLimiter->cleanRateLimiterKey(...$args);
                break;
            case 'attempt':
                $key = $args[0];
                $max = $args[1];
                $callbackRet = $args[2] ?? null;
                $decay = $args[3] ?? 60;
                $called = false;
                $ret = $rateLimiter->attempt($key, $max, function () use ($callbackRet, &$called) {
                    $called = true;

                    return $callbackRet;
                }, $decay);
                $events[] = ['attempt_callback', $called];
                break;
            case 'defineLimiter':
                $limiterName = $args[0];
                $spec = $args[1] ?? ['limits' => []];
                $rateLimiter->for($limiterName, function () use ($spec) {
                    $kind = $spec['kind'] ?? 'limits';

                    if ($kind === 'unlimited') {
                        return Limit::none();
                    }

                    if ($kind === 'response') {
                        return new Response('limiter-response', 403);
                    }

                    if ($kind === 'single') {
                        $limits = lwBuildLimits([$spec['limit']]);

                        return $limits[0];
                    }

                    return lwBuildLimits($spec['limits'] ?? []);
                });
                $hasRet = false;
                break;
            case 'limiterResolve':
                $wrapper = $rateLimiter->limiter($args[0]);

                if ($wrapper === null) {
                    $ret = null;
                } else {
                    $result = $wrapper(null);
                    $ret = is_array($result)
                        ? array_map('lwLimitOut', $result)
                        : ['single' => lwLimitOut($result)];
                }
                break;
            case 'now':
                $ret = lwPrecise();
                break;
            default:
                fwrite(STDERR, "php-ratelimit-oracle: unknown op {$name}\n");
                exit(4);
        }

        $steps[] = [
            'op' => $name,
            'has_ret' => $hasRet,
            'ret' => $hasRet ? lwJson($ret) : null,
            'events' => $events,
            'store' => lwJson($store->all()),
            'now' => lwPrecise(),
        ];
    }

    echo lwJson([
        'mode' => 'ratelimiter',
        'start' => lwPrecise(),
        'steps' => $steps,
        'store' => lwJson($store->all()),
        'final_now' => lwPrecise(),
    ]);
    exit(0);
}

// ---------------------------------------------------------------------------
// throttle — real ThrottleRequests::handle() cases.
// ---------------------------------------------------------------------------

if ($mode === 'throttle') {
    $casesOut = [];

    foreach ($input['cases'] ?? [] as $case) {
        $name = $case['name'] ?? 'case';
        lwFreezeMs(lwMs($case['now'] ?? 1792336827) + lwMs($case['advance'] ?? 0));

        $store = new ArrayStore();
        $rateLimiter = new RateLimiter(new Repository($store));

        ThrottleRequests::shouldHashKeys($case['should_hash_keys'] ?? true);

        if (($case['limiter_name'] ?? null) !== null) {
            $spec = $case['limiter_spec'] ?? ['limits' => []];
            $rateLimiter->for($case['limiter_name'], function () use ($spec) {
                $kind = $spec['kind'] ?? 'limits';

                if ($kind === 'unlimited') {
                    return Limit::none();
                }

                if ($kind === 'response') {
                    return new Response('limiter-response', 403);
                }

                if ($kind === 'single') {
                    $limits = lwBuildLimits([$spec['limit']]);

                    return $limits[0];
                }

                return lwBuildLimits($spec['limits'] ?? []);
            });
        }

        $request = Request::create($case['uri'] ?? '/x', $case['method'] ?? 'GET');
        $request->server->set('REMOTE_ADDR', $case['ip'] ?? '127.0.0.1');

        if (($case['user'] ?? null) !== null) {
            $userSpec = $case['user'];
            $user = new LWFakeUser($userSpec['id'] ?? null, $userSpec['attrs'] ?? []);
            $request->setUserResolver(fn () => $user);
        } else {
            $request->setUserResolver(fn () => null);
        }

        if (array_key_exists('route', $case)) {
            $routeSpec = $case['route'];
            $request->setRouteResolver(fn () => new LWFakeRoute($routeSpec['domain'] ?? null));
        } else {
            $request->setRouteResolver(fn () => null);
        }

        $nextCalled = 0;
        $next = function ($request) use ($case, &$nextCalled) {
            $nextCalled++;
            $response = new Response($case['next_body'] ?? 'OK', $case['next_status'] ?? 200);

            foreach (($case['pre_headers'] ?? []) as $headerName => $headerValue) {
                $response->headers->set($headerName, $headerValue);
            }

            return $response;
        };

        $middleware = new ThrottleRequests($rateLimiter);

        $repeat = max(1, (int) ($case['repeat'] ?? 1));
        $results = [];

        for ($i = 0; $i < $repeat; $i++) {
            $out = ['ok' => true];

            try {
                $response = $middleware->handle($request, $next, ...($case['middleware'] ?? [60, 1]));
                $out['status'] = $response->getStatusCode();
                $out['body'] = $response->getContent();
                $out['headers'] = lwResponseHeaders($response);
            } catch (Throwable $e) {
                $out['ok'] = false;
                $out['exception'] = lwThrowableOut($e);
            }

            $out['next_called'] = $nextCalled;
            $results[] = $out;
        }

        $casesOut[] = [
            'name' => $name,
            'results' => $results,
            'store' => lwJson($store->all()),
            'now' => lwPrecise(),
        ];
    }

    echo lwJson(['mode' => 'throttle', 'cases' => $casesOut]);
    exit(0);
}

// ---------------------------------------------------------------------------
// hash — sha1/md5/cleanRateLimiterKey vectors.
// ---------------------------------------------------------------------------

if ($mode === 'hash') {
    $rateLimiter = new RateLimiter(new Repository(new ArrayStore()));

    $out = ['mode' => 'hash', 'sha1' => [], 'md5' => [], 'clean' => []];

    foreach ($input['strings'] ?? [] as $string) {
        $out['sha1'][] = sha1($string);
        $out['md5'][] = md5($string);
    }

    foreach ($input['clean_keys'] ?? [] as $key) {
        $out['clean'][] = $rateLimiter->cleanRateLimiterKey($key);
    }

    echo lwJson($out);
    exit(0);
}

fwrite(STDERR, "php-ratelimit-oracle: unknown mode {$mode}\n");
exit(2);
