// tools/port-manifest.mjs — the single manifest of every package-port ROUTE.
//
// `registry.example.json` maps route PATH -> bare slug, but it carries no
// methods or file, and the ports it does not map (the new fleet: ai-sdk, mcp,
// pulse, ...) are easy to forget. This file is the one place that lists every
// route the fleet answers, with the metadata a deployment needs:
//   slug     — the port file under `ports/packages/<slug>.mjs`
//   methods  — the verbs the handler answers on that path (dispatch happens in
//              the port, not the registry: one entry per PATH, all verbs)
//   file     — where the handler lives (relative to the repo root)
//
// What a route READS from `env` and which D1 tables it touches is deliberately
// NOT listed here. Those two inventories already have one owner: the port
// sources, compiled by `tools/port-catalog.mjs` into `docs/ENV-SECRETS.md` and
// `docs/D1-SCHEMA.md` and gated by `port-catalog --check`. A hand-written copy
// lived in this file until 2026-11-14 and had already drifted in 27 of its 85
// entries (`POSTMARK_STREAM`, `SESSION_SECRET`, `MCP_TOOLS`, `SCOUT_INDEX`, ...
// were read by the code and never declared; `lw_webhook_events` was declared
// against a "tables the port owns" definition while the kernel creates it).
// One inventory, one owner - do not re-list them here.
//
// `validateManifest()` is the cheap structural guard (every entry has the right
// shape); `missingManifestFiles()` is the one that checks the `file` slot
// resolves on disk, helpers included. `missingRegistryRoutes()` checks the other
// direction: every `registry.example.json` route is covered here. The build's own
// checks (route not in `route:list`, slug with no file) stay authoritative for
// a real deploy — this manifest is the map, not the enforcer.
//
// Sources: `ports/packages/*.mjs` headers (Route wiring blocks). Per-port
// secrets and the one route collision (`/broadcasting/auth`, pusher vs reverb)
// are documented in `docs/PACKAGE-PORTS.md`.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Ports that answer NO fixed path — the registry maps them to a slug with no
// route key (middleware/header helpers, the Inertia page renderer). Kept here
// so the manifest is the complete port inventory, but they carry no route.
const NON_ROUTE_PORTS = {
  'csp-middleware': { slug: 'csp-middleware', methods: [], file: 'ports/packages/csp-middleware.mjs' },
  'honeypot-middleware': { slug: 'honeypot-middleware', methods: [], file: 'ports/packages/honeypot-middleware.mjs' },
  'response-cache': { slug: 'response-cache', methods: [], file: 'ports/packages/response-cache.mjs' },
  inertia: { slug: 'inertia', methods: [], file: 'ports/packages/inertia.mjs' },
};

