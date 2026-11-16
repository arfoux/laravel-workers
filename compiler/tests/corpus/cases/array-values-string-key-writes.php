<?php
// A PHP array written as `[]` then given string keys (the /misc/collection
// shape). The transpiler emits a JS Array with computed property writes;
// every PHP-key reader must still see these three values in key order.
$a = [];
$a['k3'] = 3;
$a['k1'] = 1;
$a['k2'] = 2;
echo implode(',', array_values($a)), "\n";
echo count($a), "\n";
echo empty($a) ? 'T' : 'F', "\n";
echo implode(',', array_keys($a)), "\n";
foreach ($a as $k => $v) echo $k, '=', $v, ';';
echo "\n";
echo implode(',', $a), "\n";
echo array_sum($a), "\n";
echo json_encode($a), "\n";
echo in_array(1, $a) ? 'T' : 'F', "\n";
echo $a == ['k1' => 1, 'k2' => 2, 'k3' => 3] ? 'T' : 'F', "\n";
