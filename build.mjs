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
import { buildRoutesJson } from './tools/routes-json.mjs';
import { mergePorts, serializeRegistry } from './tools/registry-json.mjs';
import { STUB_MARKER, buildStubSource, findStubPorts } from './tools/ports.mjs';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = dirname(fileURLToPath(import.meta.url));
let appDir;
if (existsSync(join(process.cwd(), 'artisan')) && existsSync(join(process.cwd(), 'vendor'))) {
  appDir = process.cwd();
} else if (existsSync(join(dirname(pkgDir), 'artisan'))) {
  appDir = dirname(pkgDir);
} else {
  appDir = process.cwd();
}
const isNpmMode = appDir !== pkgDir && existsSync(join(appDir, 'artisan'));
const dist = isNpmMode ? join(appDir, 'dist') : join(pkgDir, 'dist');
const cacheDir = isNpmMode ? join(appDir, '.cache', 'laravel-workers') : join(pkgDir, '.cache');
const strict = process.argv.includes('--strict');
const scaffold = process.argv.includes('--scaffold');
const PHP = process.env.PHP_BIN || 'php';

const fail = (msg) => {
  console.error('BUILD FAILED: ' + msg);
  process.exit(1);
};

const lwConfig = process.env.LW_CONFIG ? resolve(appDir, process.env.LW_CONFIG) : null;
if (lwConfig && !existsSync(lwConfig))
  fail(`LW_CONFIG is set to "${process.env.LW_CONFIG}" but that file was not found (resolved: ${lwConfig})`);
const registryCandidates = [
  ...(lwConfig ? [lwConfig] : []),
  join(appDir, 'registry.json'),
  join(appDir, 'laravel-workers.json'),
  join(appDir, 'edge/registry.json'),
  join(pkgDir, 'registry.json'),
];
let registryPath = null;
for (const p of registryCandidates) if (existsSync(p)) { registryPath = p; break; }
if (lwConfig && registryPath === lwConfig) console.log(`• registry: LW_CONFIG -> ${registryPath}`);
let registry = {};
if (registryPath) {
  registry = JSON.parse(readFileSync(registryPath, 'utf8'));
} else {
  registryPath = join(appDir, 'registry.json');
  console.log('• registry: none found — using defaults (autoSnapshot on, no ports/ignore); add registry.json or set LW_CONFIG to declare routes');
}
const lwPortsDir = process.env.LW_PORTS_DIR ? resolve(appDir, process.env.LW_PORTS_DIR) : null;
if (lwPortsDir && !existsSync(lwPortsDir))
  fail(`LW_PORTS_DIR is set to "${process.env.LW_PORTS_DIR}" but that directory was not found (resolved: ${lwPortsDir})`);
const autoSnapshot = registry.autoSnapshot !== false;
const staticMap = Object.entries(registry.static || {});
const portEntries = Object.entries(registry.ports || {});
const ignoreMap = Object.entries(registry.ignore || {});
const viewMap = Object.entries(registry.views || {});
if (!existsSync(join(appDir, 'vendor/autoload.php'))) fail('vendor/ not found — run composer install');
if (!existsSync(join(appDir, 'public/build/manifest.json')))
  fail('public/build/manifest.json not found — run `npm run build` first');

