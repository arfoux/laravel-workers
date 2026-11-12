// tools/port-manifest.mjs — the single manifest of every package-port ROUTE.
//
// `registry.example.json` maps route PATH -> bare slug, but it carries no
// methods, secrets or D1 tables, and the ports it does not map (the new
// fleet: ai-sdk, mcp, pulse, ...) are easy to forget. This file is the one
// place that lists every route the fleet answers, with the metadata a
// deployment needs:
//   slug     — the port file under `ports/packages/<slug>.mjs`
//   methods  — the verbs the handler answers on that path (dispatch happens in
//              the port, not the registry: one entry per PATH, all verbs)
//   file     — where the handler lives (relative to the repo root)
//   d1       — D1 tables the port owns via its exported `ensureSchema`, or null
//              when it touches no table
//   secrets  — the env secrets/bindings the handler reads (`env.<NAME>`)
//
// `validateManifest()` is the cheap structural guard (every entry has the right
// shape); `missingManifestFiles()` is the one that checks the `file` slot
// resolves on disk, helpers included. `missingRegistryRoutes()` checks the other
// direction: every `registry.example.json` route is covered here. The build's own
// checks (route not in `route:list`, slug with no file) stay authoritative for
// a real deploy — this manifest is the map, not the enforcer.
//
// Sources: `ports/packages/*.mjs` headers (Route wiring blocks) + the
// `env.<NAME>` accesses in their bodies + the `ensureSchema` CREATE TABLEs.
// `docs/PACKAGE-PORTS.md` documents the secrets table and the one route
// collision (`/broadcasting/auth`, pusher vs reverb).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Ports that answer NO fixed path — the registry maps them to a slug with no
// route key (middleware/header helpers, the Inertia page renderer). Kept here
// so the manifest is the complete port inventory, but they carry no route.
const NON_ROUTE_PORTS = {
  'csp-middleware': { slug: 'csp-middleware', methods: [], file: 'ports/packages/csp-middleware.mjs', d1: null, secrets: ['CSP_POLICY'] },
  'honeypot-middleware': { slug: 'honeypot-middleware', methods: [], file: 'ports/packages/honeypot-middleware.mjs', d1: null, secrets: ['HONEYPOT_MIN_DELTA_MS'] },
  'response-cache': { slug: 'response-cache', methods: [], file: 'ports/packages/response-cache.mjs', d1: null, secrets: [] },
  inertia: { slug: 'inertia', methods: [], file: 'ports/packages/inertia.mjs', d1: null, secrets: ['APP_VERSION', 'INERTIA_VERSION'] },
};

