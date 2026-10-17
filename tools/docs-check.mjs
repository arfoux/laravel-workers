#!/usr/bin/env node
// tools/docs-check.mjs — Coverage gate (105 rows)
// Offline-safe: validates the table itself; if a laravel/docs listing is reachable, cross-checks.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAP = join(ROOT, 'MAP.md');
const EXPECTED = 105;
const VALID = new Set(['✅', '🟡', '🔴', '⛔']);

function fail(msg) { console.error('docs-check FAIL: ' + msg); process.exit(1); }
function ok(msg) { console.log('docs-check PASS: ' + msg); }

let text;
try { text = readFileSync(MAP, 'utf8'); } catch (e) { fail('cannot read MAP.md: ' + e.message); }

const idx = text.indexOf('## C. Coverage index');
if (idx === -1) fail('Coverage index section not found');
const tallyIdx = text.indexOf('**Tally', idx);
const block = tallyIdx !== -1 ? text.slice(idx, tallyIdx) : text.slice(idx);
const lines = block.split('\n');
const rows = lines.filter(l => /^\| [a-z0-9][a-z0-9-]* \s*\|/.test(l) && !l.includes('Docs page'));

if (rows.length !== EXPECTED) fail(`coverage rows ${rows.length} != ${EXPECTED}`);

const seen = new Set();
for (const r of rows) {
  const parts = r.split('|').map(s => s.trim());
  // parts[0]='', parts[1]=Docs page, parts[2]=Class, parts[3]=Note, parts[4]=''
  const page = parts[1];
  const klass = parts[2];
  const note = parts[3];
  if (!page) fail('blank Docs page in row: ' + r);
  if (seen.has(page)) fail('duplicate page ' + page);
  seen.add(page);
  if (!note) fail('blank Note for ' + page);
  // klass must contain one of the verdict glyphs
  const hasVerdict = [...VALID].some(v => klass.includes(v));
  if (!hasVerdict) fail(`invalid Class "${klass}" for ${page} — expected one of ✅ 🟡 🔴 ⛔`);
}

ok(`${rows.length}/${EXPECTED} rows, no blanks, verdicts valid`);
console.log('coverage: ' + rows.length + '/' + EXPECTED);
