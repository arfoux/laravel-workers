# D1 Schema Catalog

Consolidated list of every Cloudflare D1 table the package ports and the kernel packages create.

**Scope / method:** every `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statement the code RUNS, read out of the string and template literals of `ports/packages/*.mjs` and `kernel/packages/*.mjs` by `tools/port-catalog.mjs`. A statement sketched in a module's header comment (`//   CREATE TABLE IF NOT EXISTS users ( ... )`) documents the shape and is deliberately not counted here — a plain grep counted those sketches too, and that is how this file came to describe itself as complete while six tables the code creates (`channel_memberships`, `invoices`, `job_metrics`, `mollie_payments`, `tenants`, `transactions`) had no section at all.

The numbers, the summary and every SQL block below are generated; `--check` runs in the docs gate (`npm run check:docs`), so they cannot drift from the code again. What stays hand-written is the per-table description and the caveats — analysis, not a grep.

Where more than one module creates the same name with a different column set, the Summary and the section heading both say so (`users (7 variants)`), and the section documents each variant with its own block; the check proves every block it quotes is a statement the code runs, but not which variant is which — that label is hand-written.

<!-- port-catalog:totals:start -->

**Totals**
- `CREATE TABLE IF NOT EXISTS` statements the code runs: **56**
- Distinct table names: **48**
- Explicit indexes (`CREATE INDEX IF NOT EXISTS`): **6**

<!-- port-catalog:totals:end -->

The `Status` column this file used to carry (**NEW** = introduced by the port fleet, **existing** = already on `main`) was removed on 2026-11-13, along with the `— existing` / `— NEW` suffixes the variant subsections carried: they described a migration that has landed, and a hand-typed status inside a generated table is what this file no longer does.

---

## Summary

<!-- port-catalog:summary:start -->

| # | Table | Port(s) | Explicit indexes |
|---|-------|---------|------------------|
| 1 | `activity_log` | `activitylog` | `activity_log_subject_idx`, `activity_log_causer_idx` |
| 2 | `agent_conversations` | `ai-sdk` | — |
| 3 | `agent_conversation_messages` | `ai-sdk` | `agent_conversation_messages_conv_idx` |
| 4 | `cache_response` | kernel `response-cache` | — |
| 5 | `lemon_squeezy_customers` | `lemonsqueezy` | — |
| 6 | `lemon_squeezy_license_keys` | `lemonsqueezy` | — |
| 7 | `lemon_squeezy_orders` | `lemonsqueezy` | — |
| 8 | `lemon_squeezy_subscriptions` | `lemonsqueezy` | — |
| 9 | `lw_dtos` | `spatie-data` | — |
| 10 | `lw_oauth_state` | kernel `socialite` | — |
| 11 | `lw_settings` | `spatie-settings` | — |
| 12 | `lw_webhook_events` | kernel `webhook` | — |
| 13 | `model_has_permissions` | `permission` | — |
| 14 | `model_has_roles` | `permission` | — |
| 15 | `oauth_access_tokens` | `passport-oauth` | — |
| 16 | `oauth_auth_codes` | `passport-oauth` | — |
| 17 | `oauth_clients` | `passport-oauth` | — |
| 18 | `oauth_refresh_tokens` | `passport-oauth` | — |
| 19 | `permissions` | `permission` | — |
| 20 | `personal_access_tokens` | `laravel-socialite-callback`, `sanctum` | — |
| 21 | `posts` | `spatie-query-builder` | — |
| 22 | `pulse_aggregates` | `pulse` | — |
| 23 | `pulse_entries` | `pulse` | `pulse_entries_recorded_at_idx` |
| 24 | `pusher_events` | `pusher` | — |
| 25 | `role_has_permissions` | `permission` | — |
| 26 | `roles` | `permission` | — |
| 27 | `sessions` | `sanctum-spa-cookie` | — |
| 28 | `scout_search_log` | `scout-meilisearch` | — |
| 29 | `sitemap_urls` | `spatie-sitemap` | — |
| 30 | `slugs` | `sluggable` | — |
| 31 | `state_models` | `spatie-model-states` | — |
| 32 | `subscription_items` | `cashier-stripe` | — |
| 33 | `subscriptions` | `cashier-stripe` | — |
| 34 | `taggables` | `tags` | — |
| 35 | `tags` | `tags` | — |
| 36 | `translatable_posts` | `spatie-translatable` | — |
| 37 | `users` (6 variants) | `fortify-confirmation`, `fortify-two-factor`, `jwt-auth`, `laravel-socialite-callback`, `maatwebsite-excel`, `sanctum-spa-cookie`, `sanctum` | — |
| 38 | `webhook_calls` (2 variants) | `webhook-client`, `webhook-server` | — |
| 39 | `webpush_subscriptions` | `webpush-notification` | `webpush_subscriptions_endpoint_idx` |
| 40 | `paddle_customers` | `cashier-paddle` | — |
| 41 | `paddle_subscriptions` | `cashier-paddle` | — |
| 42 | `paddle_transactions` | `cashier-paddle` | — |
| 43 | `channel_memberships` | `echo` | — |
| 44 | `invoices` | `xendit-webhook` | — |
| 45 | `job_metrics` | `horizon-metrics` | `job_metrics_queue_idx` |
| 46 | `mollie_payments` | `mollie-webhook` | — |
| 47 | `tenants` | `multitenancy` | — |
| 48 | `transactions` | `midtrans-webhook` | — |

<!-- port-catalog:summary:end -->

---

## Catalog

### 1. `activity_log`
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
    )
CREATE INDEX IF NOT EXISTS activity_log_subject_idx
     ON activity_log (subject_type, subject_id)
CREATE INDEX IF NOT EXISTS activity_log_causer_idx
     ON activity_log (causer_type, causer_id)
```

### 2. `agent_conversations`
Port: `ai-sdk` (`POST /ai/chat`) — one row per AI conversation session, holding the chosen provider + model.

```sql
CREATE TABLE IF NOT EXISTS agent_conversations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       provider TEXT NOT NULL,
       model TEXT NOT NULL,
       created_at TEXT NOT NULL
     )
```

### 3. `agent_conversation_messages`
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
     )
CREATE INDEX IF NOT EXISTS agent_conversation_messages_conv_idx
       ON agent_conversation_messages (conversation_id)
```

### 4. `cache_response`
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

### 5. `lemon_squeezy_customers`
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
  )
```

### 6. `lemon_squeezy_license_keys`
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
  )
```

### 7. `lemon_squeezy_orders`
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
  )
```

### 8. `lemon_squeezy_subscriptions`
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
  )
```

### 9. `lw_dtos`
Port: `spatie-data` — demo store for spatie/laravel-data DTO serialisation round-trips.

```sql
CREATE TABLE IF NOT EXISTS lw_dtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      age INTEGER,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
```

### 10. `lw_oauth_state`
Kernel: `socialite` — OAuth `state` nonces for Laravel Socialite CSRF verification.

```sql
CREATE TABLE IF NOT EXISTS lw_oauth_state (
      state TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
```

### 11. `lw_settings`
Port: `spatie-settings` — typed key/value settings store for spatie/laravel-settings.

```sql
CREATE TABLE IF NOT EXISTS lw_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "group" TEXT NOT NULL,
      key TEXT NOT NULL,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE ("group", key)
    )
```

### 12. `lw_webhook_events`
Ports: `cashier-paddle`, `cashier-stripe`, `lemonsqueezy` — shared dedupe ledger of incoming billing webhooks (guards replay/double-processing).

```sql
CREATE TABLE IF NOT EXISTS lw_webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    type TEXT,
    payload TEXT,
    received_at TEXT
  )
```

### 13. `model_has_permissions`
Port: `permission` — spatie/laravel-permission polymorphic model↔permission pivot.

```sql
CREATE TABLE IF NOT EXISTS model_has_permissions (
    permission_id INTEGER NOT NULL,
    model_type TEXT NOT NULL,
    model_key TEXT NOT NULL,
    UNIQUE (permission_id, model_type, model_key)
  )
```

### 14. `model_has_roles`
Port: `permission` — spatie/laravel-permission polymorphic model↔role pivot.

```sql
CREATE TABLE IF NOT EXISTS model_has_roles (
    role_id INTEGER NOT NULL,
    model_type TEXT NOT NULL,
    model_key TEXT NOT NULL,
    UNIQUE (role_id, model_type, model_key)
  )
```

### 15. `oauth_access_tokens`
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
    )
```

### 16. `oauth_auth_codes`
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
    )
```

### 17. `oauth_clients`
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
    )
```

### 18. `oauth_refresh_tokens`
Port: `passport-oauth` — Passport refresh tokens tied to an access token.

```sql
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      id TEXT PRIMARY KEY,
      access_token_id INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT
    )
```

### 19. `permissions`
Port: `permission` — spatie/laravel-permission named permissions per guard.

```sql
CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    guard_name TEXT NOT NULL DEFAULT 'web',
    UNIQUE (name, guard_name)
  )
```

### 20. `personal_access_tokens`
Ports: `sanctum` and `laravel-socialite-callback` — both run the **same** statement (Sanctum's migration verbatim, `created_at`/`updated_at` included), so whichever port calls `ensureSchema()` first provisions the table both then insert into. `sanctum` writes seven columns and updates two of them; the socialite port inserts five and leaves the timestamps NULL.

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
  )
```

### 21. `posts`
Port: `spatie-query-builder` — demo posts for filtering/sorting via spatie/laravel-query-builder.

```sql
CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
```

### 22. `pulse_aggregates`
Port: `pulse` (`GET /pulse`) — pre-aggregated Pulse metrics per period/path (requests, errors, avg duration).

```sql
CREATE TABLE IF NOT EXISTS pulse_aggregates (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       period TEXT NOT NULL,
       path TEXT,
       requests INTEGER NOT NULL DEFAULT 0,
       errors INTEGER NOT NULL DEFAULT 0,
       avg_duration REAL
     )
```

### 23. `pulse_entries`
Port: `pulse` (`POST /pulse/record`, `GET /pulse`) — raw Pulse entries (one request/error datapoint per row).

```sql
CREATE TABLE IF NOT EXISTS pulse_entries (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       type TEXT NOT NULL,
       path TEXT,
       status INTEGER,
       duration_ms REAL,
       recorded_at TEXT NOT NULL
     )
CREATE INDEX IF NOT EXISTS pulse_entries_recorded_at_idx
     ON pulse_entries (recorded_at)
```

### 24. `pusher_events`
Port: `pusher` — persisted broadcast events for the Pusher channel fallback.

```sql
CREATE TABLE IF NOT EXISTS pusher_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      name TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
```

### 25. `role_has_permissions`
Port: `permission` — spatie/laravel-permission role↔permission pivot.

```sql
CREATE TABLE IF NOT EXISTS role_has_permissions (
    permission_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    PRIMARY KEY (permission_id, role_id)
  )
```

### 26. `roles`
Port: `permission` — spatie/laravel-permission named roles per guard.

```sql
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    guard_name TEXT NOT NULL DEFAULT 'web',
    UNIQUE (name, guard_name)
  )
```

### 27. `sessions`
Port: `sanctum-spa-cookie` — server-side session rows carrying the CSRF token for SPA-cookie auth.

```sql
CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      csrf_token TEXT NOT NULL,
      created_at TEXT,
      last_activity TEXT
    )
```

### 28. `scout_search_log`
Port: `scout-meilisearch` — search-query log (index + query + hit count) for Scout Meilisearch.

```sql
CREATE TABLE IF NOT EXISTS scout_search_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      index_uid TEXT NOT NULL,
      q TEXT,
      hits INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
```

### 29. `sitemap_urls`
Port: `spatie-sitemap` — URLs tracked for sitemap generation via spatie/laravel-sitemap.

```sql
CREATE TABLE IF NOT EXISTS sitemap_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loc TEXT NOT NULL UNIQUE,
      lastmod TEXT NOT NULL,
      changefreq TEXT,
      priority TEXT
    )
```

### 30. `slugs`
Port: `sluggable` — slug history per (table, column) for spatie/laravel-sluggable.

```sql
CREATE TABLE IF NOT EXISTS slugs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug_table TEXT NOT NULL,
      slug_column TEXT NOT NULL,
      slug TEXT NOT NULL,
      source TEXT,
      UNIQUE (slug_table, slug_column, slug)
    )
```

### 31. `state_models`
Port: `spatie-model-states` — demo models whose `state` column is a validated state-machine value.

```sql
CREATE TABLE IF NOT EXISTS state_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
```

### 32. `subscription_items`
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
  )
```

### 33. `subscriptions`
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
  )
```

### 34. `taggables`
Port: `tags` — spatie/laravel-tags polymorphic tag↔model pivot.

```sql
CREATE TABLE IF NOT EXISTS taggables (
      tag_id INTEGER NOT NULL,
      taggable_type TEXT NOT NULL,
      taggable_id TEXT NOT NULL,
      UNIQUE (tag_id, taggable_type, taggable_id)
    )
```

### 35. `tags`
Port: `tags` — spatie/laravel-tags named tags per type.

```sql
CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      type TEXT,
      order_column INTEGER NOT NULL DEFAULT 0,
      UNIQUE (slug, type)
    )
```

### 36. `translatable_posts`
Port: `spatie-translatable` — demo posts storing per-locale JSON strings for spatie/laravel-translatable.

```sql
CREATE TABLE IF NOT EXISTS translatable_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '{}',
      body TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
```

### 37. `users` (6 variants)
The `users` table is created independently by seven auth ports, each provisioning its own demo shape — six distinct statements, since `sanctum` and `jwt-auth` carry the same one. `IF NOT EXISTS` means whichever port runs first on a fresh DB wins; the others become no-ops. Documented as separate variants:

**(a) `sanctum`**
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL
);
```

**(b) `sanctum-spa-cookie`**
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password TEXT
);
```

**(c) `fortify-confirmation`**
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

**(d) `fortify-two-factor`**
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

**(e) `laravel-socialite-callback`** (provider-linked users)
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

**(f) `maatwebsite-excel`** (demo export source)
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT
);
```

**(g) `jwt-auth`** (`POST /auth/jwt/login`, `GET /auth/jwt/user`, byte-identical to `sanctum`'s statement)
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL
);
```

### 38. `webhook_calls` (2 variants)
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

### 39. `webpush_subscriptions`
Port: `webpush-notification` (`POST /notify/webpush`, `POST /webpush/subscribe`) — Web Push VAPID endpoint subscriptions (endpoint + client keys).

```sql
CREATE TABLE IF NOT EXISTS webpush_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT
    )
CREATE INDEX IF NOT EXISTS webpush_subscriptions_endpoint_idx ON webpush_subscriptions (endpoint)
```

### 40. `paddle_customers`
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
  )
```

### 41. `paddle_subscriptions`
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
  )
```

### 42. `paddle_transactions`
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
  )
```

### 43. `channel_memberships`
Port: `echo` — the edge's stand-in for `Broadcast::channel()`: one row per (user, channel) pair the broadcast-auth endpoint may authorize.

```sql
CREATE TABLE IF NOT EXISTS channel_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
```

### 44. `invoices`
Port: `xendit-webhook` — every accepted Xendit invoice callback, stored so a re-delivered callback is idempotent.

```sql
CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    external_id TEXT,
    status TEXT,
    created_at TEXT NOT NULL
  )
```

### 45. `job_metrics`
Port: `horizon-metrics` — one row per job event (`POST /horizon/record`), read back as the JSON summary; indexed on `queue`.

```sql
CREATE TABLE IF NOT EXISTS job_metrics (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       type TEXT NOT NULL,
       queue TEXT,
       status TEXT,
       duration_ms REAL,
       created_at TEXT NOT NULL
     )
CREATE INDEX IF NOT EXISTS job_metrics_queue_idx
     ON job_metrics (queue)
```

### 46. `mollie_payments`
Port: `mollie-webhook` — the payment state the receiver re-fetches from the Mollie API and upserts (the callback itself carries no status).

```sql
CREATE TABLE IF NOT EXISTS mollie_payments (
      id TEXT PRIMARY KEY,
      method TEXT,
      status TEXT,
      amount_value TEXT,
      amount_currency TEXT,
      customer_id TEXT,
      paid_at TEXT,
      canceled_at TEXT,
      expires_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      webhook_meta TEXT
    )
```

### 47. `tenants`
Port: `multitenancy` — the morph map's hard tenant table (key/name + a `data_json` payload): create a tenant, then resolve + boot it.

```sql
CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
```

### 48. `transactions`
Port: `midtrans-webhook` — the Midtrans notification ledger, keyed by `order_id` and written `INSERT OR IGNORE`, so a re-delivery is idempotent.

---

```sql
CREATE TABLE IF NOT EXISTS transactions (
       order_id TEXT PRIMARY KEY,
       status TEXT NOT NULL,
       gross_amount TEXT NOT NULL,
       payment_type TEXT,
       updated_at TEXT NOT NULL
     )
```

## Caveats

1. **`users` shape drift.** Seven ports each `CREATE TABLE IF NOT EXISTS users` with different columns — six distinct statements (`sanctum` and `jwt-auth` carry the same one). On a fresh database the first port to call `ensureSchema()` fixes the schema; later ports silently accept it. Combining an auth port that needs `two_factor_secret` with one that only provisions `(id,name,email,password)` will leave the 2FA column missing. Use one owning port's schema, or define `users` at the app level.
2. **`webhook_calls` name collision.** `webhook-client` and `webhook-server` both create `webhook_calls` with incompatible primary keys (`TEXT` vs `INTEGER`) and column sets. Running both ports against the same D1 binding will make one of them fail at insert time. Rename one (e.g. `webhook_server_calls`) or namespace by port.
3. **`lw_webhook_events` is kernel-owned.** Kernel `webhook` is the only creator; `cashier-paddle`, `cashier-stripe` and `lemonsqueezy` insert into it as their replay guard. The Summary's `Port(s)` column lists creators, so a kernel-only row is not an omission.
4. **Best-effort indexes.** The Summary's `Explicit indexes` column is the code's own count; `ai-sdk` wraps its `CREATE INDEX` in `try/catch` so minimal SQL fakes that don't parse index DDL still persist rows.

Settled elsewhere: `personal_access_tokens` used to be a third collision — `laravel-socialite-callback` created it without `created_at`/`updated_at` while `sanctum` inserted both, so sanctum's insert failed on a database the socialite port had provisioned first. Measured on `node:sqlite` (create from the socialite DDL, then run sanctum's own INSERT → `table personal_access_tokens has no column named created_at`). The socialite port now runs the same statement as `sanctum`, and the same measurement succeeds — the Summary above counts one variant, not two.
