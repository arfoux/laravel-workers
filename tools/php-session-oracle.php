<?php

// tools/php-session-oracle.php — PHP 8.3 oracle for kernel/session.mjs.
//
// Runs the real Illuminate\Session\Store (laravel/framework 11+/13.x) against a
// recording session handler (mode "store") or the real CookieSessionHandler +
// CookieJar (mode "cookie") and prints every intermediate state so
// kernel/tests/session.test.mjs can prove byte-for-byte parity of:
//   - Arr::get/set/forget semantics as used by Store (dot notation, null
//     handling, list/gap array shapes)
//   - flash lifecycle (_flash.old/_flash.new, array_merge/unique/diff shapes)
//   - Store::save() payload bytes (json_encode / serialize)
//   - cookie driver envelopes ({data,expires}), CookieJar queueing and the
//     Symfony Cookie::__toString() rendering of session cookies
//
// Input (stdin JSON):
//   {
//     "app_root": "...",                 // or env LW_LARAVEL_APP (needs vendor/autoload.php)
//     "mode": "store" | "cookie",        // default "store"
//     "serialization": "json" | "php",   // default "json"
//     "name": "laravel_session",         // session cookie name
//     "id": "40-char" | null,            // passed to Store::__construct
//     "seed_handler_data": "..."|null,   // store mode: what handler->read() returns
//     "seed": {...} | null,              // attributes put() right after start()
//     "ops": [["put", ["k", 1]], ...],
//     "save": true,
//     "lifetime": 120,                   // cookie mode (minutes)
//     "request_cookie": {"name":..,"value":..} | null   // cookie mode: incoming cookie
//   }
//
// Output (stdout JSON):
//   {
//     "results": [{ "all": <json_encode(Store::all())>, "id": ..., "token": ...,
//                   "started": bool, "has_ret": bool, "ret": <json_encode(ret)> }, ...],
//     "all": ..., "id": ..., "token": ...,
//     "queue": [cookieOut...],           // cookie mode
//     "payload": "...", "written_id": "...", "destroyed_ids": [...],  // store mode
//     "writes_count": N
//   }

$input = json_decode((string) stream_get_contents(STDIN), true);

if (!is_array($input)) {
    fwrite(STDERR, "php-session-oracle: invalid JSON input\n");
    exit(2);
}

$appRoot = $input['app_root'] ?? (getenv('LW_LARAVEL_APP') ?: null);

if (!is_string($appRoot) || !is_file($appRoot . '/vendor/autoload.php')) {
    fwrite(STDERR, "php-session-oracle: pass \"app_root\" or set LW_LARAVEL_APP to a Laravel app (vendor/autoload.php required)\n");
    exit(2);
}

require $appRoot . '/vendor/autoload.php';

use Illuminate\Cookie\CookieJar;
use Illuminate\Session\CookieSessionHandler;
use Illuminate\Session\Store;
use Symfony\Component\HttpFoundation\Cookie;
use Symfony\Component\HttpFoundation\Request;

class LWRecordingSessionHandler implements SessionHandlerInterface
{
    public string $readData = '';

    public array $writes = [];

    public function open(string $path, string $name): bool
    {
        return true;
    }

    public function close(): bool
    {
        return true;
    }

    public function read(string $id): string|false
    {
        return $this->readData;
    }

    public function write(string $id, string $data): bool
    {
        $this->writes[] = ['write', $id, $data];

        return true;
    }

    public function destroy(string $id): bool
    {
        $this->writes[] = ['destroy', $id];

        return true;
    }

    public function gc(int $max_lifetime): int|false
    {
        return 0;
    }
}

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
        'header' => (string) $c,
    ];
}

$mode          = $input['mode'] ?? 'store';
$serialization = $input['serialization'] ?? 'json';
$sessionName   = $input['name'] ?? 'laravel_session';
$id            = $input['id'] ?? null;

$recorder = new LWRecordingSessionHandler();
$recorder->readData = $input['seed_handler_data'] ?? '';
$jar = null;

if ($mode === 'cookie') {
    $jar = new CookieJar();
    $handler = new CookieSessionHandler($jar, (int) ($input['lifetime'] ?? 120), false);

    $requestCookie = $input['request_cookie'] ?? null;

    // The real app always has a Request; without one CookieSessionHandler::read()
    // would fatal on null->cookies.
    $request = new Request([], [], [], is_array($requestCookie) && isset($requestCookie['name'])
        ? [$requestCookie['name'] => $requestCookie['value'] ?? '']
        : []);

    $handler->setRequest($request);

    $store = new Store($sessionName, $handler, $id, $serialization);
} else {
    $store = new Store($sessionName, $recorder, $id, $serialization);
}

