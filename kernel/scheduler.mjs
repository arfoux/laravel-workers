// kernel/scheduler.mjs — single-trigger cron dispatcher padanan (M7).
const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const DAYS = { sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6, sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6 };

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
    if (n === 7 && min === 0) return 0; // Sunday 7 -> 0
    return n;
  }
  return min;
}
function match(date, expr) {
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
  const vals = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  // dow: 7 is Sunday alias
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

export function defineSchedule(fn) {
  const jobs = [];
  const api = {
    call(name, cron, handler) { jobs.push({ name, cron, handler }); return api; },
    run(date = new Date()) {
      const due = [];
      for (const j of jobs) if (match(date, j.cron)) due.push(j);
      return { due, async exec() { for (const j of due) await j.handler(); return due.map(d=>d.name); } };
    },
    // Exposed for tests
    _match: match,
  };
  if (typeof fn === 'function') fn(api);
  return api;
}
export default { defineSchedule };
