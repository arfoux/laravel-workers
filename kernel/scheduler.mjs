// kernel/scheduler.mjs — Scheduler (UTC cron, optional per-job/per-schedule timezone)
const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const DAYS = { sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6, sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6 };
const WD = { Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6 };

function parsePart(part, min, max) {
  if (part === '*') return null; // any
  const set = new Set();
  for (const seg of part.split(',')) {
    let step = 1;
    let range = seg;
    if (seg.includes('/')) { const [r, s] = seg.split('/'); range = r; step = Number(s) || 1; }
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const [a,b] = range.split('-');
      lo = mapToken(a, min, max); hi = mapToken(b, min, max);
    } else if (range === '') { continue; }
    else { lo = hi = mapToken(range, min, max); }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}
function mapToken(tok, min, max) {
  const low = String(tok).toLowerCase();
  if (MONTHS[low] !== undefined) return MONTHS[low];
  if (DAYS[low] !== undefined) return DAYS[low];
  const n = Number(low);
  if (!Number.isNaN(n)) {
    if (n === 7 && min === 0 && max === 7) return 0; // Sunday 7 -> 0 (dow only)
    return n;
  }
  return min;
}

function wallParts(date, timeZone) {
  if (!timeZone) {
    return { minute: date.getUTCMinutes(), hour: date.getUTCHours(), day: date.getUTCDate(), month: date.getUTCMonth() + 1, weekday: date.getUTCDay() };
  }
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  } catch (e) {
    throw new Error('Invalid timezone: ' + timeZone);
  }
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value;
  const weekday = WD[get('weekday')];
  return {
    minute: Number(get('minute')),
    hour: Number(get('hour')),
    day: Number(get('day')),
    month: Number(get('month')),
    weekday: weekday === undefined ? 0 : weekday,
  };
}

function match(date, expr, timeZone) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [mS, hS, domS, monS, dowS] = parts;
  const sets = [
    parsePart(mS, 0, 59),
    parsePart(hS, 0, 23),
    parsePart(domS, 1, 31),
    parsePart(monS, 1, 12),
    parsePart(dowS, 0, 7),
  ];
  const wp = wallParts(date, timeZone);
  const vals = [wp.minute, wp.hour, wp.day, wp.month, wp.weekday];
  for (let i = 0; i < 5; i++) {
    const set = sets[i];
    if (set === null) continue;
    let v = vals[i];
    if (i === 4) {
      if (!set.has(v) && !(v === 0 && set.has(7))) return false;
      else if (set.has(v) || (v === 0 && set.has(7))) continue;
      return false;
    }
    if (!set.has(v)) return false;
  }
  return true;
}

export function defineSchedule(fn, opts = {}) {
  const defaultTz = opts && opts.timezone;
  if (defaultTz) {
    // validate up front
    wallParts(new Date(), defaultTz);
  }
  const jobs = [];
  const api = {
    call(name, cron, handler, callOpts = {}) {
      const tz = (callOpts && callOpts.timezone) !== undefined ? callOpts.timezone : defaultTz;
      jobs.push({ name, cron, handler, timezone: tz });
      return api;
    },
    run(date = new Date()) {
      const due = [];
      for (const j of jobs) if (match(date, j.cron, j.timezone)) due.push(j);
      return { due, async exec() { for (const j of due) await j.handler(); return due.map(d => d.name); } };
    },
    _match: match,
  };
  if (typeof fn === 'function') fn(api);
  return api;
}
export default { defineSchedule };

/**
 * The cron matching the edge uses for the *dumped* Laravel schedule: does
 * `expression` fire at `date` (in `timeZone`, UTC when omitted)?
 */
export function cronMatches(expression, date = new Date(), timeZone) {
  return match(date, String(expression), timeZone);
}

/**
 * The events of a dumped Laravel schedule that are due at `date`.
 *
 * A dumped event is `{ name, expression, command, description, timezone }`
 * (the build writes `dist/src/schedule.generated.mjs`). The edge can only
 * *trigger* an event — the command itself still needs the app runtime, so the
 * caller queues it.
 */
export function dueEvents(events, date = new Date(), timeZone) {
  const list = Array.isArray(events) ? events : [];
  return list.filter((ev) => {
    const expr = ev && (ev.expression || ev.cron);
    if (!expr) return false;
    const tz = ev.timezone || timeZone;
    try {
      return match(date, String(expr), tz);
    } catch {
      return false;
    }
  });
}






