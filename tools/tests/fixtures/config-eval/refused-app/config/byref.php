<?php

// A reference has no value semantics in the fold: `$v = 'z'` would write a COPY
// and the array would keep 'a', so the fold refuses rather than answering a
// plausible-but-wrong value.
$items = ['a'];
foreach ($items as &$v) {
    $v = 'z';
}
unset($v);

return ['byref' => $items];
