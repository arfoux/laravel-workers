// kernel/response.mjs — the one response helper the generated worker imports.
// json/redirect/notFound/text were removed: JSON bytes come from
// kernel/php-json.mjs via compiler/runtime/rt-from-context.mjs, and port
// answers come from kernel/packages/port-ctx.mjs. GitHub code search found no
// external deep import of this module (2026-11-27).
export function html(body, status = 200) {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body: String(body == null ? '' : body) };
}
