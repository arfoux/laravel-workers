// Port: flare-laravel — POST /flare/report.
//
// `spatie/laravel-flare` reports exceptions and log messages to the Flare
// error-tracking SaaS. On the classic path the PHP Flare client POSTs a JSON
// payload to:
//   POST https://flareapp.io/api/report
// with header `X-Flare-Key: {apiKey}` where the apiKey is `key:projectKey`
// (the `key` is the app secret, `projectKey` identifies the project).
//
// Edge disclosure: the report endpoint is a plain HTTPS JSON POST — 1:1 port,
// no socket/FFI involved. What the edge CANNOT do is the PHP client's local
// in-process capture of a real PHP stack trace (source code snippets, full
// request context, executed queries). Callers that have a stack (e.g. the
// compiled kernel's catch/error path) pass `stacktrace` as
// [{file, lineNumber, method}]; when absent we send a minimal single-frame
// trace so Flare still groups the report.
//
// Config (env): FLARE_KEY (required, app secret), FLARE_PROJECT_KEY (required).
// Payload (ctx.body): { errorClass (required), message?,
//                       stacktrace?: [{file, lineNumber, method}], metadata? }.
// Provider response is mapped 1:1 to {status, headers, body}.
import {
  resolveFetch,
  jsonPort,
  deliverVia,
  normaliseErrorReport,
} from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

const FLARE_URL = 'https://flareapp.io/api/report';

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const body = (ctx && ctx.body) || {};

  // `errorClass` (or Laravel's `error_class`) plus the coerced stack — a real
  // captured stack when the caller has one, otherwise a single minimal frame so
  // the report still groups. Both error-tracking ports share this rule.
  const { errorClass, stacktrace } = normaliseErrorReport(ctx);
  if (!errorClass) return jsonPort({ error: 'missing `errorClass`' }, 422);

  const flareKey = env && env.FLARE_KEY;
  const projectKey = env && env.FLARE_PROJECT_KEY;
  if (!flareKey) return jsonPort({ error: 'missing Flare credential: set FLARE_KEY' }, 500);
  if (!projectKey) return jsonPort({ error: 'missing Flare credential: set FLARE_PROJECT_KEY' }, 500);

  const doFetch = resolveFetch(env);
  const init = {
    method: 'POST',
    headers: {
      'x-flare-key': `${String(flareKey)}:${String(projectKey)}`,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify({
      errorClass,
      ...(body.message ? { message: String(body.message) } : {}),
      stacktrace,
      ...(body.metadata && typeof body.metadata === 'object'
        ? { metadata: body.metadata }
        : {}),
    }),
  };

  return deliverVia(doFetch, FLARE_URL, init);
}
