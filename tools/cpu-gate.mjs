#!/usr/bin/env node
// tools/cpu-gate.mjs — the CPU gate from the PLATFORM's own numbers (#434/#443).
//
// `tools/bench.mjs` measures the hot paths on whatever Node machine runs the
// gate: a fast regression detector, but NOT the budget that matters. The budget
// is workerd's `cpu_ms` (Workers Free: 10 ms per request), and the only honest
// source is the runtime itself: `wrangler tail --format json` reports
// `cpuTime` and `outcome` per request. This gate deploys a probe worker that
// runs the REAL kernel hot paths, drives a CONTINUOUS load through one
// connection, and reads the platform's numbers back.
//
//   node tools/cpu-gate.mjs                    # measure, assert, delete the probe
//   node tools/cpu-gate.mjs --keep              # leave the probe worker deployed
//   node tools/cpu-gate.mjs --requests 400 --n 50
//
// `--n` is the iterations PER OP (`router`/`validator`/`Str`/`Collection`/PHP
// json) inside one request: on the Free plan ~100 iterations of one op costs
// ~2 ms CPU, so the default 50 x 5 ops is roughly a page's worth of kernel work.
//   node tools/cpu-gate.mjs --p50 10 --p95 50   # the Workers Free budget
//   node tools/cpu-gate.mjs --burn-ms 3000      # the enforcement control size
//   node tools/cpu-gate.mjs --help              # the full flag list
//
// Three things are measured:
//   1. `page-like` - the kernel hot paths (router/validator/Str/Collection/PHP
//      json) at a realistic size. Every request must answer `ok`, and the
//      percentiles must fit the budget.
//   2. `enforcement-control` - one request that burns far past the budget. It
//      MUST come back not-`ok` (`exceededCpu`), otherwise this gate cannot see
//      enforcement at all and is worthless; the burst tolerance of a fresh
//      isolate makes a single over-budget request pass, which is exactly why
//      the control is big. `--no-enforcement-check` skips it (e.g. on Paid).
//   3. `sustained` (opt-in, `--sustained-ms`) - a continuous burn per request:
//      with enough back-to-back requests the isolate's rollover bank empties,
//      which is the only way to see the limit on real traffic.
//
// It needs a logged-in `wrangler` (the release/verification process runs it;
// `gate:ci` cannot - CI has no Cloudflare credentials). Exit 0 = every
// assertion held; exit 1 otherwise.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

// The tuning surface: `--name` (the probe worker), `--keep` (leave it deployed),
// `--requests` / `--n` / `--concurrency` (the load), `--p50` / `--p95` (the
// assertion, defaulting to the Workers Free budget), `--burn-ms` (the
// enforcement control's size), `--sustained-ms` (the per-request burn of the
// opt-in sustained load), and `--no-enforcement-check` (Paid plans, where a burn
// is not expected to be killed).
const NAME = String(arg('name', 'lw-cpu-probe'));
const KEEP = arg('keep', false) === true;
const REQUESTS = Number(arg('requests', 200));
const N = Number(arg('n', 50));
const CONCURRENCY = Number(arg('concurrency', 4));
const P50 = Number(arg('p50', 10));
const P95 = Number(arg('p95', 50));
const BURN_MS = Number(arg('burn-ms', 3000));
const SUSTAINED_MS = Number(arg('sustained-ms', 0));
const ENFORCEMENT = arg('no-enforcement-check', false) !== true;

// `--help` before anything side-effecting: without this, a bare `--help` would
// DEPLOY a probe worker (every flag it does not recognize is ignored).
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    'usage: node tools/cpu-gate.mjs [--name <worker>] [--keep] [--requests N] [--n N] [--concurrency N]\n' +
      '                              [--p50 MS] [--p95 MS] [--burn-ms MS] [--sustained-ms MS]\n' +
      '                              [--no-enforcement-check]\n\n' +
      'Deploys a probe worker, drives a load through the real kernel hot paths, reads the\n' +
      "platform's own cpuTime/outcome back through `wrangler tail`, asserts them, then deletes\n" +
      'the worker. See the header of this file for what each stage measures.\n'
  );
  process.exit(0);
}

const localBin = process.platform === 'win32'
  ? join(ROOT, 'node_modules', '.bin', 'wrangler.cmd')
  : join(ROOT, 'node_modules', '.bin', 'wrangler');
const localWrangler = existsSync(localBin) ? localBin : null;
// No local install: `npx wrangler ...` - the package must be NAMED, or npx
// would fetch a different package that happens to be called `deploy`.
const WRANGLER = process.env.LW_WRANGLER || localWrangler || 'npx';
const WRANGLER_PREFIX = process.env.LW_WRANGLER || localWrangler ? [] : ['wrangler'];

