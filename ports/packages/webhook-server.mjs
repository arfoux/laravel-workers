import { normalizePortCtx, guardUserId } from '../../kernel/packages/port-ctx.mjs';
import { resolveFetch, mapProviderResponse, jsonPort } from '../../kernel/packages/notify-http.mjs';
import { hmacSha256Base64 as signPayload } from '../../kernel/hmac.mjs';

// ports/packages/webhook-server.mjs — port of spatie/laravel-webhook-server
// (the CLIENT side: signing + sending a webhook to a third-party endpoint).
//
// Parity target: the package's `WebhookCall` job signs the payload with
// `hash_hmac('sha256', payload, secret)` and sends it with a signature header;
// the receiving side (`VerifySignature` middleware) recomputes it. The package
// also stamps a timestamp header so receivers can reject stale calls.
// This port reproduces that outbound call on the edge:
//   signature = base64( HMAC-SHA256( secret, rawJsonBody ) )
//   headers   = { webhook-signature, webhook-timestamp, content-type }
//
// Edge notes:
//   - Laravel's default HTTP transport is a blocking Guzzle request; here it is
//     a Workers `fetch` subrequest (the only way out from the edge).
//   - Each call is recorded in a D1 `webhook_calls` table (url, payload,
//     signature, response status/body, error) so the package's "latest calls"
//     debugging surface stays available.
//
// Route wiring: registry.json → "ports": { "/webhook-server/send": "webhook-server" }
//
// POST /webhook-server/send { url, payload?, headers?, tags? }
//   → 201 { ok, call: { id, url, signature, response_status, response_body, ... } }
//   → 422 when `url` is missing/invalid (no subrequest spent)
//   → 500 when WEBHOOK_SERVER_SECRET is unset or the call throws

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS webhook_calls (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       uuid TEXT,
       url TEXT NOT NULL,
       payload TEXT,
       signature TEXT,
       headers TEXT,
       tags TEXT,
       response_status INTEGER,
       response_body TEXT,
       error TEXT,
       created_at TEXT NOT NULL
     )`
  ).run();
}

function nowIso() {
  return new Date().toISOString();
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    // The route IS the seam: Laravel's WebhookClient/Server send from app code
    // (`WebhookCall::dispatch()` in a job) using the app's signing secret. Exposed
    // anonymously, this URL is both an arbitrary-URL egress (SSRF-ish: any https
    // host) and a signing oracle over a secret the caller cannot read. App code
    // calls `signPayload()`/the module directly; the HTTP route needs a caller.
    if ((await guardUserId(ctx)) == null) return jsonPort({ message: 'Unauthenticated.' }, 401);
    const body = ctx.body || {};
    const url = body.url;

    if (!url || typeof url !== 'string' || !/^https:\/\//i.test(url)) {
      return jsonPort({ error: 'body.url (https) required' }, 422);
    }

    const secret = env && env.WEBHOOK_SERVER_SECRET;
    if (!secret) {
      return jsonPort({ error: 'WEBHOOK_SERVER_SECRET not configured' }, 500);
    }

    // Canonical JSON body — signed and sent verbatim so a receiver's
    // HMAC over the raw body matches byte-for-byte.
    const payload = body.payload == null ? {} : body.payload;
    const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);

    const signature = await signPayload(secret, rawBody);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const extraHeaders = body.headers && typeof body.headers === 'object' ? body.headers : {};
    const requestInit = {
      method: 'POST',
      headers: {
        // Caller extras first: the three canonical headers define the signed
        // contract the receiver verifies, so they always win (a caller-supplied
        // `webhook-signature` would else replace the real signature and make the
        // receiver accept an unsigned body).
        ...extraHeaders,
        'content-type': 'application/json',
        'webhook-signature': signature,
        'webhook-timestamp': timestamp,
      },
      body: rawBody,
    };

    const fetchImpl = resolveFetch(env);
    let resp;
    let error = null;
    try {
      resp = await fetchImpl(url, requestInit);
    } catch (err) {
      error = String((err && err.message) || err);
    }

    const mapped = resp ? await mapProviderResponse(resp) : { status: 0, headers: {}, body: '' };

    // Record the call (best-effort: a logging failure must not mask the result).
    let callId = null;
    try {
      await ensureSchema(env);
      const uuid = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      const tags = body.tags == null ? null : typeof body.tags === 'string' ? body.tags : JSON.stringify(body.tags);
      const res = await env.DB
        .prepare(
          `INSERT INTO webhook_calls
             (uuid, url, payload, signature, headers, tags, response_status, response_body, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          uuid,
          url,
          rawBody,
          signature,
          JSON.stringify(requestInit.headers),
          tags,
          mapped.status,
          mapped.body,
          error,
          nowIso()
        )
        .run();
      callId = res.last_row_id ?? res.meta?.last_row_id ?? null;
    } catch {
      /* logging is best-effort */
    }

    if (error) {
      return jsonPort(
        { ok: false, error, call: { id: callId, url, signature, response_status: 0 } },
        502
      );
    }

    return jsonPort(
      {
        ok: mapped.status >= 200 && mapped.status < 300,
        call: {
          id: callId,
          url,
          signature,
          response_status: mapped.status,
          response_body: mapped.body,
        },
      },
      mapped.status >= 200 && mapped.status < 300 ? 201 : 200
    );
  } catch (err) {
    return jsonPort({ error: String((err && err.message) || err) }, 500);
  }
}
