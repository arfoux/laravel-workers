<?php

// A DECLARATION is inert where it stands: PHP registers the name and runs
// nothing, so a config file may declare a helper class, interface, trait, enum
// or function and still return its array. The statement path used to refuse
// every one of them ("statement 'function' is not modelled..."), which poisoned
// the whole group over a statement that cannot change a single value (the fold
// answered an empty group where PHP answers every key below). USING one is
// still refused by name at the use site (see refused-app/config/declared_call.php).
// `const NAME = ...;` is readable from that point on, so the fold records it.
const LW_LIMIT = 10;
const LW_NAME = 'laravel-workers';
const LW_SUM = LW_LIMIT + 5;

function lw_declared_helper(): int
{
    return 1;
}

class LwDeclaredThing
{
    public const N = 3;
}

interface LwDeclaredIface
{
}

trait LwDeclaredTrait
{
}

enum LwDeclaredEnum: int
{
    case A = 1;
}

$config = [
    'limit' => LW_LIMIT,
    'name' => LW_NAME,
    'sum' => LW_SUM,
];

// `LwDeclaredThing::N` is deliberately NOT read here: a class the CONFIG FILE
// declares inline is not in the fold's class map, so `::N` would be a (named,
// loud) drop. Declarations are inert; their uses refuse.
return $config;
