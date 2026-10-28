import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const doctor = join(here, '..', 'doctor.mjs');
const fakeWrangler = join(here, 'fixtures', 'fake-wrangler.mjs');
const ACCOUNT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_ACCOUNT_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CONFIG = `{
  // doctor only needs the account pin for these tests
  "name": "my-app",
}\n`;

function stateFor({ account = null, deployed = false } = {}) {
  return {
    schemaVersion: 1,
    ...(account ? { account } : {}),
    deployedAt: deployed ? '2026-10-28T00:00:00.000Z' : null,
    workerName: 'my-app',
    workerUrl: deployed ? 'https://my-app.example.workers.dev' : null,
    d1: {
      binding: 'DB',
      databaseName: 'my-app-db',
      databaseId: '9e355138-3a4c-4f5d-9b6e-2a1f0c7d8e9a',
      schemaAppliedAt: null,
      schemaHash: null,
    },
  };
}

function makeApp(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-doctor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'artisan'), '', 'utf8');

  if (options.config !== null) {
    writeFileSync(join(dir, 'wrangler.jsonc'), options.config || CONFIG, 'utf8');
  }
  if (options.state) {
    writeFileSync(join(dir, 'lw-state.json'), JSON.stringify(options.state, null, 2) + '\n', 'utf8');
  }
  const logPath = join(dir, 'fake-wrangler.log');
  const fakeState = join(dir, 'fake-wrangler-state.json');
  writeFileSync(fakeState, JSON.stringify({ databases: [] }), 'utf8');

  function run(args = [], extraEnv = {}) {
    const env = { ...process.env };
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.CF_ACCOUNT_ID;
    for (const key of Object.keys(env)) {
      if (key.startsWith('FAKE_ACCOUNT_') || key.startsWith('FAKE_WHOAMI_')) delete env[key];
    }
    Object.assign(env, {
      LW_WRANGLER_BIN: fakeWrangler,
      FAKE_WRANGLER_LOG: logPath,
      FAKE_WRANGLER_STATE: fakeState,
      ...extraEnv,
    });
    return spawnSync(process.execPath, [doctor, ...args], {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: 60000,
    });
  }

  function calls() {
    if (!readFileSync(logPath, 'utf8').trim()) return [];
    return readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  }

  function whoamiCalls() {
    return calls().filter((call) => call.args?.[0] === 'whoami');
  }

  return { dir, run, calls, whoamiCalls };
}

test('doctor --cloud matches the recorded account', (t) => {
  const app = makeApp(t, {
    state: stateFor({
      account: { id: ACCOUNT_ID, name: 'Old Name', email: 'old@example.com' },
      deployed: true,
    }),
  });

  const result = app.run(['--cloud'], {
    FAKE_ACCOUNT_ID: ACCOUNT_ID,
    FAKE_ACCOUNT_NAME: 'Fake Account',
    FAKE_ACCOUNT_EMAIL: 'fake@example.com',
  });

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /cloud auth\s+logged in as fake@example\.com/);
  assert.match(result.stdout, /cloud account\s+.*matches lw-state\.json/);
  assert.match(result.stdout, /account "Old Name"/);
  assert.equal(app.whoamiCalls().length, 1);
});

test('doctor --cloud fails on an account mismatch', (t) => {
  const app = makeApp(t, {
    state: stateFor({ account: { id: ACCOUNT_ID, name: 'Old Name' } }),
  });

  const result = app.run(['--cloud'], {
    FAKE_ACCOUNT_ID: OTHER_ACCOUNT_ID,
    FAKE_ACCOUNT_NAME: 'New Account',
  });

  assert.equal(result.status, 2);
  assert.match(result.stdout, /cloud account\s+.*linked to/);
  assert.match(result.stdout, /allow-account-change/);
  assert.equal(app.whoamiCalls().length, 1);
});

test('doctor --cloud falls back to the Wrangler 3 table output', (t) => {
  const app = makeApp(t, {
    state: stateFor({ account: { id: ACCOUNT_ID, name: 'Fake Account' } }),
  });

  const result = app.run(['--cloud'], {
    FAKE_WHOAMI_JSON_UNSUPPORTED: '1',
    FAKE_ACCOUNT_ID: ACCOUNT_ID,
    FAKE_ACCOUNT_NAME: 'Fake Account',
    FAKE_ACCOUNT_EMAIL: 'table@example.com',
  });

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /logged in as table@example\.com/);
  assert.match(result.stdout, /matches lw-state\.json/);
  assert.equal(app.whoamiCalls().length, 2);
  assert.deepEqual(app.whoamiCalls()[0].args, ['whoami', '--json']);
  assert.deepEqual(app.whoamiCalls()[1].args, ['whoami']);
});

test('doctor --cloud accepts legacy state and explains the future record', (t) => {
  const app = makeApp(t, { state: stateFor() });

  const result = app.run(['--cloud'], {
    FAKE_ACCOUNT_ID: ACCOUNT_ID,
    FAKE_ACCOUNT_NAME: 'Fake Account',
  });

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /not recorded yet; the next successful deploy records it/);
});

test('doctor --cloud refuses multiple accounts without a selection', (t) => {
  const app = makeApp(t, { state: stateFor() });

  const result = app.run(['--cloud'], {
    FAKE_ACCOUNT_IDS: `${ACCOUNT_ID},${OTHER_ACCOUNT_ID}`,
  });

  assert.equal(result.status, 2);
  assert.match(result.stdout, /authenticated to 2 Cloudflare accounts/);
  assert.match(result.stdout, /cloud account/);
});

test('doctor --cloud follows wrangler.jsonc account_id with multiple accounts', (t) => {
  const config = CONFIG.replace(
    '  "name": "my-app",',
    `  "name": "my-app",\n  "account_id": "${OTHER_ACCOUNT_ID}",`,
  );
  const app = makeApp(t, {
    config,
    state: stateFor({ account: { id: OTHER_ACCOUNT_ID, name: 'Second Account' } }),
  });

  const result = app.run(['--cloud'], {
    FAKE_ACCOUNT_IDS: `${ACCOUNT_ID},${OTHER_ACCOUNT_ID}`,
    FAKE_ACCOUNT_NAME: 'Shared',
  });

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /matches lw-state\.json/);
  assert.match(result.stdout, /Shared 2/);
});

test('doctor without --cloud uses only the recorded account and does not ask whoami', (t) => {
  const app = makeApp(t, {
    state: stateFor({ account: { id: ACCOUNT_ID, name: 'Fake Account' }, deployed: true }),
  });

  const result = app.run([]);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /account "Fake Account"/);
  assert.equal(app.whoamiCalls().length, 0);
  assert.equal(app.calls().filter((call) => call.args?.[0] === '--version').length, 1);
});
