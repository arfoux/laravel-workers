// Port of the Auth0 authorization-code callback — exchanging a `code` for tokens
// at the edge.
//
// Route seam: registry.json → "ports": {
//   "POST /auth/auth0/callback": "auth0:callback",
// }
//
// What runs at the edge (parity with the Auth0 quickstart's `/callback`):
//   • the client sends { code } — the authorization code Auth0 redirected back
//     with (and optionally the `state` the app stashed);
//   • the handler POSTs the standard `authorization_code` grant to
//     `https://{AUTH0_DOMAIN}/oauth/token` with the client credentials and the
//     `redirect_uri` the authorize step used;
//   • returns Auth0's token response verbatim (`access_token`, `id_token`,
//     `refresh_token`, `expires_in`, `token_type`, `scope`).
// The downstream JWT verification (Auth0's RS256 `id_token` against
// `https://{AUTH0_DOMAIN}/.well-known/jwks.json`) is the same shape the
// firebase-php-jwt port implements — compose the two if you need offline verify
// here too; this handler stops at the token exchange, which is what `/callback`
// does.
//
// Config (env):
//   AUTH0_DOMAIN        (required, e.g. "dev-abc123.us.auth0.com")
//   AUTH0_CLIENT_ID     (required)
//   AUTH0_CLIENT_SECRET (required for a confidential client)
//   AUTH0_REDIRECT_URI  (required — must match the authorize call exactly)
//   AUTH0_AUDIENCE      (optional — the API identifier, sent as `audience`)
//
// Reuses `kernel/packages/notify-http.mjs` (`resolveFetch`, `formUrlEncoded`,
// `jsonPort`) so tests can inject a fake fetch. No D1 — the callback is a pure
// token exchange.
//
// Free tier: exactly 1 outbound subrequest per callback. The token response is
// never logged (it carries bearer credentials).

import { resolveFetch, jsonPort, formUrlEncoded } from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

function auth0Provider(env) {
  const domain = String(env.AUTH0_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!domain) throw new Error('AUTH0_DOMAIN is not configured');
  const clientId = env.AUTH0_CLIENT_ID;
  const clientSecret = env.AUTH0_CLIENT_SECRET;
  const redirectUri = env.AUTH0_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('AUTH0_CLIENT_ID / AUTH0_CLIENT_SECRET / AUTH0_REDIRECT_URI are not configured');
  }
  const base = `https://${domain}`;
  const provider = {
    tokenUrl: `${base}/oauth/token`,
    clientId,
    clientSecret,
    redirectUri,
  };
  if (env.AUTH0_AUDIENCE) provider.audience = String(env.AUTH0_AUDIENCE);
  return provider;
}

// POST /auth/auth0/callback — {code} → Auth0 token response
export async function handleCallback(ctx, env) {
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code) {
    return jsonPort({ error: 'invalid_request', message: 'The code field is required.' }, 400);
  }
  let provider;
  try {
    provider = auth0Provider(env);
  } catch (err) {
    return jsonPort({ error: 'server_configuration', message: String((err && err.message) || err) }, 500);
  }

  const fetchImpl = resolveFetch(env);
  const params = {
    grant_type: 'authorization_code',
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    redirect_uri: provider.redirectUri,
    code,
  };
  if (provider.audience) params.audience = provider.audience;

  let res;
  try {
    res = await fetchImpl(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: formUrlEncoded(params),
    });
  } catch (err) {
    return jsonPort({ error: 'provider_unreachable', message: String((err && err.message) || err) }, 502);
  }

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    // Surface Auth0's error/error_description (e.g. invalid_grant, unauthorized_client).
    return jsonPort(
      {
        error: (json && json.error) || 'invalid_grant',
        message: (json && (json.error_description || json.error)) || `token exchange failed (${res.status})`,
      },
      res.status === 400 || res.status === 401 ? 401 : 502,
    );
  }
  return jsonPort(json, 200);
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  if (ctx.method === 'POST') return handleCallback(ctx, env);
  return jsonPort({ message: `Unknown auth0 route (${ctx.method}).` }, 404);
}
