#!/usr/bin/env node
// tools/schedule-dump.mjs — pure-JS replacement for tools/schedule-dump.php.
// Parses routes/console.php (the file bootstrap/app.php registers via
// `withRouting(commands: ...)`, defaulting to routes/console.php) for
// `Schedule::command/call/exec(...)` chains and emits the same JSON the PHP
// oracle prints: {"events":[{name,expression,command,description,timezone,
//   without_overlapping,on_one_server,cron_triggerable,reason},...]}
//
// Laravel expression synthetic methods are replayed onto the framework's
// `* * * * *` base exactly like Illuminate\Console\Scheduling\ManagesFrequencies
// splices it (call order = source order); `->cron('...')` passes through.
// `_root.php`/Cli note: the PHP oracle prints COMPACT json (json_encode), so
// this writes compact json too - the two tools must stay byte-comparable.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import parser from 'php-parser';
import { parsePhpFile, appRouteFiles, callMethodName, callArgs, argValue, loadConfig, readEnvFile, configGet } from './static.mjs';

const appDir = process.env.LW_APP_ROOT || (existsSync(join(process.cwd(), 'artisan')) ? process.cwd() : null);
if (!appDir) { process.stderr.write('schedule-dump.mjs: cannot find app root\n'); process.exit(1); }

let _parser;
const phpParse = (source) => {
  _parser = _parser || new parser({ parser: { extractDoc: false }, ast: { withPositions: false } });
  return _parser.parseCode(source);
};

const strLit = (n) => {
  if (n && n.kind === 'string') return n.value;
  if (typeof n === 'string') return n;
  if (n && n.kind === 'number') return n.value;
  return null;
};

/**
 * A chain argument as a VALUE: scalars through strLit, an `[...]` literal as a
 * real array (Laravel's `days([1, 3])`), a boolean as its JS value. The
 * frequency methods receive these directly - feeding them AST nodes produced
 * '[object Object]' inside the cron expression.
 */
const valOf = (n) => {
  if (n === null || n === undefined) return n;
  if (Array.isArray(n)) return n.map(valOf);
  if (typeof n !== 'object') return n;
  if (n.kind === 'array') return (n.items || []).map((it) => valOf(it && it.kind === 'entry' ? it.value : it));
  const s = strLit(n);
  if (s !== null) return s;
  if (n.kind === 'boolean') return !!n.value;
  return n;
};

/** Mirror the PHP oracle's command-name extraction ('php artisan X' -> 'X'). */
const commandNameOf = (cmd) => {
  if (typeof cmd !== 'string') return cmd;
  const m = cmd.match(/artisan"?\s+(.*)$/i);
  if (m) return m[1].trim();
  return cmd.split(/[\\/]/).pop();
};

// ---------- the schedule timezone + Laravel's expression splicing ----------
// Laravel resolves the default event timezone as
// `config('app.schedule_timezone', config('app.timezone'))`
// (Foundation\Console\Kernel::scheduleTimezone(), :306-311) — the old code
// hardcoded 'UTC', which is only right for an app that left both keys at UTC.
const cfgEnv = readEnvFile(appDir, process.env);
let appConfig = {};
try {
  appConfig = loadConfig(appDir, cfgEnv).config || {};
} catch {
  appConfig = {};
}
const scheduleTimezone = () => {
  const v = configGet(appConfig, 'app.schedule_timezone') ?? configGet(appConfig, 'app.timezone');
  return v === null || v === undefined || v === '' ? 'UTC' : String(v);
};

/** PHP's (int) cast for a segment: '08' -> 8, 'x' -> 0. */
const phpInt = (v) => {
  const n = parseInt(String(v === null || v === undefined ? '' : v), 10);
  return Number.isFinite(n) ? n : 0;
};

/**
 * `Event::$expression` starts at '* * * * *' and every frequency method splices
 * ONE position of the CURRENT string (`spliceIntoPosition()` +
 * `hourBasedSchedule()`, ManagesFrequencies.php:404-412,674-682). The calls run
 * in SOURCE order, so the expression is built by replaying the chain from the
 * innermost call outward - the old code instead took the first cron-looking
 * step and ignored the arguments of `twiceDaily(2, 14)`-style methods.
 */
const makeState = () => ({ expr: '* * * * *' });
const splice = (state, pos, value) => {
  const segs = state.expr.split(/\s+/);
  segs[pos - 1] = String(value);
  state.expr = segs.join(' ');
};
const spliceCron = (state, value) => {
  state.expr = String(value);
};
/** `dailyAt()`/`at()`: `implode(':', ...)` -> hourBasedSchedule() (:349-368). */
const applyDailyAt = (state, time) => {
  const segs = String(time === null || time === undefined ? '0:0' : time).split(':');
  splice(state, 1, segs.length >= 2 ? phpInt(segs[1]) : 0);
  splice(state, 2, phpInt(segs[0]));
};
/** Laravel's `days($days)`: an array wins, otherwise every argument joins. */
const dayList = (args) => {
  if (args.length === 1 && Array.isArray(args[0])) return args[0].map(String).join(',');
  return args.map(String).join(',');
};
/** The last day of the CURRENT month (Laravel splices `Carbon::now()->endOfMonth()->day`). */
const lastDayOfCurrentMonth = () => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: scheduleTimezone(), year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(new Date());
    const y = Number(parts.find((p) => p.type === 'year').value);
    const m = Number(parts.find((p) => p.type === 'month').value);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  } catch {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0)).getUTCDate();
  }
};

