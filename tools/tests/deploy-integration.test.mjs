import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = dirname(here);
const deploy = join(toolsDir, 'deploy.mjs');
const fakeBuild = join(here, 'fixtures', 'fake-build.mjs');
const fakeWrangler = join(here, 'fixtures', 'fake-wrangler.mjs');

const DB_ID = '9e355138-3a4c-4f5d-9b6e-2a1f0c7d8e9a';
const OTHER_ID = '11111111-2222-3333-4444-555555555555';
const ACCOUNT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_ACCOUNT_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OLD_SCHEMA = 'CREATE TABLE old_users (id INTEGER);\n';
const SCHEMA = 'CREATE TABLE users (id INTEGER);\nCREATE TABLE posts (id INTEGER);\n';
const CONFIG = `{
  // keep this comment
  "name": "my-app",
  "main": "./dist/src/worker.mjs",
  "assets": { "directory": "./dist/public", "binding": "ASSETS" },
  "d1_databases": [
    { "binding": "DB", "database_name": "my-app-db", "database_id": "REPLACE_WITH_D1_ID" },
  ],
}
`;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function stateFor({
  schemaHash = null,
  databaseId = DB_ID,
  databaseName = 'my-app-db',
  account = null,
} = {}) {
  return {
    schemaVersion: 1,
    ...(account ? { account } : {}),
    deployedAt: '2026-10-27T10:00:00.000Z',
    workerName: 'my-app',
    workerUrl: 'https://old.example.workers.dev',
    d1: {
      binding: 'DB',
      databaseName,
      databaseId,
      schemaAppliedAt: schemaHash ? '2026-10-27T10:00:00.000Z' : null,
      schemaHash,
    },
  };
}

