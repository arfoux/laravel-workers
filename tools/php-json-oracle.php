<?php
// tools/php-json-oracle.php — PHP 8.3 json_encode()/json_decode($s, true) oracle.
//
// Used by kernel/tests/php-json.test.mjs to prove byte parity of
// kernel/php-json.mjs with PHP's json_encode() default flags — the exact call
// Illuminate\Session\Store::save() makes when session.serialization === 'json'
// (Laravel 11+/13 default) and CookieSessionHandler::write() makes for the
// {"data": ..., "expires": ...} cookie envelope.
//
// Protocol: JSON on stdin, JSON on stdout.
//   { "mode": "encode", "values": [tagged, ...] }
//     -> { "results": [ {"out": "<json>"} | {"err": "..."}, ... ] }
//   { "mode": "roundtrip", "strings": ["<json>", ...] }
//     -> { "results": [ {"reencoded": "<json>"} | {"err": "..."}, ... ] }
//
// Tagged value format (JSON-safe) — same as tools/php-serialize-oracle.php:
//   {"t":"n"}                      null
//   {"t":"b","v":true}             bool
//   {"t":"i","v":"42"}             int (string to survive JS JSON)
//   {"t":"d","v":"1.5"}            float (string; "NAN"/"INF"/"-INF" supported)
//   {"t":"s","v":"str"}            string
//   {"t":"a","v":{...}} or [...]   array (object form preserves key order)

function fromTagged($t)
{
    if (!is_array($t) || !isset($t['t'])) {
        throw new Exception('bad tag structure');
    }
    switch ($t['t']) {
        case 'n':
            return null;
        case 'b':
            return (bool) $t['v'];
        case 'i':
            return intval($t['v']);
        case 'd':
            $s = (string) $t['v'];
            if ($s === 'NAN') return NAN;
            if ($s === 'INF') return INF;
            if ($s === '-INF') return -INF;
            return floatval($s);
        case 's':
            return (string) $t['v'];
        case 'a':
            $a = [];
            if (!is_array($t['v'])) throw new Exception('bad array tag');
            foreach ($t['v'] as $k => $v) {
                // PHP auto-casts canonical decimal string keys to int, like a real $a["5"] = ...
                $a[$k] = fromTagged($v);
            }
            return $a;
        case 'o':
            // PHP stdClass: json_encode() answers `{}` for the empty one and
            // `{"0":..}` for one whose property names are the list indices.
            if (!is_array($t['v'])) throw new Exception('bad object tag');
            $o = new stdClass();
            foreach ($t['v'] as $k => $v) {
                $o->{$k} = fromTagged($v);
            }
            return $o;
    }
    throw new Exception('unknown tag: ' . $t['t']);
}

$raw = stream_get_contents(STDIN);
if ($raw === false || trim($raw) === '') {
    fwrite(STDERR, "no input\n");
    exit(1);
}
$in = json_decode($raw, true);
if (!is_array($in) || !isset($in['mode'])) {
    fwrite(STDERR, "bad input json\n");
    exit(1);
}

$results = [];
if ($in['mode'] === 'encode') {
    foreach ($in['values'] as $tagged) {
        try {
            $v = fromTagged($tagged);
            $json = json_encode($v);
            if ($json === false) {
                throw new Exception(json_last_error_msg());
            }
            $results[] = ['out' => $json];
        } catch (Throwable $e) {
            $results[] = ['err' => $e->getMessage()];
        }
    }
} elseif ($in['mode'] === 'roundtrip') {
    foreach ($in['strings'] as $s) {
        try {
            $v = json_decode($s, true);
            if (json_last_error() !== JSON_ERROR_NONE) {
                throw new Exception(json_last_error_msg());
            }
            $json = json_encode($v);
            if ($json === false) {
                throw new Exception(json_last_error_msg());
            }
            $results[] = ['reencoded' => $json];
        } catch (Throwable $e) {
            $results[] = ['err' => $e->getMessage()];
        }
    }
} else {
    fwrite(STDERR, "unknown mode\n");
    exit(1);
}

echo json_encode(['results' => $results], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
