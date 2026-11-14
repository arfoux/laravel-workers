#!/usr/bin/env node
// tools/status.mjs — show the deployed state for this app (lw-state.json).
//
// Three situations, told apart instead of merged — merging them is what made
// `status` print "no deploy recorded" for an app that was live (docs/EVIDENCE.md
// finding 4):
//   1. nothing recorded, and nothing that looks built/deployed — a fresh app;
//   2. a wrangler config or a dist but no recorded deploy — deployed outside this
//      toolchain, which is a fact worth stating (and stating what it cannot know);
//   3. a recorded deploy — worker, account, URL, when, which commit, which version.
//
// The commit comes from the deploy record when there is one, and from the build's
// own record (`dist/build-info.json`) when there is not. Neither is guessed: an
// app outside git says "not recorded".
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountLabel } from './cloud-account.mjs';
import { readState, STATE_FILE } from './lw-state.mjs';
import { sourceLabel } from './git-sha.mjs';

const appDir = resolve(process.cwd());

// What the last build recorded (build.mjs writes it): the commit the dist came
// from, the toolchain that wrote it, and when.
let built = null;
try {
  built = JSON.parse(readFileSync(join(appDir, 'dist', 'build-info.json'), 'utf8'));
} catch {
  /* no build record — say nothing rather than guess */
}

let state = null;
try {
  state = readState(appDir, { strict: true });
} catch (e) {
  console.error(`laravel-workers: ${e.message}`);
  console.error(`  fix or remove ${join(appDir, STATE_FILE)} before the next deploy.`);
  process.exitCode = 2;
}

const hasWranglerConfig = existsSync(join(appDir, 'wrangler.jsonc'))
  || existsSync(join(appDir, 'wrangler.toml'));

if (state) {
  if (!state.workerName && !state.d1.databaseId) {
    if (!hasWranglerConfig && !built) {
      console.log('laravel-workers: no deploy recorded for this app yet.');
      console.log('  run `npx laravel-workers deploy` to build + deploy.');
    } else {
      const seen = [];
      if (hasWranglerConfig) seen.push('wrangler.jsonc is present');
      if (built) {
        seen.push(`dist/ was built from ${sourceLabel(built.source)}`
          + (built.builtAt ? ` at ${built.builtAt}` : '') + (built.toolVersion ? ` by laravel-workers ${built.toolVersion}` : ''));
      }
      console.log('laravel-workers: this toolchain recorded no deploy for this app.');
      console.log(`  ${seen.join('; ')} — so it was most likely deployed outside laravel-workers`);
      console.log('  (a plain `wrangler deploy`, or another machine\'s checkout).');
      console.log('  run `npx laravel-workers deploy` to build + deploy and record the worker, D1 and commit here.');
      console.log('  not known from here: the live worker, its URL, and its D1 — only that deploy writes those.');
    }
  } else {
    console.log(`worker  : ${state.workerName || '(not deployed)'}`);
    console.log(`account : ${state.account.id ? accountLabel(state.account) : '(not recorded yet)'}`);
    console.log(`url     : ${state.workerUrl || '(not deployed)'}`);
    console.log(`deployed: ${state.deployedAt || '(never)'}`);
    const commit = state.sourceSha
      ? sourceLabel({ sha: state.sourceSha, dirty: state.sourceDirty })
      : (built ? `${sourceLabel(built.source)} (from dist/build-info.json — no deploy recorded it)` : 'not recorded');
    console.log(`commit  : ${commit}`);
    if (state.versionId) console.log(`version : ${state.versionId}`);

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