// compiler/bin/controller.mjs — CLI for controller extraction/transpilation.
//
// Usage:
//   node controller.mjs extract --file app/Http/Controllers/PostController.php --method show [--out meta.json]
//   node controller.mjs emit    --file app/Http/Controllers/PostController.php --method show --meta meta.json --out dist/src/controllers/posts-show.mjs
//
// extract prints {ok, fqcn, namespace, className, method, params, classes, views} on
// stdout (or writes it with --out). emit writes the handler module atomically on
// success. Both exit non-zero with a JSON error array [{code,message,line,column,hint}]
// on stderr when the controller/method is outside the supported subset.
import fs from 'node:fs';
import path from 'node:path';
import { extractController, emitController } from '../src/controller.mjs';

const USAGE =
  'usage: controller.mjs extract|emit --file <controller.php> --method <name> [--meta <meta.json>] [--out <file>]';

function fail(errors) {
  process.stderr.write(JSON.stringify(errors));
  process.exit(1);
}

function usageError(message) {
  fail([{ code: 'LW004', message: message + ' — ' + USAGE, line: 0, column: 0, hint: '' }]);
}

const args = process.argv.slice(2);
let cmd = null;
let file = null;
let method = null;
let metaPath = null;
let outPath = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === 'extract' || a === 'emit') cmd = a;
  else if (a === '--file') file = args[++i];
  else if (a === '--method') method = args[++i];
  else if (a === '--meta') metaPath = args[++i];
  else if (a === '--out') outPath = args[++i];
  else usageError('unexpected argument ' + JSON.stringify(a));
}
if (!cmd) usageError('missing command (extract|emit)');
if (!file) usageError('missing --file');
if (!method) usageError('missing --method');

const absFile = path.resolve(process.cwd(), file);
if (!fs.existsSync(absFile)) usageError('file not found: ' + absFile);
const source = fs.readFileSync(absFile, 'utf8');

if (cmd === 'extract') {
  const info = extractController(source, method);
  if (!info.ok) fail(info.errors);
  const out = {
    ok: true,
    fqcn: info.fqcn,
    namespace: info.namespace,
    className: info.className,
    method: info.method,
    params: info.params,
    classes: info.classes,
    constants: info.constants,
    views: info.views,
  };
  const text = JSON.stringify(out);
  if (outPath) fs.writeFileSync(path.resolve(process.cwd(), outPath), text);
  else process.stdout.write(text);
} else {
  if (!metaPath) usageError('emit requires --meta <file.json>');
  if (!outPath) usageError('emit requires --out <file.mjs>');
  const absMeta = path.resolve(process.cwd(), metaPath);
  if (!fs.existsSync(absMeta)) usageError('meta file not found: ' + absMeta);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(absMeta, 'utf8'));
  } catch (e) {
    usageError('invalid meta JSON: ' + (e.message || String(e)));
  }
  const res = emitController(source, method, meta);
  if (res.errors.length) fail(res.errors);
  const absOut = path.resolve(process.cwd(), outPath);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  const tmp = absOut + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, res.code);
  fs.renameSync(tmp, absOut);
}
