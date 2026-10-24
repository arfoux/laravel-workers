<?php

// tools/routes-dump.php — the app's route table, as JSON. Build time only.
// Usage: php tools/routes-dump.php
// Output (stdout): the same JSON `php artisan route:list --json` prints.
//
// Why not call `artisan` directly? The app's own `artisan` file hardcodes
// `require __DIR__.'/vendor/autoload.php'`, so it can only ever run against the
// checkout's own vendor/. The build must also work when the autoloader comes
// from elsewhere (LW_VENDOR_DIR - the vendor-lite cache, a fresh clone with no
// vendor/), so it boots the console kernel itself, through the overridable
// autoloader, and asks Artisan for the same command.

require_once __DIR__ . '/_root.php';

$root = lw_app_root();
require lw_vendor_autoload();

$app = require $root . '/bootstrap/app.php';

$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();

$status = Illuminate\Support\Facades\Artisan::call('route:list', ['--json' => true]);
if ($status !== 0) {
    fwrite(STDERR, "route:list --json exited {$status}\n");
    exit($status === 0 ? 1 : $status);
}

echo Illuminate\Support\Facades\Artisan::output();
