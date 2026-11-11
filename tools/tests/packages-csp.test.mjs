// tools/tests/packages-csp.test.mjs — spatie/laravel-csp port tests.
//
// Pure header-assembly: no network, no D1. We assert:
//   - buildCspHeader turns a policy object into the exact header VALUE string,
//   - a nonce is injected into script-src/style-src and changes per call,
//   - a blank/missing policy falls back to `default-src 'self'`,
//   - the middleware port stamps the CSP header and returns a fresh nonce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCspHeader, generateNonce, CSP_HEADER } from '../../kernel/packages/csp.mjs';
import cspMiddleware from '../../ports/packages/csp-middleware.mjs';

// ---- buildCspHeader -------------------------------------------------------

test('csp: builds a semicolon-joined header value from a policy object', () => {
  const value = buildCspHeader({
    'default-src': ["'self'"],
    'script-src': ["'self'", 'https://cdn.example.com'],
    'img-src': ["'self'", 'data:'],
  });
  assert.equal(typeof value, 'string');
  assert.ok(value.includes("default-src 'self'"));
  assert.ok(value.includes("script-src 'self' https://cdn.example.com"));
  assert.ok(value.includes("img-src 'self' data:"));
  // Directives are `; `-separated and each appears exactly once.
  assert.equal(value.split('; ').length, 3);
});

test('csp: directive order is stable (sorted) for deterministic output', () => {
  const a = buildCspHeader({ 'script-src': ["'self'"], 'default-src': ["'self'"] });
  const b = buildCspHeader({ 'default-src': ["'self'"], 'script-src': ["'self'"] });
  assert.equal(a, b);
  assert.ok(a.indexOf('default-src') < a.indexOf('script-src'));
});

test('csp: bare keyword sources are quoted, host sources stay bare', () => {
  const value = buildCspHeader({ 'default-src': ['self', 'https://x.test'] });
  assert.ok(value.includes("default-src 'self' https://x.test"));
});

// ---- nonce injection ------------------------------------------------------

test('csp: nonce is appended to script-src and style-src', () => {
  const value = buildCspHeader({ 'default-src': ["'self'"], 'script-src': ["'self'"] }, 'abc123');
  assert.ok(value.includes("script-src 'self' 'nonce-abc123'"));
  assert.ok(value.includes("style-src 'nonce-abc123'"));
});

test('csp: a nonce- prefixed token is accepted verbatim', () => {
  const value = buildCspHeader({ 'script-src': ["'self'"] }, 'nonce-xyz');
  assert.ok(value.includes("'nonce-xyz'"));
  // no double prefix
  assert.ok(!value.includes('nonce-nonce-'));
});

test('csp: nonce is added even when the directive was absent', () => {
  const value = buildCspHeader({ 'default-src': ["'self'"] }, 'n1');
  assert.ok(value.includes("script-src 'nonce-n1'"));
  assert.ok(value.includes("style-src 'nonce-n1'"));
});

test('csp: nonce is not duplicated when the policy already carries one', () => {
  const value = buildCspHeader({ 'script-src': ["'self'", "'nonce-n1'"] }, 'n1');
  const script = value.split('; ').find((d) => d.startsWith('script-src'));
  assert.equal(script.match(/'nonce-n1'/g).length, 1);
});

test('csp: generateNonce returns a fresh nonce- token each call', () => {
  const a = generateNonce();
  const b = generateNonce();
  assert.match(a, /^nonce-/);
  assert.match(b, /^nonce-/);
  assert.notEqual(a, b);
});

// ---- fallback -------------------------------------------------------------

test('csp: a missing policy falls back to default-src self', () => {
  assert.equal(buildCspHeader(undefined), "default-src 'self'");
  assert.equal(buildCspHeader(null), "default-src 'self'");
});

test('csp: an empty policy object falls back to default-src self', () => {
  assert.equal(buildCspHeader({}), "default-src 'self'");
});

test('csp: flag directives with no sources are emitted bare', () => {
  const value = buildCspHeader({ 'default-src': ["'self'"], 'upgrade-insecure-requests': true });
  assert.ok(value.includes('upgrade-insecure-requests'));
  assert.ok(value.includes("default-src 'self'"));
});

test('csp: exports the canonical header name', () => {
  assert.equal(CSP_HEADER, 'Content-Security-Policy');
});

// ---- middleware port ------------------------------------------------------

test('csp middleware: stamps the CSP header and returns a nonce', async () => {
  const res = await cspMiddleware({ body: { policy: { 'default-src': ["'self'"] } } }, {});
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  const csp = res.headers['content-security-policy'];
  const directives = Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d.slice(d.indexOf(' ') + 1)]));
  assert.equal(directives['default-src'], "'self'");
  assert.equal(directives['script-src'], `'nonce-${payload.nonce.slice(6)}'`);
  assert.equal(directives['style-src'], `'nonce-${payload.nonce.slice(6)}'`);
  assert.equal(payload.ok, true);
  assert.equal(payload.header, 'Content-Security-Policy');
  assert.match(payload.nonce, /^nonce-/);
});

test('csp middleware: nonce changes across requests', async () => {
  const a = await cspMiddleware({ body: {} }, {});
  const b = await cspMiddleware({ body: {} }, {});
  const na = JSON.parse(a.body).nonce;
  const nb = JSON.parse(b.body).nonce;
  assert.notEqual(na, nb);
  assert.notEqual(a.headers['content-security-policy'], b.headers['content-security-policy']);
});

test('csp middleware: reads a JSON-string policy from env', async () => {
  const res = await cspMiddleware(
    { body: {} },
    { CSP_POLICY: JSON.stringify({ 'default-src': ["'self'"], 'frame-ancestors': ["'none'"] }) }
  );
  const csp = res.headers['content-security-policy'];
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("default-src 'self'"));
});
