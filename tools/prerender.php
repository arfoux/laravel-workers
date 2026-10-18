<?php

// Prerender a page with the real Laravel app — the boot happens HERE, at build time.
// Usage: php edge/tools/prerender.php /
// Output: JSON {"status":N,"content_type":"...","location":"...","body":"..."} on stdout.
//   - body is included only for 2xx
//   - location is included only for 3xx

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

require $root . '/vendor/autoload.php';

$app = require $root . '/bootstrap/app.php';

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);

$uri = $argv[1] ?? '/';

$request = Illuminate\Http\Request::create($uri, 'GET');

$response = $kernel->handle($request);

$kernel->terminate($request, $response);

$status = $response->getStatusCode();

$payload = [
    'status' => $status,
    'content_type' => (string) $response->headers->get('Content-Type'),
];

if ($status >= 300 && $status < 400) {
    $payload['location'] = (string) $response->headers->get('Location');
}

if ($status >= 200 && $status < 300) {
    $payload['body'] = $response->getContent();
}

echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
