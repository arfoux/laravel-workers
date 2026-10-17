#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cmd = process.argv[2] ?? 'test';

const run = (command, args, options = {}) => {
  const res = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (res.error) {
    console.error(res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
};

if (cmd === 'test') {
  run(process.execPath, ['--test', 'kernel/tests/router.test.mjs', 'kernel/tests/db.test.mjs', 'kernel/tests/hash.test.mjs', 'kernel/tests/encrypter.test.mjs', 'kernel/tests/validator.test.mjs', 'kernel/tests/services.test.mjs', 'kernel/tests/budget.test.mjs']);
} else if (cmd === 'test:db') {
  run(process.execPath, ['--test', 'kernel/tests/db.test.mjs']);
} else if (cmd === 'test:hash') {
  run(process.execPath, ['--test', 'kernel/tests/hash.test.mjs', 'kernel/tests/encrypter.test.mjs']);
} else if (cmd === 'test:validator') {
  run(process.execPath, ['--test', 'kernel/tests/validator.test.mjs']);
} else if (cmd === 'test:services') {
  run(process.execPath, ['--test', 'kernel/tests/services.test.mjs']);
} else if (cmd === 'test:budget') {
  run(process.execPath, ['--test', 'kernel/tests/budget.test.mjs']);
} else if (cmd === 'test:corpus') {
  run(process.execPath, ['compiler/tests/run-corpus.mjs']);
} else if (cmd === 'bench') {
  run(process.execPath, ['tools/bench.mjs']);
} else if (cmd === 'check:docs') {
  run(process.execPath, ['tools/docs-check.mjs']);
} else if (cmd === 'build') {
  if (!existsSync(join(root, 'build.mjs'))) {
    console.error('laravel-workers build: build.mjs not found — run inside a Laravel app edge checkout.');
    process.exit(1);
  }
  run(process.execPath, ['build.mjs', '--strict']);
} else if (cmd === 'verify') {
  const php = process.env.PHP_BIN ?? 'php';
  if (!existsSync(join(root, 'tools', 'verify-s0.php'))) {
    console.error('laravel-workers verify: tools/verify-s0.php not found.');
    process.exit(1);
  }
  if (!existsSync(join(dirname(root), 'vendor', 'autoload.php'))) {
    console.log('VERIFY-S0: SKIP (no Laravel vendor/ in parent checkout).');
    process.exit(0);
  }
  run(php, ['tools/verify-s0.php']);
} else {
  console.error(`laravel-workers: unknown command "${cmd}". Try: test | test:db | test:hash | test:validator | test:services | test:budget | test:corpus | bench | check:docs | build | verify`);
  process.exit(1);
}
