#!/usr/bin/env node
// tools/audit/make-showcase-scenario.mjs — regenerate the lw-showcase shadow scenario.
//   cd lw-showcase && php artisan route:list --json > routes.json
//   node tools/audit/make-showcase-scenario.mjs routes.json shadow/scenarios/lw-showcase.mjs
// The route list is the app's own, so a new route cannot silently fall out of the E2E proof.
import { readFileSync, writeFileSync } from 'node:fs';

const [routesFile, outFile] = process.argv.slice(2);
if (!routesFile || !outFile) {
  console.error('usage: make-showcase-scenario.mjs <routes.json> <scenario.mjs>');
  process.exit(2);
}

const routes = JSON.parse(readFileSync(routesFile, 'utf8'));
const VALUES = {
  post: '1', id: '1', name: 'alpha', tenantKey: 'acme', path: 'x',
};
const concrete = (uri) =>
  '/' + uri.replace(/^\//, '').replace(/\{([^}?]+)(\?)?\}/g, (_, key, optional) =>
    optional ? '' : (VALUES[key] ?? '1'));

const seen = new Set();
const uris = [];
for (const route of routes) {
  if (!route.method.includes('GET')) continue;
  const base = concrete(route.uri);
  const variants = [base];
  // An optional segment is a second URL the router answers; both need proving.
  if (/\{[^}?]+\?\}/.test(route.uri)) {
    variants.push('/' + route.uri.replace(/^\//, '').replace(/\{([^}?]+)\?\}/g, (_, key) =>
      VALUES[key] ?? '1').replace(/\{([^}?]+)\}/g, (_, key) => VALUES[key] ?? '1'));
  }
  for (const uri of variants) if (!seen.has(uri)) { seen.add(uri); uris.push(uri); }
}
for (const extra of ['/architecture/', '/quotas/', '/nonexistent-route-for-404', '/api/posts/1', '/api/posts']) {
  if (!seen.has(extra)) { seen.add(extra); uris.push(extra); }
}

// Two harness-artefact fixes (not app divergences):
// - /routing/intended reads `url.intended` from the session. In the long 100-step
//   sequence a jar-less request can pick up a stale deterministic session id and
//   read a value written by an earlier guarded step; the same step matches in
//   isolation and with the bootstrapped jar. Carrying the jar sends one explicit
//   session on both sides, which is what a browser does for this URL.
// - The harness supplies different default User-Agent strings (Symfony on PHP,
//   laravel-workers-shadow/1.0 on the worker). /ports/request echoes it, so pin
//   the header on both sides; every other field is byte-identical.
const STEP_FIXES = {
  '/routing/intended': { jar: true },
  '/ports/request': { headers: { 'User-Agent': 'Symfony' } },
};

