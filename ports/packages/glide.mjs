// ports/packages/glide.mjs — spatie/laravel-glide port.
//
// Parity target: `GlideImage::load('image.jpg')->setParameter('w', 200)->url()`
// — a signed transform parameter set in a URL, then a server-side controller
// (`GlideController::render`) that reads those params and streams the transformed
// bytes. On the edge the transform is delegated to Cloudflare Image Resizing:
// the same params ride as query string on `GET /img/{path}` and the handler
// proxies to `https://{zone}/cdn-cgi/image?...&url={origin}/{path}`. Cloudflare
// resizes/crops/encodes and caches at the edge PoP — no GD/Imagick, no local
// filesystem, both of which a Worker forbids. That proxy is the substitute and
// is disclosed here.
//
// Contract:
//   GET /img/{path}?w=200&h=150&fit=crop&q=80&dpr=2
//   - `path` is the route capture `{path}` (single segment; nested paths are
//     reached via the `url` query param if the caller knows the full key).
//   - `w` (width) is REQUIRED — a resize call without a target size is a caller
//     bug and would just pass the original through; fail 422 before fetching.
//   - `CF_IMAGE_RESIZING_ZONE` (env) — the Cloudflare zone hostname that fronts
//     the images (e.g. `example.com`). Missing is a 500 before any fetch.
//   - The upstream origin is `GLIDE_ORIGIN` when set, else the current request
//     host (`{scheme}://{host}`) — so the images live on the same zone by
//     default.
//   - `fit`, `q` (quality), `dpr` are optional passthroughs mapped 1:1 to the
//     CF Image Resizing params (`fit`, `quality`, `dpr`); anything else is
//     ignored so an attacker cannot reach arbitrary CF resize options.
//   - The CF response is binary — the port returns `{status, headers, body}` with
//     `body` the bytes as base64 and `content-transfer-encoding: base64` set so
//     the caller knows to decode before streaming.
import { normalizePortCtx, jsonError } from '../../kernel/packages/port-ctx.mjs';
import { resolveFetch } from '../../kernel/packages/notify-http.mjs';

const ALLOWED = new Set(['w', 'h', 'fit', 'q', 'dpr']);


// Build the Cloudflare Image Resizing URL for one transform request.
export function buildResizingUrl({ zone, origin, path, params }) {
  const cf = new URL(`https://${zone}/cdn-cgi/image`);
  if (params.w !== undefined) cf.searchParams.set('width', String(params.w));
  if (params.h !== undefined) cf.searchParams.set('height', String(params.h));
  if (params.fit !== undefined) cf.searchParams.set('fit', String(params.fit));
  if (params.q !== undefined) cf.searchParams.set('quality', String(params.q));
  if (params.dpr !== undefined) cf.searchParams.set('dpr', String(params.dpr));
  cf.searchParams.set('url', `${origin}/${path}`);
  return cf.toString();
}

export default async function handle(ctx, env = {}) {
  ctx = normalizePortCtx(ctx);

  const zone = env.CF_IMAGE_RESIZING_ZONE;
  if (!zone) {
    return jsonError(500, 'CF_IMAGE_RESIZING_ZONE is not configured');
  }

  const query = ctx.query || {};
  const params = {};
  for (const key of ALLOWED) {
    const v = query[key];
    if (v !== undefined && v !== null && String(v).length) params[key] = v;
  }
  if (params.w === undefined) {
    return jsonError(422, 'The w (width) parameter is required');
  }

  const path = String((ctx.params && ctx.params.path) || '').replace(/^\/+/, '');
  if (!path) {
    return jsonError(422, 'The image path is required');
  }

  const scheme = query._scheme === 'http' ? 'http' : 'https';
  const host = ctx.host || 'port.local';
  const origin = env.GLIDE_ORIGIN
    ? String(env.GLIDE_ORIGIN).replace(/\/+$/, '')
    : `${scheme}://${host}`;

  const url = buildResizingUrl({ zone, origin, path, params });

  let resp;
  try {
    resp = await resolveFetch(env)(url, { method: 'GET' });
  } catch (err) {
    return jsonError(502, `image resizing upstream failed: ${err && err.message ? err.message : 'error'}`);
  }

  const headers = {};
  if (resp && resp.headers && typeof resp.headers.forEach === 'function') {
    resp.headers.forEach((value, key) => {
      headers[String(key).toLowerCase()] = value;
    });
  }
  const status = resp && typeof resp.status === 'number' ? resp.status : 0;

  // Binary body → base64 (Workers Response bodies are streams; a port returns a
  // string body, so encode and mark it).
  let body = '';
  try {
    const buf = resp && typeof resp.arrayBuffer === 'function' ? await resp.arrayBuffer() : new ArrayBuffer(0);
    body = Buffer.from(buf).toString('base64');
  } catch {
    body = '';
  }
  headers['content-transfer-encoding'] = 'base64';

  return { status, headers, body };
}
