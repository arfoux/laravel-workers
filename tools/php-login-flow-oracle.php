<?php
require_once __DIR__ . '/_root.php';

// tools/php-login-flow-oracle.php — Breeze-shape login flow parity oracle.
//
// Boots a real Laravel app and replays the *application's own* `/login`,
// `/dashboard` and `/logout` routes through the full HTTP kernel
// (EncryptCookies -> StartSession -> CSRF -> route middleware -> controller)
// carrying a cookie jar between steps. The controllers under test run unchanged;
// only the storage is redirected at a dedicated sqlite connection so application
// data is never touched, and the auth provider model is swapped to LWOracleUser
// (table `lw_users`) so `Auth::attempt()` resolves against the oracle seeds.
//
// Usage: php tools/php-login-flow-oracle.php
//   stdin:  {"app_root":"...","freeze_ms":<int>,"user":{...},"steps":[...]}
//   stdout: {"app":...,"config":{...},"user":{...},"steps":[{"label","status",
//            "headers","set_cookie","jar_after","body","session_rows",
//            "session_plain","xsrf_plain"}]}
//
// Step fields: method, uri, jar (bool), cookies (map), headers (map), form (map),
//   server (map). Placeholder inside strings: `@token` -> the `_token` seen in the
//   previous step's session row (the driver reads it back out of the session
//   store, so `SessionGuard::login` / `regenerate()` token rotation stays in step).
//
// Routes are whatever the app declares; this oracle assumes the Breeze shape:
//   GET  /login      named `login`                        (guest)
//   POST /login      guest + throttle:5,1                 -> redirect()->intended()
//   POST /logout     auth                                 -> redirect('/')
//   GET  /dashboard  auth                                 -> JSON

$input = json_decode(stream_get_contents(STDIN), true);
if (!is_array($input)) {
    fwrite(STDERR, "php-login-flow-oracle: bad input json\n");
    exit(1);
}

$appRoot = $input['app_root'] ?? (getenv('LW_LARAVEL_APP') ?: null);
if (!is_string($appRoot) || !is_file($appRoot . '/bootstrap/app.php') || !lw_has_vendor($appRoot)) {
    fwrite(STDERR, "php-login-flow-oracle: pass \"app_root\" or set LW_LARAVEL_APP (a Laravel app root with an autoloader - set LW_VENDOR_DIR to reuse one)\n");
    exit(2);
}

require lw_vendor_autoload_for($appRoot);

use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

$app = require $appRoot . '/bootstrap/app.php';

if (isset($input['freeze_ms'])) {
    Carbon::setTestNow(Carbon::createFromTimestamp(((int) $input['freeze_ms']) / 1000));
}

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$kernel->bootstrap();

$config = $app['config'];

// ---------------------------------------------------------------------------
// Dedicated sqlite database (sessions + oracle user + cache for the throttle).
// ---------------------------------------------------------------------------
$dbPath = $input['db_path'] ?? ($appRoot . '/php-login-flow-oracle.sqlite');
if (file_exists($dbPath)) @unlink($dbPath);
@mkdir(dirname($dbPath), 0777, true);
touch($dbPath);

$config->set('database.default', 'lw_http');
$config->set('database.connections.lw_http', [
    'driver' => 'sqlite',
    'database' => $dbPath,
    'prefix' => '',
    'foreign_key_constraints' => true,
]);
DB::purge('lw_http');

Schema::connection('lw_http')->create('sessions', function ($table) {
    $table->string('id')->primary();
    $table->foreignId('user_id')->nullable()->index();
    $table->string('ip_address', 45)->nullable();
    $table->text('user_agent')->nullable();
    $table->longText('payload');
    $table->integer('last_activity')->index();
});

Schema::connection('lw_http')->create('lw_users', function ($table) {
    $table->id();
    $table->string('name')->nullable();
    $table->string('email')->unique();
    $table->timestamp('email_verified_at')->nullable();
    $table->string('password');
    $table->string('remember_token', 100)->nullable();
    $table->timestamps();
});

// The database cache store backs `throttle:5,1` (RouteMiddleware resolves it
// through the default cache store). Mirrors Laravel's stock migration.
Schema::connection('lw_http')->create('cache', function ($table) {
    $table->string('key')->primary();
    $table->mediumText('value');
    $table->integer('expiration');
});

Schema::connection('lw_http')->create('cache_locks', function ($table) {
    $table->string('key')->primary();
    $table->string('owner');
    $table->integer('expiration');
});

