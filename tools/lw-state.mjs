#!/usr/bin/env node
// tools/lw-state.mjs — persistent deploy state for a Laravel app.
//
// <app>/lw-state.json — read by deploy / status / doctor; written by deploy.
//
// Schema version 1 shape:
// {
//   "schemaVersion": 1,
//   "account": {
//     "id": null | "<32-hex Cloudflare account id>",
//     "name": null | "<account name>",
//     "email": null | "<login email>"
//   },
//   "deployedAt": null | "<ISO timestamp>",
//   "workerName": null | "<worker-name>",
//   "workerUrl": null | "https://<worker>.<account>.workers.dev",
//   "d1": {
//     "binding": "DB",
//     "databaseName": null | "<db-name>",
//     "databaseId": null | "<uuid>",
//     "schemaAppliedAt": null | "<ISO timestamp>",
//     "schemaHash": null | "<sha256 of dist/schema.sql>"
//   }
// }
//
// Consumers import this module. deploy, status, doctor, and writeState() use
// strict mode so a damaged state file can never be mistaken for "no deployed
// state" and silently replaced; readState() can opt out for read-only callers.
//
// Validation is structural: field *types*, the schemaVersion, and the
// account.id's 32-hex shape. The `<uuid>`, `<ISO timestamp>` and `<sha256>`
// values documented above are not format-checked, so a hand-edited file is
// trusted for their exact contents (the deploy flow writes them from wrangler
// and its own hash, so in practice they are well-formed).

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATE_FILE = 'lw-state.json';
export const SCHEMA_VERSION = 1;

/** Default empty state matching the current schema. */
const EMPTY = () => ({
  schemaVersion: SCHEMA_VERSION,
  account: {
    id: null,
    name: null,
    email: null,
  },
  deployedAt: null,
  workerName: null,
  workerUrl: null,
  d1: {
    binding: 'DB',
    databaseName: null,
    databaseId: null,
    schemaAppliedAt: null,
    schemaHash: null,
  },
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

const TOP_LEVEL_STRINGS = ['deployedAt', 'workerName', 'workerUrl'];
const ACCOUNT_STRINGS = ['id', 'name', 'email'];
const D1_STRINGS = ['binding', 'databaseName', 'databaseId', 'schemaAppliedAt', 'schemaHash'];
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

function invalidStringField(object, keys) {
  return keys.find((key) => key in object && !isNullableString(object[key])) || null;
}

/** Return a human-readable schema/type problem, or null when the state is valid. */
function stateProblem(value) {
  if (!isPlainObject(value)) return 'is not a JSON object';
  if (value.schemaVersion !== undefined && value.schemaVersion !== SCHEMA_VERSION) {
    return `uses unsupported schemaVersion ${value.schemaVersion} (expected ${SCHEMA_VERSION})`;
  }
  if (value.account !== undefined && !isPlainObject(value.account)) {
    return 'has an invalid "account" object';
  }
  if (value.d1 !== undefined && !isPlainObject(value.d1)) return 'has an invalid "d1" object';
  const topLevelBad = invalidStringField(value, TOP_LEVEL_STRINGS);
  if (topLevelBad) return `has an invalid "${topLevelBad}" value`;
  if (value.account) {
    const accountBad = invalidStringField(value.account, ACCOUNT_STRINGS);
    if (accountBad) return `has an invalid "account.${accountBad}" value`;
    if (value.account.id !== null && value.account.id !== undefined
      && !ACCOUNT_ID.test(String(value.account.id).trim())) {
      return 'has an invalid "account.id" value';
    }
  }
  if (value.d1) {
    const d1Bad = invalidStringField(value.d1, D1_STRINGS);
    if (d1Bad) return `has an invalid "d1.${d1Bad}" value`;
  }
  return null;
}

class StateError extends Error {}

/**
 * Read the state file at appRoot.
 *
 * In strict mode a present-but-damaged file throws: deploy, status, and doctor
 * must stop rather than forget which D1/worker the app is attached to.
 * Non-strict mode is only for callers that explicitly want a blank fallback.
 *
 * @param {string} appRoot - Laravel app root (the directory containing artisan)
 * @param {{strict?: boolean}} [options]
 */
export function readState(appRoot, { strict = false } = {}) {
  const path = join(appRoot, STATE_FILE);
  if (!existsSync(path)) return EMPTY();

  const bad = (message) => {
    if (strict) throw new StateError(`${STATE_FILE} ${message}`);
    return EMPTY();
  };

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const problem = stateProblem(parsed);
    if (problem) return bad(problem);
    const empty = EMPTY();
    const account = { ...empty.account, ...(parsed.account || {}) };
    if (account.id) account.id = String(account.id).trim().toLowerCase();
    return {
      ...empty,
      ...parsed,
      account,
      d1: { ...empty.d1, ...(parsed.d1 || {}) },
    };
  } catch (e) {
    if (e instanceof StateError) throw e;
    if (strict) throw new Error(`could not read ${STATE_FILE}: ${e.message}`);
    return EMPTY();
  }
}

/**
 * Merge patch into the state file (read-modify-write, atomic rename).
 *
 * Strict read is intentional: a corrupt file is a stopped deploy, not a blank
 * slate that would lose the recorded D1/worker. Patch values are merged, so a
 * caller that wants to preserve a field simply omits it (or starts from
 * readState()).
 *
 * @param {string} appRoot - Laravel app root
 * @param {object} patch - shallow partial state to merge
 */
export function writeState(appRoot, patch) {
  const path = join(appRoot, STATE_FILE);
  const current = readState(appRoot, { strict: true });
  const next = {
    ...current,
    ...patch,
    account: {
      ...current.account,
      ...(isPlainObject(patch && patch.account) ? patch.account : {}),
    },
    d1: { ...current.d1, ...(isPlainObject(patch && patch.d1) ? patch.d1 : {}) },
  };
  if (next.account.id) next.account.id = String(next.account.id).trim().toLowerCase();
  const problem = stateProblem(next);
  if (problem) throw new Error(`refusing to write ${STATE_FILE}: it ${problem}`);
  const tmp = path + '.tmp.' + process.pid + '.' + Date.now() + '.'
    + Math.random().toString(36).slice(2, 8) + '.json';
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch { /* ignore */ }
    throw e;
  }
}