export const PORT_MANIFEST = {
  // -- spatie / misc -------------------------------------------------------
  '/sitemap.xml': { slug: 'spatie-sitemap', methods: ['GET'], file: 'ports/packages/spatie-sitemap.mjs' },
  '/sitemap': { slug: 'spatie-sitemap', methods: ['GET', 'POST', 'DELETE'], file: 'ports/packages/spatie-sitemap.mjs' },
  '/settings/{group}': { slug: 'spatie-settings', methods: ['GET', 'PUT'], file: 'ports/packages/spatie-settings.mjs' },
  '/activity': { slug: 'activitylog', methods: ['GET', 'POST'], file: 'ports/packages/activitylog.mjs' },
  '/activity/{id}': { slug: 'activitylog', methods: ['GET'], file: 'ports/packages/activitylog.mjs' },
  '/slug': { slug: 'sluggable', methods: ['GET', 'POST'], file: 'ports/packages/sluggable.mjs' },
  '/data': { slug: 'spatie-data', methods: ['POST'], file: 'ports/packages/spatie-data.mjs' },
  '/posts': { slug: 'spatie-query-builder', methods: ['GET'], file: 'ports/packages/spatie-query-builder.mjs' },
  '/translatable': { slug: 'spatie-translatable', methods: ['GET', 'POST'], file: 'ports/packages/spatie-translatable.mjs' },
  '/translatable/{id}': { slug: 'spatie-translatable', methods: ['GET', 'PUT'], file: 'ports/packages/spatie-translatable.mjs' },
  '/enums': { slug: 'spatie-enum', methods: ['GET'], file: 'ports/packages/spatie-enum.mjs' },
  '/enums/{class}': { slug: 'spatie-enum', methods: ['GET'], file: 'ports/packages/spatie-enum.mjs' },
  '/enums/{class}/from': { slug: 'spatie-enum', methods: ['POST'], file: 'ports/packages/spatie-enum.mjs' },
  '/enums/{class}/tryFrom': { slug: 'spatie-enum', methods: ['POST'], file: 'ports/packages/spatie-enum.mjs' },
  '/enums/{class}/random': { slug: 'spatie-enum', methods: ['GET'], file: 'ports/packages/spatie-enum.mjs' },
  '/state-models': { slug: 'spatie-model-states', methods: ['GET', 'POST'], file: 'ports/packages/spatie-model-states.mjs' },
  '/state-models/{id}': { slug: 'spatie-model-states', methods: ['GET'], file: 'ports/packages/spatie-model-states.mjs' },
  '/state-models/{id}/transition': { slug: 'spatie-model-states', methods: ['POST'], file: 'ports/packages/spatie-model-states.mjs' },
  '/state-models/{id}/transitions': { slug: 'spatie-model-states', methods: ['GET'], file: 'ports/packages/spatie-model-states.mjs' },

  // -- scout / search ------------------------------------------------------
  '/search': { slug: 'scout-meilisearch', methods: ['GET'], file: 'ports/packages/scout-meilisearch.mjs' },
  '/indexes/{uid}/search': { slug: 'scout-meilisearch', methods: ['GET'], file: 'ports/packages/scout-meilisearch.mjs' },
  '/indexes/{uid}/settings': { slug: 'scout-meilisearch', methods: ['GET'], file: 'ports/packages/scout-meilisearch.mjs' },
  '/1/indexes/{name}/query': { slug: 'scout-algolia', methods: ['POST'], file: 'ports/packages/scout-algolia.mjs' },

  // -- sanctum / fortify ---------------------------------------------------
  '/sanctum/token': { slug: 'sanctum', methods: ['POST'], file: 'ports/packages/sanctum.mjs' },
  '/sanctum/verify': { slug: 'sanctum', methods: ['GET'], file: 'ports/packages/sanctum.mjs' },
  '/sanctum/tokens': { slug: 'sanctum', methods: ['GET', 'DELETE'], file: 'ports/packages/sanctum.mjs' },
  '/sanctum/tokens/{id}': { slug: 'sanctum', methods: ['DELETE'], file: 'ports/packages/sanctum.mjs' },
  '/sanctum/csrf-cookie': { slug: 'sanctum-spa-cookie', methods: ['GET'], file: 'ports/packages/sanctum-spa-cookie.mjs' },
  '/sanctum/spa/login': { slug: 'sanctum-spa-cookie', methods: ['POST'], file: 'ports/packages/sanctum-spa-cookie.mjs' },
  '/sanctum/spa/user': { slug: 'sanctum-spa-cookie', methods: ['GET'], file: 'ports/packages/sanctum-spa-cookie.mjs' },
  '/sanctum/spa/logout': { slug: 'sanctum-spa-cookie', methods: ['POST'], file: 'ports/packages/sanctum-spa-cookie.mjs' },
  '/user/confirm-password': { slug: 'fortify-confirmation', methods: ['POST', 'GET'], file: 'ports/packages/fortify-confirmation.mjs' },
  '/user/confirm-password/status': { slug: 'fortify-confirmation', methods: ['GET'], file: 'ports/packages/fortify-confirmation.mjs' },
  '/email/verification-notification': { slug: 'fortify-confirmation', methods: ['POST'], file: 'ports/packages/fortify-confirmation.mjs' },
  '/email/verify/{id}/{hash}': { slug: 'fortify-confirmation', methods: ['GET'], file: 'ports/packages/fortify-confirmation.mjs' },
  '/user/two-factor-authentication': { slug: 'fortify-two-factor', methods: ['POST'], file: 'ports/packages/fortify-two-factor.mjs' },
  '/user/two-factor-authentication/confirm': { slug: 'fortify-two-factor', methods: ['POST'], file: 'ports/packages/fortify-two-factor.mjs' },
  '/user/two-factor-challenge': { slug: 'fortify-two-factor', methods: ['POST'], file: 'ports/packages/fortify-two-factor.mjs' },
  '/user/two-factor-challenge/recovery': { slug: 'fortify-two-factor', methods: ['POST'], file: 'ports/packages/fortify-two-factor.mjs' },

  // -- social / oauth / billing -------------------------------------------
  '/auth/{provider}/redirect': { slug: 'laravel-socialite-redirect', methods: ['GET'], file: 'ports/packages/laravel-socialite-redirect.mjs' },
  '/auth/{provider}/callback': { slug: 'laravel-socialite-callback', methods: ['GET'], file: 'ports/packages/laravel-socialite-callback.mjs' },
  '/oauth/authorize': { slug: 'passport-oauth', methods: ['GET'], file: 'ports/packages/passport-oauth.mjs' },
  '/oauth/token': { slug: 'passport-oauth', methods: ['POST'], file: 'ports/packages/passport-oauth.mjs' },
  '/oauth/refresh': { slug: 'passport-oauth', methods: ['POST'], file: 'ports/packages/passport-oauth.mjs' },
  '/oauth/jwks': { slug: 'passport-oauth', methods: ['GET'], file: 'ports/packages/passport-oauth.mjs' },
  '/stripe/webhook': { slug: 'cashier-stripe', methods: ['POST'], file: 'ports/packages/cashier-stripe.mjs' },
  '/paddle/webhook': { slug: 'cashier-paddle', methods: ['POST'], file: 'ports/packages/cashier-paddle.mjs' },
  '/lemon-squeezy/webhook': { slug: 'lemonsqueezy', methods: ['POST'], file: 'ports/packages/lemonsqueezy.mjs' },

  // -- realtime / permission / tags ---------------------------------------
  '/broadcast': { slug: 'pusher', methods: ['POST'], file: 'ports/packages/pusher.mjs' },
  '/broadcasting/auth': { slug: 'reverb', methods: ['POST'], file: 'ports/packages/reverb.mjs' },
  '/model/{modelType}/{modelKey}/has-role': { slug: 'permission', methods: ['GET'], file: 'ports/packages/permission.mjs' },
  '/model/{modelType}/{modelKey}/has-permission': { slug: 'permission', methods: ['GET'], file: 'ports/packages/permission.mjs' },
  '/model/{modelType}/{modelKey}/has-any': { slug: 'permission', methods: ['GET'], file: 'ports/packages/permission.mjs' },
  '/model/{modelType}/{modelKey}/roles/{action}': { slug: 'permission', methods: ['POST'], file: 'ports/packages/permission.mjs' },
  '/model/{modelType}/{modelKey}/permissions/{action}': { slug: 'permission', methods: ['POST'], file: 'ports/packages/permission.mjs' },
  '/model/{modelType}/{modelKey}/tags': { slug: 'tags', methods: ['GET', 'POST'], file: 'ports/packages/tags.mjs' },

  // -- export / notify-http ------------------------------------------------
  '/export': { slug: 'maatwebsite-excel', methods: ['GET'], file: 'ports/packages/maatwebsite-excel.mjs' },
  '/notify/mailgun': { slug: 'mailgun-mail', methods: ['POST'], file: 'ports/packages/mailgun-mail.mjs' },
  '/notify/postmark': { slug: 'postmark-mail', methods: ['POST'], file: 'ports/packages/postmark-mail.mjs' },
  '/notify/slack': { slug: 'slack-notification', methods: ['POST'], file: 'ports/packages/slack-notification.mjs' },
  '/notify/twilio': { slug: 'twilio-sms', methods: ['POST'], file: 'ports/packages/twilio-sms.mjs' },

  // -- new fleet: ai / mcp / observability --------------------------------
  '/ai/chat': { slug: 'ai-sdk', methods: ['POST'], file: 'ports/packages/ai-sdk.mjs' },
  '/mcp': { slug: 'mcp', methods: ['POST'], file: 'ports/packages/mcp.mjs' },
  '/pulse': { slug: 'pulse', methods: ['GET'], file: 'ports/packages/pulse.mjs' },
  '/pulse/record': { slug: 'pulse', methods: ['POST'], file: 'ports/packages/pulse.mjs' },
  '/bugsnag/notify': { slug: 'bugsnag', methods: ['POST'], file: 'ports/packages/bugsnag.mjs' },

  // -- new fleet: webhooks / search ---------------------------------------
  '/webhooks/{name}': { slug: 'webhook-client', methods: ['POST'], file: 'ports/packages/webhook-client.mjs' },
  '/webhook-server/send': { slug: 'webhook-server', methods: ['POST'], file: 'ports/packages/webhook-server.mjs' },
  '/site-search': { slug: 'site-search', methods: ['GET'], file: 'ports/packages/site-search.mjs' },

  // -- new fleet: notification channels -----------------------------------
  '/notify/telegram': { slug: 'telegram-notification', methods: ['POST'], file: 'ports/packages/telegram-notification.mjs' },
  '/notify/discord': { slug: 'discord-notification', methods: ['POST'], file: 'ports/packages/discord-notification.mjs' },
  '/notify/expo': { slug: 'expo-notification', methods: ['POST'], file: 'ports/packages/expo-notification.mjs' },
  '/notify/fcm': { slug: 'fcm-notification', methods: ['POST'], file: 'ports/packages/fcm-notification.mjs' },
  '/notify/webpush': { slug: 'webpush-notification', methods: ['POST'], file: 'ports/packages/webpush-notification.mjs' },
  '/notify/onesignal': { slug: 'onesignal-notification', methods: ['POST'], file: 'ports/packages/onesignal-notification.mjs' },

  // -- new fleet: auth extras / media -------------------------------------
  '/auth/jwt/login': { slug: 'jwt-auth', methods: ['POST'], file: 'ports/packages/jwt-auth.mjs' },
  '/auth/jwt/user': { slug: 'jwt-auth', methods: ['GET'], file: 'ports/packages/jwt-auth.mjs' },
  '/auth/firebase/verify': { slug: 'firebase-php-jwt', methods: ['POST'], file: 'ports/packages/firebase-php-jwt.mjs' },
  '/auth/auth0/callback': { slug: 'auth0', methods: ['POST'], file: 'ports/packages/auth0.mjs' },
  '/img/{path}': { slug: 'glide', methods: ['GET'], file: 'ports/packages/glide.mjs' },

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
 * Structural check: every manifest entry has a slug, a file, and a method array
 * (route ports) or an empty one (helpers).
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
    if (!/^ports\/packages\/[a-z0-9-]+\.mjs$/.test(entry.file)) {
      problems.push(`${label}: file is not a ports/packages slug file`);
    }
  }
  return { ok: problems.length === 0, problems };
}
