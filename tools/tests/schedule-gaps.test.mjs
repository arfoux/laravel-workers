// tools/tests/schedule-gaps.test.mjs — the two findings the build's schedule
// section emits, and the shapes they must have.
//
// WHY THIS FILE EXISTS. A schedule event the build cannot express as a
// Cloudflare cron trigger (an empty / `@alias` / 6-field expression) is still
// written to `dist/src/schedule.generated.mjs` — it SHIPS — but nothing at the
// edge can fire it. That is a DECLARED gap, and it has to reach the verdict the
// way every other shipped-but-gapped decision does. It used to be a bare
// `console.log`, so `renderReadiness` never showed it: an operator reading the
// readiness report saw RUNS ON THE EDGE for an app whose one scheduled job
// never runs. The findings are built here (pure: events in, findings out) so
// this file pins the shape a wiring bug would otherwise erase.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { notTriggerableFindings, shiftedTriggerFindings } from '../schedule-gaps.mjs';
import { BLOCK, DECLARED, verdictOf, VERDICT, renderReadiness } from '../readiness.mjs';

test('every non-triggerable event yields exactly one DECLARED finding (#S50)', () => {
  const events = [
    { name: 'reports:send', expression: '* * * * *', cron_triggerable: true, reason: null },
    { name: 'cleanup', expression: '', cron_triggerable: false, reason: 'the event has no cron expression' },
    { name: 'heartbeat', expression: '@daily', cron_triggerable: false, reason: 'the @alias cron expressions are not supported by Cloudflare' },
  ];
  const findings = notTriggerableFindings(events);
  assert.equal(findings.length, 2, 'one finding per gap, and none for the triggerable event');
  for (const f of findings) {
    assert.equal(f.severity, DECLARED, 'the event ships - the gap is declared, not blocking');
    assert.equal(f.area, 'schedule');
    assert.equal(f.route, null, 'a schedule event belongs to no route');
    assert.match(f.fix, /5-field cron expression/);
  }
  // The reason reaches the reader verbatim: a wrong cause is worse than none.
  assert.match(findings[1].cause, /@alias cron expressions are not supported by Cloudflare/);
  // An event with an expression names it; one without does not print " ()".
  assert.match(findings[0].cause, /"cleanup"/);
  assert.doesNotMatch(findings[0].cause, /\(\)/);
});

test('a non-triggerable event turns the verdict into DECLARED GAPS, not plain RUNS', () => {
  // The regression: with only a `console.log`, the verdict below printed
  // RUNS ON THE EDGE while the event could never fire.
  const findings = notTriggerableFindings([
    { name: 'cleanup', expression: null, cron_triggerable: false, reason: 'the event has no cron expression' },
  ]);
  assert.equal(verdictOf(findings), VERDICT.GAPS);
  const report = renderReadiness(findings);
  assert.match(report, /declared gaps/);
  assert.match(report, /"cleanup".*never fires at the edge/);
  assert.doesNotMatch(report, /READINESS: RUNS ON THE EDGE/, 'a shipped-but-dead event is not a clean run');
});

test('a triggerable-only schedule reports no gaps', () => {
  const findings = notTriggerableFindings([
    { name: 'ok', expression: '*/5 * * * *', cron_triggerable: true, reason: null },
  ]);
  assert.deepEqual(findings, []);
  assert.equal(verdictOf(findings), VERDICT.RUNS);
});

test('a shifted trigger is DECLARED and its fix follows the strategy', () => {
  const mapped = [
    { event: { name: 'daily', expression: '0 9 * * *', timezone: 'Asia/Jakarta' }, trigger: '0 * * * *', strategy: 'per-minute', reason: 'the timezone has a fractional-hour offset' },
    { event: { name: 'monthly', expression: '0 0 1 * *', timezone: 'Asia/Jakarta' }, trigger: '0 17 * * *', strategy: 'shifted', reason: 'the expression is a wall-clock time in Asia/Jakarta' },
    { event: { name: 'utc', expression: '0 9 * * *', timezone: 'UTC' }, trigger: '0 9 * * *', strategy: 'exact', reason: null },
  ];
  const findings = shiftedTriggerFindings(mapped);
  assert.equal(findings.length, 2, 'a `reason: null` mapping is not a gap');
  assert.equal(findings[0].severity, DECLARED);
  assert.match(findings[0].cause, /`0 \* \* \* \*`/, 'the shifted TRIGGER is named, not the source expression');
  assert.match(findings[0].cause, /fractional-hour offset/);
  assert.match(findings[0].fix, /1440×\/day/, 'the per-minute strategy warns about the trigger rate');
  assert.match(findings[1].fix, /nothing to do/, 'the shifted-daily strategy is the normal case');
  // None of these is blocking: the schedule still runs.
  assert.equal(verdictOf(findings), VERDICT.GAPS);
  assert.ok(!findings.some((f) => f.severity === BLOCK));
});
