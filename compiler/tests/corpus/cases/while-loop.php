<?php
$i = 0;
while ($i < 3) {
    echo $i;
    $i++;
}
echo "\n";
$j = 0;
while ($j < 10) {
    $j++;
    if ($j === 2) {
        continue;
    }
    if ($j === 5) {
        break;
    }
    echo $j;
}
echo "\n";
$k = 3;
while ($k > 0) {
    echo $k;
    $k--;
}
echo "\n";
