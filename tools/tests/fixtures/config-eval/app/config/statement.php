<?php

$driver = 'mysql';
$config = ['driver' => $driver, 'host' => 'localhost'];

if ($driver === 'mysql') {
    $config['port'] = 3306;
} elseif ($driver === 'pgsql') {
    $config['port'] = 5432;
} else {
    $config['port'] = 0;
}

foreach ([1, 2, 3] as $n) {
    $config['nums'][] = $n * 2;
}

foreach (['a' => 1, 'b' => 2] as $k => $v) {
    $config['pairs'][$k] = $v + 10;
}

$sum = 0;
for ($i = 0; $i < 4; $i++) {
    $sum += $i;
}
$config['sum'] = $sum;

$i = 0;
while ($i < 3) {
    $config['while'][] = $i;
    $i++;
}

$j = 0;
do {
    $config['do'][] = $j;
    $j++;
} while ($j < 2);

switch ($driver) {
    case 'mysql':
        $config['switch'] = 'm';
        break;
    case 'pgsql':
        $config['switch'] = 'p';
        break;
    default:
        $config['switch'] = 'd';
}

$upper = function ($s) {
    return strtoupper($s);
};
$double = fn ($n) => $n * 2;
$config['closure'] = $upper('abc');
$config['arrow'] = $double(4);

$config['default'] ??= 'from-default';
$config['driver'] .= '-pdo';
$config['pow'] = 2;
$config['pow'] **= 3;

$config['builtins'] = implode(',', array_map('strtoupper', ['a', 'b']));
$config['merge'] = array_merge(['a' => 1], ['b' => 2]);
$config['pad'] = str_pad('7', 3, '0', STR_PAD_LEFT);
$config['repeat'] = str_repeat('ab', 2);
$config['count'] = count([1, 2, 3]);
$config['filter'] = array_values(array_filter([1, 2, 3, 4], fn ($n) => $n % 2 === 0));

return $config;
