<?php
// tools/php-serialize-oracle.php — PHP 8.3 serialize()/unserialize() oracle.
//
// Used by kernel/tests/php-serialize.test.mjs to prove that
// kernel/php-serialize.mjs produces byte-identical output to PHP 8.3
// (serialize_precision=-1) for the session payload subset.
//
// Protocol: JSON on stdin, JSON on stdout.
//   { "mode": "encode",    "values": [tagged, ...] }
//     -> { "results": [ {"out": "<serialize()>"} | {"err": "..."}, ... ] }
//   { "mode": "roundtrip", "strings": ["<serialized>", ...] }
//     -> { "results": [ {"tagged": tagged, "reserialized": "..."} | {"err": "..."}, ... ] }
//
// Tagged value format (JSON-safe):
//   {"t":"n"}                      null
//   {"t":"b","v":true}             bool
//   {"t":"i","v":"42"}             int (string to survive JS JSON)
//   {"t":"d","v":"1.5"}            float (string; "NAN"/"INF"/"-INF" supported)
//   {"t":"s","v":"str"}            string
//   {"t":"a","v":{"k":tagged,...}} or {"t":"a","v":[tagged,...]} array

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
    }
    throw new Exception('unknown tag: ' . $t['t']);
}

function toTagged($v)
{
    if (is_null($v)) return ['t' => 'n'];
    if (is_bool($v)) return ['t' => 'b', 'v' => $v];
    if (is_int($v)) return ['t' => 'i', 'v' => (string) $v];
    if (is_float($v)) {
        if (is_nan($v)) return ['t' => 'd', 'v' => 'NAN'];
        if ($v === INF) return ['t' => 'd', 'v' => 'INF'];
        if ($v === -INF) return ['t' => 'd', 'v' => '-INF'];
        return ['t' => 'd', 'v' => sprintf('%.17G', $v)];
    }
    if (is_string($v)) return ['t' => 's', 'v' => $v];
    if (is_array($v)) {
        $pairs = [];
        foreach ($v as $k => $vv) {
            $pairs[(string) $k] = toTagged($vv); // order preserved for string+int keys in JSON objects? see note below
        }
        return ['t' => 'a', 'v' => $pairs];
    }
    throw new Exception('unsupported PHP type: ' . gettype($v));
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
            $results[] = ['out' => serialize($v)];
        } catch (Throwable $e) {
            $results[] = ['err' => $e->getMessage()];
        }
    }
} elseif ($in['mode'] === 'roundtrip') {
    foreach ($in['strings'] as $s) {
        try {
            $v = @unserialize($s);
            if ($v === false && $s !== 'b:0;') {
                throw new Exception('php unserialize failed');
            }
            $results[] = ['tagged' => toTagged($v), 'reserialized' => serialize($v)];
        } catch (Throwable $e) {
            $results[] = ['err' => $e->getMessage()];
        }
    }
} else {
    fwrite(STDERR, "unknown mode\n");
    exit(1);
}

echo json_encode(['results' => $results], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
