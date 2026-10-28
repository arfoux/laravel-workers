#!/usr/bin/env node
// tools/deploy.mjs — build → D1 → Cloudflare, the interactive path.
//
// Usage (from the Laravel app root):
//   npx laravel-workers deploy [--name <worker>] [--mode 1|2|3]
//                              [--d1-auto | --d1-id <uuid>]
//                              [--skip-schema | --schema=apply] [--yes]
//                              [--plan [--check]]
//
// Modes:
//   1 = build only    (compiles dist/ — identical to `laravel-workers build`)
//   2 = + database    (provision/create-or-reuse D1, apply dist/schema.sql)
//   3 = + deploy      (everything, then `wrangler deploy`)
//
// --plan is a read-only preview: no build, no wrangler.jsonc/state writes, no
// D1 create/apply, no deploy. --check adds read-only Cloudflare list/count
// calls. When stdin is a TTY the missing choices are prompted; with flags they
// are taken verbatim (CI-safe). `--yes` skips every prompt and accepts defaults.
// Explicit --d1-id/--d1-auto always win over the recorded state.
//
// Exit codes: 2 = usage/config/state refusal; 1 = build/Cloudflare failure;
// 0 = success. --plan: 0 = no blocking issue, 2 = a real run would stop, 1 =
// --check could not complete.

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectD1Target, inspectWranglerAccount, inspectWranglerName, JsoncError, setWranglerName,
} from './jsonc.mjs';
import {
  accountLabel, readCloudIdentity, selectAccount,
} from './cloud-account.mjs';
import { readState, writeState } from './lw-state.mjs';
import { NPX, runCapture, runInherit } from './run.mjs';

// Re-exported for the unit tests and for callers that edited the old module.
import { updateWranglerD1Id } from './jsonc.mjs';
export { updateWranglerD1Id };

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = resolve(process.cwd());
const hasTTY = Boolean(process.stdin.isTTY);

const argv = process.argv.slice(2);
const consumed = new Set();
const DEPLOY_BOOL_FLAGS = new Set([
  '--d1-auto', '--skip-schema', '--yes', '-y', '--deploy', '--db', '--help', '-h',
  '--plan', '--check', '--dry-run', '--allow-account-change',
]);

// Test hooks: tools/tests points these at fake executables so the real CLI
// flow (including state writes and exit codes) can run without an account.
// The fixtures are excluded from the npm tarball; requiring both to exist keeps
// the hooks inert in an installed package even if the env vars are set.
const testHooks = existsSync(join(pkgDir, 'tools', 'tests', 'fixtures', 'fake-build.mjs'))
  && existsSync(join(pkgDir, 'tools', 'tests', 'fixtures', 'fake-wrangler.mjs'));
const testBuild = testHooks ? (process.env.LW_BUILD_BIN || null) : null;
const testWrangler = testHooks ? (process.env.LW_WRANGLER_BIN || null) : null;

function fail(msg, code = 2) {
  console.error('deploy: ' + msg);
  process.exit(code);
}

function wranglerCapture(args, opts = {}) {
  if (testWrangler) {
    return runCapture(process.execPath, [testWrangler, ...args], opts);
  }
  return runCapture(NPX, ['wrangler', ...args], opts);
}

function buildArgsFor(extra) {
  if (testBuild) return [testBuild, ...extra];
  return [join(pkgDir, 'build.mjs'), '--strict', ...extra];
}

function has(name) {
  return argv.some((arg) => arg === name || arg.startsWith(name + '='));
}

function flag(name) {
  const equals = name + '=';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) fail(`${name} requires a value`);
      consumed.add(i);
      consumed.add(i + 1);
      return value;
    }
    if (argv[i].startsWith(equals)) {
      const value = argv[i].slice(equals.length);
      if (!value) fail(`${name} requires a value`);
      consumed.add(i);
      return value;
    }
  }
  return undefined;
}

const wantsHelp = has('--help') || has('-h');
const nameFlag = wantsHelp ? undefined : flag('--name');
const modeFlag = wantsHelp ? undefined : flag('--mode');
const d1IdFlag = wantsHelp ? undefined : flag('--d1-id');
const schemaFlag = wantsHelp ? undefined : flag('--schema');
const autoD1 = !wantsHelp && has('--d1-auto');
const skipSchema = !wantsHelp && has('--skip-schema');
const schemaApply = schemaFlag === 'apply';
const yes = !wantsHelp && (has('--yes') || has('-y'));
const plan = !wantsHelp && has('--plan');
const check = !wantsHelp && has('--check');
const dryRunFlag = !wantsHelp && has('--dry-run');
const allowAccountChange = !wantsHelp && has('--allow-account-change');

// Unknown flags (and their values) go to build. Deploy consumes only its own
// flags; e.g. `deploy --no-cache` still forwards `--no-cache`.
const buildExtra = argv.filter((arg, i) => !consumed.has(i) && !DEPLOY_BOOL_FLAGS.has(arg));

const USAGE = `Usage: npx laravel-workers deploy [flags]

  --name <worker>     set the worker name (modes 2/3; syncs wrangler.jsonc)
  --mode 1|2|3        build only / + database / + database + deploy
  --deploy            shorthand for --mode 3
  --db                shorthand for --mode 2
  --d1-auto           create or reuse <worker>-db (overrides recorded D1)
  --d1-id <uuid>      use this existing D1 (overrides recorded D1)
  --skip-schema       never apply dist/schema.sql
  --schema=apply      apply dist/schema.sql even when the D1 has tables
  --plan              show what would happen; changes nothing
                      (no build, no state/config/cloud writes; no prompts)
  --check             with --plan: read-only account/D1 list/count verification
  --allow-account-change
                      continue when wrangler is on a different Cloudflare account
                      than lw-state.json (clears the old URL/deploy time; D1 must
                      resolve in the new account)
  --yes, -y           accept defaults, never prompt (schema drift and an
                      unconfirmed account change still stop; a D1 that already
                      has tables is skipped — pass --schema=apply to force)
  --help, -h          show this help
  any other --flag    forwarded to build (value included)

  --dry-run is not supported; use --plan, or --mode 1 for build only.`;


// State carried to the final write. It starts as a copy of the existing state,
// so a D1-only run preserves the last deploy metadata unless the worker name
// changes (in which case the old URL belongs to a different worker).
const chosen = {
  account: { id: null, name: null, email: null },
  workerName: null,
  workerUrl: null,
  deployedAt: null,
  d1: {
    binding: 'DB',
    databaseName: null,
    databaseId: null,
    schemaAppliedAt: null,
    schemaHash: null,
  },
};

let rl = null;
function prompt(question) {
  if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question + ' ', resolve));
}

async function ask(question, fallback) {
  if (plan) throw new Error('internal: --plan must not prompt');
  if (yes || !hasTTY) return fallback;
  return (await prompt(question)) || fallback;
}

async function choose(raw, fallback = 'A') {
  if (plan) throw new Error('internal: --plan must not prompt');
  if (yes || !hasTTY) return fallback;
  const map = { a: 'A', b: 'B', c: 'C', '1': 'A', '2': 'B', '3': 'C' };
  return map[String(raw).toLowerCase()] || fallback;
}

