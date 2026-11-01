import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utcTriggersFor, observesDst, tzOffsetMinutes, PER_MINUTE } from '../../tools/schedule-utc.mjs';
import { cronMatches } from '../scheduler.mjs';

test('a UTC (or unset) timezone keeps the expression verbatim', () => {
  assert.equal(utcTriggersFor('0 9 * * *', null).trigger, '0 9 * * *');
  assert.equal(utcTriggersFor('0 9 * * *', 'UTC').trigger, '0 9 * * *');
  assert.equal(utcTriggersFor('0 9 * * *', 'Etc/UTC').trigger, '0 9 * * *');
  assert.equal(utcTriggersFor('0 9 * * *', 'UTC').strategy, 'identity');
});

test('a constant-offset zone shifts the wall clock onto its UTC instants', () => {
  // Jakarta is UTC+7 all year: 09:00 local is 02:00 UTC — the old build shipped
  // `0 9 * * *`, which fires at 16:00 local and let the runtime filter drop the
  // occurrence in silence.
  assert.equal(utcTriggersFor('0 9 * * *', 'Asia/Jakarta').trigger, '0 2 * * *');
  // A half-hour offset moves the MINUTE too: 02:30 IST (UTC+5:30) is 21:00 UTC.
  assert.equal(utcTriggersFor('30 2 * * *', 'Asia/Kolkata').trigger, '0 21 * * *');
  // A fixed negative offset (Phoenix has had no DST since 1968): 09:00 local is
  // 16:00 UTC.
  assert.equal(utcTriggersFor('0 9 * * *', 'America/Phoenix').trigger, '0 16 * * *');
  assert.equal(observesDst('Asia/Jakarta'), false);
});

test('a DST zone and an unknown zone fall back to the per-minute trigger', () => {
  // No fixed conversion is right all year for Europe/Paris, and a MISSED
  // occurrence is silent — the trigger covers every minute instead and the
  // runtime's timezone-aware filter (dueEvents) picks the exact one.
  assert.equal(utcTriggersFor('0 9 * * *', 'Europe/Paris').trigger, PER_MINUTE);
  assert.match(utcTriggersFor('0 9 * * *', 'Europe/Paris').reason, /observes DST/);
  assert.equal(observesDst('Europe/Paris'), true);
  assert.equal(utcTriggersFor('0 9 * * *', 'Not/AZone').trigger, PER_MINUTE);
  assert.match(utcTriggersFor('0 9 * * *', 'Not/AZone').reason, /not one this build can resolve/);
  assert.equal(tzOffsetMinutes('Asia/Jakarta'), 420);
});

test('a wide expression with a fixed offset uses the per-minute trigger', () => {
  const out = utcTriggersFor('*/5 * * * *', 'Asia/Jakarta');
  assert.equal(out.trigger, PER_MINUTE);
  assert.match(out.reason, /wide expression/);
});

// The property that matters: at EVERY instant, the UTC trigger fires iff the
// original expression is due in the event's own timezone (cronMatches is what
// kernel/http + src/worker run at the edge). A superset would over-fire (cheap,
// the filter narrows it); a MISSING instant is the silent bug this test exists
// for.
const WINDOW_START = Date.UTC(2027, 0, 1, 0, 0, 0);
const WINDOW_MINUTES = 14 * 24 * 60;

const fires = (expr, at, tz) => cronMatches(expr, at, tz);

test('shifted triggers cover every local occurrence and only those', () => {
  const zones = ['Asia/Jakarta', 'Asia/Kolkata', 'America/Phoenix', 'Pacific/Midway'];
  const exprs = ['0 9 * * *', '30 2 * * *', '0 0 * * *', '15 23 * * *', '0 6,18 * * *'];
  let checked = 0;
  for (const tz of zones) {
    for (const expr of exprs) {
      const { trigger, strategy } = utcTriggersFor(expr, tz);
      assert.equal(strategy, 'shifted', `${tz} ${expr} should shift`);
      for (let i = 0; i < WINDOW_MINUTES; i++) {
        const at = new Date(WINDOW_START + i * 60000);
        const local = fires(expr, at, tz);
        const utc = fires(trigger, at, 'UTC');
        assert.equal(utc, local, `${expr} @ ${tz}: ${at.toISOString()} trigger=${trigger} fired=${utc} due=${local}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 200000, `the sweep really ran (${checked} instants)`);
});

test('a day-constrained expression is a superset (the runtime filter decides)', () => {
  const tz = 'Asia/Jakarta';
  const expr = '0 9 1 * *'; // the 1st of the month, 09:00 Jakarta
  const { trigger } = utcTriggersFor(expr, tz);
  for (let i = 0; i < 40 * 24 * 60; i++) {
    const at = new Date(WINDOW_START + i * 60000);
    if (fires(expr, at, tz)) {
      assert.ok(fires(trigger, at, 'UTC'), `the trigger must fire when ${expr} is due (${at.toISOString()})`);
    }
  }
  // …and it really is a superset (the day field cannot be baked into the trigger).
  let extra = 0;
  for (let i = 0; i < 40 * 24 * 60; i++) {
    const at = new Date(WINDOW_START + i * 60000);
    if (fires(trigger, at, 'UTC') && !fires(expr, at, tz)) extra++;
  }
  assert.ok(extra > 0, 'the shifted trigger fires every day by design');
});
