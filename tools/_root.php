<?php

// Shared app-root resolver for the build-time PHP tools.
// Works in both layouts:
//   - npm:    <app>/node_modules/laravel-workers/tools/
//   - legacy: <app>/edge/tools/
// Resolution order: LW_APP_ROOT env (set by build.mjs/bin) → cwd → walk-up → legacy dirname.

function lw_app_root(): string
{
    $env = getenv('LW_APP_ROOT');
    if (is_string($env) && $env !== '' && is_file(rtrim($env, "/\\") . '/vendor/autoload.php')) {
        return rtrim($env, "/\\");
    }

    $cwd = getcwd();
    if ($cwd !== false && is_file($cwd . '/vendor/autoload.php') && is_file($cwd . '/artisan')) {
        return $cwd;
    }

    $dir = __DIR__;
    for ($i = 0; $i < 8; $i++) {
        $dir = dirname($dir);
        if (is_file($dir . '/vendor/autoload.php') && is_file($dir . '/artisan')) {
            return $dir;
        }
    }

    $legacy = dirname(__DIR__, 2);
    if (is_file($legacy . '/vendor/autoload.php')) {
        return $legacy;
    }

    fwrite(STDERR, "laravel-workers: cannot locate the Laravel app root (no vendor/autoload.php + artisan found).\n");
    fwrite(STDERR, "Run this from your Laravel app root, or set LW_APP_ROOT=/path/to/laravel.\n");
    exit(2);
}
