<?php
function greet()
{
    return "hi";
}

function add($a, $b)
{
    return $a + $b;
}

function printTwice($s)
{
    echo $s, $s, "\n";
}

function returnsNothing()
{
    $local = 1;
}

echo greet(), "\n";
echo add(2, 3), "\n";
echo add(10, -10), "\n";
printTwice("ab");
$r = returnsNothing();
echo $r === null ? "null-ret" : "got", "\n";
