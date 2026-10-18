#!/usr/bin/env node
// build.mjs — Build pipeline (Laravel → Workers artifact)
//
// "Booting" happens HERE (build time): the real Laravel app renders pages and
// exports its route table. The artifact shipped to Cloudflare is request-time
// static: prerendered HTML + small JS ports. Nothing boots at request time.
//
// Route tiers (see README):
//   ports    — live JS handlers (registry.json → "ports"), highest priority
//   static   — manual page map (registry.json → "static")
//   snapshot — automatic: clean GET routes rendered at build time land on the edge
//   ignore   — consciously skipped (registry.json → "ignore")
//
// Usage: node build.mjs [--strict] [--scaffold]

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const edgeDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(edgeDir);
const dist = join(edgeDir, 'dist');
const strict = process.argv.includes('--strict');
const scaffold = process.argv.includes('--scaffold');
const PHP = process.env.PHP_BIN || 'php';

const fail = (msg) => {
  console.error('BUILD FAILED: ' + msg);
  process.exit(1);
};

// ---------- 0. sanity ----------
const registry = JSON.parse(readFileSync(join(edgeDir, 'registry.json'), 'utf8'));
const autoSnapshot = registry.autoSnapshot !== false;
const staticMap = Object.entries(registry.static || {});
const portEntries = Object.entries(registry.ports || {});
const ignoreMap = Object.entries(registry.ignore || {});
const viewMap = Object.entries(registry.views || {});
if (!existsSync(join(root, 'vendor/autoload.php'))) fail('vendor/ not found — run composer install');
if (!existsSync(join(root, 'public/build/manifest.json')))
  fail('public/build/manifest.json not found — run `npm run build` first');

// ---------- 1. export routes from the Laravel app ----------
console.log('• exporting routes via `php artisan route:list --json`');
const listed = JSON.parse(
  execFileSync(PHP, ['artisan', 'route:list', '--json'], { cwd: root }).toString('utf8')
);
const appRoutes = listed.filter((r) => String(r.path || '').startsWith('routes/'));
const normalize = (u) => (u === '/' || u === '' ? '/' : '/' + String(u).replace(/^\/+|\/+$/g, ''));
const routes = [...new Set(appRoutes.map((r) => normalize(r.uri)))].sort();
const methodsFor = new Map();
const metaFor = new Map(); // 'METHOD /uri' -> { name, domain }
for (const r of appRoutes) {
  const uri = normalize(r.uri);
  const set = methodsFor.get(uri) || new Set();
  const methods = String(r.method || 'GET').split('|');
  for (const m of methods) if (m) set.add(m);
  methodsFor.set(uri, set);
  for (const m of methods) {
    if (!m) continue;
    const key = m.toUpperCase() + ' ' + uri;
    if (!metaFor.has(key)) metaFor.set(key, { name: r.name ?? null, domain: r.domain ?? null });
  }
}
const otherMethods = (route) =>
  [...(methodsFor.get(route) || new Set())].filter((m) => m !== 'GET' && m !== 'HEAD');
// first non-null name/domain across the route's methods (they share a uri in the table)
const metaForRoute = (route) => {
  let name = null;
  let domain = null;
  for (const m of methodsFor.get(route) || []) {
    const meta = metaFor.get(m + ' ' + route);
    if (!meta) continue;
    if (name == null) name = meta.name;
    if (domain == null) domain = meta.domain;
  }
  return { name, domain };
};
console.log(`  app routes (${routes.length}): ${routes.join('  ')}`);

// ---------- 2. prerender helper (boots the real app, build time only) ----------
const originRe = /(?:https?:)?\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//g;

