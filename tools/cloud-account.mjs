#!/usr/bin/env node
// tools/cloud-account.mjs — decide which Cloudflare account a deploy targets.
//
// `wrangler` can be logged in to more than one account, and ids are the only
// stable identity: an email alias or an account rename must not look like a
// different account. This module turns `wrangler whoami` into that one id.
//
// Wrangler 4 supports `whoami --json`; Wrangler 3 rejects `--json`, so the
// human table is parsed as a fallback. The table parser strips ANSI escapes and
// expects the 32-hex account id in the last meaningful cell of a row.

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

export function stripAnsi(value) {
  return String(value ?? '').replace(ANSI, '');
}

/** Normalise a Cloudflare account id, or return null when it is not one. */
export function normalizeAccountId(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return ACCOUNT_ID.test(text) ? text : null;
}

function cleanDetail(value) {
  return stripAnsi(value).trim().replace(/\s+/g, ' ').slice(0, 400);
}

function accountName(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Parse `wrangler whoami --json`. Returns null when the text is not a
 * logged-in JSON response. Extra Wrangler banners before/after the JSON are
 * tolerated.
 */
export function parseWhoamiJson(text) {
  const clean = stripAnsi(text);
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let data;
  try {
    data = JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  const accounts = (Array.isArray(data.accounts) ? data.accounts : [])
    .map((entry) => {
      const id = normalizeAccountId(entry && entry.id);
      return id ? { id, name: accountName(entry.name) } : null;
    })
    .filter(Boolean);
  const email = accountName(data.email);
  // An explicit logged-out response is never an identity, even if a stale
  // email or account list is still cached next to it.
  if (data.loggedIn === false) return null;
  if (data.loggedIn !== true && !email && accounts.length === 0) return null;

  return { email, accounts, source: 'json' };
}

/**
 * Parse the human-readable `wrangler whoami` table. Returns null when there is
 * neither an email line nor an account row.
 */
export function parseWhoamiTable(text) {
  const clean = stripAnsi(text);
  const emailMatch = clean.match(/associated with the email\s+([^\s,]+)/i);
  const accounts = [];

  for (const line of clean.split(/\r?\n/)) {
    const cells = line.split(/[│|]/).map((cell) => cell.trim());
    for (let i = 0; i < cells.length - 1; i++) {
      const id = normalizeAccountId(cells[i + 1]);
      if (!id) continue;
      const name = cells[i].replace(/^[•\s]+|[•\s]+$/g, '').trim() || null;
      if (!accounts.some((entry) => entry.id === id)) accounts.push({ id, name });
      break;
    }
  }

  if (!emailMatch && accounts.length === 0) return null;
  return {
    email: emailMatch ? emailMatch[1].replace(/[.,;!]+$/, '') : null,
    accounts,
    source: 'table',
  };
}

/** Parse either supported `wrangler whoami` output shape. */
export function parseWhoamiOutput(text) {
  return parseWhoamiJson(text) || parseWhoamiTable(text);
}

/**
 * Run `wrangler whoami --json`, then the table form when that is unsupported
 * or unparseable. `runWhoami(args)` must return the runCapture() shape:
 * { error, status, stdout, stderr }.
 */
export function readCloudIdentity(runWhoami) {
  let last = null;
  for (const args of [['whoami', '--json'], ['whoami']]) {
    let result;
    try {
      result = runWhoami(args);
    } catch (e) {
      last = e && e.message ? e.message : String(e);
      continue;
    }
    if (result && result.error) {
      last = result.error.message || String(result.error);
      continue;
    }
    if (!result || result.status !== 0) {
      last = cleanDetail((result && (result.stderr || result.stdout))
        || `wrangler ${args.join(' ')} exited ${result && result.status}`);
      continue;
    }
    const identity = parseWhoamiOutput(`${result.stdout || ''}\n${result.stderr || ''}`);
    if (identity) return { identity };
    last = `could not parse \`wrangler ${args.join(' ')}\` output`;
  }
  return {
    error: cleanDetail(last) || 'could not read `wrangler whoami` output',
    code: 1,
  };
}

/**
 * Pick the account Wrangler will use. Precedence mirrors Wrangler:
 * wrangler.jsonc `account_id`, then CLOUDFLARE_ACCOUNT_ID, then the only
 * authenticated account. Multiple accounts are never guessed.
 */
export function selectAccount(identity, { configAccountId, envAccountId } = {}) {
  const accounts = Array.isArray(identity && identity.accounts) ? identity.accounts : [];
  const email = accountName(identity && identity.email);
  const configured = configAccountId === undefined || configAccountId === null
    ? null
    : String(configAccountId).trim();
  const fromEnv = envAccountId === undefined || envAccountId === null
    ? null
    : String(envAccountId).trim();

  let selected = null;
  // A config pin is authoritative, so any provided-but-invalid value —
  // including an empty string — fails closed instead of falling through to
  // the env or whoami. (An empty CLOUDFLARE_ACCOUNT_ID stays "unset",
  // mirroring Wrangler's env || undefined handling.)
  if (configured !== null) {
    const id = normalizeAccountId(configured);
    if (!id) {
      return {
        error: `wrangler.jsonc account_id "${configured}" is not a 32-character Cloudflare account ID`,
        code: 2,
      };
    }
    selected = { id, source: 'config' };
  } else if (fromEnv) {
    const id = normalizeAccountId(fromEnv);
    if (!id) {
      return {
        error: `CLOUDFLARE_ACCOUNT_ID "${fromEnv}" is not a 32-character Cloudflare account ID`,
        code: 2,
      };
    }
    selected = { id, source: 'env' };
  } else if (accounts.length === 1) {
    selected = { id: accounts[0].id, source: 'only' };
  } else if (accounts.length === 0) {
    return {
      error: 'could not determine the Cloudflare account from `wrangler whoami`',
      code: 2,
    };
  } else {
    return {
      error: `wrangler is authenticated to ${accounts.length} Cloudflare accounts; set CLOUDFLARE_ACCOUNT_ID or wrangler.jsonc account_id to choose one`,
      code: 2,
    };
  }

  const hit = accounts.find((entry) => entry.id === selected.id) || null;
  if (accounts.length && !hit) {
    const label = selected.source === 'config' ? 'wrangler.jsonc account_id' : 'CLOUDFLARE_ACCOUNT_ID';
    return {
      error: `${label} "${selected.id}" is not one of the accounts returned by \`wrangler whoami\``,
      code: 2,
    };
  }

  return {
    id: selected.id,
    name: hit ? hit.name : null,
    email,
    source: selected.source,
  };
}

/** Human-readable account label; the id is always present. */
export function accountLabel(account) {
  if (!account) return '(unknown account)';
  const id = normalizeAccountId(account.id) || String(account.id || '');
  const name = accountName(account.name) || accountName(account.email);
  return name ? `"${name}" (${id})` : id;
}

/** True when two account records point at the same Cloudflare account id. */
export function sameAccount(a, b) {
  const left = normalizeAccountId(a && a.id);
  const right = normalizeAccountId(b && b.id);
  return Boolean(left && right && left === right);
}
