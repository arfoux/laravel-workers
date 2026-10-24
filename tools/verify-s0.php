<?php
// verify-s0.php — independent re-verification of the S0 context captured in
// edge/.cache/welcome.compiled.json. Boots Laravel exactly like compile-view.php
// (HTTP kernel + Request::create('/', 'GET') + handle/terminate) and recomputes
// every enriched + legacy context field from scratch. Does NOT import compile-view.php.
//
// Usage: php edge/tools/verify-s0.php [--json]
// Exit: 0 iff all checks pass (and compiled-field sha256 matches the registry).

require_once __DIR__ . '/_root.php';
$root = lw_app_root();
require lw_vendor_autoload();
$app = require $root . '/bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$request = Illuminate\Http\Request::create('/', 'GET');
$response = $kernel->handle($request);
$kernel->terminate($request, $response);

$dumpCandidates = [
    $root . '/edge/.cache/welcome.compiled.json',
    $root . '/.cache/laravel-workers/welcome.compiled.json',
];
$dumpPath = null;
foreach ($dumpCandidates as $candidate) {
    if (is_file($candidate)) { $dumpPath = $candidate; break; }
}
if ($dumpPath === null) {
    echo "VERIFY-S0: SKIP (no S0 dump at " . implode(' or ', $dumpCandidates) . " — run a build with a views map first)\n";
    exit(0);
}
$dump = json_decode(file_get_contents($dumpPath), true);
if (!is_array($dump) || !isset($dump['context'])) {
    fwrite(STDERR, "cannot read dump context\n");
    exit(1);
}
$ctx = $dump['context'];
$compiled = $dump['compiled'] ?? '';

// --- helpers (same shape as compile-view.php, re-implemented here) -----------
$extractArgs = function (string $text, int $open): ?string {
    $depth = 0; $len = strlen($text); $quote = null;
    for ($i = $open; $i < $len; $i++) {
        $ch = $text[$i];
        if ($quote !== null) {
            if ($ch === '\\') { $i++; } elseif ($ch === $quote) { $quote = null; }
            continue;
        }
        if ($ch === "'" || $ch === '"') { $quote = $ch; }
        elseif ($ch === '(') { $depth++; }
        elseif ($ch === ')') { $depth--; if ($depth === 0) return substr($text, $open + 1, $i - $open - 1); }
    }
    return null;
};
$evalGate = function (string $code): bool {
    return (bool) preg_match('/^[\\sA-Za-z0-9_\'"\\-\\.\\/()\\[\\],:=>$\\\\]*$/', $code);
};
$stringLiteral = function (string $code): ?string {
    $code = trim($code); $len = strlen($code);
    if ($len < 2 || ($code[0] !== "'" && $code[0] !== '"') || $code[$len-1] !== $code[0]) return null;
    $inner = substr($code, 1, $len - 2);
    return str_replace(['\\\\', '\\'.$code[0]], ['\\', $code[0]], $inner);
};

// --- recompute every field ---------------------------------------------------
$recomputed = [];

// app
$recomputed['app'] = ['version' => $app->version(), 'locale' => $app->getLocale()];

// config
$recomputed['config'] = ['app.name' => config('app.name'), 'app.locale' => config('app.locale')];

// files
$files = [];
foreach (['build/manifest.json', 'build/fonts-manifest.json', 'hot'] as $f) {
    $files[$f] = file_exists(public_path($f));
}
$recomputed['files'] = $files;

// vite (fresh instance, exact args from compiled text)
$viteInvokeArgs = null;
if (preg_match('/app\\(\\s*([\'"])Illuminate\\\\Foundation\\\\Vite\\1\\s*\\)\\s*\\(/', $compiled, $m, PREG_OFFSET_CAPTURE)) {
    $open = $m[0][1] + strlen($m[0][0]) - 1;
    $inner = $extractArgs($compiled, $open);
    if ($inner !== null && $evalGate($inner)) {
        try { $viteInvokeArgs = eval('return ' . $inner . ';'); }
        catch (Throwable $e) { $viteInvokeArgs = null; }
    }
}
$app->forgetInstance(Illuminate\Foundation\Vite::class);
$vite = $app->make(Illuminate\Foundation\Vite::class);
$recomputed['vite'] = ['fonts' => (string) $vite->fonts(), 'invoke' => ''];
if ($viteInvokeArgs !== null) {
    $recomputed['vite']['invoke'] = (string) $vite($viteInvokeArgs);
}

// auth
try { $authCheck = auth()->guard()->check(); }
catch (Throwable $e) { $authCheck = false; }
$recomputed['auth'] = ['check' => (bool) $authCheck];

// routes
$routeData = []; $routeNames = [];
foreach ($app->make('router')->getRoutes() as $route) {
    $routeData[] = ['uri' => $route->uri(), 'name' => $route->getName(), 'methods' => $route->methods(), 'domain' => $route->getDomain()];
    if (($rn = $route->getName()) !== null) $routeNames[] = $rn;
}
$recomputed['routes'] = $routeData;
$recomputed['route_names'] = array_values($routeNames);

