<?php

// tools/php-shadow-oracle.php — generic scenario oracle for the shadow harness.
//
// Boots a real Laravel app and replays a *scenario* (a list of request steps)
// through the full HTTP kernel (EncryptCookies -> StartSession -> CSRF ->
// route middleware -> controller), carrying a cookie jar between the steps.
// The controllers under test run unchanged; only the storage is redirected at a
// dedicated sqlite connection so application data is never touched.
//
// Usage: php tools/php-shadow-oracle.php
//   stdin:  {"app_root":"...","db_path":"...","freeze_ms":<int>,
//            "migrate":true,"user":{...},"fixtures":[{"sql":"..."}],
//            "steps":[{"label","method","uri","jar","headers","form","json","query"}]}
//   stdout: {"app":...,"user":{...},"steps":[{"label","status","headers",
//            "set_cookie","body","session_rows"}]}
//
// Step fields:
//   method, uri      the request line (uri may carry a query string)
//   jar              carry the cookie jar from the previous step
//   headers          extra request headers (map)
//   form             form fields (map) — `@token` resolves to the CSRF token
//   json             a JSON request body
//   query            extra query parameters (map)
//   fixtures         SQL rows inserted before the steps (both sides see them)
//
// The schema comes from the app's own migrations, so the oracle and the
// compiled worker read exactly the same tables. The auth provider is swapped to
// `LWOracleUser` (table `lw_users`) so the oracle's seeded user never collides
// with the app's own `users` table.

$input = json_decode(stream_get_contents(STDIN), true);
if (!is_array($input)) {
    fwrite(STDERR, "php-shadow-oracle: bad input json\n");
    exit(1);
}

$appRoot = $input['app_root'] ?? (getenv('LW_LARAVEL_APP') ?: null);
if (!is_string($appRoot) || !is_file($appRoot . '/vendor/autoload.php')) {
    fwrite(STDERR, "php-shadow-oracle: pass \"app_root\" or set LW_LARAVEL_APP (vendor/autoload.php required)\n");
    exit(2);
}

require $appRoot . '/vendor/autoload.php';

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
// Nothing but the JSON may reach stdout: a PHP notice, or an uncaught error
// (the app's own error page can itself fail), would corrupt the result.
ini_set('display_errors', '0');
ini_set('log_errors', '0');
ob_start();

$config = $app['config'];

// The oracle runs in a controlled environment: whoops (the debug error page)
// prints the error page to stdout and exits, which would destroy the harness
// result. With debug off Laravel renders the error page as a normal response.
$config->set('app.debug', false);

// ---------------------------------------------------------------------------
// Dedicated sqlite database (the app's own schema + the oracle's own tables).
// ---------------------------------------------------------------------------
$dbPath = $input['db_path'] ?? ($appRoot . '/php-shadow-oracle.sqlite');
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
DB::connection('lw_http')->reconnect();

// The app's own migrations — the compiled worker reads the same tables.
if (array_key_exists('migrate', $input) ? $input['migrate'] : true) {
    try {
        $console = $app->make(Illuminate\Contracts\Console\Kernel::class);
        $console->call('migrate', ['--force' => true, '--database' => 'lw_http']);
    } catch (Throwable $e) {
        fwrite(STDERR, 'php-shadow-oracle: migrate failed: ' . $e->getMessage() . "\n");
        exit(3);
    }
}

$schema = Schema::connection('lw_http');

// The oracle's own auth table (the app's `users` table is left alone).
if (!$schema->hasTable('lw_users')) {
    $schema->create('lw_users', function ($table) {
        $table->id();
        $table->string('name')->nullable();
        $table->string('email')->unique();
        $table->timestamp('email_verified_at')->nullable();
        $table->string('password');
        $table->string('remember_token', 100)->nullable();
        $table->timestamps();
    });
}

