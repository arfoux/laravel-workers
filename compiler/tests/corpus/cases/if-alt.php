<?php
$n = 3;
if ($n === 1):
    echo "one\n";
elseif ($n === 2):
    echo "two\n";
else:
    echo "many\n";
endif;
if ($n > 0): echo "positive\n"; endif;
if ($n < 0):
    echo "negative\n";
endif;