const run = (args, opts = {}) =>
  spawnSync(WRANGLER, [...WRANGLER_PREFIX, ...args], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', ...opts });

// --- 1. the probe project: a byte-identical copy of the kernel + one entry ---
const dir = mkdtempSync(join(tmpdir(), 'lw-cpu-gate-'));
cpSync(join(ROOT, 'kernel'), join(dir, 'kernel'), { recursive: true });
const bcryptSrc = join(ROOT, 'node_modules', 'bcryptjs');
if (existsSync(bcryptSrc)) {
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  try {
    symlinkSync(bcryptSrc, join(dir, 'node_modules', 'bcryptjs'), 'junction');
  } catch {
    /* a second gate run in the same second can race the junction */
  }
}

writeFileSync(
  join(dir, 'wrangler.jsonc'),
  JSON.stringify({ name: NAME, main: './probe.mjs', compatibility_date: '2026-01-01', workers_dev: true }, null, 2) + '\n'
);

writeFileSync(
  join(dir, 'probe.mjs'),
  `// The ops are the kernel's hot paths, entered the way a request enters them.
const OPS = ['router', 'validator', 'str', 'collection', 'json'];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const op = url.searchParams.get('op') || 'all';
    const n = Math.min(Number(url.searchParams.get('n') || 100), 200000);

    if (op === 'sustained') {
      // A CONTINUOUS burn: a per-request budget says nothing about a burst (the
      // isolate pays into a rollover bank and only dies when the bank is dry).
      const ms = Math.min(Number(url.searchParams.get('ms') || 3000), 30000);
      const deadline = Date.now() + ms;
      let loops = 0;
      let acc = 0;
      while (Date.now() < deadline) {
        for (let i = 0; i < 20000; i++) acc += Math.sqrt(i) % 7;
        loops++;
      }
      return Response.json({ op, ms, loops, acc: acc % 1000 });
    }

    const wanted = op === 'all' ? OPS : [op];
    const out = {};
    for (const o of wanted) out[o] = await run(o, n);
    return Response.json({ n, ops: out });
  },
};

async function run(op, n) {
  const t0 = Date.now();
  switch (op) {
    case 'router': {
      const { normalizeTable, match } = await import('./kernel/router.mjs');
      const table = normalizeTable([{ uri: 'posts/{post}', methods: ['GET'] }]);
      for (let i = 0; i < n; i++) match(table, { method: 'GET', path: '/posts/' + (i % 20) });
      break;
    }
    case 'validator': {
      const { Validator } = await import('./kernel/validator.mjs');
      const rules = 'required|string|max:10|min:2';
      for (let i = 0; i < n; i++) new Validator({ name: 'x' + i }, { name: rules }).passes();
      break;
    }
    case 'str': {
      const { str } = await import('./kernel/str.mjs');
      for (let i = 0; i < n; i++) str.slug('žluťoučký kůň ' + i);
      break;
    }
    case 'collection': {
      const { Collection } = await import('./kernel/collections.mjs');
      const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, name: 'r' + i, score: (i * 37) % 11 }));
      for (let i = 0; i < n; i++) new Collection(rows).where('score', '>', 3).sortBy('name').values();
      break;
    }
    case 'json': {
      const { phpJsonEncode } = await import('./kernel/php-json.mjs');
      for (let i = 0; i < n; i++) phpJsonEncode({ a: i, b: 'x'.repeat(24), c: [1, 2, 3] });
      break;
    }
    case 'bcrypt': {
      const { makeSync } = await import('./kernel/hash.mjs');
      for (let i = 0; i < n; i++) makeSync('pw' + i, { rounds: 6 });
      break;
    }
    default:
      return { error: 'unknown op ' + op };
  }
  return { ms: Date.now() - t0 };
}
`
);

// --- 2. deploy ---
process.stdout.write(`cpu-gate: deploying ${NAME} (kernel copy: ${dir})\n`);
const deployed = run(['deploy', '--config', join(dir, 'wrangler.jsonc')]);
const deployText = `${deployed.stdout || ''}\n${deployed.stderr || ''}`;
const urlMatch = deployText.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/);
if (deployed.status !== 0 || !urlMatch) {
  process.stderr.write(deployText.split('\n').slice(-25).join('\n') + '\n');
  process.exit(1);
}
const base = urlMatch[0];
process.stdout.write(`cpu-gate: ${base}\n`);

const cleanup = () => {
  if (!KEEP) run(['delete', '--name', NAME], { input: 'y\n' });
  else process.stdout.write(`cpu-gate: kept ${NAME} (delete with: wrangler delete --name ${NAME})\n`);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
};

// --- 3. tail the platform's per-request cpuTime/outcome ---
const tailLog = join(dir, 'tail.json');
const tailErr = join(dir, 'tail.err');
// Separate files: wrangler writes progress to stderr and events to stdout, and
// two handles on one file interleave at the OS level.
const tail = spawn(WRANGLER, [...WRANGLER_PREFIX, 'tail', NAME, '--format', 'json'], {
  cwd: ROOT,
  shell: process.platform === 'win32',
  stdio: ['ignore', openSync(tailLog, 'w'), openSync(tailErr, 'w')],
});

