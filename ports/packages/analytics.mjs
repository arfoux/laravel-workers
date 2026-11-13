// Port: spatie/laravel-analytics — Google Analytics 4 Data API (runReport).
//
// Laravel's `spatie/laravel-analytics` wraps the GA4 Data API v1beta `runReport`
// endpoint: `POST https://analyticsdata.googleapis.com/v1beta/properties/{propertyId}:runReport`
// with a JSON body of `metrics` / `dimensions` / `dateRanges` and a Bearer token
// minted from a Google service account. Everything is HTTPS `fetch` + WebCrypto,
// so it ports 1:1 to a Worker.
//
// Edge disclosure: NONE. The RS256 JWT mint (kernel/packages/google-oauth.mjs)
// and the report POST are native WebCrypto / HTTPS `fetch`. The parity target's
// SDK (`google/apiclient`) needs a socket and a filesystem token cache; the
// WebCrypto mint above is the substitute — same protocol on the wire.
//
// Route contract (registry.json): GET /analytics
//   metrics    — comma-separated GA4 metric names, e.g. `activeUsers,screenPageViews`
//   dimensions — comma-separated GA4 dimension names, e.g. `date,pagePath`
//   dateRange  — `startDate,endDate`, e.g. `2024-01-01,2024-01-31`
// All three are optional: GA4 itself rejects a report without a metric and a
// date range, and that provider error is surfaced verbatim rather than us
// guessing a default — matching spatie/laravel-analytics, which requires its
// caller to supply both.
//
// Config (env): GA4_PROPERTY_ID (required), GA4_SERVICE_ACCOUNT_JSON (required;
// raw or base64 service-account JSON).
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';
import { resolveFetch, jsonPort, deliverVia, bearerAuthHeader } from '../../kernel/packages/notify-http.mjs';
import { mintGoogleAccessToken } from '../../kernel/packages/google-oauth.mjs';

const GA4_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';

function runReportUrl(propertyId) {
  return `${GA4_API_BASE}/properties/${encodeURIComponent(propertyId)}:runReport`;
}

// Split a comma-separated query value into GA4 names used as `{ name }` entries.
function splitList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length);
}

// dateRange `start,end` -> GA4 `{ startDate, endDate }`. A single value is a
// one-day (start==end) range rather than a degenerate undefined endDate.
function parseDateRange(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  const start = (parts[0] || '').trim();
  if (!start) return null;
  const end = parts.length > 1 ? (parts[1] || '').trim() : start;
  return { startDate: start, endDate: end || start };
}

// Assemble the runReport request body from the query params. GA4 accepts the
// shape as-is; an absent metric/dateRange is GA4's call to reject and we
// surface that error verbatim.
function buildRunReportRequest(query) {
  const q = query || {};
  const req = {};
  const metrics = splitList(q.metrics);
  if (metrics.length) req.metrics = metrics.map((name) => ({ name }));
  const dimensions = splitList(q.dimensions);
  if (dimensions.length) req.dimensions = dimensions.map((name) => ({ name }));
  const range = parseDateRange(q.dateRange);
  if (range) req.dateRanges = [range];
  return req;
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const query = (ctx && ctx.query) || {};

  const propertyId = (env && env.GA4_PROPERTY_ID) ? String(env.GA4_PROPERTY_ID).trim() : '';
  if (!propertyId) {
    return jsonPort({ error: 'missing GA4_PROPERTY_ID (set env GA4_PROPERTY_ID to the GA4 property id)' }, 422);
  }

  if (!env || !env.GA4_SERVICE_ACCOUNT_JSON) {
    return jsonPort({ error: 'missing GA4_SERVICE_ACCOUNT_JSON (set env GA4_SERVICE_ACCOUNT_JSON to the service-account JSON)' }, 500);
  }

  let accessToken;
  try {
    accessToken = await mintGoogleAccessToken(env);
  } catch (err) {
    return jsonPort({ error: `GA4 auth failed: ${String((err && err.message) || err)}` }, 500);
  }

  const doFetch = resolveFetch(env);
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: bearerAuthHeader(accessToken),
    },
    body: JSON.stringify(buildRunReportRequest(query)),
  };

  // GA4 returns 200 with the report JSON ({dimensionHeaders, metricHeaders,
  // rows}); surface it verbatim so callers see the full report, and so a
  // non-2xx GA4 error JSON is preserved instead of wrapped.
  return deliverVia(doFetch, runReportUrl(propertyId), init);
}
