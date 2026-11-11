<?php

// Shared app-root resolver for the build-time PHP tools.
// Works in both layouts:
//   - npm:    <app>/node_modules/laravel-workers/tools/
//   - legacy: <app>/edge/tools/
// Resolution order: LW_APP_ROOT env (set by build.mjs/bin) -> cwd -> walk-up -> legacy dirname.
//
// LW_VENDOR_DIR decouples "which app" from "which autoloader". A fresh clone has
// no vendor/ but is still a valid Laravel app; with LW_VENDOR_DIR pointing at a
// vendor-lite cache (tools/vendor-lite.mjs) the build can boot it without ever
// running `composer install` in the checkout.

/** Is this directory a Laravel app root? (artisan + bootstrap/app.php) */
function lw_is_app(string $d): bool
{
    return is_file($d . '/artisan') && is_file($d . '/bootstrap/app.php');
}

/** Is a vendor autoloader reachable here (own vendor/ or the override)? */
function lw_has_vendor(string $d): bool
{
    if (is_file($d . '/vendor/autoload.php')) {
        return true;
    }
    $v = getenv('LW_VENDOR_DIR');

    return is_string($v) && $v !== '';
}

function lw_app_root(): string
{
    $env = getenv('LW_APP_ROOT');
    if (is_string($env) && $env !== '') {
        $env = rtrim($env, "/\\");
        if (lw_is_app($env) && lw_has_vendor($env)) {
            return $env;
        }
    }

    $cwd = getcwd();
    if ($cwd !== false && lw_is_app($cwd) && lw_has_vendor($cwd)) {
        return $cwd;
    }

    $dir = __DIR__;
    for ($i = 0; $i < 8; $i++) {
        $dir = dirname($dir);
        if (lw_is_app($dir) && lw_has_vendor($dir)) {
            return $dir;
        }
    }

    $legacy = dirname(__DIR__, 2);
    if (is_file($legacy . '/vendor/autoload.php')) {
        return $legacy;
    }

    fwrite(STDERR, "laravel-workers: cannot locate the Laravel app root.\n");
    fwrite(STDERR, "  Looked for artisan + bootstrap/app.php (and an autoloader) from cwd upward.\n");
    fwrite(STDERR, "  Run this from your Laravel app root, or set LW_APP_ROOT=/path/to/laravel.\n");
    exit(2);
}

/**
 * The autoloader every tool requires.
 *
 * LW_VENDOR_DIR may point at a vendor directory (`<v>/autoload.php`) or at a
 * project directory that contains one (`<v>/vendor/autoload.php`) - both spellings
 * appear in the wild, and guessing wrong is a fatal require.
 */
function lw_vendor_autoload_for(string $appRoot): string
{
    $v = getenv('LW_VENDOR_DIR');
    if (is_string($v) && $v !== '') {
        $base = rtrim($v, "/\\");
        foreach ([$base . '/autoload.php', $base . '/vendor/autoload.php'] as $cand) {
            if (is_file($cand)) {
                return $cand;
            }
        }
        fwrite(STDERR, "laravel-workers: LW_VENDOR_DIR=\"{$v}\" has no autoload.php.\n");
        exit(2);
    }

    $own = rtrim($appRoot, "/\\") . '/vendor/autoload.php';
    if (!is_file($own)) {
        fwrite(STDERR, "laravel-workers: {$own} is missing - run `npx laravel-workers vendor:ensure` in {$appRoot}, or set LW_VENDOR_DIR.\n");
        exit(2);
    }

    return $own;
}

function lw_vendor_autoload(): string
{
    return lw_vendor_autoload_for(lw_app_root());
}

/**
 * Require the resolved autoloader, register the checkout's App\ namespace on it,
 * and boot the app. Used by every tool that needs the full Laravel app (it
 * replaces the previous two-liner: `require lw_vendor_autoload(); $app =
 * require .../bootstrap/app.php`).
 *
 * Why register App\ separately? An LW_VENDOR_DIR points at a vendor-lite cache
 * whose vendor/ only contains packages — the cache has no app/ directory, so the
 * composer-generated autoloader never maps App\* classes. Without this line every
 * `$app->make(...\Kernel::class)` fails. The cache stays pristine; the mapping is
 * registered at boot time from the checkout.
 */