// The database session handler + the database cache store (Laravel's stock
// tables — the app may or may not ship the migrations for them).
if (!$schema->hasTable('sessions')) {
    $schema->create('sessions', function ($table) {
        $table->string('id')->primary();
        $table->foreignId('user_id')->nullable()->index();
        $table->string('ip_address', 45)->nullable();
        $table->text('user_agent')->nullable();
        $table->longText('payload');
        $table->integer('last_activity')->index();
    });
}
if (!$schema->hasTable('cache')) {
    $schema->create('cache', function ($table) {
        $table->string('key')->primary();
        $table->mediumText('value');
        $table->integer('expiration');
    });
}
if (!$schema->hasTable('cache_locks')) {
    $schema->create('cache_locks', function ($table) {
        $table->string('key')->primary();
        $table->string('owner');
        $table->integer('expiration');
    });
}

$userInput = $input['user'] ?? [];
$passwordHash = $userInput['password_hash']
    ?? password_hash($userInput['password'] ?? 'secret', PASSWORD_BCRYPT, ['cost' => 12]);

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

// The compiled worker authenticates against the *app's* own user model (table
// `users`), the oracle against `lw_users` — so the same user row must exist in
// both, or the two sides would authenticate different accounts.
if ($schema->hasTable('users') && $userInput['id'] !== null) {
    try {
        DB::connection('lw_http')->table('users')->insert([[
            'id' => $userInput['id'] ?? 1,
            'name' => $userInput['name'] ?? 'Test User',
            'email' => $userInput['email'] ?? 'u@example.com',
            'email_verified_at' => null,
            'password' => $passwordHash,
            'remember_token' => null,
            'created_at' => '2026-01-01 00:00:00',
            'updated_at' => '2026-01-01 00:00:00',
        ]]);
    } catch (Throwable $e) {
        // The app's users table may have extra required columns — the compiled
        // side then simply cannot authenticate this user (the harness reports
        // the divergence).
        fwrite(STDERR, 'php-shadow-oracle: users seed skipped: ' . $e->getMessage() . "\n");
    }
}

// The oracle uses the app's own auth provider (the same model + table the
// compiled worker uses) so both sides authenticate the *same* row. The row is
// seeded in the oracle's own sqlite database, so the app's data is untouched.
if (!class_exists('LWOracleUser')) {
    class LWOracleUser extends \Illuminate\Foundation\Auth\User
    {
        protected $connection = 'lw_http';

        protected $table = 'lw_users';

        protected $guarded = [];
    }
}

// Session + auth + the cache store all point at the oracle database / model.
$config->set('session.driver', 'database');
$config->set('session.connection', 'lw_http');
$config->set('session.table', 'sessions');
$config->set('session.encrypt', false);
// The oracle keeps the app's own auth provider (the same model + table the
// compiled worker uses) so both sides authenticate the *same* row. The row is
// seeded in the oracle's own sqlite database, so the app's data is untouched.
// (A `LWOracleUser` swap is still possible via `user.provider` in the scenario.)

$config->set('cache.default', 'database');
$config->set('cache.stores.database', [
    'driver' => 'database',
    'connection' => 'lw_http',
    'table' => 'cache',
    'lock_table' => 'cache_locks',
    'lock_connection' => 'lw_http',
]);

// Scenario fixtures (rows both sides must see).
foreach (($input['fixtures'] ?? []) as $fixture) {
    $sql = is_array($fixture) ? ($fixture['sql'] ?? null) : $fixture;
    if (!is_string($sql) || $sql === '') continue;
    try {
        DB::connection('lw_http')->statement($sql);
    } catch (Throwable $e) {
        fwrite(STDERR, 'php-shadow-oracle: fixture failed (' . $e->getMessage() . '): ' . $sql . "\n");
        exit(4);
    }
}