function makeApp(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-int-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'artisan'), '', 'utf8');

  const schema = options.schema === undefined ? SCHEMA : options.schema;
  if (schema !== null) {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'schema.sql'), schema, 'utf8');
  }
  const schemaSource = join(dir, 'fixture-schema.sql');
  if (schema !== null) writeFileSync(schemaSource, schema, 'utf8');

  const config = options.config === undefined ? CONFIG : options.config;
  if (config !== null) writeFileSync(join(dir, 'wrangler.jsonc'), config, 'utf8');

  const statePath = join(dir, 'lw-state.json');
  if (options.state === 'corrupt') {
    writeFileSync(statePath, '{ not json', 'utf8');
  } else if (options.state) {
    writeFileSync(statePath, JSON.stringify(options.state, null, 2) + '\n', 'utf8');
  }

  const fakeState = join(dir, 'fake-wrangler-state.json');
  writeFileSync(fakeState, JSON.stringify({ databases: options.databases || [] }, null, 2), 'utf8');
  const wranglerLog = join(dir, 'fake-wrangler.log');
  const buildLog = join(dir, 'fake-build.log');

  function run(args, extraEnv = {}) {
    // The host may have a real Cloudflare account selected; tests choose
    // explicitly. Clear inherited selectors before applying test overrides.
    const env = { ...process.env };
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.CF_ACCOUNT_ID;
    for (const key of Object.keys(env)) {
      if (key.startsWith('FAKE_ACCOUNT_') || key.startsWith('FAKE_WHOAMI_')) delete env[key];
    }
    Object.assign(env, {
      LW_BUILD_BIN: fakeBuild,
      LW_WRANGLER_BIN: fakeWrangler,
      FAKE_WRANGLER_STATE: fakeState,
      FAKE_WRANGLER_LOG: wranglerLog,
      FAKE_BUILD_LOG: buildLog,
      ...extraEnv,
    });
    if (schema !== null) env.FAKE_SCHEMA_SOURCE = schemaSource;
    else delete env.FAKE_SCHEMA_SOURCE;
    delete env.FAKE_SCHEMA_SQL;

    return spawnSync(process.execPath, [deploy, ...args], {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  function readState() {
    return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  }

  function readConfig() {
    return existsSync(join(dir, 'wrangler.jsonc'))
      ? readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')
      : null;
  }

  function fakeDatabases() {
    return JSON.parse(readFileSync(fakeState, 'utf8')).databases;
  }

  function calls() {
    if (!existsSync(wranglerLog)) return [];
    return readFileSync(wranglerLog, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function buildCalls() {
    if (!existsSync(buildLog)) return [];
    return readFileSync(buildLog, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function schemaCalls() {
    return calls().filter((call) =>
      call.args?.[0] === 'd1'
      && call.args?.[1] === 'execute'
      && !/count\s*\(\s*\*\s*\)/i.test(call.sql || ''));
  }

  function countCalls() {
    return calls().filter((call) =>
      call.args?.[0] === 'd1'
      && call.args?.[1] === 'execute'
      && /count\s*\(\s*\*\s*\)/i.test(call.sql || ''));
  }

  function whoamiCalls() {
    return calls().filter((call) => call.args?.[0] === 'whoami');
  }

  return {
    dir,
    statePath,
    fakeState,
    wranglerLog,
    buildLog,
    run,
    readState,
    readConfig,
    fakeDatabases,
    calls,
    buildCalls,
    schemaCalls,
    countCalls,
    whoamiCalls,
    schema,
  };
}

test('--plan is zero-mutation: no build, config/state write, or Wrangler call', (t) => {
  const app = makeApp(t);
  const beforeConfig = app.readConfig();
  const beforeSchema = readFileSync(join(app.dir, 'dist', 'schema.sql'), 'utf8');

  const result = app.run(['--plan', '--mode', '3', '--d1-auto', '--name', 'my-app']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plan — nothing will be written/);
  assert.match(result.stdout, /mode\s+3/);
  assert.match(result.stdout, /worker\s+my-app/);
  assert.match(result.stdout, /account\s+not recorded; a real run records/);
  assert.match(result.stdout, /my-app-db/);
  assert.match(result.stdout, /schema/);
  assert.match(result.stdout, /lw-state\.json/);
  assert.equal(app.readConfig(), beforeConfig);
  assert.equal(readFileSync(join(app.dir, 'dist', 'schema.sql'), 'utf8'), beforeSchema);
  assert.equal(existsSync(app.statePath), false);
  assert.equal(existsSync(join(app.dir, '.cache')), false);
  assert.deepEqual(app.calls(), []);
  assert.deepEqual(app.buildCalls(), []);
});

test('--plan with an unresolved --d1-id marks the config target unchecked without calling Wrangler', (t) => {
  const app = makeApp(t);

  const result = app.run([
    '--plan', '--mode', '3', '--d1-id', OTHER_ID, '--name', 'my-app',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /target not checked/);
  assert.match(result.stdout, /may change after D1 lookup/);
  assert.deepEqual(app.calls(), []);
  assert.deepEqual(app.buildCalls(), []);
  assert.equal(existsSync(app.statePath), false);
});

test('--plan --check verifies a matching hash without writing or applying schema', (t) => {
  const app = makeApp(t, {
    state: stateFor({
      schemaHash: sha256(SCHEMA),
      account: { id: ACCOUNT_ID, name: 'Fake Account', email: 'fake@example.com' },
    }),
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 3 }],
  });
  const beforeState = readFileSync(app.statePath, 'utf8');
  const beforeConfig = app.readConfig();

  const result = app.run([
    '--plan', '--mode', '3', '--d1-auto', '--name', 'my-app', '--check',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /account\s+.*matches lw-state\.json/);
  assert.match(result.stdout, /already applied; hash matches/);
  assert.equal(app.countCalls().length, 1);
  assert.equal(app.schemaCalls().length, 0);
  assert.equal(app.calls().filter((call) => call.args?.[1] === 'create').length, 0);
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'deploy').length, 0);
  assert.equal(readFileSync(app.statePath, 'utf8'), beforeState);
  assert.equal(app.readConfig(), beforeConfig);
});

test('--plan --check with drift and --yes exits 2 and explains both safe flags', (t) => {
  const app = makeApp(t, {
    state: stateFor({ schemaHash: sha256(OLD_SCHEMA) }),
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 3 }],
  });
  const beforeState = readFileSync(app.statePath, 'utf8');
  const beforeConfig = app.readConfig();

  const result = app.run([
    '--plan', '--mode', '3', '--d1-auto', '--name', 'my-app', '--yes', '--check',
  ]);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /schema drift/);
  assert.match(result.stdout, /--schema=apply/);
  assert.match(result.stdout, /--skip-schema/);
  assert.match(result.stdout, /Plan NOT ready/);
  assert.equal(app.schemaCalls().length, 0);
  assert.equal(readFileSync(app.statePath, 'utf8'), beforeState);
  assert.equal(app.readConfig(), beforeConfig);
});

test('--plan uses a manually renamed wrangler.jsonc name without writing', (t) => {
  const app = makeApp(t);
  const beforeConfig = app.readConfig();

  const result = app.run(['--plan', '--mode', '3']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /config\s+name "my-app" \(already\)/);
  assert.equal(app.readConfig(), beforeConfig);
  assert.equal(existsSync(app.statePath), false);
});

test('--plan --check does not create a missing D1', (t) => {
  const app = makeApp(t);
  const beforeConfig = app.readConfig();

  const result = app.run([
    '--plan', '--mode', '3', '--d1-auto', '--name', 'my-app', '--check',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would apply dist\/schema\.sql \(D1 has 0 tables\)/);
  assert.match(result.stdout, /d1 create if missing/);
  assert.equal(app.fakeDatabases().length, 0);
  assert.equal(app.calls().filter((call) => call.args?.[1] === 'create').length, 0);
  assert.equal(app.readConfig(), beforeConfig);
  assert.equal(existsSync(app.statePath), false);
});

test('--dry-run is rejected with a --plan hint and runs nothing', (t) => {
  const app = makeApp(t);
  const result = app.run(['--dry-run', '--mode', '1']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--dry-run is not supported/);
  assert.match(result.stderr, /--plan/);
  assert.deepEqual(app.buildCalls(), []);
  assert.deepEqual(app.calls(), []);
});

test('mode 1 rejects --name before building and leaves state/config untouched', (t) => {
  const app = makeApp(t, { state: stateFor({ schemaHash: sha256(SCHEMA) }) });
  const beforeState = readFileSync(app.statePath, 'utf8');
  const beforeConfig = app.readConfig();

  const result = app.run(['--mode', '1', '--name', 'other-app']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--name requires --mode 2 or 3/);
  assert.deepEqual(app.buildCalls(), []);
  assert.equal(readFileSync(app.statePath, 'utf8'), beforeState);
  assert.equal(app.readConfig(), beforeConfig);
});

test('mode 3 creates a D1, rewrites only the placeholder value, applies schema, deploys, and records state', (t) => {
  const app = makeApp(t);
  const result = app.run(['--mode', '3', '--d1-auto', '--yes', '--name', 'my-app']);

  assert.equal(result.status, 0, result.stderr);
  const created = app.fakeDatabases()[0];
  assert.ok(created, 'fake Wrangler should have created a database');
  const config = app.readConfig();
  assert.match(config, /\/\/ keep this comment/);
  assert.match(config, new RegExp(created.uuid));
  assert.match(config, /"database_name": "my-app-db"/);
  assert.doesNotMatch(config, /REPLACE_WITH_D1_ID/);

  const state = app.readState();
  assert.equal(state.account.id, ACCOUNT_ID);
  assert.equal(state.account.name, 'Fake Account');
  assert.equal(state.account.email, 'fake@example.com');
  assert.equal(state.workerName, 'my-app');
  assert.equal(state.workerUrl, 'https://my-app.example.workers.dev');
  assert.equal(state.d1.databaseName, 'my-app-db');
  assert.equal(state.d1.databaseId, created.uuid);
  assert.equal(state.d1.schemaHash, sha256(SCHEMA));
  assert.ok(state.d1.schemaAppliedAt);
  assert.equal(app.whoamiCalls().length, 1);

  assert.equal(app.calls().filter((call) => call.args?.[1] === 'create').length, 1);
  assert.equal(app.schemaCalls().length, 1);
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'deploy').length, 1);

  for (const call of [...app.countCalls(), ...app.schemaCalls()]) {
    const configIndex = call.args.indexOf('--config');
    assert.ok(configIndex >= 0, 'D1 execute must use the resolved temporary config');
    assert.equal(existsSync(call.args[configIndex + 1]), false, 'temporary config must be cleaned up');
    assert.equal(call.configId, created.uuid);
  }
});

