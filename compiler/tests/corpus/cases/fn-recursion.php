<?php
function fact($n)
{
    if ($n <= 1) {
        return 1;
    }
    return $n * fact($n - 1);
}

function fib($n)
{
    if ($n < 2) {
        return $n;
    }
    return fib($n - 1) + fib($n - 2);
}

echo fact(5), "\n";
echo fib(10), "\n";
