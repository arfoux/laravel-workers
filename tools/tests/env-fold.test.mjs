// The build folds config/*.php with env() against the app's .env. These cases
// pin the vlucas/dotenv v5.7 + Illuminate\Support\Env behaviour the fold has to
// copy: a defined-but-empty variable beats the default, `${NAME}` interpolates
// (single-quoted values do not), an unquoted `#` starts a comment, the process
// environment wins over the file, and Env::getOption() types the raw string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvFile, evalConfigExpr, coerceEnvValue } from '../static.mjs';

function appWith(dotenv) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-env-'));
  writeFileSync(join(dir, '.env'), dotenv);
  return dir;
}

const envCall = (key, def) => ({
  kind: 'call',
  what: { kind: 'name', name: 'env' },
  arguments: [key, def]
    .filter((v) => v !== undefined)
    .map((v) => ({ kind: 'argument', value: { kind: 'string', value: v } })),
});

const fold = (env, key, def) => evalConfigExpr(envCall(key, def), { env, appDir: '.' });

test('a defined-but-empty variable wins over the default (Env::get, not `?:`)', () => {
  const dir = appWith('AWS_ACCESS_KEY_ID=\nAWS_BUCKET=\n');
  const env = readEnvFile(dir);
  assert.equal(fold(env, 'AWS_ACCESS_KEY_ID', 'FALLBACK'), '');
  assert.equal(fold(env, 'AWS_BUCKET', 'D'), '');
  assert.equal(fold(env, 'NOT_SET_ANYWHERE', 'DEF'), 'DEF');
  assert.equal(fold(env, 'NOT_SET_ANYWHERE'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('${NAME} interpolates against the values defined so far; $NAME does not', () => {
  const dir = appWith('APP_NAME=Laravel\n'
    + 'MAIL_FROM_NAME="${APP_NAME}"\n'
    + 'SINGLE=\'${APP_NAME}\'\n'
    + 'BARE=$APP_NAME\n'
    + 'UNKNOWN=${MISSING_ONE}\n');
  const env = readEnvFile(dir);
  assert.equal(env.MAIL_FROM_NAME, 'Laravel');
  assert.equal(env.SINGLE, '${APP_NAME}');
  assert.equal(env.BARE, '$APP_NAME');
  assert.equal(env.UNKNOWN, '${MISSING_ONE}');
  rmSync(dir, { recursive: true, force: true });
});

test('an unquoted # opens a comment; a quoted # is kept', () => {
  const dir = appWith('LEVEL=5 # c\nKING="a#b"\n');
  const env = readEnvFile(dir);
  assert.equal(env.LEVEL, '5');
  assert.equal(env.KING, 'a#b');
  rmSync(dir, { recursive: true, force: true });
});

test('the process environment wins over the file (immutable repository)', () => {
  const dir = appWith('APP_ENV=local\nCACHE_STORE=database\nDUP=first\nDUP=second\n');
  const env = readEnvFile(dir, { APP_ENV: 'production' });
  assert.equal(env.APP_ENV, 'production');
  assert.equal(env.CACHE_STORE, 'database');
  assert.equal(env.DUP, 'second', 'a duplicate inside the file keeps the last line');
  rmSync(dir, { recursive: true, force: true });
});

test('Env::getOption() types the raw repository string at lookup', () => {
  const dir = appWith('A=(true)\nB=null\nC=empty\nD="quoted"\nE=false\n');
  const env = readEnvFile(dir);
  assert.equal(fold(env, 'A'), true);
  assert.equal(fold(env, 'B'), null);
  assert.equal(fold(env, 'C'), '');
  assert.equal(fold(env, 'D'), 'quoted');
  assert.equal(fold(env, 'E'), false);
  // The process environment is raw, so the coercion has to happen here too.
  assert.equal(fold({ APP_DEBUG: 'false' }, 'APP_DEBUG'), false);
  assert.equal(coerceEnvValue('(false)'), false);
  assert.equal(coerceEnvValue('1'), '1', 'plain values stay strings, as in PHP');
  rmSync(dir, { recursive: true, force: true });
});

test('a single-quoted .env value keeps backslash escapes literal; double-quoted resolves them', () => {
  const dir = appWith('DQ="a\\nb"\nSQ=\'a\\nb\'\n');
  try {
    const env = readEnvFile(dir);
    assert.equal(env.DQ, 'a\nb', 'double-quoted processes \\n');
    assert.equal(env.SQ, 'a\\nb', 'single-quoted keeps \\n literal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('`?:` / ternary follow PHP truthiness: "0" and [] are falsy', () => {
  const envCall = (key) => ({
    kind: 'call',
    what: { kind: 'name', name: 'env' },
    arguments: [{ kind: 'argument', value: { kind: 'string', value: key } }],
  });
  const ternary = (env) => evalConfigExpr(
    {
      kind: 'ternary',
      test: envCall('X'),
      trueExpr: { kind: 'string', value: 'a' },
      falseExpr: { kind: 'string', value: 'b' },
    },
    { env, appDir: '.' }
  );
  assert.equal(ternary({ X: '0' }), 'b', 'PHP casts "0" to false');
  assert.equal(ternary({ X: '1' }), 'a');
  assert.equal(ternary({ X: '' }), 'b');
  assert.equal(ternary({}), 'b');
});
