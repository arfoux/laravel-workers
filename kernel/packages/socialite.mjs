// kernel/packages/socialite.mjs — cluster-E (DATA & EXPORT) glue for the
// Socialite port: resolve a provider's config from env, mint a state nonce, and
// read/write the state cookie. The actual OAuth steps (authorizeUrl /
// verifyState / exchangeCode / fetchUser) live in `oauth.mjs` and are used
// as-is by the two handler modules (redirect + callback).
//
// Parity target: laravel/socialite v5.31.0 builds the redirect URL and stores
// the `state` in the session, then verifies it on the callback. Workers have no
// PHP session; we carry `state` in an HttpOnly cookie holding a 40-char random
// nonce (unguessable, NOT signed - there is no MAC; the D1 row beside it is the
// second check) AND a
// `lw_oauth_state` D1 row so the callback can check either (defense in depth).

import { randomString } from './token.mjs';
import { parseCookieHeader } from '../cookies.mjs';

// Provider config straight from the env binding. Callers must set:
//   env.<PROVIDER>_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI
//   (optional) env.<PROVIDER>_SCOPES  — space-separated
// e.g. env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, env.GITHUB_REDIRECT_URI.
// The provider *shape* (authUrl / tokenUrl / userUrl / mapUser) is code-side;
// only credentials come from env, so secrets never appear in the repo.
export function resolveProvider(env, name) {
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
  const shared = providerEnv(env, name, { scope: base.scope });
  if (!shared) return null;
  return { ...base, name, ...shared };
}

// The env half of a provider resolution: the standard `<PROVIDER>_CLIENT_ID` /
// `_CLIENT_SECRET` / `_REDIRECT_URI` / `_SCOPES` reads plus the "unconfigured ->
// null" guard, in ONE place. `socialite-providers.mjs` (azure, keycloak,
// cognito, okta) merges the same four fields, so the rule is written once
// instead of drifting in two files. `scope` is the caller's default for when
// `<PROVIDER>_SCOPES` is absent (the base shape's scope, or the extra shape's).
export function providerEnv(env, name, { scope } = {}) {
  const upper = String(name).toUpperCase();
  const clientId = env[`${upper}_CLIENT_ID`];
  const clientSecret = env[`${upper}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: env[`${upper}_REDIRECT_URI`] || '',
    scope: env[`${upper}_SCOPES`] || scope,
  };
}

// Fresh state nonce — Socialite uses `Str::random(40)`; the same primitive.
export function randomState() {
  return randomString(40);
}

// --- state cookie (Laravel puts `state` in the session cookie) -------------

const COOKIE_NAME = 'oauth_state';

// The window a `state` is worth remembering: the cookie's Max-Age, and the age
// at which `rememberState` prunes the D1 row (one constant so the two cannot
// drift - a row outliving its cookie is dead weight in D1).
const STATE_TTL_SECONDS = 600;

export function stateCookie(state, { maxAgeSeconds = STATE_TTL_SECONDS, secure = true } = {}) {
  return `${COOKIE_NAME}=${state}; Path=/; HttpOnly; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function readStateCookie(ctx) {
  const cookie = (ctx.request && ctx.request.headers && ctx.request.headers.get('cookie')) || '';
  // `parseCookieHeader` (kernel/cookies.mjs) is the one Cookie-header reader:
  // it trims the name, keeps the LAST duplicate (PHP's parser overwrites),
  // tolerates a malformed escape (`%` stays `%`, where `decodeURIComponent`
  // threw a URIError - uncontrolled input on a public callback route) and
  // nests PHP-style `name[]=` cookies, which a string cookie is not.
  const state = parseCookieHeader(cookie)[COOKIE_NAME];
  return typeof state === 'string' ? state : null;
}

// Persist the state so the callback can double-check when the cookie is absent
// (cross-domain or a privacy browser). One row per state; short-lived - the row
// is pruned once it is older than the cookie's own window, because a flow whose
// callback never comes (a bot hitting `/auth/{provider}/redirect`, a closed tab)
// otherwise leaves it behind for good.
export async function rememberState(env, state) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS lw_oauth_state (
      state TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
  await env.DB.prepare(
    `DELETE FROM lw_oauth_state WHERE created_at < datetime('now', '-${STATE_TTL_SECONDS} seconds')`
  ).run();
  await env.DB.prepare('INSERT INTO lw_oauth_state (state) VALUES (?1)').bind(state).run();
}

export async function consumeState(env, state) {
  const row = await env.DB.prepare('SELECT state FROM lw_oauth_state WHERE state = ?1')
    .bind(state).first();
  if (row) await env.DB.prepare('DELETE FROM lw_oauth_state WHERE state = ?1').bind(state).run();
  return !!row;
}
