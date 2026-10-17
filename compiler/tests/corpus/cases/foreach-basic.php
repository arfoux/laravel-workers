<?php
$vals = ["a", "b", "c"];
foreach ($vals as $v) {
    echo $v;
}
echo "\n";
foreach ($vals as $v) echo $v;
echo "\n";
foreach ($vals as $v) {
    if ($v === "b") {
        continue;
    }
    echo $v;
}
echo "\n";
$nums = [1, 2, 3];
$sum = 0;
foreach ($nums as $n) {
    $sum += $n;
}
echo $sum, "\n";