test('deploy refuses an account mismatch before D1 or deploy mutations', (t) => {
  const app = makeApp(t, {
    state: stateFor({
      schemaHash: sha256(SCHEMA),
      account: { id: ACCOUNT_ID, name: 'Old Account', email: 'old@example.com' },
    }),
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 3 }],
  });
  const beforeState = readFileSync(app.statePath, 'utf8');
  const beforeConfig = app.readConfig();

  const result = app.run(['--mode', '3', '--d1-auto', '--yes', '--name', 'my-app'], {
    FAKE_ACCOUNT_ID: OTHER_ACCOUNT_ID,
    FAKE_ACCOUNT_NAME: 'New Account',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Cloudflare account changed/);
  assert.match(result.stderr, /--allow-account-change/);
  assert.equal(app.buildCalls().length, 1);
  assert.equal(app.whoamiCalls().length, 1);
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'd1').length, 0);
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'deploy').length, 0);
  assert.equal(readFileSync(app.statePath, 'utf8'), beforeState);
  assert.equal(app.readConfig(), beforeConfig);
});

test('deploy refuses multiple Cloudflare accounts without an explicit selection', (t) => {
  const app = makeApp(t, { state: stateFor() });
  const beforeState = readFileSync(app.statePath, 'utf8');
  const beforeConfig = app.readConfig();

  const result = app.run(['--mode', '2', '--d1-auto', '--yes', '--name', 'my-app'], {
    FAKE_ACCOUNT_IDS: `${ACCOUNT_ID},${OTHER_ACCOUNT_ID}`,
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /authenticated to 2 Cloudflare accounts/);
  assert.equal(app.whoamiCalls().length, 1);
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'd1').length, 0);
  assert.equal(readFileSync(app.statePath, 'utf8'), beforeState);
  assert.equal(app.readConfig(), beforeConfig);
});