/**
 * Replay one ManagesFrequencies method onto the expression state.
 * Returns false for a method that is not a frequency method at all (the
 * caller records it: a chain step the dump does not understand must not
 * silently become "no cron expression").
 */
const applyStep = (state, method, args) => {
  const a = args || [];
  switch (method) {
    case 'everyMinute': splice(state, 1, '*'); return true;
    case 'everyTwoMinutes': splice(state, 1, '*/2'); return true;
    case 'everyThreeMinutes': splice(state, 1, '*/3'); return true;
    case 'everyFourMinutes': splice(state, 1, '*/4'); return true;
    case 'everyFiveMinutes': splice(state, 1, '*/5'); return true;
    case 'everyTenMinutes': splice(state, 1, '*/10'); return true;
    case 'everyFifteenMinutes': splice(state, 1, '*/15'); return true;
    case 'everyThirtyMinutes': splice(state, 1, '*/30'); return true;
    case 'hourly': splice(state, 1, 0); return true;
    case 'hourlyAt': splice(state, 1, a[0] === null || a[0] === undefined ? 0 : a[0]); splice(state, 2, '*'); return true;
    case 'everyOddHour': splice(state, 1, a[0] === null || a[0] === undefined ? 0 : a[0]); splice(state, 2, '1-23/2'); return true;
    case 'everyTwoHours': splice(state, 1, a[0] === null || a[0] === undefined ? 0 : a[0]); splice(state, 2, '*/2'); return true;
    case 'everyThreeHours': splice(state, 1, a[0] === null || a[0] === undefined ? 0 : a[0]); splice(state, 2, '*/3'); return true;
    case 'everyFourHours': splice(state, 1, a[0] === null || a[0] === undefined ? 0 : a[0]); splice(state, 2, '*/4'); return true;
    case 'everySixHours': splice(state, 1, a[0] === null || a[0] === undefined ? 0 : a[0]); splice(state, 2, '*/6'); return true;
    case 'daily': splice(state, 1, 0); splice(state, 2, 0); return true;
    case 'at':
    case 'dailyAt': applyDailyAt(state, a[0]); return true;
    case 'twiceDaily': splice(state, 1, 0); splice(state, 2, `${a[0] ?? 1},${a[1] ?? 13}`); return true;
    case 'twiceDailyAt': splice(state, 1, a[2] ?? 0); splice(state, 2, `${a[0] ?? 1},${a[1] ?? 13}`); return true;
    case 'weekdays': splice(state, 5, '1-5'); return true; // MONDAY..FRIDAY
    case 'weekends': splice(state, 5, '6,0'); return true; // SATURDAY,SUNDAY
    case 'mondays': splice(state, 5, 1); return true;
    case 'tuesdays': splice(state, 5, 2); return true;
    case 'wednesdays': splice(state, 5, 3); return true;
    case 'thursdays': splice(state, 5, 4); return true;
    case 'fridays': splice(state, 5, 5); return true;
    case 'saturdays': splice(state, 5, 6); return true;
    case 'sundays': splice(state, 5, 0); return true;
    case 'days': splice(state, 5, dayList(a)); return true;
    case 'weekly': splice(state, 1, 0); splice(state, 2, 0); splice(state, 5, 0); return true;
    case 'weeklyOn': applyDailyAt(state, a[1] === null || a[1] === undefined ? '0:0' : a[1]); splice(state, 5, a[0] ?? 0); return true;
    case 'monthly': splice(state, 1, 0); splice(state, 2, 0); splice(state, 3, 1); return true;
    case 'monthlyOn': applyDailyAt(state, a[1] === null || a[1] === undefined ? '0:0' : a[1]); splice(state, 3, a[0] ?? 1); return true;
    case 'twiceMonthly': applyDailyAt(state, a[2] === null || a[2] === undefined ? '0:0' : a[2]); splice(state, 3, `${a[0] ?? 1},${a[1] ?? 16}`); return true;
    case 'lastDayOfMonth': applyDailyAt(state, a[0] === null || a[0] === undefined ? '0:0' : a[0]); splice(state, 3, lastDayOfCurrentMonth()); return true;
    case 'daysOfMonth': applyDailyAt(state, '0:0'); splice(state, 3, dayList(a)); return true;
    case 'quarterly': splice(state, 1, 0); splice(state, 2, 0); splice(state, 3, 1); splice(state, 4, '1-12/3'); return true;
    case 'quarterlyOn': applyDailyAt(state, a[1] === null || a[1] === undefined ? '0:0' : a[1]); splice(state, 3, a[0] ?? 1); splice(state, 4, '1-12/3'); return true;
    case 'yearly': splice(state, 1, 0); splice(state, 2, 0); splice(state, 3, 1); splice(state, 4, 1); return true;
    case 'yearlyOn': applyDailyAt(state, a[2] === null || a[2] === undefined ? '0:0' : a[2]); splice(state, 3, a[1] ?? 1); splice(state, 4, a[0] ?? 1); return true;
    case 'cron': if (a[0] !== null && a[0] !== undefined) spliceCron(state, a[0]); return true;
    default: return false;
  }
};

