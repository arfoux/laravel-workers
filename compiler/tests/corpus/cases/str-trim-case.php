<?php
echo ltrim("  hi ") . "|";
echo rtrim("  hi ") . "|";
echo ucwords("hello world") . "|";
echo strrev("abcde") . "|";
echo strpos("hello world", "world") . "|";
echo strrpos("a.b.c", ".") . "|";
echo substr_count("aaa", "a") . "|";
echo strip_tags("<b>bold</b>") . "|";
echo htmlspecialchars("<a&b>") . "|";
echo trim("  hi  ") . "|";
echo trim("/path/", "/") . "|";
echo trim("abc123xyz", "a..z") . "|";
echo ltrim("0a1b", "0..9") . "|";
echo rtrim("xxyxx", "x") . "|";
echo rtrim("xyx", "") . "|";
