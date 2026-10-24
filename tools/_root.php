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
        fwrite(STDERR, "laravel-workers: {$own} is missing - run `composer install --no-dev` in {$appRoot}, or set LW_VENDOR_DIR.\n");
        exit(2);
    }

    return $own;
}

function lw_vendor_autoload(): string
{
    return lw_vendor_autoload_for(lw_app_root());
}
