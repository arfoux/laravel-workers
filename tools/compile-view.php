<?php

// Compile a Blade view to PHP using the real Laravel Blade compiler — build time only.
// Usage: php edge/tools/compile-view.php <view-name> [out.json]
// Output: JSON {view, path, compiled, context:{config, app, vite, files, auth, routes, route_names, urls, app_version, vfs}}
//
// The context is captured under the SAME boot path as edge/tools/prerender.php
// (HTTP kernel + Request::create('/', 'GET') + handle/terminate) so every captured
// value is byte-exact against the reference render (e.g. url('/dashboard') resolves
// against the request root, not APP_URL).
//
// The Vite capture uses a FRESH Vite instance: rendering '/' already called
// fonts()/__invoke() on the container singleton, which pollutes its
// preloadedAssets (font-preload dedupe) and would drop <link rel="preload"> tags
// from a second capture on the same instance.

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

require $root . '/vendor/autoload.php';

$app = require $root . '/bootstrap/app.php';

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$request = Illuminate\Http\Request::create($argv[3] ?? '/', 'GET');
$response = $kernel->handle($request);
$kernel->terminate($request, $response);

$name = $argv[1] ?? 'welcome';
$out = $argv[2] ?? null;
$uri = $argv[3] ?? '/';

$notes = [];

// --- helpers -----------------------------------------------------------------

// Text between the paren at $open and its matching close paren (string-aware).
$extractArgs = function (string $text, int $open): ?string {
    $depth = 0;
    $len = strlen($text);
    $quote = null;

    for ($i = $open; $i < $len; $i++) {
        $ch = $text[$i];

        if ($quote !== null) {
            if ($ch === '\\') {
                $i++;
            } elseif ($ch === $quote) {
                $quote = null;
            }
            continue;
        }

        if ($ch === "'" || $ch === '"') {
            $quote = $ch;
        } elseif ($ch === '(') {
            $depth++;
        } elseif ($ch === ')') {
            $depth--;
            if ($depth === 0) {
                return substr($text, $open + 1, $i - $open - 1);
            }
        }
    }

    return null;
};

// Conservative gate before eval()ing a snippet from the compiled template.
$evalGate = function (string $code): bool {
    return (bool) preg_match('/^[\sA-Za-z0-9_\'"\-\.\/()\[\],:=>$\\\\]*$/', $code);
};

// Strip the quotes of a single string literal; null when not a plain literal.
$stringLiteral = function (string $code): ?string {
    $code = trim($code);
    $len = strlen($code);

    if ($len < 2 || ($code[0] !== "'" && $code[0] !== '"') || $code[$len - 1] !== $code[0]) {
        return null;
    }

    $inner = substr($code, 1, $len - 2);
    $value = str_replace(['\\\\', '\\' . $code[0]], ['\\', $code[0]], $inner);

    return $value;
};

$finder = $app->make('view.finder');
$path = $finder->find($name);

$compiler = $app->make('blade.compiler');
$compiled = $compiler->compileString(file_get_contents($path));

// --- route data / names ------------------------------------------------------

$routeData = [];
$routeNames = [];
foreach ($app->make('router')->getRoutes() as $route) {
    $routeData[] = [
        'uri' => $route->uri(),
        'name' => $route->getName(),
        'methods' => $route->methods(),
        'domain' => $route->getDomain(),
    ];
    if (($routeName = $route->getName()) !== null) {
        $routeNames[] = $routeName;
    }
}
$routeNames = array_values($routeNames);

// --- files (public_path existence) -------------------------------------------

$files = [];
foreach (['build/manifest.json', 'build/fonts-manifest.json', 'hot'] as $f) {
    $files[$f] = file_exists(public_path($f));
}

// --- vite: fonts() + invoke() with the EXACT args found in the compiled text --

