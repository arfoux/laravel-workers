import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Validator, validate, strGetcsv, splitRuleString, phpRelativeTimestamp } from '../validator.mjs';
import { buildRequest } from '../http.mjs';
import { oracleAppRoot, oracleSkip } from './oracle-app.mjs';

// The unique/exists parity test at the bottom drives the real Laravel validator
// in PHP; without an app it skips (the oracle half) and asserts the pinned
// verdicts only. Same contract as the other oracle tests (ratelimit, session).
const ORACLE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tools',
  'php-unique-exists-oracle.php'
);
const PHP_BIN = process.env.PHP_BIN || 'php';
const APP_ROOT = oracleAppRoot();

test('required/nullable/sometimes', async () => {
  let v = new Validator({ a: '' }, { a: 'required' });
  assert.equal(await v.fails(), true);
  v = new Validator({ a: null }, { a: 'nullable|string' });
  assert.equal(await v.passes(), true);
  v = new Validator({}, { a: 'sometimes|required|string' });
  assert.equal(await v.passes(), true);
  v = new Validator({ a: '' }, { a: 'sometimes|required' });
  assert.equal(await v.fails(), true);
});

test('string/integer/numeric/boolean/array', async () => {
  assert.equal(await new Validator({ x: 'hi' }, { x: 'string' }).passes(), true);
  assert.equal(await new Validator({ x: 1 }, { x: 'string' }).passes(), false);
  assert.equal(await new Validator({ x: '123' }, { x: 'integer' }).passes(), true);
  assert.equal(await new Validator({ x: '1.2' }, { x: 'integer' }).passes(), false);
  assert.equal(await new Validator({ x: '1.2' }, { x: 'numeric' }).passes(), true);
  assert.equal(await new Validator({ x: 'a' }, { x: 'numeric' }).passes(), false);
  assert.equal(await new Validator({ x: true }, { x: 'boolean' }).passes(), true);
  assert.equal(await new Validator({ x: '1' }, { x: 'boolean' }).passes(), true);
  // `boolean:strict` narrows the acceptable list to the booleans themselves
  // (ValidatesAttributes::validateBoolean() :536-545 compares strictly).
  assert.equal(await new Validator({ x: '1' }, { x: 'boolean:strict' }).passes(), false);
  assert.equal(await new Validator({ x: 0 }, { x: 'boolean:strict' }).passes(), false);
  assert.equal(await new Validator({ x: true }, { x: 'boolean:strict' }).passes(), true);
  assert.equal(await new Validator({ x: false }, { x: 'boolean:strict' }).passes(), true);
  assert.equal(await new Validator({ x: [] }, { x: 'array' }).passes(), true);
});

test('min/max/between/size numeric vs string vs array', async () => {
  assert.equal(await new Validator({ s: 'ab' }, { s: 'min:3' }).passes(), false);
  assert.equal(await new Validator({ s: 'abc' }, { s: 'min:3' }).passes(), true);
  assert.equal(await new Validator({ n: 5 }, { n: 'numeric|min:10' }).passes(), false);
  assert.equal(await new Validator({ n: 15 }, { n: 'numeric|min:10' }).passes(), true);
  assert.equal(await new Validator({ a: [1,2] }, { a: 'array|min:3' }).passes(), false);
  assert.equal(await new Validator({ a: [1,2,3] }, { a: 'array|size:3' }).passes(), true);
  assert.equal(await new Validator({ s: 'hi' }, { s: 'between:3,5' }).passes(), false);
  assert.equal(await new Validator({ s: 'abcd' }, { s: 'between:3,5' }).passes(), true);
});

test('email/url/date', async () => {
  assert.equal(await new Validator({ e: 'a@b.co' }, { e: 'email' }).passes(), true);
  assert.equal(await new Validator({ e: 'bad' }, { e: 'email' }).passes(), false);
  // Egulias RFCValidation probed against Laravel 13: a dotless domain and a
  // bracketed literal both pass, `_` is not a host byte, and the local part
  // takes quoted strings, `(...)` comments (which end at the byte before the
  // `@`), obsolete `\.` escapes, FWS and a `::` token - while a lone `:` is
  // INVALID_TOKENS.
  for (const good of [
    'a@b', 'a@[127.0.0.1]', 'a@[b c]', '"quoted local"@c.com', 'a(b)x@c.com',
    '}()\\{@9', 'a::b@c.com', 'a::::@c.com', 'a(b)::@c.com', 'a\\.b@c.com',
    'a @c.com', 'ü@ü.de', 'a(b)x\\@c.com',
    // `_` is atext in the LOCAL part (only the domain refuses it) and Egulias
    // reads a bare NUL as its own token, so a NUL local byte passes.
    'a_b@c.com', 'a\u0000b@c.com',
  ]) assert.equal(await new Validator({ e: good }, { e: 'email' }).passes(), true, good);
  for (const bad of [
    'a@b_c.com', 'a:b@c.com', 'a:::@c.com', 'a(b):@c.com',
    'a(b):::@c.com', 'a\u0001b@c.com', 'a@b\u0001c.com',
    'a(b@c.com', 'a\\(b@c.com', 'a @b@c.com', '"a"b@c.com',
  ]) assert.equal(await new Validator({ e: bad }, { e: 'email' }).passes(), false, JSON.stringify(bad));
  assert.equal(await new Validator({ u: 'https://x.co' }, { u: 'url' }).passes(), true);
  // `Str::isUrl()` accepts any protocol of Laravel's list (probed: `ftp://x`
  // IS a url), a scheme-less host is not, and a custom list (`url:ftp`) wins.
  assert.equal(await new Validator({ u: 'ftp://x' }, { u: 'url' }).passes(), true);
  assert.equal(await new Validator({ u: 'wss://x.co/s' }, { u: 'url' }).passes(), true);
  assert.equal(await new Validator({ u: 'x.co' }, { u: 'url' }).passes(), false);
  assert.equal(await new Validator({ u: 'mailto:a@b.c' }, { u: 'url' }).passes(), false);
  assert.equal(await new Validator({ u: 'ftp://x.co' }, { u: 'url:ftp' }).passes(), true);
  assert.equal(await new Validator({ u: 'http://x.co' }, { u: 'url:ftp' }).passes(), false);
  assert.equal(await new Validator({ d: '2026-10-18' }, { d: 'date' }).passes(), true);
  assert.equal(await new Validator({ d: 'not-date' }, { d: 'date' }).passes(), false);
});

test('alpha/alpha_num/alpha_dash', async () => {
  assert.equal(await new Validator({ x: 'abc' }, { x: 'alpha' }).passes(), true);
  assert.equal(await new Validator({ x: 'a1' }, { x: 'alpha' }).passes(), false);
  assert.equal(await new Validator({ x: 'a1' }, { x: 'alpha_num' }).passes(), true);
  assert.equal(await new Validator({ x: 'a-1' }, { x: 'alpha_num' }).passes(), false);
  assert.equal(await new Validator({ x: 'a-1_b' }, { x: 'alpha_dash' }).passes(), true);
});

test('in/not_in', async () => {
  assert.equal(await new Validator({ r: 'admin' }, { r: 'in:admin,user' }).passes(), true);
  assert.equal(await new Validator({ r: 'guest' }, { r: 'in:admin,user' }).passes(), false);
  assert.equal(await new Validator({ r: 'guest' }, { r: 'not_in:admin,user' }).passes(), true);
});

test("the rule parameters are parsed like Laravel's (CSV)", async () => {
  // Laravel parses a rule's parameters with str_getcsv(): the quotes are
  // gone and a quoted field keeps its commas.
  assert.equal(await new Validator({ r: 'admin' }, { r: 'in:"admin","user"' }).passes(), true);
  assert.equal(await new Validator({ r: 'user' }, { r: 'in:"admin","user"' }).passes(), true);
  assert.equal(await new Validator({ r: 'guest' }, { r: 'in:"admin","user"' }).passes(), false);
  assert.equal(await new Validator({ r: 'a,b' }, { r: 'in:"a,b"' }).passes(), true);
  // Nothing is trimmed: the spaces are part of the value.
  assert.equal(await new Validator({ r: ' a ' }, { r: 'in: a , b ' }).passes(), true);
  assert.equal(await new Validator({ r: 'a' }, { r: 'in: a , b ' }).passes(), false);
  // A dependent rule looks the other field up by the exact name Laravel uses.
  assert.equal(
    await new Validator({ status: 'active' }, { reason: 'required_if: status , pending' }).passes(),
    true,
  );
});

test('str_getcsv matches PHP', () => {
  assert.deepEqual(strGetcsv('admin,user'), ['admin', 'user']);
  assert.deepEqual(strGetcsv('"admin","user"'), ['admin', 'user']);
  assert.deepEqual(strGetcsv(' a , b '), [' a ', ' b ']);
  assert.deepEqual(strGetcsv(''), [null]);
  assert.deepEqual(strGetcsv('"a,b",c'), ['a,b', 'c']);
  assert.deepEqual(strGetcsv('"a""b",c'), ['a"b', 'c']);
  assert.deepEqual(strGetcsv('a,'), ['a', '']);
});

test('same/different/confirmed', async () => {
  assert.equal(await new Validator({ a: 'x', b: 'x' }, { a: 'same:b' }).passes(), true);
  assert.equal(await new Validator({ a: 'x', b: 'y' }, { a: 'same:b' }).passes(), false);
  assert.equal(await new Validator({ a: 'x', b: 'y' }, { a: 'different:b' }).passes(), true);
  assert.equal(await new Validator({ pw: 'secret123', pw_confirmation: 'secret123' }, { pw: 'confirmed' }).passes(), true);
  assert.equal(await new Validator({ pw: 'a', pw_confirmation: 'b' }, { pw: 'confirmed' }).passes(), false);
});

test('regex/not_regex: a plain pattern validates as one rule', async () => {
  assert.equal(await new Validator({ x: 'abc123' }, { x: 'regex:/^[a-z]+[0-9]+$/' }).passes(), true);
  assert.equal(await new Validator({ x: '123' }, { x: 'regex:/^[a-z]+$/' }).passes(), false);
  assert.equal(await new Validator({ x: 'hello' }, { x: 'not_regex:/^hello$/' }).passes(), false);
  assert.equal(await new Validator({ x: 'world' }, { x: 'not_regex:/^hello$/' }).passes(), true);
});

