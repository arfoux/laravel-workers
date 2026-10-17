<?php
$defined = 1;
$null = null;
$arr = ["k" => "v", "n" => null];
echo isset($defined) ? "T" : "F", "\n";
echo isset($never) ? "T" : "F", "\n";
echo isset($null) ? "T" : "F", "\n";
echo isset($arr["k"]) ? "T" : "F", "\n";
echo isset($arr["n"]) ? "T" : "F", "\n";
echo isset($arr["missing"]) ? "T" : "F", "\n";
echo isset($defined, $arr["k"]) ? "T" : "F", "\n";
echo isset($defined, $null) ? "T" : "F", "\n";
