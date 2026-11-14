// Port of laravel/socialite v5.31.0 - the CALLBACK half: verify state, exchange
// the code for tokens, fetch the user, and log them in (JSON session payload).
//
// GET /auth/{provider}/callback?code=..&state=..
// Laravel flow: `$user = Socialite::driver($p)->user();` = verify state, POST
// the code to the token endpoint, GET the user-info endpoint, mapUser. We keep
// exactly that shape (oauth.mjs) and mint a personal access token (token.mjs)
// so the login is end-to-end real: a bearer token the client can present.
//
// fetchImpl is injectable (ctx.fetchImpl || env.fetchImpl || globalThis.fetch)
// so tests can stub the token + user-info round trips.
//
// D1 schema: users table (upsert by provider identity) + token rows from the
// token primitive's caller. This handler only upserts users.
//   CREATE TABLE IF NOT EXISTS users (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     provider TEXT NOT NULL,
//     provider_id TEXT NOT NULL,
//     name TEXT, email TEXT, avatar TEXT,
//     UNIQUE (provider, provider_id)
//   );

import { verifyState, exchangeCode, fetchUser } from '../../kernel/packages/oauth.mjs';
import { resolveProvider, readStateCookie, consumeState } from '../../kernel/packages/socialite.mjs';
import { resolveProviderExtra } from '../../kernel/packages/socialite-providers.mjs';
import { createPersonalAccessToken, ensurePersonalAccessTokens } from '../../kernel/packages/token.mjs';
import { normalizePortCtx, jsonResponse } from '../../kernel/packages/port-ctx.mjs';

export async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      name TEXT,
      email TEXT,
      avatar TEXT,
      UNIQUE (provider, provider_id)
    )`
  ).run();
  // Sanctum's token table (so the minted bearer can be verified later) — the
  // SAME statement `sanctum.mjs` runs, and it lives once in
  // kernel/packages/token.mjs for exactly that reason: `CREATE TABLE IF NOT
  // EXISTS` means the first port to provision it decides the columns for the
  // other, and a copy here that dropped `created_at`/`updated_at` once made
  // sanctum's own INSERT fail (docs/D1-SCHEMA.md, "Settled elsewhere").
  await ensurePersonalAccessTokens(env);
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const providerName = String(ctx.params && ctx.params.provider);
  // Same order as the redirect half: Laravel's own set first, the extra
  // shape-only providers second.
  const provider = resolveProvider(env, providerName) || resolveProviderExtra(env, providerName);
  if (!provider) {
    return jsonResponse(400, { error: 'unknown or unconfigured provider' }, { noStore: false });
  }

  const query = ctx.query || {};
  const url = new URL(ctx.request.url);
  const code = query.code || url.searchParams.get('code') || '';
  const state = query.state || url.searchParams.get('state') || '';

  // 1) verify state: match against the cookie OR a stored row (either proves
  //    we initiated the flow). Constant-time (verifyState).
  const cookieState = readStateCookie(ctx);
  let stateOk = verifyState(cookieState, state);
  if (!stateOk) stateOk = await consumeState(env, state);
  if (!state || !stateOk) {
    return jsonResponse(401, { error: 'invalid state' }, { noStore: false });
  }

  const doFetch = ctx.fetchImpl || env.fetchImpl || globalThis.fetch;

  try {
    await ensureSchema(env);
    // 2) code -> tokens
    const token = await exchangeCode(provider, code, doFetch);
    // 3) tokens -> user profile (mapped like Socialite's mapUserToObject)
    const profile = await fetchUser(provider, token.access_token, doFetch);

    // 4) upsert the user by (provider, provider_id)
    const providerId = String(profile.id);
    await env.DB.prepare(
      `INSERT INTO users (provider, provider_id, name, email, avatar)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(provider, provider_id) DO UPDATE SET
         name = excluded.name, email = excluded.email, avatar = excluded.avatar`
    ).bind(providerName, providerId, profile.name || null, profile.email || null, profile.avatar || null).run();

    const user = await env.DB.prepare(
      'SELECT id, provider, provider_id, name, email, avatar FROM users WHERE provider = ?1 AND provider_id = ?2'
    ).bind(providerName, providerId).first();

    // 5) mint + persist a bearer token (login). randomBytes injectable for tests.
    const { plain, row } = await createPersonalAccessToken(user.id, `${providerName}-login`, ['*'], {
      randomBytes: ctx.randomBytes || env.randomBytes,
    });
    await env.DB.prepare(
      `INSERT INTO personal_access_tokens
        (tokenable_type, tokenable_id, name, token, abilities) VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(row.tokenable_type, row.tokenable_id, row.name, row.token, row.abilities).run();

    return jsonResponse(200, {
      user,
      access_token: plain,
      token_id: row.tokenable_id,
    });
  } catch (err) {
    return jsonResponse(502, { error: String((err && err.message) || err) }, { noStore: false });
  }
}
