<?php
$m = ["a" => 1, "b" => 2];
echo count($m), "\n";
echo implode(",", array_keys($m)), "\n";
echo implode(",", array_values($m)), "\n";
echo array_key_exists("a", $m) ? "T" : "F", "\n";
echo array_key_exists("z", $m) ? "T" : "F", "\n";
$n = array_merge(["a" => 1], ["b" => 2]);
echo count($n), "\n";
echo $n["b"], "\n";
$l = array_merge([4, 5], [6]);
echo count($l), "\n";
echo $l[2], "\n";