test('CLOUDFLARE_ACCOUNT_ID selects one of multiple accounts', (t) => {
  const app = makeApp(t, { databases: [] });

  const result = app.run(['--mode', '2', '--d1-auto', '--yes', '--name', 'my-app'], {
    FAKE_ACCOUNT_IDS: `${ACCOUNT_ID},${OTHER_ACCOUNT_ID}`,
    CLOUDFLARE_ACCOUNT_ID: OTHER_ACCOUNT_ID,
    FAKE_ACCOUNT_NAME: 'Shared',
  });

  assert.equal(result.status, 0, result.stderr);
  const created = app.fakeDatabases()[0];
  assert.ok(created, 'the explicitly selected account should be used for D1');
  const state = app.readState();
  assert.equal(state.account.id, OTHER_ACCOUNT_ID);
  assert.equal(state.account.name, 'Shared 2');
  assert.equal(state.d1.databaseId, created.uuid);
});

test('wrangler.jsonc account_id selects one of multiple accounts', (t) => {
  const config = CONFIG.replace(
    '  "name": "my-app",',
    `  "name": "my-app",\n  "account_id": "${OTHER_ACCOUNT_ID}",`,
  );
  const app = makeApp(t, { config, databases: [] });

  const result = app.run(['--mode', '2', '--d1-auto', '--yes', '--name', 'my-app'], {
    FAKE_ACCOUNT_IDS: `${ACCOUNT_ID},${OTHER_ACCOUNT_ID}`,
    FAKE_ACCOUNT_NAME: 'Shared',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(app.readState().account.id, OTHER_ACCOUNT_ID);
  assert.match(app.readConfig(), new RegExp(`"account_id": "${OTHER_ACCOUNT_ID}"`));
  assert.equal(app.fakeDatabases().length, 1);
});

test('an email/name change on the same account preserves the old URL', (t) => {
  const app = makeApp(t, {
    state: stateFor({
      schemaHash: sha256(SCHEMA),
      account: { id: ACCOUNT_ID, name: 'Old Name', email: 'old@example.com' },
    }),
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 3 }],
  });

  const result = app.run(['--mode', '2', '--d1-auto', '--yes', '--name', 'my-app'], {
    FAKE_ACCOUNT_ID: ACCOUNT_ID,
    FAKE_ACCOUNT_NAME: 'Renamed Account',
    FAKE_ACCOUNT_EMAIL: 'new@example.com',
  });

  assert.equal(result.status, 0, result.stderr);
  const state = app.readState();
  assert.equal(state.account.id, ACCOUNT_ID);
  assert.equal(state.account.name, 'Renamed Account');
  assert.equal(state.account.email, 'new@example.com');
  assert.equal(state.workerUrl, 'https://old.example.workers.dev');
  assert.equal(state.deployedAt, '2026-10-27T10:00:00.000Z');
  assert.equal(state.d1.databaseId, DB_ID);
  assert.equal(app.countCalls().length, 1);
});

