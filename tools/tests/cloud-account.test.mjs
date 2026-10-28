import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountLabel,
  normalizeAccountId,
  parseWhoamiJson,
  parseWhoamiOutput,
  parseWhoamiTable,
  readCloudIdentity,
  sameAccount,
  selectAccount,
  stripAnsi,
} from '../cloud-account.mjs';

const ACCOUNT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const THIRD = 'cccccccccccccccccccccccccccccccc';

function whoamiJson(accounts, { email = 'owner@example.com', loggedIn = true } = {}) {
  return JSON.stringify({ loggedIn, authType: 'OAuth Token', email, accounts }, null, 2);
}

function table(accounts, { email = 'owner@example.com' } = {}) {
  return [
    `✅ You are logged in with an OAuth Token, associated with the email ${email}!`,
    '',
    '┌──────────────┬──────────────────────────────────┐',
    '│ Account Name │ Account ID                       │',
    '├──────────────┼──────────────────────────────────┤',
    ...accounts.map((entry) => `│ ${entry.name.padEnd(12)} │ ${entry.id.padEnd(32)} │`),
    '└──────────────┴──────────────────────────────────┘',
  ].join('\n');
}

test('stripAnsi removes colour/control escapes', () => {
  assert.equal(stripAnsi('\u001b[32mok\u001b[0m'), 'ok');
  assert.equal(stripAnsi(null), '');
});

