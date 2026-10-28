import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoD1Name,
  isValidD1Id,
  isValidD1Name,
  isValidWorkerName,
  parseD1Id,
  parseD1ListOutput,
  parseJsonOutput,
  parseTableCountOutput,
  resolveSchemaAction,
  slugifyWorkerName,
  updateWranglerD1Id,
  wranglerD1TargetProblem,
} from '../deploy.mjs';
import { readState, STATE_FILE, writeState } from '../lw-state.mjs';
import { runCapture } from '../run.mjs';

const DB_ID = '9e355138-3a4c-4f5d-9b6e-2a1f0c7d8e9a';
const OTHER_ID = '11111111-2222-3333-4444-555555555555';
const ACCOUNT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('runCapture keeps shell-special argument text intact', () => {
  const r = runCapture(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', 'a b', 'c&d'],
    { timeout: 30000 },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['a b', 'c&d']);
});

test('worker names are canonical, bounded and safe for the shell', () => {
  assert.equal(slugifyWorkerName('My Laravel App!'), 'my-laravel-app');
  assert.equal(slugifyWorkerName('A--B'), 'a-b');
  assert.equal(slugifyWorkerName('---'), 'laravel-workers-app');
  assert.equal(slugifyWorkerName('---abc---'), 'abc');
  assert.equal(slugifyWorkerName('a'.repeat(70)).length, 63);
  assert.equal(isValidWorkerName('my-worker'), true);
  assert.equal(isValidWorkerName('a'), true);
  assert.equal(isValidWorkerName('-bad'), false);
  assert.equal(isValidWorkerName('UPPER'), false);
  assert.equal(isValidWorkerName('bad_name'), false);
  assert.equal(isValidWorkerName('a'.repeat(64)), false);
});

test('D1 ids are validated and parsed from both wrangler output shapes', () => {
  assert.equal(isValidD1Id(DB_ID), true);
  assert.equal(isValidD1Id('not-a-uuid'), false);
  assert.equal(parseD1Id(`{"database_id":"${DB_ID}"}`), DB_ID);
  assert.equal(parseD1Id(`database_id = "${DB_ID}"`), DB_ID);
  assert.equal(parseD1Id('nothing here'), null);
});

test('D1 names are safe to pass through the CLI shell', () => {
  assert.equal(isValidD1Name('app-db'), true);
  assert.equal(isValidD1Name('app_db'), true);
  assert.equal(isValidD1Name('app.db'), true);
  assert.equal(isValidD1Name('app db'), false);
  assert.equal(isValidD1Name('-app'), false);
  assert.equal(isValidD1Name('a'.repeat(64)), false);
  assert.equal(isValidD1Name(autoD1Name('a'.repeat(63))), true);
  assert.equal(autoD1Name('a'.repeat(63)).length, 63);
  assert.match(autoD1Name('my-worker'), /^my-worker-db$/);
});

test('JSON output survives a wrangler banner', () => {
  const parsed = parseJsonOutput('[wrangler] {\n  "ok": true\n}');
  assert.deepEqual(parsed, { ok: true });
  assert.equal(parseJsonOutput('not json'), null);
});

test('D1 list output accepts arrays and result wrappers', () => {
  const raw = `[{"name":"app-db","uuid":"${DB_ID}"}]`;
  assert.equal(parseD1ListOutput(raw)[0].name, 'app-db');
  assert.equal(parseD1ListOutput(`{"result":${raw}}`)[0].uuid, DB_ID);
  assert.equal(parseD1ListOutput(`{"databases":${raw}}`)[0].name, 'app-db');
  assert.equal(parseD1ListOutput('not json'), null);
});

test('table-count parsing supports rows and meta, and refuses unknown output', () => {
  assert.equal(parseTableCountOutput('[{"results":[{"n":3}],"success":true}]'), 3);
  assert.equal(parseTableCountOutput('[{"results":[],"meta":{"num_tables":0}}]'), 0);
  assert.equal(parseTableCountOutput('banner\n[{"meta":{"num_tables":2}}]'), 2);
  assert.equal(parseTableCountOutput('not json'), null);
  assert.equal(parseTableCountOutput('[{"results":[]}]'), null);
});

