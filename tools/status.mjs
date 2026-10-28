#!/usr/bin/env node
// tools/status.mjs — show the deployed state for this app (lw-state.json).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountLabel } from './cloud-account.mjs';
import { readState, STATE_FILE } from './lw-state.mjs';

const appDir = resolve(process.cwd());

let state = null;
try {
  state = readState(appDir, { strict: true });
} catch (e) {
  console.error(`laravel-workers: ${e.message}`);
  console.error(`  fix or remove ${join(appDir, STATE_FILE)} before the next deploy.`);
  process.exitCode = 2;
}

if (state) {
  if (!state.workerName && !state.d1.databaseId) {
    console.log('laravel-workers: no deploy recorded for this app yet.');
    console.log('  run `npx laravel-workers deploy` to build + deploy.');
  } else {
    console.log(`worker  : ${state.workerName || '(not deployed)'}`);
    console.log(`account : ${state.account.id ? accountLabel(state.account) : '(not recorded yet)'}`);
    console.log(`url     : ${state.workerUrl || '(not deployed)'}`);
    console.log(`deployed: ${state.deployedAt || '(never)'}`);

    if (state.d1.databaseId) {
      console.log(`d1      : ${state.d1.databaseName || '?'} (${state.d1.databaseId})`);
      let schemaLine = `schema  : ${state.d1.schemaAppliedAt || '(not applied)'}`;
      if (state.d1.schemaHash) schemaLine += ' · ' + state.d1.schemaHash.slice(0, 8);

      const schemaPath = join(appDir, 'dist', 'schema.sql');
      if (state.d1.schemaHash) {
        if (!existsSync(schemaPath)) {
          schemaLine += ' (dist/schema.sql is missing)';
        } else {
          try {
            const current = createHash('sha256').update(readFileSync(schemaPath)).digest('hex');
            if (current !== state.d1.schemaHash) {
              schemaLine += ' (dist/schema.sql changed since last apply)';
            }
          } catch {
            schemaLine += ' (dist/schema.sql is unreadable)';
          }
        }
      }
      console.log(schemaLine);
    } else {
      console.log('d1      : (none)');
    }
  }
}
