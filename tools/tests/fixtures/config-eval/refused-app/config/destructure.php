<?php

// `foreach ($rows as [$name, $n])` — the fold reads the destructor as a property
// name and wrote scope[undefined], so every later read of $name/$n dropped the
// key it fed while PHP had a value. Refused (and the file is reported) instead.
$out = [];
foreach ([['a', 1], ['b', 2]] as [$name, $n]) {
    $out[$name] = $n;
}

return ['destructured' => $out];
