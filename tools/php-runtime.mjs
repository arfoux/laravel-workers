// tools/php-runtime.mjs — which PHP interpreter boots the app?
//
// The build uses PHP only as a BUILD-TIME ORACLE: it boots the real Laravel app
// (route:list, config-dump, model-dump, compile-view, ...) and compiles the
// answers to JS. The edge never runs PHP. The interpreter is therefore a tool,
// not a runtime — and the only hard requirement is that it can parse and boot
// the app, i.e. that it satisfies the app's own `composer.json` `require.php`.
//
// That requirement belongs to the APP, not to the machine. An app declaring
// `^8.4` (Laravel 13 / Symfony 8) cannot be parsed by 8.3 at all; an older app
// may not run on 8.4. Hard-coding `php` from PATH therefore fails for every user
// whose default interpreter differs from the app's — which is the normal case
// once more than one PHP is installed. So the interpreter is RESOLVED:
//
//   1. PHP_BIN              explicit override. Honoured as given; a version
//                           mismatch is an error, never silently replaced.
//   2. `php` on PATH        the default. Used whenever it satisfies the app.
//   3. installed versions   versioned binaries (`php8.4`, `php84`, ...) and the
//                           usual per-platform install roots (Laragon, XAMPP,
//                           C:\php, Herd, Homebrew, asdf, phpenv, mise),
//                           highest satisfying version first.
//   4. nothing satisfies    an error naming every interpreter that was found,
//                           with the three ways out (install one / PHP_BIN /
//                           build where one exists). Never a bare "no".
//
// Provisioning (downloading a portable PHP) is deliberately NOT done here: it
// would add a platform-specific, network-dependent, unverified binary to a
// build that is supposed to be deterministic. The resolver's job is to use what
// the machine already has and to say precisely what is missing.
//
// Parity note: the compiler's byte-parity suite is pinned to PHP 8.3.30
// (`ORACLE_PHP`). Any interpreter that boots the app produces a valid build, but
// a different version is REPORTED by the caller (advisory, never fatal) so that
// a behavioural divergence has a visible cause instead of a silent one.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The version the parity suite is pinned to. */
export const ORACLE_PHP = '8.3.30';

/** MSYS2/Git Bash hands Node POSIX paths ("/c/Users/...") that spawn() cannot use. */
function toNativePath(p) {
  if (process.platform !== 'win32' || typeof p !== 'string') return p;
  const s = p.replace(/\\/g, '/');
  const m = s.match(/^\/([a-zA-Z])(?:\/|$)/);
  if (!m) return p;
  return `${m[1].toUpperCase()}:/${s.slice(3)}`;
}

