<?php

// Prerender a page with the real Laravel app — the boot happens HERE, at build time.
// Usage: php edge/tools/prerender.php /
// Output: JSON {"status":N,"content_type":"...","location":"...","body":"..."} on stdout.
//   - body is included only for 2xx
//   - location is included only for 3xx

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

require lw_vendor_autoload();

$app = require $root . '/bootstrap/app.php';

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);

$uri = $argv[1] ?? '/';

$request = Illuminate\Http\Request::create($uri, 'GET');

// The framework's error renderers can echo to stdout directly (they are written
// for CLI/fatal crashes). Buffer everything so the only thing the build ever sees
// on stdout is the single JSON payload.
ob_start();

try {
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
} catch (Throwable $e) {
    // The app threw while serving the page (e.g. a controller hitting a table that
    // does not exist at build time). Report a 500 + the error so the build treats
    // the route as "needs a port" and --strict stays blocked until it is handled.
    $payload = [
        'status' => 500,
        'content_type' => 'text/plain',
        'error' => get_class($e) . ': ' . $e->getMessage(),
    ];
} finally {
    ob_end_clean();
}

echo "\n---LW-PRERENDER-JSON---\n";
echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
