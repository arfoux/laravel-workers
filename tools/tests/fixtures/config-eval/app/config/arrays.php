<?php

$x = 'X';

return [
    'plain' => 'x',
    'list' => ['a', 'b', 'c'],
    'nested' => ['k' => ['deep' => [1, 2, 3]]],
    'keys' => ['a' => 1, 'b' => 2],
    'mixed' => ['x' => 1, 0 => 'zero', 'y' => 2],
    'numeric' => [5 => 'five', 6 => 'six'],
    'bool' => [true, false, null],
    'concat' => 'a' . 'b' . 'c',
    'interp' => "a{$x}b",
    'x' => 1,
    'ternary' => 1 > 0 ? 'yes' : 'no',
    'coalesce' => $missing ?? 'fallback',
    'spread' => [...['a', 'b'], 'c'],
];