// `wrangler tail` needs a moment to attach (and `npx` may have to resolve the
// package), so WAIT for the first event instead of guessing: fire one small
// request every 2s until the tail reports it (up to ~40s).
const readTail = () => (existsSync(tailLog) ? readFileSync(tailLog, 'utf8') : '');
let warmed = false;
for (let i = 0; i < 20; i++) {
  await fetch(`${base}/?op=json&n=1&tag=warmup`).then((r) => r.arrayBuffer()).catch(() => {});
  await sleep(2000);
  if (readTail().trim().length > 0) {
    warmed = true;
    break;
  }
}
if (!warmed) {
  process.stderr.write(`cpu-gate FAIL: \`wrangler tail\` never reported an event (log: ${tailLog})\n`);
  cleanup();
  process.exit(1);
}
await sleep(1500);

// --- 4. the loads: one connection pool, back to back ---
const load = async (label, url) => {
  const started = Date.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let i = 0; i < Math.ceil(REQUESTS / CONCURRENCY); i++) {
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        await res.arrayBuffer();
      }
    })
  );
  process.stdout.write(`cpu-gate: ${label} - ${REQUESTS} requests in ${Date.now() - started} ms\n`);
};

await load('page-like hot paths', `${base}/?op=all&n=${N}&tag=page-like`);
await load('enforcement control', `${base}/?op=sustained&ms=${BURN_MS}&tag=control`);
if (SUSTAINED_MS > 0) await load(`sustained ${SUSTAINED_MS} ms/req`, `${base}/?op=sustained&ms=${SUSTAINED_MS}&tag=sustained`);

await sleep(3000);
tail.kill();
await sleep(500);

// --- 5. read the numbers back ---
// `wrangler tail --format json` PRETTY-PRINTS each event across several lines,
// so the stream is split by brace matching (string/escape-aware), not by
// newline.
function jsonObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

const rows = [];
for (const chunk of jsonObjects(readTail())) {
  let e;
  try {
    e = JSON.parse(chunk);
  } catch {
    continue;
  }
  const req = e && e.event && e.event.request;
  if (!req || !req.url || e.eventTimestamp === undefined) continue;
  rows.push({ url: req.url, outcome: e.outcome, cpuTime: e.cpuTime, wallTime: e.wallTime, status: e.event.response && e.event.response.status });
}

const byTag = new Map();
for (const r of rows) {
  const q = new URL(r.url).searchParams;
  const key = q.get('tag') || q.get('op') || '?';
  if (key === 'warmup') continue;
  if (!byTag.has(key)) byTag.set(key, []);
  byTag.get(key).push(r);
}

const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const report = [];
for (const [key, list] of byTag) {
  const cpus = list.map((r) => Number(r.cpuTime || 0));
  const bad = list.filter((r) => r.outcome !== 'ok');
  report.push({
    tag: key,
    n: list.length,
    'cpu p50': pct(cpus, 0.5),
    'cpu p95': pct(cpus, 0.95),
    'cpu max': Math.max(...cpus),
    'wall p95': pct(list.map((r) => Number(r.wallTime || 0)), 0.95),
    ok: list.length - bad.length,
    'not ok': bad.length,
    outcomes: [...new Set(bad.map((r) => r.outcome))].sort().join(',') || '-',
  });
}
process.stdout.write('\n' + JSON.stringify(report, null, 2) + '\n');

const page = report.find((r) => r.tag === 'page-like');
const control = report.find((r) => r.tag === 'control');
const problems = [];
if (!page) problems.push('no `page-like` events were read back');
else {
  if (page['not ok']) problems.push(`page-like: ${page['not ok']}/${page.n} answered ${page.outcomes}`);
  if (page['cpu p50'] > P50) problems.push(`page-like cpu p50 ${page['cpu p50']} ms > ${P50} ms`);
  if (page['cpu p95'] > P95) problems.push(`page-like cpu p95 ${page['cpu p95']} ms > ${P95} ms`);
}
if (ENFORCEMENT) {
  if (!control) problems.push('no `enforcement control` events were read back');
  else if (control['not ok'] === 0)
    problems.push(
      `enforcement control answered ok ${control.n}/${control.n} - the platform reported no violation for a ${BURN_MS} ms burn, so this gate cannot see the budget`
    );
}
if (problems.length) {
  process.stderr.write('cpu-gate FAIL:\n  - ' + problems.join('\n  - ') + '\n');
  cleanup();
  process.exit(1);
}
process.stdout.write(
  `cpu-gate PASS: page-like ${page.n}/${page.n} ok within ${P50}/${P95} ms` +
    (ENFORCEMENT ? `; the control was caught (${control.outcomes})` : '') +
    '\n'
);
cleanup();
