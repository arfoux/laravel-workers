// kernel/packages/socialite.mjs — cluster-E (DATA & EXPORT) glue for the
// Socialite port: resolve a provider's config from env, mint a state nonce, and
// read/write the state cookie. The actual OAuth steps (authorizeUrl /
// verifyState / exchangeCode / fetchUser) live in `oauth.mjs` and are used
// as-is by the two handler modules (redirect + callback).
//
// Parity target: laravel/socialite v5.31.0 builds the redirect URL and stores
// the `state` in the session, then verifies it on the callback. Workers have no
// PHP session; we carry `state` in a signed-by-randomness cookie AND a
// `lw_oauth_state` D1 row so the callback can check either (defense in depth).

import { randomString } from './token.mjs';

// Provider config straight from the env binding. Callers must set:
//   env.<PROVIDER>_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI
//   (optional) env.<PROVIDER>_SCOPES  — space-separated
// e.g. env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, env.GITHUB_REDIRECT_URI.
// The provider *shape* (authUrl / tokenUrl / userUrl / mapUser) is code-side;
// only credentials come from env, so secrets never appear in the repo.
export function resolveProvider(env, name) {
  const upper = String(name).toUpperCase();
  const clientId = env[`${upper}_CLIENT_ID`];
  const clientSecret = env[`${upper}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;

  const base = {
    github: {
      authUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      userUrl: 'https://api.github.com/user',
      scope: 'read:user user:email',
      mapUser: (j) => ({ id: j.id, name: j.name, email: j.email, nickname: j.login, avatar: j.avatar_url }),
    },
    google: {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid email profile',
      mapUser: (j) => ({ id: j.sub, name: j.name, email: j.email, nickname: j.email, avatar: j.picture }),
    },
    // Facebook Graph API v18: the OAuth dialog lives at facebook.com/v18.0,
    // the token + user endpoints at graph.facebook.com/v18.0. `/me` returns a
    // nested `picture` object (picture.data.url), which mapUser flattens.
    facebook: {
      authUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
      tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
      userUrl: 'https://graph.facebook.com/me?fields=id,name,email,picture',
      scope: 'email',
      mapUser: (j) => ({
        id: j.id,
        name: j.name,
        email: j.email,
        nickname: j.name,
        avatar: j.picture && j.picture.data ? j.picture.data.url : j.picture,
      }),
    },
  }[name];

  if (!base) return null;
  return {
    ...base,
    name,
    clientId,
    clientSecret,
    redirectUri: env[`${upper}_REDIRECT_URI`] || '',
    scope: env[`${upper}_SCOPES`] || base.scope,
  };
}

// Fresh state nonce — Socialite uses `Str::random(40)`; the same primitive.
export function randomState() {
  return randomString(40);
}

// --- state cookie (Laravel puts `state` in the session cookie) -------------

const COOKIE_NAME = 'oauth_state';

export function stateCookie(state, { maxAgeSeconds = 600, secure = true } = {}) {
  return `${COOKIE_NAME}=${state}; Path=/; HttpOnly; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function readStateCookie(ctx) {
  const cookie = (ctx.request && ctx.request.headers && ctx.request.headers.get('cookie')) || '';
  for (const part of cookie.split(/;\s*/)) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === COOKIE_NAME) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

// Persist the state so the callback can double-check when the cookie is absent
// (cross-domain or a privacy browser). One row per state; short-lived.
export async function rememberState(env, state) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS lw_oauth_state (
      state TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
  await env.DB.prepare('INSERT INTO lw_oauth_state (state) VALUES (?1)').bind(state).run();
}

export async function consumeState(env, state) {
  const row = await env.DB.prepare('SELECT state FROM lw_oauth_state WHERE state = ?1')
    .bind(state).first();
  if (row) await env.DB.prepare('DELETE FROM lw_oauth_state WHERE state = ?1').bind(state).run();
  return !!row;
}
