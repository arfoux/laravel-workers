<?php

// Compile a Blade view to PHP using the real Laravel Blade compiler — build time only.
// Usage:
//   php tools/compile-view.php <view-name> [out.json] [uri]   one view — one boot
//   php tools/compile-view.php --batch <jobs.json>            every view — ONE boot
// jobs.json: [{"name": "...", "out": "...", "uri": "..."}, ...]
// or a phase plan: {"jobs": [...], "outDir": "...", "recursive": true,
//                    "manifest": "..."} — recursive compiles the `make('...')`
//                   dependency closure in the SAME boot and writes a manifest.
// Output: JSON {view, path, compiled, context:{config, app, vite, files, auth, routes, route_names, urls, app_version, vfs}}
//
// The context is captured under the SAME boot path as tools/prerender.php
// (HTTP kernel + Request::create + handle/terminate) so every captured
// value is byte-exact against the reference render (e.g. url('/dashboard') resolves
// against the request root, not APP_URL).
//
// The Vite capture uses a FRESH Vite instance: rendering '/' already called
// fonts()/__invoke() on the container singleton, which pollutes its
// preloadedAssets (font-preload dedupe) and would drop <link rel="preload"> tags
// from a second capture on the same instance.
//
// Track E (compile-view-batch): --batch boots the framework ONCE and runs the
// identical single-view steps — handle, capture, write — for every job. A
// failed job is caught per job (`view <name>: <error>` on stderr, dump left
// unwritten) so the rest still compile; the process then exits 1.

require_once __DIR__ . '/_root.php';
$app = lw_boot_app();
$root = lw_app_root();

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);

// The app may have registered an exception handler (Ignition renders the page
// and PHP then exits 0), which turns every failure into a silent missing dump —
// the build can only report ENOENT instead of the real cause. Register ours
// AFTER the kernel bootstrapped so it wins: honest stderr + non-zero exit.
$ownHandler = static function (\Throwable $e): void {
    fwrite(STDERR, 'compile-view: ' . get_class($e) . ': ' . $e->getMessage()
        . ' @ ' . $e->getFile() . ':' . $e->getLine() . PHP_EOL);
    exit(1);
};

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

// --- one view: the steps are IDENTICAL in single and batch mode ---------------

$capture = function (string $name, ?string $out, string $uri) use ($app, $root, $kernel, $extractArgs, $evalGate, $stringLiteral, $ownHandler): void {
    // The native request first, then our handler: the framework registers its
    // own exception handler while bootstrapping this first handle(), so ours
    // has to (re)win afterwards — same order as the single-view mode always had.
    $request = Illuminate\Http\Request::create($uri, 'GET');
    $response = $kernel->handle($request);
    $kernel->terminate($request, $response);
    set_exception_handler($ownHandler);

    // The FRAMEWORK's error views (`errors::404`): Laravel registers that namespace
    // only while an exception is being rendered (RegisterErrorViewPaths), so a
    // build-time compile must register it the same way - the app's own
    // resources/views/errors first, then the framework's views. Without this, a
    // view name that starts with `errors::` cannot be found at all.
    if (str_starts_with($name, 'errors::')) {
        $viewPaths = [$root . '/resources/views/errors'];
        $frameworkViews = dirname((new ReflectionClass(Illuminate\Foundation\Exceptions\Handler::class))->getFileName())
            . '/views';
        $viewPaths[] = $frameworkViews;
        $app['view']->addNamespace('errors', array_values(array_filter($viewPaths, 'is_dir')));
    }

    $notes = [];

    // The view factory first: the namespaced views (the framework's
    // `pagination::tailwind`) are registered when the 'view' service is resolved
    // (the providers hook into it), so the factory has to be built before its
    // finder can find them.
    $finder = $app->make('view')->getFinder();
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
    } elseif (stripos($compiled, 'vite') !== false) {
        // A plain view (no @vite) is the normal case — only note it when the view
        // mentions vite but the standard call pattern is missing.
        $notes[] = 'no app(\'Illuminate\\Foundation\\Vite\')(...) call site found in the compiled view (view mentions "vite" but the standard call pattern is missing)';
    }

    $app->forgetInstance(Illuminate\Foundation\Vite::class);
    $vite = $app->make(Illuminate\Foundation\Vite::class);

    // Laravel gained Vite::fonts() in 12.x. On 11 and older the method does not
    // exist, and a bare call there threw — rendered by the app's exception handler
    // with exit 0, so the build saw only "dump missing". No fonts feature on that
    // major = nothing to capture.
    $viteFonts = method_exists($vite, 'fonts') ? (string) $vite->fonts() : '';

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
        if (file_put_contents($out, $json) === false) {
            throw new RuntimeException("could not write {$out}");
        }
        fwrite(STDOUT, 'wrote ' . $out . ' (' . strlen($json) . " bytes)\n");
    } else {
        echo $json;
    }

    foreach ($notes as $note) {
        fwrite(STDERR, 'note: ' . $note . "\n");
    }
};