test('legacy state without account metadata is upgraded on the next mode 2 run', (t) => {
  const app = makeApp(t, {
    state: stateFor({ schemaHash: sha256(SCHEMA) }),
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 3 }],
  });

  const result = app.run(['--mode', '2', '--d1-auto', '--yes', '--name', 'my-app']);

  assert.equal(result.status, 0, result.stderr);
  const state = app.readState();
  assert.equal(state.account.id, ACCOUNT_ID);
  assert.equal(state.workerUrl, 'https://old.example.workers.dev');
  assert.equal(state.deployedAt, '2026-10-27T10:00:00.000Z');
});

test('--allow-account-change switches D1 and clears stale deploy metadata', (t) => {
  const app = makeApp(t, {
    state: stateFor({
      schemaHash: sha256(SCHEMA),
      account: { id: ACCOUNT_ID, name: 'Old Account', email: 'old@example.com' },
    }),
    databases: [],
  });

  const result = app.run([
    '--mode', '2', '--d1-auto', '--yes', '--name', 'my-app', '--allow-account-change',
  ], {
    FAKE_ACCOUNT_ID: OTHER_ACCOUNT_ID,
    FAKE_ACCOUNT_NAME: 'New Account',
  });

  assert.equal(result.status, 0, result.stderr);
  const created = app.fakeDatabases()[0];
  assert.ok(created, 'the new account should get a new D1');
  const state = app.readState();
  assert.equal(state.account.id, OTHER_ACCOUNT_ID);
  assert.equal(state.account.name, 'New Account');
  assert.equal(state.workerUrl, null);
  assert.equal(state.deployedAt, null);
  assert.equal(state.d1.databaseId, created.uuid);
  assert.equal(state.d1.schemaHash, sha256(SCHEMA));
  assert.match(app.readConfig(), new RegExp(created.uuid));
  assert.doesNotMatch(app.readConfig(), new RegExp(DB_ID));
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'deploy').length, 0);
});

test('--plan shows a recorded account offline without checking it', (t) => {
  const app = makeApp(t, {
    state: stateFor({
      account: { id: ACCOUNT_ID, name: 'Fake Account', email: 'fake@example.com' },
    }),
  });

  const result = app.run(['--plan', '--mode', '3', '--d1-auto', '--name', 'my-app']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /recorded; not checked offline/);
  assert.deepEqual(app.calls(), []);
  assert.deepEqual(app.buildCalls(), []);
});

