<?php

// tools/controller-oracle.php — build-time JSON oracle for @lw-precompute methods.
//
// Usage: php controller-oracle.php <laravel-app-path> <Fqcn@method>
// Stdout: {"status":200,"headers":{...},"body":"<raw response body>","json":<decoded body>}
//
// The method is invoked on the REAL Laravel app (the same boot the build uses
// for config-dump/prerender), through the router's own toResponse() conversion.
// No digest is hand-written here: the PHP controller's own logic produces the
// bytes, and build.mjs fails when those bytes differ from the checked-in fixture.

require_once __DIR__ . '/_root.php';

$appPath = $argv[1] ?? null;
$target = $argv[2] ?? null;
if (!$appPath || !$target || !preg_match('/^([A-Za-z_][A-Za-z0-9_\\\\]*)@([A-Za-z_][A-Za-z0-9_]*)$/', $target, $m)) {
    fwrite(STDERR, "usage: php controller-oracle.php <laravel-app-path> <Fqcn@method>\n");
    exit(2);
}

$fqcn = $m[1];
$methodName = $m[2];

try {
    $app = lw_boot_app($appPath);

    // The HTTP kernel boot registers providers/middleware and binds a canonical
    // request before the controller runs, exactly as a live GET would.
    $kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
    $request = Illuminate\Http\Request::create('/', 'GET');
    $app->instance('request', $request);
    Illuminate\Support\Facades\Facade::clearResolvedInstance('request');
    $kernel->bootstrap();

    if (!class_exists($fqcn)) {
        throw new RuntimeException("controller class not found: {$fqcn}");
    }
    $controller = $app->make($fqcn);
    $reflection = new ReflectionMethod($controller, $methodName);
    if (!$reflection->isPublic()) {
        throw new RuntimeException("{$fqcn}@{$methodName} is not public");
    }
    if ($reflection->getNumberOfRequiredParameters() !== 0) {
        throw new RuntimeException(
            "{$fqcn}@{$methodName} requires arguments; @lw-precompute only supports zero-argument methods"
        );
    }
    $result = $reflection->invoke($controller);
    $response = Illuminate\Routing\Router::toResponse($request, $result);
    if (!$response instanceof Symfony\Component\HttpFoundation\Response) {
        throw new RuntimeException('controller did not produce an HTTP response');
    }
    $body = (string) $response->getContent();
    $decoded = json_decode($body, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        throw new RuntimeException('controller response is not JSON: ' . json_last_error_msg());
    }
    // Only deterministic headers are baked: Symfony adds a volatile `date`
    // to every response, which would make a checked-in fixture stale on every
    // build. The JSON body and these two headers are the observable contract.
    $headers = [];
    foreach (['cache-control', 'content-type'] as $name) {
        $value = $response->headers->get($name);
        if ($value !== null) $headers[$name] = $value;
    }
    echo json_encode(
        [
            'status' => $response->getStatusCode(),
            'headers' => $headers,
            'body' => $body,
            'json' => $decoded,
        ],
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit(0);
} catch (Throwable $e) {
    fwrite(STDERR, 'controller-oracle: ' . get_class($e) . ': ' . $e->getMessage() . "\n");
    exit(1);
}