// ---------- 1. export routes from the Laravel app ----------
console.log('• exporting routes via `php artisan route:list --json`');
const listed = JSON.parse(
  execFileSync(PHP, ['artisan', 'route:list', '--json'], { cwd: appDir }).toString('utf8')
);
// Laravel only reports `path` for closure routes — controller-action routes
// (Route::get('/x', [XController::class, 'm']), Route::resource, invokable
// controllers) come back with path === null even though they live in routes/.
const isAppRoute = (r) => {
  const p = String(r.path || '');
  if (p) return p.startsWith('routes/');
  const action = String(r.action || '');
  return action !== '' && action !== 'Closure';
};
const appRoutes = listed.filter(isAppRoute);
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
    if (!metaFor.has(key)) metaFor.set(key, { name: r.name ?? null, domain: r.domain ?? null, action: r.action ?? null, middleware: Array.isArray(r.middleware) ? r.middleware : null });
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
// route:list action for a route (prefer GET — the only method controller
// transpilation supports today).
const actionForRoute = (route) => {
  const getMeta = metaFor.get('GET ' + route);
  if (getMeta && getMeta.action) return getMeta.action;
  for (const m of methodsFor.get(route) || []) {
    const meta = metaFor.get(m + ' ' + route);
    if (meta && meta.action) return meta.action;
  }
  return null;
};
// route:list middleware for a route (prefer GET — see above).
const middlewareForRoute = (route) => {
  const getMeta = metaFor.get('GET ' + route);
  if (getMeta && getMeta.middleware) return getMeta.middleware;
  for (const m of methodsFor.get(route) || []) {
    const meta = metaFor.get(m + ' ' + route);
    if (meta && meta.middleware) return meta.middleware;
  }
  return null;
};
console.log(`  app routes (${routes.length}): ${routes.join('  ')}`);
const skippedRoutes = [
  ...new Set(listed.filter((r) => !isAppRoute(r)).map((r) => normalize(r.uri))),
];
if (skippedRoutes.length) {
  const shown = skippedRoutes.slice(0, 5).join(', ');
  console.log(
    `  skipped ${skippedRoutes.length} route(s) defined outside routes/ (not part of the edge build): ${shown}${
      skippedRoutes.length > 5 ? ', …' : ''
    }`
  );
}

// ---------- 2. prerender helper (boots the real app, build time only) ----------
const originRe = /(?:https?:)?\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//g;

// The framework can write an error page to stdout around our payload (console
// exception renderers bypass PHP output buffering), so prerender.php terminates
// its stdout with a marker and the JSON that follows it.
const PRERENDER_MARKER = '---LW-PRERENDER-JSON---';
const prerender = (route) => {
  let out;
  try {
    out = execFileSync(PHP, ['-d', 'display_errors=stderr', join(pkgDir, 'tools/prerender.php'), route], {
      cwd: appDir,
      env: { ...process.env, LW_APP_ROOT: appDir },
    }).toString('utf8');
  } catch (e) {
    const stderr = String(e.stderr || '').trim();
    const stdout = String(e.stdout || '').trim();
    const detail = (stderr || stdout || String(e.message || '')).slice(-2000);
    fail(`prerender crashed for ${route}${detail ? `:\n${detail}` : ''}`);
  }
  const idx = out.lastIndexOf(PRERENDER_MARKER);
  const jsonText = idx >= 0 ? out.slice(idx + PRERENDER_MARKER.length) : out;
  try {
    return JSON.parse(jsonText);
  } catch {
    fail(`prerender returned non-JSON for ${route}: ${jsonText.trim().slice(0, 200)}`);
  }
};

