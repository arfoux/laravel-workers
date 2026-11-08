<?php
// The PHP 8.3 side of the expression corpus (tools/tests/config-eval.test.mjs).
//
// Every expression in fixtures/config-eval/cases.json is evaluated with real PHP
// (no Laravel, no app) and reported as:
//   kind:  'value' (json + the array KEY ORDER, flattened) or 'threw' (+ class)
//   json:  json_encode of the value - the same encoder the fold's answers are
//          compared through, so the comparison is PHP against PHP
//   order: `[a,b]` per array, depth-first - PHP's array order, which a JS object
//          cannot hold on its own (integer-like keys enumerate first), so the
//          fold records it in `__lwOrder` and the test walks that marker.
//
// usage: php oracle.php fixtures/config-eval/cases.json
ini_set('display_errors', 'stderr');
ini_set('log_errors', '0');
error_reporting(E_ALL);

// Laravel's HandleExceptions::handleError() promotes every non-deprecation
// warning the app raises to an ErrorException, so an arithmetic warning inside a
// config file is a boot failure in a Laravel app, not a value with a note. A
// DEPRECATION is different: Laravel logs it and keeps the value (`strlen(null)`
// is 0 in a real app). The fold models both halves (`phpNumeric()` raises
// "A non-numeric value encountered"), so the oracle does the same here: without
// this handler a raw `eval()` keeps the prefix value and the two sides would
// disagree for the wrong reason.
set_error_handler(function ($errno, $errstr, $errfile, $errline) {
    if ($errno === E_DEPRECATED || $errno === E_USER_DEPRECATED) return true;
    if (!(error_reporting() & $errno)) return false;
    throw new ErrorException($errstr, 0, $errno, $errfile, $errline);
});

function lw_order($v, string $prefix = '', array &$out = []): array {
    if (is_array($v)) {
        $order = array_map('strval', array_keys($v));
        $out[] = $prefix . '[' . implode(',', $order) . ']';
        foreach ($order as $k) {
            lw_order($v[$k], $prefix . '.' . $k, $out);
        }
    }
    return $out;
}

$corpus = json_decode(file_get_contents($argv[1]), true);
$out = [];
foreach ($corpus['expressions'] as $expr) {
    try {
        $v = eval('return ' . $expr . ';');
        $ordered = [];
        lw_order($v, '', $ordered);
        // Per value: one string can hold invalid UTF-8 (a substr() cutting a
        // sequence), and one bad value would make the whole json_encode() answer
        // false, so the flags substitute instead of failing.
        $out[$expr] = [
            'kind' => 'value',
            'order' => implode('|', $ordered),
            'json' => json_encode($v, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR),
        ];
    } catch (Throwable $e) {
        $out[$expr] = ['kind' => 'threw', 'class' => get_class($e), 'error' => $e->getMessage()];
    }
}
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
