// tools/tests/_helpers.mjs — the stubs several package suites copied verbatim.
//
// The tests sweep found 35 helper bodies that were byte-identical across two
// or more suites (52 redundant copies, 439 lines). A fix in one copy silently
// missed the rest, and the same-named helpers that were NOT identical
// (`makeFetch` in analytics/fcm-webpush, the five `okCtx` shapes) are exactly
// how that drift shows up. Only the bodies that were identical EVERYWHERE
// live here; a helper that genuinely differs per cluster stays local to its
// suite so the difference is visible at the call site.
//
// Nothing here is shipped: `tools/run-tests.mjs` only discovers `*.test.mjs`.

// A `fetch` stub that records every call. `fetchImpl.calls` is what the suites
// assert on; `rawBody` pins the exact bytes when the handler reads `text()`.
export function makeFetch(status, jsonBody, { rawBody, headers } = {}) {
  const calls = [];
  const bodyText = rawBody !== undefined ? rawBody : JSON.stringify(jsonBody);
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(bodyText, {
      status,
      headers: headers || { 'content-type': 'application/json' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// The port context a JSON handler expects: a pre-parsed body, no query/params.
export const okCtx = (body) => ({ body, query: {}, params: {} });

// Split a PHP argument list at the top-level commas only (paren-aware).
export function splitTop(str) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim());
}

// The port context for the methods that read `request.method` off the ctx.
export function makeCtx({ method = 'GET', body, query, params } = {}) {
  return {
    request: { method },
    method,
    body: body ?? {},
    query: query ?? {},
    params: params ?? {},
  };
}
