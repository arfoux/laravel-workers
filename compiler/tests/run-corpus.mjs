#!/usr/bin/env node
// edge/compiler/tests/run-corpus.mjs — M1 corpus regression net.
// For each case in cases.json:
//   SUP   : transpile via CLI -> import emitted module -> run main(rt) -> byte-compare rt.__output to expectations/<id>.txt
//   UNSUP : transpile via CLI -> expect exit 1 + stderr JSON code == expected (no render)
// Exit 0 iff all pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildRt } from '../runtime/rt-from-context.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..'); // edge/
const casesJson = path.join(here, 'corpus', 'cases.json');
const casesDir = path.join(here, 'corpus', 'cases');
const expDir = path.join(here, 'corpus', 'expectations');
const transpile = path.join(root, 'compiler', 'bin', 'transpile.mjs');
const scratch = path.join(process.env.TEMP || '/tmp', 'opencode', 'corpus-run-' + process.pid);

fs.mkdirSync(scratch, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(casesJson, 'utf8'));

let pass = 0, fail = 0;
const failures = [];

function hexdump(a, b) {
  const n = Math.min(a.length, b.length, 64);
  let out = '';
  for (let i = 0; i < n; i += 16) {
    const chunk = [];
    for (let j = 0; j < 16 && i + j < n; j++) {
      const x = a[i+j], y = b[i+j];
      chunk.push((x === y ? ' ' : '>') + x.toString(16).padStart(2,'0'));
    }
    out += chunk.join(' ') + '\n';
  }
  return out;
}

for (const c of manifest) {
  const id = c.id;
  const casePath = path.join(casesDir, id + '.php');
  const src = fs.readFileSync(casePath, 'utf8');
  const dumpPath = path.join(scratch, id + '.json');
  fs.writeFileSync(dumpPath, JSON.stringify({ view: 'case', compiled: src, context: {} }));
  const outPath = path.join(scratch, id + '.mjs');

  // --- run transpiler CLI ---
  let cliCode = 0, cliStderr = '';
  try {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    execFileSync(process.execPath, [transpile, dumpPath, '--json', '--out', outPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    cliCode = 0;
  } catch (e) {
    cliCode = e.status ?? 1;
    cliStderr = (e.stderr || '').toString();
  }

  if (c.kind === 'UNSUP') {
    // expect failure + matching LW code
    let lwCode = null;
    try { const arr = JSON.parse(cliStderr); if (Array.isArray(arr) && arr[0]) lwCode = arr[0].code; } catch {}
    const ok = cliCode !== 0 && lwCode === c.expect;
    if (ok) { pass++; process.stdout.write('PASS  ' + id + ' (UNSUP ' + lwCode + ')\n'); }
    else { fail++; failures.push({ id, reason: 'UNSUP mismatch: cli=' + cliCode + ' got=' + lwCode + ' expected=' + c.expect + ' stderr=' + cliStderr.slice(0,200) }); process.stdout.write('FAIL  ' + id + ' (UNSUP) cli=' + cliCode + ' got=' + lwCode + ' exp=' + c.expect + '\n'); }
    continue;
  }

  // SUP: need successful transpile + render + byte compare
  if (cliCode !== 0) {
    fail++;
    failures.push({ id, reason: 'SUP but transpile failed: ' + cliStderr.slice(0,200) });
    process.stdout.write('FAIL  ' + id + ' (SUP transpile failed)\n');
    continue;
  }
  // render
  let actual = null, renderErr = null;
  try {
    const mod = await import(pathToFileURL(outPath).href + '?t=' + Date.now());
    const main = mod.default;
    const rt = buildRt({}, { strict: false });
    main(rt);
    actual = Buffer.from(rt.__output, 'utf8');
  } catch (e) {
    renderErr = e;
  }
  if (renderErr) {
    fail++;
    failures.push({ id, reason: 'render threw: ' + (renderErr && renderErr.message || renderErr) });
    process.stdout.write('FAIL  ' + id + ' (render threw)\n');
    continue;
  }
  const expPath = path.join(expDir, id + '.txt');
  const expected = fs.readFileSync(expPath);
  if (Buffer.compare(actual, expected) === 0) {
    pass++;
    process.stdout.write('PASS  ' + id + ' (SUP ' + actual.length + 'B)\n');
  } else {
    fail++;
    failures.push({ id, reason: 'byte mismatch: actual=' + actual.length + 'B expected=' + expected.length + 'B', actual, expected });
    process.stdout.write('FAIL  ' + id + ' (byte mismatch ' + actual.length + ' vs ' + expected.length + ')\n');
  }
}

process.stdout.write('\n=== CORPUS: ' + pass + '/' + (pass+fail) + ' pass, ' + fail + ' fail ===\n');
if (failures.length) {
  process.stdout.write('\n--- first failure detail ---\n');
  const f = failures[0];
  process.stdout.write(f.id + ': ' + f.reason + '\n');
  if (f.actual && f.expected) {
    process.stdout.write('hexdump (actual vs expected, > = differ):\n');
    process.stdout.write(hexdump(f.actual, f.expected));
  }
}
process.exit(fail === 0 ? 0 : 1);
