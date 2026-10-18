<?php
// tools/php-crypto-oracle.php — standalone PHP implementation of the Laravel
// Encrypter payload (AES-256-CBC + HMAC-SHA256, serialize=false) and
// CookieValuePrefix, used by kernel/tests/cookies.test.mjs to cross-check
// kernel/cookies.mjs in both directions without booting the framework.
//
// Protocol: JSON on stdin, JSON on stdout.
//   {
//     "key_b64": "<base64 app key>",
//     "mode": "encrypt" | "decrypt" | "prefix" | "cookie-encrypt" | "cookie-decrypt",
//     "items": [ ... ]
//   }
//
// Modes:
//   encrypt          item = plaintext string   -> base64 payload
//   decrypt          item = base64 payload     -> plaintext (error => {"error": ...})
//   prefix           item = cookie name        -> 41-char "sha1hex|" prefix
//   cookie-encrypt   item = {name, value}      -> EncryptCookies-style encrypted cookie value
//   cookie-decrypt   item = {name, value}      -> value with prefix stripped, or null when
//                                                the prefix is invalid / decryption fails

function encryptRaw(string $value, string $key): string
{
    $iv = random_bytes(16);
    $ciphertext = openssl_encrypt($value, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
    if ($ciphertext === false) {
        throw new RuntimeException('openssl_encrypt failed');
    }
    $ivB64 = base64_encode($iv);
    $valueB64 = base64_encode($ciphertext);
    $mac = hash_hmac('sha256', $ivB64 . $valueB64, $key);
    $json = json_encode(['iv' => $ivB64, 'value' => $valueB64, 'mac' => $mac, 'tag' => ''], JSON_UNESCAPED_SLASHES);
    return base64_encode($json);
}

function decryptRaw(string $payload, string $key): string
{
    $raw = base64_decode($payload, true);
    if ($raw === false) {
        throw new RuntimeException('invalid base64 payload');
    }
    $json = json_decode($raw, true);
    if (!is_array($json) || !isset($json['iv'], $json['value'], $json['mac'])) {
        throw new RuntimeException('invalid payload structure');
    }
    $expected = hash_hmac('sha256', $json['iv'] . $json['value'], $key);
    if (!hash_equals($expected, (string) $json['mac'])) {
        throw new RuntimeException('MAC invalid');
    }
    $iv = base64_decode($json['iv'], true);
    $value = base64_decode($json['value'], true);
    if ($iv === false || $value === false) {
        throw new RuntimeException('invalid iv/value base64');
    }
    $plain = openssl_decrypt($value, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
    if ($plain === false) {
        throw new RuntimeException('openssl_decrypt failed');
    }
    return $plain;
}

function cookiePrefix(string $name, string $key): string
{
    return hash_hmac('sha1', $name . 'v2', $key) . '|';
}

$in = json_decode(stream_get_contents(STDIN), true);
if (!is_array($in) || !isset($in['key_b64'], $in['mode'], $in['items'])) {
    fwrite(STDERR, "usage: stdin JSON {key_b64, mode, items}\n");
    exit(1);
}

$key = base64_decode($in['key_b64']);
if ($key === false || strlen($key) !== 32) {
    fwrite(STDERR, "key must decode to 32 bytes\n");
    exit(1);
}

$out = [];
foreach ($in['items'] as $item) {
    try {
        switch ($in['mode']) {
            case 'encrypt':
                $out[] = encryptRaw($item, $key);
                break;
            case 'decrypt':
                $out[] = decryptRaw($item, $key);
                break;
            case 'prefix':
                $out[] = cookiePrefix($item, $key);
                break;
            case 'cookie-encrypt':
                $out[] = encryptRaw(cookiePrefix($item['name'], $key) . ($item['value'] ?? ''), $key);
                break;
            case 'cookie-decrypt':
                try {
                    $plain = decryptRaw($item['value'], $key);
                } catch (Throwable $e) {
                    $out[] = null;
                    break;
                }
                $prefix = cookiePrefix($item['name'], $key);
                $out[] = str_starts_with($plain, $prefix) ? substr($plain, 41) : null;
                break;
            default:
                throw new RuntimeException('unknown mode ' . $in['mode']);
        }
    } catch (Throwable $e) {
        $out[] = ['error' => $e->getMessage()];
    }
}

echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
