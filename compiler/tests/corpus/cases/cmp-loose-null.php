<?php
echo (null == false) ? "T" : "F", "\n";
echo (null == 0) ? "T" : "F", "\n";
echo (null == "") ? "T" : "F", "\n";
echo (null == "0") ? "T" : "F", "\n";
echo (null === false) ? "T" : "F", "\n";
echo (false == "") ? "T" : "F", "\n";
echo (false == 0) ? "T" : "F", "\n";
echo ("0" == false) ? "T" : "F", "\n";
echo (0 == "") ? "T" : "F", "\n";
echo ([] == null) ? "T" : "F", "\n";