function lw_boot_app(?string $root = null)
{
    $root = $root ?? lw_app_root();
    // Generate and inject APP_KEY if missing. The app cannot boot without a valid
    // key. Setting it in $_ENV / $_SERVER makes `config('app.key')` pick it up
    // at boot time — no need to write the .env file, which keeps the checkout clean.
    // FIXED: putenv('APP_KEY') with no '=' UNSETS the variable and returns true,
    // so `! putenv('APP_KEY')` was never true and no key was ever injected — a
    // checkout without .env then died with MissingAppKeyException. getenv()
    // returns false exactly when the variable is absent.
    if (getenv('APP_KEY') === false || getenv('APP_KEY') === '') {
        $key = 'base64:' . base64_encode(random_bytes(32));
        $_ENV['APP_KEY'] = $key;
        $_SERVER['APP_KEY'] = $key;
        putenv('APP_KEY=' . $key);
    }

    // Vendor-lite provisions a cache OUTSIDE the checkout and Laravel's package
    // auto-discovery reads exactly `<composer vendor dir>/composer/installed.json`
    // (`Illuminate\Foundation\PackageManifest`: `Env::get('COMPOSER_VENDOR_DIR')
    // ?: base_path('vendor')`). Without this line the manifest is built from the
    // app's own absent vendor/ — empty — so EVERY auto-discovered package
    // provider (and its aliases/config/migrations/routes) stays unregistered and
    // the build boots a different application than `php artisan` does: measured
    // 5-37 providers per pilot app. vendor-lite writes that file itself
    // (installedJsonOf() in tools/vendor-lite.mjs); here we point Laravel at it.
    // Only set when LW_VENDOR_DIR is in play, so an app with its own vendor/ is untouched.
    if (!getenv('COMPOSER_VENDOR_DIR')) {
        $lwVendor = getenv('LW_VENDOR_DIR');
        if (is_string($lwVendor) && $lwVendor !== '') {
            $base = rtrim($lwVendor, "/\\");
            if (is_file($base . '/autoload.php')) {
                $base = dirname($base); // LW_VENDOR_DIR pointed straight at vendor/
            }
            $cand = $base . '/vendor';
            if (is_dir($cand)) {
                $_ENV['COMPOSER_VENDOR_DIR'] = $cand;
                $_SERVER['COMPOSER_VENDOR_DIR'] = $cand;
                putenv('COMPOSER_VENDOR_DIR=' . $cand);
            }
        }
    }

    require lw_vendor_autoload_for($root);
    spl_autoload_register(function (string $class) use ($root): void {
        $prefix = 'App\\';
        if (strpos($class, $prefix) !== 0) { return; }
        $rel = str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        // The composer-generated autoloader maps App\* only when the app has its
        // own vendor/. With a vendor-lite cache it does not, so the checkout's
        // mapping is registered here (see the docblock above). Read it from
        // composer.json instead of assuming `app/`: a project may map `App\` to
        // a different directory (`"psr-4": {"App\\": "src/"}`), or to several
        // ones (an array, tried in order - composer's own behaviour).
        foreach (lw_app_psr4_dirs($root) as $dir) {
            $file = $dir . '/' . $rel;
            if (is_file($file)) { require $file; return; }
        }
    });

    return require $root . '/bootstrap/app.php';
}

/**
 * The directories composer maps the `App\` prefix to, as absolute paths, in the
 * order composer declares them. Falls back to `<root>/app` (the skeleton's
 * mapping) when composer.json is absent, unreadable, or declares no `App\`
 * prefix under psr-4.
 */
function lw_app_psr4_dirs(string $root): array
{
    static $cache = [];
    $key = rtrim($root, '/\\');
    if (isset($cache[$key])) { return $cache[$key]; }

    $dirs = [];
    $composerJson = $key . '/composer.json';
    if (is_file($composerJson)) {
        $decoded = json_decode((string) file_get_contents($composerJson), true);
        $map = is_array($decoded) && isset($decoded['autoload']['psr-4']) && is_array($decoded['autoload']['psr-4'])
            ? $decoded['autoload']['psr-4']
            : [];
        // The prefix is spelled "App\\" in JSON (a trailing backslash is escaped);
        // accept the unescaped spelling too for a hand-written file.
        foreach (['App\\', 'App'] as $prefix) {
            if (!array_key_exists($prefix, $map)) { continue; }
            foreach ((array) $map[$prefix] as $dir) {
                if (!is_string($dir) || $dir === '') { continue; }
                $abs = rtrim($key . '/' . trim(str_replace('\\', '/', $dir), '/'), '/');
                if (!in_array($abs, $dirs, true)) { $dirs[] = $abs; }
            }
        }
    }

    if (!$dirs) { $dirs[] = $key . '/app'; }
    return $cache[$key] = $dirs;
}

// ---------------------------------------------------------------------------
// The prelude every PHP oracle in tools/ shares.
//
// Each `php-*-oracle.php` reads one JSON request on stdin, resolves the Laravel
// app root it must boot, and (when the request asks for it) freezes the clock.
// Those three steps were copy-pasted into every oracle and had drifted: the same
// malformed-JSON condition answered "invalid JSON input" with exit 2 in one file
// and "bad input json" with exit 1 in another. One spelling each.
// ---------------------------------------------------------------------------

/** The JSON request on stdin, or a loud exit naming the tool. */
function lw_oracle_input(string $tool): array
{
    $decoded = json_decode((string) stream_get_contents(STDIN), true);
    if (!is_array($decoded)) {
        fwrite(STDERR, "{$tool}: invalid JSON input\n");
        exit(2);
    }

    return $decoded;
}

/**
 * The Laravel app root an oracle must boot: `app_root` from the request, else
 * LW_LARAVEL_APP. Validated, because every oracle boots the real framework and a
 * wrong root would otherwise fail somewhere deep inside Laravel.
 */
function lw_oracle_root(string $tool, array $input): string
{
    $root = $input['app_root'] ?? (getenv('LW_LARAVEL_APP') ?: null);
    $root = is_string($root) ? rtrim($root, "/\\") : '';
    if ($root === '' || !is_file($root . '/bootstrap/app.php') || !lw_has_vendor($root)) {
        fwrite(STDERR, "{$tool}: pass \"app_root\" or set LW_LARAVEL_APP to a Laravel app (a Laravel app root with an autoloader - set LW_VENDOR_DIR to reuse one)\n");
        exit(2);
    }

    return $root;
}

/**
 * Carbon::setTestNow() for a request carrying `freeze_ms`, so a parity run can
 * assert exact expiries. A no-op when the request carries no freeze.
 */
function lw_oracle_freeze(array $input): void
{
    if (isset($input['freeze_ms'])) {
        \Carbon\Carbon::setTestNow(\Carbon\Carbon::createFromTimestamp(((int) $input['freeze_ms']) / 1000));
    }
}
