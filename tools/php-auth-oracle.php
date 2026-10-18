<?php

// tools/php-auth-oracle.php — PHP 8.3 oracle for kernel/auth.mjs.
//
// Boots the real Laravel app under app_root (so config, hashing and the DB
// stack are the app's own), then runs the real:
//   Illuminate\Auth\SessionGuard + GuardHelpers + EloquentUserProvider
//   Illuminate\Auth\Middleware\Authenticate + RedirectIfAuthenticated
//   Illuminate\Auth\Recaller / Illuminate\Support\Timebox
//   illuminate/hashing BcryptHasher (through the app HashManager)
// and prints every intermediate state so kernel/tests/auth.test.mjs can prove
// parity of the compiled rung against PHP.
//
// Input (stdin JSON):
//   {
//     "app_root": "...",                  // or env LW_LARAVEL_APP
//     "mode": "auth" | "negotiation" | "recaller" | "hasher",   // default "auth"
//     "freeze_ms": <int>|null,            // Carbon::setTestNow for exact expiries
//     "db_path": "...",                   // sqlite file; default <app_root>/lw-auth-oracle.sqlite
//     "user": {                           // one seeded lw_users row
//       "id": 1, "name": "Test User", "email": "u@example.com",
//       "password_hash": "$2y$...", "remember_token": null
//     },
//     "guard": "web",
//     "session_id": "40-char"|null,       // Store ctor id
//     "session_seed": {...}|null,         // attributes put() right after start()
//     "cookies": {"name":"value"}|{},     // Request cookies (recaller resumption)
//     "server": {"HTTP_ACCEPT":"..."} | {}, // Request server/headers
//     "ops": [["attempt", [{"email":"..","password":".."}, false]], ...],
//     "str_random": true                  // fix Str::random to str_repeat('A', n)
//   }
//
// Modes:
//   auth        — run $ops against the guard, snapshot every step
//   negotiation — run $vectors: [{"server": {...}}, ...] through a real
//                 Illuminate Request; reports expectsJson and friends
//   recaller    — run $values through new Recaller($value)
//   hasher      — run $ops through the app's bcrypt hasher
//
// Output: one JSON object on stdout. For "auth" it is
//   { "meta": {...}, "snapshots": [...], "final": {...} }.
// Snapshots carry ret/threw/session/session_id/queued/db/events per op.

$input = json_decode((string) stream_get_contents(STDIN), true);

if (!is_array($input)) {
    fwrite(STDERR, "php-auth-oracle: invalid JSON input\n");
    exit(2);
}

// Recaller::token()/hash() on short segment lists raise "Undefined array key"
// warnings in PHP 8.3 (the values still come back as null); keep stdout pure
// JSON for the parity harness.
error_reporting(E_ALL & ~E_WARNING & ~E_NOTICE & ~E_DEPRECATED);

$appRoot = $input['app_root'] ?? (getenv('LW_LARAVEL_APP') ?: null);

if (!is_string($appRoot) || !is_file($appRoot . '/vendor/autoload.php')) {
    fwrite(STDERR, "php-auth-oracle: pass \"app_root\" or set LW_LARAVEL_APP to a Laravel app (vendor/autoload.php required)\n");
    exit(2);
}

require $appRoot . '/vendor/autoload.php';

use Carbon\Carbon;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Auth\EloquentUserProvider;
use Illuminate\Auth\Middleware\Authenticate;
use Illuminate\Auth\Middleware\RedirectIfAuthenticated;
use Illuminate\Auth\Recaller;
use Illuminate\Auth\SessionGuard;
use Illuminate\Contracts\Auth\Factory as AuthFactory;
use Illuminate\Cookie\CookieJar;
use Illuminate\Http\Request;
use Illuminate\Session\ArraySessionHandler;
use Illuminate\Session\Store;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Cookie;

if (isset($input['freeze_ms'])) {
    Carbon::setTestNow(Carbon::createFromTimestamp(((int) $input['freeze_ms']) / 1000));
}

$mode = $input['mode'] ?? 'auth';

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

function lwCookieOut(Cookie $c): array
{
    return [
        'name' => $c->getName(),
        'value' => $c->getValue(),
        'expires' => $c->getExpiresTime(),
        'path' => $c->getPath(),
        'domain' => $c->getDomain(),
        'secure' => $c->isSecure(),
        'http_only' => $c->isHttpOnly(),
        'raw' => $c->isRaw(),
        'same_site' => $c->getSameSite(),
        'render_now' => time(),
        'header' => (string) $c,
    ];
}