/** Chain steps for a call, outer -> inner. */
const chainSteps = (callNode) => {
  const steps = [];
  let cur = callNode;
  const seen = new Set();
  while (cur && cur.kind === 'call' && !seen.has(cur)) {
    seen.add(cur);
    const mm = (cur.what && cur.what.kind === 'propertylookup')
      ? (cur.what.offset && (cur.what.offset.name || cur.what.offset.value))
      : (cur.what && cur.what.kind === 'staticlookup')
        ? (cur.what.offset && (cur.what.offset.name || cur.what.offset.value))
        : null;
    steps.push({ method: mm, node: cur, args: callArgs(cur).map(argValue) });
    cur = cur.what && cur.what.what;
  }
  return steps;
};

const inspect = (node, seen = new Set()) => {
  if (Array.isArray(node)) { for (const c of node) inspect(c, seen); return; }
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  if (node.kind === 'call') {
    const steps = chainSteps(node);
    if (steps.length) {
      const root = steps[steps.length - 1]; // innermost: Schedule::command/call/exec
      const isSchedule = (n) => n && n.kind === 'staticlookup' && n.what && n.what.name === 'Schedule';
      const rootWhat = root.node.what;
      const facade = rootWhat && rootWhat.kind === 'staticlookup' ? (rootWhat.what && rootWhat.what.name) : null;
      if (facade === 'Schedule') {
        seen.add(node);
        // Replay the chain in SOURCE order (innermost call first; `steps` is
        // outer -> inner) onto Laravel's `* * * * *` base. Anything the dump
        // does not understand is reported instead of silently answering
        // "no cron expression" (which would drop a real cron trigger).
        const state = makeState();
        let timezone = null;
        const unknown = [];
        for (const st of steps.slice(0, -1).reverse()) {
          if (st.method === 'timezone') { const v = strLit(st.args[0]); if (v != null) timezone = v; continue; }
          if (st.method === 'description' || st.method === 'name') continue;
          if (st.method === 'withoutOverlapping' || st.method === 'onOneServer' || st.method === 'runInBackground'
            || st.method === 'evenInMaintenanceMode' || st.method === 'when' || st.method === 'skip'
            || st.method === 'environments' || st.method === 'between' || st.method === 'unlessBetween'
            || st.method === 'sendOutputTo' || st.method === 'appendOutputTo' || st.method === 'emailOutputTo'
            || st.method === 'storeOutput' || st.method === 'pingBefore' || st.method === 'thenPing'
            || st.method === 'onSuccess' || st.method === 'onFailure' || st.method === 'then' || st.method === 'tap'
            || st.method === 'graceTimeInMinutes' || st.method === 'repeat' || st.method === 'runInBackground') continue;
          if (!applyStep(state, st.method, (st.args || []).map(valOf))) unknown.push(st.method);
        }
        const expression = state.expr;
        const kind = root.method; // command | call | exec
        let rawCommand = null;
        if (kind === 'command' || kind === 'exec') rawCommand = strLit(root.args[0]);
        const descArg = root.args.length > 1 ? root.args[1] : null;
        let description = null;
        if (descArg && descArg.kind === 'array') {
          for (const e of (descArg.items || [])) {
            if (e && e.kind === 'entry' && e.key && e.key.name === 'description') description = strLit(e.value);
          }
        }
        // ::description() / ::name() chain modifier
        for (const st of steps.slice(0, -1)) {
          if (st.method === 'description') { const v = strLit(st.args[0]); if (v != null) description = v; }
        }

        if (unknown.length) {
          // Fail loud: a chain step the dump cannot model would otherwise be
          // reported as "no cron expression", and the build would silently
          // ship no cron trigger for an event that really is schedulable.
          throw new Error(
            'schedule-dump.mjs: unsupported schedule chain method(s) '
            + unknown.map((m) => '->' + m + '()').join(', ')
            + ' on the event "' + (description || commandNameOf(rawCommand) || 'closure') + '"'
          );
        }
        const command = commandNameOf(rawCommand);
        const name = description !== null && description !== undefined
          ? description
          : (command || 'closure');
        const timezoneOut = timezone !== null && timezone !== undefined ? timezone : scheduleTimezone();

        const without = steps.slice(0, -1).some((s) => s.method === 'withoutOverlapping');
        const oneServer = steps.slice(0, -1).some((s) => s.method === 'onOneServer');

        // cron_triggerable logic mirrors the PHP oracle (only checks the final expression).
        let triggerable = true, reason = null;
        const expr = expression === null || expression === '' ? null : expression;
        if (expr === null) { triggerable = false; reason = 'the event has no cron expression'; }
        else if (String(expr).trim().split(/\s+/).length !== 5) { triggerable = false; reason = 'the cron expression is not a 5-field expression'; }
        else if (String(expr).trim().startsWith('@')) { triggerable = false; reason = 'the @alias cron expressions are not supported by Cloudflare'; }

        events.push({
          name,
          expression: expression === null || expression === undefined ? null : expression,
          command,
          description,
          timezone: timezoneOut,
          without_overlapping: without,
          on_one_server: oneServer,
          cron_triggerable: triggerable,
          reason,
        });
        return;
      }
    }
    seen.add(node);
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'locend' || k === 'locstart' || k === 'leadingComments' || k === 'trailingComments' || k === 'comments' || k === 'raw' || k === 'error' || k === 'parent') continue;
    inspect(node[k], seen);
  }
};

const events = [];
let file = null;
const rf = appRouteFiles(appDir);
if (rf && rf.commands && existsSync(rf.commands)) {
  file = rf.commands;
} else if (existsSync(join(appDir, 'routes', 'console.php'))) {
  file = join(appDir, 'routes', 'console.php');
}
if (file) {
  const parsed = parsePhpFile(file);
  if (parsed.error) {
    process.stdout.write(JSON.stringify({ events, error: parsed.error }) + '\n');
    process.exit(0);
  }
  const ast = phpParse(parsed.source);
  inspect(ast);
}

process.stdout.write(JSON.stringify({ events }) + '\n');
