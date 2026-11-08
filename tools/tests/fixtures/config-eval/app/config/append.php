<?php

$a = ['a' => 1];
$a[] = 2;
$b = ['a' => 1, 'b' => 2, 'c' => 3];
unset($b['c']);
$b[] = 4;
$c = [1, 2, 3];
unset($c[1]);
$c[] = 9;
$d = [5 => 'five'];
$d[] = 'six';
$e = ['x' => 1, 'y' => 2];
$e['z'] = 3;
$e[] = 4;

// PHP's nextFreeElement survives unset() of the highest key, survives a value
// that came from a fold function (array_merge), is NOT lowered by an explicit
// integer key, and - when the array has no integer key at all - starts at
// key+1 even when that key is negative. `nextFreeKey()`'s max+1 answers the
// first two cases as 0/2, so every one of these is a silent wrong key without
// the `__lwNext` marker (probed PHP 8.3 answers are the oracle's).
$f = [5 => 'x'];
unset($f[5]);
$f[] = 'y';
$g = [1, 2, 3];
unset($g[2]);
$g[] = 'z';
$h = array_merge([1], [2]);
unset($h[1]);
$h[] = 3;
$i = [10 => 'x'];
$i[3] = 'y';
$i[] = 'z';
$j = [-5 => 'neg'];
$j[] = 'zero';
$k = [];
$k[-5] = 'a';
$k[] = 'b';
$l = ['x' => 1];
$l[-5] = 'y';
$l[] = 'z';
$m = ['x'];
$m[-3] = 'n';
$m[] = 'z';
// PHP 8 lowered '.' BELOW '+' (php-parser still nests the PHP 7 tree), so these
// two are strings at the edge, not integers.
$n = 1 . 2 + 3;
$o = 'x' . 1 + 2;
// `<< >>` also bind TIGHTER than `.` in PHP 8 (so `'a' . 1 << 2` is 'a4', where
// PHP 7 read it as ('a' . 1) << 2 = 4). The transpiler refuses `<<`/`>>` outright
// ("unsupported operator"), so this is a fold-only form: the config path must
// still answer it.
$p = 'a' . 1 << 2;
$q = 1 << 2 . 'a';

return [
    'append_assoc' => $a,
    'unset_then_append' => $b,
    'hole_then_append' => $c,
    'numeric_then_append' => $d,
    'assoc_then_append' => $e,
    'counter_high_unset' => $f,
    'counter_mid_unset' => $g,
    'counter_after_merge' => $h,
    'counter_explicit_lower' => $i,
    'counter_negative_literal' => $j,
    'counter_empty_negative' => $k,
    'counter_string_then_negative' => $l,
    'counter_list_then_negative' => $m,
    'precedence_concat_plus' => $n,
    'precedence_concat_var_plus' => $o,
    'precedence_concat_shift_left' => $p,
    'precedence_shift_concat_right' => $q,
];
