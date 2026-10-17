<?php
$x = 2;
echo match ($x) { 1 => "one", 2, 3 => "two-three", default => "other" }, "\n";
echo match ("b") { "a" => "A", "b" => "B", default => "?" }, "\n";
echo match (5) { 1 => "x", default => "fallback" }, "\n";
$y = "2";
echo match ($y) { 2 => "int-two", "2" => "str-two", default => "none" }, "\n";
