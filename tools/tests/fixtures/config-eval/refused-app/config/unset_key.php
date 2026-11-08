<?php

// The unset() OFFSET is not statically evaluable, so the fold cannot know which
// key PHP removed: keeping the key (or removing the wrong one) diverges from PHP.
$arr = ['a' => 1, 'b' => 2];
unset($arr[time()]);

return ['left' => $arr];
