#!/usr/bin/env node
// compiler/tests/rt-arith.test.mjs — the runtime's arithmetic (PHP 8's rules).
//
// The compiled code must answer what PHP answers: a numeric string is a
// number, a non-numeric string in an arithmetic operation is a TypeError, a
// division by zero is a DivisionByZeroError, and the modulo truncates its
// operands to int. The expectations come from PHP 8.3 itself (the probe
// output is in the commit message).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRt } from '../runtime/rt-from-context.mjs';

const rt = buildRt({}, { strict: false });

test('rt-arith: a numeric string is a number', () => {
  assert.equal(rt.add('1', '2'), 3);
  assert.equal(rt.add('1.5', 1), 2.5);
  assert.equal(rt.add(' 2', 1), 3);
  assert.equal(rt.add('2 ', 1), 3);
  assert.equal(rt.add('1e3', 0), 1000);
  assert.equal(rt.add(null, 1), 1);
  assert.equal(rt.add(true, 1), 2);
});

test('rt-arith: a string with a leading numeric part is that part (PHP warns)', () => {
  // PHP: "0x1A" + 0 => 0 (a warning, not a TypeError: the leading numeric
  // part is 0 - and NOT the hex value, which is what JavaScript's Number()
  // would parse).
  assert.equal(rt.add('0x1A', 0), 0);
  assert.equal(rt.add('12abc', 0), 12);
});

test('rt-arith: a non-numeric string in an arithmetic operation is a TypeError', () => {
  // PHP 8: "abc" + "def" => TypeError: Unsupported operand types: string + string
  assert.throws(() => rt.add('abc', 'def'), /Unsupported operand types: string \+ string/);
  assert.throws(() => rt.add('abc', 2), /Unsupported operand types: string \+ int/);
  assert.throws(() => rt.add(2, 'abc'), /Unsupported operand types: int \+ string/);
  assert.throws(() => rt.add(null, 'abc'), /Unsupported operand types: null \+ string/);
  assert.throws(() => rt.add(false, 'abc'), /Unsupported operand types: bool \+ string/);
  assert.throws(() => rt.mul('abc', 2), /Unsupported operand types: string \* int/);
  assert.throws(() => rt.sub('abc', 1), /Unsupported operand types: string - int/);
  assert.throws(() => rt.pow('abc', 2), /Unsupported operand types: string \*\* int/);
  assert.throws(() => rt.add([1, 2], 1), /Unsupported operand types: array \+ int/);
});

test('rt-arith: a division by zero is a DivisionByZeroError', () => {
  // PHP: 1/0 => DivisionByZeroError: Division by zero; 1%0 => Modulo by zero
  assert.throws(() => rt.div(1, 0), /Division by zero/);
  assert.throws(() => rt.mod(1, 0), /Modulo by zero/);
});

test('rt-arith: the modulo truncates its operands to int (PHP)', () => {
  // PHP: 7.5 % 2 => 1 (int); -7 % 2 => -1
  assert.equal(rt.mod(7.5, 2), 1);
  assert.equal(rt.mod(-7, 2), -1);
  assert.equal(rt.mod(7, 2), 1);
  assert.equal(rt.pow(2, 3), 8);
});