test('--plan --check refuses an account mismatch before D1 queries', (t) => {
  const app = makeApp(t, {
    state: stateFor({
      schemaHash: sha256(SCHEMA),
      account: { id: ACCOUNT_ID, name: 'Old Account', email: 'old@example.com' },
    }),
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 3 }],
  });
  const beforeState = readFileSync(app.statePath, 'utf8');
  const beforeConfig = app.readConfig();

  const result = app.run([
    '--plan', '--mode', '3', '--d1-auto', '--name', 'my-app', '--check',
  ], {
    FAKE_ACCOUNT_ID: OTHER_ACCOUNT_ID,
    FAKE_ACCOUNT_NAME: 'New Account',
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /would stop/);
  assert.match(result.stdout, /not reached \(account check would stop the run\)/);
  assert.match(result.stdout, /Plan NOT ready/);
  assert.equal(app.whoamiCalls().length, 1);
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'd1').length, 0);
  assert.equal(readFileSync(app.statePath, 'utf8'), beforeState);
  assert.equal(app.readConfig(), beforeConfig);
});

test('--plan --check allows an account switch only with --allow-account-change', (t) => {
  const app = makeApp(t, {
    state: stateFor({
      schemaHash: sha256(SCHEMA),
      account: { id: ACCOUNT_ID, name: 'Old Account', email: 'old@example.com' },
    }),
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 3 }],
  });
  const beforeState = readFileSync(app.statePath, 'utf8');
  const beforeConfig = app.readConfig();

  const result = app.run([
    '--plan', '--mode', '3', '--d1-auto', '--name', 'my-app', '--check',
    '--allow-account-change',
  ], {
    FAKE_ACCOUNT_ID: OTHER_ACCOUNT_ID,
    FAKE_ACCOUNT_NAME: 'New Account',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /allowed by --allow-account-change/);
  assert.equal(app.countCalls().length, 1);
  assert.equal(app.schemaCalls().length, 0);
  assert.equal(readFileSync(app.statePath, 'utf8'), beforeState);
  assert.equal(app.readConfig(), beforeConfig);
});

test('--plan --check names the current account when it matches the state', (t) => {
  const app = makeApp(t, {
    state: stateFor({
      schemaHash: sha256(SCHEMA),
      account: { id: ACCOUNT_ID, name: 'Old Name', email: 'old@example.com' },
    }),
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 3 }],
  });
  const beforeState = readFileSync(app.statePath, 'utf8');

  const result = app.run([
    '--plan', '--mode', '3', '--d1-auto', '--name', 'my-app', '--check',
  ], {
    FAKE_ACCOUNT_ID: ACCOUNT_ID,
    FAKE_ACCOUNT_NAME: 'Renamed Account',
    FAKE_ACCOUNT_EMAIL: 'new@example.com',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /matches lw-state\.json/);
  assert.match(result.stdout, /Renamed Account/);
  assert.equal(app.countCalls().length, 1);
  assert.equal(readFileSync(app.statePath, 'utf8'), beforeState);
});

test('--plan --check treats an unreadable account as an operational failure', (t) => {
  const app = makeApp(t, {
    state: stateFor({ account: { id: ACCOUNT_ID, name: 'Old Account' } }),
  });
  const beforeState = readFileSync(app.statePath, 'utf8');
  const beforeConfig = app.readConfig();

  const result = app.run([
    '--plan', '--mode', '3', '--d1-auto', '--name', 'my-app', '--check',
  ], { FAKE_WHOAMI_FAIL: 'not logged in' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not verify the Cloudflare account/);
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'd1').length, 0);
  assert.equal(readFileSync(app.statePath, 'utf8'), beforeState);
  assert.equal(app.readConfig(), beforeConfig);
});

