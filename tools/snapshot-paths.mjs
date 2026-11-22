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

// S146h: a registry `static` value is an OUTPUT FILE NAME under dist/public,
// not a URL and not a filesystem path. Refuse everything that could make
// join()/resolve() climb out of that directory, including Windows-only names
// (trailing dot/space, ADS, device names). The checks are deliberately blunt;
// legitimate nested names such as "vendor/foo/x.js" are unaffected.
import { unsafeNameReason, assertNoSymlinkComponents } from './path-safety.mjs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const unsafeName = (reason, value) =>
  new Error(
    `unsafe snapshot output name ${JSON.stringify(value)}: ${reason} - use a relative name such as "docs/guide/index.html"`
  );

function checkName(value, { absolute }) {
  if (absolute && value.startsWith('/')) throw unsafeName('absolute paths are not allowed', value);
  const reason = unsafeNameReason(value);
  if (reason) throw unsafeName(reason, value);
}

/** Fail on a `registry.json` -> `static` name that could escape dist/public. */
export function assertSafeStaticName(name) {
  const value = String(name ?? '');
  if (value === '') return; // empty means "derive the name from the route"
  checkName(value, { absolute: true });
}

// Routes are written as `/about` by Laravel, so their leading slash is normal;
// it is trimmed before this runs. Everything else is still checked.
function assertSafeDerivedName(name) {
  checkName(String(name), { absolute: false });
}

/**
 * Fail if `file` would resolve outside `publicRoot`. This is the backstop: even
 * if a future caller bypasses assertSafeStaticName() (or a name reaches the
 * writer from a new source), no byte can be written outside dist/public.
 * It also refuses symlinked/junctioned components under the root, which a
 * purely lexical check cannot see. Returns the resolved absolute output path.
 */
export function assertContainedSnapshotPath(publicRoot, file) {
  const root = resolve(publicRoot);
  const out = resolve(root, String(file));
  const rel = relative(root, out);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error(
      `refusing snapshot output path ${JSON.stringify(file)}: it resolves outside dist/public (${out})`
    );
  }
  return assertNoSymlinkComponents(root, out);
}

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
    assertSafeStaticName(name);
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
  assertSafeDerivedName(route);
  return [`${route}.html`, `${route}/index.html`];
}

// Two page names are claimed outside the route table: `index.html` is the root
// page, and `404.html` is written after the snapshots as the edge error page
// (or shipped by the app itself). A route that produces either name silently
// overwrites - or is overwritten by - that writer. The root route is the
// legitimate owner of `index.html`; no route owns `404.html`.
const RESERVED_PAGE_FILES = new Map([
  ['index.html', { ownerRoute: '', claimant: 'the root route (/)' }],
  ['404.html', { ownerRoute: null, claimant: 'the edge 404 page writer' }],
]);

const normalizeRoute = (route) => trimSlashes(route ?? '');

/**
 * The output files claimed by more than one distinct writer.
 *
 * Each claim is `{ route, files, label? }`: `route` is the URI a page is
 * rendered for, `files` is what snapshotFiles() returns for it, and `label`
 * is the human name used in the failure message (defaults to the route).
 * Returns `{ file, claimants: string[] }[]`, empty when every file has one owner.
 */
export function findSnapshotCollisions(claims) {
  const byFile = new Map();
  const seenRoutes = new Set();
  for (const claim of claims) {
    const route = normalizeRoute(claim.route);
    // `/about` and `/about/` are one route to Laravel (and to snapshotFiles),
    // not two claimants for the same file.
    if (seenRoutes.has(route)) continue;
    seenRoutes.add(route);
    const label = claim.label || (route === '' ? 'the root route (/)' : `route /${route}`);
    for (const file of claim.files || []) {
      if (!byFile.has(file)) byFile.set(file, new Set());
      const reserved = RESERVED_PAGE_FILES.get(file);
      // The root route writing its own index.html is the reserved owner, not
      // a second claimant. Every other writer of a reserved name is.
      if (!(reserved && reserved.ownerRoute !== null && reserved.ownerRoute === route)) {
        byFile.get(file).add(label);
      }
    }
  }

  const collisions = [];
  for (const [file, writers] of byFile) {
    const reserved = RESERVED_PAGE_FILES.get(file);
    const claimants = [...writers];
    if (reserved && claimants.length && !claimants.includes(reserved.claimant)) {
      claimants.push(reserved.claimant);
    }
    if (claimants.length > 1) collisions.push({ file, claimants });
  }
  return collisions;
}

/** Fail before any page is written when two writers claim the same output file. */
export function assertNoSnapshotCollisions(claims) {
  const collisions = findSnapshotCollisions(claims);
  if (!collisions.length) return;
  const lines = collisions.map(({ file, claimants }) => {
    const names = claimants.length === 2 ? claimants.join(' and ') : claimants.join(', ');
    return `  public/${file} <- ${names}`;
  });
  throw new Error(
    'prerender output-file collision: more than one writer claims the same page file:\n' +
      lines.join('\n') +
      '\n  -> give each route a distinct `static` name in registry.json, or remove one of the\n' +
      '     colliding routes; the build refuses to let one page silently overwrite another'
  );
}