// urls
$phpSegments = [];
if (preg_match_all('/<\?(?:php|=)?(.*?)(?:\?>|$)/s', $compiled, $m, PREG_OFFSET_CAPTURE)) {
    foreach ($m[1] as $seg) $phpSegments[] = $seg[0];
}
$urls = [];
foreach ($phpSegments as $code) {
    if (!preg_match_all('/(?<![A-Za-z0-9_$>:])(url|route)\s*\(/', $code, $calls, PREG_OFFSET_CAPTURE)) continue;
    foreach ($calls[0] as $i => $call) {
        $fn = $calls[1][$i][0];
        $open = $call[1] + strlen($call[0]) - 1;
        $inner = $extractArgs($code, $open);
        if ($inner === null) { $urls[$fn.'(...unbalanced...)'] = ['error' => 'could not extract arguments']; continue; }
        $key = $stringLiteral($inner) ?? trim($inner);
        if (!array_key_exists($key, $urls) && $evalGate($inner)) {
            try {
                $value = eval('return ' . $fn . '(' . $inner . ');');
                if (is_object($value)) $value = method_exists($value, '__toString') ? (string)$value : json_encode($value);
                $urls[$key] = $value;
            } catch (Throwable $e) { $urls[$key] = ['error' => $e->getMessage()]; }
        }
    }
}
$recomputed['urls'] = $urls === [] ? new stdClass() : $urls;

// legacy
$recomputed['app_version'] = $app->version();
$recomputed['vfs'] = $files;

// --- json mode --------------------------------------------------------------
if (in_array('--json', $argv, true)) {
    echo json_encode($recomputed, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    exit(0);
}

// --- compare ----------------------------------------------------------------
$checks = [];
$add = function (string $key, $exp, $got) use (&$checks) {
    $checks[] = ['key' => $key, 'ok' => ($exp === $got), 'expected' => $exp, 'got' => $got];
};

$add('app.version', $ctx['app']['version'] ?? null, $recomputed['app']['version']);
$add('app.locale', $ctx['app']['locale'] ?? null, $recomputed['app']['locale']);
$add('config.app.name', $ctx['config']['app.name'] ?? null, $recomputed['config']['app.name']);
$add('config.app.locale', $ctx['config']['app.locale'] ?? null, $recomputed['config']['app.locale']);
$add('vite.fonts', $ctx['vite']['fonts'] ?? null, $recomputed['vite']['fonts']);
$add('vite.invoke', $ctx['vite']['invoke'] ?? null, $recomputed['vite']['invoke']);
$add('files.build/manifest.json', $ctx['files']['build/manifest.json'] ?? null, $recomputed['files']['build/manifest.json']);
$add('files.build/fonts-manifest.json', $ctx['files']['build/fonts-manifest.json'] ?? null, $recomputed['files']['build/fonts-manifest.json']);
$add('files.hot', $ctx['files']['hot'] ?? null, $recomputed['files']['hot']);
$add('auth.check', $ctx['auth']['check'] ?? null, $recomputed['auth']['check']);
$add('route_names', $ctx['route_names'] ?? null, $recomputed['route_names']);
$add('urls', $ctx['urls'] ?? null, $recomputed['urls']);
$add('app_version (legacy)', $ctx['app_version'] ?? null, $recomputed['app_version']);
$add('vfs (legacy)', $ctx['vfs'] ?? null, $recomputed['vfs']);

// routes array deep compare
$routesOk = ($ctx['routes'] ?? null) === $recomputed['routes'];
$checks[] = ['key' => 'routes[]', 'ok' => $routesOk, 'expected' => count($ctx['routes'] ?? []), 'got' => count($recomputed['routes'])];

$pass = 0; $fail = 0;
foreach ($checks as $c) {
    $exp = is_string($c['expected']) ? (strlen($c['expected']) > 80 ? substr($c['expected'], 0, 80) . '…(' . strlen($c['expected']) . 'B, sha' . substr(sha1($c['expected']), 0, 12) . ')' : $c['expected']) : json_encode($c['expected']);
    $got = is_string($c['got']) ? (strlen($c['got']) > 80 ? substr($c['got'], 0, 80) . '…(' . strlen($c['got']) . 'B, sha' . substr(sha1($c['got']), 0, 12) . ')' : $c['got']) : json_encode($c['got']);
    printf("%s  %-28s  expected=%s  got=%s\n", $c['ok'] ? 'OK  ' : 'FAIL', $c['key'], $exp, $got);
    $c['ok'] ? $pass++ : $fail++;
}
printf("\nVERIFY-S0: %s (%d/%d checks)\n", $fail === 0 ? 'PASS' : 'FAIL', $pass, count($checks));

// compiled-field sha256 registry (host Laravel app edge/ — not this package)
$shaFile = $root . '/edge/notes/welcome.compiled.sha256.txt';
$sha = hash('sha256', $compiled);
$line = $sha . '  ' . strlen($compiled) . " bytes\n";
if (!file_exists($shaFile)) {
    @mkdir(dirname($shaFile), 0777, true);
    file_put_contents($shaFile, $line);
    echo "created sha registry: " . trim($line) . "\n";
} else {
    $stored = trim(file_get_contents($shaFile));
    $parts = preg_split('/\\s+/', $stored);
    $storedSha = $parts[0] ?? '';
    $storedBytes = isset($parts[1]) ? (int)$parts[1] : -1;
    if ($storedSha !== $sha || $storedBytes !== strlen($compiled)) {
        echo "FAIL  compiled sha256 mismatch: stored='" . $stored . "' current='" . trim($line) . "'\n";
        $fail++;
    } else {
        echo "OK    compiled sha256 matches registry\n";
    }
}

if ($fail === 0) {
    @mkdir($root . '/edge/notes', 0777, true);
    $table = '';
    foreach ($checks as $c) $table .= sprintf("%s  %s\n", $c['ok'] ? 'OK  ' : 'FAIL', $c['key']);
    file_put_contents($root . '/edge/notes/s0-verify.txt',
        "PASS " . $pass . "/" . count($checks) . " keys — " . date('c') . "\n" . $table);
}

exit($fail === 0 ? 0 : 1);
