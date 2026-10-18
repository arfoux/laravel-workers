import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Validator, validate } from '../validator.mjs';

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
  assert.equal(await new Validator({ u: 'https://x.co' }, { u: 'url' }).passes(), true);
  assert.equal(await new Validator({ u: 'ftp://x' }, { u: 'url' }).passes(), false);
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

test('same/different/confirmed', async () => {
  assert.equal(await new Validator({ a: 'x', b: 'x' }, { a: 'same:b' }).passes(), true);
  assert.equal(await new Validator({ a: 'x', b: 'y' }, { a: 'same:b' }).passes(), false);
  assert.equal(await new Validator({ a: 'x', b: 'y' }, { a: 'different:b' }).passes(), true);
  assert.equal(await new Validator({ pw: 'secret123', pw_confirmation: 'secret123' }, { pw: 'confirmed' }).passes(), true);
  assert.equal(await new Validator({ pw: 'a', pw_confirmation: 'b' }, { pw: 'confirmed' }).passes(), false);
});

test('regex/not_regex with pipe preservation', async () => {
  assert.equal(await new Validator({ x: 'abc123' }, { x: 'regex:/^[a-z]+[0-9]+$/' }).passes(), true);
  assert.equal(await new Validator({ x: '123' }, { x: 'regex:/^[a-z]+$/' }).passes(), false);
  assert.equal(await new Validator({ x: 'a|b' }, { x: 'regex:/^a\\|b$/' }).passes(), true);
  assert.equal(await new Validator({ x: 'hello' }, { x: 'not_regex:/^hello$/' }).passes(), false);
  assert.equal(await new Validator({ x: 'world' }, { x: 'not_regex:/^hello$/' }).passes(), true);
});

test('regex pipe does not split', async () => {
  // rules string with regex containing | must stay one rule
  const v = new Validator({ x: 'a' }, { x: 'required|regex:/^(a|b)$/|string' });
  assert.equal(await v.passes(), true);
  const v2 = new Validator({ x: 'c' }, { x: 'required|regex:/^(a|b)$/' });
  assert.equal(await v2.fails(), true);
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
  assert.equal(await new Validator({ a: [1, 2, 3] }, { a: 'array|distinct' }).passes(), true);
  assert.equal(await new Validator({ a: [1, 1] }, { a: 'array|distinct' }).passes(), false);
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
  assert.equal(await new Validator({ list: ['a', 'b'], a: 'a' }, { a: 'in_array:list' }).passes(), true);
  assert.equal(await new Validator({ list: ['a', 'b'], a: 'c' }, { a: 'in_array:list' }).fails(), true);
});
