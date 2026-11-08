<?php

$config = [];
$rows = [
    ['name' => 'a', 'n' => 1],
    ['name' => 'b', 'n' => 2],
];

// nested loops with a level-2 break/continue
$hits = [];
foreach ($rows as $i => $row) {
    foreach ([1, 2, 3] as $j) {
        if ($j === 2 && $i === 0) {
            continue 2;
        }
        $hits[] = $row['name'] . $j;
    }
}
$config['hits'] = $hits;

$stop = [];
foreach ($rows as $i => $row) {
    foreach ([1, 2] as $j) {
        if ($i === 1) {
            break 2;
        }
        $stop[] = "{$row['name']}{$j}";
    }
}
$config['stop'] = $stop;

$config['nested_loop'] = [];
foreach ($rows as $row) {
    $config['nested_loop'][$row['name']] = $row['n'];
}

$config['mod'] = 7 % 3;
$config['div'] = 7 / 2;
$config['bool_or'] = false || 'x';
$config['bool_and'] = true && 'y';
$config['not'] = !false;
$config['ternary_short'] = 'a' ?: 'b';
$config['spaceship'] = 1 <=> 2;
$config['in_array'] = in_array('a', ['a', 'b'], true);
$config['array_search'] = array_search('b', ['a', 'b'], true);
$config['array_keys'] = array_keys(['x' => 1, 'y' => 2]);
$config['array_values'] = array_values(['x' => 1, 'y' => 2]);
$config['unique'] = array_unique([1, 1, 2]);
$config['slice'] = array_slice([1, 2, 3, 4], 1, 2);
$config['splice_keys'] = array_slice(['a' => 1, 'b' => 2, 'c' => 3], 1, 2, true);
$config['str_fns'] = [substr('abcdef', 1, 2), str_replace('a', 'z', 'abca'), trim('  x  '), strtolower('AB'), ucfirst('ab'), str_contains('abc', 'b'), str_starts_with('abc', 'a'), str_pad('x', 3, '*', STR_PAD_BOTH)];
$config['explode'] = explode(',', 'a,b,c');
$config['isset_check'] = isset($rows[0]['name']) ? 'yes' : 'no';
$config['empty_check'] = empty($config['nope']) ? 'empty' : 'full';
$config['nullable'] = $config['nope'] ?? null;
$config['nested_ternary_chain'] = 1 === 2 ? 'a' : (3 === 3 ? 'b' : 'c');

return $config;
