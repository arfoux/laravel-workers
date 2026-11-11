// Port: spatie/laravel-honeypot — Honeypot form-protection middleware (POST).
//
// Laravel's `Spatie\Honeypot` protects a form with two hidden fields (a NAME
// field a real user leaves empty, and a render TIMESTAMP field) and rejects the
// submit in its `ProtectAgainstSpam` middleware when the name field is filled
// OR the submit came back faster than a minimum time delta. Both checks are
// pure comparisons on the POST body — no socket, no crypto, no DB — so the
// guard ports 1:1 to a Worker as a POST handler.
//
// Edge disclosure: upstream encrypts the timestamp with the Laravel app key.
// The edge has no shared app key, so `kernel/packages/honeypot.mjs` carries the
// render time as base36 in the clear. This stops the naive fill-everything bot;
// it is NOT tamper-proof (a bot that reads the field can pre-age it). See the
// kernel header for the signing follow-up.
//
// Behaviour:
//   - POST: read the parsed body, run `validateHoneypot`, return 403 with the
//     failure reason when invalid (name filled / too fast / field missing),
//     else 200 { ok: true } (the pass-through a wrapping route continues from).
//   - Non-POST: nothing to protect — pass through 200 { ok: true, skipped: true }.
//
// Config (env): HONEYPOT_MIN_DELTA_MS — minimum elapsed ms (default 1000).
// Body (ctx.body): the submitted form fields, including the honeypot name field
//   (key starting `_hp_name_`) and the timestamp field `_hp_time`.
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';
import { validateHoneypot } from '../../kernel/packages/honeypot.mjs';
import { jsonPort } from '../../kernel/packages/notify-http.mjs';

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const method = String(ctx.method || 'GET').toUpperCase();

  // A honeypot guards a form POST; other verbs have no submit to check.
  if (method !== 'POST') {
    return jsonPort({ ok: true, skipped: true }, 200);
  }

  const body = ctx.body || {};
  const envMin = env && Number(env.HONEYPOT_MIN_DELTA_MS);
  const minDeltaMs = Number.isFinite(envMin) ? envMin : 1000;

  const result = validateHoneypot(body, minDeltaMs);

  if (!result.valid) {
    return jsonPort(
      { ok: false, error: 'honeypot', reason: result.reason },
      403
    );
  }

  return jsonPort({ ok: true }, 200);
}