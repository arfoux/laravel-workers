// kernel/scheduler.mjs — Scheduler (UTC cron, optional per-job/per-schedule timezone)
const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const DAYS = { sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6, sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6 };
const WD = { Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6 };

// The alias table belongs to the field (the month names are not weekday
// names): the cron library keeps them apart and an unknown name makes the
// expression invalid.
function parsePart(part, min, max, aliases) {
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
      lo = mapToken(a, min, max, aliases); hi = mapToken(b, min, max, aliases);
    } else if (range === '') { continue; }
    else { lo = hi = mapToken(range, min, max, aliases); }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}
function mapToken(tok, min, max, aliases) {
  const low = String(tok).toLowerCase();
  if (aliases && aliases[low] !== undefined) return aliases[low];
  const n = Number(low);
  if (!Number.isNaN(n)) {
    if (n === 7 && min === 0 && max === 7) return 0; // Sunday 7 -> 0 (dow only)
    return n;
  }
  // An unknown token is an invalid expression (the cron library throws).
  throw new Error('invalid CRON field value ' + tok);
}

// The day-of-month part: the set plus the 'L' form (the last day of the
// month) - the cron library's DayOfMonthField.
function parseDayOfMonth(part) {
  if (part === '*' || part === '?') return null; // any
  const set = new Set();
  let last = false;
  for (const seg of part.split(',')) {
    const t = seg.trim();
    if (/^L$/i.test(t)) { last = true; continue; }
    const s = parsePart(t, 1, 31, null);
    if (s) for (const v of s) set.add(v);
  }
  return { set, last };
}

// The day-of-week part: the set plus the 'L' form (the last <weekday> of the
// month) and the '#' form (the n-th <weekday>) - the cron library's
// DayOfWeekField.
function parseDayOfWeek(part) {
  if (part === '*' || part === '?') return null; // any
  const set = new Set();
  const lastOf = new Set();
  const nth = [];
  for (const seg of part.split(',')) {
    const t = seg.trim();
    const m = /^(\d+)#(\d+)$/.exec(t);
    if (m) { nth.push({ dow: Number(m[1]) % 7, n: Number(m[2]) }); continue; }
    const lm = /^(\d+)L$/i.exec(t);
    if (lm) { lastOf.add(Number(lm[1]) % 7); continue; }
    const s = parsePart(t, 0, 7, DAYS);
    if (s) for (const v of s) set.add(v);
  }
  return { set, lastOf, nth };
}

// The number of days in a month (the 'L' forms need it).
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// The day of the month of the last <weekday> of the month.
function lastWeekdayOfMonth(year, month, weekday) {
  const last = daysInMonth(year, month);
  for (let d = last; d > last - 7; d--) {
    if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === weekday) return d;
  }
  return -1;
}

// The day of the month of the n-th <weekday> of the month.
function nthWeekdayOfMonth(year, month, weekday, n) {
  const last = daysInMonth(year, month);
  for (let d = 1; d <= 7 && d <= last; d++) {
    if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === weekday) {
      const day = d + (n - 1) * 7;
      return day <= last ? day : -1;
    }
  }
  return -1;
}

function wallParts(date, timeZone) {
  if (!timeZone) {
    return { minute: date.getUTCMinutes(), hour: date.getUTCHours(), day: date.getUTCDate(), month: date.getUTCMonth() + 1, year: date.getUTCFullYear(), weekday: date.getUTCDay() };
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
    year: Number(get('year')),
    weekday: weekday === undefined ? 0 : weekday,
  };
}

function match(date, expr, timeZone) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [mS, hS, domS, monS, dowS] = parts;
  const sets = [
    parsePart(mS, 0, 59, null),
    parsePart(hS, 0, 23, null),
    null,
    parsePart(monS, 1, 12, MONTHS),
    null,
  ];
  const dom = parseDayOfMonth(domS);
  const dow = parseDayOfWeek(dowS);
  const wp = wallParts(date, timeZone);
  const vals = [wp.minute, wp.hour, wp.day, wp.month, wp.weekday];
  for (let i = 0; i < 2; i++) {
    const set = sets[i];
    if (set === null) continue;
    if (!set.has(vals[i])) return false;
  }
  // The month.
  const monSet = sets[3];
  if (monSet !== null && !monSet.has(wp.month)) return false;
  // The day: the cron library ORs the day-of-month and the day-of-week when
  // BOTH are restricted (the classic cron rule) - '0 0 1 * 1' fires on the
  // 1st AND on every Monday.
  const domMatch = dom === null ? true : dayOfMonthMatches(dom, wp);
  const dowMatch = dow === null ? true : dayOfWeekMatches(dow, wp);
  if (dom !== null && dow !== null) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

function dayOfMonthMatches(dom, wp) {
  if (dom.set.has(wp.day)) return true;
  if (dom.last) {
    const last = daysInMonth(wp.year, wp.month);
    if (wp.day === last) return true;
  }
  return false;
}

function dayOfWeekMatches(dow, wp) {
  if (dow.set.has(wp.weekday) || (wp.weekday === 0 && dow.set.has(7))) return true;
  for (const d of dow.lastOf) {
    if (d !== wp.weekday) continue;
    if (lastWeekdayOfMonth(wp.year, wp.month, d) === wp.day) return true;
  }
  for (const nth of dow.nth) {
    if (nth.dow !== wp.weekday) continue;
    if (nthWeekdayOfMonth(wp.year, wp.month, nth.dow, nth.n) === wp.day) return true;
  }
  return false;
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






