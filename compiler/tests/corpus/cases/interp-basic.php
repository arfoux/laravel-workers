<?php
$who = "edge";
$count = 7;
$map = ["k" => "V"];
echo "hi $who\n";
echo "{$who}!\n";
echo "count={$count}, twice=", $count * 2, "\n";
echo "map: {$map["k"]}\n";
echo "map2: $map[k]\n";
echo "adjacent: {$who}{$count}\n";
