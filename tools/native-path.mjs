// tools/native-path.mjs — one place for the app-root shape the CLI tools share.
//
// The dump tools read `LW_APP_ROOT` (or take the app root positionally) so they
// can be pointed at an app from a shell, a Makefile or CI. Two shapes arrive
// there and they are NOT the same string:
//
//   C:/Users/me/app      (CMD/PowerShell, and what build.mjs hands its children)
//   /c/Users/me/app      (Git-Bash/MSYS)
//
// `join('/c/Users/me/app', 'artisan')` and `existsSync()` read the POSIX form as
// `<current drive>:\c\Users\me\app\artisan` on Windows, so the app loaded
// nothing and the dump came out EMPTY with **exit 0** — a silent empty artifact
// (audit #401/#417 for config-dump, #803 for the other entry points, where the
// same command worked or failed depending only on how the path was spelled).
//
// The build itself never hits this (`build.mjs` spawns the tools with a native
// `appDir`), so the fix is for the DIRECT CLI path: Git Bash, CI recipes, docs.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A shell-supplied path in the form Node/Windows reads back: `/c/Users/app`
 * (Git-Bash/MSYS) and `/cygdrive/c/Users/app` (MSYS with the cygdrive prefix)
 * become `C:/Users/app`. Everything else — already-native `C:\...`, UNC, a
 * relative path, a POSIX path on Linux/macOS — is returned untouched.
 */
export function toNativePath(p) {
  if (process.platform !== 'win32' || typeof p !== 'string' || p === '') return p;
  const s = p.replace(/\\/g, '/');
  const m = s.match(/^\/(?:cygdrive\/)?([a-zA-Z])(?:\/|$)/);
  return m ? `${m[1].toUpperCase()}:/${s.slice(m[0].length)}` : p;
}

/**
 * The app root to operate on: the explicit argument (or `LW_APP_ROOT`) first,
 * then the current directory when it is an app root. `null` when neither is —
 * the caller owns the message and the exit code (the tools word it differently).
 */
export function resolveAppRoot(explicit = process.env.LW_APP_ROOT) {
  const fromEnv = toNativePath(explicit);
  if (fromEnv) return fromEnv;
  return existsSync(join(process.cwd(), 'artisan')) ? process.cwd() : null;
}
