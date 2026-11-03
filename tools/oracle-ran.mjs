#!/usr/bin/env node
// tools/oracle-ran.mjs — CI guard: the PHP oracle parity has to RUN.
//
// `node --test kernel/tests/auth.test.mjs` without a Laravel app prints
// `# skipped 4` and exits 0: green CI that proved nothing. The `parity-oracle`
// job re-checked the run with `grep '# skipped 0'` on the TAP text, which has
// two holes:
//
//   * the grep decides the step's exit status, so a FAILING oracle run (which
//     still prints `# skipped 0`) sailed through the step that was meant to
//     guard it;
//   * the grep is coupled to the TAP wording of one Node version — a reporter
//     change makes the guard fail, or pass, for the wrong reason.
//
// This gate runs the oracle files itself and fails unless the run genuinely
// executed them: `node --test` exits 0, at least one test ran, and every
// counter the summary reports is zero (fail, skipped, cancelled, todo). A
// summary it cannot parse is a failure too — never a silent pass.
//
// Usage: node tools/oracle-ran.mjs [test file ...]
//   (default: the oracle parity set the CI job runs)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oracleAppRoot } from '../kernel/tests/oracle-app.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILES = ['auth', 'cache', 'csrf', 'session', 'ratelimit'].map((name) =>
  path.join('kernel', 'tests', `${name}.test.mjs`),
);
// The vendor-dir resolver (#647) is an app-dependent oracle too: without an app
// it self-skips, so a plain `node --test` is green while proving nothing. The
// parity job has an app with `vendor/` (the framework's lang files), so the
// gate runs it for real - and its own skipped!==0 check keeps it from silently
// dropping out again (it shipped wired nowhere).
DEFAULT_FILES.push(path.join('tools', 'tests', 'vendor-dir.test.mjs'));
const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES;

const app = oracleAppRoot();
if (!app) {
  process.stderr.write(
    'oracle-ran: no Laravel app — set LW_LARAVEL_APP to an app with vendor/ installed ' +
      '(or create the conventional parity-app/ directory).\n',
  );
  process.exit(1);
}

process.stdout.write(`oracle-ran: app ${app}\noracle-ran: node --test ${files.join(' ')}\n`);
const run = spawnSync(process.execPath, ['--test', ...files], { cwd: repoRoot, encoding: 'utf8' });
const out = `${run.stdout || ''}${run.stderr || ''}`;
const counter = (label) => {
  const m = out.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
  return m ? Number(m[1]) : null;
};
const tests = counter('tests');
const pass = counter('pass');
const fail = counter('fail');
const skipped = counter('skipped');
const cancelled = counter('cancelled');
const todo = counter('todo');

const problems = [];
if (run.error) problems.push(`could not run node --test: ${run.error.message}`);
if ([tests, pass, fail, skipped, cancelled, todo].includes(null)) {
  problems.push('the TAP summary could not be parsed (did the reporter change?)');
} else {
  if (tests === 0) problems.push('no test was collected');
  if (pass === 0) problems.push('no test passed');
  if (fail !== 0) problems.push(`${fail} test(s) failed`);
  if (skipped !== 0) problems.push(`${skipped} test(s) skipped — the oracle parity did not run`);
  if (cancelled !== 0) problems.push(`${cancelled} test(s) cancelled`);
  if (todo !== 0) problems.push(`${todo} test(s) marked todo`);
}
if (run.status !== 0 && problems.length === 0) {
  problems.push(`node --test exited ${run.status === null ? 'on a signal' : run.status}`);
}

const tail = out.split('\n').slice(-25).join('\n');
if (problems.length) {
  process.stdout.write(`${tail}\n`);
  process.stderr.write(`oracle-ran FAILED: ${problems.join('; ')}\n`);
  process.exit(1);
}
process.stdout.write(`${tail}\noracle-ran OK: ${tests} tests ran, 0 skipped, 0 failed\n`);