$userInput = $input['user'] ?? [];
$passwordHash = $userInput['password_hash']
    ?? password_hash('secret', PASSWORD_BCRYPT, ['cost' => 12]);

DB::connection('lw_http')->table('lw_users')->insert([[
    'id' => $userInput['id'] ?? 1,
    'name' => $userInput['name'] ?? 'Test User',
    'email' => $userInput['email'] ?? 'u@example.com',
    'email_verified_at' => null,
    'password' => $passwordHash,
    'remember_token' => null,
    'created_at' => '2026-01-01 00:00:00',
    'updated_at' => '2026-01-01 00:00:00',
]]);

if (!class_exists('LWOracleUser')) {
    class LWOracleUser extends \Illuminate\Foundation\Auth\User
    {
        protected $connection = 'lw_http';

        protected $table = 'lw_users';

        protected $guarded = [];
    }
}

// Session + auth + throttle cache all point at the oracle database / model.
$config->set('session.driver', 'database');
$config->set('session.connection', 'lw_http');
$config->set('session.table', 'sessions');
$config->set('session.encrypt', false);
$config->set('auth.providers.users', ['driver' => 'eloquent', 'model' => 'LWOracleUser']);

$config->set('cache.default', 'database');
$config->set('cache.stores.database', [
    'driver' => 'database',
    'connection' => 'lw_http',
    'table' => 'cache',
    'lock_table' => 'cache_locks',
    'lock_connection' => 'lw_http',
]);

// The app's own routes are the subject of the test; nothing extra is registered.
$router = $app->make('router');
$router->getRoutes()->refreshNameLookups();

// ---------------------------------------------------------------------------
// Replay the steps.
// ---------------------------------------------------------------------------
$encrypter = $app->make(Illuminate\Contracts\Encryption\Encrypter::class);
$cookieJar = $app->make('cookie');

function lwResolve($value, array $jar, ?string $lastToken)
{
    if (is_array($value)) {
        $out = [];
        foreach ($value as $k => $v) {
            $out[$k] = lwResolve($v, $jar, $lastToken);
        }
        return $out;
    }
    if (!is_string($value)) return $value;
    if ($value === '@token') {
        if ($lastToken === null) throw new RuntimeException('@token but no session token seen yet');
        return $lastToken;
    }
    return $value;
}

function lwDecodePayload(string $payload): array
{
    // The database session handler stores base64_encode($data) in the column.
    $raw = base64_decode($payload, true);
    if (!is_string($raw)) return ['__serialization' => 'non-base64'];

    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : ['__serialization' => 'non-json'];
}

/** Decrypt an EncryptCookies-protected cookie value (Laravel prefix aware). */
function lwDecryptCookie($encrypter, string $name, ?string $value)
{
    if ($value === null) return null;
    try {
        $raw = $encrypter->decrypt($value, false);
        return \Illuminate\Cookie\CookieValuePrefix::remove($raw);
    } catch (Throwable $e) {
        return '__undecryptable__';
    }
}

$jar = [];
$lastToken = null;
$out = [
    'app' => realpath($appRoot),
    'user' => [
        'id' => $userInput['id'] ?? 1,
        'email' => $userInput['email'] ?? 'u@example.com',
        'password_hash' => $passwordHash,
    ],
    'config' => [
        'app.key' => $config->get('app.key'),
        'app.url' => $config->get('app.url'),
        'session.driver' => $config->get('session.driver'),
        'session.cookie' => $config->get('session.cookie'),
        'session.lifetime' => $config->get('session.lifetime'),
        'session.expire_on_close' => $config->get('session.expire_on_close'),
        'session.path' => $config->get('session.path'),
        'session.domain' => $config->get('session.domain'),
        'session.secure' => $config->get('session.secure'),
        'session.http_only' => $config->get('session.http_only'),
        'session.same_site' => $config->get('session.same_site'),
        'session.partitioned' => $config->get('session.partitioned'),
        'session.serialization' => $config->get('session.serialization'),
        'cookies.except' => [],
        'csrf.except' => [],
        'auth.defaults.guard' => $config->get('auth.defaults.guard'),
        'auth.guards.web' => $config->get('auth.guards.web'),
        'auth.providers.users' => $config->get('auth.providers.users'),
        'auth.hash_key' => $config->get('app.key'),
        'auth.timebox_duration' => $config->get('auth.timebox_duration', 200000),
        'auth.rehash_on_login' => $config->get('hashing.rehash_on_login', true),
        'hashing.driver' => $config->get('hashing.driver'),
        'hashing.bcrypt.rounds' => $config->get('hashing.bcrypt.rounds'),
        'hashing.bcrypt.verify' => $config->get('hashing.bcrypt.verify'),
        'hashing.bcrypt.limit' => $config->get('hashing.bcrypt.limit'),
    ],
    'steps' => [],
];

