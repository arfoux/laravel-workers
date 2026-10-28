#!/usr/bin/env node
// tools/run.mjs — the one place that knows how to spawn external CLIs.
//
// Windows cannot execute `.cmd` shims directly from child_process.spawn().
// Both deploy and doctor need npx, so they share this helper instead of each
// carrying their own platform guess. Keep arguments internal, validated or
// relative: shell:true on Windows is a shell, not an argument vector — quoting
// alone does not stop `%VAR%` expansion, so quoteWindowsArg() also caret-escapes
// cmd's metacharacters.

import { spawnSync } from 'node:child_process';

const WINDOWS = process.platform === 'win32';

export const NPX = WINDOWS ? 'npx.cmd' : 'npx';

/**
 * Quote one argument for cmd.exe. `spawnSync(..., { shell: true })` joins an
 * argument vector with spaces and then hands the whole line to `cmd.exe /d /s
 * /c`, so values such as a D1 name or a path with a space must be quoted here —
 * and, crucially, neutralized against cmd's variable expansion: `cmd` expands
 * `%VAR%` (and `!VAR!` when delayed expansion is on) *even inside quotes*, so a
 * path or name containing `%` would otherwise be substituted or dropped. The
 * recipe (the same one `cross-spawn` uses for `.cmd`/`.bat` shims) wraps the
 * argument in quotes and prefixes every cmd metacharacter — including `%`, `!`
 * and the surrounding quotes — with `^`, which cmd strips while keeping the
 * literal text. Do not "simplify" this to a bare quote or to `%%`: `%%` is a
 * batch-file escape and on a `cmd /c` command line it stays a literal `%%`.
 */
function quoteWindowsArg(value) {
  let arg = String(value);
  if (arg === '') return '""';
  // Escape backslash runs that precede a quote, then any trailing backslashes,
  // so the argument still ends exactly at the closing quote.
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  arg = arg.replace(/(?=(\\+?)?)\1$/, '$1$1');
  arg = '"' + arg + '"';
  return arg.replace(/([()%!^"<>&|;, *?])/g, '^$1');
}

function commandLine(cmd, args) {
  return [cmd, ...args].map(quoteWindowsArg).join(' ');
}

function spawnOptions(opts) {
  return {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
    ...(WINDOWS ? { shell: true } : {}),
  };
}

export function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(
    WINDOWS ? commandLine(cmd, args) : cmd,
    WINDOWS ? [] : args,
    spawnOptions(opts),
  );
  return {
    error: res.error || null,
    status: res.status,
    signal: res.signal || null,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

export function runInherit(cmd, args, opts = {}) {
  return spawnSync(
    WINDOWS ? commandLine(cmd, args) : cmd,
    WINDOWS ? [] : args,
    { stdio: 'inherit', ...opts, ...(WINDOWS ? { shell: true } : {}) },
  );
}
