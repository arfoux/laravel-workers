<?php

// `sort()` returns a bool that nothing consumes, and it sorts IN PLACE: the fold
// cannot see the mutation, so the array it keeps is in a different order than
// PHP's. A refused expression statement has no key to name, which is exactly the
// state-divergence the file-level report exists for.
$arr = [3, 1, 2];
sort($arr);

return ['sorted' => $arr];
