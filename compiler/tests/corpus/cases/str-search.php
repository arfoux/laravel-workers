<?php
echo str_contains("foobar", "bar") ? "T" : "F", "\n";
echo str_contains("foobar", "") ? "T" : "F", "\n";
echo str_contains("foobar", "zzz") ? "T" : "F", "\n";
echo str_starts_with("foobar", "foo") ? "T" : "F", "\n";
echo str_starts_with("foobar", "") ? "T" : "F", "\n";
echo str_ends_with("foobar", "bar") ? "T" : "F", "\n";
echo str_ends_with("foobar", "foo") ? "T" : "F", "\n";
