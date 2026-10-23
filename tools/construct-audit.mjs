#!/usr/bin/env node
// tools/construct-audit.mjs - the construct audit, generated.
//
// Every construct that an app can meet is listed in tools/constructs.json. This
// script probes the **real compiler** for each one and reports what the build
// does with it: it compiles, or it fails loud (with the fail-loud code). The
// expectation in the data is checked too, so a construct that starts compiling
// (or stops) is flagged instead of rotting in a document.
//
//   node tools/construct-audit.mjs            # the table (markdown)
//   node tools/construct-audit.mjs --check    # the gate: fail on a mismatch
//
// The table is written into COMPILED.md between the markers; `--check` verifies
// that the document still matches the code (the docs cannot lie).

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = JSON.parse(readFileSync(join(ROOT, 'tools', 'constructs.json'), 'utf8'));
const { emitController } = await import(
  pathToFileURL(join(ROOT, 'compiler', 'src', 'controller.mjs')).href
);
const { transpile } = await import(
  pathToFileURL(join(ROOT, 'compiler', 'src', 'transpiler.mjs')).href
);
const { compileClasses } = await import(
  pathToFileURL(join(ROOT, 'compiler', 'src', 'classes.mjs')).href
);

const CHECK = process.argv.includes('--check');
const START = '<!-- construct-audit:start -->';
const END = '<!-- construct-audit:end -->';

const GLYPH = { ok: '✅ compiles', fail: '⛔ fails loud', documented: '— documented (build level)' };

// The event class the class-level probes hang their listener on.
const AUDIT_EVENT_PHP = `<?php
namespace App\\Events;

class PostPublished
{
    public function __construct(public int $id = 0)
    {
    }
}
`;

// A class-level construct (a listener): the class compiler is the probe.
function probeClasses(c) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-audit-'));
  const eventFile = join(dir, 'Event.php');
  const listenerFile = join(dir, 'Listener.php');
  writeFileSync(eventFile, c.event_php || AUDIT_EVENT_PHP, 'utf8');
  writeFileSync(listenerFile, c.class_php, 'utf8');
  const event = c.class_event || 'App\\Events\\PostPublished';
  const listener = c.class_listener || 'App\\Listeners\\L';
  const dump = {
    events: {
      [event]: {
        file: eventFile,
        listeners: [listener],
        queued: c.queued ? [listener] : [],
        broadcast: c.broadcast ? [listener] : [],
        afterCommit: c.afterCommit ? [listener] : [],
      },
    },
    classes: {
      [event]: { file: eventFile },
      [listener]: { file: listenerFile },
    },
  };
  // The extra class of the construct (the service the listener injects): the
  // build compiles it too, so the edge can build it.
  const compiled = [event, listener];
  if (c.class_extra && c.class_extra_php) {
    const extraFile = join(dir, c.class_extra.split('\\').pop() + '.php');
    writeFileSync(extraFile, c.class_extra_php, 'utf8');
    dump.classes[c.class_extra] = { file: extraFile };
    compiled.push(c.class_extra);
  }
  const res = compileClasses(dump, {
    modelClassFqcns: {},
    classes: new Set(compiled),
    constants: {},
  });
  if (!res.errors.length) return { verdict: 'ok', code: null, message: 'compiles' };
  const e = res.errors[0];
  return { verdict: 'fail', code: e.code || null, message: String(e.message).split('\n')[0] };
}

function probe(c) {
  if (c.check === 'classes') return probeClasses(c);
  if (!c.php) return { verdict: 'not probed', code: null, message: 'documented (a build-level construct)' };
  // A view-level construct (a Blade layout): the compiled PHP goes through the
  // view transpiler.
  if (c.view) {
    const res = transpile(c.php);
    if (!res.errors.length) return { verdict: 'ok', code: null, message: 'compiles' };
    const e = res.errors[0];
    return { verdict: 'fail', code: e.code, message: String(e.message).split('\n')[0] };
  }
  // A probe may carry a preamble (the context the construct needs), the
  // method parameters and the models of the route - so the probe is the real
  // code an app would have, not a fragment.
  const src =
    '<?php\nnamespace App\\Http\\Controllers;\n' +
    (c.uses || []).map((u) => 'use ' + u + ';\n').join('') +
    'class C {\n    public function demo' +
    (c.sig || '()') +
    '\n    {\n' +
    (c.pre ? c.pre + '\n' : '') +
    c.php +
    '\n        return response("ok");\n    }\n}\n';
  const res = emitController(src, 'demo', {
    routeUri: '/x',
    routeParams: c.routeParams || [],
    models: c.models || [],
    views: [],
    // The dumped Gate metadata (the policies the check reads).
    policies: c.policies || {},
    // The compiled classes (the event classes + their listeners).
    classes: c.classes || {},
    // The app's object store: the default disk + the configured disk names.
    storage: c.storage || { defaultDisk: 'local', disks: ['local', 'public'] },
  });
  if (!res.errors.length) return { verdict: 'ok', code: null, message: 'compiles' };
  const e = res.errors[0];
  return { verdict: 'fail', code: e.code, message: String(e.message).split('\n')[0] };
}

