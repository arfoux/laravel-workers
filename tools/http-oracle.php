<?php
// tools/http-oracle.php — Laravel HTTP pipeline oracle.
//
// Boots a real Laravel app (fresh-app fixture) and replays scripted requests
// through the full HTTP kernel (EncryptCookies -> StartSession -> CSRF ->
// probe route), carrying a cookie jar between steps. Emits raw statuses,
// headers and Set-Cookie strings so kernel/*.mjs can be calibrated and
// verified byte-for-byte against real Laravel behaviour.
//
// Usage: php tools/http-oracle.php <app-path>
//   stdin:  {"driver":"cookie","steps":[...]}
//   stdout: {"app":..., "session_cookie_name":..., "steps":[{"label":..., "status":..., "headers":{...}, "set_cookie":[...], "body":...}]}
//
// Step fields:
//   method, uri, jar (bool: attach jar cookies), headers (map), form (map),
//   json (string), server (map: e.g. {"REMOTE_ADDR":"1.2.3.4"}),
//   placeholders in strings: @xsrf -> decrypted XSRF-TOKEN cookie value,
//                            @session_token -> session _token seen last step.

putenv('SESSION_DRIVER=cookie');
putenv('CACHE_STORE=array');

$appPath = $argv[1] ?? getenv('LW_APP');
if (!$appPath || !is_file($appPath . '/bootstrap/app.php')) {
    fwrite(STDERR, "usage: php http-oracle.php <laravel-app-path>\n");
    exit(1);
}
require $appPath . '/vendor/autoload.php';
$app = require $appPath . '/bootstrap/app.php';

$input = json_decode(stream_get_contents(STDIN), true);
if (!is_array($input)) {
    fwrite(STDERR, "bad input json\n");
    exit(1);
}

$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$kernel->bootstrap();
$encrypter = $app->make(Illuminate\Contracts\Encryption\Encrypter::class);
$key = $encrypter->getKey();

// --- probe routes ----------------------------------------------------------
$router = $app->make('router');

$sessionProbe = function (Illuminate\Http\Request $request) use ($app) {
    $ops = [];
    if ($raw = $request->input('ops')) {
        $ops = json_decode($raw, true) ?: [];
    }
    $session = $request->session();
    foreach ($ops as $op) {
        switch ($op['type'] ?? '') {
            case 'put':    $session->put($op['key'], $op['value']); break;
            case 'push':   $session->push($op['key'], $op['value']); break;
            case 'flash':  $session->flash($op['key'], $op['value']); break;
            case 'now':    $session->now($op['key'], $op['value']); break;
            case 'reflash': $session->reflash(); break;
            case 'keep':   $session->keep($op['keys'] ?? []); break;
            case 'forget': $session->forget($op['keys'] ?? []); break;
            case 'pull':   $session->pull($op['key']); break;
            case 'invalidate': $session->invalidate(); break;
            case 'regenerate': $session->regenerate(); break;
            case 'regenerateToken': $session->regenerateToken(); break;
            case 'flush':  $session->flush(); break;
            case 'putFlashBag': break;
            default: throw new RuntimeException('unknown op: ' . ($op['type'] ?? '?'));
        }
    }
    return response()->json([
        'all' => $session->all(),
        'id' => $session->getId(),
        'token' => $session->token(),
        'previous' => $session->previousUrl(),
    ]);
};

$router->middleware('web')->get('/__probe/session', $sessionProbe);
$router->middleware('web')->post('/__probe/session', $sessionProbe);
$router->middleware('web')->get('/__probe/plain', fn () => response()->json(['ok' => true]));
$router->middleware(['web', 'throttle:3,1'])->get('/__probe/throttle', fn () => response()->json(['ok' => true]));
$router->middleware(['web', 'throttle:3,1'])->post('/__probe/throttle', fn () => response()->json(['ok' => true]));

// --- run steps ---------------------------------------------------------------
$jar = [];
$lastToken = null;
$out = [
    'app' => realpath($appPath),
    'session_cookie_name' => config('session.cookie'),
    'session_driver' => config('session.driver'),
    'session_lifetime' => config('session.lifetime'),
    'key_b64' => base64_encode($key),
    'steps' => [],
];

