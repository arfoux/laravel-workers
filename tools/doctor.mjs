#!/usr/bin/env node
// tools/doctor.mjs — one-command preflight for laravel-workers.
//
// Checks (each: OK / WARN / FAIL):
//   • node version            (>=22)
//   • a Laravel app root    -- artisan present?
//   • PHP interpreter          (requirements below, via tools/php-runtime.mjs)
//   • vendor/ autoload        (own or LW_VENDOR_DIR)
//   • APP_KEY in .env
//   • wrangler reachable      (needed for deploy-backed modes)
//   • wrangler login          (account reachable — only when asked)
//   • existing deploy state   (lw-state.json)
//
// Exit code: 0 when nothing FAILs, 2 when something FAILs (1 is reserved for
// crash/usage). `--cloud` adds the authenticated wrangler checks. `--strict`
// upgrades the missing-app-root WARN to a FAIL, so CI can run `doctor --strict`
// from the app root and treat "not a Laravel app" as a hard error instead of a
// silent pass.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountLabel, readCloudIdentity, selectAccount } from './cloud-account.mjs';
import { inspectWranglerAccount } from './jsonc.mjs';
import { readState, STATE_FILE } from './lw-state.mjs';
import { NPX, runCapture } from './run.mjs';

const appDir = resolve(process.cwd());
const checkCloud = process.argv.includes('--cloud');
const strict = process.argv.includes('--strict');

// Test hook: tools/tests points LW_WRANGLER_BIN at the fake CLI. The fixture is
// excluded from the npm tarball, so the hook is inert in an installed package.
const testWrangler = existsSync(new URL('./tests/fixtures/fake-wrangler.mjs', import.meta.url))
  ? (process.env.LW_WRANGLER_BIN || null)
  : null;

function wranglerCapture(args) {
  if (testWrangler) {
    return runCapture(process.execPath, [testWrangler, ...args], { timeout: 30000 });
  }
  return runCapture(NPX, ['wrangler', ...args], { timeout: 30000 });
}

function configAccountId() {
  const path = join(appDir, 'wrangler.jsonc');
  if (!existsSync(path)) return { id: null };
  let info;
  try {
    info = inspectWranglerAccount(readFileSync(path, 'utf8'));
  } catch (e) {
    return { error: `wrangler.jsonc: ${e.message}` };
  }
  if (info.status === 'missing') return { id: null };
  if (info.status === 'duplicate') {
    return { error: 'wrangler.jsonc has more than one top-level account_id — remove the duplicate' };
  }
  if (info.status === 'invalid') return { error: 'wrangler.jsonc account_id is not a string' };
  if (info.status === 'not-object') return { error: 'wrangler.jsonc is not a JSON object' };
  return { id: info.id };
}

const checks = [];
let fails = 0;
const ok = (name, detail) => checks.push({ name, level: 'ok', detail: detail || '' });
const warn = (name, detail) => checks.push({ name, level: 'warn', detail: detail || '' });
const fail = (name, detail) => { checks.push({ name, level: 'fail', detail: detail || '' }); fails++; };

// 1. node
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 22) ok('node', `v${process.versions.node}`);
else fail('node', `v${process.versions.node} — laravel-workers needs >=22`);

// 2. app root
const isApp = existsSync(join(appDir, 'artisan'));
if (isApp) ok('app root', join(appDir, 'artisan'));
else if (strict) fail('app root', `no artisan in ${appDir} — run from the Laravel app root (--strict)`);
else warn('app root', `no artisan in ${appDir} — run from the Laravel app root (pass --strict to make this fatal)`);

// 3. PHP
try {
  const { resolvePhp } = await import(new URL('./php-runtime.mjs', import.meta.url).href);
  const r = resolvePhp({}); // no app requirement probe; build resolves with composer
  ok('php', `PHP ${r.version || '?'} (${r.bin})`);
} catch (e) {
  warn('php', 'no PHP found on PATH or via PHP_BIN (' + String(e.message || e).slice(0, 80) + ')');
}

// 4. vendor
const vendorDir = process.env.LW_VENDOR_DIR
  ? join(process.env.LW_VENDOR_DIR, 'autoload.php')
  : join(appDir, 'vendor', 'autoload.php');
if (existsSync(vendorDir)) ok('vendor', vendorDir);
else warn('vendor', 'vendor/autoload.php not found — build provisions it via vendor-lite');

