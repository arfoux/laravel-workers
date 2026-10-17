<?php
foreach ([1, 2, 3, 9] as $n) {
    switch ($n) {
        case 1:
            echo "one";
            break;
        case 2:
        case 3:
            echo "two-or-three";
            break;
        default:
            echo "other";
    }
    echo ";";
}
echo "\n";
