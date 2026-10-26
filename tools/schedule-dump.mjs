#!/usr/bin/env node
// tools/schedule-dump.mjs — pure-JS replacement for tools/schedule-dump.php.
// Parses routes/console.php (the file bootstrap/app.php registers via
// `withRouting(commands: ...)`, defaulting to routes/console.php) for
// `Schedule::command/call/exec(...)` chains and emits the same JSON the PHP
// oracle prints: {"events":[{name,expression,command,description,timezone,
//   without_overlapping,on_one_server,cron_triggerable,reason},...]}
//
// Laravel expression synthetic methods map to cron (5-field, UTC) in the same
// way the framework's `Expression` class does; `->cron('...')` passes through.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import parser from 'php-parser';
import { parsePhpFile, appRouteFiles, callMethodName, callArgs, argValue } from './static.mjs';

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

/** Mirror the PHP oracle's command-name extraction ('php artisan X' -> 'X'). */
const commandNameOf = (cmd) => {
  if (typeof cmd !== 'string') return cmd;
  const m = cmd.match(/artisan"?\s+(.*)$/i);
  if (m) return m[1].trim();
  return cmd.split(/[\\/]/).pop();
};

/** Laravel's synthetic schedule frequencies -> 5-field cron (UTC). */
const EXPR_METHODS = {
  everyMinute: () => '* * * * *',
  everyTwoMinutes: () => '*/2 * * * *',
  everyThreeMinutes: () => '*/3 * * * *',
  everyFourMinutes: () => '*/4 * * * *',
  everyFiveMinutes: () => '*/5 * * * *',
  everyTenMinutes: () => '*/10 * * * *',
  everyFifteenMinutes: () => '*/15 * * * *',
  everyThirtyMinutes: () => '0,30 * * * *',
  hourly: () => '0 * * * *',
  everyTwoHours: () => '0 */2 * * *',
  everyThreeHours: () => '0 */3 * * *',
  everyFourHours: () => '0 */4 * * *',
  everySixHours: () => '0 */6 * * *',
  daily: () => '0 0 * * *',
  at: (when) => atCron('0 0 * * *', when),
  dailyAt: (when) => atCron('0 0 * * *', when),
  twiceDaily: () => '0 1,13 * * *',
  twiceDailyAt: (h1, h2) => `0 ${h1 || 1},${h2 || 13} * * *`,
  weekdays: () => '0 0 * * 1-5',
  weekends: () => '0 0 * * 0,6',
  monday: () => '0 0 * * 1',
  tuesday: () => '0 0 * * 2',
  wednesday: () => '0 0 * * 3',
  thursday: () => '0 0 * * 4',
  friday: () => '0 0 * * 5',
  saturday: () => '0 0 * * 6',
  sunday: () => '0 0 * * 0',
  weekly: () => '0 0 * * 0',
  weeklyOn: (d, time) => weeklyOnCron(d, time),
  monthly: () => '0 0 1 * *',
  monthlyOn: (day, time) => atCron('0 0 1 * *', time || '00:00', day),
  twiceMonthly: (d1, d2) => `0 0 ${d1 || 1},${d2 || 16} * *`,
  quarterly: () => '0 0 1 1,4,7,10 *',
  yearly: () => '0 0 1 1 *',
  annually: () => '0 0 1 1 *',
  timezone: () => null, // modifier, not an expression
};

const atCron = (base, when, day) => {
  const t = parseTime(when);
  if (!t) return base;
  const [min, hour] = t;
  const baseParts = base.split(' ');
  if (day) baseParts[2] = String(day);
  return `${min} ${hour} ${baseParts[2]} ${baseParts[3]} ${baseParts[4]}`;
};
const weeklyOnCron = (day, time) => {
  const t = parseTime(time);
  const days = ['0', '1', '2', '3', '4', '5', '6'];
  const d = days[day % 7];
  return t ? `${t[0]} ${t[1]} * * ${d}` : `0 0 * * ${d}`;
};
const parseTime = (when) => {
  const s = String(when || '');
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hour = Number(m[1]) % 24, min = Number(m[2]) % 60;
  // Laravel emits bare numbers (no zero-padding): '0 13 * * *', '30 8 * * 1'.
  return [String(min), String(hour)];
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
        // expression: first outer call that yields a cron string
        let expression = null;
        let timezone = null;
        for (const st of steps.slice(0, -1)) {
          if (st.method === 'cron') { const v = strLit(st.args[0]); if (v != null) expression = v; }
          else if (st.method === 'timezone') { const v = strLit(st.args[0]); if (v != null) timezone = v; }
          else if (EXPR_METHODS[st.method]) {
            const e = EXPR_METHODS[st.method](...(st.args || []).map(strLit));
            if (e) expression = expression || e;
          }
        }
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

        const command = commandNameOf(rawCommand);
        const name = description !== null && description !== undefined
          ? description
          : (command || 'closure');
        const timezoneOut = timezone !== null && timezone !== undefined ? timezone : 'UTC';

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

process.stdout.write(JSON.stringify({ events }, null, 2) + '\n');