function parseVer(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpArr(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function cmpVer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  return x && y ? cmpArr(x, y) : 0;
}

/**
 * Does `version` satisfy a Composer constraint?
 * Returns true / false, or null when the constraint uses syntax this parser
 * does not understand. null means SKIP the gate: the build then surfaces the
 * interpreter's real error instead of inventing one from a bad guess.
 */
export function satisfies(version, constraint) {
  const v = parseVer(version);
  if (!v || typeof constraint !== 'string' || !constraint.trim()) return null;

  const one = (raw) => {
    const c = raw.trim();
    if (!c || c === '*') return true;
    let m, lo, hi;

    // ^8.4 / ^8.4.1 — next major
    if ((m = c.match(/^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/))) {
      lo = [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
      hi = [Number(m[1]) + 1, 0, 0];
      return cmpArr(v, lo) >= 0 && cmpArr(v, hi) < 0;
    }
    // ~8.4 (next major) / ~8.4.1 (next minor)
    if ((m = c.match(/^~(\d+)(?:\.(\d+))?(?:\.(\d+))?$/))) {
      lo = [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
      hi = m[2] === undefined ? [Number(m[1]) + 1, 0, 0] : [Number(m[1]), Number(m[2]) + 1, 0];
      return cmpArr(v, lo) >= 0 && cmpArr(v, hi) < 0;
    }
    // 8 / 8.3 / 8.3.0 / 8.3.*
    if ((m = c.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.\*)?$/))) {
      if (m[3] !== undefined) {
        lo = [Number(m[1]), Number(m[2] || 0), Number(m[3])];
        hi = [lo[0], lo[1], lo[2] + 1];
      } else if (m[2] === undefined) {
        lo = [Number(m[1]), 0, 0];
        hi = [Number(m[1]) + 1, 0, 0];
      } else {
        lo = [Number(m[1]), Number(m[2]), 0];
        hi = [Number(m[1]), Number(m[2]) + 1, 0];
      }
      return cmpArr(v, lo) >= 0 && cmpArr(v, hi) < 0;
    }
    // >=8.3 / <=8.3.1 / >8 / <9 / =8.3
    if ((m = c.match(/^(>=|<=|>|<|=)\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/))) {
      const t = [Number(m[2]), Number(m[3] || 0), Number(m[4] || 0)];
      const d = cmpArr(v, t);
      switch (m[1]) {
        case '>=': return d >= 0;
        case '<=': return d <= 0;
        case '>': return d > 0;
        case '<': return d < 0;
        default: return d === 0;
      }
    }
    // !=8.3.1 (exact) / !=8.3 (the whole 8.3.x line) / !=8 (the whole major)
    if ((m = c.match(/^!=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/))) {
      const t = [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
      if (m[3] !== undefined) return cmpArr(v, t) !== 0;
      if (m[2] !== undefined) return v[0] !== t[0] || v[1] !== t[1];
      return v[0] !== t[0];
    }
    return null;
  };

  let sawUnknown = false;
  for (const branch of constraint.split('||')) {
    const parts = branch.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    let branchUnknown = false;
    let branchOk = true;
    for (const part of parts) {
      const r = one(part);
      if (r === null) branchUnknown = true;
      else if (!r) { branchOk = false; break; }
    }
    if (branchOk && !branchUnknown) return true;
    if (branchUnknown) sawUnknown = true;
  }
  return sawUnknown ? null : false;
}

/** Probe one interpreter: returns its version, or null when it cannot run. */
export function probePhp(bin) {
  try {
    const out = execFileSync(bin, ['-r', 'echo PHP_VERSION;'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 15000,
    });
    const matches = String(out).match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?/g);
    return matches ? matches[matches.length - 1] : null;
  } catch {
    return null;
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Interpreters this machine plausibly has, cheapest to discover first.
 * Order is only a discovery order; the caller sorts by version.
 */
export function phpCandidates() {
  const out = [];
  const seen = new Set();
  const add = (bin, source) => {
    if (!bin) return;
    let key = bin;
    try {
      key = realpathSync(bin);
    } catch {
      /* not resolvable yet — the probe decides */
    }
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ bin, source });
  };

  const names = ['php', 'php8.5', 'php85', 'php8.4', 'php84', 'php8.3', 'php83', 'php8.2', 'php82', 'php8.1', 'php81', 'php8.0', 'php80'];
  for (const n of names) add(n, 'PATH');

  const home = homedir();

  if (process.platform === 'win32') {
    const roots = [];
    if (process.env.LARAGON) roots.push(join(process.env.LARAGON, 'bin', 'php'));
    roots.push('C:\\laragon\\bin\\php', 'C:\\xampp\\php', 'C:\\php', 'C:\\tools', 'C:\\Program Files\\PHP');
    for (const root of roots) {
      const direct = join(root, 'php.exe');
      if (isFile(direct)) add(direct, root);
      for (const d of readdirSafe(root)) {
        const exe = join(root, d, 'php.exe');
        if (isFile(exe)) add(exe, root);
      }
    }
    for (const base of [
      join(process.env.LOCALAPPDATA || '', 'Herd', 'bin'),
      join(home, '.config', 'herd', 'bin'),
      join(home, 'scoop', 'apps', 'php', 'current'),
      join(home, 'scoop', 'apps', 'php'),
    ]) {
      const direct = join(base, 'php.exe');
      if (isFile(direct)) add(direct, base);
      for (const d of readdirSafe(base)) {
        const exe = join(base, d, 'php.exe');
        if (isFile(exe)) add(exe, base);
      }
    }
    return out;
  }

  // POSIX: versioned binaries in the usual bin dirs, Homebrew kegs, and the
  // version managers that keep a directory per PHP version.
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    for (const f of readdirSafe(dir)) {
      if (!/^php(\d+(\.\d+)?)?$/.test(f)) continue;
      const p = join(dir, f);
      if (isFile(p)) add(p, dir);
    }
  }
  for (const dir of ['/opt/homebrew/opt', '/usr/local/opt']) {
    for (const f of readdirSafe(dir)) {
      if (!f.startsWith('php')) continue;
      const p = join(dir, f, 'bin', 'php');
      if (isFile(p)) add(p, dir);
    }
  }
  for (const base of [
    join(home, '.asdf', 'installs', 'php'),
    join(home, '.phpenv', 'versions'),
    join(home, '.local', 'share', 'mise', 'installs', 'php'),
  ]) {
    for (const v of readdirSafe(base)) {
      const p = join(base, v, 'bin', 'php');
      if (isFile(p)) add(p, base);
    }
  }
  return out;
}

