<?php

// `try`/`catch`/`finally` is control flow the statement path does not model: the
// old walk ran the try block and IGNORED the finally block, and a throw would
// have taken a different branch than PHP's.
try {
    $value = 'from-try';
} catch (Throwable $e) {
    $value = 'from-catch';
} finally {
    $done = true;
}

return ['try' => $value, 'done' => $done];
