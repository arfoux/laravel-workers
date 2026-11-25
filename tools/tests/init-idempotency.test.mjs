// tools/tests/init-idempotency.test.mjs — `init` must be safe to re-run.
//
// `init` scaffolds four files from an app root: registry.json, wrangler.jsonc,
// .env and .gitignore. A second run must not rewrite any of them: doing so would
// reset a filled-in D1 database_id, rotate a deployed APP_KEY, or duplicate the
// .gitignore marker. This test runs the real CLI twice in a throwaway Laravel
// app and pins both the file bytes and the skip messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(dirname(here));
const init = join(repo, 'tools', 'init.mjs');
const scoped = ['registry.json', 'wrangler.jsonc', '.env', '.gitignore'];

function run(app) {
  const result = spawnSync(process.execPath, [init], {
    cwd: app,
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('a second init run leaves every scaffolded file byte-identical', (t) => {
  const app = mkdtempSync(join(tmpdir(), 'lw-init-'));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  writeFileSync(join(app, 'artisan'), '#!/usr/bin/env php\n');
  writeFileSync(join(app, '.env.example'), 'APP_NAME=Laravel\nAPP_KEY=\n');
  writeFileSync(join(app, '.gitignore'), '/vendor\n/node_modules\n');

  run(app);
  const before = Object.fromEntries(scoped.map((name) => [name, readFileSync(join(app, name), 'utf8')]));
  const second = run(app);
  const after = Object.fromEntries(scoped.map((name) => [name, readFileSync(join(app, name), 'utf8')]));

  assert.deepEqual(after, before);
  assert.match(second, /registry\.json exists — skipped/);
  assert.match(second, /wrangler\.jsonc exists — skipped/);
  assert.match(second, /\.env already has APP_KEY — skipped/);
  assert.match(second, /\.gitignore — nothing to add/);
});
