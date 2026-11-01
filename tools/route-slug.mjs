// The module name a route compiles to: `dist/src/controllers/<slug>.mjs`.
//
// A slug keeps [a-zA-Z0-9] and turns every other run into `-`, so a slug can
// never CONTAIN `_`. ROOT_SLUG is therefore only ever produced by the empty-slug
// family (`/`, `/-`, `/__` — a URI that keeps no alphanumeric character), and
// two members of that family at once still refuse (they really are two URIs
// sharing one module name). What it can no longer do is collide with a URI that
// carries a segment: the old fallback was the literal `home`, which both the
// root URI AND the unrelated legal route `/home` produced — BookStack declares
// both (`routes/web.php:225-226`, both answering `HomeController@index`), and
// the build refused over a name the tool itself had invented.
//
// Two DIFFERENT URIs can still slugify to the same name (`/a/b`, `/a-b` and
// `/{a}-{b}` all answer `a-b`); `tools/routes-dump.mjs` refuses that dump rather
// than let one route's handler overwrite the other's.
export const ROOT_SLUG = '_root';

export function slugifyRoute(uri) {
  return (
    String(uri)
      .replace(/^\//, '')
      .replace(/[{}]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || ROOT_SLUG
  );
}