// Compiled by @vite([...]): app('Illuminate\Foundation\Vite')(['…', '…']).
$viteInvokeArgs = null;
if (preg_match('/app\(\s*([\'"])Illuminate\\\\Foundation\\\\Vite\1\s*\)\s*\(/', $compiled, $m, PREG_OFFSET_CAPTURE)) {
    $open = $m[0][1] + strlen($m[0][0]) - 1;
    $inner = $extractArgs($compiled, $open);

    if ($inner !== null && $evalGate($inner)) {
        try {
            $viteInvokeArgs = eval('return ' . $inner . ';');
        } catch (\Throwable $e) {
            $notes[] = "vite invoke args eval threw: {$e->getMessage()}";
        }
    } else {
        $notes[] = 'vite invoke args not captured (unsupported expression)';
    }
} else {
    $notes[] = 'no app(\'Illuminate\\Foundation\\Vite\')(...) call site found in the compiled view';
}

$app->forgetInstance(Illuminate\Foundation\Vite::class);
$vite = $app->make(Illuminate\Foundation\Vite::class);

$viteFonts = (string) $vite->fonts();

$viteInvoke = '';
if ($viteInvokeArgs !== null) {
    $viteInvoke = (string) $vite($viteInvokeArgs);
}

// --- urls: every url(...) / route(...) call site in the compiled PHP segments --

$phpSegments = [];
if (preg_match_all('/<\?(?:php|=)?(.*?)(?:\?>|$)/s', $compiled, $m, PREG_OFFSET_CAPTURE)) {
    foreach ($m[1] as $segment) {
        $phpSegments[] = $segment[0];
    }
}

$urls = [];
foreach ($phpSegments as $code) {
    if (!preg_match_all('/(?<![A-Za-z0-9_$>:])(url|route)\s*\(/', $code, $calls, PREG_OFFSET_CAPTURE)) {
        continue;
    }

    foreach ($calls[0] as $i => $call) {
        $fn = $calls[1][$i][0];
        $open = $call[1] + strlen($call[0]) - 1;
        $inner = $extractArgs($code, $open);

        if ($inner === null) {
            $urls[$fn . '(...unbalanced...)'] = ['error' => 'could not extract arguments'];
            continue;
        }

        $key = $stringLiteral($inner) ?? trim($inner);

        if (!array_key_exists($key, $urls) && $evalGate($inner)) {
            try {
                $value = eval('return ' . $fn . '(' . $inner . ');');
                if (is_object($value)) {
                    $value = method_exists($value, '__toString') ? (string) $value : json_encode($value);
                }
                $urls[$key] = $value;
            } catch (\Throwable $e) {
                $urls[$key] = ['error' => $e->getMessage()];
            }
        }
    }
}

// --- auth (wrapped: the build context may throw without an HTTP session) ------

try {
    $authCheck = auth()->guard()->check();
} catch (\Throwable $e) {
    $authCheck = false;
    $notes[] = 'auth()->guard()->check() threw: ' . get_class($e) . ': ' . $e->getMessage() . ' — captured false';
}

// --- payload ------------------------------------------------------------------

$payload = [
    'view' => $name,
    'path' => $path,
    'compiled' => $compiled,
    'context' => [
        'app' => [
            'version' => $app->version(),
            'locale' => $app->getLocale(),
        ],
        'config' => [
            'app.name' => config('app.name'),
            'app.locale' => config('app.locale'),
        ],
        'vite' => [
            'fonts' => $viteFonts,
            'invoke' => $viteInvoke,
        ],
        'files' => $files,
        'auth' => [
            'check' => (bool) $authCheck,
        ],
        'routes' => $routeData,
        'route_names' => $routeNames,
        'urls' => $urls === [] ? new stdClass() : $urls,
        'app_version' => $app->version(),
        'vfs' => $files,
    ],
];

$json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);

if ($out) {
    @mkdir(dirname($out), 0777, true);
    file_put_contents($out, $json);
    fwrite(STDOUT, 'wrote ' . $out . ' (' . strlen($json) . " bytes)\n");
} else {
    echo $json;
}

foreach ($notes as $note) {
    fwrite(STDERR, 'note: ' . $note . "\n");
}
