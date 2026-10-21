// kernel/tests/validator-hooks.test.mjs — the validator's after() hooks and the
// error bag they write into.
//
// Laravel's FormRequest lifecycle (Illuminate\Validation\ValidatesWhenResolvedTrait:
// validateResolved(), line 17) runs the app's hooks around the validation:
// `withValidator()` and `after()` register callbacks ON the validator, and those
// callbacks run at the END of the validation pass - even when a rule failed -
// and they can add messages to the error bag.
//
//   Illuminate\Validation\Validator::after()          Validator.php:447
//   the after loop in passes()                       Validator.php:509
//   Illuminate\Support\MessageBag::add()             MessageBag.php:59
//   Illuminate\Support\MessageBag::isUnique()        MessageBag.php:88
//   Illuminate\Support\MessageBag::toArray()         MessageBag.php:396
//
// The edge keeps Laravel's bag a plain map (the 422 body the HTTP kernel
// serializes IS that map), so the bag's methods ride on the map as
// non-enumerable properties: the map's own enumerable keys stay exactly the
// fields and the JSON body does not change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Validator } from '../validator.mjs';
import { FormRequest } from '../form-request.mjs';
import { ValidationException } from '../validation.mjs';
import { phpJsonEncode } from '../php-json.mjs';
import { handleHttp } from '../http.mjs';
import { normalizeTable } from '../router.mjs';

// ---------------------------------------------------------------------------
// the after() hooks
// ---------------------------------------------------------------------------

test('the after callbacks run at the end of the pass, in the order they were registered', async () => {
  const order = [];
  const v = new Validator({ email: 'a@b.com' }, { email: 'required|email' });
  v.after(() => order.push('first'));
  v.after(() => order.push('second'));
  assert.equal(await v.passes(), true);
  assert.deepEqual(order, ['first', 'second']);
});

test('the after callback receives the validator (it reads the errors the rules left)', async () => {
  let seen = null;
  const v = new Validator({ email: '' }, { email: 'required' });
  v.after((validator) => {
    seen = validator;
  });
  await v.passes();
  assert.equal(seen, v, 'the callback gets the validator itself');
  assert.deepEqual(seen.errors().email, ['The email field is required.']);
});

test('the after callbacks run even when a rule failed (Laravel runs them after the rules)', async () => {
  // Illuminate\Validation\Validator::passes() runs the rules, and then
  // `foreach ($this->after as $after) { $after(); }` - the hooks are not
  // skipped when a rule failed.
  const order = [];
  const v = new Validator({ email: '' }, { email: 'required' });
  v.after(() => order.push('after'));
  assert.equal(await v.fails(), true);
  assert.deepEqual(order, ['after'], 'the hook ran although the rule failed');
  assert.deepEqual(v.errors().email, ['The email field is required.']);
});

test('the rules run before the after callbacks (the callback sees the rule messages)', async () => {
  const seen = [];
  const v = new Validator({ email: '' }, { email: 'required' });
  v.after((validator) => {
    seen.push(...validator.errors().get('email'));
  });
  await v.passes();
  assert.deepEqual(seen, ['The email field is required.']);
});

test('a message an after callback adds fails the validation and lands in the errors', async () => {
  const v = new Validator({ email: 'a@b.com' }, { email: 'required|email' });
  v.after((validator) => {
    validator.errors().add('email', 'The email is already taken.');
  });
  // The rules passed, but the hook added a message: the validation fails.
  assert.equal(await v.fails(), true);
  assert.deepEqual(v.errors().email, ['The email is already taken.']);
});

test('an async after callback is awaited (the compiled hook is async)', async () => {
  const v = new Validator({ email: 'a@b.com' }, { email: 'required|email' });
  v.after(async (validator) => {
    await Promise.resolve();
    validator.errors().add('email', 'The email is already taken.');
  });
  assert.equal(await v.fails(), true);
  assert.deepEqual(v.errors().email, ['The email is already taken.']);
});

test('after() takes an array of callbacks (Laravel registers them one by one)', async () => {
  const order = [];
  const v = new Validator({}, {});
  v.after([() => order.push('a'), () => order.push('b')]);
  await v.passes();
  assert.deepEqual(order, ['a', 'b']);
});

test('after() refuses a callback that is not callable', () => {
  const v = new Validator({}, {});
  assert.throws(() => v.after('not a callback'), /after\(\) hook takes a callback/);
});

