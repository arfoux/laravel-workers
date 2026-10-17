<?php
$scores = ["alice" => 10, "bob" => 7, "carol" => 13];
foreach ($scores as $name => $score) {
    echo $name, "=", $score, ";";
}
echo "\n";
foreach ($scores as $name => $score) echo $name;
echo "\n";
$copy = [];
foreach ($scores as $k => $v) {
    $copy[$k] = $v * 2;
}
foreach ($copy as $k => $v) {
    echo "$k:$v;";
}
echo "\n";
