<?php
for ($i = 0; $i < 3; $i++) {
    echo $i;
}
echo "\n";
for ($i = 5; $i > 0; $i--) {
    echo $i;
}
echo "\n";
$total = 0;
for ($i = 1; $i <= 10; $i++) {
    $total += $i;
}
echo $total, "\n";
for ($i = 0; $i < 10; $i++) {
    if ($i === 3) {
        continue;
    }
    if ($i === 6) {
        break;
    }
    echo $i;
}
echo "\n";