test('D1 injection updates the matching entry and never dereferences a missing id', () => {
  const placeholder = `{"d1_databases":[{"database_name":"app-db","database_id":"REPLACE_WITH_D1_ID"}]}`;
  const set = updateWranglerD1Id(placeholder, 'app-db', DB_ID);
  assert.equal(set.status, 'set');
  assert.match(set.text, new RegExp(DB_ID));

  const renamed = updateWranglerD1Id(placeholder, 'other-db', DB_ID);
  assert.equal(renamed.status, 'set');
  assert.match(renamed.text, /"database_name":"other-db"/);
  assert.match(renamed.text, new RegExp(DB_ID));

  const different = `{"d1_databases":[{"database_name":"app-db","database_id":"${OTHER_ID}"}]}`;
  const updated = updateWranglerD1Id(different, 'app-db', DB_ID);
  assert.equal(updated.status, 'updated');
  assert.match(updated.text, new RegExp(DB_ID));
  assert.doesNotMatch(updated.text, new RegExp(OTHER_ID));

  const same = updateWranglerD1Id(different, 'app-db', OTHER_ID);
  assert.equal(same.status, 'already');
  assert.equal(same.text, different);

  const missing = updateWranglerD1Id('{"d1_databases":[{"database_name":"app-db"}]}', 'app-db', DB_ID);
  assert.equal(missing.status, 'missing-id');
  assert.equal(missing.text, '{"d1_databases":[{"database_name":"app-db"}]}');

  const noEntry = updateWranglerD1Id('{"d1_databases":[{"database_name":"other-db"}]}', 'app-db', DB_ID);
  assert.equal(noEntry.status, 'no-entry');
  assert.equal(noEntry.text, '{"d1_databases":[{"database_name":"other-db"}]}');
});

test('state patches preserve deploy metadata while changing one field', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeState(dir, {
    account: { id: ACCOUNT_ID, name: 'Old Name', email: 'old@example.com' },
    deployedAt: '2026-10-28T00:00:00.000Z',
    workerName: 'my-worker',
    workerUrl: 'https://my-worker.example.workers.dev',
    d1: {
      databaseName: 'my-worker-db',
      databaseId: DB_ID,
      schemaAppliedAt: '2026-10-28T00:01:00.000Z',
      schemaHash: 'abc123',
    },
  });
  writeState(dir, {
    account: { name: 'New Name', email: 'new@example.com' },
    d1: { databaseName: 'renamed-db' },
  });

  const state = readState(dir, { strict: true });
  assert.equal(state.account.id, ACCOUNT_ID);
  assert.equal(state.account.name, 'New Name');
  assert.equal(state.account.email, 'new@example.com');
  assert.equal(state.workerName, 'my-worker');
  assert.equal(state.workerUrl, 'https://my-worker.example.workers.dev');
  assert.equal(state.deployedAt, '2026-10-28T00:00:00.000Z');
  assert.equal(state.d1.databaseName, 'renamed-db');
  assert.equal(state.d1.databaseId, DB_ID);
  assert.equal(state.d1.schemaAppliedAt, '2026-10-28T00:01:00.000Z');
});

test('legacy state without account metadata stays usable', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-state-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, STATE_FILE), JSON.stringify({
    schemaVersion: 1,
    workerName: 'my-worker',
    d1: { databaseId: DB_ID },
  }), 'utf8');

  const state = readState(dir, { strict: true });
  assert.deepEqual(state.account, { id: null, name: null, email: null });
  assert.equal(state.workerName, 'my-worker');

  writeState(dir, { account: { id: ACCOUNT_ID.toUpperCase(), name: 'Main' } });
  assert.equal(readState(dir, { strict: true }).account.id, ACCOUNT_ID);
});

test('state rejects malformed account metadata', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-state-account-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, STATE_FILE), '{"schemaVersion":1,"account":"main"}', 'utf8');
  assert.throws(() => readState(dir, { strict: true }), /invalid "account"/);

  writeFileSync(join(dir, STATE_FILE), '{"schemaVersion":1,"account":{"id":"nope"}}', 'utf8');
  assert.throws(() => readState(dir, { strict: true }), /invalid "account\.id"/);

  writeFileSync(join(dir, STATE_FILE), '{"schemaVersion":1,"account":{"name":7}}', 'utf8');
  assert.throws(() => readState(dir, { strict: true }), /invalid "account\.name"/);

  writeFileSync(join(dir, STATE_FILE), '{"schemaVersion":1}', 'utf8');
  assert.throws(
    () => writeState(dir, { account: { id: 'nope' } }),
    /refusing to write/,
  );
});

test('a damaged state file is visible to status but stops deploy', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-state-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, STATE_FILE), '{not json', 'utf8');

  assert.equal(readState(dir).workerName, null);
  assert.throws(() => readState(dir, { strict: true }), /could not read/);
  assert.throws(() => writeState(dir, { workerName: 'new-worker' }), /could not read/);
});

