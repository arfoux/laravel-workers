<?php

// Prerender a page with the real Laravel app — the boot happens HERE, at build time.
// Usage: php tools/prerender.php <uri...>   (Track E: every URI in ONE boot)
//        php tools/prerender.php --error 404
// Output: JSON [{uri, status, content_type, location?, body?, error?}...] on stdout.
//   - body is included only for 2xx
//   - location is included only for 3xx
//
// `--error 404` renders the page the framework answers a request that reaches no
// route with, so the build can write it to public/404.html: the ASSETS layer serves
// that file for any path outside `_routes.json` once the app sets
// `assets.not_found_handling: "404-page"` (docs/EVIDENCE.md finding 2). Unlike a URI,
// it never goes through the router, so no route of the app can capture the request
// the page is rendered for. Only 404 is rendered — public/404.html is the one page the
// asset router serves, so any other status would be dead weight.

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

$app = lw_boot_app();

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
// Boot the full bootstrap pipeline (LoadEnvironmentVariables, LoadConfiguration,
// RegisterProviders, BootProviders…) — without it the container lacks the
// `config` binding and every prerender 500s with BindingResolutionException.
// The request is bound BEFORE the bootstrap, in the order Laravel's own kernel
// uses it (Kernel::handle(): instance('request') -> Facade::clearResolvedInstance
// -> bootstrap()). Boot straight away and a provider that resolves `url` while
// booting builds the URL generator from the request the container holds RIGHT
// NOW: Laravel 13 passes `$app->rebinding('request', ...)` there
// (RoutingServiceProvider.php:63), so an unbound request arrives as NULL -
//   TypeError: UrlGenerator::__construct(): Argument #2 ($request) must be of
//   type Illuminate\Http\Request, null given
// and the build dies before it renders anything. Found on BookStack, whose
// AppServiceProvider::boot() calls URL::forceRootUrl(). The loop below rebinds
// the real request per URI through $kernel->handle(), exactly like Laravel.
//
// `--error` is a MODE, not a path: without this check the flag itself would be
// bound as the path the app boots with (`Request::create('--error')`).
$errorMode = ($argv[1] ?? '') === '--error';
$bootUri = $errorMode ? '/' : ($argv[1] ?? '/');
$app->instance('request', Illuminate\Http\Request::create($bootUri, 'GET'));
Illuminate\Support\Facades\Facade::clearResolvedInstance('request');
$kernel->bootstrap();

if ($errorMode) {
    $status = (int) ($argv[2] ?? 0);
    if ($status !== 404) {
        fwrite(STDERR, "prerender.php --error: only 404 is rendered (public/404.html is the one page the asset router serves), got {$argv[2]}\n");
        exit(2);
    }

    // The page renders for NO path in particular: the asset layer answers every
    // unmatched path with this one file, so `GET /` is the least surprising request
    // to render it with. An error view that prints the request path therefore bakes
    // that `/` — the build log and docs/COMPILED.md say so.
    $request = Illuminate\Http\Request::create('/', 'GET');
    $handler = $app->make(Illuminate\Contracts\Debug\ExceptionHandler::class);

    // Laravel renders an error page into the PHP output buffer in a CLI boot, not
    // into the response body. The shadow oracle measured the same thing for its 405
    // and 500 ("the buffer is the body when the response carries none",
    // tools/php-shadow-oracle.php), so the buffer is kept and used as the body when
    // the response carries none of its own — `ob_end_clean()` here would ship an
    // empty 404.html.
    ob_start();
    try {
        $response = $handler->render($request, new Symfony\Component\HttpKernel\Exception\NotFoundHttpException());
    } catch (Throwable $e) {
        ob_end_clean();
        echo "\n---LW-PRERENDER-JSON---\n";
        echo json_encode([[
            'uri' => '/',
            'status' => 500,
            'content_type' => 'text/plain',
            'error' => get_class($e) . ': ' . $e->getMessage(),
        ]], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        exit(0);
    }
    $echoed = ob_get_clean();

    $body = (string) $response->getContent();
    if ($body === '' && $echoed !== '') {
        $body = $echoed;
    }

    echo "\n---LW-PRERENDER-JSON---\n";
    echo json_encode([[
        'uri' => '/',
        'status' => $response->getStatusCode(),
        'content_type' => (string) $response->headers->get('Content-Type'),
        'body' => $body,
    ]], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit(0);
}

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

    // One boot renders every URI (Track E), but a real worker request boots a
    // FRESH application. The Vite singleton is stateful across renders:
    // `Vite::fonts()` records each font it preloads in `$preloadedAssets`
    // (Illuminate/Foundation/Vite.php:1144) and dedupes later calls against it,
    // so the SECOND page rendered in this process loses every `<link
    // rel="preload" as="font">` the first one already emitted (measured with
    // nearFind: `/masuk` kept its 3 font preloads, `/` — rendered after it in
    // the same batch — kept none, so the edge's snapshot HTML diverged from a
    // live PHP render). `Vite::__invoke()` also dedupes `<link>` tags through
    // the same map. Drop the resolved singleton before each request so every
    // page renders from a clean instance, exactly like a fresh boot.
    if (class_exists(Illuminate\Foundation\Vite::class)) {
        $app->forgetInstance(Illuminate\Foundation\Vite::class);
    }

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