// ---------- 3. dist skeleton + prerendered pages ----------
const hotFile = join(appDir, 'public/hot');
const hotAside = join(appDir, 'public/hot.edge-build-aside');
if (existsSync(hotFile)) {
  renameSync(hotFile, hotAside);
  console.log('  (moved public/hot aside for the build)');
}
// Clean dist/. On Windows a running `wrangler dev` (or editor) can hold a handle on
// dist/ or a subdirectory: file deletion still works, so fall back to wiping the
// contents and keeping the locked directory shells — the build rewrites everything
// fresh and the watcher picks the changes up.
for (const entry of readdirSync(appDir)) {
  if (entry.startsWith('dist.old-')) {
    try {
      rmSync(join(appDir, entry), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      /* still locked — try again next build */
    }
  }
}
try {
  rmSync(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
} catch {
  if (existsSync(dist)) {
    for (const entry of readdirSync(dist)) {
      try {
        rmSync(join(dist, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        console.log(
          `  (warning: ${relative(appDir, join(dist, entry))} is locked by a running process — restart the dev server if build output looks stale)`
        );
      }
    }
  }
}
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
      const why = res.error ? `: ${res.error}` : '';
      needsPort.push({ route, reason: `HTTP ${res.status}${to}${why}` });
    }
  }
} finally {
  if (existsSync(hotAside)) renameSync(hotAside, hotFile);
}

// ---------- 2b. runtime config (compiled HTTP kernel) ----------
// kernel/http.mjs reads a FLAT dotted config. Anything the compiled rung cannot
// honour fails the build here instead of producing a silently-degraded worker.
console.log('\u0007 dumping runtime config via `tools/config-dump.php`');
let runtimeConfig;
try {
  const raw = execFileSync(PHP, [join(pkgDir, 'tools', 'config-dump.php')], {
    cwd: appDir,
    maxBuffer: 1 << 24,
  }).toString('utf8');
  runtimeConfig = JSON.parse(raw);
} catch (e) {
  fail('config dump failed: ' + String(e.stderr || e.message || '').trim().slice(0, 800));
}
{
  const problems = [];
  if (!runtimeConfig['app.key']) problems.push('app.key is empty');
  const driver = runtimeConfig['session.driver'];
  if (driver !== 'database' && driver !== 'cookie') {
    problems.push(`session.driver '${driver}' is not supported by the compiled rung (database/cookie only)`);
  }
  if (runtimeConfig['session.encrypt']) {
    problems.push('SESSION_ENCRYPT=true (EncryptedStore) is not supported by the compiled rung yet');
  }
  if (runtimeConfig['cookies.serialize']) {
    problems.push('EncryptCookies::$serialize must be false (cookie serialization is not ported)');
  }
  if ((runtimeConfig['hashing.driver'] || 'bcrypt') !== 'bcrypt') {
    problems.push(`hashing.driver '${runtimeConfig['hashing.driver']}' is not supported (bcrypt only)`);
  }
  const thirdPartyGuards = Object.entries(runtimeConfig)
    .filter(([k, v]) => k.startsWith('auth.guards.') && v && v.driver && v.driver !== 'session')
    .map(([k, v]) => `${k} (driver '${v.driver}')`);
  if (thirdPartyGuards.length) {
    problems.push(`guard(s) with a non-session driver: ${thirdPartyGuards.join(', ')} (only the session guard is ported)`);
  }
  if (problems.length) {
    fail('unsupported runtime config (the compiled rung would diverge from PHP):\n  - ' + problems.join('\n  - '));
  }
  writeFileSync(
    join(dist, 'src', 'config.generated.mjs'),
    '// generated by build.mjs — do not edit\n' + 'export default ' + JSON.stringify(runtimeConfig, null, 2) + ';\n'
  );
  console.log(`  -> dist/src/config.generated.mjs (session: ${driver}, guard: ${runtimeConfig['auth.defaults.guard']})`);
}

// Eloquent auth providers name their model as a string; the compiled rung needs the
// generated Model class, so those FQCNs are always dumped into models.generated.mjs.
const authProviderFqcns = Object.entries(runtimeConfig)
  .filter(([k, v]) => k.startsWith('auth.providers.') && v && v.driver === 'eloquent' && typeof v.model === 'string')
  .map(([, v]) => v.model);

// ---------- 3c. compile view controllers ----------
const slugifyRoute = (route) =>
  route.replace(new RegExp('^/'), '').replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'home';

mkdirSync(join(dist, 'src', 'controllers'), { recursive: true });
mkdirSync(join(dist, 'src', 'views'), { recursive: true });
mkdirSync(join(dist, 'src', 'contexts'), { recursive: true });

const controllerByRoute = new Map();

for (const [route, view] of viewMap) {
  const slug = slugifyRoute(route);
  const dumpPath = join(cacheDir, view + '.compiled.json');
  console.log(`compiling view ${view} for ${route}`);
  execFileSync(PHP, [join(pkgDir, 'tools', 'compile-view.php'), view, dumpPath, route], {
    cwd: appDir,
    env: { ...process.env, LW_APP_ROOT: appDir },
  });
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  if (!dump || typeof dump.compiled !== 'string') fail('compile-view produced no compiled PHP for ' + route);

  const viewModulePath = join(dist, 'src', 'views', view + '.mjs');
  execFileSync('node', [join(pkgDir, 'compiler', 'bin', 'transpile.mjs'), dumpPath, '--json', '--out', viewModulePath], { cwd: appDir });

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

// ---------- 3c2. transpile controllers (GET-only routes that still need a port) ----------
// A route only leaves the "needs a port" list when its controller method was fully
// transpiled at build time. Anything outside the supported subset (POST flows, auth,
// relations, unknown calls, non-scalar params, ...) stays blocked under --strict or
// keeps needing a port — the build never silently degrades.
const controllerRoutes = new Map(); // route -> { slug, fqcn, method }
{
  const methodsOk = (route) => {
    const others = [...(methodsFor.get(route) || new Set())].filter((m) => m !== 'HEAD');
    return others.length === 1 && others[0] === 'GET';
  };
  // Routes on the default web/api groups are transpiled. auth/guest are honoured
  // by kernel/http.mjs, so they are benign at transpile time too. Any other
  // middleware (throttle, verified, can:, custom) would be bypassed at the edge,
  // so those routes stay "needs a port" instead of silently opening up.
  const benignMiddleware = new Set(['web', 'api', 'substitute_bindings', 'bindings', 'auth', 'guest']);
  const targets = [];
  for (const { route } of needsPort) {
    if (!methodsOk(route)) continue;
    const action = actionForRoute(route);
    if (!action || action === 'Closure') continue;
    const mwList = middlewareForRoute(route) || [];
    const blocking = mwList.filter((m) => !benignMiddleware.has(String(m).split(':')[0]));
    if (blocking.length) {
      const throttled = mwList.some((m) => String(m).split(':')[0] === 'throttle');
      console.log(
        `  skip controller ${route}: middleware [${blocking.join(', ')}] not transpiled — ${
          throttled
            ? 'throttle needs the D1 rate-limit store (not wired yet) or a port'
            : 'write a port'
        }`
      );
      continue;
    }
    const at = action.lastIndexOf('@');
    const fqcn = at >= 0 ? action.slice(0, at) : action;
    const method = at >= 0 ? action.slice(at + 1) : '__invoke';
    if (!/^[A-Za-z_][A-Za-z0-9_\\]*$/.test(fqcn) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(method)) continue;
    targets.push({ route, fqcn, method });
  }

  if (targets.length) {
    console.log(`• controller routes: trying to transpile ${targets.length} route(s)`);

    const formatControllerError = (e) => {
      const raw = String(e.stderr || e.stdout || e.message || '').trim();
      try {
        const errs = JSON.parse(raw);
        if (Array.isArray(errs) && errs.length) {
          return errs
            .map((x) => `${x.code || 'LW'} ${x.message || ''}${x.line ? ` (line ${x.line})` : ''}`)
            .join('; ');
        }
      } catch {
        /* not a JSON error payload */
      }
      return raw.slice(0, 300) || 'unknown error';
    };

    // resolve controller PHP files through the app's composer PSR-4 map
    let psr4 = {};
    try {
      const composer = JSON.parse(readFileSync(join(appDir, 'composer.json'), 'utf8'));
      psr4 = Object.fromEntries(
        Object.entries((composer.autoload && composer.autoload['psr-4']) || {}).map(([prefix, dirs]) => [
          prefix,
          Array.isArray(dirs) ? dirs : [dirs],
        ])
      );
    } catch {
      /* defaults below win */
    }
    const resolvePsr4 = (fqcn) => {
      let best = null;
      for (const [prefix, dirs] of Object.entries(psr4)) {
        if (fqcn.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, dirs];
      }
      if (!best) return null;
      const rest = fqcn.slice(best[0].length).replace(/\\/g, '/') + '.php';
      for (const d of best[1]) {
        const p = join(appDir, String(d).replace(/[\\/]+$/, ''), rest);
        if (existsSync(p)) return p;
      }
      return null;
    };

    mkdirSync(join(dist, 'src', 'controllers'), { recursive: true });
    mkdirSync(join(dist, 'src', 'views'), { recursive: true });
    mkdirSync(join(dist, 'src', 'contexts'), { recursive: true });
    const metaDir = join(cacheDir, 'controllers');
    mkdirSync(metaDir, { recursive: true });

    // phase A: extract method metadata (params, model classes, views)
    const prepared = [];
    for (const t of targets) {
      const file = resolvePsr4(t.fqcn);
      if (!file) {
        console.log(`  controller ${t.route}: skipped — cannot resolve ${t.fqcn} via composer autoload`);
        continue;
      }
      try {
        const out = execFileSync(
          process.execPath,
          [join(pkgDir, 'compiler', 'bin', 'controller.mjs'), 'extract', '--file', file, '--method', t.method],
          { cwd: appDir }
        ).toString('utf8');
        prepared.push({ ...t, file, meta: JSON.parse(out) });
      } catch (e) {
        console.log(`  controller ${t.route}: skipped — ${formatControllerError(e)}`);
      }
    }

    if (prepared.length) {
      // phase B: model metadata (one PHP dump for every referenced class)
      const aliasToFqcns = new Map(); // alias -> Set(fqcn)
      for (const p of prepared) {
        for (const c of p.meta.classes || []) {
          const set = aliasToFqcns.get(c.alias) || new Set();
          set.add(c.fqcn);
          aliasToFqcns.set(c.alias, set);
        }
      }
      const allFqcns = [...new Set([...aliasToFqcns.values()].flatMap((s) => [...s]))];
      // Eloquent auth provider models (config('auth.providers.*.model')) must be in the
      // generated registry even when no compiled controller references them.
      for (const fqcn of authProviderFqcns) {
        const short = fqcn.split('\\').pop();
        if (!aliasToFqcns.has(short)) aliasToFqcns.set(short, new Set());
        aliasToFqcns.get(short).add(fqcn);
        if (!allFqcns.includes(fqcn)) allFqcns.push(fqcn);
      }
      const modelDump = new Map();
      if (allFqcns.length) {
        console.log(`• dumping model metadata (${allFqcns.length}): ${allFqcns.join(', ')}`);
        try {
          const raw = execFileSync(PHP, [join(pkgDir, 'tools', 'model-dump.php'), ...allFqcns], {
            cwd: appDir,
            env: { ...process.env, LW_APP_ROOT: appDir },
          }).toString('utf8');
          for (const d of JSON.parse(raw)) modelDump.set(d.fqcn, d);
        } catch (e) {
          console.log(
            `  model dump failed — controller routes stay blocked: ${String(e.stderr || e.message || '')
              .trim()
              .slice(0, 200)}`
          );
        }
      }

      // views used by prepared controllers (compiled once; skipped views block their routes)
      const neededViews = new Set();
      for (const p of prepared) for (const v of p.meta.views || []) neededViews.add(v);
      const compiledViews = new Set();
      for (const view of neededViews) {
        const viewModulePath = join(dist, 'src', 'views', view + '.mjs');
        if (existsSync(viewModulePath)) {
          compiledViews.add(view);
          continue;
        }
        console.log(`compiling view ${view} (controller)`);
        try {
          const dumpPath = join(cacheDir, view + '.compiled.json');
          execFileSync(PHP, [join(pkgDir, 'tools', 'compile-view.php'), view, dumpPath, '/'], {
            cwd: appDir,
            env: { ...process.env, LW_APP_ROOT: appDir },
          });
          const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
          if (!dump || typeof dump.compiled !== 'string') throw new Error('compile-view produced no compiled PHP');
          execFileSync('node', [join(pkgDir, 'compiler', 'bin', 'transpile.mjs'), dumpPath, '--json', '--out', viewModulePath], {
            cwd: appDir,
          });
          writeFileSync(join(dist, 'src', 'contexts', view + '.mjs'), 'export default ' + JSON.stringify(dump.context) + ';\n');
          compiledViews.add(view);
        } catch (e) {
          console.log(`  view ${view}: skipped — ${String(e.stderr || e.message || '').trim().slice(0, 300)}`);
        }
      }

      // generated model classes + route-name -> uri map (imported by controller handlers)
      const classVarNames = new Map(); // fqcn -> generated class identifier
      const modelLines = ['// generated by laravel-workers — do not edit', "import { Model } from '../kernel/model.mjs';", ''];
      for (const [, fqcns] of aliasToFqcns) {
        for (const fqcn of fqcns) {
          if (classVarNames.has(fqcn)) continue;
          const d = modelDump.get(fqcn);
          if (!d || !d.model) continue;
          const varName = 'M_' + fqcn.replace(/[^A-Za-z0-9]/g, '_');
          classVarNames.set(fqcn, varName);
          modelLines.push(`export class ${varName} extends Model {}`);
          modelLines.push(`${varName}.table = ${JSON.stringify(d.table)};`);
          modelLines.push(`${varName}.primaryKey = ${JSON.stringify(d.primaryKey || 'id')};`);
          modelLines.push(`${varName}.casts = ${JSON.stringify(d.casts || {})};`);
          modelLines.push(`${varName}.timestamps = ${d.timestamps === false ? 'false' : 'true'};`);
          modelLines.push(`${varName}.softDeletes = ${d.softDeletes ? 'true' : 'false'};`);
          modelLines.push(`${varName}.hidden = ${JSON.stringify(d.hidden || [])};`);
          modelLines.push(`${varName}.appends = ${JSON.stringify(d.appends || [])};`);
          modelLines.push('');
        }
      }
      const mapPairs = [];
      for (const [alias, fqcns] of aliasToFqcns) {
        if (fqcns.size !== 1) continue; // ambiguous alias: never guessed
        const fqcn = [...fqcns][0];
        if (!classVarNames.has(fqcn)) continue;
        mapPairs.push(`${JSON.stringify(alias)}: ${classVarNames.get(fqcn)}`);
        mapPairs.push(`${JSON.stringify(fqcn)}: ${classVarNames.get(fqcn)}`);
      }
      modelLines.push('export const models = { ' + mapPairs.join(', ') + ' };');
      const routeMapObj = {};
      for (const route of routes) {
        const { name } = metaForRoute(route);
        if (name && !(name in routeMapObj)) routeMapObj[name] = route.replace(/^\//, '');
      }
      modelLines.push('export const routeMap = ' + JSON.stringify(routeMapObj) + ';');
      modelLines.push('');
      writeFileSync(join(dist, 'src', 'models.generated.mjs'), modelLines.join('\n'));

      // phase C: emit one handler module per transpilable route
      let emittedCount = 0;
      for (const p of prepared) {
        const ambiguous = (p.meta.classes || []).find((c) => (aliasToFqcns.get(c.alias) || new Set()).size > 1);
        if (ambiguous) {
          console.log(`  controller ${p.route}: skipped — model alias "${ambiguous.alias}" is ambiguous between namespaces`);
          continue;
        }
        const badModel = (p.meta.classes || []).find((c) => {
          const d = modelDump.get(c.fqcn);
          return !d || !d.model;
        });
        if (badModel) {
          const d = modelDump.get(badModel.fqcn);
          console.log(
            `  controller ${p.route}: skipped — ${badModel.fqcn} is not a usable Eloquent model${
              d && d.error ? ' (' + d.error + ')' : ''
            }`
          );
          continue;
        }
        const missingView = (p.meta.views || []).find((v) => !compiledViews.has(v));
        if (missingView) {
          console.log(`  controller ${p.route}: skipped — view "${missingView}" did not compile`);
          continue;
        }
        const slug = slugifyRoute(p.route);
        const meta = {
          routeUri: p.route,
          routeParams: (p.route.match(/\{([^}]+)\}/g) || []).map((s) => s.slice(1, -1).replace(/[?*]$/, '')),
          models: (p.meta.classes || []).map((c) => ({ alias: c.alias, fqcn: c.fqcn })),
          views: p.meta.views || [],
        };
        const metaPath = join(metaDir, slug + '.meta.json');
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        const outPath = join(dist, 'src', 'controllers', slug + '.mjs');
        try {
          execFileSync(
            process.execPath,
            [
              join(pkgDir, 'compiler', 'bin', 'controller.mjs'),
              'emit',
              '--file', p.file,
              '--method', p.method,
              '--meta', metaPath,
              '--out', outPath,
            ],
            { cwd: appDir }
          );
          controllerRoutes.set(p.route, { slug, fqcn: p.fqcn, method: p.method });
          emittedCount++;
          console.log(`  controller ${p.route} -> dist/src/controllers/${slug}.mjs (${p.fqcn}@${p.method})`);
        } catch (e) {
          console.log(`  controller ${p.route}: skipped — ${formatControllerError(e)}`);
        }
      }
      if (emittedCount) {
        console.log(`• controllers transpiled: ${emittedCount}/${targets.length}`);
        for (let i = needsPort.length - 1; i >= 0; i--) {
          if (controllerRoutes.has(needsPort[i].route)) needsPort.splice(i, 1);
        }
      }
    }
  }
}

// Always emit models.generated.mjs (even with no compiled controllers) so the
// worker template can import `models` / `routeMap` unconditionally.
if (!existsSync(join(dist, 'src', 'models.generated.mjs'))) {
  writeFileSync(
    join(dist, 'src', 'models.generated.mjs'),
    '// generated by laravel-workers — do not edit\nimport { Model } from \'../kernel/model.mjs\';\n\nexport const models = { };\nexport const routeMap = {};\n'
  );
}

// ---------- 3d. schema snapshot ----------
mkdirSync(cacheDir, { recursive: true });
const schemaPath = join(cacheDir, 'schema.json');
console.log('\u2022 dumping DB schema');
execFileSync(PHP, [join(pkgDir, 'tools', 'schema-dump.php'), schemaPath], {
  cwd: appDir,
  env: { ...process.env, LW_APP_ROOT: appDir },
});
cpSync(schemaPath, join(dist, 'schema.json'));
console.log('  -> dist/schema.json');

// ---------- 4. copy static assets ----------
for (const f of ['build', 'favicon.ico', 'robots.txt']) {
  const src = join(appDir, 'public', f);
  if (!existsSync(src)) {
    console.log(`  ! public/${f} missing — skipped`);
    continue;
  }
  cpSync(src, join(dist, 'public', f), { recursive: true });
  console.log(`• copied public/${f}`);
}

// ---------- 5. worker + ports + routes ----------
const workerCandidates = [join(appDir, 'src/worker.mjs'), join(pkgDir, 'src/worker.mjs')];
let workerSrc = null;
for (const p of workerCandidates) if (existsSync(p)) { workerSrc = p; break; }
if (!workerSrc) fail('no worker template found — looked for src/worker.mjs in the app and in the package (reinstall laravel-workers)');
cpSync(workerSrc, join(dist, 'src/worker.mjs'));
const portsCandidates = [
  ...(lwPortsDir ? [lwPortsDir] : []),
  join(appDir, 'src/ports'),
  join(appDir, 'ports'),
  join(appDir, 'edge/src/ports'),
  join(pkgDir, 'src/ports'),
];
let portsSrc = null;
for (const p of portsCandidates) if (existsSync(p)) { portsSrc = p; break; }
if (!portsSrc) portsSrc = join(pkgDir, 'src/ports');
if (portsSrc === lwPortsDir) console.log(`• ports: LW_PORTS_DIR -> ${portsSrc}`);
const missingPortFiles = portEntries
  .map(([route, name]) => [route, String(name)])
  .filter(([, slug]) => !existsSync(join(portsSrc, slug + '.mjs')));
if (missingPortFiles.length)
  fail(
    'port file(s) missing in ' + portsSrc + ': ' +
      missingPortFiles.map(([route, slug]) => `${route} -> ${slug}.mjs`).join(', ') +
      ' — create them, fix the "ports" mapping in registry.json, or point LW_PORTS_DIR at the right directory'
  );
if (existsSync(portsSrc)) {
  cpSync(portsSrc, join(dist, 'src/ports'), { recursive: true });
} else {
  mkdirSync(join(dist, 'src/ports'), { recursive: true });
  console.log('  ! no ports directory found — created empty dist/src/ports');
}
cpSync(join(pkgDir, 'kernel'), join(dist, 'kernel'), { recursive: true });
cpSync(join(pkgDir, 'compiler', 'runtime'), join(dist, 'src', 'runtime'), { recursive: true });

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
  if (controllerRoutes.has(route)) {
    const info = controllerRoutes.get(route);
    return { uri: route, ...metaForRoute(route), methods: [...(methodsFor.get(route) || new Set())], kind: 'controller', controller: info.slug };
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

// ---------- 5a. middleware audit ----------
// kernel/http.mjs honours exactly this set. Anything else on a view / controller /
// snapshot route would be bypassed at the edge — fail the build instead.
{
  const RUNTIME_MIDDLEWARE = new Set(['web', 'api', 'substitute_bindings', 'bindings', 'auth', 'guest']);
  const offenders = [];
  for (const entry of routeTable) {
    if (entry.kind !== 'view' && entry.kind !== 'controller' && entry.kind !== 'snapshot') continue;
    const bad = (entry.middleware || []).filter((m) => !RUNTIME_MIDDLEWARE.has(String(m).split(':')[0]));
    if (bad.length) offenders.push(`${entry.uri} [${bad.join(', ')}] (${entry.kind})`);
  }
  if (offenders.length) {
    fail(
      'route middleware the compiled rung does not honour:\n  - ' +
        offenders.join('\n  - ') +
        '\n  add a port for these routes, or drop the middleware'
    );
  }
}

const controllerImports = [];
const controllerMap = [];
let controllerIndex = 0;
for (const route of routes) {
  const entry = routeTable.find((r) => r.uri === route);
  if (entry && (entry.kind === 'view' || entry.kind === 'port' || entry.kind === 'controller')) {
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
// ---------- 5b. Cloudflare Static Assets routing ----------
mkdirSync(join(dist, 'public'), { recursive: true });
const routesJson = buildRoutesJson(routeTable, { publicDirs: ['build'], extraInclude: ['/health'] });
writeFileSync(join(dist, 'public', '_routes.json'), JSON.stringify(routesJson, null, 2) + '\n');
console.log(`  -> dist/public/_routes.json (${(routesJson.include || []).length} include, ${(routesJson.exclude || []).length} exclude)`);

// ---------- 6. coverage report ----------
const unknown = [
  ...new Set([
    ...staticMap.map(([r]) => r),
    ...portEntries.map(([r]) => r),
    ...viewMap.map(([r]) => r),
    ...ignoreMap.map(([r]) => r),
  ]),
].filter((r) => !routes.includes(r));
const stubPorts = findStubPorts(portsSrc);
const blocked = needsPort.length > 0 || partials.length > 0 || unknown.length > 0 || stubPorts.length > 0;

if (snapshots.length) console.log(`• auto-snapshots (${snapshots.length}): ${snapshots.join(', ')}`);
for (const p of partials)
  console.log(`  WARN ${p.route}: GET is snapshotted, but ${p.methods.join(', ')} needs a port`);
for (const n of needsPort) console.log(`  UNHANDLED ${n.route}: ${n.reason}`);
if (needsPort.length)
  console.log('  -> add a port, a "static" entry, or "ignore" (with a reason) in registry.json');
if (unknown.length) console.log(`  registry entries not found in route:list: ${unknown.join(', ')}`);
if (stubPorts.length)
  console.log(
    `  STUB ${stubPorts.length} port(s) not implemented yet (returning 501): ${stubPorts
      .map((n) => relative(appDir, join(portsSrc, n)))
      .join(', ')}`
  );
if (!blocked)
  console.log(
    `• coverage: all ${routes.length} route(s) handled — static ${staticMap.length}, snapshots ${snapshots.length}, ports ${portEntries.length}, controllers ${controllerRoutes.size}, ignored ${ignoreMap.length}`
  );

// ---------- 7. scaffold stubs for routes that need a port ----------
if (scaffold && needsPort.length) {
  const slugify = (route) =>
    route.replace(/^\//, '').replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'home';
  const entries = needsPort.map(({ route }) => ({ route, slug: slugify(route) }));
  for (const { route, slug } of entries) {
    const stubDir = isNpmMode ? (portsSrc !== join(pkgDir, 'src/ports') ? portsSrc : join(appDir, 'src/ports')) : join(pkgDir, 'src/ports');
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, `${slug}.mjs`);
    if (existsSync(stub)) {
      console.log(`  scaffold: ${relative(appDir, stub)} already exists`);
    } else {
      writeFileSync(stub, buildStubSource(route));
      console.log(`  scaffolded ${relative(appDir, stub)} (${STUB_MARKER} — build --strict fails until implemented)`);
    }
  }
  const { registry: nextRegistry, added } = mergePorts(registry, entries);
  if (added.length) {
    writeFileSync(registryPath, serializeRegistry(nextRegistry));
    for (const { route, slug } of added) {
      console.log(`  registry.json: "ports" += ${JSON.stringify(route)}: ${JSON.stringify(slug)}`);
    }
  } else {
    console.log('  registry.json: all scaffolded ports already registered');
  }
}
if (blocked && !scaffold) {
  if (needsPort.length) console.log('  (tip: re-run with --scaffold to generate + register port stubs)');
  else if (stubPorts.length) console.log('  (tip: implement the stub port(s), then re-run)');
}
if (strict && blocked) {
  const stubNote = stubPorts.length
    ? ` — ${stubPorts.length} port(s) are still scaffold stubs (returning 501): ${stubPorts.join(', ')}`
    : '';
  fail(
    'coverage check failed (--strict)' +
      (scaffold ? ' — port stubs were scaffolded + registered; implement them, then re-run' : '') +
      stubNote
  );
}

console.log(
  `done. dist: ${relative(appDir, dist)}  (static: ${staticMap.length}, snapshots: ${snapshots.length}, ports: ${portEntries.length}, controllers: ${controllerRoutes.size}, ignored: ${ignoreMap.length})`
);
