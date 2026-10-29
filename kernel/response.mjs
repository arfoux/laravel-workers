// kernel/response.mjs — Response helpers
import { phpJsonEncode } from './php-json.mjs';
export function html(body, status = 200) {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body: String(body == null ? '' : body) };
}
// PHP's JsonResponse body is `json_encode($data)` (JsonResponse.php:147-152:
// `json_encode($data, $this->encodingOptions, $this->encodingDepth)`), so the
// helper answers the same bytes: PHP escapes the slash by default and writes
// the raw UTF-8 only with JSON_UNESCAPED_UNICODE. `JSON.stringify` wrote
// `/` raw and left the escaping of the rest to JS, so a controller's
// `response()->json([...])` (the kernel's `rt.response.json` goes through the
// same encoder) answered different bytes than Laravel.
export function json(value, status = 200) {
  return { status, headers: { 'content-type': 'application/json' }, body: phpJsonEncode(value) };
}
export function redirect(location, status = 302) {
  return { status, headers: { location: String(location) }, body: '' };
}
export function notFound() {
  return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not Found' };
}
export function text(body, status = 200) {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: String(body == null ? '' : body) };
}
export default { html, json, redirect, notFound, text };
