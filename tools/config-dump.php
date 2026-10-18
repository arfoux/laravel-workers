<?php

// Dump the runtime config the compiled HTTP kernel needs — build time only.
// Usage: php tools/config-dump.php
// Output (stdout): JSON object with FLAT DOTTED keys (the shape kernel/auth.mjs
// and kernel/http.mjs read, e.g. 'auth.defaults.guard', 'session.driver').
//
// The app is booted through the HTTP kernel first so bootstrap/app.php's
// ->withMiddleware(...) callbacks run and their static state (CSRF / cookie
// except lists, origin-only flags) is populated exactly as a live request
// would see it.

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

require $root . '/vendor/autoload.php';

$app = require $root . '/bootstrap/app.php';

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$request = Illuminate\Http\Request::create('/', 'GET');
$response = $kernel->handle($request);
$kernel->terminate($request, $response);

/** Read a protected/private STATIC property off a class (build-time reflection). */
function lw_static(string $class, string $prop)
{
    if (!class_exists($class)) {
        throw new RuntimeException("missing class {$class}");
    }
    $rc = new ReflectionClass($class);
    if (!$rc->hasProperty($prop)) {
        throw new RuntimeException("missing static \${$prop} on {$class}");
    }
    $rp = $rc->getProperty($prop);
    $rp->setAccessible(true);
    return $rp->getValue();
}

$config = $app['config'];
$dump = [];

$put = function (string $key, $value) use (&$dump) {
    $dump[$key] = $value;
};

// ---------- app ----------
$put('app.key', $config->get('app.key'));
$put('app.url', $config->get('app.url'));
$put('app.cipher', $config->get('app.cipher'));

// ---------- session ----------
foreach ([
    'driver', 'lifetime', 'expire_on_close', 'encrypt', 'serialization',
    'cookie', 'path', 'domain', 'secure', 'http_only', 'same_site',
    'partitioned', 'table', 'connection', 'files', 'lottery',
] as $key) {
    $put('session.' . $key, $config->get('session.' . $key));
}

// ---------- cookies (EncryptCookies) ----------
$put('cookies.except', array_values(lw_static(Illuminate\Cookie\Middleware\EncryptCookies::class, 'neverEncrypt')));
$put('cookies.serialize', (bool) lw_static(Illuminate\Cookie\Middleware\EncryptCookies::class, 'serialize'));

// ---------- csrf (PreventRequestForgery) ----------
$csrf = Illuminate\Foundation\Http\Middleware\PreventRequestForgery::class;
$put('csrf.except', array_values(lw_static($csrf, 'neverVerify')));
$put('csrf.allow_same_site', (bool) lw_static($csrf, 'allowSameSite'));
$put('csrf.origin_only', (bool) lw_static($csrf, 'originOnly'));

// ---------- auth (flat dotted, the shape kernel/auth.mjs reads) ----------
$put('auth.defaults.guard', $config->get('auth.defaults.guard'));
$put('auth.defaults.passwords', $config->get('auth.defaults.passwords'));
$put('auth.defaults.provider', $config->get('auth.defaults.provider'));
foreach (($config->get('auth.guards') ?: []) as $name => $guard) {
    $put('auth.guards.' . $name, $guard);
}
foreach (($config->get('auth.providers') ?: []) as $name => $provider) {
    $put('auth.providers.' . $name, $provider);
}
foreach (($config->get('auth.passwords') ?: []) as $name => $broker) {
    $put('auth.passwords.' . $name, $broker);
}
// SessionGuard::__construct(hashKey:) is wired from config('app.key') verbatim
// (vendor AuthManager::createSessionDriver) — keep the `base64:` prefix.
$put('auth.hash_key', $config->get('app.key'));
$put('auth.timebox_duration', $config->get('auth.timebox_duration', 200000));
$put('auth.rehash_on_login', $config->get('hashing.rehash_on_login', true));

// ---------- hashing ----------
$put('hashing.driver', $config->get('hashing.driver'));
$put('hashing.bcrypt.rounds', $config->get('hashing.bcrypt.rounds'));
$put('hashing.bcrypt.verify', $config->get('hashing.bcrypt.verify'));
$put('hashing.bcrypt.limit', $config->get('hashing.bcrypt.limit'));

echo json_encode($dump, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
