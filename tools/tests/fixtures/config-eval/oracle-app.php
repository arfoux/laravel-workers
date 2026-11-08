<?php
// The PHP 8.3 side of the STATEMENT corpus: boot-free, no Laravel — it just
// `include`s every config/*.php of the fixture app the way an app's config
// directory is read (each file returns its group array).
//
// tools/tests/config-eval.test.mjs folds the same directory through
// tools/static.mjs's `loadConfig()` and compares the two `json_encode()`
// answers BYTE FOR BYTE, which is why this half must not set
// JSON_UNESCAPED_SLASHES or the fold side would have to guess the flags: PHP's
// json_encode defaults (escaped `/`, \uXXXX for non-ASCII) are the canon, and
// kernel/php-json.mjs copies them for the worker.
//
// usage: php oracle-app.php <app-dir>
$appDir = $argv[1];
$out = [];
foreach (glob(rtrim($appDir, '/\\') . '/config/*.php') as $f) {
    $out[basename($f, '.php')] = include $f;
}
ksort($out);
echo json_encode($out);
