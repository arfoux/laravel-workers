#!/usr/bin/env node
// tools/init.mjs — Scaffold registry.json + wrangler.jsonc for a Laravel app.
// Run from the Laravel app root: npx laravel-workers init
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = process.cwd();

if (!existsSync(join(appDir, 'artisan'))) {
  console.warn('warning: artisan not found in ' + appDir + ' — run init from your Laravel app root.');
}

const slug = basename(appDir).toLowerCase().replace(/[^a-z0-9-]+/g, '-');

// registry.json — tier maps read by build.mjs
const registryPath = join(appDir, 'registry.json');
if (!existsSync(registryPath)) {
  writeFileSync(registryPath, '{\n  "autoSnapshot": true,\n  "static": {},\n  "ports": {},\n  "ignore": {},\n  "views": {}\n}\n');
  console.log('created registry.json');
} else {
  console.log('registry.json exists — skipped');
}

// wrangler.jsonc — minimal Workers config; fill database_id after `wrangler d1 create`
const wranglerPath = join(appDir, 'wrangler.jsonc');
if (!existsSync(wranglerPath)) {
  writeFileSync(wranglerPath, `{
  "name": "${slug}",
  "main": "./dist/src/worker.mjs",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "./dist/public", "binding": "ASSETS" },
  "d1_databases": [ { "binding": "DB", "database_name": "${slug}", "database_id": "REPLACE_WITH_D1_ID" } ],
    // The Storage facade (Storage::put/get/exists/delete) writes to R2 — the edge
    // has no local filesystem. Uncomment and fill in a bucket:
    // "r2_buckets": [ { "binding": "R2", "bucket_name": "REPLACE_WITH_R2_BUCKET" } ],
    // The build writes dist/cron.json (the app schedule -> Cloudflare Cron Triggers).
    // Copy its "crons" here to arm the schedule:
    // "triggers": { "crons": [ "*/5 * * * *" ] },
  "observability": { "enabled": true }
}
`);
  console.log('created wrangler.jsonc (set database_id after `npx wrangler d1 create ' + slug + '`)');
} else {
  console.log('wrangler.jsonc exists — skipped');
}

// .env — copy from .env.example and/or add APP_KEY if missing
// APP_KEY = base64:<32 random bytes> — pure JS, no PHP, no Laravel needed
const envPath = join(appDir, '.env');
const envExamplePath = join(appDir, '.env.example');

function generateAppKey() {
  const bytes = randomBytes(32);
  return 'base64:' + bytes.toString('base64');
}

function setEnvVar(content, key, value) {
  const pattern = new RegExp('^' + key + '=.*', 'm');
  if (pattern.test(content)) {
    return content.replace(pattern, key + '=' + value);
  }
  return content + (content.endsWith('\n') ? '' : '\n') + key + '=' + value + '\n';
}

let envContent = '';
let appKeySet = false;

if (existsSync(envPath)) {
  envContent = readFileSync(envPath, 'utf8');
} else if (existsSync(envExamplePath)) {
  envContent = readFileSync(envExamplePath, 'utf8');
  writeFileSync(envPath, envContent);
  console.log('created .env from .env.example');
} else {
  // Bare .env — start fresh
  writeFileSync(envPath, '');
  console.log('created empty .env');
}

if (!/^APP_KEY=./m.test(envContent)) {
  const newKey = generateAppKey();
  envContent = setEnvVar(envContent, 'APP_KEY', newKey);
  writeFileSync(envPath, envContent);
  console.log('APP_KEY set: ' + newKey + '  (no PHP, no Laravel — pure Node.js)');
  appKeySet = true;
} else {
  console.log('.env already has APP_KEY — skipped');
}

// .gitignore — append missing build artifacts under a marker comment
const gitignorePath = join(appDir, '.gitignore');
const wanted = ['dist/', '.cache/', '.wrangler/'];
if (existsSync(gitignorePath)) {
  const current = readFileSync(gitignorePath, 'utf8');
  const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = wanted.filter((l) => !present.has(l));
  if (missing.length === 0) {
    console.log('.gitignore — nothing to add (dist/, .cache/, .wrangler/ already present)');
  } else {
    const block = '# laravel-workers\n' + missing.join('\n') + '\n';
    writeFileSync(gitignorePath, (current.endsWith('\n') ? current : current + '\n') + block);
    console.log('.gitignore — added: ' + missing.join(', '));
  }
} else {
  console.log('.gitignore not found — skipped');
}

console.log('');
console.log('Next steps:');
if (!appKeySet) {
  console.log('  # APP_KEY already present in .env — no action needed');
}
console.log('  npx laravel-workers build --strict   # vendor + schema handled automatically');
console.log('  npx wrangler dev      # local preview');
console.log('  npx wrangler deploy   # ship to Cloudflare');