test('regex pipe splits a string rule set, like Laravel', async () => {
  // ValidationRuleParser::explodeExplicitRule (:92-96) is a naive
  // explode('|', $rule), so 'regex:/^(a|b)$/' becomes the pattern part
  // 'regex:/^(a' - an unterminated pattern - and the token 'b)$/', for which
  // no validateX() method exists: BadMethodCallException in PHP (probed on
  // 13.37). The edge answers the same class instead of validating quietly.
  let err = null;
  try {
    new Validator({ x: 'a' }, { x: 'regex:/^(a|b)$/' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'the split half must fail loud');
  assert.equal(err.phpClass, 'BadMethodCallException');
});
test('array input rules and custom messages', async () => {
  const v = new Validator({ email: 'bad' }, { email: ['required', 'email'] }, { 'email.email': 'use real email' });
  await v.fails();
  assert.equal(v.errors().email[0], 'use real email');
});

test('validated() filters only passing fields', async () => {
  const v = new Validator({ a: 'hi', b: 'bad-email', c: 'keep' }, { a: 'required|string', b: 'email', c: 'string' });
  await v.fails();
  const out = v.validated();
  assert.deepEqual(out, { a: 'hi', c: 'keep' });
});

test('validate helper', async () => {
  const r = await validate({ name: 'Jo' }, { name: 'required|min:3' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.name);
  const r2 = await validate({ name: 'John' }, { name: 'required|min:3' });
  assert.equal(r2.ok, true);
});

test('accepted/declined', async () => {
  assert.equal(await new Validator({ t: 'yes' }, { t: 'accepted' }).passes(), true);
  assert.equal(await new Validator({ t: 'no' }, { t: 'accepted' }).passes(), false);
  assert.equal(await new Validator({ t: false }, { t: 'declined' }).passes(), true);
  assert.equal(await new Validator({ t: true }, { t: 'declined' }).passes(), false);
  assert.equal(await new Validator({ t: 'yes', role: 'admin' }, { t: 'accepted_if:role,admin' }).passes(), true);
});

test('digits/digits_between/multiple_of', async () => {
  assert.equal(await new Validator({ n: '12345' }, { n: 'digits:5' }).passes(), true);
  assert.equal(await new Validator({ n: '123' }, { n: 'digits:5' }).passes(), false);
  assert.equal(await new Validator({ n: '123' }, { n: 'digits_between:2,5' }).passes(), true);
  assert.equal(await new Validator({ n: 10 }, { n: 'numeric|multiple_of:5' }).passes(), true);
  assert.equal(await new Validator({ n: 7 }, { n: 'numeric|multiple_of:5' }).passes(), false);
});

test('format rules: uuid/ip/mac/json/ascii/case/hex', async () => {
  assert.equal(await new Validator({ u: '123e4567-e89b-12d3-a456-426614174000' }, { u: 'uuid' }).passes(), true);
  assert.equal(await new Validator({ u: 'nope' }, { u: 'uuid' }).passes(), false);
  assert.equal(await new Validator({ i: '192.168.0.1' }, { i: 'ip' }).passes(), true);
  assert.equal(await new Validator({ i: '999.1.1.1' }, { i: 'ipv4' }).passes(), false);
  assert.equal(await new Validator({ i: '::1' }, { i: 'ipv6' }).passes(), true);
  assert.equal(await new Validator({ m: 'AA:BB:CC:DD:EE:FF' }, { m: 'mac_address' }).passes(), true);
  assert.equal(await new Validator({ j: '{"a":1}' }, { j: 'json' }).passes(), true);
  assert.equal(await new Validator({ j: '{bad' }, { j: 'json' }).passes(), false);
  assert.equal(await new Validator({ a: 'plain ascii' }, { a: 'ascii' }).passes(), true);
  assert.equal(await new Validator({ s: 'abc' }, { s: 'lowercase' }).passes(), true);
  assert.equal(await new Validator({ s: 'ABC' }, { s: 'uppercase' }).passes(), true);
  assert.equal(await new Validator({ c: '#ff00aa' }, { c: 'hex_color' }).passes(), true);
});

test('starts_with/ends_with', async () => {
  assert.equal(await new Validator({ s: 'hello' }, { s: 'starts_with:he,yo' }).passes(), true);
  assert.equal(await new Validator({ s: 'hello' }, { s: 'ends_with:lo' }).passes(), true);
  assert.equal(await new Validator({ s: 'hello' }, { s: 'ends_with:xy' }).passes(), false);
});

test('before/after/date_format', async () => {
  assert.equal(await new Validator({ d: '2020-01-01' }, { d: 'before:2021-01-01' }).passes(), true);
  assert.equal(await new Validator({ d: '2022-01-01' }, { d: 'after:2021-01-01' }).passes(), true);
  assert.equal(await new Validator({ d: '2021-01-01' }, { d: 'date_equals:2021-01-01' }).passes(), true);
  assert.equal(await new Validator({ d: '2021-05-04' }, { d: 'date_format:Y-m-d' }).passes(), true);
  assert.equal(await new Validator({ d: '05/04/2021' }, { d: 'date_format:Y-m-d' }).passes(), false);
});

test('gt/gte/lt/lte field compare', async () => {
  assert.equal(await new Validator({ a: 5, b: 3 }, { a: 'numeric|gt:b' }).passes(), true);
  assert.equal(await new Validator({ a: 3, b: 3 }, { a: 'numeric|gte:b' }).passes(), true);
  assert.equal(await new Validator({ a: 2, b: 3 }, { a: 'numeric|lt:b' }).passes(), true);
  assert.equal(await new Validator({ a: 3, b: 3 }, { a: 'numeric|lte:b' }).passes(), true);
});

test('distinct array', async () => {
  // ValidatesAttributes.php:919-968 (a probe against the vendored framework):
  // `distinct` compares the value against the values at the SAME wildcard path
  // (the sibling entries), not against the array's own elements - so a plain
  // array passes and a repeated wildcard entry fails.
  assert.equal(await new Validator({ a: [1, 2, 3] }, { a: 'array|distinct' }).passes(), true);
  assert.equal(await new Validator({ a: [1, 1] }, { a: 'array|distinct' }).passes(), true);
  assert.equal(
    await new Validator({ items: [{ id: 1 }, { id: 2 }] }, { 'items.*.id': 'distinct' }).passes(),
    true
  );
  assert.equal(
    await new Validator({ items: [{ id: 1 }, { id: 1 }] }, { 'items.*.id': 'distinct' }).passes(),
    false
  );
});

test('conditional required: if/unless/with/without', async () => {
  assert.equal(await new Validator({ role: 'admin' }, { name: 'required_if:role,admin' }).passes(), false);
  assert.equal(await new Validator({ role: 'user' }, { name: 'required_if:role,admin' }).passes(), true);
  assert.equal(await new Validator({}, { name: 'required_unless:role,admin' }).passes(), false);
  assert.equal(await new Validator({ a: 'x' }, { b: 'required_with:a' }).passes(), false);
  assert.equal(await new Validator({}, { b: 'required_without:a' }).passes(), false);
});

test('prohibited', async () => {
  assert.equal(await new Validator({ a: 'x' }, { a: 'prohibited' }).passes(), false);
  assert.equal(await new Validator({}, { a: 'prohibited' }).passes(), true);
});

test('bail stops at first error', async () => {
  const v = new Validator({ email: 'bad' }, { email: 'bail|email|ends_with:.com' });
  await v.fails();
  assert.equal(v.errors().email.length, 1);
});

test('unknown rule fails loud', () => {
  assert.throws(() => new Validator({ a: 'x' }, { a: 'required|bogus_rule' }), /unknown validation rule: bogus_rule/);
});

test('unique/exists via injected resolvers', async () => {
  const taken = new Set(['ada@example.com']);
  const unique = async ({ value }) => !taken.has(value);
  assert.equal(await new Validator({ email: 'new@example.com' }, { email: 'unique:users,email' }, {}, { unique }).passes(), true);
  assert.equal(await new Validator({ email: 'ada@example.com' }, { email: 'unique:users,email' }, {}, { unique }).passes(), false);
  const exists = async ({ value }) => taken.has(value);
  assert.equal(await new Validator({ email: 'ada@example.com' }, { email: 'exists:users,email' }, {}, { exists }).passes(), true);
  assert.equal(await new Validator({ email: 'no@example.com' }, { email: 'exists:users,email' }, {}, { exists }).passes(), false);
});

test('unique RUNS against a present null unless the field is nullable (audit V2)', async () => {
  // Validator::isNotNullIfMarkedAsNullable() only skips a null when the field
  // carries a `Nullable` rule; presentOrRuleIsImplicit() only blanks a STRING
  // that trims to ''. Laravel thus queries with the null and the rule fails.
  let called = 'unset';
  const unique = async (p) => { called = p.value; return false; };
  assert.equal(await new Validator({ email: null }, { email: 'unique:users,email' }, {}, { unique }).passes(), false);
  assert.equal(called, null, 'the null reached the query');
  called = 'unset';
  assert.equal(await new Validator({ email: null }, { email: 'nullable|unique:users,email' }, {}, { unique }).passes(), true);
  assert.equal(called, 'unset', 'a nullable null is not queried');
  called = 'unset';
  assert.equal(await new Validator({ email: '   ' }, { email: 'unique:users,email' }, {}, { unique }).passes(), true);
  assert.equal(called, 'unset', 'a blank string is not queried');
});

test('required_array_keys accepts a PHP list (audit V1)', async () => {
  // ValidatesAttributes::validateRequiredArrayKeys() is `is_array($value)` +
  // `Arr::exists()` per parameter; a PHP list is an array and its keys are the
  // numeric indices.
  assert.equal(await new Validator({ items: [1, 2] }, { items: 'required_array_keys:0' }).passes(), true);
  assert.equal(await new Validator({ items: [1, 2] }, { items: 'required_array_keys:1' }).passes(), true);
  assert.equal(await new Validator({ items: [1, 2] }, { items: 'required_array_keys:2' }).passes(), false);
  assert.equal(await new Validator({ items: { a: 1 } }, { items: 'required_array_keys:a,b' }).passes(), false);
});

test('unique/exists via D1-style db binding', async () => {
  const db = {
    prepare(sql) {
      const stmt = {
        params: [],
        bind(...p) { this.params = p; return this; },
        async first() { return sql.includes('WHERE "email"') && this.params[0] === 'ada@example.com' ? { aggregate: 1 } : { aggregate: 0 }; },
      };
      return stmt;
    },
  };
  assert.equal(await new Validator({ email: 'ada@example.com' }, { email: 'unique:users,email' }, {}, { db }).passes(), false);
  assert.equal(await new Validator({ email: 'ada@example.com' }, { email: 'exists:users,email' }, {}, { db }).passes(), true);
});

test('unique without resolver fails loud', async () => {
  await assert.rejects(
    () => new Validator({ email: 'a@b.c' }, { email: 'unique:users,email' }).passes(),
    /needs opts\.db or opts\.unique/
  );
});
test('a connection-qualified or class-name table fails loud (A-series #299)', async () => {
  // PHP resolves both shapes before the query and the edge cannot:
  // `ValidatesAttributes::parseTable()` splits `connection.table` (:1191) and
  // the presence verifier then runs on THAT connection, while a model FQCN
  // (:1193-1200) becomes the model's table AND the model's key as the id
  // column. The compiled app queries one database, so a rule that arrives here
  // in either shape stops with a reason instead of querying a table literally
  // named "mysql.users" (which the operator would read as a missing table).
  // The build refuses both earlier, in tools/formrequest-dump.php; this is the
  // runtime half, for a rule string written inside a compiled controller.
  const db = { prepare() { throw new Error('the guard must stop before any query'); } };
  await assert.rejects(
    () => new Validator({ email: 'a@b.c' }, { email: 'unique:mysql.users,email' }, {}, { db }).passes(),
    /needs a plain table name/
  );
  await assert.rejects(
    () => new Validator({ email: 'a@b.c' }, { email: 'exists:App\\Models\\User,email' }, {}, { db }).passes(),
    /is a class name/
  );
});

test('wildcard rules expand over nested arrays', async () => {
  const v = new Validator(
    { items: [{ name: 'a' }, { name: '' }, {}] },
    { 'items.*.name': 'required|string' }
  );
  assert.equal(await v.fails(), true);
  assert.deepEqual(Object.keys(v.errors()).sort(), ['items.1.name', 'items.2.name']);
});

test('wildcard validated() re-nests matched paths', async () => {
  const v = new Validator(
    { items: [{ name: 'a', qty: 2 }] },
    { 'items.*.name': 'required|string', 'items.*.qty': 'required|integer' }
  );
  assert.equal(await v.passes(), true);
  assert.deepEqual(v.validated(), { items: [{ name: 'a', qty: 2 }] });
});

test('wildcard over scalar arrays', async () => {
  const ok = new Validator({ tags: ['a', 'b'] }, { 'tags.*': 'string' });
  assert.equal(await ok.passes(), true);
  const bad = new Validator({ tags: ['a', 2] }, { 'tags.*': 'string' });
  assert.equal(await bad.fails(), true);
  assert.deepEqual(Object.keys(bad.errors()), ['tags.1']);
});

test('dotted field names resolve nested data', async () => {
  const v = new Validator(
    { user: { name: 'ada' }, confirm: 'ada' },
    { 'user.name': 'required|string', confirm: 'same:user.name' }
  );
  assert.equal(await v.passes(), true);
  assert.deepEqual(v.validated(), { user: { name: 'ada' }, confirm: 'ada' });

  const bad = new Validator({ user: { name: 'x' }, confirm: 'y' }, { confirm: 'same:user.name' });
  assert.equal(await bad.fails(), true);
});

test('required_if reads nested other field', async () => {
  const v = new Validator({ mode: { api: '1' }, url: '' }, { url: 'required_if:mode.api,1' });
  assert.equal(await v.fails(), true);
  assert.deepEqual(Object.keys(v.errors()), ['url']);
});

test('wildcard rules with no matching entries validate nothing', async () => {
  const v = new Validator({ items: [] }, { 'items.*.name': 'required' });
  assert.equal(await v.passes(), true);
});

test('exclude rules drop fields from validated output', async () => {
  const v = new Validator(
    { name: 'ada', secret: 'x', role: 'admin', token: 't' },
    {
      name: 'required|string',
      secret: 'exclude',
      role: 'exclude_if:name,ada|string',
      token: 'exclude_unless:role,user|string',
    }
  );
  assert.equal(await v.passes(), true);
  assert.deepEqual(v.validated(), { name: 'ada' });
});

test('exclude skips other rules for that field', async () => {
  const v = new Validator({ a: 'x' }, { a: 'exclude|integer' });
  assert.equal(await v.passes(), true);
  assert.deepEqual(v.validated(), {});
});

test('missing rules require the field to be absent', async () => {
  let v = new Validator({}, { a: 'missing' });
  assert.equal(await v.passes(), true);
  v = new Validator({ a: 'x' }, { a: 'missing' });
  assert.equal(await v.fails(), true);
  assert.deepEqual(Object.keys(v.errors()), ['a']);
  v = new Validator({ flag: '1', a: 'x' }, { a: 'missing_if:flag,1' });
  assert.equal(await v.fails(), true);
  v = new Validator({ flag: '0', a: 'x' }, { a: 'missing_if:flag,1' });
  assert.equal(await v.passes(), true);
});

test('present_if requires the field to be present', async () => {
  let v = new Validator({ flag: '1' }, { a: 'present_if:flag,1|string' });
  assert.equal(await v.fails(), true);
  v = new Validator({ flag: '1', a: '' }, { a: 'present_if:flag,1|nullable|string' });
  assert.equal(await v.passes(), true);
  v = new Validator({ flag: '0' }, { a: 'present_if:flag,1|string' });
  assert.equal(await v.passes(), true);
});

test('doesnt_start_with / doesnt_end_with / list / array key rules', async () => {
  assert.equal(await new Validator({ a: 'foo-bar' }, { a: 'doesnt_start_with:baz' }).passes(), true);
  assert.equal(await new Validator({ a: 'foo-bar' }, { a: 'doesnt_start_with:foo' }).fails(), true);
  assert.equal(await new Validator({ a: 'foo-bar' }, { a: 'doesnt_end_with:bar' }).fails(), true);
  assert.equal(await new Validator({ a: ['x', 'y'] }, { a: 'list' }).passes(), true);
  assert.equal(await new Validator({ a: { k: 1 } }, { a: 'list' }).fails(), true);
  assert.equal(await new Validator({ a: { k: 1, j: 2 } }, { a: 'required_array_keys:k,j' }).passes(), true);
  assert.equal(await new Validator({ a: { k: 1 } }, { a: 'required_array_keys:k,j' }).fails(), true);
  assert.equal(await new Validator({ a: { k: 1 } }, { a: 'array_keys:k' }).passes(), true);
  assert.equal(await new Validator({ a: { k: 1, z: 2 } }, { a: 'array_keys:k' }).fails(), true);
});

test('decimal / timezone / in_array rules', async () => {
  assert.equal(await new Validator({ a: 1.25 }, { a: 'decimal:2' }).passes(), true);
  assert.equal(await new Validator({ a: 1.2 }, { a: 'decimal:2' }).fails(), true);
  assert.equal(await new Validator({ a: 1.234 }, { a: 'decimal:1,2' }).fails(), true);
  assert.equal(await new Validator({ a: 'Asia/Jakarta' }, { a: 'timezone' }).passes(), true);
  assert.equal(await new Validator({ a: 'Not/AZone' }, { a: 'timezone' }).fails(), true);
  assert.equal(await new Validator({ list: ['a', 'b'], a: 'a' }, { a: 'in_array:list.*' }).passes(), true);
  assert.equal(await new Validator({ list: ['a', 'b'], a: 'c' }, { a: 'in_array:list.*' }).fails(), true);
});

test('required_if single value fails and passes', async () => {
  let v = new Validator({ status: 'active' }, { reason: 'required_if:status,active' });
  assert.equal(await v.fails(), true);
  v = new Validator({ status: 'active', reason: 'ok' }, { reason: 'required_if:status,active' });
  assert.equal(await v.passes(), true);
  v = new Validator({ status: 'inactive' }, { reason: 'required_if:status,active' });
  assert.equal(await v.passes(), true);
});

test('required_if multi-value list matches any', async () => {
  let v = new Validator({ role: 'admin' }, { code: 'required_if:role,admin,editor' });
  assert.equal(await v.fails(), true);
  v = new Validator({ role: 'editor' }, { code: 'required_if:role,admin,editor' });
  assert.equal(await v.fails(), true);
  v = new Validator({ role: 'viewer' }, { code: 'required_if:role,admin,editor' });
  assert.equal(await v.passes(), true);
});

test('required_unless fails when condition not met', async () => {
  let v = new Validator({ env: 'production' }, { debug: 'required_unless:env,local' });
  assert.equal(await v.fails(), true);
  v = new Validator({ env: 'local' }, { debug: 'required_unless:env,local' });
  assert.equal(await v.passes(), true);
  v = new Validator({}, { debug: 'required_unless:env,local' });
  assert.equal(await v.fails(), true);
});

test('required_with triggers when any listed field present', async () => {
  let v = new Validator({ a: 'x' }, { b: 'required_with:a,c' });
  assert.equal(await v.fails(), true);
  v = new Validator({ c: 'y' }, { b: 'required_with:a,c' });
  assert.equal(await v.fails(), true);
  v = new Validator({}, { b: 'required_with:a,c' });
  assert.equal(await v.passes(), true);
  v = new Validator({ a: '' }, { b: 'required_with:a,c' });
  assert.equal(await v.passes(), true);
});

test('required_without triggers when any listed field missing', async () => {
  let v = new Validator({ a: 'x' }, { b: 'required_without:a,c' });
  assert.equal(await v.fails(), true);
  v = new Validator({ a: 'x', c: 'y' }, { b: 'required_without:a,c' });
  assert.equal(await v.passes(), true);
  v = new Validator({ a: 'x', c: 'y', b: 'ok' }, { b: 'required_without:a,c' });
  assert.equal(await v.passes(), true);
});

test('required_with_all requires all listed present', async () => {
  let v = new Validator({ a: 'x', b: 'y' }, { c: 'required_with_all:a,b' });
  assert.equal(await v.fails(), true);
  v = new Validator({ a: 'x' }, { c: 'required_with_all:a,b' });
  assert.equal(await v.passes(), true);
  v = new Validator({ a: 'x', b: 'y', c: 'ok' }, { c: 'required_with_all:a,b' });
  assert.equal(await v.passes(), true);
});

test('required_without_all requires all listed missing', async () => {
  let v = new Validator({}, { c: 'required_without_all:a,b' });
  assert.equal(await v.fails(), true);
  v = new Validator({ a: 'x' }, { c: 'required_without_all:a,b' });
  assert.equal(await v.passes(), true);
  v = new Validator({ c: 'ok' }, { c: 'required_without_all:a,b' });
  assert.equal(await v.passes(), true);
});

test('sometimes+nullable skips conditional required when absent/null', async () => {
  let v = new Validator({}, { note: 'sometimes|required_if:status,active' });
  assert.equal(await v.passes(), true);
  v = new Validator({ note: null }, { note: 'nullable|required_if:status,active|string' });
  assert.equal(await v.passes(), true);
  v = new Validator({ status: 'active', note: null }, { note: 'nullable|required_if:status,active|string' });
  assert.equal(await v.fails(), true);
});

test('required_with respects empty string as missing', async () => {
  let v = new Validator({ a: '' }, { b: 'required_with:a' });
  assert.equal(await v.passes(), true);
  v = new Validator({ a: 'x', b: '' }, { b: 'required_with:a' });
  assert.equal(await v.fails(), true);
});

test('required conditional error shape has field/rule/message', async () => {
  const v = new Validator({ role: 'admin' }, { name: 'required_if:role,admin' });
  await v.fails();
  const errs = v.errors();
  assert.ok(errs.name && errs.name.length === 1);
  assert.match(errs.name[0], /name/i);
});

// ---------------------------------------------------------------------------
// The rules added in batch #12 - every expectation comes from the PHP oracle
// (Illuminate 13.37 on PHP 8.3, rnd/rule-probe.php: 89 cases, 0 diffs).
// ---------------------------------------------------------------------------
const passes = async (data, rules) => new Validator(data, rules).passes();
test('base64: the strict decode must re-encode to the same string', async () => {
  // validateBase64 (:183-192): `$decoded !== false && base64_encode($decoded) === $value`,
  // so a non-canonical encoding passes the decoder but fails the rule.
  for (const ok of ['AA==', 'aGk=', 'YQ==', 'YWJj']) {
    assert.equal(await passes({ x: ok }, { x: 'base64' }), true, ok);
  }
  // ('' passes: an empty string only meets the implicit rules.)
  for (const bad of ['AB==', 'aGk', 'aGk===', '!!!!', 'YQ', 'AA=A']) {
    assert.equal(await passes({ x: bad }, { x: 'base64' }), false, bad);
  }
});
test('ulid: 26 Crockford base32 characters, case-insensitive', async () => {
  for (const ok of ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01arz3ndektsv4rrffq69g5fav', '00000000000000000000000000']) {
    assert.equal(await passes({ x: ok }, { x: 'ulid' }), true, ok);
  }
  // I, L and O are not Crockford digits; the length is exactly 26.
  // (An EMPTY string passes every non-implicit rule - Laravel's
  // presentOrRuleIsImplicit - so it is not in this list.)
  for (const bad of ['01ARZ3NDEKTSV4RRFFQ69G5FA', 12]) {
    assert.equal(await passes({ x: bad }, { x: 'ulid' }), false, String(bad));
  }
  assert.equal(await passes({ x: '01ARZ3NDEKTSV4RRFFQ69G5FAI' }, { x: 'ulid' }), false, 'I is not a digit');
  assert.equal(await passes({ x: '01ARZ3NDEKTSV4RRFFQ69G5FAL' }, { x: 'ulid' }), false, 'L is not a digit');
  assert.equal(await passes({ x: '8ZZZZZZZZZZZZZZZZZZZZZZZZZ' }, { x: 'ulid' }), false, 'first char > 7');
  assert.equal(await passes({ x: '7ZZZZZZZZZZZZZZZZZZZZZZZZZ' }, { x: 'ulid' }), true, 'the maximum ulid');
});
test('contains/doesnt_contain: array_all over the parameters', async () => {
  // validateContains (:331-338) uses the LOOSE in_array, validateDoesntContain
  // (:345-352) the STRICT one.
  assert.equal(await passes({ x: ['a', 'b'] }, { x: 'contains:a,b' }), true);
  assert.equal(await passes({ x: ['a', 'c'] }, { x: 'contains:a,b' }), false);
  assert.equal(await passes({ x: ['a'] }, { x: 'contains:a,b' }), false);
  assert.equal(await passes({ x: 'x' }, { x: 'contains:a,b' }), false);
  assert.equal(await passes({ x: [['a']] }, { x: 'contains:a,b' }), false);
  assert.equal(await passes({ x: ['a'] }, { x: 'doesnt_contain:a,b' }), false);
  assert.equal(await passes({ x: ['c', 'd'] }, { x: 'doesnt_contain:a,b' }), true);
  assert.equal(await passes({ x: 'x' }, { x: 'doesnt_contain:a,b' }), false);
});
test('in_array_keys: array_any over the parameters (Arr::exists)', async () => {
  assert.equal(await passes({ x: { a: 1 } }, { x: 'in_array_keys:a,b' }), true);
  assert.equal(await passes({ x: { b: 1 } }, { x: 'in_array_keys:a,b' }), true);
  assert.equal(await passes({ x: { c: 1 } }, { x: 'in_array_keys:a,b' }), false);
  assert.equal(await passes({ x: [1, 2] }, { x: 'in_array_keys:a,b' }), false);
  assert.equal(await passes({ x: [1, 2] }, { x: 'in_array_keys:0' }), true);
  assert.equal(await passes({ x: 'x' }, { x: 'in_array_keys:a,b' }), false);
  // No parameter at all is a fail (validateInArrayKeys :359-368).
  assert.equal(await passes({ x: { a: 1 } }, { x: 'in_array_keys' }), false);
});
test('max_digits/min_digits: every character is a digit', async () => {
  assert.equal(await passes({ x: '123' }, { x: 'max_digits:3' }), true);
  assert.equal(await passes({ x: 123 }, { x: 'max_digits:3' }), true);
  assert.equal(await passes({ x: '0012' }, { x: 'max_digits:3' }), false);
  assert.equal(await passes({ x: '1234' }, { x: 'max_digits:3' }), false);
  assert.equal(await passes({ x: 12.5 }, { x: 'max_digits:3' }), false);
  assert.equal(await passes({ x: '-1' }, { x: 'max_digits:3' }), false);
  assert.equal(await passes({ x: '1e3' }, { x: 'max_digits:3' }), false);
  assert.equal(await passes({ x: 'abc' }, { x: 'max_digits:3' }), false);
  assert.equal(await passes({ x: '123' }, { x: 'min_digits:3' }), true);
  assert.equal(await passes({ x: '12' }, { x: 'min_digits:3' }), false);
  assert.equal(await passes({ x: '1234' }, { x: 'min_digits:3' }), true);
  assert.equal(await passes({ x: 1 }, { x: 'min_digits:3' }), false);
});
test('prohibits: a present attribute refuses the named ones', async () => {
  // validateProhibits (:2346-2357): both sides use validateRequired.
  assert.equal(await passes({ x: 'v', other: '1' }, { x: 'prohibits:other' }), false);
  assert.equal(await passes({ x: 'v' }, { x: 'prohibits:other' }), true);
  assert.equal(await passes({ x: 'v', other: '' }, { x: 'prohibits:other' }), true);
  // An absent/blank attribute never refuses anything.
  assert.equal(await passes({ other: '1' }, { x: 'prohibits:other' }), true);
  assert.equal(await passes({ x: '   ', other: '1' }, { x: 'prohibits:other' }), true);
});
test('uuid: the version parameter follows Str::isUuid', async () => {
  const v4 = 'a0eebc99-1c0b-4efb-b6c3-a0a5c7a1b123';
  assert.equal(await passes({ x: v4 }, { x: 'uuid' }), true);
  assert.equal(await passes({ x: 'a0eebc991c0b4efbb6c3a0a5c7a1b123' }, { x: 'uuid' }), false);
  assert.equal(await passes({ x: v4 }, { x: 'uuid:4' }), true);
  assert.equal(await passes({ x: v4 }, { x: 'uuid:1' }), false);
  // Str::isUuid accepts the 32-character form once a version is given.
  assert.equal(await passes({ x: 'a0eebc991c0b4efbb6c3a0a5c7a1b123' }, { x: 'uuid:4' }), true);
  // The variant nibble must be [89ab] in the parameterised form.
  assert.equal(await passes({ x: 'a0eebc99-1c0b-4efb-0b6c-a0a5c7a1b123' }, { x: 'uuid:4' }), false);
  assert.equal(await passes({ x: 'a0eebc99-1c0b-9efb-86c3-a0a5c7a1b123' }, { x: 'uuid:9' }), false);
  assert.equal(await passes({ x: '00000000-0000-0000-0000-000000000000' }, { x: 'uuid:0' }), true);
  assert.equal(await passes({ x: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }, { x: 'uuid:max' }), true);
  assert.equal(await passes({ x: v4 }, { x: 'uuid:max' }), false);
  assert.equal(await passes({ x: v4 }, { x: 'uuid:abc' }), false);
});
test('extensions: the client extension, and a PHP extension is refused', async () => {
  const boundary = 'LWEXT';
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x78, 0x78]);
  const file = (name) => {
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="${name}"\r\n` +
        'Content-Type: image/png\r\n\r\n',
      'utf8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);
    return buildRequest({
      method: 'POST',
      path: '/u',
      query: {},
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      cookies: {},
    }).file('f');
  };
  assert.equal(await passes({ f: file('a.PNG') }, { f: 'extensions:png' }), true);
  assert.equal(await passes({ f: file('a.php') }, { f: 'extensions:png' }), false);
  // shouldBlockPhpUpload: 'php' in the list whitelists the PHP extensions.
  assert.equal(await passes({ f: file('a.php') }, { f: 'extensions:php' }), true);
  assert.equal(await passes({ f: file('a.txt') }, { f: 'extensions:png,php' }), false);
  assert.equal(await passes({ f: 'not-a-file' }, { f: 'extensions:png' }), false);
});
test('the ARRAY form of a rule set is not split', async () => {
  // A rule set the FormRequest dump writes as an array keeps one element per
  // rule, so an alternation inside the regex is one rule. (The STRING form is
  // split - see the test above - because Laravel explodes it.)
  assert.deepEqual(splitRuleString('regex:/^(a|b)$/'), ['regex:/^(a', 'b)$/']);
  assert.equal(await passes({ x: 'a' }, { x: ['regex:/^(a|b)$/'] }), true);
  assert.equal(await passes({ x: 'c' }, { x: ['regex:/^(a|b)$/'] }), false);
  assert.equal(await passes({ x: 'a,b' }, { x: ['required', 'regex:/^(a,b|c)$/'] }), true);
  assert.equal(await passes({ x: 'a,b' }, { x: ['in:"a,b"'] }), true);
});
test('an unknown rule is a BadMethodCallException, like Laravel', () => {
  // Validator::__call (Validator.php:1746-1756) raises BadMethodCallException
  // when no validateX() method exists; the kernel answers the same class.
  let err = null;
  try {
    new Validator({ x: 'a' }, { x: 'nope_rule' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'the constructor must throw');
  assert.equal(err.phpClass, 'BadMethodCallException');
});
// ---------------------------------------------------------------------------
// $attributes display names (Laravel FormatsMessages oracle, 13.37 / PHP 8.3)
// ---------------------------------------------------------------------------

test('messages() is the container and errors() its shortcut (oracle)', async () => {
  // Validator::messages() (Validator.php:1145-1152) answers the MessageBag and
  // errors() is `return $this->messages()` (Validator.php:1159-1161) - a probe
  // on Laravel 13.37 answers `messages() === errors()` TRUE, with the bag
  // methods on the MESSAGE BAG (isEmpty/isNotEmpty/getMessages/toArray), not on
  // the validator. The compiled `$validator->messages()` used to be allowlisted
  // while the kernel had no such method: a green build and a 500 at request time.
  const v = new Validator({ a: '', b: 'x' }, { a: 'required', b: 'integer' });
  await v.fails();
  assert.equal(v.messages(), v.errors());
  assert.deepEqual(Object.keys(v.messages()), ['a', 'b']);
  assert.equal(v.messages().isEmpty(), false);
  assert.equal(v.messages().isNotEmpty(), true);
  assert.deepEqual(Object.keys(v.messages().getMessages()), ['a', 'b']);
  assert.deepEqual(Object.keys(v.messages().toArray()), ['a', 'b']);
  // A clean pass answers an EMPTY bag, not null.
  const ok = new Validator({ a: 'x' }, { a: 'required' });
  await ok.passes();
  assert.deepEqual(Object.keys(ok.messages()), []);
  assert.equal(ok.messages().isEmpty(), true);
});
test('display names: default humanisation matches Str::snake + underscores', async () => {
  const cases = [
    ['first_name', 'first name'],
    ['email', 'email'],
    ['userID', 'user i d'],
    ['URLValue', 'u r l value'],
    ['Email Address', 'email address'],
    ['address.city', 'address.city'],
    ['a1', 'a1'],
  ];
  for (const [field, expected] of cases) {
    const v = new Validator({}, { [field]: 'required' });
    await v.fails();
    assert.equal(v.errors()[field][0], `The ${expected} field is required.`, field);
  }
});

test('display names: exact $attributes entry wins', async () => {
  const v = new Validator(
    { email: '' },
    { email: 'required|email' },
    {},
    { attributes: { email: 'E-mail Address' } }
  );
  await v.fails();
  // Laravel short-circuits non-implicit rules after `required` fails, so the
  // only message is the required one (vendor oracle).
  assert.deepEqual(v.errors().email, ['The E-mail Address field is required.']);
});

test('display names: empty and "0" names fall through like PHP truthiness', async () => {
  for (const value of ['', '0', null, false]) {
    const v = new Validator(
      { first_name: '' },
      { first_name: 'required' },
      {},
      { attributes: { first_name: value } }
    );
    await v.fails();
    assert.equal(v.errors().first_name[0], 'The first name field is required.');
  }
});

test('display names: wildcard $attributes resolve concrete and primary keys', async () => {
  const data = { items: [{ name: '' }, { name: '' }] };
  const rules = { 'items.*.name': 'required' };

  let v = new Validator(data, rules, {}, { attributes: { 'items.*.name': 'Item name' } });
  await v.fails();
  assert.deepEqual(v.errors()['items.0.name'], ['The Item name field is required.']);
  assert.deepEqual(v.errors()['items.1.name'], ['The Item name field is required.']);

  // Exact concrete key wins over the wildcard pattern.
  v = new Validator(data, rules, {}, {
    attributes: { 'items.0.name': 'First item name', 'items.*.name': 'Item name' },
  });
  await v.fails();
  assert.deepEqual(v.errors()['items.0.name'], ['The First item name field is required.']);
  assert.deepEqual(v.errors()['items.1.name'], ['The Item name field is required.']);

  // A non-matching wildcard key leaves the raw implicit name.
  v = new Validator(data, rules, {}, { attributes: { 'items.*.title': 'Nope' } });
  await v.fails();
  assert.deepEqual(v.errors()['items.0.name'], ['The items.0.name field is required.']);
});

test('display names: implicit wildcard fields stay raw without a custom name', async () => {
  const v = new Validator({ items: [{ name: '' }] }, { 'items.*.name': 'required' });
  await v.fails();
  assert.deepEqual(v.errors()['items.0.name'], ['The items.0.name field is required.']);
});

test('custom messages replace :attribute/:ATTRIBUTE/:Attribute', async () => {
  const v = new Validator(
    { email: '' },
    { email: 'required' },
    { 'email.required': 'Custom :attribute / :ATTRIBUTE / :Attribute' },
    { attributes: { email: 'E-mail Address' } }
  );
  await v.fails();
  assert.deepEqual(v.errors().email, [
    'Custom E-mail Address / E-MAIL ADDRESS / E-mail Address',
  ]);
});

test('custom messages: wildcard keys and rule/attribute fallbacks', async () => {
  const data = { items: [{ name: '' }] };
  const rules = { 'items.*.name': 'required' };

  let v = new Validator(
    data,
    rules,
    { 'items.*.name.required': 'Wildcard :attribute' },
    { attributes: { 'items.*.name': 'Item name' } }
  );
  await v.fails();
  assert.deepEqual(v.errors()['items.0.name'], ['Wildcard Item name']);

  // Bare rule key applies to every field (Laravel getFromLocalArray order).
  v = new Validator({ a: '', b: '' }, { a: 'required', b: 'required' }, { required: 'Missing :attribute' });
  await v.fails();
  assert.deepEqual(v.errors().a, ['Missing a']);
  assert.deepEqual(v.errors().b, ['Missing b']);

  // Field-only key applies to every rule on that field (required short-circuits
  // the remaining non-implicit rules, as in Laravel).
  v = new Validator({ a: '' }, { a: 'required|email' }, { a: ':attribute is bad' });
  await v.fails();
  assert.deepEqual(v.errors().a, ['a is bad']);
});

test('custom messages: empty and "0" are kept like Laravel (is_null check)', async () => {
  let v = new Validator({ email: '' }, { email: 'required' }, { 'email.required': '' });
  await v.fails();
  assert.deepEqual(v.errors().email, ['']);

  v = new Validator({ email: '' }, { email: 'required' }, { 'email.required': '0' });
  await v.fails();
  assert.deepEqual(v.errors().email, ['0']);

  v = new Validator({ email: '' }, { email: 'required' }, { email: '0' });
  await v.fails();
  assert.deepEqual(v.errors().email, ['0']);
});

test('custom messages: size-rule arrays resolve by attribute type (getAttributeType)', async () => {
  // `field.rule => { type: message }` picks the attribute type.
  let v = new Validator({ title: 'abcdef' }, { title: 'max:3' }, { 'title.max': { string: 'S :attribute', numeric: 'N :attribute' } });
  await v.fails();
  assert.deepEqual(v.errors().title, ['S title']);

  v = new Validator({ qty: 10 }, { qty: 'numeric|max:3' }, { 'qty.max': { string: 'S :attribute', numeric: 'N :attribute' } });
  await v.fails();
  assert.deepEqual(v.errors().qty, ['N qty']);

  // A missing type key falls through to the default message.
  v = new Validator({ title: 'abcdef' }, { title: 'max:3' }, { 'title.max': { numeric: 'N :attribute' } });
  await v.fails();
  assert.deepEqual(v.errors().title, ['The title field must not be greater than 3 characters.']);

  // `field => { rule: message }` indexes by rule name, not by type.
  v = new Validator({ title: 'abcdef' }, { title: 'max:3' }, { title: { max: 'FIELD :attribute' } });
  await v.fails();
  assert.deepEqual(v.errors().title, ['FIELD title']);

  v = new Validator({ title: 'abcdef' }, { title: 'max:3' }, { title: { string: 'TYPE :attribute' } });
  await v.fails();
  assert.deepEqual(v.errors().title, ['The title field must not be greater than 3 characters.']);
});

test('custom messages: wildcard keys with punctuation match (no JS regex escape bug)', async () => {
  // `preg_quote()` escapes `-`/`:` but a JS `u`-mode identity escape is a
  // SyntaxError; only JS syntax characters may be escaped.
  let v = new Validator({ 'foo-bar': { x: 'abcdef' } }, { 'foo-bar.*': 'max:3' }, { 'foo-bar.*.max': 'W :attribute' });
  await v.fails();
  assert.deepEqual(v.errors()['foo-bar.x'], ['W foo-bar.x']);

  v = new Validator({ 'a:b': { x: 'abcdef' } }, { 'a:b.*': 'max:3' }, { 'a:b.*.max': 'C :attribute' });
  await v.fails();
  assert.deepEqual(v.errors()['a:b.x'], ['C a:b.x']);

  // Wildcard array messages index by rule name (Laravel), not attribute type.
  v = new Validator({ 'foo-bar': { x: 'abcdef' } }, { 'foo-bar.*': 'max:3' }, { 'foo-bar.*.max': { max: 'R :attribute' } });
  await v.fails();
  assert.deepEqual(v.errors()['foo-bar.x'], ['R foo-bar.x']);

  v = new Validator({ 'foo-bar': { x: 'abcdef' } }, { 'foo-bar.*': 'max:3' }, { 'foo-bar.*.max': { string: 'S :attribute' } });
  await v.fails();
  assert.deepEqual(v.errors()['foo-bar.x'], ['The foo-bar.x field must not be greater than 3 characters.']);
});

test('display names: wildcard keys with punctuation match (no JS regex escape bug)', async () => {
  let v = new Validator({ 'foo-bar': { x: '' } }, { 'foo-bar.*': 'required' }, {}, { attributes: { 'foo-bar.*': 'Fancy item' } });
  await v.fails();
  assert.deepEqual(v.errors()['foo-bar.x'], ['The Fancy item field is required.']);

  v = new Validator({ 'a:b': { x: '' } }, { 'a:b.*': 'required' }, {}, { attributes: { 'a:b.*': 'Colon item' } });
  await v.fails();
  assert.deepEqual(v.errors()['a:b.x'], ['The Colon item field is required.']);
});

test('display names: validation integration passes $attributes through request.validate', async () => {
  const { installValidation } = await import('../validation.mjs');
  const request = { all: () => ({ email: '' }) };
  installValidation(request);
  await assert.rejects(
    () => request.validate({ email: 'required' }, {}, { email: 'E-mail Address' }),
    (err) => err.errors().email[0] === 'The E-mail Address field is required.'
  );
});

test('the validator matches Laravel 13 (the probed semantics)', async () => {
  // Every value below is Laravel's own answer (probed against the vendored
  // Laravel 13 in the fixture app).
  // required / filled: a whitespace-only string is empty (validateRequired:
  // `is_string($value) && trim($value) === ''`).
  assert.equal(await new Validator({ name: '  ' }, { name: 'required' }).fails(), true);
  assert.equal(await new Validator({ name: ' \t ' }, { name: 'required' }).fails(), true);
  assert.equal(await new Validator({ name: 'x' }, { name: 'required' }).passes(), true);
  assert.equal(await new Validator({ name: '  ' }, { name: 'filled' }).fails(), true);
  // in / not_in: the value is cast with PHP's (string) (true -> '1', false -> '')
  // and compared strictly; with an `array` rule every element is checked.
  assert.equal(await new Validator({ flag: true }, { flag: 'in:1,0' }).passes(), true);
  assert.equal(await new Validator({ flag: false }, { flag: 'in:1,0' }).fails(), true);
  assert.equal(await new Validator({ flag: true }, { flag: 'not_in:0' }).passes(), true);
  assert.equal(await new Validator({ tags: ['a', 'b'] }, { tags: 'array|in:a,b' }).passes(), true);
  assert.equal(await new Validator({ tags: ['a', 'c'] }, { tags: 'array|in:a,b' }).fails(), true);
  assert.equal(await new Validator({ tags: ['a'] }, { tags: 'in:a' }).fails(), true);
  assert.equal(await new Validator({ n: 1 }, { n: 'in:1,2' }).passes(), true);
  assert.equal(await new Validator({ n: '1' }, { n: 'in:1,2' }).passes(), true);
  // The dependent rules compare like Laravel: `in_array($other, $values,
  // is_bool($other) || is_null($other))` - loose for the numbers, strict for a
  // bool/null.
  assert.equal(await new Validator({ count: 1, name: '' }, { name: 'required_if:count,1' }).fails(), true);
  assert.equal(await new Validator({ count: '1', name: '' }, { name: 'required_if:count,1' }).fails(), true);
  assert.equal(await new Validator({ ok: true, name: '' }, { name: 'required_if:ok,true' }).fails(), true);
  assert.equal(await new Validator({ name: '' }, { name: 'required_if:count,1' }).passes(), true);
  // starts_with / ends_with accept a numeric value (Laravel: is_string($value)
  // || is_numeric($value)).
  assert.equal(await new Validator({ n: 123 }, { n: 'starts_with:12' }).passes(), true);
  assert.equal(await new Validator({ n: 123 }, { n: 'ends_with:23' }).passes(), true);
  // The rule NAME is trimmed (Laravel: Str::studly(trim($rule))).
  assert.equal(await new Validator({ name: 'x' }, { name: ' required ' }).passes(), true);
  // The `filled` failure carries the `filled` rule, so the message is
  // Laravel's ("The :attribute field must have a value.").
  const filled = await validate({ name: '  ' }, { name: 'filled' });
  assert.equal(filled.ok, false);
  assert.match(filled.errors.name[0], /must have a value/);
  // A rule with too few parameters is an InvalidArgumentException in Laravel -
  // the edge fails loud too.
  assert.throws(
    () => new Validator({ name: 'x' }, { name: 'required_if' }),
    /requires at least 2 parameter/,
  );
});

test("unique: the 'NULL' column and the 'NULL' except mean what Laravel means", async () => {
  // Laravel's rule object writes the absent column AND the absent id as the
  // string 'NULL' (Unique::__toString()); the validator reads the column back
  // as the attribute's name (getQueryColumn, ValidatesAttributes.php:1218) and
  // the id as "no exception" (DatabasePresenceVerifier::getCount:
  // `! is_null($excludeId) && $excludeId !== 'NULL'`).
  let payload = null;
  const v = new Validator(
    { email: 'a@b.co' },
    { email: 'unique:users,NULL,NULL,id' },
    {},
    { unique: async (p) => { payload = p; return true; } }
  );
  assert.equal(await v.passes(), true);
  assert.equal(payload.table, 'users');
  assert.equal(payload.column, 'email', "the 'NULL' column falls back to the attribute's name");
  assert.equal(payload.except, null, "the 'NULL' id means no exception");
  assert.equal(payload.idColumn, 'id');
});

test('unique: the except id reaches the query as the string stripslashes() made', async () => {
  // Probed against Laravel 13.37 through tools/php-unique-exists-oracle.php
  // (table `u`: ('Null','v1'), ('','v2'), ('a"b\c','v3'), ('7','v4'), ('x','v5')).
  // validateUnique() runs stripslashes() over every non-null id, and PHP's
  // stripslashes() answers a STRING even for an int subject: a spy
  // PresenceVerifier reports `'7'` for `unique:u,a,7,id`. The kernel bound the
  // int, and SQLite's TEXT affinity never compares `'7'` equal to 7 - so the
  // id = '7' row was NOT excluded and the verdict flipped (JS FAIL vs PHP PASS).
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('create table u (id text primary key, a text null)');
  sqlite.exec("insert into u (id, a) values ('Null','v1'),('','v2'),('a\"b\\c','v3'),('7','v4'),('x','v5')");
  const db = {
    prepare(sql) {
      let params = [];
      return {
        bind(...p) { params = p; return this; },
        async all() {
          const st = sqlite.prepare(sql);
          return { results: (params.length ? st.all(...params) : st.all()).map((r) => ({ ...r })) };
        },
        async first() {
          const st = sqlite.prepare(sql);
          const row = params.length ? st.get(...params) : st.get();
          return row ? { ...row } : null;
        },
      };
    },
  };
  const verdict = async (value, rule) => (await new Validator({ a: value }, { a: rule }, {}, { db }).passes());
  // Each row: [rule, data, the PHP oracle verdict].
  const oracle = [
    ['unique:u,a,7,id', 'v4', true],
    [String.raw`unique:u,a,\7,id`, 'v4', true],
    ['unique:u,a, 7 ,id', 'v4', true],
    ['unique:u,a,007,id', 'v4', false],
    ['unique:u,a,Null,id', 'v4', false],
    ['unique:u,a,,id', 'v2', true],
    ['unique:u,a,,id', 'v4', false],
    ['unique:u,a,abc,id', 'v4', false],
    ['unique:u,a,"a\\"b\\\\c",id', 'v3', true],
  ];
  for (const [rule, value, expected] of oracle) {
    assert.equal(await verdict(value, rule), expected, `${rule} with a=${value}`);
  }
});

test("unique: the wildcard column and the bracketed id are Laravel's", async () => {
  // Probed against the real Laravel 13 (a spy presence verifier):
  //   'items.*.id' => 'unique:items,id'  -> the column is 'id' (the last dot
  //   segment of an IMPLICIT attribute - guessColumnForQuery)
  //   'email' => 'unique:users,email,[id]' -> the except id is the VALUE of
  //   'id' in the data (prepareUniqueId), not the literal '[id]'
  let payload = null;
  const spy = { unique: async (p) => { payload = p; return true; } };
  const v = new Validator(
    { items: [{ id: 1 }, { id: 2 }] },
    { 'items.*.id': 'unique:items,id' },
    {},
    spy
  );
  assert.equal(await v.passes(), true);
  assert.equal(payload.column, 'id', 'the wildcard column is the last dot segment');
  assert.equal(payload.table, 'items');

  let payload2 = null;
  const v2 = new Validator(
    { id: 7, email: 'a@b.co' },
    { email: 'unique:users,email,[id]' },
    {},
    { unique: async (p) => { payload2 = p; return true; } }
  );
  assert.equal(await v2.passes(), true);
  // The id went through stripslashes() (validateUnique, ValidatesAttributes.php
  // :1120-1124), which answers a STRING even for an int subject (`stripslashes(7)`
  // is '7') - probed on PHP 8.3.
  assert.equal(payload2.except, '7', "the bracketed id is the field's value in the data");
  assert.equal(payload2.idColumn, 'id');
});

// ---- the file-content rules: `image` and `dimensions` ----------------------
//
// Laravel's ground truth (probed against the vendored Laravel 13 / PHP 8.3 with
// a real 3x2 PNG):
//   - validateImage() (ValidatesAttributes.php:1539-1548) accepts a file whose
//     type is one of jpg/jpeg/png/gif/bmp/webp/avif/heic/heif;
//   - validateDimensions() (:792-822) reads getimagesize() and applies the
//     named checks (:832-909), with the ratio tolerance
//     1 / (max((w+h)/2, h) + 1).
// The probe: `image` PASS on a 3x2 PNG; `dimensions:width=3,height=2` PASS;
// `dimensions:min_width=4` FAIL; `dimensions:ratio=3/2` PASS;
// `dimensions:ratio=1/1` FAIL.

// A 3x2 PNG (signature + IHDR + a minimal IDAT/IEND): the bytes getimagesize()
// reads, base64-decoded - no PHP at test time.
const PNG_3x2 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAADUlEQVR42mNk+M9QzwAEYgH9Wj0mNwAAAABJRU5ErkJggg==',
    'base64'
  )
);

function uploadedFile(bytes, name = 'a.png', mime = 'image/png') {
  return {
    __uploadedFile: true,
    name,
    filename: name,
    mime,
    size: bytes.length,
    bytes,
    isValid: () => true,
  };
}

test('the image rule accepts a real PNG and rejects non-image bytes', async () => {
  const ok = new Validator({ photo: uploadedFile(PNG_3x2) }, { photo: 'image' });
  assert.equal(await ok.passes(), true);

  const notAnImage = new Validator(
    { photo: uploadedFile(Uint8Array.from([1, 2, 3, 4, 5]), 'a.txt', 'text/plain') },
    { photo: 'image' }
  );
  assert.equal(await notAnImage.passes(), false);
  assert.match(notAnImage.errors().toArray().photo[0], /must be an image/);
});

test('the image rule refuses the allow_svg parameter loudly', async () => {
  // An SVG is XML, not a raster header: the edge cannot tell it apart from an
  // XML document that happens to contain <svg>, so it must not guess.
  const v = new Validator({ photo: uploadedFile(PNG_3x2) }, { photo: 'image:allow_svg' });
  await assert.rejects(() => v.passes(), /allow_svg/);
});

test('the dimensions rule applies the named checks like Laravel', async () => {
  const pass = async (rule) => new Validator({ photo: uploadedFile(PNG_3x2) }, { photo: rule }).passes();
  assert.equal(await pass('dimensions:width=3,height=2'), true);
  assert.equal(await pass('dimensions:min_width=4'), false);
  assert.equal(await pass('dimensions:max_width=3'), true);
  assert.equal(await pass('dimensions:ratio=3/2'), true);
  assert.equal(await pass('dimensions:ratio=1/1'), false);
  // An SVG passes the dimensions rule outright (validateDimensions's first
  // branch, :794-796).
  const svg = uploadedFile(
    Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    'a.svg',
    'image/svg+xml'
  );
  assert.equal(await new Validator({ photo: svg }, { photo: 'dimensions:min_width=1000' }).passes(), true);
});

test('rules added for 13.37: base64/ulid/contains/doesnt_contain/in_array_keys/max_digits/min_digits/prohibits/extensions', async () => {
  // Every expected value below comes from the PHP 8.3 + framework 13.37 oracle
  // (rnd/rule-php.json, 89 cases, 0 diff against the kernel).
  const pass = async (data, rules) => new Validator(data, rules).passes();
  // base64: a strict decode that re-encodes to the SAME bytes ('AB==' decodes to
  // one byte and re-encodes to 'AA==', so Laravel rejects it).
  assert.equal(await pass({ x: 'aGk=' }, { x: 'base64' }), true);
  assert.equal(await pass({ x: 'AB==' }, { x: 'base64' }), false);
  assert.equal(await pass({ x: 'not base64!' }, { x: 'base64' }), false);
  // ulid: 26 Crockford chars, I/L/O/U rejected, the first char <= '7'.
  assert.equal(await pass({ x: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, { x: 'ulid' }), true);
  assert.equal(await pass({ x: '01ARZ3NDEKTSV4RRFFQ69G5FAI' }, { x: 'ulid' }), false);
  assert.equal(await pass({ x: '81ARZ3NDEKTSV4RRFFQ69G5FAV' }, { x: 'ulid' }), false);
  // contains: every parameter must appear in the array, compared LOOSELY
  // (a request value is always a string, so a numeric parameter matches text).
  assert.equal(await pass({ x: ['a', 'b'] }, { x: 'contains:a,b' }), true);
  assert.equal(await pass({ x: ['a'] }, { x: 'contains:a,b' }), false);
  assert.equal(await pass({ x: ['1'] }, { x: 'contains:1' }), true);
  // doesnt_contain: parameters are always STRINGS (the rule token is text), and
  // the comparison is strict `in_array($p, $value, true)`, so a real integer in
  // the array does not match (true) while the string '1' does (false).
  assert.equal(await pass({ x: [1] }, { x: 'doesnt_contain:1' }), true);
  assert.equal(await pass({ x: ['1'] }, { x: 'doesnt_contain:1' }), false);
  // in_array_keys: any ONE key (Arr::exists) satisfies; no parameter fails.
  assert.equal(await pass({ x: { a: 1, b: 2 } }, { x: 'in_array_keys:a' }), true);
  assert.equal(await pass({ x: { a: 1 } }, { x: 'in_array_keys:b' }), false);
  assert.equal(await pass({ x: { a: 1 } }, { x: 'in_array_keys' }), false);
  // max_digits/min_digits: the value must be all digits; the width is compared.
  assert.equal(await pass({ x: '12345' }, { x: 'max_digits:5' }), true);
  assert.equal(await pass({ x: '123456' }, { x: 'max_digits:5' }), false);
  assert.equal(await pass({ x: '12a' }, { x: 'max_digits:5' }), false);
  assert.equal(await pass({ x: '1234' }, { x: 'min_digits:5' }), false);
  // prohibits: the field must be empty/absent, and the other side is validated.
  assert.equal(await pass({ a: 'x' }, { a: 'prohibits:b' }), true);
  assert.equal(await pass({ a: 'x', b: 'y' }, { a: 'prohibits:b' }), false);
  assert.equal(await pass({}, { a: 'prohibits:b' }), true);
  // extensions: the client extension is in the list OR implied by the MIME
  // guess; `php` in the list means PHP uploads are allowed (shouldBlockPhpUpload).
  const file = (name, type) => ({
    __uploadedFile: true,
    name,
    filename: name,
    mime: type,
    size: 10,
    bytes: new Uint8Array(10),
    isValid: () => true,
    getClientOriginalExtension: () => name.split('.').pop(),
  });
  assert.equal(await pass({ f: file('a.png', 'image/png') }, { f: 'extensions:png,jpg' }), true);
  assert.equal(await pass({ f: file('a.txt', 'text/plain') }, { f: 'extensions:png,jpg' }), false);
  assert.equal(await pass({ f: file('a.php', 'application/x-php') }, { f: 'extensions:php' }), true);
  assert.equal(await pass({ f: file('a.php', 'application/x-php') }, { f: 'extensions:txt' }), false);
});

test('uuid: the version parameter narrows like Str::isUuid', async () => {
  const pass = async (value, rule) => new Validator({ x: value }, { x: rule }).passes();
  const v4 = 'a0eea2b0-1c4d-4c0e-9d1e-1a2b3c4d5e6f';
  assert.equal(await pass(v4, 'uuid:4'), true);
  assert.equal(await pass(v4, 'uuid:1'), false);
  // A bare 32-hex value is a uuid only WITH a version rule.
  assert.equal(await pass('a0eea2b01c4d4c0e9d1e1a2b3c4d5e6f', 'uuid:4'), true);
  assert.equal(await pass('a0eea2b01c4d4c0e9d1e1a2b3c4d5e6f', 'uuid'), false);
  // The variant nibble must be 8/9/a/b.
  assert.equal(await pass('a0eea2b0-1c4d-4c0e-1d1e-1a2b3c4d5e6f', 'uuid:4'), false);
  assert.equal(await pass('00000000-0000-0000-0000-000000000000', 'uuid:0'), true);
  assert.equal(await pass('ffffffff-ffff-ffff-ffff-ffffffffffff', 'uuid:max'), true);
});

test('a pipe inside a regex rule splits the string exactly like Laravel', async () => {
  // ValidationRuleParser::explodeExplicitRule() is a plain explode('|'); the
  // array form keeps each element whole.
  assert.deepEqual(splitRuleString('required|regex:/^(a|b)$/'), ['required', 'regex:/^(a', 'b)$/']);
  let err = null;
  try {
    await new Validator({ x: 'a' }, { x: 'regex:/^(a|b)$/' }).passes();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'the split produced a rule name that does not exist');
  assert.equal(err.name, 'BadMethodCallException');
  // The array form is not split, so the regex stays intact.
  assert.equal(await new Validator({ x: 'a' }, { x: ['required', 'regex:/^(a|b)$/'] }).passes(), true);
});

test('contains/in_array_keys treat a class instance like PHP is_array() (false)', async () => {
  // PHP `is_array()` is false for an object with a class, so validateContains()
  // answers false outright (oracle: a stdClass FAILS `contains:a`); a plain
  // object-map still counts as an associative array.
  class ModelLike { constructor() { this.id = 1; this.name = 'a'; } }
  const pass = async (value, rule) => new Validator({ x: value }, { x: rule }).passes();
  assert.equal(await pass(new ModelLike(), 'contains:a'), false);
  assert.equal(await pass({ __uploadedFile: true, name: 'a', size: 3, isValid: () => true }, 'contains:a'), false);
  assert.equal(await pass({ a: 1 }, 'contains:1'), true);
  assert.equal(await pass({ a: 1 }, 'in_array_keys:a'), true);
  assert.equal(await pass(new ModelLike(), 'in_array_keys:name'), false);
});
test('getSize()/mb_strlen: code points, numeric claim and the PHP string cast', async () => {
  const pass = async (value, rule) => new Validator({ x: value }, { x: rule }).passes();
  // `mb_strlen()` counts CODE POINTS: 'café' is 4, '😀' is 1 (not the 2 UTF-16
  // units `String.length` would report).
  assert.equal(await pass('café', 'size:4'), true);
  assert.equal(await pass('😀', 'size:1'), true);
  assert.equal(await pass('😀', 'size:4'), false);
  // Only `gt/gte/lt/lte` claim a numeric value (`shouldBeNumeric()`); the size
  // rules stay LENGTH-based, so `min:3` on '70' fails (length 2).
  assert.equal(await pass('70', 'min:3'), false);
  assert.equal(await pass('700', 'min:3'), true);
  assert.equal(await pass('70', 'numeric|min:3'), true);
  // The comparisons read a numeric parameter OR a field (`gt:y`).
  assert.equal(await pass(10, 'gt:3'), true);
  assert.equal(await pass(2, 'gt:3'), false);
  assert.equal(await new Validator({ x: 10, y: 5 }, { x: 'gt:y' }).passes(), true);
  assert.equal(await new Validator({ x: 10, y: 5 }, { x: 'gt:99' }).passes(), false);
  // PHP's float-to-string is `precision=14` with an `E+NN` exponent, so a
  // float casts to a form the alpha rules reject.
  assert.equal(await pass(1.5, 'alpha_num'), false);
  assert.equal(await pass(-1e-300, 'alpha_dash'), false);
});
test('before/after follow compareDates(): an unreadable value is timestamp 0', async () => {
  // `getDateTimestamp()` is null for a value Carbon refuses, and the caller
  // compares against 0 - so 'abc' PASSES `before:2026-01-01` yet FAILS `after`.
  const pass = async (value, rule) => new Validator({ x: value }, { x: rule }).passes();
  assert.equal(await pass('abc', 'before:2026-01-01'), true);
  assert.equal(await pass('abc', 'after:2026-01-01'), false);
  // A readable absolute value is a real timestamp.
  assert.equal(await pass('2026-06-01', 'after:2026-01-01'), true);
  assert.equal(await pass('2026-06-01', 'before:2026-01-01'), false);
  // A non-string, non-numeric value never reaches the comparison.
  assert.equal(await pass(null, 'before:2026-01-01'), false);
  assert.equal(await pass(true, 'before:2026-01-01'), false);
});
test('before/after read the relative shapes PHP\'s parser accepts', async () => {
  // `Date::parse()` is `strtotime`: a weekday, a month name, `noon`, `3pm`,
  // `+3 days`, `2 weeks ago`, `next week`. Before the relative grammar these
  // answered null (timestamp 0), so `before:monday` REJECTED every value PHP
  // accepts. The verdicts below are clock-independent: the field sits far
  // before or after any relative token.
  const pass = async (value, rule) => new Validator({ x: value }, { x: rule }).passes();
  assert.equal(await pass('2000-01-01', 'before:monday'), true);
  assert.equal(await pass('2000-01-01', 'before:june'), true);
  assert.equal(await pass('2000-01-01', 'before:noon'), true);
  assert.equal(await pass('2000-01-01', 'before:3pm'), true);
  assert.equal(await pass('2000-01-01', 'before:next week'), true);
  assert.equal(await pass('2000-01-01', 'before:+3 days'), true);
  assert.equal(await pass('2000-01-01', 'before:2 weeks ago'), true);
  // `-18 years` is "18 years before now": a 2000 date is before it, a 2020
  // date after it (the common "must be at least 18" idiom).
  assert.equal(await pass('2000-01-01', 'before:-18 years'), true);
  assert.equal(await pass('2020-01-01', 'after:-18 years'), true);
  // A far-future field is after every relative token PHP answers for.
  assert.equal(await pass('2999-01-01', 'before:monday'), false);
  assert.equal(await pass('2999-01-01', 'before:noon'), false);
  assert.equal(await pass('2999-01-01', 'after:-18 years'), true);
  // An unknown word stays unreadable in PHP too: Carbon refuses it, so the
  // timestamp is 0 - a 2000 date is AFTER 0 (it never precedes it).
  assert.equal(await pass('2000-01-01', 'before:tonight'), false);
  assert.equal(await pass('2000-01-01', 'after:tonight'), true);
});
test('phpRelativeTimestamp follows PHP\'s field-setter grammar', async () => {
  // Pinned against PHP 8.3 with `Carbon::setTestNow(2026-11-04 10:20:30 UTC)`
  // (a Wednesday): every epoch below is the timestamp PHP answered for that
  // token. The grammar applies field setters left to right, which is why
  // `noon tomorrow` is TOMORROW 00:00 ("tomorrow" resets the clock) while
  // `tomorrow noon` is tomorrow 12:00.
  const NOW = Date.UTC(2026, 10, 4, 10, 20, 30);
  const at = (raw) => phpRelativeTimestamp(raw, NOW);
  const cases = {
    now: 1793787630, today: 1793750400, tomorrow: 1793836800, yesterday: 1793664000,
    b: 1793787630, z: 1793787630, noon: 1793793600, midnight: 1793750400,
    '2pm': 1793800800, '12am': 1793750400, '12pm': 1793793600, '10:30pm': 1793831400,
    monday: 1794182400, sun: 1794096000, tue: 1794268800, thu: 1793836800,
    'next monday': 1794182400, 'last monday': 1793577600,
    'next week': 1794219630, 'last week': 1793010030, 'this week': 1793614830,
    june: 1780568430, '5 june': 1780654830, 'june 5': 1780654830, december: 1796379630,
    'noon tomorrow': 1793836800, 'tomorrow noon': 1793880000, 'midnight tomorrow': 1793836800,
    '+1 day': 1793874030, 'next day': 1793874030, 'last day': 1793701230,
    '1 week': 1794392430, '+2 weeks': 1794997230, '-3 months': 1785838830, '+1 year': 1825323630,
    '2 weeks ago': 1792578030, '5 days ago': 1793355630, '90 minutes': 1793793030,
    '1 month': 1796379630, 'last month': 1791109230, 'next month': 1796379630,
    'first day of january': 1767262830, 'last day of this month': 1796034030,
    'monday 9am': 1794214800, 'yesterday noon': 1793707200,
    // PHP refuses these (an unknown word), so the timestamp stays unreadable.
    tonight: null, 'new year': null, 'in 2 days': null, tues: null, thurs: null, junk: null,
  };
  for (const [raw, want] of Object.entries(cases)) {
    assert.equal(at(raw), want, `${JSON.stringify(raw)} should answer ${want}`);
  }
});
test('array/list/json match is_array()/array_is_list()/json_validate()', async () => {
  const pass = async (value, rule) => new Validator({ x: value }, { x: rule }).passes();
  // A PHP assoc array is both `is_array()` and NOT `array_is_list()`.
  assert.equal(await pass({ a: 1 }, 'array'), true);
  assert.equal(await pass({ a: 1 }, 'list'), false);
  assert.equal(await pass({ 0: 'a' }, 'list'), true);
  assert.equal(await pass(['a'], 'list'), true);
  // `json_validate()` runs on the stringified scalar: the JSON texts `true`
  // and `0` are valid, but `false` stringifies to '' and is not.
  assert.equal(await pass(true, 'json'), true);
  assert.equal(await pass(false, 'json'), false);
  assert.equal(await pass(0, 'json'), true);
});
test('multiple_of uses brick/math BigDecimal, not the JS remainder', async () => {
  const pass = async (value, rule) => new Validator({ x: value }, { x: rule }).passes();
  assert.equal(await pass(9, 'multiple_of:3'), true);
  assert.equal(await pass(10, 'multiple_of:3'), false);
  assert.equal(await pass(0.3, 'multiple_of:0.1'), true);
  // 1e300 is out of the 64-bit BigDecimal range, so the exact compare fails.
  assert.equal(await pass(1e300, 'multiple_of:3'), false);
});
test('a date attribute VALUE validates like a PHP DateTimeInterface', async () => {
  // The kernel answers a model's `created_at` as a Carbon-like value, and PHP's
  // date rules take a DateTimeInterface directly (ValidatesAttributes.php
  // :276-279, :625-627, :654-656). Oracle probes (PHP 8.3 + 13.37) with a
  // DateTime('2024-01-02 03:04:05'):
  //   date => PASS, before:2024-06-01 => PASS, after:2024-06-01 => FAIL,
  //   date_equals:'2024-01-02 03:04:05' => PASS, date_format:Y-m-d H:i:s => FAIL
  //   (the format rule has NO DateTimeInterface branch), and a NUMERIC value
  //   passes date_format:Y (`2024`).
  const { makeDateValue } = await import('../model.mjs');
  const d = makeDateValue('2024-01-02 03:04:05', 'UTC');
  const pass = async (value, rule) => new Validator({ x: value }, { x: rule }).passes();
  assert.equal(await pass(d, 'date'), true);
  assert.equal(await pass(d, 'before:2024-06-01'), true);
  assert.equal(await pass(d, 'after:2024-06-01'), false);
  assert.equal(await pass(d, 'date_equals:2024-01-02 03:04:05'), true);
  assert.equal(await pass(d, 'date_format:Y-m-d H:i:s'), false);
  // The plain strings still decide by their own text.
  assert.equal(await pass('2024-01-02 03:04:05', 'date'), true);
  assert.equal(await pass('2024-01-02 03:04:05', 'after:2024-06-01'), false);
  // A numeric value IS a string for date_format (`DateTime::createFromFormat`
  // coerces it) and the round trip is loose.
  assert.equal(await pass(2024, 'date_format:Y'), true);
  assert.equal(await pass(2024, 'date_format:Y-m-d'), false);
});
test('in_array uses the dot-flattened wildcard path and a STRICT compare', async () => {
  // ValidatesAttributes::validateInArray() (:1581-1594) filters Arr::dot($data)
  // with Str::is($param, $key) and runs in_array(..., true). Oracle probes:
  const v = (data, rule) => new Validator(data, { x: rule }).passes();
  assert.equal(await v({ ids: [1, 2, 3], x: 2 }, 'in_array:ids.*'), true);
  // strict: the integer 2 is not the string '2'.
  assert.equal(await v({ ids: [1, 2, 3], x: '2' }, 'in_array:ids.*'), false);
  // no `*`: the key `ids` itself holds the whole array, never its elements.
  assert.equal(await v({ ids: [1, 2, 3], x: 2 }, 'in_array:ids'), false);
  // an assoc array flattens to `n.a`/`n.b`.
  assert.equal(await v({ n: { a: 1, b: 2 }, x: 2 }, 'in_array:n.*'), true);
  assert.equal(await v({ n: { a: 1, b: 2 }, x: 1 }, 'in_array:n'), false);
  assert.equal(await v({ tags: ['a', 'b'], x: 'a' }, 'in_array:tags.*'), true);
});

// ---------------------------------------------------------------------------
// unique / exists against a REAL database: the extra `where` pairs, the id
// exception, the flattenValue() head, and the COUNT(DISTINCT) form.
//
// The expected answers below are the output of the real Laravel 13.37 validator
// (Illuminate\Validation\Factory + DatabasePresenceVerifier) over the same
// SQLite schema: tools/php-unique-exists-oracle.php builds this table, reads the
// `cases` below (as {data, rules} pairs) and prints one PASS/FAIL per case - the
// test itself drives it whenever a Laravel app is available, and falls back to
// the pinned answers below when one is not.
// The oracle's answers for the 34 cases below, in order (PHP 8.3 + Laravel
// 13.37, tools/php-unique-exists-oracle.php). Kept here so the matrix still
// guards the kernel when no app is available.
const PINNED = [
  // 0 unique:t,a             1 unique:t,a nope@x
  false, true,
  // 2 unique:t,a,3,id        3 unique:t,a,1,id
  false, false,
  // 4..7 the Null/null/NULL/'' ids
  false, false, false, false,
  // 8..10 tenant 1 / tenant 2 / nope@x tenant 2
  false, false, true,
  // 11..13 deleted_at NULL / NOT_NULL / tenant "!1"
  true, false, false,
  // 14..15 [id] and x[id]y
  false, false,
  // 16..17 the array value (head) and the empty array
  false, true,
  // 18 exists:t,a            19 exists:t,a nope@x
  true, false,
  // 20..21 exists tenant 1 / tenant 2
  true, false,
  // 22..23 exists array ok / array missing
  true, false,
  // 24..25 exists empty array / exists deleted_at NULL
  true, false,
  // 26..28 u: Null id / empty id / escaped id
  false, true, true,
  // 29..31 u: x[id]y / [id] / the literal 7
  true, true, true,
  // 32..35 u: the except id travels as the string stripslashes() made -
  // `\7` and ` 7 ` match the TEXT id '7' (excluded -> PASS), `007` and `abc`
  // stay literal comparisons (no row matches them -> FAIL).
  true, true, false, false,
  // 36..37 u: except '' still emits the clause, so the id = '' row is excluded
  // (a = 'v2' PASSES) while a = 'v1' keeps the id = 'Null' row (FAILS).
  true, false,
  // 38 u: exists
  true,
];

// node:sqlite only exists from Node 22.5; on an older runtime the parity half
// would throw inside the test instead of skipping (the engines field is just
// `>=22`), so the guard mirrors kernel/tests/sqlite-integration.test.mjs.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Older Node without node:sqlite: the matrix still runs, the SQL tests skip.
}
const sqliteSkip = DatabaseSync ? false : 'node:sqlite unavailable (needs Node >= 22.5)';

test('unique/exists match Laravel over SQLite: extras, id exception, array value', { skip: sqliteSkip }, async () => {
  const sqlite = new DatabaseSync(':memory:');
  // A D1-shaped adapter over the local SQLite.
  const d1 = {
    prepare(sql) {
      let params = [];
      return {
        bind(...p) { params = p; return this; },
        async all() {
          const st = sqlite.prepare(sql);
          const rows = params.length ? st.all(...params) : st.all();
          return { results: rows.map((r) => ({ ...r })) };
        },
        async first() {
          const st = sqlite.prepare(sql);
          const row = params.length ? st.get(...params) : st.get();
          return row ? { ...row } : null;
        },
      };
    },
  };
  // The schema and rows tools/php-unique-exists-oracle.php builds - keep the two
  // in sync when a case is added.
  sqlite.exec('create table t (id integer primary key, a text null, tenant integer null, deleted_at text null)');
  sqlite.exec("insert into t (id, a, tenant, deleted_at) values (1,'dup@x',1,NULL),(2,'other@x',1,'2024-01-01'),(3,'dup@x',2,NULL),(4,NULL,2,NULL)");
  sqlite.exec('create table u (id text primary key, a text null)');
  sqlite.exec("insert into u (id, a) values ('Null','v1'),('','v2'),('a\"b\\c','v3'),('7','v4'),('x','v5')");

  // [data, rule] - the expected verdicts come from the PHP oracle below.
  const cases = [
    [{ a: 'dup@x' }, 'unique:t,a'],
    [{ a: 'nope@x' }, 'unique:t,a'],
    [{ a: 'dup@x' }, 'unique:t,a,3,id'],
    [{ a: 'dup@x' }, 'unique:t,a,1,id'],
    // prepareUniqueId(): the `null`/`NULL` id is no exception at all, the empty
    // id filters `id != ''`, and the value is stripslashes()d.
    [{ a: 'dup@x' }, 'unique:t,a,Null,id'],
    [{ a: 'dup@x' }, 'unique:t,a,null,id'],
    [{ a: 'dup@x' }, 'unique:t,a,NULL,id'],
    [{ a: 'dup@x' }, 'unique:t,a,,id'],
    // getExtraConditions() + addWhere(): a plain pair, NULL, NOT_NULL and the
    // leading `!` inequality.
    [{ a: 'dup@x' }, 'unique:t,a,NULL,id,tenant,1'],
    [{ a: 'dup@x' }, 'unique:t,a,NULL,id,tenant,2'],
    [{ a: 'nope@x' }, 'unique:t,a,NULL,id,tenant,2'],
    [{ a: 'other@x' }, 'unique:t,a,NULL,id,deleted_at,"NULL"'],
    [{ a: 'other@x' }, 'unique:t,a,NULL,id,deleted_at,"NOT_NULL"'],
    [{ a: 'dup@x' }, 'unique:t,a,NULL,id,tenant,"!1"'],
    // The bracketed id is the field's value in the data; a [id] inside a wider
    // prefix/suffix is still substituted.
    [{ a: 'dup@x', id: 3 }, 'unique:t,a,[id]'],
    [{ a: 'dup@x', id: 3 }, 'unique:t,a,x[id]y'],
    // An ARRAY value: flattenValue() binds the head (unique).
    [{ a: ['dup@x', 'nope@x'] }, 'unique:t,a'],
    [{ a: [] }, 'unique:t,a'],
    // exists: whereIn + COUNT(DISTINCT), so the WHOLE list is bound.
    [{ a: 'dup@x' }, 'exists:t,a'],
    [{ a: 'nope@x' }, 'exists:t,a'],
    [{ a: 'other@x' }, 'exists:t,a,tenant,1'],
    [{ a: 'other@x' }, 'exists:t,a,tenant,2'],
    [{ a: ['dup@x', 'other@x'] }, 'exists:t,a'],
    [{ a: ['dup@x', 'nope@x'] }, 'exists:t,a'],
    [{ a: [] }, 'exists:t,a'],
    [{ a: 'other@x' }, 'exists:t,a,deleted_at,"NULL"'],
    // A TEXT primary key: the id comparison stays textual (`id != '7'`), and an
    // escaped id is unescaped before it is compared.
    [{ a: 'v1' }, 'unique:u,a,Null,id'],
    [{ a: 'v2' }, 'unique:u,a,,id'],
    [{ a: 'v3' }, 'unique:u,a,"a\\"b\\\\c",id'],
    [{ a: 'v4', id: '7' }, 'unique:u,a,x[id]y,id'],
    [{ a: 'v4', id: '7' }, 'unique:u,a,[id],id'],
    [{ a: 'v4' }, 'unique:u,a,7,id'],
    // The except id travels as the STRING stripslashes() produced: PDO sends it
    // as text, so a `id = '7'` row is excluded (`7`/`\7`/` 7 ` all pass) while
    // a non-integer id stays a literal comparison (`007`/`abc` do not). An
    // EMPTY except is not null and not 'NULL', so the clause still runs with ''
    // as its value (probed: the oracle reports '' at getCount) - the id = ''
    // row is excluded and a = 'v2' passes.
    [{ a: 'v4' }, String.raw`unique:u,a,\7,id`],
    [{ a: 'v4' }, 'unique:u,a, 7 ,id'],
    [{ a: 'v4' }, 'unique:u,a,007,id'],
    [{ a: 'v4' }, 'unique:u,a,abc,id'],
    [{ a: 'v2' }, 'unique:u,a,,id'],
    [{ a: 'v1' }, 'unique:u,a,,id'],
    [{ a: 'v1' }, 'exists:u,a'],
  ];

  // The expected verdicts: the real Laravel 13.37 validator in PHP (skipped
  // where no app/vendor is available - the CI `test` job has none, the `e2e`
  // job runs it for real). The kernel side is always exercised.
  let expected = null;
  if (APP_ROOT) {
    const res = spawnSync(PHP_BIN, [ORACLE_PATH], {
      input: JSON.stringify({ app_root: APP_ROOT, cases: cases.map(([data, rule]) => ({ data, rules: { a: rule } })) }),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) throw new Error(`PHP oracle failed to start (${res.error.message})`);
    if (res.status !== 0) throw new Error(`PHP oracle exited ${res.status}: ${res.stderr}`);
    expected = JSON.parse(res.stdout).results;
    assert.equal(expected.length, cases.length, 'the oracle answered every case');
  }

  for (let i = 0; i < cases.length; i++) {
    const [data, rule] = cases[i];
    const v = new Validator(data, { a: rule }, {}, { db: d1 });
    const got = await v.passes();
    if (expected) {
      assert.notEqual(expected[i].slice(0, 5), 'ERROR', `${rule}: oracle ${expected[i]}`);
      assert.equal(got, expected[i] === 'PASS', `${rule} with ${JSON.stringify(data)}`);
    }
    // Re-assert the pinned verdicts so the matrix still guards the kernel when
    // the oracle is unavailable.
    assert.equal(got, PINNED[i], `${rule} with ${JSON.stringify(data)} (pinned)`);
  }
});

// Audit #670/#672/#673/#674 and the sibling #675 this sweep turned up: the
// rendered FAILURE LINE, byte for byte against PHP 8.3.30 + laravel/framework
// 13.37 (the probe loads `Illuminate/Translation/lang/en/validation.php` into an
// ArrayLoader, so it prints the interpolated sentence rather than the key).
// Every expectation below is that probe's output; the value inside the
// sentence is the interesting half.
test('failure messages: comparison sizes, present/missing and the displayable value', async () => {
  const cases = [
    // #670 - `shouldBeNumeric()` (:2926-2931) appends the rule to
    // `$numericRules` when the VALUE is numeric, and the size message is picked
    // by that type (`getAttributeType()` :226-238) - so the integer form reads
    // "greater than 2", not "greater than 2 characters".
    ['#670 gt:int', { a: 1, b: 2 }, { a: 'gt:b' }, 'The a field must be greater than 2.'],
    ['#670 lt:int', { a: 5, b: 2 }, { a: 'lt:b' }, 'The a field must be less than 2.'],
    ['#670 gte:numeric string', { a: '1', b: 2 }, { a: 'gte:b' }, 'The a field must be greater than or equal to 2.'],
    ['#670 lte:int', { a: 9, b: 2 }, { a: 'lte:b' }, 'The a field must be less than or equal to 2.'],
    // The control: `min` is NOT a comparison rule, so a numeric-looking string
    // keeps the string variant.
    ['#670 min:string', { a: 'ab' }, { a: 'min:5' }, 'The a field must be at least 5 characters.'],
    // #675 - `ReplacesAttributes::replaceGt()` (:587-596, reused by gte/lt/lte
    // at :605-636) puts `getSize($attribute, $comparedToValue)` in `:value`, so
    // a non-numeric a against the field b=2 reads "> 1 characters" (mb_strlen
    // of the string '2'), and a string field shows its LENGTH.
    ['#675 gt:field, non-numeric a', { a: 'ab', b: 2 }, { a: 'gt:b' }, 'The a field must be greater than 1 characters.'],
    ['#675 gte:field, string pair', { a: 'ab', b: 'abc' }, { a: 'gte:b' }, 'The a field must be greater than or equal to 3 characters.'],
    ['#675 lte:field, string pair', { a: 'abc', b: 'ab' }, { a: 'lte:b' }, 'The a field must be less than or equal to 2 characters.'],
    // A parameter that names no field keeps its own display name.
    ['#675 gt:literal', { a: 'ab' }, { a: 'gt:5' }, 'The a field must be greater than 5 characters.'],
    // #672 - `present` is implicit and has its own line: an absent attribute
    // reports "must be present", not the `required` sentence.
    ['#672 present:absent', { b: 1 }, { a: 'present' }, 'The a field must be present.'],
    // #673 - `present_unless`/`missing_unless` go through
    // `replaceMissingUnless()` (:239-245, `present_unless` at :459-462):
    // `:value` is the displayable value of the SECOND parameter, while
    // `required_unless` keeps the `:values` list.
    ['#673 present_unless', { b: 1 }, { a: 'present_unless:b,2' }, 'The a field must be present unless b is 2.'],
    ['#673 missing_unless', { a: 1 }, { a: 'missing_unless:b,2' }, 'The a field must be missing unless b is 2.'],
    ['#673 required_unless (control)', {}, { a: 'required_unless:b,2' }, 'The a field is required unless b is in 2.'],
    // #674 - `getDisplayableValue()` (:506-529): null reads 'empty', a bool
    // reads 'true'/'false', everything else is the PHP string cast.
    ['#674 present_if:null', { b: null }, { a: 'present_if:b,null' }, 'The a field must be present when b is empty.'],
    ['#674 present_if:bool', { b: true }, { a: 'present_if:b,true' }, 'The a field must be present when b is true.'],
    ['#674 present_if:string', { b: '2' }, { a: 'present_if:b,2' }, 'The a field must be present when b is 2.'],
  ];

  for (const [label, data, rules, expected] of cases) {
    const v = new Validator(data, rules);
    await v.fails();
    const field = Object.keys(rules)[0];
    assert.deepEqual(v.errors()[field], [expected], label);
  }
});
