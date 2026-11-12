// tools/schedule-gaps.mjs — the findings the build's SCHEDULE section emits.
//
// Both of these were either silent or hand-rolled inline in `build.mjs`, which
// is how one of them (the non-triggerable event) ended up as a bare
// `console.log`: an event that ships to the worker but can never fire at the
// edge is a DECLARED gap, not a log line, and `renderReadiness` never showed it.
// The builders are pure (events in, findings out), so
// tools/tests/schedule-gaps.test.mjs pins their shape — including that every
// gap-producing event yields exactly one finding, which is the part a wiring bug
// used to erase.
import { DECLARED } from './readiness.mjs';

/**
 * One finding per schedule event that CANNOT be expressed as a Cloudflare cron
 * trigger. Cloudflare evaluates `triggers.crons` as 5-field expressions, so an
 * empty / `@alias` / 6-field expression has no trigger to hang off.
 *
 * The event is still written to `dist/src/schedule.generated.mjs` (it ships, and
 * the HTTP face `POST /__lw/cron` runs it), which is exactly why this is
 * DECLARED and not BLOCK — and why it has to reach the verdict at all.
 */
export function notTriggerableFindings(events) {
  const list = Array.isArray(events) ? events : [];
  return list
    .filter((e) => e && !e.cron_triggerable)
    .map((e) => {
      const reason = e.reason || 'not triggerable at the edge';
      return {
        route: null,
        area: 'schedule',
        severity: DECLARED,
        cause: `the schedule event "${e.name}"${e.expression ? ` (${e.expression})` : ''} is shipped to the worker but never fires at the edge — ${reason}`,
        fix: 'give the event a 5-field cron expression (`->cron("*/5 * * * *")`) so the build can emit a Cloudflare trigger, or run it outside the edge (a scheduled HTTP call from any host to `POST /__lw/cron` with the LW_CRON_SECRET secret runs the whole schedule)',
      };
    });
}

/**
 * One finding per event whose trigger had to be SHIFTED to land on the UTC
 * instants of its wall-clock expression (`tools/schedule-utc.mjs`). `mapped` is
 * that module's output: `{ event, trigger, strategy, reason }` per event.
 */
export function shiftedTriggerFindings(mapped) {
  const list = Array.isArray(mapped) ? mapped : [];
  return list
    .filter((m) => m && m.reason)
    .map((m) => ({
      route: null,
      area: 'schedule',
      severity: DECLARED,
      cause: `the schedule event "${m.event.name}" (${m.event.expression}) ships the trigger \`${m.trigger}\` — ${m.reason}`,
      fix:
        m.strategy === 'per-minute'
          ? 'the schedule still runs (the worker filters by the event timezone at fire time), but the trigger runs 1440×/day: give the event a fixed-offset timezone or `->timezone("UTC")` to collapse it to one fire per occurrence'
          : 'the trigger fires daily and the worker re-applies the day/month fields in the event timezone — nothing to do, this is how the shift works',
    }));
}
