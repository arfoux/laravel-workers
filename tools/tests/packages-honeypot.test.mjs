// tools/tests/packages-honeypot.test.mjs — spatie/laravel-honeypot port.
//
// Covers the kernel primitives (generateFieldName / renderHoneypot /
// validateHoneypot) and the POST middleware port. The primitives are pure and
// take an injectable `now`, so the "too fast" case is deterministic — no
// sleeping. The middleware is exercised with a hand-built ctx (the same shape
// normalizePortCtx reads) and asserts the 403-on-invalid / 200-on-valid /
// pass-through-on-non-POST contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateFieldName,
  renderHoneypot,
  validateHoneypot,
} from '../../kernel/packages/honeypot.mjs';
import honeypotMiddleware from '../../ports/packages/honeypot-middleware.mjs';

const NAME_PREFIX = '_hp_name_';
const TIME_FIELD = '_hp_time';

// ---- generateFieldName -----------------------------------------------------

test('generateFieldName: returns a _hp_name_ prefixed, base36-timestamped name', () => {
  const name = generateFieldName();
  assert.ok(name.startsWith(NAME_PREFIX), `expected ${NAME_PREFIX} prefix, got ${name}`);
  // Strip a same-millisecond collision counter (".<base36>") before decoding.
  const suffix = name.slice(NAME_PREFIX.length).split('.')[0];
  assert.match(suffix, /^[0-9a-z]+$/, 'timestamp suffix must be base36');
  // The suffix decodes back to ~now (within a minute), proving it is a timestamp.
  const ts = parseInt(suffix, 36);
  const now = Date.now();
  assert.ok(Math.abs(now - ts) < 60000, `decoded ts ${ts} not near now ${now}`);
});

test('generateFieldName: produces distinct names across calls', () => {
  const a = generateFieldName();
  const b = generateFieldName();
  assert.notEqual(a, b);
});

// ---- renderHoneypot --------------------------------------------------------

test('renderHoneypot: emits a hidden name input and a _hp_time hidden input', () => {
  const now = 1700000000000;
  const html = renderHoneypot({ now, nameFieldName: 'my_name' });
  assert.ok(html.includes('type="text"'), 'name field is a text input');
  assert.ok(html.includes('name="my_name"'), 'uses the given name field');
  assert.ok(html.includes(`name="${TIME_FIELD}"`), 'emits the time field');
  assert.ok(html.includes(`value="${now.toString(36)}"`), 'time value is base36(now)');
  // Hidden from real users.
  assert.ok(html.includes('display:none'), 'wrapped in a hidden container');
  assert.ok(html.includes('aria-hidden="true"'), 'aria-hidden for screen readers');
});

test('renderHoneypot: defaults the name field to a generated unique name', () => {
  const html = renderHoneypot({ now: 1700000000000 });
  // The generator's contract: base36 render time, plus a `.<seq>` counter when
  // two calls land in the same millisecond (kernel/packages/honeypot.mjs). The
  // counter is part of the name, so the pattern must allow it — otherwise this
  // passes or fails on whether the test runner crossed a millisecond boundary.
  assert.match(html, /name="_hp_name_[0-9a-z]+(\.[0-9a-z]+)?"/);
});

// ---- validateHoneypot: valid ----------------------------------------------

test('validateHoneypot: empty name field + enough delta is valid', () => {
  const now = 1700000000000;
  const key = generateFieldName();
  const res = validateHoneypot(
    { [key]: '', [TIME_FIELD]: (now - 5000).toString(36) },
    1000,
    { now }
  );
  assert.equal(res.valid, true);
  assert.equal(res.reason, null);
});

test('validateHoneypot: name field with undefined value counts as empty', () => {
  const now = 1700000000000;
  const key = generateFieldName();
  const res = validateHoneypot(
    { [key]: undefined, [TIME_FIELD]: (now - 5000).toString(36) },
    1000,
    { now }
  );
  assert.equal(res.valid, true);
  assert.equal(res.reason, null);
});

