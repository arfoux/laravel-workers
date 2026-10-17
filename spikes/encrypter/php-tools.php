<?php
// edge/spikes/encrypter/php-tools.php — Laravel Encrypter parity oracle (throwaway test key)
$root = dirname(__DIR__, 3); // edge/spikes/encrypter -> nearFind
require $root . '/vendor/autoload.php';

$cipher = 'aes-256-cbc';
$keyFile = __DIR__ . '/test-key.b64';

// Load or generate a throwaway 32-byte test key (NEVER the app's real APP_KEY).
if (!file_exists($keyFile)) {
    $key = Illuminate\Encryption\Encrypter::generateKey($cipher);
    file_put_contents($keyFile, base64_encode($key));
}
$key = base64_decode(trim(file_get_contents($keyFile)), true);
$enc = new Illuminate\Encryption\Encrypter($key, $cipher);

$cmd = $argv[1] ?? 'gen';

if ($cmd === 'gen') {
    $n = (int) ($argv[2] ?? 10);
    $samples = [
        '',
        'hello',
        'Hello, World!',
        "it's a \"test\" with 'quotes' and \\backslash",
        "line1\nline2\ttab",
        'unicode: café ☕ emoji 🎉 ñ',
        str_repeat('a', 300),
        'special: <>&\'"',
        '0',
        'false-ish',
    ];
    $out = [];
    for ($i = 0; $i < $n; $i++) {
        $plain = $samples[$i % count($samples)] . ($i > 0 ? ' #' . $i : '');
        $out[] = [
            'plaintext' => $plain,
            'payload' => $enc->encryptString($plain), // serialize=false path
        ];
    }
    echo json_encode($out, JSON_UNESCAPED_SLASHES) . "\n";
    exit(0);
}

if ($cmd === 'decrypt') {
    $payload = $argv[2] ?? '';
    try {
        echo $enc->decryptString($payload) . "\n";
        exit(0);
    } catch (\Throwable $e) {
        fwrite(STDERR, get_class($e) . ': ' . $e->getMessage() . "\n");
        exit(1);
    }
}

if ($cmd === 'tamper') {
    $payload = $argv[2] ?? '';
    $idx = (int) ($argv[3] ?? 0);
    $raw = base64_decode($payload, true);
    if ($raw === false) { fwrite(STDERR, "bad base64\n"); exit(1); }
    $bytes = str_split($raw);
    if ($idx < 0 || $idx >= count($bytes)) { fwrite(STDERR, "index out of range\n"); exit(1); }
    $bytes[$idx] = chr((ord($bytes[$idx]) ^ 0xFF) & 0xFF);
    $tampered = base64_encode(implode('', $bytes));
    // try decrypt; expect failure
    try {
        $enc->decryptString($tampered);
        echo "STILL_DECRYPTS (FAIL: tamper not detected)\n";
        exit(0);
    } catch (\Throwable $e) {
        echo "REJECTED (OK): " . get_class($e) . "\n";
        exit(0);
    }
}

fwrite(STDERR, "unknown command: $cmd\n");
exit(1);
