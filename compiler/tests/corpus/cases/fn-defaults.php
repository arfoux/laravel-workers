<?php
function greet($name = "World", $punct = "!")
{
    return "Hello, $name$punct";
}

function power($base, $exp = 2)
{
    return $base ** $exp;
}

echo greet(), "\n";
echo greet("Bob"), "\n";
echo greet("Al", "?"), "\n";
echo power(3), "\n";
echo power(2, 10), "\n";
