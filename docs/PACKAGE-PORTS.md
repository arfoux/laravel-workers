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
| `lemonsqueezy` | `LEMON_SQUEEZY_WEBHOOK_SECRET` |
| `scout-meilisearch` | `MEILISEARCH_HOST`, `MEILISEARCH_KEY` |
| `scout-algolia` | `ALGOLIA_APP_ID`, `ALGOLIA_KEY` (fallback `ALGOLIA_API_KEY`) |
| `pusher`, `reverb` | `PUSHER_APP_ID` / `PUSHER_APP_KEY` / `PUSHER_APP_SECRET` (Reverb uses its own app key/secret) |
| `mailgun-mail` | `MAILGUN_DOMAIN`, `MAILGUN_SECRET` |
| `postmark-mail` | `POSTMARK_TOKEN` |
| `slack-notification` | `SLACK_WEBHOOK_URL` or the bot token |
| `twilio-sms` | `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` |
| `fortify-two-factor` | `APP_KEY` (TOTP secret encryption); D1 `two_factor_*` (via `ensureSchema`) |
| `laravel-socialite-*` | per-provider client id/secret (`GITHUB_CLIENT_ID`, ...) |
| `ai-sdk` | per-provider LLM key, chosen per model: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`; D1 `agent_conversations`, `agent_conversation_messages` (via `ensureSchema`, best-effort) |
| `mcp` | no secret — `MCP_TOOLS` / `MCP_PROMPTS` bindings (the tool/prompt registries), optional `MCP_SERVER_NAME` / `MCP_SERVER_VERSION` / `MCP_PROTOCOL_VERSION` |
| `pulse` | no secret; D1 `pulse_entries`, `pulse_aggregates` (via `ensureSchema`) |
| `bugsnag` | `BUGSNAG_API_KEY` |
| `webhook-client` | `WEBHOOK_CLIENT_SECRET` (optional `WEBHOOK_CLIENT_SIGNATURE_HEADER`); D1 `webhook_calls` (via `ensureSchema`) |
| `webhook-server` | `WEBHOOK_SERVER_SECRET`; D1 `webhook_calls` (via `ensureSchema`) |
| `site-search` | `MEILISEARCH_HOST` (+ optional `MEILISEARCH_KEY`/`MEILISEARCH_API_KEY`), optional `SITE_SEARCH_INDEX`/`SCOUT_INDEX` |
| `telegram-notification` | `TELEGRAM_BOT_TOKEN` |
| `discord-notification` | `DISCORD_WEBHOOK_URL` (Incoming Webhook) or `DISCORD_BOT_TOKEN` (+ `DISCORD_CHANNEL`) |
| `expo-notification` | `EXPO_ACCESS_TOKEN` (optional — Bearer auth raises the rate limit) |
| `fcm-notification` | `FCM_SERVICE_ACCOUNT_JSON` (raw or base64), `FCM_PROJECT_ID` (optional — falls back to the service account's `project_id`) |
| `webpush-notification` | `WEBPUSH_VAPID_PRIVATE_KEY`, `WEBPUSH_VAPID_SUBJECT` (optional `WEBPUSH_TTL` / `WEBPUSH_URGENCY`); D1 `webpush_subscriptions` (via `ensureSchema`) |
| `onesignal-notification` | `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY` (optional `ONESIGNAL_LANGUAGE`) |
| `jwt-auth` | `JWT_SECRET` (HS256), optional `JWT_TTL`; D1 `users` (via `ensureSchema`) |
| `firebase-php-jwt` | `FIREBASE_PROJECT_ID`, optional `FIREBASE_JWKS_URL` |
| `auth0` | `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_REDIRECT_URI` (optional `AUTH0_AUDIENCE`) |
| `glide` | `CF_IMAGE_RESIZING_ZONE`, optional `GLIDE_ORIGIN` |
| `localization` (middleware) | no secret — plain Wrangler vars `LOCALES`, `DEFAULT_LOCALE`, `HIDE_DEFAULT_LOCALE_IN_URL` |

DB-backed ports create their tables through their exported `ensureSchema`, which `dist/schema.sql`
folds in — apply the schema (`npx laravel-workers deploy` mode 2) before serving them.

## Route seams — the paths the newer ports answer

Each new port is one registry slug (one file); a slug may answer several paths when it dispatches
on the resolved verb + path. All of these are already in `registry.example.json`.

| Slug | Route(s) | Notes / substitution |
|---|---|---|
| `ai-sdk` | `POST /ai/chat` | Non-streaming `generate()` only — the SSE stream is a runtime gap (no ReadableStream body contract). Tools dispatch via `env.ai_tool_runners`. |
| `mcp` | `POST /mcp` | JSON-RPC 2.0 (`initialize` / `tools/list` / `tools/call` / `prompts/list`). STDIO + SSE transports refused — a Worker has no child process and no stream body yet. |
| `pulse` | `GET /pulse`, `POST /pulse/record` | Dashboard is a JSON aggregation over `pulse_entries` (`?range=<minutes>`), not the HTML UI. |
| `bugsnag` | `POST /bugsnag/notify` | 1:1 transport swap of the notify API POST. |
| `webhook-client` | `POST /webhooks/{name}` | Receiving side: HMAC-SHA256 verify (constant-time) before the D1 write; unverified calls are never stored. |
| `webhook-server` | `POST /webhook-server/send` | Sending side: signs `base64(HMAC-SHA256(secret, rawBody))` + `webhook-timestamp` header. Requires an authenticated caller (see *seam routes* below); caller-supplied `headers` can never replace the three canonical headers. |
| `site-search` | `GET /site-search` | Proxies Meilisearch `POST /indexes/{uid}/search`; indexing is out-of-band (Searchable/Scout sync is vendor code, LW002). |
| `telegram-notification` | `POST /notify/telegram` | Token rides in the URL path (`/bot{TOKEN}/sendMessage`). |
| `discord-notification` | `POST /notify/discord` | Webhook wins over the Bot API when both are configured; on the webhook path `to`/`channel` is a thread target (`?thread_id=`, Discord's query parameter — a JSON body field is dropped by Discord). |
| `expo-notification` | `POST /notify/expo` | `EXPO_ACCESS_TOKEN` is optional (sends unauthenticated without it). |
| `fcm-notification` | `POST /notify/fcm` | FCM v1 HTTP API only; the deprecated legacy server-key path is not ported. The project id is `FCM_PROJECT_ID`, or the service account's own `project_id` when the env var is absent (kreait's `Factory::getProjectId()`). |
| `webpush-notification` | `POST /notify/webpush` | RFC 8291 encrypt + RFC 8292 VAPID. The subscription row is the **app's own** (the browser's `PushManager.getSubscription()` result stored through D1): this port only reads it by `id`, or takes it inline in the body. |
| `onesignal-notification` | `POST /notify/onesignal` | REST API key as HTTP Basic (username, no password). |
| `jwt-auth` | `POST /auth/jwt/login`, `GET /auth/jwt/user` | HS256 (the stateless `tymon/jwt-auth` default), not Passport's RS256; bcryptjs verifies Laravel's `$2y$`. |
| `firebase-php-jwt` | `POST /auth/firebase/verify` | Verifies a Firebase ID token against Google's JWKS (RS256), `kid`-matched. |
| `auth0` | `POST /auth/auth0/callback` | Stops at the `authorization_code` token exchange; compose with `firebase-php-jwt` for offline `id_token` verify. |
| `glide` | `GET /img/{path}` | Transform delegated to Cloudflare Image Resizing (`/cdn-cgi/image`) — no GD/Imagick. `w` is required (422 without it). |
| `localization` | `GET /localization` | **Middleware port**, not a route port: declare it under `middlewarePorts`. Returns `null` (continues to the route handler) for a prefixed or unprefixed path, setting `ctx.locale` on the way; the only response it produces is the `HIDE_DEFAULT_LOCALE_IN_URL` 302. |

## Seam routes — a route whose Laravel counterpart is app-side code

Some mapped routes have **no counterpart route in Laravel**. Their Laravel side is a facade or a
driver that app code calls inside a request the app itself already authenticated
(`Mail::send()`, `Notification::send()`, `$user->assignRole()`, `broadcast()`,
`WebhookCall::dispatch()`, `Prism::chat()`, `Gate`/`can:`): the package is a library, and
Laravel never exposes it as a public path.

At the edge the HTTP route is only a seam for a caller outside the app — app code reaches the
same capability through `compiler/package-bindings.mjs` (facade → `rt.<primitive>`) and the port's
exported functions, never by fetching its own URL. So a seam route must not be anonymous: without
a caller, `POST /broadcast` triggers events on any channel with the app's Pusher secret,
`POST /webhook-server/send` is a signing oracle plus arbitrary-https egress, and
`/model/{modelType}/{modelKey}/roles/{action}` grants any role to any model key.

Rule: **a seam route requires an authenticated caller.** The identity is the platform guard's
(`ctx.user()` in `kernel/http.mjs`, or a `ctx.user_id` a `middlewarePorts` guard wrote —
`guardUserId()` in `kernel/packages/port-ctx.mjs`); it is never a body/query/params value.
No identity → `401` before any DB write, any signature, any outbound `fetch` — answered through
`unauthorized()` in `kernel/packages/port-ctx.mjs`, so the status, the shared JSON envelope and
Laravel's own `Unauthenticated.` body (`kernel/auth.mjs`) are written once rather than per port.
The port's exported functions stay ungated: an app's own job or Worker call is in-process, not an
HTTP request.

Currently gated this way: `permission` (all routes), `pusher` `/broadcast`, `webhook-server`
`/webhook-server/send`, `pusher`/`reverb` on `/broadcasting/auth` (guarded channels only),
`maatwebsite-excel` `/export`, and `multitenancy` (both routes: create + resolve). `scout-algolia`
(`/1/indexes/{name}/query`) is a check rather than a gate: it requires the caller's
`X-Algolia-Application-Id`/`X-Algolia-API-Key` headers to *match* `ALGOLIA_APP_ID`/`ALGOLIA_KEY`
(constant-time) and answers `403` when either is absent — an omitted header must never proxy
through the worker's own key.

Not yet gated, same shape, listed here so the gap is visible rather than implied: the
notification transports (`/notify/*`), `mailgun-mail`, `postmark-mail`,
`slack-notification`, `twilio-sms`, `ai-sdk` (`/ai/chat`), `mcp` (`/mcp`), `pulse`
(`/pulse/record`), `bugsnag` (`/bugsnag/notify`), `glide`
(`/img/{path}`). Each spends the app's provider credentials or writes app state on behalf of
whoever reaches the URL, so an app that maps them must put a guard in front (a small
`middlewarePorts` port that answers `401` when `ctx.user_id` is absent) until the port itself
enforces it.

The kernel-side helpers these ports lean on (`kernel/packages/`): `ai.mjs` (provider adapters +
tool loop), `google-oauth.mjs` (Google service-account RS256 JWT → OAuth2 access token; the
`fcm-oauth.mjs` binding is the same mint with the FCM scope and env var), `webpush-crypto.mjs` (ECDH/HKDF/
AES-128-GCM + VAPID), `notify-http.mjs` (shared `fetch`/auth/response mapping), `port-ctx.mjs`
(the `normalizePortCtx` every handler starts with), and the page-composition helpers `menu.mjs`,
`navigation.mjs`, `html.mjs`, `options.mjs`, `csp.mjs`, `response-cache.mjs`, `honeypot.mjs`,
`seo.mjs`, `gtm.mjs`, `streaming-runtime.mjs` used by the compiled app rather than registered as
routes. Those files are copied by the build — they are not registry slugs.

## Collisions — pick one per route, never ship two keys for the same path

Route-pair collisions: none among the newer ports — `webhook-client` (`/webhooks/{name}`) and
`webhook-server` (`/webhook-server/send`) answer different paths and can coexist; they only share
the `webhook_calls` D1 table (each row is tagged by which port wrote it), which is a data-shape
fact, not a route conflict.

| Path | Ports that answer it | Note |
|---|---|---|
| `/broadcasting/auth` | `pusher`, `reverb`, `echo` | Only one broadcast backend is installed in a real app. The example maps it to `reverb` and `/broadcast` to `pusher`; a Pusher-only app should move `/broadcasting/auth` to `pusher`. All three sign a `private-`/`presence-` channel only for a request that carries an identity (`ctx.user()` / a `middlewarePorts`-written `ctx.user_id` for pusher+reverb, a Sanctum token for `echo`) and answer `401` otherwise — Laravel requires a user for a guarded channel; the presence `user_id` comes from that identity, never from `channel_data`. The **bodies are shared** (`kernel/packages/broadcast.mjs`): `401`/`403` use Laravel's error key `{"message": …}` (Laravel renders `AccessDeniedHttpException` — and its `AuthorizationException` — that way, with an empty text the ports replace by a helpful one), while the `422` for a missing `socket_id`/`channel_name` is the ports' own guard: Laravel has no such case, an empty `channel_name` takes the `403` path too. |

Route-key uniqueness is enforced by JSON: a duplicate key silently keeps the last one, so a bad
registry fails at request time, not build time — keep the pairs in this table apart.

## Middleware ports — the run-around seam

A registry slug normally **owns** a route: the router dispatches to it and its response is the
answer. A **middleware port** runs *before* the route's own handler instead, on the same `ctx`:

```json
{ "middlewarePorts": { "/localization": ["localization"] } }
```

The list is ordered (several ports chain). Returning `null`/`undefined` **continues** to the next
port, then the route handler; any state written onto `ctx` (e.g. `ctx.locale`) is visible there.
Returning `{ status, headers, body }` **short-circuits** — the handler never runs. The route must
still have a request-time handler of its own (a compiled controller or a `ports` entry); the build
refuses a `middlewarePorts` route without one, because a snapshot/unhandled route is answered by
the asset bundle and the port would never run.

Today the fleet's one middleware port is `localization` (mcamara/laravel-localization's
`LaravelLocalizationRedirectFilter`); it is the template for a response-cache or a URL-normalising
port.

## The shape a handler answers

See the README's *A route port, in practice* section. In short: `ctx.request` from the router is the
compiled kernel `Request` whose accessors are METHODS; every fleet handler starts with
`ctx = normalizePortCtx(ctx)`, and `tools/tests/packages-wiring.test.mjs` proves the fleet answers on
that ctx (not a hand-built one).
