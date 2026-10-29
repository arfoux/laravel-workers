<?php
// Array spread (`...$a`): the values of each spread part, in order, as a list
// (PHP 8.1+: integer keys only; the keys are dropped).
echo json_encode([1, ...[10, 20], 2]), "\n";
echo json_encode([...["a", "b"]]), "\n";
$a = [3, 4];
$b = [5];
echo json_encode([...$a, ...$b]), "\n";
echo json_encode([...[]]), "\n";
