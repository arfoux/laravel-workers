import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(dirname(here));
const cli = join(repo, 'bin', 'laravel-workers.mjs');

function help() {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, [cli, '--help'], {
    cwd: repo,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('CLI help mirrors the shadow harness flags and coverage floor', () => {
  const text = help();
  assert.match(text, /shadow \[--app <root>\] \[--scenarios <file>\] \[--build\] \[--json\]/);
  assert.match(text, /--scenarios <file>\s+scenario file/);
  assert.match(text, /--build\s+run build\.mjs --strict/);
  assert.match(text, /--json\s+machine-readable report on stderr/);
  assert.match(text, /byte-identical STEP coverage floor: 100% by default/);
  assert.match(text, /LW_SHADOW_MIN_COVERAGE=0\.\.1 overrides/);
});

test('CLI help states doctor WARN semantics and what --strict upgrades', () => {
  const text = help();
  assert.match(text, /missing app root\/PHP\/vendor\/wrangler becomes FAIL \(2\)/);
  assert.match(text, /plain doctor reports them as WARNs and exits 0/);
});
