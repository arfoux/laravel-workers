// tools/build-cache.mjs — content hash for the "nothing changed" fast path.
//
// The build's OUTPUT is a pure function of the app's source, the build tools,
// the registry, the PHP version and a small set of build-affecting environment
// values. Hashing mtimes is not enough: a checkout, a branch switch or a
// formatter can rewrite a file without changing its content, and a copied tree
// can carry old mtimes over new content. Every input below contributes its
// bytes.
//
// Deliberately NOT hashed:
//   - vendor/ wholesale: composer.lock + installed.php are the identity of the
//     dependency graph; hashing thousands of vendor files on every build costs
//     more than the build itself.
//   - node_modules/: package-lock.json + package.json identify it.
//   - storage/, tests/, .cache/, dist/: not inputs to the emitted worker.
//
// The cache is a LOCAL convenience, not a deployment artifact. `--no-cache`
// (or LW_NO_BUILD_CACHE=1) is the escape hatch when an operator changes
// something the key does not model.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// `public` is copied wholesale into the worker's Static Assets (except
// symlinks), so its bytes are an input too. It also contains the snapshots the
// build writes; those are deterministic for unchanged inputs and the stamp is
// taken after the build, so they do not make the cache self-invalidating.
const APP_DIRS = ['app', 'bootstrap', 'config', 'database', 'routes', 'lang', 'resources/views', 'resources/lang', 'public'];
const APP_FILES = [
  'composer.json',
  'composer.lock',
  '.env',
  '.env.example',
  'artisan',
  'package.json',
  'vite.config.js',
  'vite.config.ts',
  'vite.config.mjs',
  'vite.config.cjs',
  'tailwind.config.js',
  'tailwind.config.ts',
  'tailwind.config.cjs',
  'postcss.config.js',
  'postcss.config.cjs',
  'public/build/manifest.json',
  'public/build/.vite/manifest.json',
  'public/build/fonts-manifest.json',
  'public/hot',
  'public/mix-manifest.json',
];
// The worker's own source (`src/worker.mjs`) ships into every artifact; it is
// as much a compiler input as tools/.
const TOOL_DIRS = ['tools', 'compiler', 'kernel', 'bin', 'src'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '.wrangler', 'coverage', 'tests', 'test', '__tests__']);
const ENV_KEYS = [
  'APP_ENV',
  'APP_URL',
  'APP_KEY',
  'APP_DEBUG',
  'DB_CONNECTION',
  'DB_DATABASE',
  'DB_HOST',
  'DB_PORT',
  'DB_USERNAME',
  'CACHE_STORE',
  'CACHE_DRIVER',
  'SESSION_DRIVER',
  'QUEUE_CONNECTION',
  'FILESYSTEM_DISK',
  'MAIL_MAILER',
  'LOG_CHANNEL',
  'LW_APP_ROOT',
  'LW_VENDOR_DIR',
  'LW_CONFIG',
  'LW_PORTS_DIR',
  'NODE_ENV',
];

function makeHasher() {
  const hash = createHash('sha256');
  const stats = { files: 0, bytes: 0 };
  const add = (label, value) => {
    hash.update(String(label));
    hash.update('\0');
    hash.update(value);
    hash.update('\0');
  };
  const addFile = (root, file) => {
    const abs = join(root, file);
    if (!existsSync(abs)) return;
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    const rel = relative(root, abs).split('\\').join('/');
    add('file:' + rel, readFileSync(abs));
    stats.files++;
    stats.bytes += st.size;
  };
  const addTree = (root, dir) => {
    const abs = join(root, dir);
    if (!existsSync(abs)) return;
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    const walk = (current) => {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) continue;
          walk(join(current, ent.name));
          continue;
        }
        if (ent.isSymbolicLink()) {
          const rel = relative(root, join(current, ent.name)).split('\\').join('/');
          try {
            add('link:' + rel, readlinkSync(join(current, ent.name)));
          } catch {
            /* unreadable link: ignore */
          }
          continue;
        }
        if (!ent.isFile()) continue;
        const file = relative(root, join(current, ent.name)).split('\\').join('/');
        addFile(root, file);
      }
    };
    walk(abs);
  };
  return { add, addFile, addTree, stats, digest: () => hash.digest('hex') };
}

export function computeBuildCacheKey({
  appDir,
  pkgDir,
  registryPath,
  vendorDir,
  php,
  flags,
  env,
}) {
  const h = makeHasher();

  h.add('schema', 'laravel-workers/build-cache/v1');
  h.add('php', String((php && php.version) || ''));
  h.add('flags', JSON.stringify(flags || {}));
  const envSlice = {};
  for (const key of ENV_KEYS) {
    if (env && Object.prototype.hasOwnProperty.call(env, key) && env[key] != null) {
      envSlice[key] = String(env[key]);
    }
  }
  h.add('env', JSON.stringify(envSlice));

  if (registryPath && existsSync(registryPath)) {
    h.add('registry', readFileSync(registryPath));
    h.stats.files++;
    try {
      h.stats.bytes += statSync(registryPath).size;
    } catch {
      /* ignore */
    }
  }

  for (const file of APP_FILES) h.addFile(appDir, file);
  for (const dir of APP_DIRS) h.addTree(appDir, dir);

  // Composer's own identity, not the whole vendor tree.
  const vendorRoot = vendorDir || join(appDir, 'vendor');
  for (const file of ['composer/installed.php', 'composer/installed.json', 'autoload.php']) {
    h.addFile(vendorRoot, file);
  }

  for (const file of ['build.mjs', 'package.json', 'package-lock.json']) h.addFile(pkgDir, file);
  for (const dir of TOOL_DIRS) h.addTree(pkgDir, dir);

  return { key: h.digest(), files: h.stats.files, bytes: h.stats.bytes };
}
