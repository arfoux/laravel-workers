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
