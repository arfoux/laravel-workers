// tools/tests/verdict-action.test.mjs — the verdict action publishes parsed
// facts only, and reads only the conventional log name inside the workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const main = join(repoRoot, 'action', 'verdict', 'main.mjs');

function workspaceWithLog(log) {
  const root = mkdtempSync(join(tmpdir(), 'lw-verdict-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'edge-build.log'), log);
  return { root, ws: join(root, 'workspace') };
}

function run(ws, { inputLog, sha, repo } = {}) {
  return spawnSync(process.execPath, [main], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_WORKSPACE: ws,
      INPUT_COMMENT: 'false', // never touch the network
      INPUT_LOG: inputLog ?? '',
      GITHUB_SHA: sha ?? '',
      GITHUB_REPOSITORY: repo ?? '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
  });
}

const LOG = [
  'coverage: all 7 route(s) handled',
  'READINESS: RUNS WITH DECLARED GAPS',
  'schema: sqlite (12 table(s))',
  'declared gaps (2)',
  'SECRET-CANARY-DO-NOT-PUBLISH',
  'https://attacker.example/steal?x=[click here]',
].join('\n');

test('the comment carries parsed verdict fields, never raw log lines', () => {
  const { root, ws } = workspaceWithLog(LOG);
  try {
    const r = run(ws, { sha: '0123456789abcdef', repo: 'acme/app' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /### Verdict: RUNS WITH DECLARED GAPS/);
    assert.match(r.stdout, /\*\*7\/7 routes\*\* handled/);
    assert.match(r.stdout, /\*\*12 tables\*\*/);
    assert.match(r.stdout, /commit `0123456`/);
    assert.match(r.stdout, /acme\/app/);
    assert.doesNotMatch(r.stdout, /SECRET-CANARY-DO-NOT-PUBLISH/);
    assert.doesNotMatch(r.stdout, /attacker\.example/);
    assert.doesNotMatch(r.stdout, /declared gaps \(2\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('INPUT_LOG cannot point outside the workspace', () => {
  const { root, ws } = workspaceWithLog('READINESS: RUNS ON THE EDGE\n');
  try {
    writeFileSync(join(root, 'secret.txt'), 'OUTSIDE-CANARY');
    const r = run(ws, { inputLog: join(root, 'secret.txt') });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /OUTSIDE-CANARY/);
    // The ignored path falls back to the workspace log, not to the secret.
    assert.match(r.stdout, /### Verdict: RUNS ON THE EDGE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an attacker-chosen verdict string is replaced, not republished', () => {
  const { root, ws } = workspaceWithLog('READINESS: [click](https://attacker.example)\n');
  try {
    const r = run(ws);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /### Verdict: UNKNOWN/);
    assert.doesNotMatch(r.stdout, /attacker\.example/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
