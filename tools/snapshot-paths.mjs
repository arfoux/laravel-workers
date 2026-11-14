// tools/snapshot-paths.mjs — the file names a prerendered page is written under.
//
// WHY THERE ARE TWO. The ASSETS layer answers a URL from a file, and Cloudflare's
// `html_handling` decides how: with the default `auto-trailing-slash`, `/about`
// is answered from `about.html`, while a page that exists only as
// `about/index.html` makes `/about` a **307 to `/about/`**. PHP's matcher
// (Symfony's UrlMatcher, as Laravel uses it) trims the trailing slash, so
// `/about` and `/about/` are BOTH 200 - measured on the real app with the shadow
// oracle (`docs/EVIDENCE.md` finding 5). One file cannot express that: the asset
// layer has no mode that answers both spellings without a redirect (verified
// against the vendor's html_handling table and on a real `wrangler dev`).
//
// So the build writes every prerendered page under BOTH names - `<route>.html`
// for the canonical spelling Laravel's route table uses, `<route>/index.html`
// for the slash one - and the divergence disappears instead of moving from one
// spelling to the other. Neither file is in `_routes.json`, so the
// 0-invocation tier is untouched: both are plain assets.
//
// The rule lives here and only here: the writer, the drop path (a compiled
// controller replaces a snapshot) and the route table all ask this function, so
// a change cannot leave one of them pointing at a file that no longer exists.

const trimSlashes = (s) => String(s).replace(/^\/+|\/+$/g, '');

/**
 * The files a prerendered page is written under, canonical (extensionless,
 * flat) spelling first.
 *
 * `name` is the file an operator named in `registry.json`'s `static` map - their
 * choice wins for the pass-through name, and the twin is derived from it.
 */
export function snapshotFiles(uri, name) {
  if (name !== undefined && name !== null && String(name) !== '') {
    const file = trimSlashes(name);
    if (file === 'index.html') return ['index.html'];
    if (!file.endsWith('.html')) return [file];
    // `docs/guide/index.html` and `docs/guide.html` are the same page under the
    // two spellings; the flat one is canonical, so it comes first either way.
    return file.endsWith('/index.html')
      ? [file.slice(0, -'/index.html'.length) + '.html', file]
      : [file, file.slice(0, -'.html'.length) + '/index.html'];
  }

  const route = trimSlashes(uri ?? '');
  if (route === '') return ['index.html'];
  return [`${route}.html`, `${route}/index.html`];
}