function requireApp() {
  if (!existsSync(join(appDir, 'artisan'))) {
    fail(`artisan not found in ${appDir} — run deploy from the Laravel app root`);
  }
}

export function slugifyWorkerName(raw) {
  const slug = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return slug || 'laravel-workers-app';
}

export function isValidWorkerName(name) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(String(name || ''));
}

export function isValidD1Id(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
}

export function isValidD1Name(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(String(name || ''));
}

/** The automatic database name, capped to D1's 63-character limit. */
export function autoD1Name(workerName) {
  const suffix = '-db';
  const base = String(workerName || '')
    .slice(0, 63 - suffix.length)
    .replace(/-+$/g, '');
  return (base || 'laravel-workers-app') + suffix;
}

/** Extract the uuid from `wrangler d1 create`/`execute` output. */
export function parseD1Id(text) {
  const value = String(text || '');
  const m = value.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/i)
    || value.match(/database_id\s*=\s*["']?([0-9a-f-]{36})/i);
  return m ? m[1].toLowerCase() : null;
}

/** Parse JSON even when a CLI prints a banner before it. */
export function parseJsonOutput(text) {
  const value = String(text || '');
  const starts = [];
  const re = /[[{]/g;
  let match;
  while ((match = re.exec(value)) !== null) starts.push(match.index);
  for (const start of starts) {
    try {
      return JSON.parse(value.slice(start));
    } catch { /* try the next bracket */ }
  }
  return null;
}

/** Normalise `wrangler d1 list --json` into an array. */
export function parseD1ListOutput(text) {
  const data = parseJsonOutput(text);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.result)) return data.result;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.databases)) return data.databases;
  return null;
}

function findD1ById(list, id) {
  const wanted = String(id || '').toLowerCase();
  return (list || []).find((db) =>
    String(db.uuid || db.database_id || '').toLowerCase() === wanted);
}

function findD1ByName(list, name) {
  return (list || []).find((db) => db.name === name);
}

/**
 * Read `count(*) AS n` from a wrangler JSON response. Different wrangler
 * versions put the row at different depths, so walk the known containers.
 * Returns null when the response cannot be understood; the caller must then
 * refuse to apply the schema (fail closed).
 */
export function parseTableCountOutput(text) {
  const data = parseJsonOutput(text);
  if (data === null) return null;

  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const n = walk(item);
        if (n !== null) return n;
      }
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    for (const key of ['n', 'count', 'num_tables']) {
      if (typeof value[key] === 'number' && Number.isFinite(value[key])) return value[key];
    }
    for (const key of ['results', 'result', 'meta']) {
      if (key in value) {
        const n = walk(value[key]);
        if (n !== null) return n;
      }
    }
    return null;
  };

  return walk(data);
}

/** Read wrangler.jsonc as text; null when the file does not exist. */
function readWranglerConfig() {
  const path = join(appDir, 'wrangler.jsonc');
  if (!existsSync(path)) return null;
  return { path, text: readFileSync(path, 'utf8') };
}

function jsoncProblem(error) {
  return error instanceof JsoncError
    ? `wrangler.jsonc is not valid JSONC: ${error.message}`
    : `wrangler.jsonc could not be read: ${error.message}`;
}

/** Keep wrangler.jsonc's name authoritative unless the user explicitly chose another. */
function syncWranglerName(workerName, allowUpdate, { dryRun = false } = {}) {
  const config = readWranglerConfig();
  if (!config) {
    fail('wrangler.jsonc not found — run `npx laravel-workers build` or `init` first', 2);
  }

  let info;
  try {
    info = inspectWranglerName(config.text);
  } catch (e) {
    fail(jsoncProblem(e), 2);
  }
  if (info.status === 'missing') fail('wrangler.jsonc has no "name" field', 2);
  if (info.status === 'duplicate') {
    fail('wrangler.jsonc has more than one top-level "name" field — remove the duplicate', 2);
  }
  if (info.status !== 'ok') fail('wrangler.jsonc has no usable "name" field', 2);
  if (info.name === workerName) return { status: 'already', name: info.name };

  if (!allowUpdate) {
    fail(`wrangler.jsonc name is "${info.name}", not "${workerName}" — pass --name or edit wrangler.jsonc`, 2);
  }

  const result = setWranglerName(config.text, workerName);
  if (result.status !== 'set' || !result.changed) {
    fail(`could not update the "name" field in wrangler.jsonc (${result.status})`, 2);
  }
  if (!dryRun) {
    writeFileSync(config.path, result.text, 'utf8');
    console.log(`→ wrangler.jsonc: name → "${workerName}"`);
  }
  return { status: 'set', from: info.name, name: workerName };
}

function injectD1Id(databaseRef, databaseId) {
  const config = readWranglerConfig();
  if (!config) return 'no-file';

  let result;
  try {
    result = updateWranglerD1Id(config.text, databaseRef, databaseId);
  } catch (e) {
    fail(jsoncProblem(e), 2);
  }

  if (result.changed) writeFileSync(config.path, result.text, 'utf8');
  if (result.status === 'set') console.log('→ wrangler.jsonc: database_id set');
  else if (result.status === 'updated') console.log('→ wrangler.jsonc: database_id updated');
  else if (result.status === 'already') {
    console.log(`→ wrangler.jsonc: already points at "${databaseId}" — left as-is`);
  }

  if (result.status === 'ambiguous' || result.status === 'placeholder-outside'
    || result.status === 'missing-name' || result.status === 'invalid-d1'
    || result.status === 'no-d1' || result.status === 'invalid-root'
    || result.status === 'invalid-result') {
    fail(`wrangler.jsonc D1 entry is ambiguous or malformed (${result.status}) — refusing to write it`, 2);
  }
  return result.status;
}

/**
 * Return the reason a D1 create must not proceed, or null when the config has
 * a bindable entry. Kept separate from assertWranglerD1Target() so the parser
 * and the message rules are directly testable.
 */
export function wranglerD1TargetProblem(text, databaseRef) {
  let info;
  try {
    info = inspectD1Target(text, databaseRef);
  } catch (e) {
    return jsoncProblem(e);
  }
  if (info.status === 'placeholder' || info.status === 'ok') return null;
  if (info.status === 'no-d1') {
    return 'wrangler.jsonc has no d1_databases array — refusing to create an unbindable database';
  }
  if (info.status === 'invalid-d1') {
    return 'wrangler.jsonc has a d1_databases value that is not an array of objects — refusing to create an unbindable database';
  }
  if (info.status === 'invalid-root') {
    return 'wrangler.jsonc is not a JSON object — refusing to create an unbindable database';
  }
  if (info.status === 'missing-name') {
    return 'wrangler.jsonc has a D1 placeholder but no database_name — refusing to create an unbindable database';
  }
  if (info.status === 'placeholder-outside') {
    return 'wrangler.jsonc has a D1 placeholder outside a database_id — refusing to create an unbindable database';
  }
  if (info.status === 'ambiguous') {
    return 'wrangler.jsonc has ambiguous D1 entries (duplicate names or placeholders) — refusing to guess which one to bind';
  }
  if (info.status === 'no-entry') {
    return `wrangler.jsonc has no D1 entry named "${databaseRef}" — refusing to create an unbindable database`;
  }
  if (info.status === 'missing-id') {
    return `wrangler.jsonc has a D1 entry for "${databaseRef}" but no database_id — add it before creating the database`;
  }
  return `wrangler.jsonc has an unknown D1 target problem (${info.status}) — refusing to continue`;
}

