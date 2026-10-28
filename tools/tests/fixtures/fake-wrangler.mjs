#!/usr/bin/env node
// tools/tests/fixtures/fake-wrangler.mjs — test-only Wrangler stand-in.
//
// deploy runs this through LW_WRANGLER_BIN. It models the small surface deploy
// uses (d1 list/create/execute and deploy), stores databases in a JSON file,
// and records every call. No network, no Cloudflare account.
import { randomUUID } from 'node:crypto';
import {
  appendFileSync, existsSync, readFileSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

const args = process.argv.slice(2);
const cwd = process.cwd();
const statePath = process.env.FAKE_WRANGLER_STATE;
const logPath = process.env.FAKE_WRANGLER_LOG;

function load() {
  if (!statePath || !existsSync(statePath)) return { databases: [] };
  const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
  if (!Array.isArray(parsed.databases)) parsed.databases = [];
  return parsed;
}

function save(state) {
  if (statePath) writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function log(extra = {}) {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify({ args, cwd, ...extra }) + '\n');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const state = load();
const verb = `${args[0] || ''} ${args[1] || ''}`.trim();

if (args[0] === '--version') {
  log();
  console.log(process.env.FAKE_WRANGLER_VERSION || '4.151.1');
  process.exit(0);
}

function whoamiAccounts() {
  const ids = (process.env.FAKE_ACCOUNT_IDS
    || process.env.FAKE_ACCOUNT_ID
    || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const base = process.env.FAKE_ACCOUNT_NAME || 'Fake Account';
  return ids.map((id, index) => ({
    id,
    name: index === 0 ? base : `${base} ${index + 1}`,
    type: 'standard',
  }));
}

if (args[0] === 'whoami') {
  log();
  if (process.env.FAKE_WHOAMI_FAIL) {
    fail(`fake wrangler: whoami failed (${process.env.FAKE_WHOAMI_FAIL})`);
  }
  if (args.includes('--json') && process.env.FAKE_WHOAMI_JSON_UNSUPPORTED) {
    fail('Unknown argument: json');
  }

  const accounts = whoamiAccounts();
  const email = process.env.FAKE_ACCOUNT_EMAIL || 'fake@example.com';
  if (args.includes('--json') || process.env.FAKE_WHOAMI_JSON) {
    console.log(JSON.stringify({
      loggedIn: true,
      authType: 'OAuth Token',
      email,
      accounts,
      tokenPermissions: [],
    }, null, 2));
    process.exit(0);
  }

  console.log(`✅ You are logged in with an OAuth Token, associated with the email ${email}!`);
  console.log('');
  console.log('┌──────────────┬──────────────────────────────────┐');
  console.log('│ Account Name │ Account ID                       │');
  console.log('├──────────────┼──────────────────────────────────┤');
  for (const account of accounts) {
    console.log(`│ ${account.name.padEnd(12)} │ ${account.id.padEnd(32)} │`);
  }
  console.log('└──────────────┴──────────────────────────────────┘');
  process.exit(0);
}

if (verb === 'd1 list') {
  log();
  if (process.env.FAKE_LIST_FAIL) {
    fail(`fake wrangler: d1 list failed (${process.env.FAKE_LIST_FAIL})`);
  }
  const payload = JSON.stringify(state.databases.map((db) => ({
    uuid: db.uuid,
    name: db.name,
  })), null, 2);
  if (process.env.FAKE_LIST_STDERR) {
    console.log('fake wrangler: list banner on stdout');
    console.error(payload);
  } else {
    console.log('fake wrangler: list');
    console.log(payload);
  }
  process.exit(0);
}

if (verb === 'd1 create') {
  const name = args[2];
  log({ name });
  if (!name) fail('fake wrangler: d1 create needs a name');
  if (process.env.FAKE_CREATE_FAIL) {
    fail(`fake wrangler: d1 create failed (${process.env.FAKE_CREATE_FAIL})`);
  }
  if (state.databases.some((db) => db.name === name)) {
    fail(`fake wrangler: database "${name}" already exists`);
  }
  const uuid = randomUUID();
  state.databases.push({ uuid, name, tables: 0 });
  save(state);
  if (process.env.FAKE_CREATE_UNPARSEABLE) {
    console.log(`Created database '${name}' — the id is deliberately not printed`);
    process.exit(0);
  }
  console.log(`✅ Successfully created DB '${name}'`);
  console.log('');
  console.log('[[d1_databases]]');
  console.log('binding = "DB"');
  console.log(`database_name = "${name}"`);
  console.log(`database_id = "${uuid}"`);
  process.exit(0);
}

if (verb === 'd1 execute') {
  const name = args[2];
  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : null;
  const configIndex = args.indexOf('--config');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : null;
  if (!name) fail('fake wrangler: d1 execute needs a database name');
  if (!file) fail('fake wrangler: d1 execute needs --file');
  if (!configPath) fail('fake wrangler: d1 execute needs --config');
  if (!existsSync(configPath)) fail(`fake wrangler: config not found: ${configPath}`);

  let configId;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const entry = (config.d1_databases || []).find((item) => item.database_name === name);
    configId = String(entry?.database_id || '').toLowerCase();
  } catch (e) {
    fail(`fake wrangler: config is not the temporary JSON config: ${e.message}`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(configId)) {
    fail(`fake wrangler: config has no resolved database_id for "${name}"`);
  }

  const path = isAbsolute(file) ? file : join(cwd, file);
  if (!existsSync(path)) fail(`fake wrangler: SQL file not found: ${path}`);
  const sql = readFileSync(path, 'utf8');
  log({ name, sql, configId });

  const db = state.databases.find((item) => item.name === name);
  if (!db) fail(`fake wrangler: database "${name}" not found`);
  if (configId !== String(db.uuid).toLowerCase()) {
    fail(`fake wrangler: config id ${configId} does not match "${name}" (${db.uuid})`);
  }
  if (process.env.FAKE_EXECUTE_FAIL) {
    fail(`fake wrangler: d1 execute failed (${process.env.FAKE_EXECUTE_FAIL})`);
  }

  if (/count\s*\(\s*\*\s*\)/i.test(sql)) {
    if (process.env.FAKE_COUNT_UNPARSEABLE) {
      console.log(`table count is ${db.tables} but this is not JSON`);
      process.exit(0);
    }
    const payload = JSON.stringify([{ results: [{ n: db.tables }], success: true }]);
    if (process.env.FAKE_COUNT_STDERR) console.error(payload);
    else console.log(payload);
    process.exit(0);
  }

  const increment = Number(process.env.FAKE_SCHEMA_TABLES || 2);
  db.tables += increment;
  save(state);
  console.log(JSON.stringify([{ results: [], success: true }]));
  process.exit(0);
}

if (verb === 'deploy' || (args[0] === 'deploy' && args.length === 1)) {
  log();
  if (process.env.FAKE_DEPLOY_FAIL) {
    fail(`fake wrangler: deploy failed (${process.env.FAKE_DEPLOY_FAIL})`);
  }
  const url = process.env.FAKE_DEPLOY_URL || 'https://my-app.example.workers.dev';
  console.log(`Deployed to ${url}`);
  process.exit(0);
}

fail(`fake wrangler: unsupported command: ${args.join(' ')}`);
