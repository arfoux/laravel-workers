#!/usr/bin/env node
// Sweep every GET route an app declares, against one base URL, and write one row per URI.
//   node tools/audit/sweep.mjs --routes routes.json --base https://app.example --out .audit/live
// The routes file is the app's own `php artisan route:list --json` output.
// Bodies are stored content-addressed (sha256) so a comparison never has to refetch.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const routesFile = arg('routes');
const base = arg('base');
const outDir = arg('out');
if (!routesFile || !base || !outDir) {
  console.error('usage: sweep.mjs --routes <route:list --json> --base <url> --out <dir>');
  process.exit(2);
}

const extras = (arg('extras') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const routes = JSON.parse(readFileSync(routesFile, 'utf8'));
const uris = [
  ...new Set([
    ...routes.filter((r) => r.method.includes('GET')).map((r) => r.uri),
    ...extras,
  ]),
].map((u) => '/' + u.replace(/^\//, ''));

mkdirSync(outDir, { recursive: true });
const rows = [];
for (const uri of uris) {
  try {
    const res = await fetch(base + uri, { redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(buf).digest('hex');
    rows.push({ uri, status: res.status, bytes: buf.length, sha, location: res.headers.get('location') || '' });
    writeFileSync(join(outDir, `${sha.slice(0, 12)}.body`), buf);
  } catch (e) {
    rows.push({ uri, status: 'ERR', bytes: 0, sha: String(e.message).slice(0, 80), location: '' });
  }
}
writeFileSync(join(outDir, 'sweep.json'), JSON.stringify(rows, null, 1));

const byStatus = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
console.log(`base=${base} routes=${rows.length} statuses=${JSON.stringify(byStatus)}`);
for (const r of rows) {
  console.log(`${r.status}\t${String(r.bytes).padStart(6)}\t${r.uri}\t${r.sha.slice(0, 12)}${r.location ? '\t' + r.location : ''}`);
}