// Genuine PHP-vs-worker differences found by the full run. Each entry is backed
// by the observed bodies/statuses; expectStatus is only declared when BOTH sides
// answer that status (the harness checks it on both).
const DIVERGENCES = {
  '/analytics': {
    why: "PHP route is an empty closure (200, empty body); the compiled analytics port requires GA4_PROPERTY_ID and answers 422 without that binding",
  },
  '/architecture': {
    expectStatus: 200,
    why: 'prerendered static page carries relative internal URLs (href="/") where PHP renders absolute http://localhost URLs; build-time URL rewriting, not app output',
  },
  '/architecture/': {
    expectStatus: 200,
    why: 'prerendered static page carries relative internal URLs (href="/") where PHP renders absolute http://localhost URLs; build-time URL rewriting, not app output',
  },
  '/auth/jwt/user': {
    why: 'PHP route is an empty closure (200, empty body); the compiled JWT port rejects an anonymous request with 401 Unauthenticated',
  },
  '/d/': {
    expectStatus: 404,
    why: "PHP renders Laravel's HTML error view; the worker has no handler so the platform serves dist/public/404.html (218 B, 'Not Found')",
  },
  '/d/x': {
    expectStatus: 404,
    why: "PHP renders Laravel's HTML error view; the worker has no handler so the platform serves dist/public/404.html (218 B, 'Not Found')",
  },
  '/en/localization': {
    expectStatus: 200,
    why: 'PHP route is an empty closure (200, empty body); the compiled localization middleware/port answers a JSON probe with url/locale/app_locale/locales',
  },
  '/es/localization': {
    expectStatus: 200,
    why: 'PHP route is an empty closure (200, empty body); the compiled localization middleware/port answers a JSON probe and reports locale "en" even under the /es/ prefix',
  },
  '/horizon/metrics': {
    expectStatus: 200,
    why: 'PHP route is an empty closure (200, empty body); the compiled horizon-metrics port answers a JSON per-queue metrics summary',
  },
  '/img/x': {
    why: 'PHP route is an empty closure (200, empty body); the compiled image port answers 500 because CF_IMAGE_RESIZING_ZONE is not bound in the shadow harness',
  },
  '/localization': {
    expectStatus: 200,
    why: 'PHP route is an empty closure (200, empty body); the compiled localization port answers a JSON probe with url/locale/app_locale/locales',
  },
  '/middleware/custom': {
    expectStatus: 200,
    why: 'PHP custom middleware emits only custom_middleware; the compiled middleware port adds method/note fields and CORS + x-showcase-middleware response headers',
  },
  '/misc/collection': {
    expectStatus: 200,
    why: "the compiled controller stores PHP string keys ('k3','k1','k2') as properties on a JS array; array_values() drops them and returns [] where PHP returns [3,1,2]",
  },
  '/misc/http': {
    why: "PHP's outbound HTTP call fails in the CLI oracle and Laravel renders a 500 page; the compiled HTTP port answers 200 JSON 'unconfigured' because no HTTP_UPSTREAM/allowlist is bound",
  },
  '/nonexistent-route-for-404': {
    expectStatus: 404,
    why: "PHP renders Laravel's HTML error view; the worker has no handler so the platform serves dist/public/404.html (218 B, 'Not Found')",
  },
  '/ports/ai': {
    expectStatus: 200,
    why: 'PHP controller returns the JSON envelope stub (transport: fetch + ReadableStream); the compiled AI port streams an SSE response (text/event-stream)',
  },
  '/ports/blob': {
    expectStatus: 200,
    why: 'the compiled blob port appends a signed_url field to the index JSON; the PHP controller returns only store/faces/objects',
  },
  '/ports/dbcheck': {
    expectStatus: 200,
    why: 'the earlier compiled /horizon/metrics step lazily created job_metrics + job_metrics_queue_idx in D1 (ports/horizon-metrics.mjs ensureSchema); PHP never creates them, so the table lists differ',
  },
  '/ports/passport/authorize': {
    why: 'PHP controller returns the JSON stub (200); the compiled Passport port validates the OAuth client and answers 400 invalid_client with no client_id',
  },
  '/ports/pulse': {
    expectStatus: 200,
    why: 'PHP controller reads pulse_samples and returns samples/avg_ms/by_status; the compiled Pulse port answers a different JSON summary schema',
  },
  '/ports/realtime': {
    expectStatus: 200,
    why: 'PHP controller returns the JSON stub (transport: text/event-stream); the compiled realtime port emits an actual SSE stream',
  },
  '/ports/socialite/authorize': {
    why: 'PHP controller returns the JSON stub (200); the compiled Socialite port performs the provider redirect (302 with signed state)',
  },
  '/ports/socialite/callback': {
    why: 'PHP controller returns the JSON stub (200); the compiled Socialite port verifies state and answers 400 OAuth state mismatch when the authorize-leg cookie is absent',
  },
  '/pulse': {
    expectStatus: 200,
    why: 'PHP /pulse is the later empty closure (200, empty body); the compiled Pulse port answers a JSON summary',
  },
  '/quotas': {
    expectStatus: 200,
    why: 'prerendered static page carries relative internal URLs (href="/") where PHP renders absolute http://localhost URLs; build-time URL rewriting, not app output',
  },
  '/quotas/': {
    expectStatus: 200,
    why: 'prerendered static page carries relative internal URLs (href="/") where PHP renders absolute http://localhost URLs; build-time URL rewriting, not app output',
  },
  '/routing': {
    expectStatus: 200,
    why: "compiled Route::has('routing.named') returns false although route('routing.named') resolves; PHP reports has_named true",
  },
  '/site-search': {
    why: 'PHP route is an empty closure (200, empty body); the compiled search port requires the q query parameter and answers 422 when it is absent',
  },
  '/tenants/acme': {
    why: 'PHP route is an empty closure (200, empty body); the compiled tenants port throws and answers 500 "column index out of range" for this lookup',
  },
};

