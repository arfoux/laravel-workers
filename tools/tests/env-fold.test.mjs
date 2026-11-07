// The build folds config/*.php with env() against the app's .env. These cases
// pin the vlucas/dotenv v5.7 + Illuminate\Support\Env behaviour the fold has to
// copy: a defined-but-empty variable beats the default, `${NAME}` interpolates
// (single-quoted values do not), an unquoted `#` starts a comment, the process
// environment wins over the file, and Env::getOption() types the raw string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvFile, evalConfigExpr, coerceEnvValue, loadConfig } from '../static.mjs';

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

test('a double-quoted .env value unescapes exactly phpdotenv\'s set, in one pass', () => {
  // Probed against vlucas/phpdotenv v5.7 through `Dotenv::createImmutable()` on
  // PHP 8.3: `"a\"b"` -> `a"b`, `"a\\b"` -> `a\b`, `"a\$b"` -> `a$b`,
  // `"a\vb"`/`"a\fb"` -> vertical tab / form feed, and an unknown escape keeps
  // its backslash (`"a\qb"` -> `a\qb`). The single pass matters: `"a\\nb"`
  // is a backslash followed by `n`, never a newline.
  const dir = appWith(
    'DQ_QUOTE="a\\"b"\n' +
    'DQ_BS="a\\\\b"\n' +
    'DQ_DOLLAR="a\\$b"\n' +
    'DQ_V="a\\vb"\n' +
    'DQ_F="a\\fb"\n' +
    'DQ_UNKNOWN="a\\qb"\n' +
    'DQ_BSN="a\\\\nb"\n'
  );
  try {
    const env = readEnvFile(dir);
    assert.equal(env.DQ_QUOTE, 'a"b');
    assert.equal(env.DQ_BS, 'a\\b');
    assert.equal(env.DQ_DOLLAR, 'a$b');
    assert.equal(env.DQ_V, 'a\vb');
    assert.equal(env.DQ_F, 'a\fb');
    assert.equal(env.DQ_UNKNOWN, 'a\\qb');
    assert.equal(env.DQ_BSN, 'a\\nb');
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

test('a ternary in a REAL config/*.php is evaluated (parser kind `retif`)', () => {
  // php-parser 3.x tags both `$a ? $b : $c` and the elvis `$a ?: $c` with kind
  // `retif`; the evaluator used to match only `ternary`, so a real file's
  // ternaries were dropped without a trace (auditor note #50). This test exists
  // so the parser's real AST shape is pinned, not a hand-built one.
  const dir = mkdtempSync(join(tmpdir(), 'lw-cfg-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, '.env'), 'APP_DEBUG=false\nAPP_NAME=Laravel\n');
  writeFileSync(
    join(dir, 'config', 'demo.php'),
    '<?php\nreturn [\n'
      + "    'full'  => env('APP_DEBUG') ? 'debug' : 'release',\n"
      + "    'elvis' => env('APP_DEBUG') ?: 'fallback',\n"
      + "    'name'  => env('APP_NAME') ?: 'Laravel',\n"
      + "    'miss'  => env('NOT_SET') ? 'set' : 'unset',\n"
      + '];\n'
  );
  const { config, error } = loadConfig(dir, readEnvFile(dir));
  assert.equal(error, null);
  // `false` (coerced from the .env) picks the else arm; `Laravel` is truthy so
  // the elvis answers the test itself; an unset key is null -> falsy.
  assert.equal(config.demo.full, 'release');
  assert.equal(config.demo.elvis, 'fallback');
  assert.equal(config.demo.name, 'Laravel');
  assert.equal(config.demo.miss, 'unset');
  rmSync(dir, { recursive: true, force: true });
});

test('a signed number literal in a REAL config/*.php survives the load (parser kind `unary`)', () => {
  // php-parser 3.x tags `-6.8905` as `unary('-', number('6.8905'))` — a SIGNED
  // literal is never a `number` node. evalConfigExpr() had no `unary` branch, so
  // the value evaluated to `undefined` and the array entry was skipped by its
  // "never give an unknown expression a slot" rule: the KEY disappeared from the
  // dumped config, with no note and no build failure. A map config hit it for
  // real — `'latitude' => -6.8905` was absent from
  // `dist/src/config.generated.mjs` while `longitude` (positive) came through,
  // and the page died on `Invalid LngLat object: (107.5944, NaN)`.
  //
  // PHP 8.3 oracle:
  //   php -r "echo json_encode(['lat' => -6.8905, 'plus' => +6.8905,
  //     'int' => -12, 'rows' => [['id' => 'a', 'latitude' => -6.8905]]]);"
  //   -> {"lat":-6.8905,"plus":6.8905,"int":-12,"rows":[{"id":"a","latitude":-6.8905}]}
  //   php -r "var_dump(!'0');" -> bool(true)   (a bare JS `!'0'` answers false)
  const dir = mkdtempSync(join(tmpdir(), 'lw-cfg-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, '.env'), '');
  writeFileSync(
    join(dir, 'config', 'demo.php'),
    '<?php\nreturn [\n'
      + "    'lat'  => -6.8905,\n"
      + "    'plus' => +6.8905,\n"
      + "    'int'  => -12,\n"
      + "    'pos'  => 6.8905,\n"
      + "    'negate' => !'0',\n"
      + "    'rows' => [['id' => 'a', 'latitude' => -6.8905, 'longitude' => 107.5944]],\n"
      + '];\n'
  );
  const { config, error } = loadConfig(dir, readEnvFile(dir));
  assert.equal(error, null);
  assert.equal(config.demo.lat, -6.8905);
  assert.equal(config.demo.plus, 6.8905);
  assert.equal(config.demo.int, -12);
  assert.equal(config.demo.pos, 6.8905);
  assert.equal(config.demo.negate, true);
  // The nested form is the one a real `needs`-style group uses.
  assert.deepEqual(config.demo.rows[0], { id: 'a', latitude: -6.8905, longitude: 107.5944 });
  rmSync(dir, { recursive: true, force: true });
});
