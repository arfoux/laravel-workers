#!/usr/bin/env node
// Compare two sweeps of the same app and say what actually differs.
//   node tools/audit/compare.mjs --live .audit/live --php .audit/php --origin A=https://app.example --origin B=http://127.0.0.1:8300
//
// Raw byte equality is the wrong first metric: `url()`/`asset()` embed the origin, and a
// CSRF token differs per session. Normalise exactly those two, then classify.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const argAll = (name) => process.argv.flatMap((a, i, all) => (a === `--${name}` ? [all[i + 1]] : []));

const liveDir = arg('live');
const oracleDir = arg('php');
if (!liveDir || !oracleDir) {
  console.error('usage: compare.mjs --live <dir> --php <dir> [--origin A=<url> --origin B=<url>]');
  process.exit(2);
}

const origins = argAll('origin').map((o) => o.split('=')).filter((p) => p.length === 2);
const normalise = (text) => {
  let out = text;
  for (const [, url] of origins) out = out.split(url).join('ORIGIN');
  return out
    .replace(/name="_token" value="[^"]*"/g, 'name="_token" value="TOKEN"')
    .replace(/name="csrf-token" content="[^"]*"/g, 'name="csrf-token" content="TOKEN"');
};

const live = JSON.parse(readFileSync(join(liveDir, 'sweep.json'), 'utf8'));
const oracleRows = JSON.parse(readFileSync(join(oracleDir, 'sweep.json'), 'utf8'));
const oracle = new Map(oracleRows.map((r) => [r.uri, r]));

const rows = [];
for (const l of live) {
  const p = oracle.get(l.uri);
  if (!p) { rows.push({ uri: l.uri, live: l.status, php: '-', verdict: 'oracle-missing' }); continue; }
  const a = readFileSync(join(liveDir, `${l.sha.slice(0, 12)}.body`));
  const b = readFileSync(join(oracleDir, `${p.sha.slice(0, 12)}.body`));
  rows.push({
    uri: l.uri,
    live: l.status,
    php: p.status,
    bytes: `${a.length}/${b.length}`,
    verdict:
      l.status !== p.status
        ? 'STATUS-DIFF'
        : normalise(a.toString('utf8')) === normalise(b.toString('utf8'))
          ? 'TEMPLATE-IDENTICAL'
          : 'CONTENT-DIFF',
  });
}

const tally = {};
for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
console.log(JSON.stringify(tally, null, 1));
for (const kind of ['STATUS-DIFF', 'CONTENT-DIFF', 'oracle-missing']) {
  const hit = rows.filter((r) => r.verdict === kind);
  if (!hit.length) continue;
  console.log(`--- ${kind} ---`);
  for (const r of hit) console.log(`${r.live}/${r.php}\t${r.bytes || ''}\t${r.uri}`);
}