test('normalizeAccountId accepts only 32-hex ids', () => {
  assert.equal(normalizeAccountId(ACCOUNT.toUpperCase()), ACCOUNT);
  assert.equal(normalizeAccountId(` ${ACCOUNT} `), ACCOUNT);
  assert.equal(normalizeAccountId('not-an-account'), null);
  assert.equal(normalizeAccountId('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), null);
  assert.equal(normalizeAccountId(null), null);
});

test('parseWhoamiJson tolerates banners and normalizes ids', () => {
  const parsed = parseWhoamiJson(`notice before\n${whoamiJson([
    { id: ACCOUNT.toUpperCase(), name: 'Main' },
    { id: 'not-an-account', name: 'Ignored' },
  ])}\nnotice after`);
  assert.equal(parsed.source, 'json');
  assert.equal(parsed.email, 'owner@example.com');
  assert.deepEqual(parsed.accounts, [{ id: ACCOUNT, name: 'Main' }]);
});

test('parseWhoamiJson rejects logged-out or non-JSON output', () => {
  assert.equal(parseWhoamiJson(whoamiJson([], { loggedIn: false, email: null })), null);
  assert.equal(parseWhoamiJson('not json'), null);
});

test('parseWhoamiJson rejects logged-out output even when stale fields remain', () => {
  const stale = whoamiJson([{ id: ACCOUNT, name: 'Stale' }], { loggedIn: false });
  assert.equal(parseWhoamiJson(stale), null);
  assert.equal(parseWhoamiOutput(stale), null);
});

test('parseWhoamiTable reads the email and account rows through ANSI', () => {
  const parsed = parseWhoamiTable(`\u001b[32m${table([
    { id: ACCOUNT, name: 'Main Account' },
    { id: OTHER, name: 'Second Account' },
  ])}\u001b[0m`);
  assert.equal(parsed.source, 'table');
  assert.equal(parsed.email, 'owner@example.com');
  assert.deepEqual(parsed.accounts, [
    { id: ACCOUNT, name: 'Main Account' },
    { id: OTHER, name: 'Second Account' },
  ]);
});

test('parseWhoamiTable strips trailing punctuation from the email', () => {
  const parsed = parseWhoamiTable(table([], { email: 'owner@example.com!' }));
  assert.equal(parsed.email, 'owner@example.com');
});

test('parseWhoamiOutput prefers JSON and can fall back to a table', () => {
  const json = whoamiJson([{ id: ACCOUNT, name: 'Main' }]);
  assert.equal(parseWhoamiOutput(json).source, 'json');
  assert.equal(parseWhoamiOutput(table([{ id: ACCOUNT, name: 'Main' }])).source, 'table');
});

test('readCloudIdentity falls back when whoami --json is unsupported', () => {
  const calls = [];
  const result = readCloudIdentity((args) => {
    calls.push(args);
    if (args.includes('--json')) {
      return { status: 1, stdout: '', stderr: 'Unknown argument: json' };
    }
    return { status: 0, stdout: table([{ id: ACCOUNT, name: 'Main' }]), stderr: '' };
  });
  assert.deepEqual(calls, [['whoami', '--json'], ['whoami']]);
  assert.equal(result.identity.email, 'owner@example.com');
  assert.equal(result.identity.accounts[0].id, ACCOUNT);
});

test('readCloudIdentity accepts table output on stderr and keeps ANSI out', () => {
  const result = readCloudIdentity(() => ({
    status: 0,
    stdout: '',
    stderr: `\u001b[32m${table([{ id: ACCOUNT, name: 'Main' }])}\u001b[0m`,
  }));
  assert.equal(result.identity.accounts[0].name, 'Main');
});

test('readCloudIdentity reports an error when both commands fail', () => {
  const result = readCloudIdentity(() => ({ status: 1, stdout: '', stderr: 'not logged in' }));
  assert.equal(result.code, 1);
  assert.match(result.error, /not logged in/);
});

test('readCloudIdentity reports an error when the runner throws', () => {
  const result = readCloudIdentity(() => { throw new Error('spawn failed'); });
  assert.equal(result.code, 1);
  assert.match(result.error, /spawn failed/);
});

test('selectAccount uses the only authenticated account', () => {
  const selected = selectAccount({
    email: 'owner@example.com',
    accounts: [{ id: ACCOUNT, name: 'Main' }],
  });
  assert.deepEqual(selected, {
    id: ACCOUNT,
    name: 'Main',
    email: 'owner@example.com',
    source: 'only',
  });
});

test('selectAccount never guesses between multiple accounts', () => {
  const selected = selectAccount({
    accounts: [{ id: ACCOUNT, name: 'Main' }, { id: OTHER, name: 'Other' }],
  });
  assert.equal(selected.code, 2);
  assert.match(selected.error, /2 Cloudflare accounts/);
});

test('selectAccount gives wrangler.jsonc account_id precedence over the env', () => {
  const selected = selectAccount({
    accounts: [{ id: ACCOUNT, name: 'Main' }, { id: OTHER, name: 'Other' }],
  }, { configAccountId: ACCOUNT.toUpperCase(), envAccountId: OTHER });
  assert.equal(selected.id, ACCOUNT);
  assert.equal(selected.name, 'Main');
  assert.equal(selected.source, 'config');
});

test('selectAccount uses CLOUDFLARE_ACCOUNT_ID when the config has no pin', () => {
  const selected = selectAccount({
    accounts: [{ id: ACCOUNT, name: 'Main' }, { id: OTHER, name: 'Other' }],
  }, { envAccountId: OTHER });
  assert.equal(selected.id, OTHER);
  assert.equal(selected.name, 'Other');
  assert.equal(selected.source, 'env');
});

test('selectAccount fails when an explicit account is not in whoami', () => {
  const config = selectAccount({
    accounts: [{ id: ACCOUNT, name: 'Main' }],
  }, { configAccountId: OTHER });
  assert.equal(config.code, 2);
  assert.match(config.error, /wrangler\.jsonc account_id/);

  const env = selectAccount({
    accounts: [{ id: ACCOUNT, name: 'Main' }],
  }, { envAccountId: OTHER });
  assert.equal(env.code, 2);
  assert.match(env.error, /CLOUDFLARE_ACCOUNT_ID/);
});

test('selectAccount rejects invalid account ids', () => {
  assert.equal(selectAccount({ accounts: [] }, { configAccountId: 'nope' }).code, 2);
  assert.equal(selectAccount({ accounts: [] }, { envAccountId: 'nope' }).code, 2);
});

test('selectAccount refuses a provided-but-empty account_id pin', () => {
  const result = selectAccount({
    accounts: [{ id: ACCOUNT, name: 'Main' }],
  }, { configAccountId: '' });
  assert.equal(result.code, 2);
  assert.match(result.error, /account_id "" is not a 32-character Cloudflare account ID/);
});

test('selectAccount can use an explicit id when whoami has no account rows', () => {
  const selected = selectAccount({ email: 'owner@example.com', accounts: [] }, {
    envAccountId: ACCOUNT,
  });
  assert.equal(selected.id, ACCOUNT);
  assert.equal(selected.name, null);
  assert.equal(selected.email, 'owner@example.com');
});

test('accountLabel shows a name when available and always shows the id', () => {
  assert.equal(accountLabel({ id: ACCOUNT, name: 'Main' }), `"Main" (${ACCOUNT})`);
  assert.equal(accountLabel({ id: ACCOUNT, name: null, email: 'owner@example.com' }), `"owner@example.com" (${ACCOUNT})`);
  assert.equal(accountLabel({ id: ACCOUNT }), ACCOUNT);
  assert.equal(accountLabel(null), '(unknown account)');
});

test('sameAccount compares ids, not display names', () => {
  assert.equal(sameAccount({ id: ACCOUNT, name: 'Old' }, { id: ACCOUNT, name: 'New' }), true);
  assert.equal(sameAccount({ id: ACCOUNT }, { id: OTHER }), false);
  assert.equal(sameAccount({ id: null }, { id: ACCOUNT }), false);
  assert.equal(sameAccount({ id: THIRD }, { id: THIRD.toUpperCase() }), true);
});
