// ports/packages/dompdf.mjs — barryvdh/laravel-dompdf port (POST /pdf/generate).
//
// Parity target: `PDF::loadHtml($html)->setPaper($size, $orientation)->output()`
// (barryvdh/laravel-dompdf) — the PHP bundle (Dompdf + CPDF renderer + its
// bundled TTF font stack) turns an HTML string into PDF bytes entirely
// in-process, reading local CSS/font/float/box-model semantics.
//
// Edge disclosure (substitution, NOT a 1:1 port): Dompdf is a PHP rendering
// engine — PHP, the CPDF/GD backends and the file-backed font cache do not exist
// on a Workers runtime, so the in-process HTML→PDF transform is impossible at the
// edge. This port therefore delegates the render to an external PDF API and
// returns the provider's PDF bytes:
//   - PDF_PROVIDER=docraptor (default):
//       POST https://docraptor.com/docs
//       Authorization: Basic <PDF_API_KEY>: (username = key, empty password)
//       JSON body { test: false, document_content: html, document_type: 'pdf',
//                   ...options } — DocRaptor maps `document_type: 'pdf'` and the
//       options onto its own HTML→PDF settings.
//   - PDF_PROVIDER=cf-browser-rendering:
//       POST https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/browser-rendering/pdf
//       Authorization: Bearer <PDF_API_KEY>   (a Cloudflare API token)
//       JSON body { html, ...options } — Browser Rendering drives headless
//       Chromium and prints the page to PDF.
// Both providers own the real layout engine, so CSS fidelity is theirs, not ours.
// The provider must be enabled/paid for; PDF_API_KEY is the DocRaptor key or the
// CF API token respectively. This substitution is the documented edge path.
//
// The provider PDF arrives as binary — the port returns it base64 with
// `content-transfer-encoding: base64` so the caller decodes before streaming
// (same convention as the glide port). Provider headers are passed through.
//
// Contract (ctx.body): { html: string, options?: object }.
// Config (env): PDF_API_KEY (required), PDF_PROVIDER? ('docraptor' |
// 'cf-browser-rendering'), CF_ACCOUNT_ID? (required for cf-browser-rendering).
// Returns { status, headers, body } — 200 + application/pdf (base64) on success,
// 422 without `html`, 500 without credentials, 502 on upstream failure.
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';
import { resolveFetch, basicAuthHeader } from '../../kernel/packages/notify-http.mjs';

const DOCRAPTOR_URL = 'https://docraptor.com/docs';
const CF_BROWSER_RENDERING_URL =
  'https://api.cloudflare.com/client/v4/accounts/{account}/browser-rendering/pdf';

function jsonError(status, message) {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ ok: false, error: message }),
  };
}

// Build the provider request (url + fetch init) for the configured provider.
export function buildPdfRequest({ provider, html, options, apiKey, accountId }) {
  if (provider === 'cf-browser-rendering') {
    const url = CF_BROWSER_RENDERING_URL.replace('{account}', String(accountId));
    return {
      url,
      init: {
        method: 'POST',
        headers: {
          authorization: `Bearer ${String(apiKey)}`,
          'content-type': 'application/json',
          accept: 'application/pdf',
        },
        body: JSON.stringify({ html, ...options }),
      },
    };
  }
  // default: docraptor
  return {
    url: DOCRAPTOR_URL,
    init: {
      method: 'POST',
      headers: {
        authorization: basicAuthHeader(apiKey, ''),
        'content-type': 'application/json',
        accept: 'application/pdf',
      },
      body: JSON.stringify({
        test: false,
        document_content: html,
        document_type: 'pdf',
        ...options,
      }),
    },
  };
}

export default async function handle(ctx, env = {}) {
  ctx = normalizePortCtx(ctx);

  const payload = (ctx && ctx.body) || {};
  const html = typeof payload.html === 'string' ? payload.html.trim() : '';
  if (!html) {
    return jsonError(422, "pdf payload requires a non-empty 'html' string");
  }
  const options =
    payload.options && typeof payload.options === 'object' && !Array.isArray(payload.options)
      ? payload.options
      : {};

  const provider = String(env.PDF_PROVIDER || 'docraptor').toLowerCase();

  const apiKey = env.PDF_API_KEY;
  if (!apiKey) {
    return jsonError(500, 'PDF_API_KEY is not configured — set the provider API key/token');
  }
  const accountId = env.CF_ACCOUNT_ID;
  if (provider === 'cf-browser-rendering' && !accountId) {
    return jsonError(500, 'CF_ACCOUNT_ID is not configured (required for cf-browser-rendering)');
  }

  const { url, init } = buildPdfRequest({ provider, html, options, apiKey, accountId });

  let resp;
  try {
    resp = await resolveFetch(env)(url, init);
  } catch (err) {
    return jsonError(502, `pdf upstream failed: ${(err && err.message) || err}`);
  }

  const status = resp && typeof resp.status === 'number' ? resp.status : 0;
  const headers = {};
  if (resp && resp.headers && typeof resp.headers.forEach === 'function') {
    resp.headers.forEach((value, key) => {
      headers[String(key).toLowerCase()] = value;
    });
  }

  // Binary body → base64 (a port returns a string body; mark it so the caller
  // decodes before streaming).
  let body = '';
  try {
    const buf =
      resp && typeof resp.arrayBuffer === 'function' ? await resp.arrayBuffer() : new ArrayBuffer(0);
    body = Buffer.from(buf).toString('base64');
  } catch {
    body = '';
  }
  headers['content-transfer-encoding'] = 'base64';

  return { status, headers, body };
}