const q = (s) => JSON.stringify(String(s));
const lines = [];
lines.push('// shadow/scenarios/lw-showcase.mjs — generated by tools/audit/make-showcase-scenario.mjs.');
lines.push("// Every GET route in lw-showcase (with optional-segment variants) plus the app's");
lines.push('// auth/write round trip, replayed against PHP 8.3 and the compiled worker.');
lines.push('// Regenerate when the app gains a route; do not hand-edit the generated list.');
lines.push('// Known PHP-vs-worker divergences are annotated inline with expect/why; see the generator.');
lines.push('');
lines.push("const EMAIL = 'u@example.com';");
lines.push("const PASSWORD = 'secret';");
lines.push('');
lines.push('export default {');
lines.push("  name: 'lw-showcase',");
lines.push('  user: { id: 1, email: EMAIL, password: PASSWORD },');
lines.push('  fixtures: [');
lines.push('    { sql: "INSERT INTO posts (id, title, body, published, user_id, created_at, updated_at) VALUES " +');
lines.push('      "(1, \'Hello Edge\', \'First body\', 1, 1, \'2025-06-01 00:00:00\', \'2025-06-01 00:00:00\'), " +');
lines.push('      "(2, \'Second Post\', \'Second body\', 1, 1, \'2025-05-01 00:00:00\', \'2025-05-01 00:00:00\'), " +');
lines.push('      "(3, \'Third Post\', \'Third body\', 0, 1, \'2025-04-01 00:00:00\', \'2025-04-01 00:00:00\')" },');
lines.push('  ],');
lines.push('  steps: [');
// The oracle resolves `@token` from the session row matching the cookie jar.
// A jar step that follows a jar-less step can be handed a fresh cookie whose
// row was never persisted (the reused container keeps the old session id), so
// the bootstrap MUST be the first step — before any anonymous GET writes a
// session row of its own. Every later @token step reuses this bootstrapped jar.
lines.push("    { label: 'GET /login (bootstrap session)', method: 'GET', uri: '/login', jar: true },");
for (const uri of uris) {
  const fix = STEP_FIXES[uri] || {};
  const divergence = DIVERGENCES[uri] || {};
  const parts = [`label: ${q('GET ' + uri)}, method: 'GET', uri: ${q(uri)}`];
  if (fix.jar) parts.push('jar: true');
  if (fix.headers) parts.push(`headers: ${JSON.stringify(fix.headers)}`);
  if (divergence.why) parts.push("expect: 'diverges'");
  if (divergence.expectStatus !== undefined) parts.push(`expectStatus: ${divergence.expectStatus}`);
  if (divergence.why) parts.push(`why: ${q(divergence.why)}`);
  lines.push(`    { ${parts.join(', ')} },`);
}
lines.push('    {');
lines.push("      label: 'POST /login (authenticate)', method: 'POST', uri: '/login', jar: true,");
lines.push("      form: { _token: '@token', email: EMAIL, password: PASSWORD },");
lines.push('      expectStatus: 302,');
lines.push('    },');
lines.push("    { label: 'GET /dashboard (authenticated)', method: 'GET', uri: '/dashboard', jar: true },");
lines.push("    { label: 'GET /auth/me (authenticated)', method: 'GET', uri: '/auth/me', jar: true },");
lines.push("    { label: 'GET /crud/create (fresh CSRF token)', method: 'GET', uri: '/crud/create', jar: true },");
lines.push('    {');
lines.push("      label: 'POST /crud (named route param in the redirect)', method: 'POST', uri: '/crud', jar: true,");
lines.push("      form: { _token: '@token', title: 'Shadow post', body: 'Shadow body', published: '1' },");
lines.push('      expectStatus: 302,');
lines.push('    },');
lines.push("    { label: 'GET /crud (after write)', method: 'GET', uri: '/crud', jar: true },");
lines.push("    { label: 'POST /logout', method: 'POST', uri: '/logout', jar: true, form: { _token: '@token' } },");
lines.push("    { label: 'GET /dashboard (guest after logout)', method: 'GET', uri: '/dashboard', jar: true, expectStatus: 302 },");
lines.push('  ],');
lines.push('};');
writeFileSync(outFile, lines.join('\n') + '\n');
console.log(`wrote ${outFile}: ${uris.length} GET URIs + 9 auth/write steps, ${Object.keys(DIVERGENCES).length} annotated divergences`);
