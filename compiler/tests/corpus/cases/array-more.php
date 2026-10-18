<?php
function dbl($x) { return $x * 2; }
echo array_sum([1, 2, 3]) . "|";
echo implode(",", array_slice([1, 2, 3, 4], 1, 2)) . "|";
echo implode(",", array_reverse([1, 2, 3])) . "|";
echo implode(",", array_unique([1, 2, 2, 3, 1])) . "|";
$c = array_count_values(["a", "b", "a"]);
echo $c["a"] . "|";
echo implode(",", array_filter([0, 1, 2, "", "x"])) . "|";
echo implode(",", array_map("dbl", [1, 2, 3])) . "|";
$f = array_flip(["x" => "a", "y" => "b"]);
echo $f["a"] . "|";