function lwUserOut($user): mixed
{
    if ($user === null || $user === false) {
        return $user;
    }

    if (is_object($user) && method_exists($user, 'getAuthIdentifier')) {
        return [
            'id' => $user->getAuthIdentifier(),
            'email' => $user->email ?? null,
        ];
    }

    return $user;
}

function lwRetOut($ret): mixed
{
    if (is_object($ret) && method_exists($ret, 'getAuthIdentifier')) {
        return lwUserOut($ret);
    }

    if (is_array($ret) && $ret !== [] && array_is_list($ret) === false) {
        $out = [];

        foreach ($ret as $k => $v) {
            $out[$k] = lwUserOut($v);
        }

        return $out;
    }

    return $ret;
}

function lwFreshRequest(array $cookies = [], array $server = []): Request
{
    return Request::create('http://localhost/', 'GET', [], $cookies, [], $server);
}

// ---------------------------------------------------------------------------
// Mode: recaller — Recaller construction semantics.
// ---------------------------------------------------------------------------

if ($mode === 'recaller') {
    $out = [];

    foreach ($input['values'] ?? [] as $value) {
        $recaller = new Recaller($value);
        $valid = $recaller->valid();

        $out[] = [
            'in' => $value,
            'valid' => $valid,
            // id()/token()/hash()/segments() only run once valid() passed;
            // PHP 8.3 explodes the raw payload and fatals on non-strings,
            // which is exactly why callers gate on valid() first.
            'id' => $valid ? $recaller->id() : null,
            'token' => $valid ? $recaller->token() : null,
            'hash' => $valid ? $recaller->hash() : null,
            'segments' => $valid ? $recaller->segments() : null,
        ];
    }

    echo json_encode(['results' => $out]), "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// Mode: negotiation — Request::expectsJson() machinery.
// ---------------------------------------------------------------------------

if ($mode === 'negotiation') {
    $out = [];

    foreach ($input['vectors'] ?? [] as $vector) {
        $request = lwFreshRequest([], $vector['server'] ?? []);

        // Symfony Request::create() synthesizes a browser-ish default Accept
        // header; a real SAPI request without one reaches HeaderBag as null.
        // "drop_accept" models that (FPM/worker) case.
        if (!empty($vector['drop_accept'])) {
            $request->headers->remove('Accept');
        }

        $acceptable = $request->getAcceptableContentTypes();

        $out[] = [
            'server' => $vector['server'] ?? [],
            'expectsJson' => $request->expectsJson(),
            'wantsJson' => $request->wantsJson(),
            'acceptsAnyContentType' => $request->acceptsAnyContentType(),
            'ajax' => $request->ajax(),
            'pjax' => $request->pjax(),
            'acceptable' => array_map(
                fn ($v) => is_object($v) ? (string) $v : $v,
                $acceptable,
            ),
            'acceptable_json' => json_encode($acceptable),
        ];
    }

    echo json_encode(['results' => $out]), "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// Boot the app for the auth/hasher modes.
// ---------------------------------------------------------------------------

$app = require $appRoot . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$config = $app['config'];

if (!empty($input['str_random'])) {
    Str::createRandomStringsUsing(fn ($length) => str_repeat('A', $length));
}

$hasher = $app['hash'];

// ---------------------------------------------------------------------------
// Mode: hasher — BcryptHasher through the app HashManager.
// ---------------------------------------------------------------------------

if ($mode === 'hasher') {
    $driver = $hasher->driver('bcrypt');
    $out = [];

    foreach ($input['ops'] ?? [] as $step) {
        $op = array_shift($step);
        $args = $step[0] ?? [];

        try {
            switch ($op) {
                case 'check':
                    $ret = $driver->check($args[0], $args[1], $args[2] ?? []);
                    break;
                case 'needsRehash':
                    $ret = $driver->needsRehash($args[0], $args[1] ?? []);
                    break;
                case 'info':
                    $ret = $driver->info($args[0]);
                    break;
                case 'verifyConfiguration':
                    $ret = $driver->verifyConfiguration($args[0]);
                    break;
                case 'make':
                    $made = $driver->make($args[0], $args[1] ?? []);
                    $ret = [
                        'prefix' => substr($made, 0, 4),
                        'cost' => (int) substr($made, 4, 2),
                        'verifies' => password_verify($args[0], $made),
                        'len' => strlen($made),
                    ];
                    break;
                case 'setRoundsMake':
                    $made = $driver->setRounds((int) $args[0])->make($args[1]);
                    $driver->setRounds((int) $config->get('hashing.bcrypt.rounds', 12));
                    $ret = ['prefix' => substr($made, 0, 4), 'cost' => (int) substr($made, 4, 2)];
                    break;
                default:
                    fwrite(STDERR, "php-auth-oracle: unknown hasher op {$op}\n");
                    exit(2);
            }
            $threw = null;
        } catch (Throwable $e) {
            $ret = null;
            $threw = ['class' => get_class($e), 'message' => $e->getMessage()];
        }

        $out[] = [
            'op' => json_encode($step === [] ? [$op] : array_merge([$op], $args)),
            'ret' => json_encode(lwRetOut($ret)),
            'threw' => $threw,
        ];
    }

    echo json_encode([
        'results' => $out,
        'meta' => [
            'rounds' => (int) $config->get('hashing.bcrypt.rounds', 12),
            'verify' => $config->get('hashing.bcrypt.verify'),
            'limit' => $config->get('hashing.bcrypt.limit'),
            'rehash_on_login' => $config->get('hashing.rehash_on_login', true),
        ],
    ]), "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// Mode: auth — full SessionGuard run.
// ---------------------------------------------------------------------------

// Dedicated sqlite database for the oracle user table.
$dbPath = $input['db_path'] ?? ($appRoot . '/lw-auth-oracle.sqlite');

if (!is_dir(dirname($dbPath))) {
    @mkdir(dirname($dbPath), 0777, true);
}

if (!file_exists($dbPath)) {
    touch($dbPath);
}

$config->set('database.default', 'lw_auth');
$config->set('database.connections.lw_auth', [
    'driver' => 'sqlite',
    'database' => $dbPath,
    'prefix' => '',
    'foreign_key_constraints' => true,
]);

DB::purge('lw_auth');

Schema::connection('lw_auth')->dropIfExists('lw_users');
Schema::connection('lw_auth')->create('lw_users', function ($table) {
    $table->id();
    $table->string('name')->nullable();
    $table->string('email')->unique();
    $table->timestamp('email_verified_at')->nullable();
    $table->string('password');
    $table->string('remember_token', 100)->nullable();
    $table->timestamps();
});

$userInput = $input['user'] ?? [];

if ($userInput !== []) {
    DB::connection('lw_auth')->table('lw_users')->insert([[
        'id' => $userInput['id'] ?? 1,
        'name' => $userInput['name'] ?? 'Test User',
        'email' => $userInput['email'] ?? 'u@example.com',
        'email_verified_at' => null,
        'password' => $userInput['password_hash'] ?? password_hash('secret', PASSWORD_BCRYPT, ['cost' => 12]),
        'remember_token' => $userInput['remember_token'] ?? null,
        'created_at' => '2026-01-01 00:00:00',
        'updated_at' => '2026-01-01 00:00:00',
    ]]);
}

if (!class_exists('LWOracleUser')) {
    class LWOracleUser extends \Illuminate\Foundation\Auth\User
    {
        protected $connection = 'lw_auth';

        protected $table = 'lw_users';

        protected $guarded = [];

        public $timestamps = true;
    }
}

$guardName = $input['guard'] ?? 'web';

// Real session store: array handler + fixed id, json serialization.
$session = new Store(
    $input['session_name'] ?? 'laravel_session',
    new ArraySessionHandler((int) ($input['session_lifetime'] ?? 120)),
    $input['session_id'] ?? null,
    $input['serialization'] ?? 'json',
);
$session->start();

foreach ($input['session_seed'] ?? [] as $seedKey => $seedValue) {
    $session->put($seedKey, $seedValue);
}

// Real cookie jar with the app's session defaults.
$jar = new CookieJar();
$jar->setDefaultPathAndDomain(
    $config->get('session.path', '/'),
    $config->get('session.domain'),
    $config->get('session.secure'),
    $config->get('session.same_site', 'lax'),
);

// Real dispatcher with a wildcard recorder.
$dispatcher = new Illuminate\Events\Dispatcher($app);
$recordedEvents = [];

$dispatcher->listen('*', function ($eventName, $payload) use (&$recordedEvents) {
    $event = is_array($payload) && isset($payload[0]) ? $payload[0] : null;

    if ($event === null) {
        return;
    }

    $entry = ['class' => get_class($event)];

    foreach (['guard', 'remember'] as $prop) {
        if (property_exists($event, $prop)) {
            $entry[$prop] = $event->{$prop};
        }
    }

    if (property_exists($event, 'credentials')) {
        $entry['credentials'] = $event->credentials;
    }

    if (property_exists($event, 'user')) {
        $entry['user'] = lwUserOut($event->user);
    }

    $recordedEvents[] = $entry;
});

$request = lwFreshRequest($input['cookies'] ?? [], $input['server'] ?? []);

$provider = new EloquentUserProvider($hasher, LWOracleUser::class);

$guard = new SessionGuard(
    $guardName,
    $provider,
    $session,
    $request,
    null,
    (bool) $config->get('hashing.rehash_on_login', true),
    (int) $config->get('auth.timebox_duration', 200000),
    $config->get('app.key'),
);

$guard->setCookieJar($jar);
$guard->setDispatcher($dispatcher);
$guard->setRequest($request);

$rememberMinutes = $config->get("auth.guards.{$guardName}.remember");

if ($rememberMinutes !== null) {
    $guard->setRememberDuration($rememberMinutes);
}

$attemptingCalls = [];
$guard->attempting(function ($event) use (&$attemptingCalls) {
    $attemptingCalls[] = $event->credentials;
});

$factory = new class($guard) implements AuthFactory
{
    public $shouldUseName = null;

    public function __construct(public $guardInstance)
    {
    }

    public function guard($name = null)
    {
        return $this->guardInstance;
    }

    public function shouldUse($name)
    {
        $this->shouldUseName = $name;

        return $this;
    }
};

$snapshots = [];

$dbSnapshot = function () {
    return DB::connection('lw_auth')->table('lw_users')
        ->orderBy('id')
        ->get(['id', 'email', 'remember_token', 'password'])
        ->map(fn ($row) => (array) $row)
        ->all();
};

foreach ($input['ops'] ?? [] as $step) {
    if (!is_array($step) || $step === []) {
        fwrite(STDERR, "php-auth-oracle: malformed op\n");
        exit(2);
    }

    $op = array_shift($step);
    $args = $step[0] ?? [];
    $hasRet = true;
    $ret = null;
    $threw = null;
    $extra = [];
    $beforeEvents = count($recordedEvents);
    $startedAt = microtime(true);

    try {
        switch ($op) {
            case 'attempt':
                $ret = $guard->attempt($args[0], $args[1] ?? false);
                break;
            case 'attemptWhen':
                $cbSpec = $args[1] ?? null;
                $callbacks = null;

                if ($cbSpec !== null) {
                    $make = function ($entry) {
                        if (is_bool($entry)) {
                            return fn ($user, $guard) => $entry;
                        }

                        if (is_array($entry) && isset($entry['user_email_suffix'])) {
                            return fn ($user, $guard) => str_ends_with((string) $user->email, $entry['user_email_suffix']);
                        }

                        return fn ($user, $guard) => true;
                    };

                    $callbacks = is_array($cbSpec) && array_is_list($cbSpec)
                        ? array_map($make, $cbSpec)
                        : $make($cbSpec);
                }

                $ret = $guard->attemptWhen($args[0], $callbacks, $args[2] ?? false);
                break;
            case 'once':
                $ret = $guard->once($args[0]);
                break;
            case 'onceUsingId':
                $ret = $guard->onceUsingId($args[0]);
                break;
            case 'validate':
                $ret = $guard->validate($args[0]);
                break;
            case 'loginUsingId':
                $ret = $guard->loginUsingId($args[0], $args[1] ?? false);
                break;
            case 'logout':
                $guard->logout();
                $hasRet = false;
                break;
            case 'logoutCurrentDevice':
                $guard->logoutCurrentDevice();
                $hasRet = false;
                break;
            case 'logoutOtherDevices':
                $guard->logoutOtherDevices($args[0]);
                $hasRet = false;
                break;
            case 'user':
                $ret = $guard->user();
                break;
            case 'id':
                $ret = $guard->id();
                break;
            case 'check':
                $ret = $guard->check();
                break;
            case 'guest':
                $ret = $guard->guest();
                break;
            case 'hasUser':
                $ret = $guard->hasUser();
                break;
            case 'viaRemember':
                $ret = $guard->viaRemember();
                break;
            case 'getLastAttempted':
                $ret = $guard->getLastAttempted();
                break;
            case 'hashPasswordForCookie':
                $ret = $guard->hashPasswordForCookie($args[0]);
                break;
            case 'getName':
                $ret = $guard->getName();
                break;
            case 'getRecallerName':
                $ret = $guard->getRecallerName();
                break;
            case 'sessionPut':
                $session->put($args[0], $args[1]);
                $hasRet = false;
                break;
            case 'sessionRemove':
                $session->remove($args[0]);
                $hasRet = false;
                break;
            case 'middlewareAuth': {
                $middleware = new Authenticate($factory);
                $nextCalled = false;
                $next = function ($request) use (&$nextCalled) {
                    $nextCalled = true;

                    return 'NEXT';
                };

                try {
                    $ret = $middleware->handle($request, $next, ...($args[0] ?? []));
                    $extra = ['next' => $nextCalled, 'shouldUse' => $factory->shouldUseName ?? null];
                } catch (AuthenticationException $e) {
                    $ret = null;
                    $threw = ['class' => get_class($e), 'message' => $e->getMessage()];
                    $extra = [
                        'next' => $nextCalled,
                        'guards' => $e->guards(),
                        'redirectTo' => $e->redirectTo($request),
                        'expectsJson' => $request->expectsJson(),
                    ];
                }
                break;
            }
            case 'middlewareGuest': {
                // The vendor RedirectIfAuthenticated checks the Auth FACADE
                // (not an injected factory). In a compiled app that facade is
                // our auth manager, so swap the binding for this op and
                // restore it afterwards.
                $originalAuth = \Illuminate\Support\Facades\Auth::getFacadeRoot();
                \Illuminate\Support\Facades\Auth::swap($factory);

                try {
                    $middleware = new RedirectIfAuthenticated($factory);
                    $nextCalled = false;
                    $next = function ($request) use (&$nextCalled) {
                        $nextCalled = true;

                        // handle(): Response is strictly typed; a plain string
                        // "next" would TypeError.
                        return new \Symfony\Component\HttpFoundation\Response('NEXT');
                    };

                    $ret = $middleware->handle($request, $next, ...($args[0] ?? []));

                    if (is_object($ret) && method_exists($ret, 'getTargetUrl')) {
                        $ret = [
                            'status' => $ret->getStatusCode(),
                            'location' => $ret->getTargetUrl(),
                            'next' => $nextCalled,
                        ];
                    } else {
                        $ret = [
                            'ret' => method_exists($ret, 'getContent') ? $ret->getContent() : $ret,
                            'next' => $nextCalled,
                        ];
                    }
                } finally {
                    \Illuminate\Support\Facades\Auth::swap($originalAuth);
                }
                break;
            }
            default:
                fwrite(STDERR, "php-auth-oracle: unknown op {$op}\n");
                exit(2);
        }
    } catch (Throwable $e) {
        $ret = null;
        $threw = ['class' => get_class($e), 'message' => $e->getMessage()];
    }

    $snapshots[] = [
        'op' => $op,
        'has_ret' => $hasRet,
        'ret' => json_encode(lwRetOut($ret)),
        'threw' => $threw,
        'extra' => $extra,
        'session' => json_encode($session->all()),
        'session_id' => $session->getId(),
        'queued' => array_map('lwCookieOut', $jar->getQueuedCookies()),
        'db' => $dbSnapshot(),
        'events' => array_slice($recordedEvents, $beforeEvents),
        'duration_ms' => (int) round((microtime(true) - $startedAt) * 1000),
    ];
}

echo json_encode([
    'meta' => [
        'login_name' => $guard->getName(),
        'recaller_name' => $guard->getRecallerName(),
        'remember_minutes' => $rememberMinutes ?? 5760,
        'hash_key' => $config->get('app.key'),
        'rounds' => (int) $config->get('hashing.bcrypt.rounds', 12),
        'verify' => $config->get('hashing.bcrypt.verify'),
        'rehash_on_login' => $config->get('hashing.rehash_on_login', true),
        'timebox_duration' => (int) $config->get('auth.timebox_duration', 200000),
        'expects_json' => $request->expectsJson(),
        'attempting_calls' => $attemptingCalls,
    ],
    'snapshots' => $snapshots,
    'final' => [
        'session' => json_encode($session->all()),
        'session_id' => $session->getId(),
    ],
]), "\n";
