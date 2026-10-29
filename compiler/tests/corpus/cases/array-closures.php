<?php
// array_filter / array_map parity: keys are preserved for a single array,
// the default predicate is PHP truthiness, USE_KEY / USE_BOTH change the
// callback arguments, and the multi-array form drops keys (null padding).
$a = ['x' => 1, 'y' => 0, 'z' => 2];
echo json_encode(array_filter($a)), "\n";
echo json_encode(array_filter($a, fn ($v) => $v > 1)), "\n";
echo json_encode(array_filter(['a', '0', '', 0, 1, false, 'b'])), "\n";
echo json_encode(array_filter($a, fn ($k) => $k === 'y', ARRAY_FILTER_USE_KEY)), "\n";
echo json_encode(array_filter($a, fn ($v, $k) => $k === 'y', ARRAY_FILTER_USE_BOTH)), "\n";
echo json_encode(array_map(fn ($v) => $v * 2, $a)), "\n";
echo json_encode(array_map(fn ($v) => $v * 2, [5, 6])), "\n";
echo json_encode(array_map(null, [1, 2], [10, 20])), "\n";
echo json_encode(array_map(fn ($x, $y) => $x + $y, [1, 2, 3], [10])), "\n";
echo json_encode(array_map('strval', [1, 2.5, true, null])), "\n";
