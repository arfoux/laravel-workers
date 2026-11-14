// tools/tests/run.test.mjs — the Windows command line the tool hands to cmd.exe.
//
// The rule here exists because of a measured failure on the audit machine:
// `"npx.cmd" "wrangler" "--version"` answered
//   Error: Cannot find module '...\node_modules\npm\bin\npm-prefix.js'
// while `npx.cmd "wrangler" "--version"` answered 4.157.0 — same shell, same
// PATH, same working directory. Every `deploy`/`doctor` wrangler call went
// through the quoted form, so the guided deploy could not start there (doctor
// said "wrangler not found" while `npx wrangler` worked by hand).
//
// The other half of the rule: a command that carries a space (process.execPath is
// `C:\Program Files\nodejs\node.exe`) still has to be quoted and caret-escaped,
// and every argument is escaped so `%VAR%`, `!VAR!` and quotes reach the child
// literally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandLine } from '../run.mjs';

test('run: a bare executable name stays unquoted so cmd resolves it through PATH', () => {
  const line = commandLine('npx.cmd', ['wrangler', '--version']);
  assert.ok(line.startsWith('npx.cmd '), `head must stay bare, got ${line}`);
  assert.ok(!line.startsWith('^"') && !line.startsWith('"'), `head must not be quoted, got ${line}`);
  // arguments are still quoted and caret-escaped
  assert.ok(line.includes('^"wrangler^"') && line.includes('^"--version^"'), line);
});

test('run: an executable path with a space is quoted and escaped', () => {
  const line = commandLine('C:\\Program Files\\nodejs\\node.exe', ['-e', 'console.log(1)']);
  // cmd's caret escape covers the space too (`Program^ Files`), which is the
  // cross-spawn recipe this helper follows — the node children keep launching.
  assert.ok(line.startsWith('^"C:\\Program^ Files\\nodejs\\node.exe^" '), line);
});

test('run: cmd metacharacters in an argument are neutralised, including % and !', () => {
  const line = commandLine('npx.cmd', ['deploy', '--message', '50% done!']);
  assert.ok(line.includes('^%'), `% must be caret-escaped: ${line}`);
  assert.ok(line.includes('^!'), `! must be caret-escaped: ${line}`);
  // a percent sign is never doubled (that is a batch-file escape, not a cmd one)
  assert.ok(!line.includes('%%'), line);
});