test('the after callbacks run on every pass (Laravel re-runs them)', async () => {
  // Laravel's passes() resets the messages and runs the hooks again; the edge
  // validates once, so the second pass repeats the hook - the bag skips the
  // duplicate message (MessageBag::isUnique()), so the errors do not grow.
  const v = new Validator({}, {});
  let ran = 0;
  v.after((validator) => {
    ran++;
    validator.errors().add('a', 'the message');
  });
  await v.passes();
  await v.passes();
  assert.equal(ran, 2);
  assert.deepEqual(v.errors().a, ['the message']);
});

// ---------------------------------------------------------------------------
// the error bag (Illuminate\Support\MessageBag)
// ---------------------------------------------------------------------------

test('the error bag appends the message to the field list and skips the duplicate', async () => {
  const v = new Validator({}, {});
  await v.passes();
  const bag = v.errors();
  bag.add('email', 'first');
  bag.add('email', 'second');
  // MessageBag::isUnique(): the same message is never listed twice.
  bag.add('email', 'first');
  assert.deepEqual(bag.email, ['first', 'second']);
  assert.deepEqual(bag.get('email'), ['first', 'second']);
});

test('the error bag is the plain map the 422 body serializes', async () => {
  const v = new Validator({ email: '' }, { email: 'required' });
  await v.passes();
  const bag = v.errors();
  // The map's own enumerable keys are exactly the fields: the bag's methods
  // are not enumerable, so the JSON body does not change.
  assert.deepEqual(Object.keys(bag), ['email']);
  assert.deepEqual(JSON.parse(JSON.stringify(bag)), { email: ['The email field is required.'] });
  // The kernel's encoder (the one the HTTP kernel uses for the 422 body).
  assert.equal(phpJsonEncode(bag), '{"email":["The email field is required."]}');
  assert.equal(
    phpJsonEncode({ message: 'The email field is required.', errors: bag }),
    '{"message":"The email field is required.","errors":{"email":["The email field is required."]}}'
  );
});

test('the error bag answers has/first/get/keys/messages/toArray/isEmpty like MessageBag', async () => {
  const v = new Validator({ email: '' }, { email: 'required' });
  await v.passes();
  const bag = v.errors();
  assert.deepEqual(bag.keys(), ['email']);
  assert.equal(bag.has('email'), true);
  assert.equal(bag.has('name'), false);
  assert.equal(bag.first('email'), 'The email field is required.');
  assert.equal(bag.first('name'), '');
  assert.deepEqual(bag.messages(), { email: ['The email field is required.'] });
  assert.deepEqual(bag.toArray(), { email: ['The email field is required.'] });
  assert.equal(bag.isEmpty(), false);
  assert.equal(bag.isNotEmpty(), true);

  const empty = new Validator({}, {});
  await empty.passes();
  assert.equal(empty.errors().isEmpty(), true);
  assert.equal(empty.errors().has(null), false);
});

test('the error bag collects the wildcard fields (MessageBag::get)', async () => {
  const v = new Validator({ items: [{ name: '' }] }, { 'items.*.name': 'required' });
  await v.passes();
  const bag = v.errors();
  assert.deepEqual(Object.keys(bag.get('items.*.name')), ['items.0.name']);
  assert.equal(bag.first('items.*.name'), 'The items.0.name field is required.');
  // Str::is(): there the `*` spans the dots (the validation's own wildcard
  // does not - it matches ONE dot-free segment).
  assert.deepEqual(Object.keys(bag.get('items.*')), ['items.0.name']);
});