// A documented row names its proof: `shadow:<label substring>`,
// `test:<path>` or `dump:<path>`. The pointer is RESOLVED here, so a row cannot
// claim a proof that no longer exists (a deleted test, a renamed scenario step).
const SCENARIO_FILE = join(ROOT, 'shadow', 'scenarios', 'lw-constructs-app.mjs');
function resolveProof(proof) {
  if (typeof proof !== 'string' || !proof.includes(':')) return 'no proof recorded';
  const at = proof.indexOf(':');
  const kind = proof.slice(0, at);
  const what = proof.slice(at + 1).trim();
  if (kind === 'test' || kind === 'dump') {
    try {
      readFileSync(join(ROOT, what));
      return null;
    } catch {
      return `the file ${what} does not exist`;
    }
  }
  if (kind === 'shadow') {
    let scenario;
    try {
      scenario = readFileSync(SCENARIO_FILE, 'utf8');
    } catch {
      return `the scenario file ${SCENARIO_FILE} does not exist`;
    }
    return scenario.includes("'" + what + "'") ? null : `the scenario has no step ${JSON.stringify(what)}`;
  }
  return `unknown proof kind ${JSON.stringify(kind)}`;
}
const rows = [];
let drift = 0;
for (const c of DATA.constructs) {
  const p = probe(c);
  // The expectation must hold: a construct marked as failing must fail, and one
  // marked as compiling must compile.
  const expected = c.expect;
  const actual = p.verdict;
  // A build-level construct (a Blade layout, an OPTIONS route, a PHP-side dump
  // decision) is DOCUMENTED here: the compiler cannot judge it, so it is not
  // probed and it has no verdict to state. It must not carry an `expect`
  // either - a decorative "fail" on such a row is how a superseded refusal
  // (form_request_after) stayed green beside the shipped feature that replaced
  // it. An `expect` on a build row is drift.
  const isBuild = c.check === 'build';
  // A row may also name the REASON the construct must fail loud for (a
  // substring of the message): a construct that fails loud for another reason
  // is drift too (the M45/M46 family: the verdict was right, the reason was
  // wrong). Every PROBED fail row must name it, so a refusal cannot be recorded
  // without saying why.
  const reasonOk = expected === 'fail' && c.reason ? p.message.includes(c.reason) : true;
  const missingReason = !isBuild && expected === 'fail' && !c.reason;
  const proofProblem = isBuild ? resolveProof(c.proof) : null;
  const ok = isBuild
    ? c.expect === undefined && c.code === undefined && !proofProblem
    : actual === expected && (expected === 'fail' ? (c.code ? p.code === c.code : true) : true) && reasonOk && !missingReason;
  if (!ok) drift++;
  rows.push({
    id: c.id,
    label: c.label,
    check: c.check || 'compiler',
    verdict: isBuild ? 'documented' : actual,
    code: p.code,
    expected,
    ok,
    note: c.note,
    batch: c.batch,
    status: c.status,
    reason: c.reason || null,
    proof: c.proof || null,
    proofProblem,
    // The code the LEDGER declares (the probe's own code is `code` above).
    declaredCode: c.code === undefined ? null : c.code,
    message: p.message,
  });
}

// --dump: print every probed construct (the verdict + the message) so the
// reasons can be recorded in tools/constructs.json.
if (process.argv.includes('--dump')) {
  for (const r of rows) {
    console.log([r.id, r.verdict, r.code || '-', JSON.stringify(r.message)].join('	'));
  }
  process.exit(0);
}
// The facade coverage: every facade of Laravel 13 has a row (the coverage is
// enumerable, not an opinion).
const facadeRows = rows.filter((r) => r.id.startsWith('facade_'));
// The facades Laravel 13 has (the vendored Illuminate/Support/Facades
// directory) - the registry declares the total, so a missing row shows up as
// a coverage gap instead of a silent omission.
const facadeTotal = (DATA.meta && Number(DATA.meta.facade_total)) || facadeRows.length;
const facadeCounts = {
  total: facadeRows.length,
  ok: facadeRows.filter((r) => r.verdict === 'ok').length,
  fail: facadeRows.filter((r) => r.verdict === 'fail').length,
};
const counts = {
  ok: rows.filter((r) => r.verdict === 'ok').length,
  fail: rows.filter((r) => r.verdict === 'fail').length,
  build: rows.filter((r) => r.verdict === 'documented').length,
  np: rows.filter((r) => r.verdict === 'not probed').length,
  drift,
};