test('a missing config is scaffolded without losing a recorded worker name', (t) => {
  const app = makeApp(t, { config: null, state: stateFor() });

  const result = app.run(['--mode', '3', '--d1-auto', '--yes'], {
    FAKE_SCAFFOLD_CONFIG: '1',
  });

  assert.equal(result.status, 0, result.stderr);
  const created = app.fakeDatabases()[0];
  assert.ok(created, 'fake Wrangler should have created a database');
  assert.equal(created.name, 'my-app-db');

  const config = app.readConfig();
  assert.match(config, /"name": "my-app"/);
  assert.match(config, /"database_name": "my-app-db"/);
  assert.match(config, new RegExp(created.uuid));
  assert.doesNotMatch(config, /REPLACE_WITH_D1_ID/);
  assert.equal(app.readState().workerName, 'my-app');
  assert.equal(app.readState().d1.databaseName, 'my-app-db');
});

test('mode 3 uses a manually renamed wrangler.jsonc name as the default', (t) => {
  const app = makeApp(t, {
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 0 }],
  });

  const result = app.run(['--mode', '3', '--d1-auto', '--yes']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(app.readConfig(), /\/\/ keep this comment/);
  assert.match(app.readConfig(), /"name": "my-app"/);
  assert.equal(app.readState().workerName, 'my-app');
  assert.equal(app.readState().d1.databaseId, DB_ID);
});

test('a matching recorded schema hash skips re-application under --yes', (t) => {
  const app = makeApp(t, {
    state: stateFor({ schemaHash: sha256(SCHEMA) }),
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 3 }],
  });
  const before = app.readState();

  const result = app.run(['--mode', '3', '--d1-auto', '--yes', '--name', 'my-app']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /schema skipped \(already applied; hash matches\)/);
  assert.equal(app.schemaCalls().length, 0);
  assert.equal(app.countCalls().length, 1);
  assert.equal(app.calls().filter((call) => call.args?.[1] === 'create').length, 0);
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'deploy').length, 1);

  const after = app.readState();
  assert.equal(after.d1.schemaHash, before.d1.schemaHash);
  assert.equal(after.d1.schemaAppliedAt, before.d1.schemaAppliedAt);
});

test('schema drift with --yes fails before injecting or deploying', (t) => {
  const app = makeApp(t, {
    state: stateFor({ schemaHash: sha256(OLD_SCHEMA) }),
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 3 }],
  });
  const beforeState = readFileSync(app.statePath, 'utf8');
  const beforeConfig = app.readConfig();

  const result = app.run(['--mode', '3', '--d1-id', DB_ID, '--yes', '--name', 'other-app']);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /schema drift/);
  assert.match(result.stderr, /--schema=apply/);
  assert.match(result.stderr, /--skip-schema/);
  assert.equal(app.schemaCalls().length, 0);
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'deploy').length, 0);
  assert.equal(readFileSync(app.statePath, 'utf8'), beforeState);
  assert.equal(app.readConfig(), beforeConfig);
  assert.match(app.readConfig(), /"name": "my-app"/);
  assert.doesNotMatch(app.readConfig(), new RegExp(DB_ID));
});

test('--schema=apply applies a drifted schema deliberately under --yes', (t) => {
  const app = makeApp(t, {
    state: stateFor({ schemaHash: sha256(OLD_SCHEMA) }),
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 3 }],
  });

  const result = app.run([
    '--mode', '3', '--d1-auto', '--yes', '--name', 'my-app', '--schema=apply',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(app.schemaCalls().length, 1);
  assert.equal(app.countCalls().length, 0);
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'deploy').length, 1);
  assert.equal(app.readState().d1.schemaHash, sha256(SCHEMA));
  assert.match(app.readConfig(), new RegExp(DB_ID));
});

test('--skip-schema keeps a drifted D1 untouched under --yes', (t) => {
  const app = makeApp(t, {
    state: stateFor({ schemaHash: sha256(OLD_SCHEMA) }),
    databases: [{ uuid: DB_ID, name: 'my-app-db', tables: 3 }],
  });

  const result = app.run([
    '--mode', '3', '--d1-auto', '--yes', '--name', 'my-app', '--skip-schema',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(app.schemaCalls().length, 0);
  assert.equal(app.countCalls().length, 0);
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'deploy').length, 1);
  assert.equal(app.readState().d1.schemaHash, sha256(OLD_SCHEMA));
  assert.match(app.readConfig(), new RegExp(DB_ID));
});