// Upstream ProtectAgainstSpam skips the name check when absent ($request->has($name) ? … : '').
// A POST with no honeypot fields is left through (time check applies below).
test('validateHoneypot: absent name field skips the name check (time check applies)', () => {
  const now = 1700000000000;
  const res = validateHoneypot(
    { [TIME_FIELD]: (now - 5000).toString(36) },
    1000,
    { now }
  );
  assert.equal(res.valid, true, 'name absent but time present + valid → valid');
});

// ---- validateHoneypot: invalid (filled) -----------------------------------

test('validateHoneypot: filled name field is invalid (reason filled)', () => {
  const now = 1700000000000;
  const key = generateFieldName();
  const res = validateHoneypot(
    { [key]: 'bot-value', [TIME_FIELD]: (now - 60000).toString(36) },
    1000,
    { now }
  );
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'filled');
});

// ---- validateHoneypot: invalid (too fast) ---------------------------------

test('validateHoneypot: submit faster than minDelta is invalid (reason time)', () => {
  const now = 1700000000000;
  const key = generateFieldName();
  // Rendered 100ms ago, min delta 1000ms -> too fast.
  const res = validateHoneypot(
    { [key]: '', [TIME_FIELD]: (now - 100).toString(36) },
    1000,
    { now }
  );
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'time');
});

test('validateHoneypot: missing time field is invalid (reason missing_time_field)', () => {
  const now = 1700000000000;
  const key = generateFieldName();
  const res = validateHoneypot({ [key]: '' }, 1000, { now });
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'missing_time_field');
});

test('validateHoneypot: tampered / unparseable time value is invalid', () => {
  const now = 1700000000000;
  const key = generateFieldName();
  const res = validateHoneypot(
    { [key]: '', [TIME_FIELD]: '!!!not-base36!!!' },
    1000,
    { now }
  );
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'missing_time_field');
});

// ---- POST middleware -------------------------------------------------------

test('honeypot-middleware: POST with a filled name field is 403', async () => {
  const now = Date.now();
  const key = generateFieldName();
  const ctx = {
    method: 'POST',
    body: { [key]: 'spam', [TIME_FIELD]: (now - 60000).toString(36) },
    params: {},
  };
  const res = await honeypotMiddleware(ctx, {});
  assert.equal(res.status, 403);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'filled');
});

test('honeypot-middleware: POST that submits too fast is 403 (reason time)', async () => {
  const now = Date.now();
  const key = generateFieldName();
  const ctx = {
    method: 'POST',
    body: { [key]: '', [TIME_FIELD]: now.toString(36) }, // rendered "now" -> delta ~0
    params: {},
  };
  const res = await honeypotMiddleware(ctx, {});
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).reason, 'time');
});

test('honeypot-middleware: POST with empty name + aged timestamp is 200 ok', async () => {
  const now = Date.now();
  const key = generateFieldName();
  const ctx = {
    method: 'POST',
    body: { [key]: '', [TIME_FIELD]: (now - 60000).toString(36) },
    params: {},
  };
  const res = await honeypotMiddleware(ctx, {});
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test('honeypot-middleware: honours HONEYPOT_MIN_DELTA_MS from env', async () => {
  const now = Date.now();
  const key = generateFieldName();
  // Rendered 2s ago; with a 5s min delta this is too fast.
  const ctx = {
    method: 'POST',
    body: { [key]: '', [TIME_FIELD]: (now - 2000).toString(36) },
    params: {},
  };
  const strict = await honeypotMiddleware(ctx, { HONEYPOT_MIN_DELTA_MS: 5000 });
  assert.equal(strict.status, 403);
  assert.equal(JSON.parse(strict.body).reason, 'time');

  const lenient = await honeypotMiddleware(ctx, { HONEYPOT_MIN_DELTA_MS: 1000 });
  assert.equal(lenient.status, 200);
});

test('honeypot-middleware: non-POST passes through without validating', async () => {
  const res = await honeypotMiddleware({ method: 'GET', body: {}, params: {} }, {});
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).skipped, true);
});