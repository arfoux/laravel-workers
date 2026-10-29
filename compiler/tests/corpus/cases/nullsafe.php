<?php
$a = null;
echo $a?->b, "|";
$d = (object) ['b' => (object) ['c' => 5]];
echo $d?->b->c, "|";
$e = (object) ['b' => null];
echo $e?->b?->c, "|";
$f = (object) ['m' => 3];
echo $f?->m, "|";
echo $a?->b + 1;
