<?php

// Dump public class constants for the edge build — build time only.
// Usage: php tools/constants-dump.php "App\\Providers\\RouteServiceProvider" [...]
// Output (stdout): JSON array of {fqcn, constants: {NAME: value}, error}

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

require $root . '/vendor/autoload.php';

$app = require $root . '/bootstrap/app.php';

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$request = Illuminate\Http\Request::create('/', 'GET');
$response = $kernel->handle($request);
$kernel->terminate($request, $response);

$out = [];

foreach (array_slice($argv, 1) as $fqcn) {
    $entry = [
        'fqcn' => $fqcn,
        'constants' => [],
        'error' => null,
    ];

    try {
        if (!class_exists($fqcn)) {
            $entry['error'] = 'class not found';
            $out[] = $entry;
            continue;
        }
        $rc = new ReflectionClass($fqcn);
        $consts = $rc->getConstants();
        foreach ($consts as $name => $value) {
            if (is_scalar($value) || $value === null) {
                $entry['constants'][$name] = $value;
            }
        }
    } catch (Throwable $e) {
        $entry['error'] = get_class($e) . ': ' . $e->getMessage();
    }

    $out[] = $entry;
}

echo json_encode($out);