export const PORT_MANIFEST = {
  // -- spatie / misc -------------------------------------------------------
  '/sitemap.xml': { slug: 'spatie-sitemap', methods: ['GET'], file: 'ports/packages/spatie-sitemap.mjs', d1: ['sitemap_urls'], secrets: [] },
  '/sitemap': { slug: 'spatie-sitemap', methods: ['GET', 'POST', 'DELETE'], file: 'ports/packages/spatie-sitemap.mjs', d1: ['sitemap_urls'], secrets: [] },
  '/settings/{group}': { slug: 'spatie-settings', methods: ['GET', 'PUT'], file: 'ports/packages/spatie-settings.mjs', d1: ['lw_settings'], secrets: [] },
  '/activity': { slug: 'activitylog', methods: ['GET', 'POST'], file: 'ports/packages/activitylog.mjs', d1: ['activity_log'], secrets: [] },
  '/activity/{id}': { slug: 'activitylog', methods: ['GET'], file: 'ports/packages/activitylog.mjs', d1: ['activity_log'], secrets: [] },
  '/slug': { slug: 'sluggable', methods: ['GET', 'POST'], file: 'ports/packages/sluggable.mjs', d1: ['slugs'], secrets: [] },
  '/data': { slug: 'spatie-data', methods: ['POST'], file: 'ports/packages/spatie-data.mjs', d1: ['lw_dtos'], secrets: [] },
  '/posts': { slug: 'spatie-query-builder', methods: ['GET'], file: 'ports/packages/spatie-query-builder.mjs', d1: ['posts'], secrets: [] },
  '/translatable': { slug: 'spatie-translatable', methods: ['GET', 'POST'], file: 'ports/packages/spatie-translatable.mjs', d1: ['translatable_posts'], secrets: [] },
  '/translatable/{id}': { slug: 'spatie-translatable', methods: ['GET', 'PUT'], file: 'ports/packages/spatie-translatable.mjs', d1: ['translatable_posts'], secrets: [] },
  '/enums': { slug: 'spatie-enum', methods: ['GET'], file: 'ports/packages/spatie-enum.mjs', d1: null, secrets: [] },
  '/enums/{class}': { slug: 'spatie-enum', methods: ['GET'], file: 'ports/packages/spatie-enum.mjs', d1: null, secrets: [] },
  '/enums/{class}/from': { slug: 'spatie-enum', methods: ['POST'], file: 'ports/packages/spatie-enum.mjs', d1: null, secrets: [] },
  '/enums/{class}/tryFrom': { slug: 'spatie-enum', methods: ['POST'], file: 'ports/packages/spatie-enum.mjs', d1: null, secrets: [] },
  '/enums/{class}/random': { slug: 'spatie-enum', methods: ['GET'], file: 'ports/packages/spatie-enum.mjs', d1: null, secrets: [] },
  '/state-models': { slug: 'spatie-model-states', methods: ['GET', 'POST'], file: 'ports/packages/spatie-model-states.mjs', d1: ['state_models'], secrets: [] },
  '/state-models/{id}': { slug: 'spatie-model-states', methods: ['GET'], file: 'ports/packages/spatie-model-states.mjs', d1: ['state_models'], secrets: [] },
  '/state-models/{id}/transition': { slug: 'spatie-model-states', methods: ['POST'], file: 'ports/packages/spatie-model-states.mjs', d1: ['state_models'], secrets: [] },
  '/state-models/{id}/transitions': { slug: 'spatie-model-states', methods: ['GET'], file: 'ports/packages/spatie-model-states.mjs', d1: ['state_models'], secrets: [] },

  // -- scout / search ------------------------------------------------------
  '/search': { slug: 'scout-meilisearch', methods: ['GET'], file: 'ports/packages/scout-meilisearch.mjs', d1: ['scout_search_log'], secrets: ['MEILISEARCH_HOST', 'MEILISEARCH_KEY'] },
  '/indexes/{uid}/search': { slug: 'scout-meilisearch', methods: ['GET'], file: 'ports/packages/scout-meilisearch.mjs', d1: ['scout_search_log'], secrets: ['MEILISEARCH_HOST', 'MEILISEARCH_KEY'] },
  '/indexes/{uid}/settings': { slug: 'scout-meilisearch', methods: ['GET'], file: 'ports/packages/scout-meilisearch.mjs', d1: ['scout_search_log'], secrets: ['MEILISEARCH_HOST', 'MEILISEARCH_KEY'] },
  '/1/indexes/{name}/query': { slug: 'scout-algolia', methods: ['POST'], file: 'ports/packages/scout-algolia.mjs', d1: null, secrets: ['ALGOLIA_APP_ID', 'ALGOLIA_KEY'] },

  // -- sanctum / fortify ---------------------------------------------------
  '/sanctum/token': { slug: 'sanctum', methods: ['POST'], file: 'ports/packages/sanctum.mjs', d1: ['personal_access_tokens', 'users'], secrets: [] },
  '/sanctum/verify': { slug: 'sanctum', methods: ['GET'], file: 'ports/packages/sanctum.mjs', d1: ['personal_access_tokens', 'users'], secrets: [] },
  '/sanctum/tokens': { slug: 'sanctum', methods: ['GET', 'DELETE'], file: 'ports/packages/sanctum.mjs', d1: ['personal_access_tokens', 'users'], secrets: [] },
  '/sanctum/tokens/{id}': { slug: 'sanctum', methods: ['DELETE'], file: 'ports/packages/sanctum.mjs', d1: ['personal_access_tokens', 'users'], secrets: [] },
  '/sanctum/csrf-cookie': { slug: 'sanctum-spa-cookie', methods: ['GET'], file: 'ports/packages/sanctum-spa-cookie.mjs', d1: ['users', 'sessions'], secrets: ['APP_KEY'] },
  '/sanctum/spa/login': { slug: 'sanctum-spa-cookie', methods: ['POST'], file: 'ports/packages/sanctum-spa-cookie.mjs', d1: ['users', 'sessions'], secrets: ['APP_KEY'] },
  '/sanctum/spa/user': { slug: 'sanctum-spa-cookie', methods: ['GET'], file: 'ports/packages/sanctum-spa-cookie.mjs', d1: ['users', 'sessions'], secrets: ['APP_KEY'] },
  '/sanctum/spa/logout': { slug: 'sanctum-spa-cookie', methods: ['POST'], file: 'ports/packages/sanctum-spa-cookie.mjs', d1: ['users', 'sessions'], secrets: ['APP_KEY'] },
  '/user/confirm-password': { slug: 'fortify-confirmation', methods: ['POST', 'GET'], file: 'ports/packages/fortify-confirmation.mjs', d1: ['users'], secrets: ['APP_KEY', 'SESSION_SECRET', 'APP_URL'] },
  '/user/confirm-password/status': { slug: 'fortify-confirmation', methods: ['GET'], file: 'ports/packages/fortify-confirmation.mjs', d1: ['users'], secrets: ['APP_KEY', 'SESSION_SECRET', 'APP_URL'] },
  '/email/verification-notification': { slug: 'fortify-confirmation', methods: ['POST'], file: 'ports/packages/fortify-confirmation.mjs', d1: ['users'], secrets: ['APP_KEY', 'SESSION_SECRET', 'APP_URL'] },
  '/email/verify/{id}/{hash}': { slug: 'fortify-confirmation', methods: ['GET'], file: 'ports/packages/fortify-confirmation.mjs', d1: ['users'], secrets: ['APP_KEY', 'SESSION_SECRET', 'APP_URL'] },
  '/user/two-factor-authentication': { slug: 'fortify-two-factor', methods: ['POST'], file: 'ports/packages/fortify-two-factor.mjs', d1: ['users'], secrets: [] },
  '/user/two-factor-authentication/confirm': { slug: 'fortify-two-factor', methods: ['POST'], file: 'ports/packages/fortify-two-factor.mjs', d1: ['users'], secrets: [] },
  '/user/two-factor-challenge': { slug: 'fortify-two-factor', methods: ['POST'], file: 'ports/packages/fortify-two-factor.mjs', d1: ['users'], secrets: [] },
  '/user/two-factor-challenge/recovery': { slug: 'fortify-two-factor', methods: ['POST'], file: 'ports/packages/fortify-two-factor.mjs', d1: ['users'], secrets: [] },

  // -- social / oauth / billing -------------------------------------------
  '/auth/{provider}/redirect': { slug: 'laravel-socialite-redirect', methods: ['GET'], file: 'ports/packages/laravel-socialite-redirect.mjs', d1: null, secrets: ['<PROVIDER>_CLIENT_ID', '<PROVIDER>_CLIENT_SECRET', '<PROVIDER>_REDIRECT'] },
  '/auth/{provider}/callback': { slug: 'laravel-socialite-callback', methods: ['GET'], file: 'ports/packages/laravel-socialite-callback.mjs', d1: ['users', 'personal_access_tokens'], secrets: ['<PROVIDER>_CLIENT_ID', '<PROVIDER>_CLIENT_SECRET', '<PROVIDER>_REDIRECT'] },
  '/oauth/authorize': { slug: 'passport-oauth', methods: ['GET'], file: 'ports/packages/passport-oauth.mjs', d1: ['oauth_clients', 'oauth_auth_codes', 'oauth_access_tokens', 'oauth_refresh_tokens'], secrets: ['PASSPORT_PRIVATE_KEY', 'PASSPORT_PUBLIC_KEY', 'PASSPORT_KEY_ID'] },
  '/oauth/token': { slug: 'passport-oauth', methods: ['POST'], file: 'ports/packages/passport-oauth.mjs', d1: ['oauth_clients', 'oauth_auth_codes', 'oauth_access_tokens', 'oauth_refresh_tokens'], secrets: ['PASSPORT_PRIVATE_KEY', 'PASSPORT_PUBLIC_KEY', 'PASSPORT_KEY_ID'] },
  '/oauth/refresh': { slug: 'passport-oauth', methods: ['POST'], file: 'ports/packages/passport-oauth.mjs', d1: ['oauth_clients', 'oauth_auth_codes', 'oauth_access_tokens', 'oauth_refresh_tokens'], secrets: ['PASSPORT_PRIVATE_KEY', 'PASSPORT_PUBLIC_KEY', 'PASSPORT_KEY_ID'] },
  '/oauth/jwks': { slug: 'passport-oauth', methods: ['GET'], file: 'ports/packages/passport-oauth.mjs', d1: ['oauth_clients', 'oauth_auth_codes', 'oauth_access_tokens', 'oauth_refresh_tokens'], secrets: ['PASSPORT_PRIVATE_KEY', 'PASSPORT_PUBLIC_KEY', 'PASSPORT_KEY_ID'] },
  '/stripe/webhook': { slug: 'cashier-stripe', methods: ['POST'], file: 'ports/packages/cashier-stripe.mjs', d1: ['lw_webhook_events', 'subscriptions', 'subscription_items'], secrets: ['STRIPE_WEBHOOK_SECRET'] },
  '/paddle/webhook': { slug: 'cashier-paddle', methods: ['POST'], file: 'ports/packages/cashier-paddle.mjs', d1: ['lw_webhook_events', 'paddle_customers', 'paddle_subscriptions', 'paddle_transactions'], secrets: ['PADDLE_WEBHOOK_SECRET'] },
  '/lemon-squeezy/webhook': { slug: 'lemonsqueezy', methods: ['POST'], file: 'ports/packages/lemonsqueezy.mjs', d1: ['lw_webhook_events', 'lemon_squeezy_customers', 'lemon_squeezy_subscriptions', 'lemon_squeezy_orders', 'lemon_squeezy_license_keys'], secrets: ['LEMON_SQUEEZY_WEBHOOK_SECRET'] },

  // -- realtime / permission / tags ---------------------------------------
  '/broadcast': { slug: 'pusher', methods: ['POST'], file: 'ports/packages/pusher.mjs', d1: ['pusher_events'], secrets: ['PUSHER_APP_ID', 'PUSHER_KEY', 'PUSHER_SECRET', 'PUSHER_CLUSTER'] },
  '/broadcasting/auth': { slug: 'reverb', methods: ['POST'], file: 'ports/packages/reverb.mjs', d1: null, secrets: ['REVERB_KEY', 'REVERB_SECRET'] },
  '/model/{modelType}/{modelKey}/has-role': { slug: 'permission', methods: ['GET'], file: 'ports/packages/permission.mjs', d1: ['roles', 'permissions', 'model_has_roles', 'model_has_permissions', 'role_has_permissions'], secrets: [] },
  '/model/{modelType}/{modelKey}/has-permission': { slug: 'permission', methods: ['GET'], file: 'ports/packages/permission.mjs', d1: ['roles', 'permissions', 'model_has_roles', 'model_has_permissions', 'role_has_permissions'], secrets: [] },
  '/model/{modelType}/{modelKey}/has-any': { slug: 'permission', methods: ['GET'], file: 'ports/packages/permission.mjs', d1: ['roles', 'permissions', 'model_has_roles', 'model_has_permissions', 'role_has_permissions'], secrets: [] },
  '/model/{modelType}/{modelKey}/roles/{action}': { slug: 'permission', methods: ['POST'], file: 'ports/packages/permission.mjs', d1: ['roles', 'permissions', 'model_has_roles', 'model_has_permissions', 'role_has_permissions'], secrets: [] },
  '/model/{modelType}/{modelKey}/permissions/{action}': { slug: 'permission', methods: ['POST'], file: 'ports/packages/permission.mjs', d1: ['roles', 'permissions', 'model_has_roles', 'model_has_permissions', 'role_has_permissions'], secrets: [] },
  '/model/{modelType}/{modelKey}/tags': { slug: 'tags', methods: ['GET', 'POST'], file: 'ports/packages/tags.mjs', d1: ['tags', 'taggables'], secrets: [] },

  // -- export / notify-http ------------------------------------------------
  '/export': { slug: 'maatwebsite-excel', methods: ['GET'], file: 'ports/packages/maatwebsite-excel.mjs', d1: null, secrets: [] },
  '/notify/mailgun': { slug: 'mailgun-mail', methods: ['POST'], file: 'ports/packages/mailgun-mail.mjs', d1: null, secrets: ['MAILGUN_DOMAIN', 'MAILGUN_SECRET'] },
  '/notify/postmark': { slug: 'postmark-mail', methods: ['POST'], file: 'ports/packages/postmark-mail.mjs', d1: null, secrets: ['POSTMARK_TOKEN'] },
  '/notify/slack': { slug: 'slack-notification', methods: ['POST'], file: 'ports/packages/slack-notification.mjs', d1: null, secrets: ['SLACK_WEBHOOK_URL', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL'] },
  '/notify/twilio': { slug: 'twilio-sms', methods: ['POST'], file: 'ports/packages/twilio-sms.mjs', d1: null, secrets: ['TWILIO_SID', 'TWILIO_TOKEN', 'TWILIO_FROM'] },

  // -- new fleet: ai / mcp / observability --------------------------------
  '/ai/chat': { slug: 'ai-sdk', methods: ['POST'], file: 'ports/packages/ai-sdk.mjs', d1: ['agent_conversations', 'agent_conversation_messages'], secrets: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY'] },
  '/mcp': { slug: 'mcp', methods: ['POST'], file: 'ports/packages/mcp.mjs', d1: null, secrets: [] },
  '/pulse': { slug: 'pulse', methods: ['GET'], file: 'ports/packages/pulse.mjs', d1: ['pulse_entries', 'pulse_aggregates'], secrets: [] },
  '/pulse/record': { slug: 'pulse', methods: ['POST'], file: 'ports/packages/pulse.mjs', d1: ['pulse_entries', 'pulse_aggregates'], secrets: [] },
  '/bugsnag/notify': { slug: 'bugsnag', methods: ['POST'], file: 'ports/packages/bugsnag.mjs', d1: null, secrets: ['BUGSNAG_API_KEY'] },

  // -- new fleet: webhooks / search ---------------------------------------
  '/webhooks/{name}': { slug: 'webhook-client', methods: ['POST'], file: 'ports/packages/webhook-client.mjs', d1: ['webhook_calls'], secrets: ['WEBHOOK_CLIENT_SECRET'] },
  '/webhook-server/send': { slug: 'webhook-server', methods: ['POST'], file: 'ports/packages/webhook-server.mjs', d1: ['webhook_calls'], secrets: ['WEBHOOK_SERVER_SECRET'] },
  '/site-search': { slug: 'site-search', methods: ['GET'], file: 'ports/packages/site-search.mjs', d1: null, secrets: ['MEILISEARCH_HOST', 'MEILISEARCH_KEY'] },

  // -- new fleet: notification channels -----------------------------------
  '/notify/telegram': { slug: 'telegram-notification', methods: ['POST'], file: 'ports/packages/telegram-notification.mjs', d1: null, secrets: ['TELEGRAM_BOT_TOKEN'] },
  '/notify/discord': { slug: 'discord-notification', methods: ['POST'], file: 'ports/packages/discord-notification.mjs', d1: null, secrets: ['DISCORD_WEBHOOK_URL', 'DISCORD_BOT_TOKEN'] },
  '/notify/expo': { slug: 'expo-notification', methods: ['POST'], file: 'ports/packages/expo-notification.mjs', d1: null, secrets: ['EXPO_ACCESS_TOKEN'] },
  '/notify/fcm': { slug: 'fcm-notification', methods: ['POST'], file: 'ports/packages/fcm-notification.mjs', d1: null, secrets: ['FCM_SERVICE_ACCOUNT_JSON', 'FCM_PROJECT_ID'] },
  '/notify/webpush': { slug: 'webpush-notification', methods: ['POST'], file: 'ports/packages/webpush-notification.mjs', d1: ['webpush_subscriptions'], secrets: ['WEBPUSH_VAPID_PRIVATE_KEY', 'WEBPUSH_VAPID_SUBJECT'] },
  '/webpush/subscribe': { slug: 'webpush-notification', methods: ['POST'], file: 'ports/packages/webpush-notification.mjs', d1: ['webpush_subscriptions'], secrets: ['WEBPUSH_VAPID_PRIVATE_KEY', 'WEBPUSH_VAPID_SUBJECT'] },
  '/notify/onesignal': { slug: 'onesignal-notification', methods: ['POST'], file: 'ports/packages/onesignal-notification.mjs', d1: null, secrets: ['ONESIGNAL_APP_ID', 'ONESIGNAL_REST_API_KEY'] },

  // -- new fleet: auth extras / media -------------------------------------
  '/auth/jwt/login': { slug: 'jwt-auth', methods: ['POST'], file: 'ports/packages/jwt-auth.mjs', d1: ['users'], secrets: ['JWT_SECRET'] },
  '/auth/jwt/user': { slug: 'jwt-auth', methods: ['GET'], file: 'ports/packages/jwt-auth.mjs', d1: ['users'], secrets: ['JWT_SECRET'] },
  '/auth/firebase/verify': { slug: 'firebase-php-jwt', methods: ['POST'], file: 'ports/packages/firebase-php-jwt.mjs', d1: null, secrets: ['FIREBASE_PROJECT_ID', 'FIREBASE_JWKS_URL'] },
  '/auth/auth0/callback': { slug: 'auth0', methods: ['POST'], file: 'ports/packages/auth0.mjs', d1: null, secrets: ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'AUTH0_REDIRECT_URI'] },
  '/img/{path}': { slug: 'glide', methods: ['GET'], file: 'ports/packages/glide.mjs', d1: null, secrets: ['CF_IMAGE_RESIZING_ZONE', 'GLIDE_ORIGIN'] },

  // -- non-route ports (helpers / page renderer), keyed by slug ------------
  ...NON_ROUTE_PORTS,
};

export const REGISTRY_EXAMPLE_PATH = 'registry.example.json';

/**
 * The registry paths NOT covered by PORT_MANIFEST (empty when in sync).
 * @param {Record<string, string>} registry a `registry.example.json` `ports` map
 * @returns {{ path: string, slug: string }[]}
 */
export function missingRegistryRoutes(registry) {
  return Object.entries(registry)
    .filter(([route]) => !(route in PORT_MANIFEST))
    .map(([route, slug]) => ({ path: route, slug }));
}

/**
 * The manifest routes whose port file is missing on disk.
 * @param {string} [repoRoot] override (tests pass the real root)
 * @returns {{ route: string, file: string }[]}
 */
export function missingManifestFiles(repoRoot = REPO_ROOT) {
  // Every entry is checked, helpers included: a helper carries `methods: []` but
  // still names a `file`, so gating on methods would let a helper whose handler
  // moved keep a stale `file` slot uncounted.
  return Object.entries(PORT_MANIFEST)
    .filter(([, entry]) => !existsSync(resolve(repoRoot, entry.file)))
    .map(([route, entry]) => ({ route, file: entry.file }));
}

/**
 * Structural check: every manifest entry has a slug, a file, a method array
 * (route ports) or an empty one (helpers), and string[] d1/secrets.
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateManifest() {
  const problems = [];
  for (const [route, entry] of Object.entries(PORT_MANIFEST)) {
    const label = entry.slug === route ? `port ${route}` : route;
    if (typeof entry.slug !== 'string' || !entry.slug) problems.push(`${label}: missing slug`);
    if (typeof entry.file !== 'string' || !entry.file) problems.push(`${label}: missing file`);
    if (!Array.isArray(entry.methods)) problems.push(`${label}: methods is not an array`);
    else if (!entry.methods.every((m) => typeof m === 'string' && m.length > 0)) {
      problems.push(`${label}: methods holds a non-string`);
    }
    if (entry.d1 !== null && !Array.isArray(entry.d1)) problems.push(`${label}: d1 must be an array or null`);
    if (!Array.isArray(entry.secrets)) problems.push(`${label}: secrets is not an array`);
    if (!/^ports\/packages\/[a-z0-9-]+\.mjs$/.test(entry.file)) {
      problems.push(`${label}: file is not a ports/packages slug file`);
    }
  }
  return { ok: problems.length === 0, problems };
}
