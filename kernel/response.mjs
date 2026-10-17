// edge/kernel/response.mjs — W3 response helpers (CONTRACT-w3.md)
export function html(body, status = 200) {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body: String(body == null ? '' : body) };
}
export function json(value, status = 200) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
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