test('a future state schema is not silently downgraded', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-state-future-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, STATE_FILE), '{"schemaVersion":99}', 'utf8');

  assert.equal(readState(dir).workerName, null);
  assert.throws(() => readState(dir, { strict: true }), /unsupported schemaVersion/);
});

test('state fields with the wrong type are rejected in strict mode', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-state-types-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, STATE_FILE), '{"schemaVersion":1,"workerName":7}', 'utf8');
  assert.throws(() => readState(dir, { strict: true }), /invalid "workerName"/);

  writeFileSync(join(dir, STATE_FILE), '{"schemaVersion":1,"d1":{"databaseId":5}}', 'utf8');
  assert.throws(() => readState(dir, { strict: true }), /invalid "d1\.databaseId"/);
  writeFileSync(join(dir, STATE_FILE), '{"schemaVersion":1}', 'utf8');
  assert.throws(() => writeState(dir, { workerName: 7 }), /refusing to write/);
  assert.throws(() => writeState(dir, { schemaVersion: 99 }), /refusing to write/);
});

test('an absent state file is an empty, writable state', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-state-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const state = readState(dir, { strict: true });
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.workerName, null);
  assert.equal(state.d1.databaseId, null);

  writeState(dir, { workerName: 'my-worker' });
  assert.equal(readState(dir, { strict: true }).workerName, 'my-worker');
});

test('schema decisions are shared by the real run and --plan', () => {
  const base = { schemaExists: true, count: 0, currentHash: 'new', recordedHash: 'old' };
  assert.equal(resolveSchemaAction({ ...base, count: null }).action, 'unknown');
  assert.equal(resolveSchemaAction({ ...base, count: null, skipSchema: true }).reason, 'flag');
  assert.equal(resolveSchemaAction({ ...base, schemaApply: true }).reason, 'flag');
  assert.equal(resolveSchemaAction(base).reason, 'empty');
  assert.equal(
    resolveSchemaAction({ ...base, count: 2, currentHash: 'same', recordedHash: 'same' }).reason,
    'already-applied',
  );
  assert.equal(
    resolveSchemaAction({ ...base, count: 2, yes: true }).action,
    'fail',
  );
  assert.match(
    resolveSchemaAction({ ...base, count: 2, yes: true }).message,
    /--schema=apply/,
  );
  assert.equal(resolveSchemaAction({ ...base, count: 2 }).reason, 'drift');
  assert.equal(
    resolveSchemaAction({ ...base, count: 2, recordedHash: null, yes: true }).reason,
    'tables-yes',
  );
  assert.equal(
    resolveSchemaAction({ ...base, count: 2, recordedHash: null }).reason,
    'tables',
  );
  assert.equal(resolveSchemaAction({ ...base, schemaExists: false }).action, 'none');
});

test('D1 target refusal statuses are explicit and never guess', () => {
  const ok = `{"d1_databases":[{"binding":"DB","database_name":"app-db","database_id":"${DB_ID}"}]}`;
  assert.equal(wranglerD1TargetProblem(ok, 'app-db'), null);
  assert.equal(
    wranglerD1TargetProblem('{"d1_databases":[{"database_name":"app-db","database_id":"REPLACE_WITH_D1_ID"}]}', 'app-db'),
    null,
  );

  assert.match(wranglerD1TargetProblem('{}', 'app-db'), /no d1_databases array/);
  assert.match(wranglerD1TargetProblem('{"d1_databases":{}}', 'app-db'), /not an array of objects/);
  assert.match(wranglerD1TargetProblem('[]', 'app-db'), /not a JSON object/);
  assert.match(
    wranglerD1TargetProblem('{"d1_databases":[{"binding":"DB","database_id":"REPLACE_WITH_D1_ID"}]}', 'app-db'),
    /no database_name/,
  );
  assert.match(wranglerD1TargetProblem(ok, 'other-db'), /no D1 entry named "other-db"/);
  assert.match(
    wranglerD1TargetProblem('{"d1_databases":[{"database_name":"app-db"}]}', 'app-db'),
    /no database_id/,
  );
  assert.match(
    wranglerD1TargetProblem(`{"d1_databases":[{"database_name":"app-db","database_id":"${DB_ID}"},{"database_name":"app-db","database_id":"${OTHER_ID}"}]}`, 'app-db'),
    /ambiguous/,
  );
});
