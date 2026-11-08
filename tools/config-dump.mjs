#!/usr/bin/env node
// tools/config-dump.mjs — pure-JS replacement for tools/config-dump.php
//
// Usage: node tools/config-dump.mjs
// Output (stdout): the SAME flat dotted-key JSON object config-dump.php emits
// (the shape kernel/auth.mjs and kernel/http.mjs read). No PHP interpreter, no
// composer install, no vendor download needed.
//
// What it must match:
//   - config/*.php values (env() folded from .env, casts, Str::, path helpers)
//   - the FRAMEWORK config defaults (vendor/laravel/framework/config/*.php)
//     for groups the app did not publish (hashing, cors, view, ...)
//   - the middleware configurator state bootstrap/app.php ->withMiddleware(...)
//     (cookies.except / csrf.except / allow_same_site / origin_only)
//   - translations from lang/*/<locale>/<group>.php and the framework's
//     src/Illuminate/Translation/lang (array-replace-recursive merged)
//   - AbstractPaginator::$defaultView (pagination.view)

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evalConfigExpr, parsePhpFile, configGet, loadConfig, readEnvFile, appMiddlewareState, returnExpr } from './static.mjs';
import { serializeOrdered } from './order-json.mjs';
import { deepMerge } from './deep-merge.mjs';
import { toNativePath } from './native-path.mjs';

// #401/#417: Git-Bash/MSYS hands over POSIX-style paths ("/c/Users/..."), which
// `join()`/`existsSync` on Windows read as "<cwd-drive>:\c\Users\..." - the app
// then loaded NO config at all and the dump came out all-null with **exit 0**
// (a build compiling an empty configuration, silently). Normalise the shell
// form first (shared helper, audit #803), then refuse anything that is not a
// Laravel app root.
const appDir = (() => {
  const fromEnv = toNativePath(process.env.LW_APP_ROOT);
  if (fromEnv) return fromEnv;
  return existsSync(join(process.cwd(), 'artisan')) ? process.cwd() : null;
})();

if (!appDir) {
  process.stderr.write('config-dump.mjs: cannot find app root (set LW_APP_ROOT)\n');
  process.exit(1);
}

if (!existsSync(join(appDir, 'artisan'))) {
  process.stderr.write(
    `config-dump.mjs: ${appDir} is not a Laravel app root (no artisan) — check LW_APP_ROOT\n`
  );
  process.exit(1);
}

// Normalise path separators to what PHP emits (forward slashes everywhere).
const phpPath = (p) => String(p || '').replace(/\\/g, '/');

// Laravel's Env reads the process environment FIRST (Env::getRepository() is
// immutable), so the build's own child environment — the same one the PHP
// oracle boots with — has to be the seed here too. Without it a config value
// that only lives in the shell (CI: CACHE_STORE, APP_URL, ...) would fold
// differently from the app's own boot.
const env = readEnvFile(appDir, process.env);
const { config, error, drops } = loadConfig(appDir, env);

