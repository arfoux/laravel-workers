<?php

// tools/php-csrf-oracle.php — PHP 8.3 oracle for kernel/csrf.mjs.
//
// Runs the real Illuminate\Foundation\Http\Middleware\PreventRequestForgery
// (laravel/framework 13.x) against a real Illuminate\Http\Request and a
// recording session Store, plus direct probes for the helpers the middleware
// depends on (Str::is, Symfony Request::normalizeQueryString). Prints every
// observable so kernel/tests/csrf.test.mjs can prove parity:
//   - pass order / exceptions (TokenMismatchException, OriginMismatchException)
//   - XSRF-TOKEN response cookie fields + serialized header
//   - X-XSRF-TOKEN decryption path (the oracle encrypts, JS decrypts the same
//     payload string)
//   - except()/useOriginOnly()/allowSameSite() static behavior
//   - Str::is pattern matching (preg_quote escape set, wildcards, unicode)
//   - normalizeQueryString (HeaderUtils::parseQuery + ksort + http_build_query)
//
// Input (stdin JSON):
//   {
//     "app_root": "...",                    // or env LW_LARAVEL_APP
//     "stris": [{ "pattern": "...", "value": "...", "ignore_case": false }],
//     "qs": ["b=2&a=1", ...],
//     "middleware": {
//       "cases": [{
//         "name": "...",
//         "method": "POST",
//         "uri": "http://localhost/stripe/webhook?x=1",
//         "params": { "_token": "..." },    // form input
//         "headers": { "...": "..." },
//         "session": { "data": {...}, "token": "40-char" | null },
//         "except": ["stripe/*"],
//         "allow_same_site": true,
//         "origin_only": true,
//         "next_status": 200,
//         "next_body": "ok",
//         "x_xsrf": { "mode": "valid"|"wrong_prefix"|"garbage", "value": "..." }
//       }]
//     }
//   }
//
// Output (stdout JSON): { app_key, session_config, stris: [bool], qs: [string],
//   middleware: [{ name, threw: {class,message}|null, status, body,
//   cookies: [cookieOut], should_add_cookie, excluded_paths, session_token,
//   x_xsrf_sent }] }

$input = json_decode((string) stream_get_contents(STDIN), true);

if (!is_array($input)) {
    fwrite(STDERR, "php-csrf-oracle: invalid JSON input\n");
    exit(2);
}

$appRoot = $input['app_root'] ?? (getenv('LW_LARAVEL_APP') ?: null);

if (!is_string($appRoot) || !is_file($appRoot . '/vendor/autoload.php')) {
    fwrite(STDERR, "php-csrf-oracle: pass \"app_root\" or set LW_LARAVEL_APP to a Laravel app (vendor/autoload.php required)\n");
    exit(2);
}

require $appRoot . '/vendor/autoload.php';

use Illuminate\Foundation\Http\Middleware\PreventRequestForgery;
use Illuminate\Http\Request as LaravelRequest;
use Illuminate\Session\Store;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Cookie;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

class LWOrphanSessionHandler implements SessionHandlerInterface
{
    public string $readData = '';

    public function open(string $path, string $name): bool
    {
        return true;
    }

    public function close(): bool
    {
        return true;
    }

    public function read(string $id): string|false
    {
        return $this->readData;
    }

    public function write(string $id, string $data): bool
    {
        return true;
    }

    public function destroy(string $id): bool
    {
        return true;
    }

    public function gc(int $max_lifetime): int|false
    {
        return 0;
    }
}

function lwCsrfCookieOut(Cookie $c): array
{
    $out = [
        'name' => $c->getName(),
        'value' => $c->getValue(),
        'expires' => $c->getExpiresTime(),
        'path' => $c->getPath(),
        'domain' => $c->getDomain(),
        'secure' => $c->isSecure(),
        'http_only' => $c->isHttpOnly(),
        'raw' => $c->isRaw(),
        'same_site' => $c->getSameSite(),
        'header' => (string) $c,
    ];

    if (method_exists($c, 'isPartitioned')) {
        $out['partitioned'] = $c->isPartitioned();
    }

    return $out;
}

$output = [];

// ---------------------------------------------------------------------------
// Str::is vectors.
// ---------------------------------------------------------------------------
if (isset($input['stris'])) {
    $output['stris'] = [];

    foreach ($input['stris'] as $vector) {
        $output['stris'][] = Str::is(
            $vector['pattern'] ?? '',
            $vector['value'] ?? '',
            $vector['ignore_case'] ?? false
        );
    }
}

