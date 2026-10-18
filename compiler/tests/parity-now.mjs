#!/usr/bin/env node
// compiler/tests/parity-now.mjs — harness byte-parity untuk rt.now()
// Freeze date UTC 2024-02-29 15:04:05 UTC, bandingkan rt.now() output dengan ekspektasi PHP hardcode.

import { buildRt } from '../runtime/rt-from-context.mjs';

// Freeze Date globally — rt.now() uses new Date() internally
const FIXED_MS = Date.UTC(2024, 1, 29, 15, 4, 5);
const OrigDate = globalThis.Date;
class FrozenDate extends OrigDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_MS);
    else super(...args);
  }
  static now() { return FIXED_MS; }
  static UTC(...a) { return OrigDate.UTC(...a); }
  static parse(s) { return OrigDate.parse(s); }
}
globalThis.Date = FrozenDate;

const rt = buildRt({}, { strict: false });
const now = rt.now();

// Hardcoded PHP expectations for 2024-02-29 15:04:05 UTC
const U = '1709219045';
const U_NUM = 1709219045;

let total = 0, passed = 0, failed = 0;
function check(name, got, expected) {
  total++;
  const ok = Object.is(got, expected);
  if (ok) { passed++; console.log(`ok ${total} - ${name}`); }
  else { failed++; console.log(`not ok ${total} - ${name}`); console.log(`  ---`); console.log(`    expected: ${JSON.stringify(expected)}`); console.log(`    got:      ${JSON.stringify(got)}`); console.log(`  ...`); }
}

// 1: Y-m-d H:i:s
check("format Y-m-d H:i:s", now.format('Y-m-d H:i:s'), '2024-02-29 15:04:05');
// 2: Y-m-d
check("format Y-m-d", now.format('Y-m-d'), '2024-02-29');
// 3: H:i:s
check("format H:i:s", now.format('H:i:s'), '15:04:05');
// 4: n/j/G/g/a/A/U combined — test as single string with separators
check("format n/j/G/g/a/A/U", now.format('n/j/G/g/a/A/U'), `2/29/15/3/pm/PM/${U}`);
// 5: U alone
check("format U", now.format('U'), U);
// 6: n
check("format n", now.format('n'), '2');
// 7: j
check("format j", now.format('j'), '29');
// 8: G
check("format G", now.format('G'), '15');
// 9: g (12h)
check("format g", now.format('g'), '3');
// 10: a
check("format a", now.format('a'), 'pm');
// 11: A
check("format A", now.format('A'), 'PM');
// 12: addDays(1)
check("addDays(1) -> 2024-03-01", now.addDays(1).format('Y-m-d'), '2024-03-01');
check("addDays(1) Y-m-d H:i:s", now.addDays(1).format('Y-m-d H:i:s'), '2024-03-01 15:04:05');
// 13: subDays(1)
check("subDays(1) -> 2024-02-28", now.subDays(1).format('Y-m-d'), '2024-02-28');
// 14: addHours(24) == addDays(1)
check("addHours(24) -> 2024-03-01", now.addHours(24).format('Y-m-d H:i:s'), '2024-03-01 15:04:05');
// 15: timestamp
check("timestamp", now.timestamp, U_NUM);
// 16: getTimestamp()
check("getTimestamp()", now.getTimestamp(), U_NUM);
// 17: toDateString()
check("toDateString()", now.toDateString(), '2024-02-29');
// 18: toDateTimeString()
check("toDateTimeString()", now.toDateTimeString(), '2024-02-29 15:04:05');

console.log(`1..${total}`);
console.log(`# passed ${passed}/${total}`);
if (failed) { console.log(`# FAIL ${failed} failed`); process.exit(1); }
else { console.log(`# PASS`); }

globalThis.Date = OrigDate;
