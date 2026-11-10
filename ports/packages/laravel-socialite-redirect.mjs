// Port of laravel/socialite v5.31.0 — the REDIRECT half: build the provider
// authorize URL, remember the `state`, and 302 the browser there.
//
// GET /auth/{provider}/redirect
// In Laravel: `return Socialite::driver('github')->redirect();`. Here we:
//   1. resolve the provider's config from env (socialite.mjs),
//   2. mint a state nonce,
//   3. store it (cookie + D1 row) so the callback can verify,
//   4. return a 302 to `authorizeUrl(provider, state)` (oauth.mjs).
// fetchImpl is injectable only for the callback (this step makes no HTTP calls).

import { authorizeUrl } from '../../kernel/packages/oauth.mjs';
import {
  resolveProvider,
  randomState,
  stateCookie,
  rememberState,
} from '../../kernel/packages/socialite.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const provider = resolveProvider(env, String(ctx.params && ctx.params.provider));
  if (!provider) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'unknown or unconfigured provider' }),
    };
  }

  try {
    const state = randomState();
    await rememberState(env, state);
    const url = authorizeUrl(provider, state);
    return {
      status: 302,
      headers: {
        location: url,
        'set-cookie': stateCookie(state),
        'cache-control': 'no-store',
      },
      body: '',
    };
  } catch (err) {
    return {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: String((err && err.message) || err) }),
    };
  }
}
