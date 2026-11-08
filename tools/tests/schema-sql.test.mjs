// tools/tests/schema-sql.test.mjs — `dist/schema.sql` carries the indexes.
//
// The build renders the D1 schema from `dist/schema.json` (tools/schema-compile.php)
// and `npx laravel-workers deploy` applies it to a real D1. Laravel's schema
// builder writes `->unique()` / `->index()` as SEPARATE `CREATE [UNIQUE] INDEX`
// statements rather than constraints inside the table DDL, so a render that read
// only `table.sql` applied a database whose unique indexes were silently
// MISSING — `users.email` lost its UNIQUE on every deployed D1 and nothing said
// so (#738). Verified end to end against a real app: the 10-table fixture now
// emits 8 index statements, and applying the file to a fresh SQLite creates all
// 10 tables plus both UNIQUE indexes with no error.
//
// The two ways this regresses again are a render that drops `index.sql` (the
// original bug) and a render that emits an AUTO-index — the one a UNIQUE or
// PRIMARY KEY inside the table DDL already creates. The second one is not
// cosmetic: `d1 execute` runs the file statement by statement, so a duplicate
// `CREATE INDEX sqlite_autoindex_...` aborts the whole apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mutatingMigrations, renderSchemaSql, schemaSqlParts } from '../schema-sql.mjs';

/** A snapshot shaped like tools/schema-compile.php's: tables with their own SQL,
 *  each carrying its indexes (`sql` NULL for an auto-index, as SQLite stores it). */
const SNAPSHOT = {
  tables: [
    {
      name: 'users',
      sql: 'CREATE TABLE "users" ("id" integer primary key autoincrement not null, "email" varchar not null)',
      indexes: [
        { name: 'sqlite_autoindex_users_1', unique: true, origin: 'u', partial: false, columns: ['id'], sql: null },
        {
          name: 'users_email_unique',
          unique: true,
          origin: 'c',
          partial: false,
          columns: ['email'],
          sql: 'CREATE UNIQUE INDEX "users_email_unique" on "users" ("email")',
        },
      ],
    },
    {
      name: 'posts',
      sql: 'CREATE TABLE "posts" ("id" integer);',
      indexes: [
        {
          name: 'posts_published_index',
          unique: false,
          origin: 'c',
          partial: false,
          columns: ['published'],
          sql: 'CREATE INDEX "posts_published_index" on "posts" ("published");',
        },
      ],
    },
  ],
};

test('a unique/partial index travels with the tables, its own SQL stripped of `;`', () => {
  const { tables, indexes } = schemaSqlParts(SNAPSHOT);
  assert.deepEqual(tables, [
    'CREATE TABLE "users" ("id" integer primary key autoincrement not null, "email" varchar not null)',
    'CREATE TABLE "posts" ("id" integer)',
  ]);
  assert.deepEqual(indexes, [
    'CREATE UNIQUE INDEX "users_email_unique" on "users" ("email")',
    'CREATE INDEX "posts_published_index" on "posts" ("published")',
  ]);
});

test('the rendered file puts every index AFTER its table and keeps the D1 apply order', () => {
  const head = '-- laravel-workers: the D1 schema for this app\n';
  const blob = '\n-- the Storage facade on D1\nCREATE TABLE "lw_blobs" ("key" text primary key);\n';
  const { sql, tableCount, indexCount } = renderSchemaSql(SNAPSHOT, { head, blob });
  assert.equal(tableCount, 2);
  assert.equal(indexCount, 2);
  assert.match(sql, /^-- laravel-workers: the D1 schema for this app\n/);
  // The unique index is IN the file — this is the #738 regression itself.
  assert.ok(sql.includes('CREATE UNIQUE INDEX "users_email_unique" on "users" ("email");'), 'the UNIQUE index must be emitted');
  assert.ok(sql.indexOf('CREATE TABLE "users"') < sql.indexOf('CREATE UNIQUE INDEX "users_email_unique"'));
  assert.ok(sql.indexOf('CREATE TABLE "posts"') < sql.indexOf('CREATE INDEX "posts_published_index"'));
  // The blob table is the app's Storage schema and stays last.
  assert.ok(sql.indexOf('CREATE INDEX "posts_published_index"') < sql.indexOf('CREATE TABLE "lw_blobs"'));
});

