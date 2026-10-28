#!/usr/bin/env node
// tools/tests/fixtures/fake-build.mjs — test-only build stand-in.
//
// deploy runs this through LW_BUILD_BIN. It writes the schema deploy expects
// and can fail on demand; it never compiles a Laravel app.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const cwd = process.cwd();
const logPath = process.env.FAKE_BUILD_LOG;
if (logPath) {
  appendFileSync(logPath, JSON.stringify({ args: process.argv.slice(2), cwd }) + '\n');
}

const exit = Number(process.env.FAKE_BUILD_EXIT || 0);
if (exit) {
  console.error(`fake build: refusing with exit ${exit}`);
  process.exit(exit);
}

if (process.env.FAKE_SCHEMA_SOURCE) {
  const schema = join(cwd, 'dist', 'schema.sql');
  mkdirSync(dirname(schema), { recursive: true });
  copyFileSync(process.env.FAKE_SCHEMA_SOURCE, schema);
} else if (process.env.FAKE_SCHEMA_SQL !== undefined) {
  const schema = join(cwd, 'dist', 'schema.sql');
  mkdirSync(dirname(schema), { recursive: true });
  writeFileSync(schema, process.env.FAKE_SCHEMA_SQL, 'utf8');
}

// Mirror the real build's missing-config scaffold. deploy must still honour a
// recorded worker name and rewrite the scaffolded D1 entry to <name>-db.
if (process.env.FAKE_SCAFFOLD_CONFIG === '1' && !existsSync(join(cwd, 'wrangler.jsonc'))) {
  const slug = basename(cwd).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '') || 'fake-app';
  writeFileSync(join(cwd, 'wrangler.jsonc'), `{
  "name": "${slug}",
  "main": "./dist/src/worker.mjs",
  "d1_databases": [ { "binding": "DB", "database_name": "${slug}-db", "database_id": "REPLACE_WITH_D1_ID" } ]
}
`);
}

console.log('fake build: ok');