function assertWranglerD1Target(databaseRef) {
  const config = readWranglerConfig();
  if (!config) {
    fail('wrangler.jsonc not found — refusing to create a D1 it cannot bind', 2);
  }
  const problem = wranglerD1TargetProblem(config.text, databaseRef);
  if (problem) fail(problem, 2);
}

/**
 * Read the optional Cloudflare account pin from wrangler.jsonc. Wrangler uses
 * this before CLOUDFLARE_ACCOUNT_ID, so the guard must use the same order.
 */
function readConfigAccountId() {
  const config = readWranglerConfig();
  if (!config) return { id: null };
  let info;
  try {
    info = inspectWranglerAccount(config.text);
  } catch (e) {
    return { error: jsoncProblem(e) };
  }
  if (info.status === 'missing') return { id: null };
  if (info.status === 'duplicate') {
    return { error: 'wrangler.jsonc has more than one top-level "account_id" field — remove the duplicate' };
  }
  if (info.status === 'invalid') {
    return { error: 'wrangler.jsonc has an "account_id" field that is not a string' };
  }
  if (info.status === 'not-object') {
    return { error: 'wrangler.jsonc is not a JSON object — cannot read account_id' };
  }
  return { id: info.id };
}

/**
 * Ask Wrangler which account it will use, then apply the same precedence:
 * wrangler.jsonc account_id, CLOUDFLARE_ACCOUNT_ID (or CF_ACCOUNT_ID), then the
 * only authenticated account. The return value carries a CLI exit code when it
 * cannot answer.
 */
function resolveCurrentCloudAccount() {
  const fromConfig = readConfigAccountId();
  if (fromConfig.error) return { error: fromConfig.error, code: 2 };

  const identity = readCloudIdentity((args) =>
    wranglerCapture(args, { cwd: appDir, timeout: 30000 }));
  if (identity.error) return identity;
  return selectAccount(identity.identity, {
    configAccountId: fromConfig.id,
    envAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID,
  });
}

/**
 * Fail closed before any D1/deploy mutation when the recorded account id and
 * Wrangler's current account differ. An explicit flag (or a TTY confirmation)
 * is the only way through; --yes and non-TTY runs never prompt.
 */
async function ensureCloudAccount(state) {
  const current = resolveCurrentCloudAccount();
  if (current.error) fail(current.error, current.code || 1);

  const recorded = state.account && state.account.id ? state.account : null;
  const changed = Boolean(recorded && recorded.id !== current.id);
  if (changed) {
    const transition = `${accountLabel(recorded)} → ${accountLabel(current)}`;
    if (!allowAccountChange) {
      if (hasTTY && !yes) {
        const answer = await ask(
          `lw-state.json is linked to Cloudflare account ${accountLabel(recorded)}; Wrangler is now using ${accountLabel(current)}. Continue with the new account? [y/N]`,
          'N',
        );
        if (answer.trim().toLowerCase() !== 'y') {
          fail('Cloudflare account change was not confirmed; no D1 or deploy changes were made.', 2);
        }
        console.log(`! Cloudflare account changed: ${transition} (confirmed)`);
      } else {
        fail(
          `Cloudflare account changed: ${transition}. Refusing to touch D1 or deploy with a different account. Re-run with --allow-account-change to switch, or remove lw-state.json to start fresh.`,
          2,
        );
      }
    } else {
      console.log(`! Cloudflare account changed: ${transition} (--allow-account-change)`);
    }
  } else {
    console.log(`→ Cloudflare account ${accountLabel(current)}${recorded ? '' : ' (will be recorded)'}`);
  }
  return { ...current, changed, previous: recorded };
}

async function planAccount(state) {
  const recorded = state.account && state.account.id ? state.account : null;
  if (!check) {
    return {
      text: recorded
        ? `${accountLabel(recorded)} (recorded; not checked offline)`
        : 'not recorded; a real run records the current account after success',
      blocked: false,
    };
  }

  const current = resolveCurrentCloudAccount();
  if (current.error) {
    if ((current.code || 1) === 1) {
      fail(`could not verify the Cloudflare account: ${current.error}`, 1);
    }
    return {
      text: 'not verified',
      issue: current.error,
      blocked: true,
    };
  }

  if (recorded && recorded.id !== current.id) {
    const transition = `${accountLabel(recorded)} → ${accountLabel(current)}`;
    if (allowAccountChange) {
      return {
        text: `${transition} (allowed by --allow-account-change)`,
        blocked: false,
      };
    }
    return {
      text: `${transition} (would stop)`,
      issue: `Cloudflare account changed: ${transition}. A real run would stop before touching D1 or deploying. Re-run with --allow-account-change to switch, or remove lw-state.json to start fresh.`,
      blocked: true,
    };
  }

  return {
    text: `${accountLabel(current)} (current${recorded ? '; matches lw-state.json' : '; not recorded yet'})`,
    blocked: false,
  };
}

function listD1() {
  const res = wranglerCapture(['d1', 'list', '--json'], { cwd: appDir });
  if (res.error) fail(`wrangler d1 list: ${res.error.message}`, 1);
  if (res.status !== 0) {
    fail('wrangler d1 list failed:\n' + (res.stderr || res.stdout).slice(0, 500), 1);
  }
  const list = parseD1ListOutput(res.stdout) ?? parseD1ListOutput(res.stderr);
  if (!list) {
    fail('could not parse `wrangler d1 list --json` output:\n'
      + (res.stdout || res.stderr).slice(0, 300), 1);
  }
  return list;
}

/**
 * Resolve a D1 by name. With allowCreate:false this is a read-only peek used by
 * `--plan --check`; with the default it creates the database when absent.
 * Returns { id, name, action } where action is reuse | create.
 */
async function d1Resolve(dbName, { allowCreate = true, quiet = false } = {}) {
  if (!isValidD1Name(dbName)) fail(`invalid D1 database name "${dbName}"`, 2);
  const list = listD1();
  const found = findD1ByName(list, dbName);
  if (found) {
    const id = found.uuid || found.database_id;
    if (!id) fail(`D1 "${dbName}" has no uuid in wrangler output`, 1);
    if (!quiet) console.log(`→ D1 "${dbName}" exists (${id}) — reusing`);
    return { id: String(id), name: dbName, action: 'reuse' };
  }
  if (!allowCreate) return { id: null, name: dbName, action: 'create' };

  const created = wranglerCapture(['d1', 'create', dbName], { cwd: appDir });
  if (created.error) fail(`wrangler d1 create: ${created.error.message}`, 1);
  if (created.status !== 0) {
    fail('wrangler d1 create failed:\n' + (created.stderr || created.stdout).slice(0, 500), 1);
  }
  let id = parseD1Id(created.stdout + '\n' + created.stderr);
  if (!id) {
    // The database now exists; recover its id from the account list instead of
    // leaving a created-but-unrecorded D1 behind because the output changed.
    const after = listD1();
    const hit = findD1ByName(after, dbName);
    id = hit ? (hit.uuid || hit.database_id || null) : null;
  }
  if (!id) {
    fail('created the D1 but could not read its database_id; find it with `npx wrangler d1 list` and set it in wrangler.jsonc:\n'
      + created.stdout.slice(0, 300), 1);
  }
  if (!quiet) console.log(`→ created D1 "${dbName}" (${id})`);
  return { id: String(id), name: dbName, action: 'create' };
}

