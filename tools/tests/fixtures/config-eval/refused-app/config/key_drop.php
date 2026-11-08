<?php

// A KEY-level refusal, not a file-level one: `intdiv()` is simply not in
// tools/php-funcs.mjs, so the key it feeds is DROPPED and named in the drop
// report while the rest of the group (and every other file) stays usable.
// `loadConfig()` must NOT set `error` for this file.
return [
    'kept' => 'yes',
    'div' => intdiv(7, 2),
];
