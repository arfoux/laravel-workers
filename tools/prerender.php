<?php

// Prerender a page with the real Laravel app — the boot happens HERE, at build time.
// Usage: php tools/prerender.php <uri...>   (Track E: every URI in ONE boot)
// Output: JSON [{uri, status, content_type, location?, body?, error?}...] on stdout.
//   - body is included only for 2xx
//   - location is included only for 3xx

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

$app = lw_boot_app();

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
// Boot the full bootstrap pipeline (LoadEnvironmentVariables, LoadConfiguration,
// RegisterProviders, BootProviders…) — without it the container lacks the
// `config` binding and every prerender 500s with BindingResolutionException.
$kernel->bootstrap();

// Track E: every URI renders in this ONE boot — one process, one Laravel
// startup, one kernel. argv carries the URIs, in order; output is an array
// aligned by `uri` so the build maps a result back to its route.
$uris = array_slice($argv, 1);
if (!$uris) {
    $uris = ['/'];
}

$payloads = [];
foreach ($uris as $uri) {
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

        // A 5xx rendered inside the kernel (Laravel's error handler caught the
        // exception) still surfaces the throwable here — expose it so the build
        // log explains WHY the route needs a port instead of a bare 500.
        if ($status >= 500 && isset($response->exception)) {
            $payload['error'] = get_class($response->exception) . ': ' . $response->exception->getMessage();
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

    $payloads[] = array_merge(['uri' => $uri], $payload);
}

echo "\n---LW-PRERENDER-JSON---\n";
echo json_encode($payloads, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
