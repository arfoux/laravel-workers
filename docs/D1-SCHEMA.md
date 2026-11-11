# D1 Schema Catalog

Consolidated list of every Cloudflare D1 table created by the package ports and kernel packages.

**Scope / method:** every `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statement found in `ports/packages/*.mjs` and `kernel/packages/*.mjs`. The exact SQL from each source file is reproduced verbatim (only indentation normalised). Collected 2026-11-11.

**Totals**
- `CREATE TABLE IF NOT EXISTS` statements: **52**
- Distinct table names: **42**
- Explicit indexes (`CREATE INDEX IF NOT EXISTS`): **5**
- Status key: **NEW** = introduced by the port fleet added in this cycle (untracked files); **existing** = table that already existed on `main`.

---

## Summary

| # | Table | Status | Port(s) | Explicit indexes |
|---|-------|--------|---------|------------------|
| 1 | `activity_log` | existing | `activitylog` | `activity_log_subject_idx`, `activity_log_causer_idx` |
| 2 | `agent_conversations` | NEW | `ai-sdk` | — |
| 3 | `agent_conversation_messages` | NEW | `ai-sdk` | `agent_conversation_messages_conv_idx` |
| 4 | `cache_response` | NEW | kernel `response-cache` | — |
| 5 | `lemon_squeezy_customers` | existing | `lemonsqueezy` | — |
| 6 | `lemon_squeezy_license_keys` | existing | `lemonsqueezy` | — |
| 7 | `lemon_squeezy_orders` | existing | `lemonsqueezy` | — |
| 8 | `lemon_squeezy_subscriptions` | existing | `lemonsqueezy` | — |
| 9 | `lw_dtos` | existing | `spatie-data` | — |
| 10 | `lw_oauth_state` | existing | kernel `socialite` | — |
| 11 | `lw_settings` | existing | `spatie-settings` | — |
| 12 | `lw_webhook_events` | existing | `cashier-paddle`, `cashier-stripe`, `lemonsqueezy` | — |
| 13 | `model_has_permissions` | existing | `permission` | — |
| 14 | `model_has_roles` | existing | `permission` | — |
| 15 | `oauth_access_tokens` | existing | `passport-oauth` | — |
| 16 | `oauth_auth_codes` | existing | `passport-oauth` | — |
| 17 | `oauth_clients` | existing | `passport-oauth` | — |
| 18 | `oauth_refresh_tokens` | existing | `passport-oauth` | — |
| 19 | `permissions` | existing | `permission` | — |
| 20 | `personal_access_tokens` | existing | `sanctum`, `laravel-socialite-callback` | — |
| 21 | `posts` | existing | `spatie-query-builder` | — |
| 22 | `pulse_aggregates` | NEW | `pulse` | — |
| 23 | `pulse_entries` | NEW | `pulse` | `pulse_entries_recorded_at_idx` |
| 24 | `pusher_events` | existing | `pusher` | — |
| 25 | `role_has_permissions` | existing | `permission` | — |
| 26 | `roles` | existing | `permission` | — |
| 27 | `sanctum_sessions` (`sessions`) | existing | `sanctum-spa-cookie` | — |
| 28 | `scout_search_log` | existing | `scout-meilisearch` | — |
| 29 | `sitemap_urls` | existing | `spatie-sitemap` | — |
| 30 | `slugs` | existing | `sluggable` | — |
| 31 | `state_models` | existing | `spatie-model-states` | — |
| 32 | `subscription_items` | existing | `cashier-stripe` | — |
| 33 | `subscriptions` | existing | `cashier-stripe` | — |
| 34 | `taggables` | existing | `tags` | — |
| 35 | `tags` | existing | `tags` | — |
| 36 | `translatable_posts` | existing | `spatie-translatable` | — |
| 37 | `users` (7 variants) | existing (+1 NEW variant) | `sanctum`, `sanctum-spa-cookie`, `fortify-confirmation`, `fortify-two-factor`, `laravel-socialite-callback`, `maatwebsite-excel`, **`jwt-auth`** (NEW) | — |
| 38 | `webhook_calls` (2 variants) | NEW | `webhook-client`, `webhook-server` | — |
| 39 | `webpush_subscriptions` | NEW | `webpush-notification` | `webpush_subscriptions_endpoint_idx` |
| 40 | `paddle_customers` | existing | `cashier-paddle` | — |
| 41 | `paddle_subscriptions` | existing | `cashier-paddle` | — |
| 42 | `paddle_transactions` | existing | `cashier-paddle` | — |

### Tables NEW in this cycle (7 distinct names)
`agent_conversations`, `agent_conversation_messages`, `cache_response`, `pulse_aggregates`, `pulse_entries`, `webhook_calls`, `webpush_subscriptions`. Plus a new `users` variant from `jwt-auth` (the table name itself is pre-existing).

---

## Catalog

### 1. `activity_log` — existing
Port: `activitylog` — spatie/laravel-activitylog model-activity audit trail.

```sql
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_name TEXT,
  description TEXT,
  subject_type TEXT,
  subject_id TEXT,
  causer_type TEXT,
  causer_id TEXT,
  event TEXT,
  properties TEXT,
  batch_uuid TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_log_subject_idx ON activity_log (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS activity_log_causer_idx  ON activity_log (causer_type, causer_id);
```

### 2. `agent_conversations` — NEW
Port: `ai-sdk` (`POST /ai/chat`) — one row per AI conversation session, holding the chosen provider + model.

```sql
CREATE TABLE IF NOT EXISTS agent_conversations (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   provider TEXT NOT NULL,
   model TEXT NOT NULL,
   created_at TEXT NOT NULL
 );
```

### 3. `agent_conversation_messages` — NEW
Port: `ai-sdk` (`POST /ai/chat`) — message turn inside an agent conversation (role/content + raw JSON).

```sql
CREATE TABLE IF NOT EXISTS agent_conversation_messages (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   conversation_id INTEGER NOT NULL,
   role TEXT NOT NULL,
   content TEXT,
   name TEXT,
   raw_json TEXT,
   created_at TEXT NOT NULL
 );
-- index creation is best-effort so minimal SQL fakes that don't parse CREATE INDEX still work
CREATE INDEX IF NOT EXISTS agent_conversation_messages_conv_idx
 ON agent_conversation_messages (conversation_id);
```

### 4. `cache_response` — NEW
Kernel: `response-cache` — stores cached HTTP responses (body + headers) with an expiry for response-cache middleware.

```sql
CREATE TABLE IF NOT EXISTS cache_response (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
```

### 5. `lemon_squeezy_customers` — existing
Port: `lemonsqueezy` — LemonSqueezy customer records linked to a local user.

```sql
CREATE TABLE IF NOT EXISTS lemon_squeezy_customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  ls_id TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

### 6. `lemon_squeezy_license_keys` — existing
Port: `lemonsqueezy` — LemonSqueezy license keys and activation state.

```sql
CREATE TABLE IF NOT EXISTS lemon_squeezy_license_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  ls_id TEXT NOT NULL UNIQUE,
  key TEXT NOT NULL,
  key_short TEXT,
  activation_limit INTEGER,
  instances_count INTEGER,
  status TEXT,
  expires_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

### 7. `lemon_squeezy_orders` — existing
Port: `lemonsqueezy` — one-time LemonSqueezy orders (incl. refund flag).

```sql
CREATE TABLE IF NOT EXISTS lemon_squeezy_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  ls_id TEXT NOT NULL UNIQUE,
  billable_name TEXT,
  total TEXT,
  currency TEXT,
  status TEXT,
  refunded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
```

### 8. `lemon_squeezy_subscriptions` — existing
Port: `lemonsqueezy` — LemonSqueezy recurring subscription records.

```sql
CREATE TABLE IF NOT EXISTS lemon_squeezy_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  ls_id TEXT NOT NULL UNIQUE,
  ls_product_id TEXT,
  ls_variant_id TEXT,
  status TEXT NOT NULL,
  quantity INTEGER,
  trial_ends_at TEXT,
  renews_at TEXT,
  ends_at TEXT,
  paused_at TEXT,
  card_brand TEXT,
  card_last_four TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

### 9. `lw_dtos` — existing
Port: `spatie-data` — demo store for spatie/laravel-data DTO serialisation round-trips.

```sql
CREATE TABLE IF NOT EXISTS lw_dtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  age INTEGER,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 10. `lw_oauth_state` — existing
Kernel: `socialite` — OAuth `state` nonces for Laravel Socialite CSRF verification.

```sql
CREATE TABLE IF NOT EXISTS lw_oauth_state (
  state TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 11. `lw_settings` — existing
Port: `spatie-settings` — typed key/value settings store for spatie/laravel-settings.

```sql
CREATE TABLE IF NOT EXISTS lw_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  "group" TEXT NOT NULL,
  key TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE ("group", key)
);
```

### 12. `lw_webhook_events` — existing
Ports: `cashier-paddle`, `cashier-stripe`, `lemonsqueezy` — shared dedupe ledger of incoming billing webhooks (guards replay/double-processing).

```sql
CREATE TABLE IF NOT EXISTS lw_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  type TEXT,
  payload TEXT,
  received_at TEXT
);
```

### 13. `model_has_permissions` — existing
Port: `permission` — spatie/laravel-permission polymorphic model↔permission pivot.

```sql
CREATE TABLE IF NOT EXISTS model_has_permissions (
  permission_id INTEGER NOT NULL,
  model_type TEXT NOT NULL,
  model_key TEXT NOT NULL,
  UNIQUE (permission_id, model_type, model_key)
);
```

### 14. `model_has_roles` — existing
Port: `permission` — spatie/laravel-permission polymorphic model↔role pivot.

```sql
CREATE TABLE IF NOT EXISTS model_has_roles (
  role_id INTEGER NOT NULL,
  model_type TEXT NOT NULL,
  model_key TEXT NOT NULL,
  UNIQUE (role_id, model_type, model_key)
);
```

### 15. `oauth_access_tokens` — existing
Port: `passport-oauth` — Passport-issued OAuth access tokens.

```sql
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  expires_at TEXT
);
```

### 16. `oauth_auth_codes` — existing
Port: `passport-oauth` — Passport authorization codes (incl. PKCE).

```sql
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  code_challenge TEXT,
  code_challenge_method TEXT
);
```

### 17. `oauth_clients` — existing
Port: `passport-oauth` — Passport OAuth client applications.

```sql
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  name TEXT,
  secret TEXT,
  redirect TEXT NOT NULL,
  grant_types TEXT,
  scopes TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
```

### 18. `oauth_refresh_tokens` — existing
Port: `passport-oauth` — Passport refresh tokens tied to an access token.

```sql
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  access_token_id INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT
);
```

### 19. `permissions` — existing
Port: `permission` — spatie/laravel-permission named permissions per guard.

```sql
CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  guard_name TEXT NOT NULL DEFAULT 'web',
  UNIQUE (name, guard_name)
);
```

### 20. `personal_access_tokens` — existing
Ports: `sanctum` (canonical), `laravel-socialite-callback` (upserts a matching shape) — Sanctum personal access tokens.

```sql
CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tokenable_type TEXT NOT NULL,
  tokenable_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  abilities TEXT,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

### 21. `posts` — existing
Port: `spatie-query-builder` — demo posts for filtering/sorting via spatie/laravel-query-builder.

```sql
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 22. `pulse_aggregates` — NEW
Port: `pulse` (`GET /pulse`) — pre-aggregated Pulse metrics per period/path (requests, errors, avg duration).

```sql
CREATE TABLE IF NOT EXISTS pulse_aggregates (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   period TEXT NOT NULL,
   path TEXT,
   requests INTEGER NOT NULL DEFAULT 0,
   errors INTEGER NOT NULL DEFAULT 0,
   avg_duration REAL
 );
```

### 23. `pulse_entries` — NEW
Port: `pulse` (`POST /pulse/record`, `GET /pulse`) — raw Pulse entries (one request/error datapoint per row).

```sql
CREATE TABLE IF NOT EXISTS pulse_entries (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   type TEXT NOT NULL,
   path TEXT,
   status INTEGER,
   duration_ms REAL,
   recorded_at TEXT NOT NULL
 );
CREATE INDEX IF NOT EXISTS pulse_entries_recorded_at_idx ON pulse_entries (recorded_at);
```

### 24. `pusher_events` — existing
Port: `pusher` — persisted broadcast events for the Pusher channel fallback.

```sql
CREATE TABLE IF NOT EXISTS pusher_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  name TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 25. `role_has_permissions` — existing
Port: `permission` — spatie/laravel-permission role↔permission pivot.

```sql
CREATE TABLE IF NOT EXISTS role_has_permissions (
  permission_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL,
  PRIMARY KEY (permission_id, role_id)
);
```

### 26. `roles` — existing
Port: `permission` — spatie/laravel-permission named roles per guard.

```sql
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  guard_name TEXT NOT NULL DEFAULT 'web',
  UNIQUE (name, guard_name)
);
```

### 27. `sessions` — existing
Port: `sanctum-spa-cookie` — server-side session rows carrying the CSRF token for SPA-cookie auth.

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TEXT,
  last_activity TEXT
);
```

### 28. `scout_search_log` — existing
Port: `scout-meilisearch` — search-query log (index + query + hit count) for Scout Meilisearch.

```sql
CREATE TABLE IF NOT EXISTS scout_search_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  index_uid TEXT NOT NULL,
  q TEXT,
  hits INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 29. `sitemap_urls` — existing
Port: `spatie-sitemap` — URLs tracked for sitemap generation via spatie/laravel-sitemap.

```sql
CREATE TABLE IF NOT EXISTS sitemap_urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loc TEXT NOT NULL UNIQUE,
  lastmod TEXT NOT NULL,
  changefreq TEXT,
  priority TEXT
);
```

### 30. `slugs` — existing
Port: `sluggable` — slug history per (table, column) for spatie/laravel-sluggable.

```sql
CREATE TABLE IF NOT EXISTS slugs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug_table TEXT NOT NULL,
  slug_column TEXT NOT NULL,
  slug TEXT NOT NULL,
  source TEXT,
  UNIQUE (slug_table, slug_column, slug)
);
```

### 31. `state_models` — existing
Port: `spatie-model-states` — demo models whose `state` column is a validated state-machine value.

```sql
CREATE TABLE IF NOT EXISTS state_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 32. `subscription_items` — existing
Port: `cashier-stripe` — Cashier Stripe per-price subscription line items.

```sql
CREATE TABLE IF NOT EXISTS subscription_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  stripe_id TEXT NOT NULL,
  stripe_product TEXT,
  stripe_price TEXT,
  quantity INTEGER,
  meter_id TEXT,
  meter_event_name TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE (subscription_id, stripe_price)
);
```

### 33. `subscriptions` — existing
Port: `cashier-stripe` — Cashier Stripe subscription records per user.

```sql
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  stripe_id TEXT NOT NULL UNIQUE,
  stripe_status TEXT NOT NULL,
  stripe_price TEXT,
  quantity INTEGER,
  trial_ends_at TEXT,
  ends_at TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  paused_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

### 34. `taggables` — existing
Port: `tags` — spatie/laravel-tags polymorphic tag↔model pivot.

```sql
CREATE TABLE IF NOT EXISTS taggables (
  tag_id INTEGER NOT NULL,
  taggable_type TEXT NOT NULL,
  taggable_id TEXT NOT NULL,
  UNIQUE (tag_id, taggable_type, taggable_id)
);
```

### 35. `tags` — existing
Port: `tags` — spatie/laravel-tags named tags per type.

```sql
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  type TEXT,
  order_column INTEGER NOT NULL DEFAULT 0,
  UNIQUE (slug, type)
);
```

### 36. `translatable_posts` — existing
Port: `spatie-translatable` — demo posts storing per-locale JSON strings for spatie/laravel-translatable.

```sql
CREATE TABLE IF NOT EXISTS translatable_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '{}',
  body TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 37. `users` — existing table, multiple variants
The `users` table is created independently by several auth ports, each provisioning its own demo shape. `IF NOT EXISTS` means whichever port runs first on a fresh DB wins; the others become no-ops. Documented as separate variants:

**(a) `sanctum` — existing**
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL
);
```

**(b) `sanctum-spa-cookie` — existing**
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password TEXT
);
```

**(c) `fortify-confirmation` — existing**
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password TEXT,
  email_verified_at TEXT,
  password_confirmed_at TEXT
);
```

**(d) `fortify-two-factor` — existing**
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password TEXT,
  two_factor_secret TEXT,
  two_factor_recovery_codes TEXT,
  two_factor_confirmed_at TEXT,
  email_verified_at TEXT
);
```

**(e) `laravel-socialite-callback` — existing** (provider-linked users)
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  name TEXT,
  email TEXT,
  avatar TEXT,
  UNIQUE (provider, provider_id)
);
```

**(f) `maatwebsite-excel` — existing** (demo export source)
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT
);
```

**(g) `jwt-auth` — NEW variant** (`POST /auth/jwt/login`, `GET /auth/jwt/user`)
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL
);
```

### 38. `webhook_calls` — NEW (⚠ conflicting variants)
Two different ports create a table with the **same name but different schemas** — a real collision risk on a shared D1 binding, since `IF NOT EXISTS` means the first writer's shape wins.

**(a) `webhook-client`** (`POST /webhooks/{name}`) — outbound dispatch log (spatie/laravel-webhook-client):
```sql
CREATE TABLE IF NOT EXISTS webhook_calls (
  id TEXT PRIMARY KEY,
  name TEXT,
  payload TEXT,
  exception TEXT,
  processed_at TEXT
);
```

**(b) `webhook-server`** (`POST /webhook-server/send`) — inbound webhook log:
```sql
CREATE TABLE IF NOT EXISTS webhook_calls (
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
 );
```

### 39. `webpush_subscriptions` — NEW
Port: `webpush-notification` (`POST /notify/webpush`, `POST /webpush/subscribe`) — Web Push VAPID endpoint subscriptions (endpoint + client keys).

```sql
CREATE TABLE IF NOT EXISTS webpush_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS webpush_subscriptions_endpoint_idx ON webpush_subscriptions (endpoint);
```

### 40. `paddle_customers` — existing
Port: `cashier-paddle` — Cashier Paddle customer records.

```sql
CREATE TABLE IF NOT EXISTS paddle_customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  paddle_id TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

### 41. `paddle_subscriptions` — existing
Port: `cashier-paddle` — Cashier Paddle subscription records.

```sql
CREATE TABLE IF NOT EXISTS paddle_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  paddle_id TEXT NOT NULL UNIQUE,
  paddle_price_id TEXT,
  status TEXT NOT NULL,
  quantity INTEGER,
  trial_ends_at TEXT,
  paused_at TEXT,
  ends_at TEXT,
  next_billed_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

### 42. `paddle_transactions` — existing
Port: `cashier-paddle` — Cashier Paddle transaction receipts.

```sql
CREATE TABLE IF NOT EXISTS paddle_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  subscription_id INTEGER,
  paddle_id TEXT NOT NULL UNIQUE,
  paddle_subscription_id TEXT,
  total TEXT,
  currency TEXT,
  status TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

---

## Caveats

1. **`users` shape drift.** Seven ports each `CREATE TABLE IF NOT EXISTS users` with different columns. On a fresh database the first port to call `ensureSchema()` fixes the schema; later ports silently accept it. Combining an auth port that needs `two_factor_secret` with one that only provisions `(id,name,email,password)` will leave the 2FA column missing. Use one owning port's schema, or define `users` at the app level.
2. **`webhook_calls` name collision.** `webhook-client` and `webhook-server` both create `webhook_calls` with incompatible primary keys (`TEXT` vs `INTEGER`) and column sets. Running both ports against the same D1 binding will make one of them fail at insert time. Rename one (e.g. `webhook_server_calls`) or namespace by port.
3. **Shared `lw_webhook_events` / `personal_access_tokens`.** These are reused across ports with compatible shapes, so they are safe to share.
4. **Best-effort indexes.** Only `activitylog`, `ai-sdk`, `pulse`, and `webpush-notification` create explicit indexes; `ai-sdk` wraps its `CREATE INDEX` in `try/catch` so minimal SQL fakes that don't parse index DDL still persist rows.