// The *seed* database: the prepared schema + fixtures, before any step runs.
// The shadow harness copies this file for the compiled side, so both sides
// start from exactly the same rows.
if (!empty($input['seed_path'])) {
    $seedPath = $input['seed_path'];
    @mkdir(dirname($seedPath), 0777, true);
    if (!@copy($dbPath, $seedPath)) {
        fwrite(STDERR, "php-shadow-oracle: could not copy the seed database\n");
        exit(5);
    }
}

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
    'db_path' => $dbPath,
    'user' => [
        'id' => $userInput['id'] ?? 1,
        'email' => $userInput['email'] ?? 'u@example.com',
        'password_hash' => $passwordHash,
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
    $headers = lwResolve($step['headers'] ?? [], $jar, $lastToken);
    // A web server turns `Authorization: Basic ...` into PHP_AUTH_USER/PHP_AUTH_PW
    // (Symfony's Request::getUser()/getPassword() read those). Request::create()
    // does not, so the oracle does it here.
    if (isset($headers['Authorization']) || isset($headers['authorization'])) {
        $raw = $headers['Authorization'] ?? $headers['authorization'];
        if (preg_match('/^\s*Basic\s+(.+)$/i', (string) $raw, $m)) {
            $decoded = base64_decode(trim($m[1]), true);
            if (is_string($decoded) && ($sep = strpos($decoded, ':')) !== false) {
                $server['PHP_AUTH_USER'] = substr($decoded, 0, $sep);
                $server['PHP_AUTH_PW'] = substr($decoded, $sep + 1);
            }
        }
    }
    $params = isset($step['form']) ? lwResolve($step['form'], $jar, $lastToken) : [];
    $query = isset($step['query']) ? lwResolve($step['query'], $jar, $lastToken) : [];
    $content = null;
    if (isset($step['json'])) {
        $content = is_string($step['json']) ? $step['json'] : json_encode($step['json']);
        $server['CONTENT_TYPE'] = 'application/json';
        $server['HTTP_ACCEPT'] = 'application/json';
    }

    $request = Request::create($uri, $method, $params, $cookies, [], $server, $content);
    if (!empty($query)) {
        $request->query->replace($query);
    }
    foreach ($headers as $h => $v) {
        $request->headers->set($h, $v);
    }

    try {
        // The error pages (a 405, a 500) are rendered into the output buffer
        // instead of the response body in a CLI run. In a web request PHP
        // captures that output as the response content, so the oracle does the
        // same: the buffer is the body when the response carries none.
        ob_start();
        try {
            $response = $kernel->handle($request);
        } finally {
            $echoed = ob_get_clean();
        }
    } catch (\Throwable $e) {
        // The app's error handling itself failed (a broken error page, a
        // missing view): the step still gets a response, so the harness can
        // compare it instead of losing the whole run.
        $response = new Illuminate\Http\Response(
            'The application failed to render the error page: ' . $e->getMessage(),
            500
        );
        $echoed = '';
    }

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
    // The error page (a 405, a 500) is rendered into the output buffer; in a
    // web request that output IS the response body.
    if ($body === '' && !empty($echoed)) {
        $body = $echoed;
    }

    // Update the jar from Set-Cookie, browser-style (raw values). Only a step
    // that *used* the jar may update it: a step without the jar is a separate
    // visitor, whose cookies must not replace the main flow's session.
    if (!empty($step['jar'])) {
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
    }

    $rows = DB::connection('lw_http')->table('sessions')->orderBy('id')->get()
        ->map(function ($row) {
            $row = (array) $row;
            return [
                'id' => $row['id'],
                'user_id' => $row['user_id'],
                'last_activity' => (int) $row['last_activity'],
                'payload_decoded' => lwDecodePayload($row['payload']),
            ];
        })->all();

    $sessionCookie = $config->get('session.cookie');
    $sessionPlain = lwDecryptCookie($encrypter, $sessionCookie, $jar[$sessionCookie] ?? null);

    // Resolve the next step's `@token` from the *current* session row (the one the
    // jar points at), not from a response body — the token rotates on login and
    // on regenerate().
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
    ];

    // One app instance is reused across steps; flush per-request state so the next
    // step starts like a fresh worker request would. The session store is
    // *cleared* (not replaced): Laravel's Store::loadSession() MERGES the
    // handler's row into the in-memory attributes, so a step without the cookie
    // would otherwise still see the previous step's session (and its user).
    $cookieJar->flushQueuedCookies();
    if ($app->bound('auth')) {
        $app->make('auth')->forgetGuards();
    }
    $app->forgetInstance('auth.driver');
    if ($app->bound('session.store')) {
        $store = $app->make('session.store');
        $store->flush();
        $store->setId(null);
    }
    app()->forgetInstance('request');
}

$json = json_encode($out);
// The error renderer (the Symfony error page) writes to the output stream
// while it renders, so the JSON is printed behind a marker: the harness reads
// what follows it.
if (ob_get_level() > 0) {
    @ob_end_clean();
}
echo "\n__LW_JSON__" . $json . "\n";