/**
 * Run `wrangler d1 execute` against the resolved UUID without depending on the
 * app's wrangler.jsonc. The real config may still contain REPLACE_WITH_D1_ID
 * while the schema decision is being made, and Wrangler resolves a database
 * name through that config. A throwaway config targets the exact database we
 * resolved and keeps the app's config untouched until the decision is final.
 */
function runD1File(dbName, d1Id, sqlPath, extraArgs = []) {
  if (!isValidD1Id(d1Id)) {
    return { error: new Error('a resolved D1 database_id is required') };
  }
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'lw-d1-exec-'));
    const configPath = join(dir, 'wrangler.jsonc');
    writeFileSync(configPath, JSON.stringify({
      name: 'laravel-workers-d1-exec',
      compatibility_date: '2026-10-01',
      d1_databases: [{
        binding: 'DB',
        database_name: dbName,
        database_id: d1Id,
      }],
    }, null, 2) + '\n', 'utf8');
    return wranglerCapture([
      'd1', 'execute', dbName, '--remote', '--file', sqlPath,
      ...extraArgs, '--yes', '--config', configPath,
    ], { cwd: appDir });
  } catch (e) {
    return { error: e instanceof Error ? e : new Error(String(e)) };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Read the D1 table count without exiting, so callers can clean up scratch
 * files. Returns { count } or { error }. The count is fail-closed: an
 * unreadable response is an error, never zero.
 */
function tableCountQuery(dbName, d1Id, { scratch = false } = {}) {
  if (!dbName) return { error: 'cannot count tables without a D1 name' };
  if (!isValidD1Id(d1Id)) {
    return { error: 'cannot count tables without a resolved D1 database_id' };
  }
  const sqlText = "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';";
  let dir = null;
  let sqlPath = null;

  try {
    if (scratch) {
      dir = mkdtempSync(join(tmpdir(), 'lw-plan-'));
      sqlPath = join(dir, 'schema-count.sql');
      writeFileSync(sqlPath, sqlText, 'utf8');
    } else {
      const sqlRel = '.cache/laravel-workers/schema-count.sql';
      mkdirSync(join(appDir, '.cache', 'laravel-workers'), { recursive: true });
      sqlPath = sqlRel;
      writeFileSync(join(appDir, sqlRel), sqlText, 'utf8');
    }
  } catch (e) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return { error: `could not write the D1 table-count query: ${e.message}` };
  }

  try {
    const res = runD1File(dbName, d1Id, sqlPath, ['--json']);
    if (res.error) return { error: `wrangler d1 execute: ${res.error.message}` };
    if (res.status !== 0) {
      return {
        error: 'could not count D1 tables; refusing to apply the schema:\n'
          + (res.stderr || res.stdout).slice(0, 600),
      };
    }
    const count = parseTableCountOutput(res.stdout) ?? parseTableCountOutput(res.stderr);
    if (count === null) {
      return {
        error: 'could not read the D1 table count; refusing to apply the schema:\n'
          + (res.stderr || res.stdout).slice(0, 600),
      };
    }
    return { count };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    // The non-scratch query file lives under the app's .cache/ so wrangler can
    // read it by a relative --file path; remove it afterwards so a deploy does
    // not leave schema-count.sql (and only that) behind in the project.
    else if (sqlPath) {
      try {
        unlinkSync(join(appDir, sqlPath));
      } catch {
        // best effort: a leftover file is noise, not a failure
      }
    }
  }
}

/** Count user tables in the D1. Fails closed instead of guessing "empty". */
function d1TableCount(dbName, d1Id) {
  const result = tableCountQuery(dbName, d1Id);
  if (result.error) fail(result.error, 1);
  return result.count;
}

/** Apply dist/schema.sql to the D1. */
async function d1ApplySchema(dbName, d1Id) {
  const schemaRel = 'dist/schema.sql';
  const res = runD1File(dbName, d1Id, schemaRel);
  if (res.error) fail(`wrangler d1 execute: ${res.error.message}`, 1);
  if (res.status !== 0) {
    fail('schema apply failed:\n' + (res.stderr || res.stdout).slice(0, 600), 1);
  }
  console.log(`→ schema ${schemaRel} applied to "${dbName}"`);
}

async function doDeploy() {
  const res = wranglerCapture(['deploy'], { cwd: appDir });
  if (res.error) fail(`wrangler deploy: ${res.error.message}`, 1);
  if (res.status !== 0) {
    fail('wrangler deploy failed:\n' + (res.stderr || res.stdout).slice(0, 800), 1);
  }
  const url = (res.stdout + res.stderr).match(/https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev/i);
  return url ? url[0] : null;
}

/**
 * Shared schema decision for the real run and for --plan. Keeping this pure is
 * what stops the preview from inventing a different policy.
 *
 * actions: none | skip | apply | prompt | fail | unknown
 * reasons: no-schema | flag | empty | already-applied | tables-yes | tables |
 *          drift | drift-yes | no-count
 *
 * `tables-yes` is the deliberate, occasionally surprising case: under --yes, a
 * D1 that already has tables is skipped. When no schemaHash was ever recorded
 * for this D1 (a first deploy against a pre-populated database, or a different
 * D1), the CLI cannot tell "already applied" from "unrelated tables", so it
 * writes no hash: `schemaHash` stays null and every later --yes run skips again.
 * This is safe — it never re-applies DDL blindly — but it is silent, so
 * `--schema=apply` is the explicit way to apply the schema in that situation.
 */
export function resolveSchemaAction({
  schemaExists,
  skipSchema = false,
  schemaApply = false,
  yes = false,
  count = null,
  currentHash = null,
  recordedHash = null,
  dbName = 'the D1',
}) {
  if (!schemaExists) return { action: 'none', reason: 'no-schema' };
  if (skipSchema) return { action: 'skip', reason: 'flag' };
  if (schemaApply) return { action: 'apply', reason: 'flag' };
  if (count === null || count === undefined) return { action: 'unknown', reason: 'no-count' };
  if (count === 0) return { action: 'apply', reason: 'empty', count };

  const hashMatches = Boolean(currentHash && recordedHash && currentHash === recordedHash);
  if (hashMatches) return { action: 'skip', reason: 'already-applied', count };

  const drift = Boolean(currentHash && recordedHash && currentHash !== recordedHash);
  if (yes) {
    if (drift) {
      return {
        action: 'fail',
        reason: 'drift-yes',
        count,
        message: `schema drift: dist/schema.sql changed since it was applied to "${dbName}", and the D1 has ${count} table(s). Refusing to re-apply it under --yes. Pass --skip-schema to keep the D1 as-is, or --schema=apply to apply the change deliberately.`,
      };
    }
    return { action: 'skip', reason: 'tables-yes', count };
  }
  return { action: 'prompt', reason: drift ? 'drift' : 'tables', count, drift };
}

