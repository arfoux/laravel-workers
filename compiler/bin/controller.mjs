// compiler/bin/controller.mjs — CLI for controller extraction/transpilation.
//
// Usage:
//   node controller.mjs extract --file app/Http/Controllers/PostController.php --method show [--out meta.json]
//   node controller.mjs extract --batch jobs.json
//   node controller.mjs emit    --file app/Http/Controllers/PostController.php --method show --meta meta.json --out dist/src/controllers/posts-show.mjs
//
// extract prints {ok, fqcn, namespace, className, method, params, classes, views} on
// stdout (or writes it with --out). --batch reads [{file, method}, ...] and writes
// one JSON array; a failed job carries its own `errors` array so the caller can
// report every controller without N Node processes.
// emit writes the handler module atomically on success. Single-mode commands
// exit non-zero with a JSON error array [{code,message,line,column,hint}] on
// stderr when the controller/method is outside the supported subset.
import fs from 'node:fs';
import path from 'node:path';
import { extractController, emitController } from '../src/controller.mjs';

const USAGE =
  'usage: controller.mjs extract --file <controller.php> --method <name> [--out <file>] | ' +
  'extract --batch <jobs.json> | ' +
  'emit --file <controller.php> --method <name> --meta <meta.json> --out <file>';

function fail(errors) {
  process.stderr.write(JSON.stringify(errors));
  process.exit(1);
}

function usageError(message) {
  fail([{ code: 'LW004', message: message + ' — ' + USAGE, line: 0, column: 0, hint: '' }]);
}

function extractPayload(info) {
  return {
    ok: true,
    fqcn: info.fqcn,
    namespace: info.namespace,
    className: info.className,
    method: info.method,
    params: info.params,
    classes: info.classes,
    // The classes the body instantiates (`new OrderMail()`).
    newClasses: info.newClasses,
    constants: info.constants,
    views: info.views,
    // A paginator in the method + the kinds of the data the views receive.
    usesPaginator: info.usesPaginator,
    // A mail in the method: the build compiles the mailable's view.
    usesMail: info.usesMail,
    viewDataKinds: info.viewDataKinds,
  };
}

function batchFailure(index, file, method, errors) {
  return { ok: false, index, file, method, errors };
}

function runBatch(batchPath) {
  const absBatch = path.resolve(process.cwd(), batchPath);
  if (!fs.existsSync(absBatch)) usageError('batch file not found: ' + absBatch);
  let jobs;
  try {
    jobs = JSON.parse(fs.readFileSync(absBatch, 'utf8'));
  } catch (e) {
    usageError('invalid batch JSON: ' + (e.message || String(e)));
  }
  if (!Array.isArray(jobs)) usageError('batch JSON must be an array of {file, method}');
  const results = jobs.map((job, index) => {
    const file = job && job.file ? String(job.file) : '';
    const method = job && job.method ? String(job.method) : '';
    if (!file || !method) {
      return batchFailure(index, file, method, [
        { code: 'LW004', message: 'batch job needs file and method — ' + USAGE, line: 0, column: 0, hint: '' },
      ]);
    }
    const absFile = path.resolve(process.cwd(), file);
    if (!fs.existsSync(absFile)) {
      return batchFailure(index, file, method, [
        { code: 'LW004', message: 'file not found: ' + absFile, line: 0, column: 0, hint: '' },
      ]);
    }
    try {
      const info = extractController(fs.readFileSync(absFile, 'utf8'), method);
      if (!info.ok) return batchFailure(index, file, method, info.errors);
      return { index, file, method, ...extractPayload(info) };
    } catch (e) {
      const errors = Array.isArray(e && e.errors)
        ? e.errors
        : [{ code: 'LW004', message: String((e && e.message) || e), line: 0, column: 0, hint: '' }];
      return batchFailure(index, file, method, errors);
    }
  });
  // A batch is a report, not an all-or-nothing command: the caller needs the
  // successful controllers even when one job is outside the supported subset.
  process.stdout.write(JSON.stringify(results));
}

const args = process.argv.slice(2);
let cmd = null;
let file = null;
let method = null;
let metaPath = null;
let outPath = null;
let batchPath = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === 'extract' || a === 'emit') cmd = a;
  else if (a === '--file') file = args[++i];
  else if (a === '--method') method = args[++i];
  else if (a === '--meta') metaPath = args[++i];
  else if (a === '--out') outPath = args[++i];
  else if (a === '--batch') batchPath = args[++i];
  else usageError('unexpected argument ' + JSON.stringify(a));
}
if (!cmd) usageError('missing command (extract|emit)');

if (cmd === 'extract' && batchPath) {
  runBatch(batchPath);
} else {
  if (!file) usageError('missing --file');
  if (!method) usageError('missing --method');
  const absFile = path.resolve(process.cwd(), file);
  if (!fs.existsSync(absFile)) usageError('file not found: ' + absFile);
  const source = fs.readFileSync(absFile, 'utf8');

  if (cmd === 'extract') {
    const info = extractController(source, method);
    if (!info.ok) fail(info.errors);
    const text = JSON.stringify(extractPayload(info));
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
}
