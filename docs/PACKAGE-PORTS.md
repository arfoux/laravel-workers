# The package-port fleet — routes, secrets, collisions

`registry.example.json` maps every route the fleet's `ports/packages/*.mjs` handlers answer.
Copy the entries you use into your app's `registry.json` and copy those `<slug>.mjs` files into
your app's ports dir (`LW_PORTS_DIR`, default `ports/`) — the build copies them into
`dist/src/ports/` and refuses (`--strict`) a key that is not in `route:list` or a slug with no file.

**Keys are route paths, not verb+path**: one entry covers every verb on that path (the build emits
one port controller per path). A `{param}` key is the Laravel route pattern; a `:param` form is
NOT matched and fails the build.

## Secrets the handlers read (set them as Worker secrets, never in the registry)

| Slug(s) | Secret / binding |
|---|---|
| `sanctum`, `sanctum-spa-cookie` | `APP_KEY` (token cookie); D1 `personal_access_tokens` (via `ensureSchema`) |
| `passport-oauth` | `PASSPORT_PRIVATE_KEY` (RS256, WebCrypto) |
| `cashier-stripe` | `STRIPE_WEBHOOK_SECRET` |
| `cashier-paddle` | `PADDLE_WEBHOOK_SECRET` |
| `lemonsqueezy` | `LEMON_SQUEEZY_SIGNING_SECRET` |
| `scout-meilisearch` | `MEILISEARCH_HOST`, `MEILISEARCH_KEY` |
| `scout-algolia` | `ALGOLIA_APP_ID`, `ALGOLIA_SEARCH_KEY` |
| `pusher`, `reverb` | `PUSHER_APP_ID` / `PUSHER_APP_KEY` / `PUSHER_APP_SECRET` (Reverb uses its own app key/secret) |
| `mailgun-mail` | `MAILGUN_DOMAIN`, `MAILGUN_SECRET` |
| `postmark-mail` | `POSTMARK_TOKEN` |
| `slack-notification` | `SLACK_WEBHOOK_URL` or the bot token |
| `twilio-sms` | `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` |
| `fortify-two-factor` | `APP_KEY` (TOTP secret encryption); D1 `two_factor_*` (via `ensureSchema`) |
| `laravel-socialite-*` | per-provider client id/secret (`GITHUB_CLIENT_ID`, ...) |

DB-backed ports create their tables through their exported `ensureSchema`, which `dist/schema.sql`
folds in — apply the schema (`npx laravel-workers deploy` mode 2) before serving them.

## Collisions — pick one per route, never ship two keys for the same path

| Path | Ports that answer it | Note |
|---|---|---|
| `/broadcasting/auth` | `pusher`, `reverb` | Only one broadcast backend is installed in a real app. The example maps it to `reverb` and `/broadcast` to `pusher`; a Pusher-only app should move `/broadcasting/auth` to `pusher`. |

Route-key uniqueness is enforced by JSON: a duplicate key silently keeps the last one, so a bad
registry fails at request time, not build time — keep the pairs in this table apart.

## The shape a handler answers

See the README's *A route port, in practice* section. In short: `ctx.request` from the router is the
compiled kernel `Request` whose accessors are METHODS; every fleet handler starts with
`ctx = normalizePortCtx(ctx)`, and `tools/tests/packages-wiring.test.mjs` proves the fleet answers on
that ctx (not a hand-built one).
