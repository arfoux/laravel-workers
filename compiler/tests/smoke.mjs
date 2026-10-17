// edge/compiler/tests/smoke.mjs — basic smoke test for the transpiler
import { transpile } from '../src/transpiler.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const edgeDir = path.resolve(here, '..', '..');
const dumpPath = path.join(edgeDir, '.cache', 'welcome.compiled.json');
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const { code, errors } = transpile(dump.compiled);
if (errors && errors.length) { console.error('SMOKE FAIL:', JSON.stringify(errors)); process.exit(1); }
if (!code || !code.includes('export default function main(rt)')) { console.error('SMOKE FAIL: bad shape'); process.exit(1); }
console.log('SMOKE: PASS (' + code.length + ' chars)');