test('an auto-index is NOT emitted twice (a duplicate CREATE INDEX aborts the apply)', () => {
  const { sql } = renderSchemaSql(SNAPSHOT);
  assert.ok(!sql.includes('sqlite_autoindex'), 'an index a table constraint already creates must be left out');
  assert.equal(sql.match(/sqlite_autoindex/g), null);
});

test('an empty or unreadable snapshot still renders a usable file', () => {
  const { sql, tableCount, indexCount } = renderSchemaSql({ tables: [] }, { head: '-- head\n' });
  assert.equal(tableCount, 0);
  assert.equal(indexCount, 0);
  assert.equal(sql, '-- head\n');
  assert.deepEqual(schemaSqlParts(null), { tables: [], indexes: [] });
  // A table row whose SQL is blank is skipped instead of emitting `;`.
  assert.deepEqual(schemaSqlParts({ tables: [{ sql: '   ' }, { sql: null }, { indexes: [{ sql: null }] }] }), {
    tables: [],
    indexes: [],
  });
});

test('the migrations a CREATE-only snapshot cannot replay are named (#737)', () => {
  // dist/schema.sql is a snapshot: `deploy` skips it when the D1 has tables and
  // `--schema=apply` re-runs the CREATEs, so a `Schema::table()` migration has
  // no path to an EXISTING D1. The build must name those files (the shape of
  // the SQLite snapshot cannot tell a later ALTER from the original CREATE),
  // and must NOT report a migration that only creates.
  const app = mkdtempSync(join(tmpdir(), 'lw-migr-'));
  try {
    const dir = join(app, 'database', 'migrations');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026_01_01_000000_create_posts_table.php'),
      `<?php\nreturn new class {\n    public function up(): void {\n        Schema::create('posts', function ($t) { $t->id(); });\n    }\n};\n`);
    writeFileSync(join(dir, '2026_01_02_000000_add_slug_to_posts_table.php'),
      `<?php\nreturn new class {\n    public function up(): void {\n        Schema::table('posts', function ($t) { $t->string('slug'); });\n    }\n};\n`);
    writeFileSync(join(dir, '2026_01_03_000000_drop_legacy_table.php'),
      `<?php\nreturn new class {\n    public function up(): void { Schema::dropIfExists('legacy'); }\n};\n`);
    // A doc block that NAMES the call is not a call: this one only creates.
    writeFileSync(join(dir, '2026_01_04_000000_create_comments_table.php'),
      `<?php\n/** Unlike Schema::table('posts', ...) this migration only creates. */\nreturn new class {\n    public function up(): void { Schema::create('comments', function ($t) { $t->id(); }); }\n};\n`);
    // Not a migration file: ignored entirely.
    writeFileSync(join(dir, 'notes.txt'), 'Schema::table(\n');
    // A mutation that lives ONLY in down() cannot leave a deployed D1 behind
    // (a deploy runs up()): reporting it would bury the real one in the noise
    // of the framework's own default drops.
    writeFileSync(join(dir, '0001_01_01_000000_create_users_table.php'),
      `<?php\nreturn new class {\n    public function up(): void { Schema::create('users', function ($t) { $t->id(); }); }\n    public function down(): void { Schema::dropIfExists('users'); Schema::dropIfExists('sessions'); }\n};\n`);

    assert.deepEqual(mutatingMigrations(app), [
      '2026_01_02_000000_add_slug_to_posts_table.php',
      '2026_01_03_000000_drop_legacy_table.php',
    ]);
    // No migrations directory at all (a skeleton with none) is not a failure.
    assert.deepEqual(mutatingMigrations(join(app, 'nowhere')), []);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
