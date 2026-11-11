// Port of laravel/socialite's Sign in with Apple provider (AppleSocialite) —
// the CALLBACK half, handling Apple's `response_mode=form_post` redirect.
//
// Flow:
//   1. Apple POSTs an `application/x-www-form-urlencoded` body to this callback
//      carrying `code`, `id_token`, `user` (JSON string, first sign-in only),
//      and `state`.
//   2. We mint Apple's client secret (an ES256 JWT signed with the team's .p8
//      key — the actual credential Apple's token endpoint validates),
//   3. exchange the code at https://appleid.apple.com/auth/token,
//   4. decode the id_token and return the signed-in user: { id, email, name }.
//
// Config (env):
//   APPLE_TEAM_ID          (required — the 10-char team id, JWT `iss`)
//   APPLE_CLIENT_ID        (required — the service/bundle id, JWT `sub`)
//   APPLE_P8_PRIVATE_KEY   (required — the .p8 PKCS8 EC P-256 key, PEM or b64)
//   APPLE_KEY_ID           (optional — the 10-char key id, JWT header `kid`;
//                           Apple requires it for the secret exchange)
//   APPLE_REDIRECT_URI     (optional — must match the authorize call; Apple
//                           checks it on the token exchange)
//
// Body (ctx.body): { code, id_token, user } where `user` is a JSON string on
// first sign-in ({ name: { firstName, lastName }, email }) and absent on later
// ones — Apple never returns the name twice.
//
// Edge disclosure: NONE — one HTTPS `fetch` to Apple's token endpoint plus a
// WebCrypto ECDSA sign for the client secret; no socket, no key server. This is
// the substitute for socialite's AppleProvider token exchange. The id_token is
// DECODED here (the `sub`/`email` claims drive the user); offline signature
// verification is the JWKS path of the firebase-php-jwt port — compose that
// when you need it.

import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';
import { mintClientSecret, decodeIdToken, APPLE_TOKEN_URL } from '../../kernel/packages/apple.mjs';
import { resolveFetch, formUrlEncoded } from '../../kernel/packages/notify-http.mjs';

function json(status, payload) {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

// Apple's form body is urlencoded. normalizePortCtx surfaces the JSON bag only;
// `ctx.body` (the test/injected shape) already carries the fields as an object
// (or a raw urlencoded string). In production the kernel request's `input()`
// (which unions the parsed urlencoded post bag) holds them — reach it from the
// ORIGINAL request captured before normalization, then prefer the normalised
// body when it has the fields. Returns a flat object of form fields.
function readFormBody(ctx, originalRequest) {
  let fields = {};
  const body = ctx && ctx.body;
  if (body && typeof body === 'string') {
    fields = Object.fromEntries(new URLSearchParams(body));
  } else if (body && typeof body.get === 'function') {
    fields = Object.fromEntries(body.entries());
  } else if (body && typeof body === 'object') {
    fields = body;
  }
  if (Object.keys(fields).length === 0 && originalRequest) {
    if (typeof originalRequest.input === 'function') {
      const all = originalRequest.input();
      if (all && typeof all === 'object' && !Array.isArray(all)) fields = all;
    } else if (typeof originalRequest.json === 'function') {
      const j = originalRequest.json();
      if (j && typeof j === 'object' && !Array.isArray(j)) fields = j;
    }
  }
  return fields;
}

// Apple sends `user` as a JSON string on the FIRST sign-in only. Tolerate an
// already-parsed object (and garbage -> null).
function parseUser(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

// { name: { firstName, lastName } } -> "Ada Lovelace" (null when absent).
function fullName(userField) {
  const name = (userField && userField.name) || {};
  const first = typeof name.firstName === 'string' ? name.firstName : '';
  const last = typeof name.lastName === 'string' ? name.lastName : '';
  return first || last ? `${first} ${last}`.trim() : null;
}

// POST /auth/apple/callback — form_post callback -> { ok, user: { id, email, name } }
export async function handleCallback(ctx, env) {
  const originalRequest = ctx && ctx.request;
  ctx = normalizePortCtx(ctx);

  const teamId = String(env.APPLE_TEAM_ID || '');
  const clientId = String(env.APPLE_CLIENT_ID || '');
  const p8PrivateKey = env.APPLE_P8_PRIVATE_KEY || '';
  if (!teamId || !clientId || !p8PrivateKey) {
    return json(500, { error: 'Sign in with Apple is not configured (APPLE_TEAM_ID / APPLE_CLIENT_ID / APPLE_P8_PRIVATE_KEY)' });
  }

  const fields = readFormBody(ctx, originalRequest);
  const code = typeof fields.code === 'string' ? String(fields.code).trim() : '';
  if (!code) {
    return json(422, { error: 'no authorization code in the callback body' });
  }
  const idToken = typeof fields.id_token === 'string' ? String(fields.id_token).trim() : '';
  const userField = parseUser(fields.user);

  let clientSecret;
  try {
    const minted = await mintClientSecret({
      teamId,
      clientId,
      p8PrivateKey,
      keyId: env.APPLE_KEY_ID ? String(env.APPLE_KEY_ID) : '',
    });
    clientSecret = minted.assertion;
  } catch (err) {
    return json(500, { error: `failed to mint Apple client secret: ${String((err && err.message) || err)}` });
  }

  const params = {
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
  };
  if (env.APPLE_REDIRECT_URI) params.redirect_uri = String(env.APPLE_REDIRECT_URI);

  let res;
  try {
    res = await resolveFetch(env)(APPLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: formUrlEncoded(params),
    });
  } catch (err) {
    return json(502, { error: `Apple token endpoint unreachable: ${String((err && err.message) || err)}` });
  }

  let exchange = null;
  try {
    exchange = await res.json();
  } catch {
    exchange = null;
  }
  if (!res.ok || !exchange || !exchange.id_token) {
    const reason =
      (exchange && (exchange.error_description || exchange.error)) || `token exchange failed (${res.status})`;
    return json(res.ok ? 502 : 400, { error: String(reason) });
  }

  // Decode Apple's id_token: prefer the one Apple redirected with (the form
  // field), else the one the token endpoint returned — both are Apple's.
  let claims;
  try {
    claims = decodeIdToken(idToken || exchange.id_token);
  } catch (err) {
    return json(400, { error: `invalid id_token: ${String((err && err.message) || err)}` });
  }

  const user = {
    id: typeof claims.payload.sub === 'string' ? claims.payload.sub : '',
    email: typeof claims.payload.email === 'string' ? claims.payload.email : '',
    name: fullName(userField),
  };
  if (claims.payload.email_verified !== undefined) user.email_verified = Boolean(claims.payload.email_verified);
  if (claims.payload.is_private_email !== undefined) user.is_private_email = Boolean(claims.payload.is_private_email);

  return json(200, { ok: true, user });
}

export default async function handle(ctx, env) {
  return handleCallback(ctx, env);
}
