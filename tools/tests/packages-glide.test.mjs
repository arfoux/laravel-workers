// tools/tests/packages-glide.test.mjs — spatie/laravel-glide port
// (ports/packages/glide.mjs).
//
// The edge path for Glide is a proxy to Cloudflare Image Resizing. A FAKE
// `env.fetchImpl` captures the outgoing request and returns stubbed image bytes
// (raw base64 of the bytes we hand it), so we can assert:
//   - the CF Image Resizing URL the handler builds (zone host, params, url=),
//   - that only the allow-listed params (w/h/fit/q/dpr) ride through,
//   - the 1:1 mapping of the CF response to {status, headers, body},
//   - validation guards (missing `w` → 422; missing `CF_IMAGE_RESIZING_ZONE`
//     → 500) short-circuit before any fetch.
// No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import glide, { buildResizingUrl } from '../../ports/packages/glide.mjs';

// Build a fake fetch that records the call and replies with binary-ish bytes.
function makeImageFetch(status, bytes, { contentType = 'image/jpeg', headers } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(bytes, {
      status,
      headers: headers || { 'content-type': contentType, 'cache-control': 'public, max-age=31536000' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// A plain-ctx helper matching the port-ctx shape for a GET with query + params.
const imgCtx = (query, params) => ({
  method: 'GET',
  query,
  params: params || { path: 'x.jpg' },
  host: 'example.com',
});

// ---- Build the CF Image Resizing URL ---------------------------------------

test('glide: builds the /cdn-cgi/image URL with width and upstream url', () => {
  const url = buildResizingUrl({
    zone: 'img.example.com',
    origin: 'https://example.com',
    path: 'x.jpg',
    params: { w: '200' },
  });
  const u = new URL(url);
  assert.equal(u.host, 'img.example.com');
  assert.equal(u.pathname, '/cdn-cgi/image');
  assert.equal(u.searchParams.get('width'), '200');
  assert.equal(u.searchParams.get('url'), 'https://example.com/x.jpg');
});

test('glide: optional h/fit/q/dpr map 1:1 to CF params', () => {
  const url = buildResizingUrl({
    zone: 'img.example.com',
    origin: 'https://example.com',
    path: 'x.jpg',
    params: { w: '200', h: '150', fit: 'crop', q: '80', dpr: '2' },
  });
  const u = new URL(url);
  assert.equal(u.searchParams.get('width'), '200');
  assert.equal(u.searchParams.get('height'), '150');
  assert.equal(u.searchParams.get('fit'), 'crop');
  assert.equal(u.searchParams.get('quality'), '80');
  assert.equal(u.searchParams.get('dpr'), '2');
});

// ---- Happy path ------------------------------------------------------------

test('glide: GET /img/x.jpg?w=200 fetches the CF Image Resizing URL and returns the bytes', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]).buffer; // fake JPEG magic
  const fetchImpl = makeImageFetch(200, bytes);
  const env = { fetchImpl, CF_IMAGE_RESIZING_ZONE: 'img.example.com' };

  const res = await glide(imgCtx({ w: '200' }), env);

  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.init.method, 'GET');
  const u = new URL(call.url);
  assert.equal(u.host, 'img.example.com');
  assert.equal(u.pathname, '/cdn-cgi/image');
  assert.equal(u.searchParams.get('width'), '200');
  assert.equal(u.searchParams.get('url'), 'https://example.com/x.jpg');
  // Binary body comes back base64-encoded with the marking header.
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal(res.headers['content-transfer-encoding'], 'base64');
  assert.equal(
    Buffer.from(res.body, 'base64').toString('hex'),
    Buffer.from(bytes).toString('hex'),
  );
});

test('glide: allow-listed params only — unknown query keys are dropped', async () => {
  const fetchImpl = makeImageFetch(200, new ArrayBuffer(4));
  const env = { fetchImpl, CF_IMAGE_RESIZING_ZONE: 'img.example.com' };

  await glide(imgCtx({ w: '200', fit: 'crop', Mark: 'watermark', s: '99' }), env);

  const u = new URL(fetchImpl.calls[0].url);
  assert.equal(u.searchParams.get('fit'), 'crop');
  assert.equal(u.searchParams.get('mark'), null);
  assert.equal(u.searchParams.get('s'), null);
});

test('glide: GLIDE_ORIGIN overrides the request host as the upstream', async () => {
  const fetchImpl = makeImageFetch(200, new ArrayBuffer(4));
  const env = { fetchImpl, CF_IMAGE_RESIZING_ZONE: 'img.example.com', GLIDE_ORIGIN: 'https://cdn.example.com' };

  await glide(imgCtx({ w: '200' }), env);

  const u = new URL(fetchImpl.calls[0].url);
  assert.equal(u.searchParams.get('url'), 'https://cdn.example.com/x.jpg');
});

// ---- Validation guards -----------------------------------------------------

test('glide: missing `w` is a 422 and never fetches', async () => {
  const fetchImpl = makeImageFetch(200, new ArrayBuffer(4));
  const res = await glide(imgCtx({ h: '150' }), { fetchImpl, CF_IMAGE_RESIZING_ZONE: 'img.example.com' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(JSON.parse(res.body).ok, false);
});

test('glide: missing CF_IMAGE_RESIZING_ZONE is a 500 and never fetches', async () => {
  const fetchImpl = makeImageFetch(200, new ArrayBuffer(4));
  const res = await glide(imgCtx({ w: '200' }), { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(JSON.parse(res.body).ok, false);
});

test('glide: empty path capture is a 422 before fetch', async () => {
  const fetchImpl = makeImageFetch(200, new ArrayBuffer(4));
  const res = await glide(imgCtx({ w: '200' }, { path: '' }), { fetchImpl, CF_IMAGE_RESIZING_ZONE: 'img.example.com' });
  assert.equal(res.status, 422);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- Error mapping ---------------------------------------------------------

test('glide: non-2xx from CF is surfaced verbatim', async () => {
  const fetchImpl = makeImageFetch(404, new ArrayBuffer(0), { contentType: 'text/plain' });
  const res = await glide(imgCtx({ w: '200' }), { fetchImpl, CF_IMAGE_RESIZING_ZONE: 'img.example.com' });
  assert.equal(res.status, 404);
});

test('glide: a thrown fetch becomes a 502, never an unhandled reject', async () => {
  const fetchImpl = async () => { throw new Error('boom'); };
  const res = await glide(imgCtx({ w: '200' }), { fetchImpl, CF_IMAGE_RESIZING_ZONE: 'img.example.com' });
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(res.body).ok, false);
});
