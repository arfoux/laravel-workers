<?php
echo json_encode(["a" => 1, "b" => [1, 2]]) . "|";
echo json_encode("x/y") . "|";
echo json_encode(false) . "|";
echo json_encode(null) . "|";
$d = json_decode('{"n":5,"s":"hi"}', true);
echo $d["n"] . "|" . $d["s"] . "|";