function resolvePlaceholders($value, $jar, $lastToken, $encrypter)
{
    if (is_array($value)) {
        $r = [];
        foreach ($value as $k => $v) {
            $r[$k] = resolvePlaceholders($v, $jar, $lastToken, $encrypter);
        }
        return $r;
    }
    if (!is_string($value)) return $value;
    if ($value === '@xsrf') {
        // What a browser/axios sends back verbatim: the (percent-decoded) encrypted
        // cookie value. Laravel decrypts the header itself in getTokenFromRequest().
        $raw = $jar['XSRF-TOKEN'] ?? null;
        if ($raw === null) throw new RuntimeException('@xsrf but no XSRF-TOKEN in jar');
        return $raw;
    }
    if ($value === '@xsrf_decrypted') {
        $raw = $jar['XSRF-TOKEN'] ?? null;
        if ($raw === null) throw new RuntimeException('@xsrf_decrypted but no XSRF-TOKEN in jar');
        return \Illuminate\Cookie\CookieValuePrefix::remove($encrypter->decrypt($raw, false));
    }
    if ($value === '@xsrf_encrypted_raw') {
        return $jar['XSRF-TOKEN'] ?? null;
    }
    if ($value === '@session_token') {
        return $lastToken;
    }
    if ($value === '@session_id') {
        return $jar[config('session.cookie')] ?? null;
    }
    return $value;
}

foreach ($input['steps'] as $step) {
    $method = strtoupper($step['method'] ?? 'GET');
    $uri = $step['uri'] ?? '/';
    $cookies = [];
    if (!empty($step['jar'])) {
        $cookies = $jar;
    }
    if (!empty($step['cookies'])) {
        $cookies = array_merge($cookies, resolvePlaceholders($step['cookies'], $jar, $lastToken, $encrypter));
    }
    $server = array_merge(['HTTP_ACCEPT' => 'application/json'], $step['server'] ?? []);
    $content = null;
    $params = [];
    if (isset($step['form'])) {
        $params = resolvePlaceholders($step['form'], $jar, $lastToken, $encrypter);
    }
    if (isset($step['json'])) {
        $content = $step['json'];
        $server['CONTENT_TYPE'] = 'application/json';
        $server['HTTP_ACCEPT'] = 'application/json';
    }
    $request = Illuminate\Http\Request::create($uri, $method, $params, $cookies, [], $server, $content);
    foreach (resolvePlaceholders($step['headers'] ?? [], $jar, $lastToken, $encrypter) as $h => $v) {
        $request->headers->set($h, $v);
    }
    $response = $kernel->handle($request);

    $headers = [];
    foreach ($response->headers->all() as $name => $values) {
        if ($name === 'set-cookie') continue;
        $headers[$name] = $values;
    }
    $setCookie = [];
    foreach ($response->headers->getCookies() as $cookie) {
        $setCookie[] = (string) $cookie;
    }

    $body = $response->getContent();
    $decoded = json_decode($body, true);
    if (is_array($decoded) && isset($decoded['token'])) {
        $lastToken = $decoded['token'];
    }

    // update jar from Set-Cookie (raw values, browser-style)
    foreach ($setCookie as $sc) {
        $pair = explode(';', $sc, 2)[0];
        $eq = strpos($pair, '=');
        $name = urldecode(substr($pair, 0, $eq));
        $value = urldecode(substr($pair, $eq + 1));
        if ($value === '' && stripos($sc, 'expires=') !== false && stripos($sc, 'max-age=0') !== false) {
            unset($jar[$name]);
        } else {
            $jar[$name] = $value;
        }
    }

    $out['steps'][] = [
        'label' => $step['label'] ?? $method . ' ' . $uri,
        'status' => $response->getStatusCode(),
        'headers' => $headers,
        'set_cookie' => $setCookie,
        'jar_after' => $jar,
        'body' => $body,
    ];

    // Each real request runs in its own process with an empty cookie queue, but
    // this oracle reuses one app instance across steps, so flush the jar queue
    // to emulate production behaviour (otherwise queued cookies accumulate).
    $app->make('cookie')->flushQueuedCookies();
}

echo json_encode($out, JSON_UNESCAPED_SLASHES);
