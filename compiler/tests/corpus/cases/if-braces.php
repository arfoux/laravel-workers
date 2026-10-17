<?php
$n = 7;
if ($n > 10) {
    echo "big\n";
} elseif ($n > 5) {
    echo "medium\n";
} elseif ($n > 0) {
    echo "small\n";
} else {
    echo "non-positive\n";
}
$flag = false;
if ($flag) {
    echo "yes\n";
} else {
    echo "no\n";
}
if ($n > 0 && $n < 10) {
    echo "single-digit-ish\n";
}
if (! $flag) {
    echo "not flag\n";
}
