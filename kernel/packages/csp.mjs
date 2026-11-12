// kernel/packages/csp.mjs — spatie/laravel-csp port (header builder).
//
// Laravel's `spatie/laravel-csp` assembles a `Content-Security-Policy` header
// from a policy class: a set of directives (`default-src`, `script-src`, …),
// each a list of sources, plus per-directive extras like `'self'`, `'unsafe-inline'`
// and — the part that matters on the edge — a per-response `nonce`.
//
// This module reproduces ONLY the header assembly, which is pure string work and
// needs no PHP runtime. Two entry points:
//
//   - `buildCspHeader(policy, nonce)` — the deterministic core. Takes a policy
//     object (`{ 'default-src': [...], 'script-src': [...] }`) and an optional
//     nonce and returns the exact header VALUE string (no header name). Sources
//     that already carry their own quoting (`'self'`, `'unsafe-inline'`,
//     `'nonce-…'`) are passed through verbatim; bare sources are quoted the way
//     CSP expects (scheme/host stay bare, keywords stay as given).
//   - `generateNonce()` — a fresh `nonce-<uuid>` token, the edge equivalent of
//     Laravel's `Str::random()`-backed nonce.
//
// Edge disclosure: the Worker CANNOT run the Laravel policy CLASS (it is PHP),
// so the policy arrives as a compiled CONFIG DUMP (the same shape the policy
// class's `getDirectives()` would produce). The nonce is generated per-request
// here because Laravel generates it per-response in middleware — same semantics,
// different runtime.
//
// Directive order is stable (sorted by name) so the header is deterministic for
// a given policy + nonce, which makes caching and tests predictable.

import { bytesToHex } from '../digest.mjs';

/** A fresh per-response nonce in the CSP `nonce-<value>` form. */
export function generateNonce() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `nonce-${c.randomUUID()}`;
  // Fallback for runtimes without crypto.randomUUID (older Workers / Node 14).
  const bytes =
    c && typeof c.getRandomValues === 'function'
      ? Array.from(c.getRandomValues(new Uint8Array(16)))
      : Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  const hex = bytesToHex(bytes);
  return `nonce-${hex}`;
}

/** Token sources that CSP defines already-quoted — emit verbatim, never re-quote. */
const KEYWORD_SOURCES = new Set([
  "'self'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'unsafe-hashes'",
  "'none'",
  "'strict-dynamic'",
  "'report-sample'",
  "'wasm-unsafe-eval'",
]);

/** Quote a single source the way a directive list expects. */
function quoteSource(source) {
  const s = String(source).trim();
  if (!s) return '';
  // Already-quoted keyword or an explicit nonce/hash: pass through untouched.
  if (KEYWORD_SOURCES.has(s) || /^'(nonce|sha\d+)-/.test(s)) return s;
  // A bare keyword the caller wrote without quotes (self/none/unsafe-inline…).
  if (/^(self|none|unsafe-inline|unsafe-eval|strict-dynamic|report-sample)$/.test(s)) return `'${s}'`;
  // Otherwise it is a scheme / host / path source — CSP wants it bare.
  return s;
}

/** Compose one directive's value string from its sources + optional extras. */
function directiveValue(directive) {
  const sources = Array.isArray(directive) ? directive : [directive];
  const rendered = sources.map(quoteSource).filter(Boolean);
  return rendered.join(' ');
}

/**
 * Build the `Content-Security-Policy` header VALUE from a policy object.
 *
 * @param {Record<string, string|string[]|true>} policy
 *   `{ 'default-src': ["'self'", 'https://cdn.example.com'], ... }`. A directive
 *   whose value is `true` (or an empty array) is emitted as a flag with no
 *   sources (e.g. `upgrade-insecure-requests`, `block-all-mixed-content`).
 * @param {string} [nonce]
 *   A CSP nonce token (with or without the `nonce-` prefix). When given it is
 *   appended to `script-src` and `style-src` (the two directives that carry
 *   inline nonces in Laravel) unless the policy already provides one.
 * @returns {string} the header value, directives joined by `; `.
 */
export function buildCspHeader(policy, nonce) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    // spatie's default posture for a blank policy is `default-src 'self'`.
    policy = { 'default-src': ["'self'"] };
  }

  const directives = {};
  for (const [rawName, rawValue] of Object.entries(policy)) {
    const name = String(rawName).trim().toLowerCase();
    if (!name) continue;
    if (rawValue === true || rawValue === '') {
      directives[name] = '';
      continue;
    }
    directives[name] = directiveValue(rawValue);
  }

  // Inject the per-response nonce into the two inline-execution directives.
  if (nonce) {
    const token = String(nonce).startsWith('nonce-') ? `'${String(nonce)}'` : `'nonce-${String(nonce)}'`;
    for (const name of ['script-src', 'style-src']) {
      const current = directives[name];
      if (current === undefined) directives[name] = token;
      else if (current !== '' && !current.includes(token)) directives[name] = `${current} ${token}`;
    }
  }

  const parts = [];
  for (const name of Object.keys(directives).sort()) {
    const value = directives[name];
    parts.push(value ? `${name} ${value}` : name);
  }

  if (parts.length === 0) return "default-src 'self'";
  return parts.join('; ');
}

/** The header NAME this module produces a value for. */
export const CSP_HEADER = 'Content-Security-Policy';