$store->start();

if (!empty($input['seed'])) {
    $store->put($input['seed']);
}

$results = [];

foreach ($input['ops'] ?? [] as $step) {
    if (!is_array($step) || $step === []) {
        fwrite(STDERR, "php-session-oracle: malformed op\n");
        exit(2);
    }

    $op = array_shift($step);
    $args = $step;
    $hasRet = true;
    $ret = null;

    switch ($op) {
        case 'get':              $ret = $store->get(...$args); break;
        case 'put':              $store->put(...$args); $hasRet = false; break;
        case 'putAll':           $store->put($args[0]); $hasRet = false; break;
        case 'pull':             $ret = $store->pull(...$args); break;
        case 'remove':           $ret = $store->remove(...$args); break;
        case 'push':             $store->push(...$args); $hasRet = false; break;
        case 'increment':        $ret = $store->increment(...$args); break;
        case 'decrement':        $ret = $store->decrement(...$args); break;
        case 'flash':            $store->flash(...$args); $hasRet = false; break;
        case 'now':              $store->now(...$args); $hasRet = false; break;
        case 'reflash':          $store->reflash(); $hasRet = false; break;
        case 'keep':             $store->keep(...$args); $hasRet = false; break;
        case 'ageFlashData':     $store->ageFlashData(); $hasRet = false; break;
        case 'flashInput':       $store->flashInput($args[0]); $hasRet = false; break;
        case 'forget':           $store->forget($args[0]); $hasRet = false; break;
        case 'flush':            $store->flush(); $hasRet = false; break;
        case 'replace':          $store->replace($args[0]); $hasRet = false; break;
        case 'has':              $ret = $store->has(...$args); break;
        case 'exists':           $ret = $store->exists(...$args); break;
        case 'missing':          $ret = $store->missing(...$args); break;
        case 'hasAny':           $ret = $store->hasAny(...$args); break;
        case 'only':             $ret = $store->only($args[0]); break;
        case 'except':           $ret = $store->except($args[0]); break;
        case 'hasOldInput':      $ret = $store->hasOldInput(...$args); break;
        case 'getOldInput':      $ret = $store->getOldInput(...$args); break;
        case 'token':            $ret = $store->token(); break;
        case 'regenerateToken':  $store->regenerateToken(); $hasRet = false; break;
        case 'getId':            $ret = $store->getId(); break;
        case 'setId':            $store->setId($args[0]); $hasRet = false; break;
        case 'regenerate':       $ret = $store->regenerate(...$args); break;
        case 'migrate':          $ret = $store->migrate(...$args); break;
        case 'invalidate':       $ret = $store->invalidate(); break;
        case 'setPreviousUrl':   $store->setPreviousUrl($args[0]); $hasRet = false; break;
        case 'setPreviousRoute': $store->setPreviousRoute($args[0]); $hasRet = false; break;
        case 'previousUrl':      $ret = $store->previousUrl(); break;
        case 'previousRoute':    $ret = $store->previousRoute(); break;
        default:
            fwrite(STDERR, "php-session-oracle: unknown op {$op}\n");
            exit(2);
    }

    $results[] = [
        'all' => json_encode($store->all()),
        'id' => $store->getId(),
        'token' => $store->token(),
        'started' => $store->isStarted(),
        'has_ret' => $hasRet,
        'ret' => json_encode($ret),
    ];
}

if ($input['save'] ?? true) {
    $store->save();
}

$queue = [];
$payload = null;
$writtenId = null;
$destroyedIds = [];

if ($mode === 'cookie') {
    $queue = array_map('lwCookieOut', $jar->getQueuedCookies());
} else {
    foreach ($recorder->writes as $w) {
        if ($w[0] === 'destroy') {
            $destroyedIds[] = $w[1];

            continue;
        }

        $writtenId = $w[1];
        $payload = $w[2];
    }
}

echo json_encode([
    'results' => $results,
    'all' => json_encode($store->all()),
    'id' => $store->getId(),
    'token' => $store->token(),
    'queue' => $queue,
    'payload' => $payload,
    'written_id' => $writtenId,
    'destroyed_ids' => $destroyedIds,
    'writes_count' => count($recorder->writes),
]), "\n";
