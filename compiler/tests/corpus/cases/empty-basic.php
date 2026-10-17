<?php
$zero = 0;
$zeroStr = "0";
$one = 1;
$emptyStr = "";
$null = null;
$arr = [];
echo empty($zero) ? "T" : "F", "\n";
echo empty($zeroStr) ? "T" : "F", "\n";
echo empty($one) ? "T" : "F", "\n";
echo empty($emptyStr) ? "T" : "F", "\n";
echo empty($null) ? "T" : "F", "\n";
echo empty($neverSet) ? "T" : "F", "\n";
echo empty($arr) ? "T" : "F", "\n";
echo empty("a") ? "T" : "F", "\n";
echo empty(0.0) ? "T" : "F", "\n";