/** Read the schema bytes and decide whether recorded metadata belongs to this D1. */
function schemaMeta(state, d1Id) {
  const path = join(appDir, 'dist', 'schema.sql');
  const exists = existsSync(path);
  let hash = null;
  let error = null;
  if (exists) {
    try {
      hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch (e) {
      error = `could not read dist/schema.sql: ${e.message}`;
    }
  }
  const sameD1 = Boolean(d1Id && state.d1.databaseId)
    && String(state.d1.databaseId).toLowerCase() === String(d1Id).toLowerCase();
  return {
    path,
    exists,
    hash,
    error,
    sameD1,
    recordedHash: sameD1 ? state.d1.schemaHash : null,
  };
}

const MODE_LABEL = {
  1: 'build only',
  2: 'build + database',
  3: 'build + database + deploy',
};

/**
 * Read-only view of the wrangler.jsonc changes a real run would make. It uses
 * the same JSONC inspector/editor primitives, but never writes.
 */
function planWrangler(workerName, nameExplicit, databaseRef, plannedId) {
  const issues = [];
  const config = readWranglerConfig();
  if (!config) {
    const scaffoldName = slugifyWorkerName(basename(appDir));
    return {
      issues,
      nameText: nameExplicit && workerName !== scaffoldName
        ? `not present — build would scaffold "${scaffoldName}" and the name would become "${workerName}"`
        : `not present — build would scaffold "${scaffoldName}"`,
      d1Text: 'not checked (config absent; build would scaffold a D1 entry)',
      changes: true,
      created: true,
      uncertain: false,
    };
  }

  let nameInfo;
  try {
    nameInfo = inspectWranglerName(config.text);
  } catch (e) {
    issues.push(jsoncProblem(e));
    return { issues, nameText: 'invalid JSONC', d1Text: 'not checked', changes: false, uncertain: true };
  }

  let nameText;
  let changes = false;
  let uncertain = false;
  if (nameInfo.status === 'ok') {
    if (nameInfo.name === workerName) {
      nameText = `"${nameInfo.name}" (already)`;
    } else if (nameExplicit) {
      nameText = `"${nameInfo.name}" → "${workerName}" (would update)`;
      changes = true;
    } else {
      nameText = `"${nameInfo.name}" (mismatch; would stop)`;
      issues.push(`wrangler.jsonc name is "${nameInfo.name}", not "${workerName}" — pass --name or edit wrangler.jsonc`);
    }
  } else if (nameInfo.status === 'missing') {
    nameText = 'missing "name" (would stop)';
    issues.push('wrangler.jsonc has no "name" field');
  } else if (nameInfo.status === 'duplicate') {
    nameText = 'duplicate "name" (would stop)';
    issues.push('wrangler.jsonc has more than one top-level "name" field — remove the duplicate');
  } else {
    nameText = 'no usable "name" (would stop)';
    issues.push('wrangler.jsonc has no usable "name" field');
  }

  if (!databaseRef) {
    return {
      issues,
      nameText,
      d1Text: 'database name not resolved offline; target not checked',
      changes,
      uncertain: true,
    };
  }

  let d1Info;
  try {
    d1Info = inspectD1Target(config.text, databaseRef);
  } catch (e) {
    issues.push(jsoncProblem(e));
    return { issues, nameText, d1Text: 'invalid JSONC', changes, uncertain: true };
  }

  let d1Text;
  if (d1Info.status === 'placeholder') {
    d1Text = `"${databaseRef}" placeholder → database_id set after resolution`;
    changes = true;
  } else if (d1Info.status === 'ok') {
    if (plannedId && String(d1Info.id).toLowerCase() === String(plannedId).toLowerCase()) {
      d1Text = `"${databaseRef}" already has database_id ${plannedId}`;
    } else if (plannedId) {
      d1Text = `"${databaseRef}" database_id → ${plannedId}`;
      changes = true;
    } else {
      d1Text = `"${databaseRef}" entry found (database_id resolved at run time; may change)`;
      uncertain = true;
    }
  } else {
    const problem = wranglerD1TargetProblem(config.text, databaseRef);
    if (problem) issues.push(problem);
    d1Text = `${databaseRef}: ${d1Info.status}`;
  }

  return { issues, nameText, d1Text, changes, uncertain };
}

/** Read-only D1 resolution for --plan. Never creates a database. */
async function planD1(d1Decision, state, { verify = check } = {}) {
  if (d1Decision.kind === 'auto') {
    const name = autoD1Name(d1Decision.workerName);
    if (!verify) return { id: null, name, action: 'create-or-reuse', verified: false };
    const result = await d1Resolve(name, { allowCreate: false, quiet: true });
    return { ...result, verified: true };
  }

  if (d1Decision.kind === 'id') {
    const id = String(d1Decision.id).toLowerCase();
    if (!verify) {
      const same = Boolean(state.d1.databaseId)
        && String(state.d1.databaseId).toLowerCase() === id;
      return {
        id,
        name: same ? state.d1.databaseName : null,
        action: 'reuse',
        verified: false,
      };
    }
    const list = listD1();
    const hit = findD1ById(list, id);
    if (!hit) {
      return {
        id,
        name: null,
        action: 'missing',
        verified: true,
        problem: `D1 database_id "${id}" was not found on this account`,
      };
    }
    return {
      id: String(hit.uuid || hit.database_id || id),
      name: hit.name,
      action: 'reuse',
      verified: true,
    };
  }

  return {
    id: null,
    name: null,
    action: 'unknown',
    verified: false,
    problem: 'interactive database selection has no --plan equivalent; pass --d1-auto or --d1-id',
  };
}

function schemaPlanText(action, meta, count) {
  if (action.action === 'none') {
    return meta.exists ? 'no schema action' : 'dist/schema.sql not present (build may create one)';
  }
  if (action.action === 'skip' && action.reason === 'flag') {
    return 'would skip (--skip-schema)';
  }
  if (action.action === 'apply' && action.reason === 'flag') {
    return 'would apply dist/schema.sql (--schema=apply)';
  }
  if (action.action === 'apply' && action.reason === 'empty') {
    return `would apply dist/schema.sql (D1 has 0 tables)`;
  }
  if (action.action === 'skip' && action.reason === 'already-applied') {
    return 'would skip (already applied; hash matches)';
  }
  if (action.action === 'skip' && action.reason === 'tables-yes') {
    return `would skip (${count} table(s) present; --yes, no recorded hash)`;
  }
  if (action.action === 'prompt') {
    return action.reason === 'drift'
      ? `would ask; drift detected (${count} table(s) present)`
      : `would ask; ${count} table(s) present`;
  }
  if (action.action === 'fail') {
    return `would STOP: drift detected and --yes is set (${count} table(s) present)`;
  }
  return 'not checked (current dist/schema.sql; --plan does not rebuild)';
}

async function runPlan({ state, mode, workerName, nameExplicit, d1Decision }) {
  const issues = [];
  let db = null;
  let account = null;
  let cloudBlocked = false;
  if (mode >= 2) {
    account = await planAccount(state);
    if (account.issue) issues.push(account.issue);
    cloudBlocked = Boolean(account.blocked);
    db = await planD1({ ...d1Decision, workerName }, state, {
      verify: check && !cloudBlocked,
    });
    if (db.problem) issues.push(db.problem);
    if (db.id && !isValidD1Id(db.id)) {
      issues.push(`D1 database_id "${db.id}" is not a UUID`);
    }
    if (db.name && !isValidD1Name(db.name)) {
      issues.push(`D1 name "${db.name}" contains characters this CLI cannot pass safely to wrangler`);
    }
  }

  const meta = mode >= 2 ? schemaMeta(state, db?.id) : null;
  if (meta?.error) issues.push(meta.error);

  let count = null;
  if (mode >= 2 && meta.exists && meta.hash && !skipSchema && !schemaApply
    && check && !cloudBlocked) {
    if (db.action === 'create' && !db.id) {
      count = 0; // a database that does not exist yet is empty
    } else if (db.name && db.id) {
      const result = tableCountQuery(db.name, db.id, { scratch: true });
      if (result.error) fail(result.error, 1);
      count = result.count;
    }
  }

  const action = mode >= 2
    ? resolveSchemaAction({
      schemaExists: Boolean(meta.exists && meta.hash),
      skipSchema,
      schemaApply,
      yes,
      count,
      currentHash: meta.hash,
      recordedHash: meta.recordedHash,
      dbName: db?.name || autoD1Name(workerName),
    })
    : { action: 'none', reason: 'no-schema' };

  if (action.action === 'fail') issues.push(action.message);

  const target = mode >= 2
    ? planWrangler(workerName, nameExplicit, db?.name || null, db?.id || null)
    : { issues: [], nameText: 'not used in mode 1', d1Text: 'not used in mode 1', changes: false };
  issues.push(...target.issues);

  const driftWarning = Boolean(
    mode >= 2
    && meta?.recordedHash
    && meta?.hash
    && meta.recordedHash !== meta.hash
    && count === null
    && !skipSchema
    && !schemaApply
    && !cloudBlocked,
  );
  const stateExists = existsSync(join(appDir, 'lw-state.json'));
  const stateLabel = stateExists ? 'updated' : 'new';

  console.log('\nPlan — nothing will be written\n');
  console.log(`  mode     ${mode} (${MODE_LABEL[mode]})`);
  if (mode >= 2) console.log(`  worker   ${workerName}`);
  if (mode >= 2) console.log(`  account  ${account.text}`);
  console.log('  build    would run; --plan does not write dist/');
  if (mode >= 2) {
    console.log(`  config   name ${target.nameText}`);
    const d1Label = db.name
      ? `${db.name}${db.id ? ` (${db.id})` : ''}`
      : (db.id || '(name resolved at run time)');
    console.log(`  d1       ${d1Label} — ${db.action}`);
    console.log(`  target   ${target.d1Text}`);
    console.log(`  schema   ${schemaPlanText(action, meta, count)}`);
    console.log(`  state    lw-state.json would be ${stateLabel} after success`);
    const configFile = target.created
      ? 'wrangler.jsonc (created by build)'
      : target.changes
        ? 'wrangler.jsonc (changed)'
        : target.uncertain
          ? 'wrangler.jsonc (unchanged now; may change after D1 lookup)'
          : 'wrangler.jsonc (unchanged)';
    console.log(`  files    ${configFile}; lw-state.json (${stateLabel}); dist/ via build`);
  } else {
    console.log('  state    lw-state.json untouched');
  }

  if (mode >= 2) {
    if (cloudBlocked) {
      console.log('  cloud    not reached (account check would stop the run)');
      if (check) console.log('  check    account check stopped; no D1 calls made');
    } else {
      const cloud = [];
      cloud.push('d1 list');
      if (db.action === 'create' || db.action === 'create-or-reuse') cloud.push('d1 create if missing');
      if (action.action === 'apply') cloud.push('d1 execute --remote (schema)');
      if (mode === 3) cloud.push('wrangler deploy');
      console.log(`  cloud    ${cloud.join('; ')}`);
      if (!check) console.log('  check    off; add --check for read-only D1 existence/count verification');
    }
  }

  if (driftWarning) {
    console.log('\n  warning  schema drift is possible; if the D1 has tables, a real --yes run will stop.');
    console.log('           Add --check to confirm, or choose --skip-schema / --schema=apply.');
  }

  if (issues.length) {
    console.log('\nA real run would stop before making changes:');
    for (const issue of issues) console.log(`  - ${issue}`);
    console.log('\nPlan NOT ready — no changes made.');
    process.exitCode = 2;
  } else {
    console.log('\nPlan OK — no changes made.');
    process.exitCode = 0;
  }
}

async function main() {
  if (has('--help') || has('-h')) {
    console.log(USAGE);
    return;
  }
  if (dryRunFlag) {
    fail('--dry-run is not supported; use --plan to preview (no writes), or --mode 1 to build only', 2);
  }
  if (schemaFlag !== undefined && schemaFlag !== 'apply') {
    fail(`invalid --schema value "${schemaFlag}" (only "apply" is supported)`, 2);
  }
  if (schemaApply && skipSchema) {
    fail('use either --skip-schema or --schema=apply, not both', 2);
  }
  if (check && !plan) {
    fail('--check is only valid with --plan', 2);
  }
  if (d1IdFlag !== undefined && autoD1) fail('use either --d1-id or --d1-auto, not both', 2);
  if (d1IdFlag !== undefined && !isValidD1Id(d1IdFlag)) {
    fail(`invalid D1 database_id "${d1IdFlag}" (expected a UUID)`, 2);
  }
  if (modeFlag !== undefined && ![1, 2, 3].includes(Number(modeFlag))) {
    fail(`invalid mode: ${modeFlag} (expected 1, 2, or 3)`, 2);
  }

  requireApp();
  let state;
  try {
    state = readState(appDir, { strict: true });
  } catch (e) {
    fail(e.message, 2);
  }
  chosen.account = { ...state.account };
  chosen.workerUrl = state.workerUrl || null;
  chosen.deployedAt = state.deployedAt || null;
  chosen.d1 = { ...state.d1 };

  const interactive = hasTTY && !yes && !plan;

  // --- 1. mode ------------------------------------------------------------
  const deployShortcut = has('--deploy');
  const dbShortcut = has('--db');
  const hasD1Flag = d1IdFlag !== undefined || autoD1;
  const modeDefaulted = modeFlag === undefined && !deployShortcut && !dbShortcut;
  if (modeFlag !== undefined && (deployShortcut || dbShortcut)) {
    fail('use either --mode or --deploy/--db, not both', 2);
  }
  if (deployShortcut && dbShortcut) fail('use either --deploy or --db, not both', 2);

  let mode;
  if (modeFlag !== undefined) mode = Number(modeFlag);
  else if (deployShortcut) mode = 3;
  else if (dbShortcut) mode = 2;
  else mode = null;

  if (mode === null && !interactive) mode = hasD1Flag ? 2 : 1; // CI default: build only unless D1 was requested
  else if (mode === null) {
    const choice = await ask('What should I do?\n  [1] build only\n  [2] build + database\n  [3] build + database + deploy\nChoice [1]', '1');
    mode = Number(choice) || 1;
  }
  if (![1, 2, 3].includes(mode)) fail(`invalid mode: ${mode}`, 2);
  if (mode === 1 && nameFlag !== undefined) {
    fail('--name requires --mode 2 or 3; mode 1 builds only and does not touch wrangler.jsonc', 2);
  }
  if (mode === 1 && hasD1Flag) fail('--d1-id/--d1-auto require --mode 2 or 3', 2);
  if (mode === 1 && (skipSchema || schemaApply)) {
    fail('--skip-schema/--schema=apply require --mode 2 or 3', 2);
  }
  if (mode === 1 && allowAccountChange) {
    fail('--allow-account-change requires --mode 2 or 3', 2);
  }

  // --- 2. worker name (mode 2/3) ------------------------------------------
  // wrangler.jsonc is authoritative unless --name (or an interactive answer)
  // explicitly chooses another name. This keeps a manual rename in sync.
  let nameExplicit = false;
  let nameChanged = false;
  let workerName = slugifyWorkerName(basename(appDir));
  if (mode >= 2) {
    nameExplicit = nameFlag !== undefined;
    const config = readWranglerConfig();
    let configName = null;
    if (config) {
      try {
        const info = inspectWranglerName(config.text);
        if (info.status === 'ok') configName = info.name;
      } catch {
        // syncWranglerName() reports the precise JSONC error after the build.
      }
    }
    let recordedName = false;
    if (nameFlag !== undefined) {
      workerName = String(nameFlag).trim();
      if (!isValidWorkerName(workerName)) {
        fail('worker name must be 1–63 chars, lowercase letters/digits/hyphens, and cannot start/end with a hyphen', 2);
      }
    } else if (configName !== null) {
      if (!isValidWorkerName(configName)) {
        fail(`wrangler.jsonc name "${configName}" is not a valid worker name — pass --name to replace it`, 2);
      }
      workerName = configName;
    } else if (state.workerName) {
      workerName = state.workerName;
      recordedName = true;
      if (!isValidWorkerName(workerName)) {
        fail('lw-state.json has an invalid workerName — pass --name to replace it', 2);
      }
    }
    if (nameFlag === undefined && !config && recordedName) {
      // The build will scaffold wrangler.jsonc from the directory slug; the
      // recorded worker name must win so the guided deploy recreates its config.
      nameExplicit = true;
    }
    const suggestedName = workerName;
    const answer = plan ? suggestedName : String(await ask(`Worker name [${suggestedName}]`, suggestedName)).trim();
    if (nameFlag === undefined && answer !== suggestedName) nameExplicit = true;
    workerName = answer;
    if (!isValidWorkerName(workerName)) {
      fail('worker name must be 1–63 chars, lowercase letters/digits/hyphens, and cannot start/end with a hyphen', 2);
    }
    nameChanged = Boolean(state.workerName && state.workerName !== workerName);
    chosen.workerName = workerName;
  }

  // --- 3. D1 choice (mode 2/3) --------------------------------------------
  let d1Decision = { kind: 'auto' };
  if (mode >= 2) {
    // Explicit flags are the user's decision, even when a state file exists.
    if (d1IdFlag !== undefined) {
      d1Decision = { kind: 'id', id: d1IdFlag.toLowerCase() };
    } else if (autoD1) {
      d1Decision = { kind: 'auto' };
    } else if (state.d1.databaseId) {
      // Reuse the recorded D1 even when the worker is renamed: the state file
      // is app-scoped, and --d1-auto/--d1-id are the explicit ways to switch.
      d1Decision = { kind: 'id', id: String(state.d1.databaseId).toLowerCase() };
    } else if (!interactive) {
      d1Decision = { kind: 'auto' };
    } else {
      const pick = await ask('Database:\n  [A] auto (create/reuse <worker>-db)\n  [B] list existing\n  [C] paste database_id\nChoice [A]', 'A');
      const kind = await choose(pick, 'A');
      if (kind === 'A') d1Decision = { kind: 'auto' };
      else if (kind === 'B') d1Decision = { kind: 'list' };
      else {
        const id = await ask('D1 database_id', '');
        if (!id) fail('a database_id is required for [C]', 2);
        if (!isValidD1Id(id)) fail(`invalid D1 database_id "${id}" (expected a UUID)`, 2);
        d1Decision = { kind: 'id', id: id.toLowerCase() };
      }
    }
  }

  // --- 4. plan (read-only; returns before build) --------------------------
  if (plan) {
    if (modeDefaulted && mode === 1) {
      console.log('\nNote: no --mode was given, so --plan uses the non-interactive default (mode 1).');
      console.log('Pass --mode 3 (or --deploy) to preview the full deploy.');
    }
    await runPlan({ state, mode, workerName, nameExplicit, d1Decision });
    if (rl) rl.close();
    return;
  }

  // --- 5. build -----------------------------------------------------------
  console.log(`\n» building ${workerName} (mode ${mode}) …\n`);
  const build = runInherit(process.execPath, buildArgsFor(buildExtra));
  if (build.error) fail(build.error.message, 1);
  if (build.status !== 0) fail(`build failed (exit ${build.status}) — nothing was deployed`, 1);

  // --- 6. D1 provisioning + schema (mode 2/3) -----------------------------
  if (mode >= 2) {
    // Validate the name before provisioning; write it only after the schema
    // decision so a drift refusal leaves wrangler.jsonc untouched.
    syncWranglerName(workerName, nameExplicit, { dryRun: true });

    let d1Id = null;
    let dbName = null;

    // Validate the bind target before the account lookup so a broken config
    // still fails without a network call. Auto provisioning may then create a
    // database; every other branch lists the account.
    if (d1Decision.kind === 'auto') {
      dbName = autoD1Name(workerName);
      assertWranglerD1Target(dbName);
    }

    const account = await ensureCloudAccount(state);
    chosen.account = { id: account.id, name: account.name, email: account.email };
    if (account.changed) {
      // The worker URL and deploy timestamp belong to the old account. Never
      // carry them into the new account, even if the worker name did not change.
      chosen.workerUrl = null;
      chosen.deployedAt = null;
    }

    if (d1Decision.kind === 'list') {
      const list = listD1();
      if (!list.length) fail('no D1 databases on the account — use [A] auto to create one', 2);
      const options = list.map((d, i) => `  [${i + 1}] ${d.name} (${d.uuid || d.database_id})`).join('\n');
      const choice = await ask(`Existing databases:\n${options}\nPick [1]`, '1');
      const idx = Number(choice) - 1;
      if (!Number.isInteger(idx) || !list[idx]) fail(`invalid pick "${choice}"`, 2);
      d1Id = list[idx].uuid || list[idx].database_id;
      dbName = list[idx].name;
    } else if (d1Decision.kind === 'id') {
      const list = listD1();
      const hit = findD1ById(list, d1Decision.id);
      if (!hit) fail(`D1 database_id "${d1Decision.id}" was not found on this account`, 2);
      d1Id = hit.uuid || hit.database_id || d1Decision.id;
      dbName = hit.name;
    } else if (d1Decision.kind === 'auto') {
      const resolved = await d1Resolve(dbName);
      d1Id = resolved.id;
    } else {
      fail('no D1 database selected (use --d1-id <uuid> or --d1-auto)', 2);
    }

    if (!d1Id) fail('could not resolve the D1 database_id', 1);
    d1Id = String(d1Id).toLowerCase();
    if (!isValidD1Id(d1Id)) {
      fail(`wrangler returned an invalid D1 database_id "${d1Id}" (expected a UUID)`, 1);
    }
    if (!dbName) fail('could not resolve the D1 database name', 1);
    dbName = String(dbName);
    if (!isValidD1Name(dbName)) {
      fail(`D1 name "${dbName}" was returned by Wrangler with characters this CLI cannot pass safely`, 1);
    }

    // A different D1 must not inherit the old database's schema metadata.
    const sameD1 = Boolean(state.d1.databaseId)
      && String(state.d1.databaseId).toLowerCase() === d1Id;
    if (!sameD1) {
      chosen.d1.schemaAppliedAt = null;
      chosen.d1.schemaHash = null;
    }

    chosen.d1.databaseId = d1Id;
    chosen.d1.databaseName = dbName;

    const meta = schemaMeta(state, d1Id);
    if (meta.error) fail(meta.error, 1);
    if (!meta.exists) console.log('→ dist/schema.sql not found — no schema will be applied');

    // Decide before touching wrangler.jsonc: drift under --yes must not leave
    // a half-applied config behind.
    let schemaDecision;
    if (!meta.exists) {
      schemaDecision = { action: 'none', reason: 'no-schema' };
    } else if (!meta.hash) {
      fail('dist/schema.sql could not be read', 1);
    } else if (skipSchema) {
      schemaDecision = { action: 'skip', reason: 'flag' };
    } else if (schemaApply) {
      schemaDecision = { action: 'apply', reason: 'flag' };
    } else {
      const count = d1TableCount(dbName, d1Id);
      schemaDecision = resolveSchemaAction({
        schemaExists: true,
        yes,
        count,
        currentHash: meta.hash,
        recordedHash: meta.recordedHash,
        dbName,
      });
      if (schemaDecision.action === 'fail') fail(schemaDecision.message, 2);
      if (schemaDecision.action === 'prompt') {
        const question = schemaDecision.reason === 'drift'
          ? `"${dbName}" has ${count} table(s) and dist/schema.sql changed since the last apply. Apply the changed schema anyway? [y/N]`
          : `"${dbName}" already has ${count} table(s). Apply schema anyway? [y/N]`;
        const answer = await ask(question, 'N');
        if (answer.trim().toLowerCase() === 'y') {
          schemaDecision = { action: 'apply', reason: 'prompt', count };
        } else {
          schemaDecision = {
            action: 'skip',
            reason: schemaDecision.reason === 'drift' ? 'drift-kept' : 'tables-kept',
            count,
          };
        }
      }
    }

    // The schema decision is final; now it is safe to write the worker name and
    // then the D1 id. A drift refusal above never reaches these writes.
    syncWranglerName(workerName, nameExplicit);
    const injection = injectD1Id(dbName, d1Id);
    if (injection === 'no-file') {
      fail('wrangler.jsonc disappeared before its database_id could be written', 2);
    }
    if (injection === 'missing-id') {
      fail(`wrangler.jsonc has a D1 entry for "${dbName}" but no database_id — add it or remove the entry`, 2);
    }
    if (injection === 'no-entry') {
      fail(`wrangler.jsonc has no D1 entry named "${dbName}" — run init or edit it before deploying`, 2);
    }
    console.log(`→ D1 "${dbName}" ready`);

    if (schemaDecision.action === 'apply') {
      await d1ApplySchema(dbName, d1Id);
      chosen.d1.schemaAppliedAt = new Date().toISOString();
      chosen.d1.schemaHash = meta.hash;
    } else if (schemaDecision.action === 'skip') {
      if (schemaDecision.reason === 'flag') {
        console.log('→ schema skipped (--skip-schema)');
      } else if (schemaDecision.reason === 'already-applied') {
        console.log('→ schema skipped (already applied; hash matches)');
      } else if (schemaDecision.reason === 'tables-yes') {
        console.log(`→ schema skipped (${schemaDecision.count} table(s) present; --yes, no recorded hash)`);
      } else if (schemaDecision.reason === 'drift-kept') {
        console.log('→ schema skipped (drift kept; D1 unchanged)');
      } else if (schemaDecision.reason === 'tables-kept') {
        console.log(`→ schema skipped (${schemaDecision.count} table(s) present)`);
      }
    }
  }

  // --- 7. deploy (mode 3) -------------------------------------------------
  if (mode === 3) {
    const url = await doDeploy();
    if (url) chosen.workerUrl = url;
    else if (nameChanged) chosen.workerUrl = null;
    chosen.deployedAt = new Date().toISOString();
  } else if (mode === 2 && nameChanged) {
    // The old URL belongs to a different worker; do not pretend it is current.
    chosen.workerUrl = null;
    chosen.deployedAt = null;
  }

  // --- 8. persist state ---------------------------------------------------
  // Mode 1 is intentionally a pure build: it must not rewrite deploy state.
  if (mode >= 2) {
    try {
      writeState(appDir, {
        account: {
          id: chosen.account.id || null,
          name: chosen.account.name || null,
          email: chosen.account.email || null,
        },
        workerName: chosen.workerName,
        workerUrl: chosen.workerUrl || null,
        deployedAt: chosen.deployedAt || null,
        d1: {
          binding: 'DB',
          databaseName: chosen.d1.databaseName || null,
          databaseId: chosen.d1.databaseId || null,
          schemaAppliedAt: chosen.d1.schemaAppliedAt || null,
          schemaHash: chosen.d1.schemaHash || null,
        },
      });
    } catch (e) {
      fail(`could not write lw-state.json: ${e.message}`, 2);
    }
  }
  if (rl) rl.close();

  const summary = mode === 3
    ? (chosen.workerUrl ? `deployed → ${chosen.workerUrl}` : 'deployed (URL not detected)')
    : mode === 2 ? 'built + database ready' : 'built';
  console.log(`\n✔ ${summary}`);
}

const self = fileURLToPath(import.meta.url);
const entry = process.argv[1] ? resolve(process.argv[1]) : '';
const isMain = Boolean(entry) && (process.platform === 'win32'
  ? entry.toLowerCase() === self.toLowerCase()
  : entry === self);

if (isMain) {
  main().catch((e) => {
    console.error('deploy:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
