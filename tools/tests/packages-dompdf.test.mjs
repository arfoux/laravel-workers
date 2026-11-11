// tools/tests/packages-dompdf.test.mjs — barryvdh/laravel-dompdf port
// (ports/packages/dompdf.mjs).
//
// The edge path is a delegated HTML→PDF render to an external PDF API. A FAKE
// `env.fetchImpl` captures the outgoing request (url/method/headers/body) and
// returns stubbed provider PDF bytes, so we can assert:
//   - the provider URL + auth + body the handler builds (DocRaptor Basic + JSON;
//     Cloudflare Browser Rendering Bearer + JSON),
//   - the 1:1 mapping of the provider PDF response to {status, headers, body}
//     with the binary body base64 + `content-transfer-encoding: base64`,
//   - validation guards (missing `html` → 422; missing PDF_API_KEY → 500;
//     cf-browser-rendering without CF_ACCOUNT_ID → 500) short-circuit before any
//     fetch.
// No network. The PHP Dompdf engine itself is NOT ported — this substitution is
// disclosed in the port header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dompdf, { buildPdfRequest } from '../../ports/packages/dompdf.mjs';

// Build a fake fetch that records the call and replies with binary-ish bytes.
function makePdfFetch(status, bytes, { contentType = 'application/pdf', headers } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(bytes, { status, headers: headers || { 'content-type': contentType } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// Fake one-page PDF bytes (%PDF- magic + a byte, for base64 round-trip checks).
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0x01]).buffer;

const pdfCtx = (body) => ({ method: 'POST', body, query: {}, params: {} });

// ---- Request builders ------------------------------------------------------

test('buildPdfRequest: docraptor builds the /docs URL with basic auth + JSON body', () => {
  const { url, init } = buildPdfRequest({
    provider: 'docraptor',
    html: '<h1>Invoice</h1>',
    options: {},
    apiKey: 'key-123',
  });
  assert.equal(url, 'https://docraptor.com/docs');
  assert.equal(init.method, 'POST');
  // DocRaptor Basic auth: username = api key, empty password.
  assert.equal(init.headers.authorization, 'Basic ' + Buffer.from('key-123:').toString('base64'));
  const sent = JSON.parse(init.body);
  assert.equal(sent.test, false);
  assert.equal(sent.document_content, '<h1>Invoice</h1>');
  assert.equal(sent.document_type, 'pdf');
});

test('buildPdfRequest: cf-browser-rendering builds the account-scoped URL with bearer auth', () => {
  const { url, init } = buildPdfRequest({
    provider: 'cf-browser-rendering',
    html: '<h1>Hi</h1>',
    options: {},
    apiKey: 'cf-token',
    accountId: 'acct-9',
  });
  assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/acct-9/browser-rendering/pdf');
  assert.equal(init.headers.authorization, 'Bearer cf-token');
  const sent = JSON.parse(init.body);
  assert.equal(sent.html, '<h1>Hi</h1>');
});

// ---- Happy path ------------------------------------------------------------

test('dompdf: POST /pdf/generate posts html to DocRaptor (default) and returns base64 PDF', async () => {
  const fetchImpl = makePdfFetch(200, PDF_BYTES);
  const env = { fetchImpl, PDF_API_KEY: 'key-123' }; // PDF_PROVIDER unset → docraptor

  const res = await dompdf(pdfCtx({ html: '<h1>Invoice #7</h1>' }), env);

  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://docraptor.com/docs');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.authorization, 'Basic ' + Buffer.from('key-123:').toString('base64'));
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.document_content, '<h1>Invoice #7</h1>');
  assert.equal(sent.document_type, 'pdf');
  // Binary body comes back base64-encoded with the marking header.
  assert.equal(res.headers['content-transfer-encoding'], 'base64');
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(Buffer.from(res.body, 'base64').toString('hex'), Buffer.from(PDF_BYTES).toString('hex'));
});

test('dompdf: options are passed through verbatim to the provider', async () => {
  const fetchImpl = makePdfFetch(200, PDF_BYTES);
  const env = { fetchImpl, PDF_API_KEY: 'k', PDF_PROVIDER: 'docraptor' };
  const options = { page_size: 'A4', orientation: 'landscape', test: true };

  await dompdf(pdfCtx({ html: '<p>x</p>', options }), env);

  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.page_size, 'A4');
  assert.equal(sent.orientation, 'landscape');
  assert.equal(sent.test, true); // caller override wins over the default
});

test('dompdf: PDF_PROVIDER=cf-browser-rendering routes to Browser Rendering with a bearer token', async () => {
  const fetchImpl = makePdfFetch(200, PDF_BYTES);
  const env = { fetchImpl, PDF_API_KEY: 'cf-token', PDF_PROVIDER: 'cf-browser-rendering', CF_ACCOUNT_ID: 'acct-9' };

  const res = await dompdf(pdfCtx({ html: '<h1>Hi</h1>' }), env);

  assert.equal(res.status, 200);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.cloudflare.com/client/v4/accounts/acct-9/browser-rendering/pdf');
  assert.equal(call.init.headers.authorization, 'Bearer cf-token');
  assert.equal(JSON.parse(call.init.body).html, '<h1>Hi</h1>');
});

// ---- Validation guards -----------------------------------------------------

test('dompdf: missing html is a 422 and never fetches', async () => {
  const fetchImpl = makePdfFetch(200, PDF_BYTES);
  const res = await dompdf(pdfCtx({ options: {} }), { fetchImpl, PDF_API_KEY: 'k' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(JSON.parse(res.body).ok, false);
});

test('dompdf: empty html string is a 422 before fetch', async () => {
  const fetchImpl = makePdfFetch(200, PDF_BYTES);
  const res = await dompdf(pdfCtx({ html: '   ' }), { fetchImpl, PDF_API_KEY: 'k' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

test('dompdf: missing PDF_API_KEY is a 500 and never fetches (docraptor)', async () => {
  const fetchImpl = makePdfFetch(200, PDF_BYTES);
  const res = await dompdf(pdfCtx({ html: '<p>x</p>' }), { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(JSON.parse(res.body).error, /PDF_API_KEY/);
});

test('dompdf: cf-browser-rendering without CF_ACCOUNT_ID is a 500 before fetch', async () => {
  const fetchImpl = makePdfFetch(200, PDF_BYTES);
  const res = await dompdf(pdfCtx({ html: '<p>x</p>' }), {
    fetchImpl, PDF_API_KEY: 'cf-token', PDF_PROVIDER: 'cf-browser-rendering',
  });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(JSON.parse(res.body).error, /CF_ACCOUNT_ID/);
});

// ---- Error mapping ---------------------------------------------------------

test('dompdf: non-2xx from the provider is surfaced verbatim', async () => {
  const fetchImpl = makePdfFetch(401, new ArrayBuffer(0), { contentType: 'text/html' });
  const res = await dompdf(pdfCtx({ html: '<p>x</p>' }), { fetchImpl, PDF_API_KEY: 'bad' });
  assert.equal(res.status, 401);
  assert.equal(typeof res.body, 'string');
});

test('dompdf: a thrown fetch becomes a 502, never an unhandled reject', async () => {
  const fetchImpl = async () => { throw new Error('dns fail'); };
  const res = await dompdf(pdfCtx({ html: '<p>x</p>' }), { fetchImpl, PDF_API_KEY: 'k' });
  assert.equal(res.status, 502);
  assert.match(res.body, /dns fail/);
});
