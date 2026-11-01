<?php
// tools/php-json-decode-oracle.php — canonical dump of json_decode($s, true)
// for kernel/tests/php-json-ordered.test.mjs.
//
// Reads {"cases":[<b64 document>, ...]} on stdin and prints one canonical dump
// per line, so the test can compare PHP's ORDER, byte-strings and 64-bit
// integers against kernel/php-json-ordered.mjs. A parse failure dumps NULL,
// like json_decode's default.

function lw_dump($v)
{
    if ($v === null) return 'NULL';
    if (is_bool($v)) return $v ? 'bool(true)' : 'bool(false)';
    if (is_int($v)) return 'num(' . $v . ')';
    if (is_float($v)) return 'num(' . json_encode($v) . ')';
    if (is_string($v)) return 'str:' . bin2hex($v);
    if (is_array($v)) {
        $parts = [];
        foreach ($v as $k => $val) {
            $kk = is_int($k) ? 'int(' . $k . ')' : 'str:' . bin2hex($k);
            $parts[] = $kk . '=>' . lw_dump($val);
        }
        return 'array[' . implode(',', $parts) . ']';
    }
    return 'other';
}

$raw = stream_get_contents(STDIN);
$payload = json_decode($raw, true);
$cases = $payload['cases'] ?? [];
foreach ($cases as $b64) {
    $doc = base64_decode($b64);
    $v = json_decode($doc, true);
    echo lw_dump($v), "\n";
}