test('a field named like one of the bag methods fails loud', async () => {
  // The edge keeps the bag a plain map (the 422 body is that map), so a field
  // named like a bag method would overwrite the method. Laravel keeps the
  // messages in an array of its own and has no such clash.
  const v = new Validator({ first: '' }, { first: 'required' });
  await assert.rejects(() => v.passes(), /is the name of one of the error bag's methods/);
});

// ---------------------------------------------------------------------------
// the FormRequest base (Illuminate\Foundation\Http\FormRequest)
// ---------------------------------------------------------------------------

function fakeRequest(data) {
  return {
    all: () => ({ ...data }),
    input: (key = null, def = null) => (key === null ? { ...data } : data[key] ?? def),
    merge: (input) => Object.assign(data, input),
  };
}

test('the FormRequest base validates the whole request (validationData)', () => {
  const request = new FormRequest(fakeRequest({ email: 'a@b.com', name: 'Ada' }));
  assert.deepEqual(request.validationData(), { email: 'a@b.com', name: 'Ada' });
});

test('the FormRequest base holds the validator the compiled lifecycle hands in', () => {
  const request = new FormRequest(fakeRequest({}));
  const validator = new Validator({}, {});
  assert.equal(request.setValidator(validator), request);
  assert.equal(request.getValidatorInstance(), validator);
});

test('the FormRequest base without a validator fails loud (the kernel has no factory)', () => {
  const request = new FormRequest(fakeRequest({}));
  assert.throws(() => request.getValidatorInstance(), /has no validator/);
});

test('the FormRequest base does nothing on a passed validation (passedValidation)', () => {
  const request = new FormRequest(fakeRequest({}));
  assert.equal(request.passedValidation(), undefined);
});

test('the FormRequest base throws the ValidationException on a failed validation', async () => {
  const request = new FormRequest(fakeRequest({ email: '' }));
  const validator = new Validator(request.validationData(), { email: 'required' });
  request.setValidator(validator);
  assert.throws(
    () => request.failedValidation(request.getValidatorInstance()),
    (e) => {
      assert.ok(e instanceof ValidationException);
      assert.deepEqual(e.errors(), { email: ['The email field is required.'] });
      assert.equal(e.status, 422);
      assert.equal(e.errorBag, 'default');
      return true;
    }
  );
});

test("the lifecycle runs the hooks in Laravel's order", async () => {
  // ValidatesWhenResolvedTrait::validateResolved(): prepareForValidation ->
  // the validator -> withValidator -> after -> the rules -> passedValidation.
  const order = [];
  const request = new FormRequest(fakeRequest({ email: '' }));
  request.prepareForValidation = () => order.push('prepareForValidation');
  request.prepareForValidation();

  const validator = new Validator(request.validationData(), { email: 'required' });
  request.setValidator(validator);

  // The app's withValidator() hook: it registers on the validator.
  validator.after(() => order.push('withValidator'));
  // The app's after() hook: it RETURNS the callback Laravel registers.
  const callback = () => order.push('after');
  validator.after(callback);

  assert.equal(await request.getValidatorInstance().fails(), true);
  request.passedValidation();
  order.push('passedValidation');

  assert.deepEqual(order, [
    'prepareForValidation',
    'withValidator',
    'after',
    'passedValidation',
  ]);
});

// ---------------------------------------------------------------------------
// the 422 body
// ---------------------------------------------------------------------------

const KEY = Buffer.alloc(32, 7).toString('base64');

function baseConfig() {
  return {
    'app.key': 'base64:' + KEY,
    'app.url': 'http://localhost',
    'session.driver': 'cookie',
    'session.cookie': 'laravel_session',
    'session.lifetime': 120,
    'session.expire_on_close': false,
    'session.serialization': 'json',
    'session.path': '/',
    'session.domain': null,
    'session.secure': null,
    'session.http_only': true,
    'session.same_site': 'lax',
    'session.encrypt': false,
    'csrf.except': ['probe/after'],
    'cookies.except': [],
  };
}

// The compiled lifecycle the compiler track emits: the validator is built
// from the dumped rules, the app's after() hook registers on it, and the
// failure throws the ValidationException the HTTP kernel renders.
const HANDLERS = {
  'POST /probe/after': async (ctx) => {
    const validator = new Validator(ctx.request.all(), { email: 'required' });
    validator.after((v) => {
      v.errors().add('email', 'The email is already taken.');
    });
    if (await validator.fails()) {
      throw new ValidationException(validator.errors());
    }
    return { status: 200, body: 'ok' };
  },
};

const ROUTES = [{ uri: '/probe/after', methods: ['POST'], middleware: ['web'] }];

test('the 422 body of a failed validation with an after message keeps the shape', async () => {
  const headers = { host: 'localhost', accept: 'application/json', 'user-agent': 'Symfony' };
  headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = await handleHttp(
    { method: 'POST', url: 'http://localhost/probe/after', headers, body: 'email=a%40b.com' },
    {
      table: normalizeTable(ROUTES),
      handlers: HANDLERS,
      config: baseConfig(),
      clock: () => 1792336827,
      randomString: (n) => 'A'.repeat(n),
      clientIp: '127.0.0.1',
    }
  );
  assert.equal(res.status, 422);
  assert.equal(res.headers['content-type'], 'application/json');
  // The body is the same shape as before: the message and the error bag.
  assert.deepEqual(JSON.parse(res.body), {
    message: 'The email is already taken.',
    errors: { email: ['The email is already taken.'] },
  });
  assert.equal(
    res.body,
    '{"message":"The email is already taken.","errors":{"email":["The email is already taken."]}}'
  );
});