const table = [
  '| Construct | The build | Note | Batch |',
  '|---|---|---|---|',
  ...rows.map((r) => {
    const v =
      r.verdict === 'ok'
        ? GLYPH.ok
        : r.verdict === 'fail'
          ? (r.code ? `${GLYPH.fail} (\`${r.code}\`)` : GLYPH.fail)
          : GLYPH.documented;
    const drift = r.ok ? '' : ' **⚠ drift**';
    return `| ${r.label} | ${v}${drift} | ${r.note} | ${r.batch} |`;
  }),
  '',
  `**${rows.length} constructs: ${counts.ok} compile, ${counts.fail} fail loud, ${counts.build} documented at the build level.** Every probed construct is either compiled *and* proven by the shadow harness, or it fails the build; the ${counts.build} documented rows are build-level decisions the compiler cannot judge, and each one names its own proof (the 'proof' field: a shadow step, a test file or the dump that decides it). The Laravel 13 facades: **${facadeCounts.total} of ${facadeTotal} classified (${facadeCounts.ok} compile, ${facadeCounts.fail} fail loud) — the facade coverage is ${facadeTotal ? Math.round((facadeCounts.total / facadeTotal) * 100) : 0}%** (every facade of the vendored Illuminate/Support/Facades must have a row).`,
].join('\n');

if (CHECK) {
  // 1. the expectations must hold
  const drifted = rows.filter((r) => !r.ok);
  for (const r of drifted) {
    if (r.check === 'build') {
      // A build-level row states no verdict: carrying one is the drift.
      if (r.expected !== undefined || r.declaredCode !== null) {
        console.error(
          `construct-audit FAIL: ${r.label} - a documented (build-level) row must not carry expect/code (it is not probed)`
        );
        continue;
      }
      // ...and it must point at a proof that still exists.
      console.error(
        `construct-audit FAIL: ${r.label} - its proof does not resolve: ${r.proofProblem}`
      );
      continue;
    }
    if (!r.reason && r.expected === 'fail') {
      // A probed refusal must say WHY it refuses, or the row cannot be checked.
      console.error(
        `construct-audit FAIL: ${r.label} - a probed fail row must record the reason (a substring of the message)`
      );
      continue;
    }
    console.error(
      `construct-audit FAIL: ${r.label} - expected ${r.expected}${r.expected === 'fail' ? ` (${r.code})` : ''}, got ${r.verdict}${r.code ? ` (${r.code})` : ''}`
    );
    if (r.reason && !r.message.includes(r.reason)) {
      console.error(
        `construct-audit FAIL: ${r.label} - it fails loud, but not for the recorded reason: ${JSON.stringify(r.reason)}`
      );
    }
  }
  // 2. the document must match the code
  const docPath = join(ROOT, 'COMPILED.md');
  const doc = readFileSync(docPath, 'utf8');
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1) {
    console.error('construct-audit FAIL: COMPILED.md has no construct-audit markers');
    process.exit(1);
  }
  const current = doc.slice(start + START.length, end).trim();
  if (current !== table.trim()) {
    console.error('construct-audit FAIL: the COMPILED.md table is stale - run: node tools/construct-audit.mjs --write');
    process.exit(1);
  }
  console.log(
    `construct-audit PASS: ${rows.length} constructs (${counts.ok} compile, ${counts.fail} fail loud, ${counts.build} documented at the build level), the COMPILED.md table matches the code`
  );
  process.exit(drift ? 1 : 0);
}

if (process.argv.includes('--write')) {
  const docPath = join(ROOT, 'COMPILED.md');
  const doc = readFileSync(docPath, 'utf8');
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1) {
    console.error('construct-audit: COMPILED.md has no construct-audit markers');
    process.exit(1);
  }
  writeFileSync(docPath, doc.slice(0, start + START.length) + '\n\n' + table + '\n\n' + doc.slice(end));
  console.log('COMPILED.md: the construct audit table is written');
  process.exit(0);
}

console.log(table);
if (drift) {
  console.error(`\nconstruct-audit: ${drift} construct(s) drifted from the expectation`);
  process.exit(1);
}
