<?php
$o = (object) ['x' => 1, 'y' => 'two'];
echo $o->x, '-', $o->y, "\n";
$s = (object) 9;
echo $s->scalar, "\n";
$o2 = (object) ['b' => ['c' => 5]];
echo $o2->b['c'], "\n";
