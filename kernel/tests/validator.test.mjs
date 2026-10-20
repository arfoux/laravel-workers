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
// $attributes display names (Laravel FormatsMessages oracle, 13.37 / PHP 8.3)
// ---------------------------------------------------------------------------

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

