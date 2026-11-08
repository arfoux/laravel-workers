<?php

// `static` keeps state BETWEEN calls; a folded closure would start at 0 every
// time. The old statement walk skipped the declaration silently, so whatever the
// config built from the counter was simply wrong.
$counter = function (): int {
    static $n = 0;
    $n++;

    return $n;
};

return ['static' => $counter()];
