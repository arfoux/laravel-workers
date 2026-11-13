// Port: bugsnag-laravel — POST /bugsnag/notify.
//
// `bugsnag/bugsnag-laravel` reports unhandled exceptions to the Bugsnag
// notify API. The package ships a default `Bugsnag` client that, over the
// classic (non-serverless) path, posts to:
//   POST https://notify.bugsnag.com/events
// with header `Bugsnag-Api-Key: {apiKey}` and a JSON body:
//   { apiKey, notifier: {...}, events: [{ exceptions: [{ errorClass,
//       message, stacktrace: [{ file, lineNumber, method }] }] }] }.
//
// Edge disclosure: the notify endpoint is a plain HTTPS JSON POST — 1:1 port,
// no socket/FFI involved. What the edge CANNOT do is the PHP client's local
// in-process capture of a real PHP stack trace (function args, code snippet,
// loaded-file list). Callers that have a stack (e.g. the compiled kernel's
// catch/error path) pass `stacktrace` as [{file, lineNumber, method}]; when
// absent we send a minimal single-frame trace so Bugsnag still groups the event.
//
// Config (env): BUGSNAG_API_KEY (required).
// Payload (ctx.body): { errorClass (required), message (required),
//                       stacktrace?: [{file, lineNumber, method}], appVersion?, releaseStage? }.
// Provider response is mapped 1:1 to {status, headers, body}.
import {
  resolveFetch,
  jsonPort,
  deliverVia,
  normaliseErrorReport,
} from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

const BUGSNAG_URL = 'https://notify.bugsnag.com/events';

const NOTIFIER = {
  name: 'Bugsnag JS (Laravel Workers port)',
  version: '1.0.0',
  url: 'https://github.com/bugsnag/bugsnag-laravel',
};

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const body = (ctx && ctx.body) || {};

  // `errorClass` (or Laravel's `error_class`) plus the coerced stack — a real
  // captured stack when the caller has one, otherwise a single minimal frame so
  // the event still groups. Both error-tracking ports share this rule.
  const { errorClass, stacktrace } = normaliseErrorReport(ctx);
  const message = body.message;
  if (!errorClass) return jsonPort({ error: 'missing `errorClass`' }, 422);
  if (!message) return jsonPort({ error: 'missing `message`' }, 422);

  const apiKey = env && env.BUGSNAG_API_KEY;
  if (!apiKey) return jsonPort({ error: 'missing Bugsnag credential: set BUGSNAG_API_KEY' }, 500);

  const doFetch = resolveFetch(env);
  const init = {
    method: 'POST',
    headers: {
      'bugsnag-api-key': String(apiKey),
      'bugsnag-payload-version': '4',
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify({
      apiKey,
      notifier: NOTIFIER,
      events: [
        {
          exceptions: [{ errorClass, message, stacktrace }],
          ...(body.appVersion ? { app: { version: String(body.appVersion) } } : {}),
          ...(body.releaseStage ? { releaseStage: String(body.releaseStage) } : {}),
          unhandled: body.unhandled !== false,
        },
      ],
    }),
  };

  return deliverVia(doFetch, BUGSNAG_URL, init);
}
