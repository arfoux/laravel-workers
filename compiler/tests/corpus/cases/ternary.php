<?php
$n = 5;
echo $n > 3 ? "big" : "small", "\n";
echo $n % 2 === 0 ? "even" : "odd", "\n";
$name = "";
echo $name !== "" ? $name : "anon", "\n";
$color = "red";
echo $color === "red" ? "warm" : ($color === "blue" ? "cool" : "other"), "\n";
$v = 0;
echo $v ?: "empty-ish", "\n";
$v2 = "yes";
echo $v2 ?: "default", "\n";
$v3 = "0";
echo $v3 ?: "zero-str", "\n";
