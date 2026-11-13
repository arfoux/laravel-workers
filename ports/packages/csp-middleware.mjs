// Port: spatie/laravel-csp — CSP middleware (applies a Content-Security-Policy
// header to a response and exposes the per-response nonce).
//
// In Laravel, `spatie/laravel-csp` runs as HTTP middleware: the policy class
// produces the directive list, the package generates a per-response nonce,
// injects `'nonce-…'` into the inline `<script>`/`<style>` directives and stamps
// the resulting header onto the response.
//
// On the edge we can't run the PHP policy class, so the policy arrives as a
// compiled CONFIG DUMP in `ctx.body.policy` (or `env.CSP_POLICY` as a JSON
// string / object) — the same shape `buildCspHeader` consumes. The nonce is
// generated HERE per request, which matches Laravel's per-response semantics.
//
// What the port returns is the header SET a downstream compiled-view handler
// needs: the CSP header value plus the nonce so the view can emit
// `<script nonce="…">`. It does NOT render HTML itself — that is the view port's
// job; this port is the header/nonce authority.
//
// Edge disclosure: no PHP execution, no disk, no long-running work — pure header
// assembly, well within Workers limits.
import { normalizePortCtx, jsonResponse } from '../../kernel/packages/port-ctx.mjs';
import { buildCspHeader, generateNonce, CSP_HEADER } from '../../kernel/packages/csp.mjs';

/** Read the policy object from ctx.body / env, tolerating a JSON-string dump. */
function resolvePolicy(ctx, env) {
  const fromBody = ctx && ctx.body && ctx.body.policy;
  if (fromBody !== undefined) {
    if (typeof fromBody === 'string') {
      try {
        return JSON.parse(fromBody);
      } catch {
        return undefined;
      }
    }
    return fromBody;
  }
  const fromEnv = env && env.CSP_POLICY;
  if (typeof fromEnv === 'string') {
    try {
      return JSON.parse(fromEnv);
    } catch {
      return undefined;
    }
  }
  return fromEnv;
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);

  const policy = resolvePolicy(ctx, env);
  const nonce = generateNonce();
  const headerValue = buildCspHeader(policy, nonce);

  // The header metadata a view port reads to stamp onto its own response.
  return jsonResponse(
    200,
    {
      ok: true,
      header: CSP_HEADER,
      'content-security-policy': headerValue,
      nonce,
    },
    { headers: { 'content-security-policy': headerValue } }
  );
}