// ---------------------------------------------------------------------------
// Symfony Request::normalizeQueryString vectors.
// ---------------------------------------------------------------------------
if (isset($input['qs'])) {
    $output['qs'] = [];

    foreach ($input['qs'] as $qs) {
        $output['qs'][] = Request::normalizeQueryString(is_string($qs) ? $qs : null);
    }
}

// ---------------------------------------------------------------------------
// PreventRequestForgery middleware cases.
// ---------------------------------------------------------------------------
if (isset($input['middleware'])) {
    /** @var Illuminate\Foundation\Application $app */
    $app = require $appRoot . '/bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

    $config = $app->make('config')->get('session');
    $encrypter = $app->make('encrypter');

    $output['app_key_base64'] = base64_encode($encrypter->getKey());
    $output['session_config'] = [
        'lifetime' => $config['lifetime'],
        'path' => $config['path'],
        'domain' => $config['domain'],
        'secure' => $config['secure'],
        'same_site' => $config['same_site'] ?? null,
        'partitioned' => $config['partitioned'] ?? false,
    ];
    $output['middleware'] = [];

    foreach ($input['middleware']['cases'] ?? [] as $case) {
        PreventRequestForgery::flushState();

        if (!empty($case['except'])) {
            PreventRequestForgery::except($case['except']);
        }
        if (!empty($case['allow_same_site'])) {
            PreventRequestForgery::allowSameSite();
        }
        if (!empty($case['origin_only'])) {
            PreventRequestForgery::useOriginOnly();
        }

        /** @var PreventRequestForgery $middleware */
        $middleware = $app->make(PreventRequestForgery::class);

        $handler = new LWOrphanSessionHandler();
        $store = new Store($config['cookie'] ?? 'laravel_session', $handler, $case['id'] ?? null);
        $store->start();
        foreach (($case['session']['data'] ?? []) as $key => $value) {
            $store->put($key, $value);
        }
        if (($case['session']['token'] ?? null) !== null) {
            $store->put('_token', $case['session']['token']);
        }

        $request = LaravelRequest::create(
            $case['uri'] ?? 'http://localhost/',
            $case['method'] ?? 'GET',
            $case['params'] ?? []
        );
        $request->setLaravelSession($store);

        foreach (($case['headers'] ?? []) as $name => $value) {
            $request->headers->set($name, $value);
        }

        $result = ['name' => $case['name'] ?? null, 'x_xsrf_sent' => null];

        if (isset($case['x_xsrf'])) {
            $spec = $case['x_xsrf'];
            $mode = $spec['mode'] ?? 'garbage';

            if ($mode === 'valid' || $mode === 'wrong_prefix') {
                $prefix = $mode === 'valid' ? 'XSRF-TOKEN' : 'SESSION';
                $value = $encrypter->encrypt(
                    \Illuminate\Cookie\CookieValuePrefix::create($prefix, $encrypter->getKey())
                        . $store->token(),
                    false
                );
            } else {
                $value = $spec['value'] ?? 'not-a-valid-encrypted-payload!!';
            }

            $request->headers->set('X-XSRF-TOKEN', $value);
            $result['x_xsrf_sent'] = $value;
        }

        try {
            $response = $middleware->handle($request, function ($req) use ($case) {
                return new Response($case['next_body'] ?? 'ok', $case['next_status'] ?? 200);
            });

            $result['threw'] = null;
            $result['status'] = $response->getStatusCode();
            $result['body'] = $response->getContent();
            $result['cookies'] = [];
            foreach ($response->headers->getCookies() as $cookie) {
                $result['cookies'][] = lwCsrfCookieOut($cookie);
            }
        } catch (Throwable $e) {
            $result['threw'] = ['class' => get_class($e), 'message' => $e->getMessage()];
            $result['status'] = null;
            $result['body'] = null;
            $result['cookies'] = null;
        }

        $result['should_add_cookie'] = $middleware->shouldAddXsrfTokenCookie();
        $result['excluded_paths'] = array_values($middleware->getExcludedPaths());
        $result['session_token'] = $request->session()->token();

        $output['middleware'][] = $result;
    }
}

try {
    echo json_encode(
        $output,
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR
    ), "\n";
} catch (JsonException $e) {
    fwrite(STDERR, "php-csrf-oracle: json_encode failed: " . $e->getMessage() . "\n");
    exit(3);
}
