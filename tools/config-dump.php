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
// env('APP_ENV') / env('APP_DEBUG') - the build-time dump is the padanan
// for env() at the edge (there is no .env there).
$put('app.env', $config->get('app.env'));
$put('app.debug', $config->get('app.debug'));

// ---------- pagination ----------
// The pagination view the paginator renders (Laravel's default:
// `pagination::tailwind`; an app can change it with Paginator::defaultView()).
$put('pagination.view', Illuminate\Pagination\AbstractPaginator::$defaultView);

// ---------- translations ----------
// The strings the views use (__()). The framework's fallback first, then the
// app's lang/ files (the app's win), per locale and per group.
$langPaths = [];
$frameworkLang = $root . '/vendor/laravel/framework/src/Illuminate/Translation/lang';
if (is_dir($frameworkLang)) {
    $langPaths[] = $frameworkLang;
}
if (function_exists('lang_path') && is_dir(lang_path())) {
    $langPaths[] = lang_path();
}
$translations = [];
foreach ($langPaths as $langPath) {
    foreach (glob($langPath . '/*', GLOB_ONLYDIR) ?: [] as $localeDir) {
        $locale = basename($localeDir);
        foreach (glob($localeDir . '/*.php') ?: [] as $file) {
            $group = basename($file, '.php');
            $values = require $file;
            if (!is_array($values)) {
                continue;
            }
            $translations[$locale][$group] = array_replace_recursive(
                $translations[$locale][$group] ?? [],
                $values
            );
        }
    }
}
$put('translations', $translations);

// ---------- errors ----------
// The method-not-allowed answer: Laravel renders the errors/405 view when the
// app has one (resources/views/errors/405.blade.php); without it the
// framework's error renderer answers 500 (the Symfony error page). The
// compiled side answers the same status.
$has405 = false;
foreach ((array) $config->get('view.paths') as $viewPath) {
    if (is_file($viewPath . '/errors/405.blade.php')) {
        $has405 = true;
        break;
    }
}
$put('errors.405_view', $has405);

// ---------- cors ----------
// The CORS paths (HandleCors): the compiled worker does not add the CORS
// headers, so the build skips the routes under those paths (the build tells
// the user what to do).
$corsPaths = $config->get('cors.paths', []);
if (!is_array($corsPaths)) {
    $corsPaths = [];
}
$put('cors.paths', $corsPaths);

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

// ---------- cache (the `database` driver compiled to D1) ----------
// The compiled rung supports exactly one cache driver: `database`, backed by the
// D1 binding. build.mjs refuses to compile `throttle` routes unless this resolves
// to `database` (see the cache audit there).
$defaultCache = $config->get('cache.default');
$cacheStore = is_array($defaultCache) ? $defaultCache : $config->get('cache.stores.' . $defaultCache, []);
$put('cache.default', is_array($defaultCache) ? 'database' : $defaultCache);
$put('cache.prefix', $config->get('cache.prefix'));
$put('cache.driver', $cacheStore['driver'] ?? null);
$put('cache.table', $cacheStore['table'] ?? 'cache');
$put('cache.lock_table', $cacheStore['lock_table'] ?? 'cache_locks');
$put('cache.serializable_classes', $config->get('cache.serializable_classes') ?? null);
// The mailer the worker builds: `log` (default, no network), `noop` or `resend`.
$put('mail.driver', $config->get('mail.default'));
$put('mail.from.address', $config->get('mail.from.address'));

// ---------- filesystems (the object store) ----------
// The compiled rung has ONE object store: the padanan for the app's default
// disk (R2 when the app binds it, else the D1 blob store). The build needs the
// default disk's name to compile `Storage::disk('x')` exactly (and to fail
// loud for a disk that would need a bucket of its own).
$defaultDisk = $config->get('filesystems.default');
$put('filesystems.default', $defaultDisk);
$put('filesystems.disks', array_values(array_keys((array) ($config->get('filesystems.disks') ?: []))));
foreach ((array) ($config->get('filesystems.disks') ?: []) as $name => $disk) {
    $put('filesystems.disks.' . $name . '.driver', is_array($disk) ? ($disk['driver'] ?? null) : null);
}

echo json_encode($dump, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