// ---------- the fold's DROP report (stderr) ----------
// Every config value the build-time evaluator could NOT answer, named by group,
// key, file and line with the reason that stopped it. This goes to stderr so the
// JSON on stdout stays parseable. A refused KEY alone does not fail the dump —
// the honest failure is at the app's own `config('x')`, which the compiled worker
// answers null for (and the build's config gate reports) — but a refused
// STATEMENT (a poisoned file, see loadConfig) does, and this report is what names
// it. Before this report the entry was simply absent from the dump and nothing
// said so.
function reportDrops() {
  if (!drops || !drops.length) return;
  const rel = (p) => String(p || '?').replace(/\\/g, '/').replace(String(appDir).replace(/\\/g, '/') + '/', '');
  const seen = new Set();
  const lines = [];
  for (const d of drops) {
    const where = `${rel(d.file)}${d.line ? ':' + d.line : ''}`;
    const key =
      d.key === '<group>'
        ? `${d.group || '?'} (the whole group)`
        : d.key
          ? `${d.group || '?'}.${d.key}`
          : `${d.group || '?'}.<unknown key>`;
    const line = `${key} — ${where}: ${d.reason}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  process.stderr.write(`config-fold: ${lines.length} value(s) could not be evaluated at build time:\n`);
  for (const line of lines) process.stderr.write('  • ' + line + '\n');
  process.stderr.write(
    '  the compiled worker answers null for these keys; write the value literally in config/ ' +
      '(or add the construct to tools/static.mjs) to fold it\n'
  );
}

// A config file the fold could NOT answer is a hard failure, not a silent gap.
// `error` used to be destructured and never read, so `loadConfig()` skipping a
// group (a parse error, an unbounded loop, a construct the statement path does
// not model — audit #774-#776) left the dump WITHOUT that group and the build
// kept going: the compiled worker then answers Laravel's defaults where the real
// app answers the file. Fail loud instead — the message names file, line and
// reason, and the drop report below names the rest of the file.
if (error) {
  reportDrops();
  process.stderr.write(`config-dump: ${error}\n`);
  process.stderr.write(
    '  the app\'s config/*.php could not be folded at build time; the compiled worker would boot ' +
      'with different configuration than the app (write the value literally, or simplify the construct)\n'
  );
  process.exit(1);
}
const mwReport = {};
const mw = appMiddlewareState(appDir, mwReport) || {};
// `transformers` carries its own refusal (a skipWhen() callback or an
// unreadable `->use()` entry): the input our worker sees would differ from the
// app's.
if (mw.transformers && mw.transformers.refusal) mwReport.failure = mw.transformers.refusal;
// A middleware shape the build cannot read is a REFUSAL, not "no middleware":
// the global stack would transform input (trim / empty→null) the compiled
// request never sees, and the edge would answer different bytes.
if (mwReport.failure) {
  process.stderr.write('config-dump: ' + mwReport.failure + '\n');
  process.exit(1);
}

const dump = {};
const $put = (key, val) => { dump[key] = val; };
// configGet mirrors Config::get: a missing key answers null, not undefined.
const c = (path, def) => {
  const v = configGet(config, path, def);
  return v === undefined ? null : v;
};

// ---------- app ----------
$put('app.key', c('app.key'));
$put('app.url', c('app.url'));
$put('app.cipher', c('app.cipher'));
$put('app.env', c('app.env'));
$put('app.debug', c('app.debug'));
$put('app.locale', c('app.locale'));
// The FALLBACK locale (config/app.php `fallback_locale`): Laravel's translator
// answers a missing key from it, group by group and key by key. The runtime
// used to assume 'en', so an app with a `fr` fallback answered the wrong
// message (or the key itself) at the edge.
$put('app.fallback_locale', c('app.fallback_locale'));
$put('app.timezone', c('app.timezone'));

// ---------- pagination ----------
// Laravel's default pagination view is the `pagination::tailwind` namespace.
$put('pagination.view', String(c('view.pagination') || 'pagination::tailwind'));

// ---------- translations ----------
const translations = {};
const langPaths = [];
{
  // The framework's translation files live under the VENDOR dir — which is not
  // always `<app>/vendor`. An app with no `vendor/` of its own reaches the
  // framework through LW_VENDOR_DIR (vendor-lite's cache, or a vendor mounted
  // elsewhere); hard-coding `<app>/vendor` here silently dropped EVERY
  // framework translation, so validation messages fell back to the key and
  // `__('auth.failed')` answered the key itself (#647). Resolve the same two
  // layouts the config defaults already accept (tools/static.mjs:1593-1600)
  // and the PHP path uses (`lw_vendor_autoload_for()`).
  const frameworkLang = [
    process.env.LW_VENDOR_DIR
      ? join(process.env.LW_VENDOR_DIR, 'laravel', 'framework', 'src', 'Illuminate', 'Translation', 'lang')
      : null,
    process.env.LW_VENDOR_DIR
      ? join(process.env.LW_VENDOR_DIR, 'vendor', 'laravel', 'framework', 'src', 'Illuminate', 'Translation', 'lang')
      : null,
    join(appDir, 'vendor', 'laravel', 'framework', 'src', 'Illuminate', 'Translation', 'lang'),
  ].find((p) => p && existsSync(p)) || null;
  if (frameworkLang) langPaths.push(frameworkLang);
  // Laravel's lang_path(): `resources/lang` WINS when that directory exists,
  // otherwise `<base>/lang` (Application::useLangPath(), :440-443). An app that
  // kept the L9/L10 layout would otherwise lose every translation the worker
  // renders. FileLoader merges framework-first / app-last, per locale+group.
  const legacyLang = join(appDir, 'resources', 'lang');
  const appLangDir = existsSync(legacyLang) ? legacyLang : join(appDir, 'lang');
  if (existsSync(appLangDir)) langPaths.push(appLangDir);
}
for (const langPath of langPaths) {
  let locales = [];
  try {
    for (const name of readdirSync(langPath)) {
      if (statSync(join(langPath, name)).isDirectory()) locales.push(name);
    }
  } catch { continue; }
  for (const locale of locales) {
    let files = [];
    try {
      for (const file of readdirSync(join(langPath, locale))) if (file.endsWith('.php')) files.push(file);
    } catch { continue; }
    for (const file of files) {
      const group = file.replace(/\.php$/, '');
      const parsed = parsePhpFile(join(langPath, locale, file));
      if (parsed.error) continue;
      const retExpr = returnExpr(parsed);
      if (!retExpr) continue;
      const values = evalConfigExpr(retExpr, { env, appDir, parsed });
      if (!values || typeof values !== 'object') continue;
      // merge recursive array_replace_recursive semantics (deep merge).
      translations[locale] = translations[locale] || {};
      translations[locale][group] = deepMerge(translations[locale][group] || {}, values);
    }
  }
}
$put('translations', translations);

// ---------- cors ----------
const corsPaths = c('cors.paths');
$put('cors.paths', Array.isArray(corsPaths) ? corsPaths : []);

// ---------- session ----------
for (const key of ['driver', 'lifetime', 'expire_on_close', 'encrypt', 'serialization', 'cookie', 'path', 'domain', 'secure', 'http_only', 'same_site', 'partitioned', 'table', 'connection', 'files', 'lottery']) {
  $put('session.' + key, c('session.' + key));
}

// ---------- cookies (EncryptCookies) ----------
$put('cookies.except', mw.cookiesExcept || []);
// The input transformers Laravel's global stack runs BEFORE the router
// (TrimStrings -> ConvertEmptyStringsToNull). `trim.except` is the framework's
// own list (`TrimStrings::$except`) plus the app's `->trimStrings(except:)`
// entries (`TrimStrings::except()` merges them).
// The input transformers the app's final global stack runs (read from its own
// bootstrap/app.php; `transformers` is null for an app whose shape this dump
// cannot read - a Laravel 9/10 Kernel, or an unsupported transformer call).
const transform = mw.transformers || null;
$put('transform.trim', transform ? transform.trim !== false : true);
$put('transform.empty_to_null', transform ? transform.emptyToNull !== false : true);
// TrimStrings::transform() merges the framework's own list
// (`TrimStrings::$except`, the three password fields) with the app's
// `TrimStrings::except()` / `->trimStrings(except:)` entries; the skip is
// `Str::is($except, $key)`, so a nested key matches through the pattern.
// The list is COMPUTED at build time (`appMiddlewareState` walks the app's
// final global stack and answers `Transformers::$except`'s accumulated value
// plus `TrimStrings::except()`), because `->trimStrings(except: [...])` and
// `TrimStrings::except()` are app decisions the three names below cannot
// express: an app that added `card_number` had that field trimmed at the edge
// while Laravel skipped it. The kernel reads this key as
// `transformers.trimExcept` (kernel/http.mjs:1481); the framework list stays
// the fallback for a dump whose transformer shape could not be read
// (`transform` is null then, and both passes run).
// TrimStrings::skipWhen() and a Closure inside ->trimStrings() are refusals
// above (`mwReport.failure`), so a readable list here is exact.
const frameworkTrimExcept = [
  'current_password',
  'password',
  'password_confirmation',
];
$put('transform.trim.except', transform && Array.isArray(transform.trimExcept)
  ? transform.trimExcept
  : frameworkTrimExcept);
// Global middleware on the app's final stack that the compiled kernel does not
// implement (TrustHosts, HandleCors, TrustProxies, an app class, ...). Every
// request fails loud in the worker; the build reports them.
$put('middleware.prevented', transform && Array.isArray(transform.prevented) ? transform.prevented : []);
$put('cookies.serialize', false);

// ---------- csrf (PreventRequestForgery) ----------
$put('csrf.except', mw.csrfExcept || []);
$put('csrf.allow_same_site', mw.allowSameSite || false);
$put('csrf.origin_only', mw.originOnly || false);

// ---------- auth ----------
$put('auth.defaults.guard', c('auth.defaults.guard'));
$put('auth.defaults.passwords', c('auth.defaults.passwords'));
$put('auth.defaults.provider', c('auth.defaults.provider'));
for (const [name, guard] of Object.entries(c('auth.guards') || {})) $put('auth.guards.' + name, guard);
for (const [name, provider] of Object.entries(c('auth.providers') || {})) $put('auth.providers.' + name, provider);
for (const [name, broker] of Object.entries(c('auth.passwords') || {})) $put('auth.passwords.' + name, broker);
$put('auth.hash_key', c('app.key'));
$put('auth.timebox_duration', c('auth.timebox_duration', 200000));
$put('auth.rehash_on_login', c('hashing.rehash_on_login', true));

// ---------- hashing ----------
$put('hashing.driver', c('hashing.driver'));
$put('hashing.bcrypt.rounds', c('hashing.bcrypt.rounds'));
$put('hashing.bcrypt.verify', c('hashing.bcrypt.verify'));
$put('hashing.bcrypt.limit', c('hashing.bcrypt.limit'));

// ---------- cache ----------
const defaultCache = c('cache.default');
const isCacheArr = Array.isArray(defaultCache);
const cacheStore = isCacheArr ? defaultCache : c('cache.stores.' + defaultCache, {});
$put('cache.default', isCacheArr ? 'database' : defaultCache);
$put('cache.prefix', c('cache.prefix'));
$put('cache.driver', cacheStore?.driver ?? null);
$put('cache.table', cacheStore?.table ?? 'cache');
$put('cache.lock_table', cacheStore?.lock_table ?? 'cache_locks');
$put('cache.serializable_classes', c('cache.serializable_classes', null));

// ---------- mail ----------
$put('mail.driver', c('mail.default'));
$put('mail.from.address', c('mail.from.address'));

// ---------- filesystems ----------
const defaultDisk = c('filesystems.default');
$put('filesystems.default', defaultDisk);
const disksObj = c('filesystems.disks') || {};
$put('filesystems.disks', Object.keys(disksObj));
for (const [name, disk] of Object.entries(disksObj)) {
  $put('filesystems.disks.' + name + '.driver', disk && typeof disk === 'object' && 'driver' in disk ? disk.driver : null);
}

// ---------- the app's own config groups (registry.json "config") ----------
// The dump above is a curated set: framework keys plus the app values the
// compiled rung is known to read. An app config group (`config/needs.php` →
// `needs.*`) is NOT part of it unless declared, and a compiled
// `config('needs.categories')` would then answer null where PHP answers the
// value. The build passes the declared groups on argv; the whole group tree is
// dumped (arrays at their own key too, so `config('needs.categories')` and
// `config('needs.categories.0.id')` both resolve).
for (const group of process.argv.slice(2).map((g) => g.trim()).filter(Boolean)) {
  const tree = configGet(config, group);
  if (tree === undefined) continue; // the build refuses a declared-but-empty group
  const putTree = (prefix, value) => {
    dump[prefix] = value === undefined ? null : value;
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) putTree(prefix + '.' + k, v);
    }
  };
  if (!Object.prototype.hasOwnProperty.call(dump, group)) putTree(group, tree);
}

reportDrops();

// `serializeOrdered` carries each value's PHP key order (`__lwOrder`, #416);
// a plain JSON.stringify would drop the non-enumerable marker and reorder a
// `[-1 => 'm', 'n']`-shaped config value.
process.stdout.write(serializeOrdered(dump) + '\n');