// 5. APP_KEY — only a real assignment, not a commented line or empty value
try {
  const env = existsSync(join(appDir, '.env')) ? readFileSync(join(appDir, '.env'), 'utf8') : '';
  const line = env.match(/^\s*APP_KEY\s*=\s*(.*)$/m);
  const value = line ? line[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim() : '';
  if (value && !value.startsWith('#')) ok('APP_KEY', 'present in .env');
  else if (process.env.APP_KEY) ok('APP_KEY', 'present in process env');
  else warn('APP_KEY', 'missing — build generates one automatically');
} catch (e) {
  warn('APP_KEY', 'unreadable .env');
}

// 6. wrangler. runCapture() uses shell:true on Windows, where npx is a .cmd.
const wrangler = wranglerCapture(['--version']);
if (!wrangler.error && wrangler.status === 0) {
  const version = (wrangler.stdout || wrangler.stderr || '').trim();
  const major = Number((version.match(/(\d+)\./) || [])[1]);
  if (Number.isFinite(major) && major < 4) {
    warn('wrangler', `${version || 'old version'} — v4+ expected; upgrade before a live deploy`);
  } else {
    ok('wrangler', version || 'reachable via npx');
  }
} else {
  const detail = wrangler.error
    ? wrangler.error.message
    : 'not found — needed for deploy/D1 modes (npm i -g wrangler or npx)';
  warn('wrangler', detail);
}

// 7. state — read before the cloud check so the recorded account can be
// compared, but report it after the cloud rows to keep the familiar order.
let state = null;
let stateProblem = null;
try {
  state = readState(appDir, { strict: true });
} catch (e) {
  stateProblem = e.message;
}

// 8. cloud auth (only when requested)
if (checkCloud) {
  const who = readCloudIdentity((args) => wranglerCapture(args));
  if (who.error) {
    fail('cloud auth', `could not read wrangler whoami (${who.error}) — run \`npx wrangler login\``);
  } else {
    const email = who.identity.email;
    ok('cloud auth', email ? `logged in as ${email}` : 'logged in to Cloudflare');

    const fromConfig = configAccountId();
    if (fromConfig.error) {
      fail('cloud account', fromConfig.error);
    } else {
      const selected = selectAccount(who.identity, {
        configAccountId: fromConfig.id,
        envAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID,
      });
      if (selected.error) {
        fail('cloud account', selected.error);
      } else {
        const recorded = state && state.account && state.account.id ? state.account : null;
        if (recorded && recorded.id !== selected.id) {
          fail('cloud account', `lw-state.json is linked to ${accountLabel(recorded)}, but wrangler is using ${accountLabel(selected)} — run deploy with --allow-account-change to switch`);
        } else if (recorded) {
          ok('cloud account', `${accountLabel(selected)} (matches lw-state.json)`);
        } else {
          ok('cloud account', `${accountLabel(selected)} (not recorded yet; the next successful deploy records it)`);
        }
      }
    }
  }
}

// 9. state details
if (stateProblem) {
  fail('deploy state', `${stateProblem} — fix or remove ${join(appDir, STATE_FILE)}`);
}
const bits = [];
if (state && state.account && state.account.id) {
  bits.push(`account ${accountLabel(state.account)}`);
}
if (state && state.workerName) {
  const shipped = Boolean(state.deployedAt);
  const target = state.workerUrl ? ' → ' + state.workerUrl : '';
  bits.push(`${shipped ? 'deployed' : 'recorded'} "${state.workerName}"${target}`
    + (shipped ? ` (${state.deployedAt})` : ' (not deployed yet)'));
}
if (state && state.d1 && state.d1.databaseId) {
  bits.push(`D1 ${state.d1.databaseName || state.d1.databaseId}`);
}
if (bits.length) ok('deploy state', bits.join(' · '));
else if (state) warn('deploy state', 'no deploy recorded yet');

// output
const width = Math.max(...checks.map((c) => c.name.length)) + 2;
for (const c of checks) {
  const glyph = c.level === 'ok' ? ' ✓' : c.level === 'warn' ? ' ⚠' : ' ✗';
  process.stdout.write(`${glyph} ${c.name.padEnd(width)} ${c.detail}\n`);
}
process.exitCode = fails ? 2 : 0;
