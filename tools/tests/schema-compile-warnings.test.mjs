// tools/tests/schema-compile-warnings.test.mjs — every pragma fallback is loud.
//
// tools/schema-compile.php used to swallow all four pragma errors: a broken or
// unusual SQLite could silently drop columns, indexes or foreign keys from
// dist/schema.json, and the deployed D1 then lacked data nobody warned about.
// Each fallback now writes a STDERR warning, and LW_SCHEMA_PRAGMA_FAIL forces
// one pragma to fail so the fallback is testable without a broken SQLite.
//
// The fake Laravel app below supplies just the boot surface schema-compile
// needs (artisan, bootstrap/app.php, a vendor autoload with Config/DB/Kernel
// stubs). It asserts the normal snapshot AND each of the four forced failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PHP = process.env.PHP_BIN || 'php';
const SCHEMA_PHP = fileURLToPath(new URL('../../tools/schema-compile.php', import.meta.url));
const phpOk = spawnSync(PHP, ['-v'], { encoding: 'utf8', timeout: 15000 }).status === 0;

const AUTOLOAD = String.raw`<?php
namespace Illuminate\Contracts\Console {
    interface Kernel {
        public function bootstrap();
        public function call($command, array $parameters = []);
    }
}
namespace Illuminate\Support\Facades {
    class Config {
        public static array $items = [];
        public static function set($key, $value): void { self::$items[$key] = $value; }
    }
    class DB {
        public static array $rows = [];
        public static function purge($name = null): void {}
        public static function select($sql): array {
            foreach (self::$rows as $needle => $rows) {
                if (str_contains($sql, (string) $needle)) { return $rows; }
            }
            return [];
        }
    }
}
namespace {
    final class FakeConsole implements \Illuminate\Contracts\Console\Kernel {
        public function bootstrap(): void {}
        public function call($command, array $parameters = []): int { return 0; }
    }
    final class FakeApp {
        public function make($abstract) {
            return $abstract === \Illuminate\Contracts\Console\Kernel::class ? new FakeConsole() : null;
        }
    }
    \Illuminate\Support\Facades\DB::$rows = (array) json_decode((string) getenv('LW_SCHEMA_STUB_ROWS'));
}
`;

const ROWS = {
  "type = 'table'": [
    { name: 'users', sql: 'CREATE TABLE "users" ("id" integer primary key autoincrement not null, "email" varchar not null)' },
  ],
  "type = 'index'": [
    { name: 'users_email_unique', sql: 'CREATE UNIQUE INDEX "users_email_unique" on "users" ("email")' },
  ],
  pragma_table_info: [
    { cid: 0, name: 'id', type: 'integer', notnull: 0, dflt_value: null, pk: 1 },
    { cid: 1, name: 'email', type: 'varchar', notnull: 1, dflt_value: null, pk: 0 },
  ],
  pragma_index_list: [
    { name: 'users_email_unique', unique: 1, origin: 'c', partial: 0 },
  ],
  pragma_index_info: [
    { name: 'email' },
  ],
  pragma_foreign_key_list: [
    { id: 0, seq: 0, table: 'posts', from: 'user_id', to: 'id', on_update: 'cascade', on_delete: 'cascade', match: 'simple' },
  ],
};

function compile(forcedPragma = '') {
  const root = mkdtempSync(join(tmpdir(), 'lw-schema-warn-'));
  mkdirSync(join(root, 'bootstrap'), { recursive: true });
  mkdirSync(join(root, 'vendor'), { recursive: true });
  writeFileSync(join(root, 'artisan'), '<?php\n');
  writeFileSync(join(root, 'bootstrap/app.php'), '<?php\nreturn new \\FakeApp();\n');
  writeFileSync(join(root, 'vendor/autoload.php'), AUTOLOAD);

  const out = join(root, 'schema.json');
  const env = {
    ...process.env,
    LW_APP_ROOT: root,
    LW_VENDOR_DIR: '',
    COMPOSER_VENDOR_DIR: '',
    LW_SCHEMA_STUB_ROWS: JSON.stringify(ROWS),
    LW_SCHEMA_PRAGMA_FAIL: forcedPragma,
  };
  const run = spawnSync(PHP, [SCHEMA_PHP, out], { cwd: root, env, encoding: 'utf8', timeout: 30000 });

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    snapshot = null;
  }
  rmSync(root, { recursive: true, force: true });

  return { status: run.status, stderr: run.stderr || '', stdout: run.stdout || '', error: run.error, snapshot };
}

const tableOf = (result) => result.snapshot?.tables?.[0];

test('no seam: the full snapshot is written with no warnings', { skip: !phpOk }, () => {
  const r = compile();
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(tableOf(r).columns.length, 2);
  assert.equal(tableOf(r).indexes.length, 1);
  assert.deepEqual(tableOf(r).indexes[0].columns, ['email']);
  assert.equal(tableOf(r).foreign_keys.length, 1);
});

test('forced table_info failure warns and parses columns from CREATE TABLE', { skip: !phpOk }, () => {
  const r = compile('table_info');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING pragma_table_info failed for users: forced pragma failure: table_info \(LW_SCHEMA_PRAGMA_FAIL\); parsing columns from CREATE TABLE instead/);
  assert.deepEqual(tableOf(r).columns.map((c) => c.name), ['id', 'email']);
});

test('forced index_list failure warns and omits every index', { skip: !phpOk }, () => {
  const r = compile('index_list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING pragma_index_list failed for users: forced pragma failure: index_list \(LW_SCHEMA_PRAGMA_FAIL\); NO indexes emitted for this table/);
  assert.deepEqual(tableOf(r).indexes, []);
});

test('forced index_info failure warns and keeps the index with no columns', { skip: !phpOk }, () => {
  const r = compile('index_info');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING pragma_index_info failed for users_email_unique: forced pragma failure: index_info \(LW_SCHEMA_PRAGMA_FAIL\); index columns omitted/);
  assert.equal(tableOf(r).indexes.length, 1);
  assert.deepEqual(tableOf(r).indexes[0].columns, []);
  assert.match(tableOf(r).indexes[0].sql, /CREATE UNIQUE INDEX/);
});

test('forced foreign_key_list failure warns and omits the FK metadata', { skip: !phpOk }, () => {
  const r = compile('foreign_key_list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING pragma_foreign_key_list failed for users: forced pragma failure: foreign_key_list \(LW_SCHEMA_PRAGMA_FAIL\); FK metadata omitted/);
  assert.deepEqual(tableOf(r).foreign_keys, []);
  assert.equal(tableOf(r).columns.length, 2);
});

test('a comma-separated seam forces more than one pragma', { skip: !phpOk }, () => {
  const r = compile('index_list, foreign_key_list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING pragma_index_list failed for users/);
  assert.match(r.stderr, /WARNING pragma_foreign_key_list failed for users/);
  assert.deepEqual(tableOf(r).indexes, []);
  assert.deepEqual(tableOf(r).foreign_keys, []);
});