// --- main ---------------------------------------------------------------------

// Keep this identical to compiler/src/view-name.mjs: a view name is a dotted
// path or a namespaced one (`pagination::tailwind`); `:` is illegal on Windows.
$viewFileName = static function (string $name): string {
    $safe = preg_replace('/[^A-Za-z0-9._-]/', '-', $name);
    $safe = preg_replace('/^\.+/', '_', (string) $safe);
    return $safe === '' ? '_' : $safe;
};

// The compiled Blade names its dependencies through `$__env->make('...')`.
// The build already uses this contract; the recursive batch uses it to close
// the dependency graph without a second PHP boot per depth level.
$viewDeps = static function (string $compiled): array {
    $deps = [];
    if (preg_match_all('/make\(\s*\'([^\']+)\'/', $compiled, $m)) {
        foreach ($m[1] as $dep) {
            if ($dep !== '' && ! in_array($dep, $deps, true)) $deps[] = $dep;
        }
    }
    return $deps;
};

if (($argv[1] ?? '') === '--batch') {
    $jobsFile = $argv[2] ?? '';
    $plan = json_decode((string) @file_get_contents($jobsFile), true);
    if (!is_array($plan)) {
        fwrite(STDERR, "compile-view: cannot read the jobs file {$jobsFile}\n");
        exit(1);
    }

    // Backwards-compatible: a bare array is a one-wave batch. The phase plan
    // adds outDir/recursive/manifest so the closure is one boot, not one per wave.
    $jobs = isset($plan['jobs']) ? $plan['jobs'] : $plan;
    if (!is_array($jobs)) {
        fwrite(STDERR, "compile-view: the jobs file has no jobs array\n");
        exit(1);
    }
    $recursive = !empty($plan['recursive']);
    $outDir = isset($plan['outDir']) ? (string) $plan['outDir'] : null;
    $manifestPath = isset($plan['manifest']) ? (string) $plan['manifest'] : null;
    $queue = array_values($jobs);
    $seen = [];
    $compiled = [];
    $failed = [];
    $deps = [];
    $failures = 0;

    while ($queue) {
        $job = array_shift($queue);
        $name = (string) ($job['name'] ?? '');
        if ($name === '' || isset($seen[$name])) continue;
        $seen[$name] = true;
        // A dependency is captured under its parent's request URI, not a
        // hard-coded `/`: a layout that reads the current request path must see
        // the same URL the parent view saw.
        $parentUri = (string) ($job['uri'] ?? '/');
        $out = $job['out'] ?? null;
        if (! $out && $outDir) {
            $out = rtrim($outDir, '/\\') . DIRECTORY_SEPARATOR . $viewFileName($name) . '.compiled.json';
        }

        // A view already compiled by the route phase in THIS build can be
        // reused: its dump carries the context captured for that route.
        if (!empty($job['reuse']) && $out && is_file($out)) {
            $dump = json_decode((string) file_get_contents($out), true);
            if (is_array($dump) && isset($dump['compiled'])) {
                $compiled[$name] = $out;
                $deps[$name] = $viewDeps((string) $dump['compiled']);
                foreach ($deps[$name] as $dep) {
                    if (!isset($seen[$dep])) $queue[] = ['name' => $dep, 'uri' => $parentUri];
                }
                continue;
            }
        }

        try {
            $capture($name, $out, $parentUri);
            $dump = ($out && is_file($out)) ? json_decode((string) file_get_contents($out), true) : null;
            $compiled[$name] = $out;
            $deps[$name] = is_array($dump) ? $viewDeps((string) ($dump['compiled'] ?? '')) : [];
            if ($recursive && $outDir) {
                foreach ($deps[$name] as $dep) {
                    if (isset($seen[$dep])) continue;
                    $queue[] = [
                        'name' => $dep,
                        'uri' => '/',
                        'out' => rtrim($outDir, '/\\') . DIRECTORY_SEPARATOR . $viewFileName($dep) . '.compiled.json',
                    ];
                }
            }
        } catch (\Throwable $e) {
            $failures++;
            $failed[$name] = get_class($e) . ': ' . $e->getMessage();
            fwrite(STDERR, 'view ' . $name . ': ' . get_class($e) . ': ' . $e->getMessage() . "\n");
        }
    }

    if ($manifestPath) {
        @mkdir(dirname($manifestPath), 0777, true);
        @file_put_contents($manifestPath, json_encode([
            'views' => array_keys($compiled),
            'failed' => $failed,
            'deps' => $deps,
        ], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE));
    }
    exit($failures ? 1 : 0);
}

$capture($argv[1] ?? 'welcome', $argv[2] ?? null, $argv[3] ?? '/');
