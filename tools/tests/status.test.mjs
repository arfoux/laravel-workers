// tools/tests/status.test.mjs — what `status` says, in the three situations.
//
// The finding (docs/EVIDENCE.md 4) was that a LIVE app printed "no deploy recorded
// for this app yet", which reads as "not deployed". The cases below are the ones
// that made that indistinguishable: nothing at all, a wrangler config with no
// record, a damaged state file, and a recorded deploy carrying the commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'status.mjs');

function appDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-status-'));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
  }
  return dir;
}

function run(dir) {
  const res = spawnSync(process.execPath, [STATUS], { cwd: dir, encoding: 'utf8' });
  return { code: res.status, out: res.stdout + res.stderr };
}

const recorded = (extra = {}) => ({
  schemaVersion: 1,
  account: { id: 'a'.repeat(32), name: 'acct', email: 'lw@example.test' },
  deployedAt: '2026-11-14T10:00:00.000Z',
  workerName: 'my-app',
  workerUrl: 'https://my-app.acct.workers.dev',
  d1: { binding: 'DB', databaseName: 'my-app-db', databaseId: '11111111-1111-1111-1111-111111111111' },
  sourceSha: '0123456789abcdef0123456789abcdef01234567',
  sourceDirty: true,
  toolVersion: '0.5.0',
  versionId: '22222222-3333-4444-5555-666666666666',
  ...extra,
});

test('status: a fresh app says nothing is recorded yet', () => {
  const dir = appDir();
  try {
    const { code, out } = run(dir);
    assert.equal(code, 0);
    assert.match(out, /no deploy recorded for this app yet/);
    assert.match(out, /run `npx laravel-workers deploy`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status: a wrangler config with no record names the case instead of claiming nothing was deployed', () => {
  const dir = appDir({ 'wrangler.jsonc': '{"name":"my-app","assets":{"directory":"./dist/public"}}\n' });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 0);
    assert.match(out, /recorded no deploy for this app/);
    assert.match(out, /wrangler\.jsonc is present/);
    assert.match(out, /deployed outside laravel-workers/);
    assert.match(out, /not known from here/);
    assert.doesNotMatch(out, /no deploy recorded for this app yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status: a build record without a deploy is shown as the dist commit, not as a deploy', () => {
  const dir = appDir({
    'dist/build-info.json': {
      toolVersion: '0.5.0',
      builtAt: '2026-11-14T09:00:00.000Z',
      source: { sha: '0123456789abcdef0123456789abcdef01234567', dirty: false },
    },
  });
  try {
    const { out } = run(dir);
    assert.match(out, /this toolchain recorded no deploy/);
    assert.match(out, /dist\/ was built from 0123456/);
    assert.match(out, /by laravel-workers 0\.5\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status: a recorded deploy prints the worker, the commit and the version', () => {
  const dir = appDir({ 'lw-state.json': recorded() });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 0);
    assert.match(out, /worker  : my-app/);
    assert.match(out, /url     : https:\/\/my-app\.acct\.workers\.dev/);
    assert.match(out, /deployed: 2026-11-14T10:00:00\.000Z/);
    assert.match(out, /commit  : 0123456 \(\+uncommitted changes\)/);
    assert.match(out, /version : 22222222-3333-4444-5555-666666666666/);
    assert.doesNotMatch(out, /no deploy recorded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status: a damaged state file stops with exit 2 instead of pretending nothing is recorded', () => {
  const dir = appDir({ 'lw-state.json': '{not json' });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 2);
    assert.match(out, /could not read lw-state\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});