test('an unparseable d1 create output re-lists and records the created database', (t) => {
  const app = makeApp(t);
  const result = app.run(
    ['--mode', '3', '--d1-auto', '--yes', '--name', 'my-app'],
    { FAKE_CREATE_UNPARSEABLE: '1' },
  );

  assert.equal(result.status, 0, result.stderr);
  const created = app.fakeDatabases()[0];
  assert.ok(created);
  const state = app.readState();
  assert.equal(state.d1.databaseId, created.uuid);
  assert.match(app.readConfig(), new RegExp(created.uuid));
  assert.equal(app.calls().filter((call) => call.args?.[0] === 'd1' && call.args?.[1] === 'list').length, 2);
});

test('D1 auto refuses a config without a bindable D1 entry before creating anything', (t) => {
  const app = makeApp(t, { config: '{\n  "name": "my-app"\n}\n' });
  const beforeConfig = app.readConfig();

  const result = app.run(['--mode', '3', '--d1-auto', '--yes', '--name', 'my-app']);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /no d1_databases array/);
  assert.deepEqual(app.calls(), []);
  assert.equal(existsSync(app.statePath), false);
  assert.equal(app.readConfig(), beforeConfig);
});

test('corrupt state stops deploy with exit 2 before build', (t) => {
  const app = makeApp(t, { state: 'corrupt' });
  const result = app.run(['--mode', '1']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /lw-state\.json/);
  assert.deepEqual(app.buildCalls(), []);
  assert.deepEqual(app.calls(), []);
});

test('build failure exits 1 and leaves state/config untouched', (t) => {
  const app = makeApp(t);
  const beforeConfig = app.readConfig();

  const result = app.run(['--mode', '1'], { FAKE_BUILD_EXIT: '7' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /build failed \(exit 7\)/);
  assert.equal(existsSync(app.statePath), false);
  assert.equal(app.readConfig(), beforeConfig);
  assert.deepEqual(app.calls(), []);
});

test('invalid JSONC is a config error (2) and is never written', (t) => {
  const bad = '{\n  "name": "my-app",\n  "d1_databases": [ }\n}\n';
  const app = makeApp(t, { config: bad });

  const result = app.run(['--mode', '3', '--d1-auto', '--yes', '--name', 'my-app']);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /not valid JSONC/);
  assert.match(result.stderr, /line \d+, column \d+/);
  assert.equal(app.readConfig(), bad);
  assert.deepEqual(app.calls(), []);
});

test('--plan --check reports a missing --d1-id without creating or writing', (t) => {
  const app = makeApp(t);
  const beforeConfig = app.readConfig();

  const result = app.run([
    '--plan', '--mode', '3', '--d1-id', OTHER_ID, '--check', '--name', 'my-app',
  ]);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /was not found on this account/);
  assert.equal(app.calls().filter((call) => call.args?.[1] === 'create').length, 0);
  assert.equal(app.readConfig(), beforeConfig);
  assert.equal(existsSync(app.statePath), false);
});

test('flag conflicts and misuse exit 2 before any work', (t) => {
  const app = makeApp(t);

  const both = app.run(['--mode', '3', '--d1-id', DB_ID, '--d1-auto']);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /either --d1-id or --d1-auto/);

  const checkAlone = app.run(['--check', '--mode', '1']);
  assert.equal(checkAlone.status, 2);
  assert.match(checkAlone.stderr, /--check is only valid with --plan/);

  const schemaConflict = app.run(['--mode', '3', '--skip-schema', '--schema=apply']);
  assert.equal(schemaConflict.status, 2);
  assert.match(schemaConflict.stderr, /either --skip-schema or --schema=apply/);

  const accountFlag = app.run(['--mode', '1', '--allow-account-change']);
  assert.equal(accountFlag.status, 2);
  assert.match(accountFlag.stderr, /--allow-account-change requires --mode 2 or 3/);

  assert.deepEqual(app.buildCalls(), []);
  assert.deepEqual(app.calls(), []);
});
