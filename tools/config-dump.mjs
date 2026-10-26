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
//   - the errors/405.blade.php existence check (errors.405_view)

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evalConfigExpr, parsePhpFile, configGet, loadConfig, readEnvFile, appMiddlewareState, returnExpr } from './static.mjs';

const appDir =
  process.env.LW_APP_ROOT ||
  (existsSync(join(process.cwd(), 'artisan')) ? process.cwd() : null);

if (!appDir) {
  process.stderr.write('config-dump.mjs: cannot find app root (set LW_APP_ROOT)\n');
  process.exit(1);
}

// Normalise path separators to what PHP emits (forward slashes everywhere).
const phpPath = (p) => String(p || '').replace(/\\/g, '/');

const env = readEnvFile(appDir);
const { config, error } = loadConfig(appDir, env);
const mw = appMiddlewareState(appDir) || {};

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
$put('app.timezone', c('app.timezone'));

// ---------- pagination ----------
// Laravel's default pagination view is the `pagination::tailwind` namespace.
$put('pagination.view', String(c('view.pagination') || 'pagination::tailwind'));

// ---------- translations ----------
const translations = {};
const langPaths = [];
{
  const frameworkLang = join(appDir, 'vendor', 'laravel', 'framework', 'src', 'Illuminate', 'Translation', 'lang');
  if (existsSync(frameworkLang)) langPaths.push(frameworkLang);
  const langDir = join(appDir, 'lang');
  if (existsSync(langDir)) langPaths.push(langDir);
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

// ---------- errors (405) ----------
let has405 = false;
{
  const viewPaths = c('view.paths');
  const list = Array.isArray(viewPaths) ? viewPaths : [join(appDir, 'resources', 'views')];
  for (const vp of list) {
    if (existsSync(join(String(vp), 'errors', '405.blade.php'))) { has405 = true; break; }
  }
}
$put('errors.405_view', has405);

// ---------- cors ----------
const corsPaths = c('cors.paths');
$put('cors.paths', Array.isArray(corsPaths) ? corsPaths : []);

// ---------- session ----------
for (const key of ['driver', 'lifetime', 'expire_on_close', 'encrypt', 'serialization', 'cookie', 'path', 'domain', 'secure', 'http_only', 'same_site', 'partitioned', 'table', 'connection', 'files', 'lottery']) {
  $put('session.' + key, c('session.' + key));
}

// ---------- cookies (EncryptCookies) ----------
$put('cookies.except', mw.cookiesExcept || []);
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

process.stdout.write(JSON.stringify(dump) + '\n');

/** Deep merge in the spirit of array_replace_recursive (later wins, both ears). */
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
