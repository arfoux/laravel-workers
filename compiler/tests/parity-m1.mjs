// compiler/tests/parity-m1.mjs — byte-parity proof (M1)
// M1 byte-parity proof: compiled JS render of `welcome` vs Laravel's own render.
//
// Usage: node compiler/tests/parity-m1.mjs
// Steps: refresh S0 dump -> transpile -> render via compiled module (strict rt) -> php reference render -> byte-compare.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const edgeDir = path.resolve(here, '..', '..'); // .../nearFind/edge
const repoRoot = path.resolve(edgeDir, '..');   // .../nearFind
const scratch = 'C:/Users/HP/AppData/Local/Temp/opencode';
const dumpPath = path.join(edgeDir, '.cache', 'welcome.compiled.json');
const outPath = path.join(edgeDir, '.cache', 'welcome.view.mjs');

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });

const sha = (s) => createHash('sha256').update(s).digest('hex');

let failed = false;
const fail = (msg) => { failed = true; console.error('FAIL: ' + msg); };

// 1) Refresh the S0 dump (build-time PHP boot — never at request time).
console.log('1/5 S0 dump...');
run('php', ['edge/tools/compile-view.php', 'welcome', dumpPath]);

// 2) Transpile compiled Blade (template mode) -> dependency-free ESM.
console.log('2/5 transpile...');
run(process.execPath, ['edge/compiler/bin/transpile.mjs', dumpPath, '--json', '--out', outPath]);

// 3) Render with the compiled module (strict rt: no silent fallbacks).
console.log('3/5 compiled render...');
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const { buildRt } = await import(pathToFileURL(path.join(edgeDir, 'compiler', 'runtime', 'rt-from-context.mjs')).href);
const rt = buildRt(dump.context, { strict: true });
let jsOut = '';
rt.echo = (v) => {
  jsOut += v === null || v === undefined ? '' : v === true ? '1' : v === false ? '' : String(v);
};
const mod = await import(pathToFileURL(outPath).href + '?t=' + Date.now());
mod.default(rt);
if (rt.__warnings && rt.__warnings.length) {
  fail('rt warnings in strict mode: ' + rt.__warnings.join(' | '));
}

// 4) Laravel's own render (reference).
console.log('4/5 php reference render...');
const ref = JSON.parse(run('php', ['edge/tools/prerender.php', '/']));
if (ref.status !== 200 || typeof ref.body !== 'string') fail('prerender did not return a 200 with body');

// 5) Byte compare.
console.log('5/5 compare...');
fs.writeFileSync(path.join(scratch, 'welcome.js.html'), jsOut);
fs.writeFileSync(path.join(scratch, 'welcome.php.html'), ref.body ?? '');
console.log('  js  sha256 ' + sha(jsOut) + '  bytes ' + Buffer.byteLength(jsOut));
console.log('  php sha256 ' + sha(ref.body ?? '') + '  bytes ' + Buffer.byteLength(ref.body ?? ''));

if (jsOut === ref.body) {
  console.log('PARITY: PASS — byte-identical (' + Buffer.byteLength(jsOut) + ' bytes)');
  process.exit(failed ? 1 : 0);
}

let i = 0;
const n = Math.min(jsOut.length, ref.body.length);
while (i < n && jsOut[i] === ref.body[i]) i++;
console.log('PARITY: FAIL — first diff at byte ' + i + ' (js len ' + jsOut.length + ', php len ' + ref.body.length + ')');
console.log('  js : ' + JSON.stringify(jsOut.slice(Math.max(0, i - 70), i + 70)));
console.log('  php: ' + JSON.stringify(ref.body.slice(Math.max(0, i - 70), i + 70)));
process.exit(1);