foreach (($input['steps'] ?? []) as $step) {
    $method = strtoupper($step['method'] ?? 'GET');
    $uri = 'http://localhost' . ($step['uri'] ?? '/');

    $cookies = !empty($step['jar']) ? $jar : [];
    if (!empty($step['cookies'])) {
        $cookies = array_merge($cookies, lwResolve($step['cookies'], $jar, $lastToken));
    }

    $server = array_merge(['HTTP_ACCEPT' => 'text/html,application/xhtml+xml'], $step['server'] ?? []);
    $params = isset($step['form']) ? lwResolve($step['form'], $jar, $lastToken) : [];
    $content = null;
    if (isset($step['json'])) {
        $content = $step['json'];
        $server['CONTENT_TYPE'] = 'application/json';
        $server['HTTP_ACCEPT'] = 'application/json';
    }

    $request = Request::create($uri, $method, $params, $cookies, [], $server, $content);
    foreach (lwResolve($step['headers'] ?? [], $jar, $lastToken) as $h => $v) {
        $request->headers->set($h, $v);
    }

    $response = $kernel->handle($request);

    $headers = [];
    foreach ($response->headers->all() as $name => $values) {
        if ($name === 'set-cookie') continue;
        $headers[$name] = $values;
    }
    $setCookie = [];
    foreach ($response->headers->getCookies() as $cookie) {
        $setCookie[] = (string) $cookie;
    }

    $body = $response->getContent();

    // Update the jar from Set-Cookie, browser-style (raw values).
    foreach ($setCookie as $sc) {
        $pair = explode(';', $sc, 2)[0];
        $eq = strpos($pair, '=');
        if ($eq === false) continue;
        $name = urldecode(substr($pair, 0, $eq));
        $value = urldecode(substr($pair, $eq + 1));
        if ($value === '' && stripos($sc, 'expires=') !== false && stripos($sc, 'max-age=0') !== false) {
            unset($jar[$name]);
        } else {
            $jar[$name] = $value;
        }
    }

    $rows = DB::connection('lw_http')->table('sessions')->orderBy('id')->get()
        ->map(function ($row) {
            $row = (array) $row;
            return [
                'id' => $row['id'],
                'user_id' => $row['user_id'],
                'ip_address' => $row['ip_address'],
                'user_agent' => $row['user_agent'],
                'last_activity' => (int) $row['last_activity'],
                'payload' => $row['payload'],
                'payload_decoded' => lwDecodePayload($row['payload']),
            ];
        })->all();

    $sessionCookie = $config->get('session.cookie');
    $sessionPlain = lwDecryptCookie($encrypter, $sessionCookie, $jar[$sessionCookie] ?? null);

    // Resolve the next step's `@token` from the *current* session row (the one the
    // jar points at), not from a response body — the Breeze controllers never echo
    // it. SessionGuard / regenerate() rotate both the id and the token.
    foreach ($rows as $row) {
        if ($sessionPlain !== null && $row['id'] === $sessionPlain) {
            if (isset($row['payload_decoded']['_token']) && is_string($row['payload_decoded']['_token'])) {
                $lastToken = $row['payload_decoded']['_token'];
            }
        }
    }

    $out['steps'][] = [
        'label' => $step['label'] ?? ($method . ' ' . $uri),
        'status' => $response->getStatusCode(),
        'headers' => $headers,
        'set_cookie' => $setCookie,
        'jar_after' => $jar,
        'body' => $body,
        'session_rows' => $rows,
        'session_plain' => $sessionPlain,
        'xsrf_plain' => lwDecryptCookie($encrypter, 'XSRF-TOKEN', $jar['XSRF-TOKEN'] ?? null),
    ];

    // One app instance is reused across steps; flush per-request state so the next
    // step starts like a fresh worker request would.
    $cookieJar->flushQueuedCookies();
    if ($app->bound('auth')) {
        $app->make('auth')->forgetGuards();
    }
    $app->forgetInstance('auth.driver');
    app()->forgetInstance('request');
}

echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
