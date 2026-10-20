// compiler/bin/transpile.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transpile } from '../src/transpiler.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

let input = null;
let jsonMode = false;
let templateMode = false;
let outPath = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') jsonMode = true;
  else if (a === '--template') templateMode = true;
  else if (a === '--out') { outPath = args[++i]; }
  else if (!input) input = a;
  else { console.error(JSON.stringify([{ code: 'LW004', message: 'unexpected arg ' + a, line: 0, column: 0, hint: '' }])); process.exit(1); }
}

if (!input) {
  console.error(JSON.stringify([{ code: 'LW004', message: 'missing input file', line: 0, column: 0, hint: '' }]));
  process.exit(1);
}

const inputPath = path.resolve(process.cwd(), input);
let compiled;
let viewDataKinds = null;
try {
  const raw = fs.readFileSync(inputPath, 'utf8');
  if (jsonMode) {
    const data = JSON.parse(raw);
    compiled = data.compiled;
    if (typeof compiled !== 'string') throw new Error('no .compiled string in JSON');
    // The kinds of the view data (the build knows them: the pagination view
    // receives a paginator).
    if (data.viewDataKinds && typeof data.viewDataKinds === 'object') {
      viewDataKinds = data.viewDataKinds;
    }
  } else {
    compiled = raw;
  }
} catch (e) {
  console.error(JSON.stringify([{ code: 'LW004', message: 'cannot read input: ' + (e.message || e), line: 0, column: 0, hint: '' }]));
  process.exit(1);
}

const { code, errors } = transpile(compiled, { viewDataKinds });

if (errors && errors.length) {
  console.error(JSON.stringify(errors));
  process.exit(1);
}

if (outPath) {
  const absOut = path.resolve(process.cwd(), outPath);
  const tmp = absOut + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, code, 'utf8');
  fs.renameSync(tmp, absOut);
} else {
  process.stdout.write(code);
}