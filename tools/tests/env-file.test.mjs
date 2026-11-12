// tools/tests/env-file.test.mjs — the ONE reader of the app's .env that build.mjs
// uses for APP_KEY, APP_URL, DB_CONNECTION and DB_DATABASE.
//
// Before this module those four reads were hand-rolled regexes that returned the
// raw text between `=` and end-of-line, so a QUOTED value kept its quotes:
//
//   APP_URL="https://app.test"  -> raw `"https://app.test"` -> new URL() throws -> origin dropped
//   DB_CONNECTION='sqlite'      -> raw `'sqlite'`          -> !== 'sqlite'      -> build-time sqlite sandbox skipped
//
// PHP 8.3 oracle, vlucas/phpdotenv (the app's own copy):
//   PLAIN=sqlite        => 'sqlite'
//   DQUOTED="sqlite"    => 'sqlite'
//   SQUOTED='sqlite'    => 'sqlite'
//   INDENTED   =   sqlite  => 'sqlite'
//   UNQ_COMMENT=sqlite # keep sqlite here  => 'sqlite'
//   HASHONLY=# just a comment              => ''
//   export EXPORTVAR=yes                   => 'yes'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envString, readAppEnv } from '../../tools/env-file.mjs';

/** Write a `.env` (verbatim lines) into a fresh dir; run `fn`, then clean up. */
function withEnv(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-envfile-'));
  try {
    writeFileSync(join(dir, '.env'), lines.join('\n') + '\n');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a double-quoted value is stripped the way Dotenv strips it', () => {
  withEnv(['APP_URL="https://app.test"'], (dir) => {
    assert.equal(envString(dir, 'APP_URL'), 'https://app.test');
    assert.equal(new URL(envString(dir, 'APP_URL')).host, 'app.test');
  });
});

test('a single-quoted value is stripped too', () => {
  withEnv(["DB_CONNECTION='sqlite'", "DB_DATABASE='database/db.sqlite'"], (dir) => {
    assert.equal(envString(dir, 'DB_CONNECTION', 'sqlite'), 'sqlite');
    assert.equal(envString(dir, 'DB_DATABASE', 'database/database.sqlite'), 'database/db.sqlite');
  });
});

test('an unquoted `# …` is a comment, but `#` inside quotes is literal', () => {
  withEnv(['A=sqlite # keep', 'B="a # b"', 'C=# only a comment'], (dir) => {
    assert.equal(envString(dir, 'A'), 'sqlite');
    assert.equal(envString(dir, 'B'), 'a # b');
    assert.equal(envString(dir, 'C', 'fallback'), 'fallback');
  });
});

test('an `export ` prefix is allowed', () => {
  withEnv(['export APP_URL="https://app.test"'], (dir) => {
    assert.equal(envString(dir, 'APP_URL'), 'https://app.test');
  });
});

test('a `${REF}` reference is interpolated', () => {
  withEnv(['HOST=app.test', 'APP_URL="https://${HOST}"'], (dir) => {
    assert.equal(envString(dir, 'APP_URL'), 'https://app.test');
  });
});

test('a real process env value wins over the file, an empty one does not', () => {
  withEnv(['APP_URL="https://file.test"'], (dir) => {
    assert.equal(envString(dir, 'APP_URL', '', { APP_URL: 'https://proc.test' }), 'https://proc.test');
    // The file-only read (`extra = {}`) is what the APP_KEY writer needs.
    assert.equal(envString(dir, 'APP_URL', '', {}), 'https://file.test');
  });
});

test('a missing file, a missing name, and an empty value all answer the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-envfile-none-'));
  try {
    assert.equal(envString(dir, 'APP_URL', 'none'), 'none');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  withEnv(['EMPTY=', 'WSPACE=   '], (d) => {
    assert.equal(envString(d, 'EMPTY', 'default'), 'default');
    assert.equal(envString(d, 'WSPACE', 'default'), 'default');
  });
});

test('readAppEnv exposes the whole resolved map (last line wins)', () => {
  withEnv(['KEY=first', 'KEY=second'], (dir) => {
    assert.equal(readAppEnv(dir, {}).KEY, 'second');
  });
});
