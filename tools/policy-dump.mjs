#!/usr/bin/env node
// tools/policy-dump.mjs — build-time replacement for tools/policy-dump.php.
//
// The Gate's effective state (which policy answers for a model, the global
// before/after callbacks, the Gate::define abilities) is assembled at RUNTIME
// by the app's service providers — a provider can register anything, and
// replicating Laravel's Gate resolution statically would be a duplicate of
// framework logic with a real chance of silent divergence. So the PHP oracle
// remains the source of truth here: this module is the node-side entry point
// the build calls (the same shape model-dump.mjs takes), so the build's PHP
// dependency for this one tool is contained to an oracle call the edge never
// runs.
//
// Usage: node tools/policy-dump.mjs "App\Models\Post" ["App\Models\User" ...]
// Output (stdout): the same JSON the PHP tool emitted, verbatim:
//   { "globals": { before, after, abilities, definitions },
//     "models":  [ { model, policy, file, error, hasMagicCall, before, methods } ] }
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePhp } from './php-runtime.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isMain =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].replace(/\\/g, '/').endsWith('/tools/policy-dump.mjs'));

if (isMain) {
  const appDir =
    process.env.LW_APP_ROOT ||
    (existsSync(join(process.cwd(), 'artisan')) ? process.cwd() : null);
  if (!appDir) {
    process.stderr.write('policy-dump.mjs: cannot find app root (set LW_APP_ROOT)\n');
    process.exit(1);
  }

  const fqcns = process.argv.slice(2);
  if (!fqcns.length) {
    process.stderr.write('policy-dump.mjs: no FQCNs given\n');
    process.exit(1);
  }

  const php = resolvePhp({ requirement: '>=8.1' });
  const raw = execFileSync(php.bin, [join(__dirname, 'policy-dump.php'), ...fqcns], {
    cwd: appDir,
    env: { ...process.env, LW_APP_ROOT: appDir },
  }).toString('utf8');
  process.stdout.write(raw);
}
