// tools/env-file.mjs — the ONE reader of the app's .env for the build's own needs.
//
// build.mjs answered `APP_KEY`, `APP_URL`, `DB_CONNECTION` and `DB_DATABASE` with
// four hand-rolled regexes (`:474`, `:484`, `:977`, `:986-988`). Each read the raw
// text between `=` and end-of-line, so a QUOTED value kept its quotes:
//
//   APP_URL="https://app.test"    -> raw `"https://app.test"` -> `new URL()` throws -> origin dropped
//   DB_CONNECTION='sqlite'        -> raw `'sqlite'`          -> !== 'sqlite'       -> the build-time sqlite sandbox is skipped
//
// Laravel's own Dotenv strips the quotes before `env()` ever sees them (probed
// against the app's vlucas/phpdotenv on PHP 8.3: `DQUOTED="sqlite"` and
// `SQUOTED='sqlite'` both answer `'sqlite'`, an unquoted `# …` is a comment, an
// `export ` prefix is allowed, and `${REF}` is interpolated). `readEnvFile()`
// (tools/static.mjs) already models all of that — it is the reader the config
// dump uses, so it is the one the runtime folds with — so the build now uses the
// SAME reader instead of a second, weaker one.
import { readEnvFile } from './static.mjs';

/**
 * The app's `.env` resolved the way Laravel resolves it: the process environment
 * seeds an IMMUTABLE repository, so a variable the operator exported wins over
 * the file (Env::getRepository() reads through $_SERVER/$_ENV). Pass `extra = {}`
 * to read the FILE alone.
 */
export function readAppEnv(appDir, extra = process.env) {
  return readEnvFile(appDir, extra);
}

/**
 * `Env::get($name, $default)` narrowed to the string the build wants: the
 * resolved value trimmed, or `$default` when it is absent, null or empty.
 *
 * `extra` seeds the immutable repository and defaults to `process.env` (the
 * `env()` semantics); pass `{}` to read the FILE alone — the difference a
 * `APP_KEY` writer needs, because "the operator exported it" and "the file has
 * a real value" are two different answers there.
 */
export function envString(appDir, name, dflt = '', extra = process.env) {
  const value = readEnvFile(appDir, extra)[name];
  if (value === undefined || value === null) return dflt;
  const s = String(value).trim();
  return s || dflt;
}