const prerender = (route) => {
  let out;
  try {
    out = execFileSync(PHP, ['-d', 'display_errors=stderr', join(edgeDir, 'tools/prerender.php'), route], {
      cwd: root,
    }).toString('utf8');
  } catch (e) {
    const stderr = String(e.stderr || '').trim();
    fail(`prerender crashed for ${route}${stderr ? `:\n${stderr}` : ''}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    fail(`prerender returned non-JSON for ${route}: ${out.slice(0, 200)}`);
  }
};

// ---------- 3. dist skeleton + prerendered pages ----------
const hotFile = join(root, 'public/hot');
const hotAside = join(root, 'public/hot.edge-build-aside');
if (existsSync(hotFile)) {
  renameSync(hotFile, hotAside);
  console.log('  (moved public/hot aside for the build)');
}
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'public'), { recursive: true });
mkdirSync(join(dist, 'src'), { recursive: true });

const writePage = (file, html) => {
  const rel = html.replace(originRe, '/');
  const outPath = join(dist, 'public', file);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, rel);
  return { bytes: rel.length, fixed: (html.match(originRe) || []).length };
};

const snapshots = [];
const partials = [];
const needsPort = [];

try {
  // 3a. manual static pages (registry.json → "static")
  for (const [route, file] of staticMap) {
    const res = prerender(route);
    if (res.status < 200 || res.status >= 300) fail(`static route ${route} returned HTTP ${res.status}`);
    const { bytes, fixed } = writePage(file, res.body);
    console.log(`• static ${route} -> public/${file} (${bytes} bytes, ${fixed} URL(s) made relative)`);
    if (otherMethods(route).length) partials.push({ route, methods: otherMethods(route) });
  }

  // 3b. auto-snapshot: clean GET routes appear on the edge on the next deploy
  const handled = new Set([
    ...staticMap.map(([r]) => r),
    ...portEntries.map(([r]) => r),
    ...viewMap.map(([r]) => r),
    ...ignoreMap.map(([r]) => r),
  ]);
  for (const route of routes) {
    if (handled.has(route)) continue;
    if (!autoSnapshot) {
      needsPort.push({ route, reason: 'unhandled (autoSnapshot: false)' });
      continue;
    }
    const methods = methodsFor.get(route) || new Set();
    const others = otherMethods(route);
    if (!methods.has('GET')) {
      needsPort.push({ route, reason: `no GET (${[...methods].join(', ') || '?'})` });
      continue;
    }
    if (route.includes('{')) {
      needsPort.push({ route, reason: 'dynamic segment — needs a port' });
      continue;
    }
    const res = prerender(route);
    const isHtml = String(res.content_type || '').includes('text/html');
    if (res.status >= 200 && res.status < 300 && isHtml) {
      const file = route === '/' ? 'index.html' : route.slice(1) + '/index.html';
      const { bytes, fixed } = writePage(file, res.body);
      snapshots.push(route);
      console.log(`• snapshot ${route} -> public/${file} (${bytes} bytes, ${fixed} URL(s) made relative)`);
      if (others.length) partials.push({ route, methods: others });
    } else if (res.status >= 200 && res.status < 300) {
      needsPort.push({ route, reason: `HTTP ${res.status} non-HTML (${res.content_type || '?'})` });
    } else {
      const to = res.location ? ` -> ${res.location}` : '';
      needsPort.push({ route, reason: `HTTP ${res.status}${to}` });
    }
  }
} finally {
  if (existsSync(hotAside)) renameSync(hotAside, hotFile);
}

// ---------- 3c. compile view controllers ----------
const slugifyRoute = (route) =>
  route.replace(new RegExp('^/'), '').replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'home';

mkdirSync(join(dist, 'src', 'controllers'), { recursive: true });
mkdirSync(join(dist, 'src', 'views'), { recursive: true });
mkdirSync(join(dist, 'src', 'contexts'), { recursive: true });

const controllerByRoute = new Map();

for (const [route, view] of viewMap) {
  const slug = slugifyRoute(route);
  const dumpPath = join(edgeDir, '.cache', view + '.compiled.json');
  console.log(`compiling view ${view} for ${route}`);
  execFileSync(PHP, [join(edgeDir, 'tools', 'compile-view.php'), view, dumpPath, route], { cwd: root });
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  if (!dump || typeof dump.compiled !== 'string') fail('compile-view produced no compiled PHP for ' + route);

  const viewModulePath = join(dist, 'src', 'views', view + '.mjs');
  execFileSync('node', [join(edgeDir, 'compiler', 'bin', 'transpile.mjs'), dumpPath, '--json', '--out', viewModulePath], { cwd: root });

  const contextPath = join(dist, 'src', 'contexts', view + '.mjs');
  writeFileSync(contextPath, 'export default ' + JSON.stringify(dump.context) + ';\n');

  const controllerPath = join(dist, 'src', 'controllers', slug + '.mjs');
  writeFileSync(
    controllerPath,
    [
      "import main from '../views/" + view + ".mjs';",
      "import context from '../contexts/" + view + ".mjs';",
      "import { buildRt } from '../runtime/rt-from-context.mjs';",
      "import { html } from '../../kernel/response.mjs';",
      '',
      'export default function handle(ctx, env) {',
      '  const rt = buildRt(context, { strict: true });',
      '  main(rt);',
      '  return html(rt.__output);',
      '}',
      '',
        ].join('\n')
  );

  controllerByRoute.set(route, slug);
  console.log(`  -> dist/src/controllers/${slug}.mjs`);
}

for (const [route, name] of portEntries) {
  const slug = String(name);
  const controllerPath = join(dist, 'src', 'controllers', slug + '.mjs');
  writeFileSync(
    controllerPath,
    [
      "export { default } from '../ports/" + name + ".mjs';",
      '',
        ].join('\n')
  );
  controllerByRoute.set(route, slug);
  console.log(`port controller ${route} -> dist/src/controllers/${slug}.mjs`);
}

// ---------- 3d. schema snapshot ----------
mkdirSync(join(edgeDir, '.cache'), { recursive: true });
const schemaPath = join(edgeDir, '.cache', 'schema.json');
console.log('\u2022 dumping DB schema');
execFileSync(PHP, [join(edgeDir, 'tools', 'schema-dump.php'), schemaPath], { cwd: root });
cpSync(schemaPath, join(dist, 'schema.json'));
console.log('  -> dist/schema.json');

// ---------- 4. copy static assets ----------
for (const f of ['build', 'favicon.ico', 'robots.txt']) {
  const src = join(root, 'public', f);
  if (!existsSync(src)) {
    console.log(`  ! public/${f} missing — skipped`);
    continue;
  }
  cpSync(src, join(dist, 'public', f), { recursive: true });
  console.log(`• copied public/${f}`);
}

// ---------- 5. worker + ports + routes ----------
cpSync(join(edgeDir, 'src/worker.mjs'), join(dist, 'src/worker.mjs'));
cpSync(join(edgeDir, 'src/ports'), join(dist, 'src/ports'), { recursive: true });
cpSync(join(edgeDir, 'kernel'), join(dist, 'kernel'), { recursive: true });
cpSync(join(edgeDir, 'compiler', 'runtime'), join(dist, 'src', 'runtime'), { recursive: true });

const builtAt = new Date().toISOString();
const routeTable = routes.map((route) => {
  if (ignoreMap.some(([r]) => r === route)) {
    const entry = ignoreMap.find(([r]) => r === route);
    return { uri: route, ...metaForRoute(route), methods: [...(methodsFor.get(route) || new Set())], kind: 'ignore', reason: entry[1] };
  }
  if (portEntries.some(([r]) => r === route)) {
    const slug = portEntries.find(([r]) => r === route)[1];
    return { uri: route, ...metaForRoute(route), methods: [...(methodsFor.get(route) || new Set())], kind: 'port', controller: slug };
  }
  if (viewMap.some(([r]) => r === route)) {
    const slug = controllerByRoute.get(route);
    const view = viewMap.find(([r]) => r === route)[1];
    return { uri: route, ...metaForRoute(route), methods: [...(methodsFor.get(route) || new Set())], kind: 'view', view, controller: slug };
  }
  if (staticMap.some(([r]) => r === route)) {
    const file = staticMap.find(([r]) => r === route)[1];
    return { uri: route, ...metaForRoute(route), methods: [...(methodsFor.get(route) || new Set())], kind: 'snapshot', snapshot: file };
  }
  if (snapshots.includes(route)) {
    const file = route === '/' ? 'index.html' : route.slice(1) + '/index.html';
    return { uri: route, ...metaForRoute(route), methods: [...(methodsFor.get(route) || new Set())], kind: 'snapshot', snapshot: file };
  }
  return { uri: route, ...metaForRoute(route), methods: [...(methodsFor.get(route) || new Set())], kind: 'unhandled' };
});

const controllerImports = [];
const controllerMap = [];
let controllerIndex = 0;
for (const route of routes) {
  const entry = routeTable.find((r) => r.uri === route);
  if (entry && (entry.kind === 'view' || entry.kind === 'port')) {
    const idx = controllerIndex++;
    controllerImports.push(`import handler${idx} from './controllers/${entry.controller}.mjs';`);
    controllerMap.push({ route, idx });
  }
}

const routeNames = {};
for (const [key, meta] of metaFor) {
  if (meta.name) routeNames[meta.name] = key.slice(key.indexOf(' ') + 1);
}

const handlersLines = controllerMap.map(({ route, idx }) => {
  const entry = routeTable.find((r) => r.uri === route);
  const methods = entry.methods && entry.methods.length ? entry.methods : ['GET'];
  return `  ${JSON.stringify(methods[0] + ' ' + route)}: handler${idx},`;
});

writeFileSync(
  join(dist, 'src', 'routes.generated.mjs'),
  [
    '// generated by build.mjs — do not edit',
    ...controllerImports,
    `export const builtAt = ${JSON.stringify(builtAt)};`,
    'export const routeTable = ' + JSON.stringify(routeTable, null, 2) + ';',
    'export const routeNames = ' + JSON.stringify(routeNames, null, 2) + ';',
    'export const handlers = {',
    ...handlersLines,
    '};',
    '',
  ].join('\n')
);
// ---------- 6. coverage report ----------
const unknown = [
  ...new Set([
    ...staticMap.map(([r]) => r),
    ...portEntries.map(([r]) => r),
    ...viewMap.map(([r]) => r),
    ...ignoreMap.map(([r]) => r),
  ]),
].filter((r) => !routes.includes(r));
const blocked = needsPort.length > 0 || partials.length > 0 || unknown.length > 0;

if (snapshots.length) console.log(`• auto-snapshots (${snapshots.length}): ${snapshots.join(', ')}`);
for (const p of partials)
  console.log(`  WARN ${p.route}: GET is snapshotted, but ${p.methods.join(', ')} needs a port`);
for (const n of needsPort) console.log(`  UNHANDLED ${n.route}: ${n.reason}`);
if (needsPort.length)
  console.log('  -> add a port, a "static" entry, or "ignore" (with a reason) in registry.json');
if (unknown.length) console.log(`  registry entries not found in route:list: ${unknown.join(', ')}`);
if (!blocked)
  console.log(
    `• coverage: all ${routes.length} route(s) handled — static ${staticMap.length}, snapshots ${snapshots.length}, ports ${portEntries.length}, ignored ${ignoreMap.length}`
  );

// ---------- 7. scaffold stubs for routes that need a port ----------
if (scaffold && needsPort.length) {
  const slugify = (route) =>
    route.replace(/^\//, '').replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'home';
  for (const { route } of needsPort) {
    const slug = slugify(route);
    const stub = join(edgeDir, 'src/ports', `${slug}.mjs`);
    if (existsSync(stub)) {
      console.log(`  scaffold: src/ports/${slug}.mjs already exists`);
    } else {
      writeFileSync(
        stub,
        [
          `// Port for GET ${route} — TODO: implement against env.DB and return a Response.`,
          route.includes('{')
            ? '// NOTE: dynamic segments ({...}) are not matched by the worker router yet — check worker.mjs.'
            : '',
          'export async function handle(request, env) {',
          `  return Response.json({ error: 'not implemented', route: ${JSON.stringify(route)} }, { status: 501 });`,
          '}',
          '',
        ]
          .filter(Boolean)
          .join('\n')
      );
      console.log(`  scaffolded src/ports/${slug}.mjs`);
    }
    console.log(`     registry.json line:  ${JSON.stringify(route)}: ${JSON.stringify(slug)}  (under "ports")`);
  }
}
if (blocked && !scaffold) console.log('  (tip: run `node build.mjs --scaffold` to generate port stubs)');
if (strict && blocked) fail('coverage check failed (--strict)');

console.log(
  `done. dist: ${relative(root, dist)}  (static: ${staticMap.length}, snapshots: ${snapshots.length}, ports: ${portEntries.length}, ignored: ${ignoreMap.length})`
);