/** One interpreter, resolved against the app's requirement. */
function pick(bin, source, requirement, probe) {
  const version = probe(bin);
  if (!version) return null;
  return { bin, version, source, satisfies: requirement ? satisfies(version, requirement) : true };
}

/**
 * Resolve the interpreter that can boot this app.
 *
 * @param {object} opts
 * @param {string|null} opts.requirement  the app's `require.php` (null = unknown)
 * @param {string} [opts.explicit]        PHP_BIN, when set
 * @param {string} [opts.current]         the default binary name ('php')
 * @param {(bin:string)=>string|null} [opts.probe]  injectable for tests
 * @param {()=>{bin:string,source:string}[]} [opts.list]  injectable for tests
 * @returns {{bin:string,version:string,source:string}}
 * @throws {Error} when no interpreter can boot the app
 */
export function resolvePhp(opts = {}) {
  const {
    requirement = null,
    explicit = process.env.PHP_BIN,
    current = 'php',
    probe = probePhp,
    list = phpCandidates,
  } = opts;

  // 1. An explicit override is a decision, not a hint: honour it and report a
  //    mismatch instead of quietly building with a different interpreter.
  if (explicit) {
    const bin = toNativePath(explicit);
    const info = pick(bin, 'PHP_BIN', requirement, probe);
    if (!info) {
      throw new Error(
        `PHP_BIN is set to "${explicit}", but that is not a working PHP interpreter.\n` +
          `  -> point PHP_BIN at a php executable (check it with: "${explicit}" -r "echo PHP_VERSION;")`
      );
    }
    if (info.satisfies === false) {
      throw new Error(
        `PHP_BIN is set to "${explicit}" (PHP ${info.version}), but this app requires PHP ${requirement}.\n` +
          `  -> point PHP_BIN at a PHP that satisfies ${requirement}, or unset it to let the build pick one`
      );
    }
    return { bin: info.bin, version: info.version, source: info.source };
  }

  // 2. The default interpreter, when it can boot the app.
  const def = pick(current, 'PATH', requirement, probe);
  if (def && def.satisfies !== false) return { bin: def.bin, version: def.version, source: def.source };

  // 3. Anything else installed that satisfies the app; highest version wins.
  const found = [];
  for (const c of list()) {
    const info = pick(c.bin, c.source, requirement, probe);
    if (info) found.push(info);
  }
  const usable = found
    .filter((i) => i.satisfies !== false)
    .sort((a, b) => cmpVer(b.version, a.version));
  if (usable.length) return { bin: usable[0].bin, version: usable[0].version, source: usable[0].source };

  // 4. Nothing satisfies it. Name what exists and the ways out.
  const seen = [];
  for (const i of [def, ...found].filter(Boolean)) {
    if (seen.some((s) => s.bin === i.bin)) continue;
    seen.push(i);
  }
  const req = requirement ? `PHP ${requirement}` : 'a PHP that can boot this app';
  const foundLines = seen.length
    ? seen.map((i) => `    ${i.bin}  (PHP ${i.version}, from ${i.source})`).join('\n')
    : '    (no PHP interpreter was found at all)';
  throw new Error(
    `no installed PHP can boot this app — it requires ${req}.\n` +
      `  interpreters found:\n${foundLines}\n` +
      `  -> install a PHP that satisfies ${req}, then re-run; or point at an existing one:\n` +
      `       PHP_BIN=/path/to/php npx laravel-workers build --strict\n` +
      `     (PHP_BIN is honoured by every build tool that boots the app)`
  );
}
