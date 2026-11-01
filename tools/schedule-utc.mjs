// tools/schedule-utc.mjs — turn a Laravel schedule event into the Cloudflare
// Cron Trigger that actually fires at the right instant.
//
// Why this exists: a Cloudflare Cron Trigger is evaluated in UTC, but a Laravel
// event is a WALL-CLOCK expression in the app's timezone (`config('app.timezone')`
// — Laravel copies it onto every event, verified on framework 13.37). The build
// used to copy the expression verbatim, so a `->dailyAt('09:00')` in a
// `Asia/Jakarta` app became the trigger `0 9 * * *` — 09:00 **UTC** = 16:00
// Jakarta. The trigger fires once a day, the runtime's tz-aware filter
// (`kernel/scheduler.mjs dueEvents`) sees 16:00 local, decides nothing is due,
// and the job silently never runs. Nothing in the build said so: the schedule
// was configured, the trigger existed, the queue stayed empty.
//
// The trigger only has to FIRE at the event's UTC instants — the runtime filter
// (`dueEvents`, which does use `Intl` with the event's IANA timezone, so DST is
// handled there) decides whether the occurrence is due. Three strategies:
//
//   identity    the timezone is UTC (or unset): the expression is already UTC.
//   shifted     the timezone has a CONSTANT UTC offset for the whole year (most
//               zones people actually deploy with): every local occurrence maps
//               onto exactly one UTC instant, so the minute/hour fields are
//               shifted and the trigger stays one fire per occurrence. The
//               day/month fields are dropped (`* * * *`) because the UTC date of
//               a shifted instant may be the day before; the runtime filter
//               re-applies them in the event's own timezone.
//   per-minute  the timezone OBSERVES DST (or uses a half-hour offset that
//               changes): a fixed conversion is wrong for part of the year, and
//               a wrong trigger is a silently missing occurrence — so the
//               trigger is `* * * * *` and the runtime filter picks the exact
//               minute. Correct for every zone; costs 1440 fires/day.
export const PER_MINUTE = '* * * * *';

/** The UTC offset (minutes) the zone is at for `at`. */
export function tzOffsetMinutes(timeZone, at = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]));
  // `hour12:false` can print midnight as 24; Date.UTC rolls that into the next
  // day, which is the same instant, so the offset stays right.
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * Does the zone change its offset within the year `at` sits in? `null` when the
 * zone name is not a timezone JS knows (the caller reports that loudly).
 */
export function observesDst(timeZone, at = new Date()) {
  let jan;
  let jul;
  try {
    jan = tzOffsetMinutes(timeZone, new Date(Date.UTC(at.getUTCFullYear(), 0, 1)));
    jul = tzOffsetMinutes(timeZone, new Date(Date.UTC(at.getUTCFullYear(), 6, 1)));
  } catch {
    return null;
  }
  return jan !== jul;
}

const isUtcName = (tz) => /^(utc|etc\/utc|gmt|z)$/i.test(String(tz || '').trim());

/** Parse one cron field into the sorted set of values it selects. */
function parseField(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    const seg = part.trim();
    if (seg === '*') {
      for (let v = min; v <= max; v++) out.add(v);
      continue;
    }
    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(seg);
    let lo = min;
    let hi = max;
    let step = 1;
    if (stepMatch) {
      step = Number(stepMatch[2]);
      if (!(step > 0)) return null;
      const range = stepMatch[1];
      if (range !== '*') {
        const [a, b] = range.split('-').map(Number);
        lo = a;
        hi = b === undefined ? max : b;
      }
    } else if (seg.includes('-')) {
      const [a, b] = seg.split('-').map(Number);
      lo = a;
      hi = b;
    } else if (/^\d+$/.test(seg)) {
      lo = Number(seg);
      hi = lo;
    } else {
      return null; // names (JAN, MON) and @aliases are refused by the dump already
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const list = (set) => [...set].sort((a, b) => a - b).join(',');

/**
 * The UTC trigger for one dumped event.
 *   { trigger, strategy: 'identity'|'shifted'|'per-minute', reason }
 * `reason` is null unless the caller has something to tell the operator.
 */
export function utcTriggersFor(expression, timeZone, at = new Date()) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) {
    return { trigger: null, strategy: null, reason: 'the cron expression is not 5-field' };
  }
  if (!timeZone || isUtcName(timeZone)) return { trigger: fields.join(' '), strategy: 'identity', reason: null };

  const dst = observesDst(timeZone, at);
  if (dst === null) {
    return {
      trigger: PER_MINUTE,
      strategy: 'per-minute',
      reason: `the timezone "${timeZone}" is not one this build can resolve`,
    };
  }
  if (dst) {
    return {
      trigger: PER_MINUTE,
      strategy: 'per-minute',
      reason:
        `"${timeZone}" observes DST, so no fixed UTC conversion of \`${expression}\` is right all year: ` +
        `the trigger is \`${PER_MINUTE}\` and the worker's timezone-aware filter picks the exact minute ` +
        '(1440 fires/day — set the event to `->timezone("UTC")` to get one fire per occurrence)',
    };
  }

  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  if (!minutes || !hours) {
    return {
      trigger: PER_MINUTE,
      strategy: 'per-minute',
      reason: `the cron expression \`${expression}\` uses syntax this build cannot shift to UTC`,
    };
  }
  const offset = tzOffsetMinutes(timeZone, at);
  const utcMinutes = new Set();
  const utcHours = new Set();
  for (const h of hours) {
    for (const m of minutes) {
      const shifted = (((h * 60 + m - offset) % 1440) + 1440) % 1440;
      utcHours.add(Math.floor(shifted / 60));
      utcMinutes.add(shifted % 60);
    }
  }
  // A large cartesian product (e.g. every minute of a range) is cheaper as the
  // per-minute trigger, which the runtime filter then narrows.
  if (utcMinutes.size * utcHours.size > 60) {
    return {
      trigger: PER_MINUTE,
      strategy: 'per-minute',
      reason: `\`${expression}\` in "${timeZone}" is a wide expression; the trigger is \`${PER_MINUTE}\``,
    };
  }
  const dayFieldsKept = fields[2] === '*' && fields[4] === '*' && fields[3] === '*';
  const reason = dayFieldsKept
    ? null
    : `\`${expression}\` in "${timeZone}" is shifted to UTC \`${list(utcMinutes)} ${list(utcHours)} * * *\`: ` +
      'the trigger fires every day and the worker\'s timezone-aware filter re-applies the day/month fields ' +
      "(a UTC shift can move the calendar day, so they cannot be baked into the trigger)";
  return { trigger: `${list(utcMinutes)} ${list(utcHours)} * * *`, strategy: 'shifted', reason };
}

export default { utcTriggersFor, tzOffsetMinutes, observesDst };
