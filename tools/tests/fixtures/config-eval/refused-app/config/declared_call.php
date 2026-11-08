<?php

// `declarations.php` in the fixture app proves that a DECLARATION is inert. This
// file proves the other half: USING one is refused by name. The fold does not
// implement the app's own functions, so `lw_call_helper()` has no value - and an
// expression statement whose value nothing consumes is exactly the state
// divergence the statement path poisons a file for... unless the refusal was
// REPORTED, which it is here (a drop naming the function). So this file stays a
// usable group whose return value is exact, plus one drop the report names.
function lw_call_helper(): int
{
    return 1;
}

lw_call_helper();

return ['kept' => 'yes'];
