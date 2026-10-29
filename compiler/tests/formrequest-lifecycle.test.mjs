// compiler/tests/formrequest-lifecycle.test.mjs — the FormRequest hook order.
//
// Laravel runs the hooks around the validation
// (Illuminate/Foundation/Http/FormRequest::getValidatorInstance,
// FormRequest.php:94-131):
//
//   prepareForValidation() -> passesAuthorization() -> getValidatorInstance()
//     (rules() -> withValidator($validator) -> after())
//   -> fails()/failedValidation() -> passedValidation()
//
// `withValidator()` and `after()` both receive the validator: Laravel calls
// them through the container with `['validator' => $validator]`
// (FormRequest.php:110, :112-115), so `public function after(Validator $v)`
// is legal app code. The runtime hands the validator to `withValidator()`
// already; `after()` used to get nothing, so `$v` was undefined and the
// request died with a TypeError where Laravel answers 422.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRt } from '../runtime/rt-from-context.mjs';

const FQCN = 'App\\Http\\Requests\\AfterRequest';

// The compiled class registry entry (what the build emits): the methods are
// `(rt, ...args)` and the runtime binds the instance.
//
// `db` defaults to NULL on purpose: a worker without a D1 binding must still
// validate a request whose rules never touch the database (Laravel answers
// 200), and only `unique`/`exists` may complain.
function makeRt(methods, { db = null, input = { title: 'ok' } } = {}) {
  const request = {
    all: () => ({ ...input }),
    input: (key, def = null) => (Object.prototype.hasOwnProperty.call(input, key) ? input[key] : def),
  };
  return buildRt(
    {},
    {
      http: { request },
      db,
      classes: {
        [FQCN]: { base: 'formRequest', ctor: () => ({}), deps: [], methods },
      },
    }
  );
}

// A D1-shaped binding that answers one prepared query (the `unique` rule's
// COUNT(*)).
function countBinding(count) {
  return {
    prepare() {
      const stmt = {
        bind: () => stmt,
        first: async () => ({ aggregate: count }),
        all: async () => ({ results: [{ aggregate: count }] }),
        run: async () => ({ success: true, meta: {} }),
      };
      return stmt;
    },
  };
}

test('formrequest: after() receives the validator Laravel passes it', async () => {
  const seen = [];
  const rt = makeRt({
    // `public function after(Validator $validator): callable`
    after: async (rtArg, validator) => {
      seen.push(validator);
      return () => {};
    },
  });
  await rt.formRequest(FQCN, {
    hooks: ['after'],
    rules: { title: ['required', 'string'] },
    messages: {},
    attributes: {},
  });
  assert.equal(seen.length, 1);
  assert.ok(seen[0], 'the hook must receive the validator');
  // The kernel's validator surface: the hook may add a message through it.
  assert.equal(typeof seen[0].errors, 'function');
});

test('formrequest: an after() that adds a message fails the request', async () => {
  const rt = makeRt({
    after: async (rtArg, validator) => {
      validator.errors().add('title', 'The title is refused by after().');
      return () => {};
    },
  });
  await assert.rejects(
    () =>
      rt.formRequest(FQCN, {
        hooks: ['after'],
        rules: { title: ['required', 'string'] },
        messages: {},
        attributes: {},
      }),
    (e) => {
      // failedValidation() throws the ValidationException the HTTP layer turns
      // into the 422 body.
      assert.equal(e.name, 'ValidationException');
      assert.deepEqual(e.errors(), { title: ['The title is refused by after().'] });
      return true;
    }
  );
});

test('formrequest: an after() that takes no parameter still works', async () => {
  // The common shape (`public function after(): callable`) must not break: the
  // extra argument is ignored.
  const rt = makeRt({ after: async () => () => {} });
  await rt.formRequest(FQCN, {
    hooks: ['after'],
    rules: { title: ['required', 'string'] },
    messages: {},
    attributes: {},
  });
});

test('formrequest: a unique rule reads the connection the worker binds', async () => {
  const rt = makeRt({}, { db: countBinding(0), input: { email: 'new@example.com' } });
  // No row matches: the request passes.
  await rt.formRequest(FQCN, {
    hooks: [],
    rules: { email: ['required', 'unique:users,email'] },
    messages: {},
    attributes: {},
  });
  // A matching row fails the rule with Laravel's message.
  const taken = makeRt({}, { db: countBinding(1), input: { email: 'taken@example.com' } });
  await assert.rejects(
    () =>
      taken.formRequest(FQCN, {
        hooks: [],
        rules: { email: ['required', 'unique:users,email'] },
        messages: {},
        attributes: {},
      }),
    (e) => {
      assert.equal(e.name, 'ValidationException');
      assert.deepEqual(e.errors(), { email: ['The email has already been taken.'] });
      return true;
    }
  );
});

test('formrequest: unique without a connection raises the rule its own error', async () => {
  // The binding is OPTIONAL for the lifecycle: without one, the rule that needs
  // it raises the precise message instead of every FormRequest dying.
  const rt = makeRt({}, { db: null, input: { email: 'x@example.com' } });
  await assert.rejects(
    () =>
      rt.formRequest(FQCN, {
        hooks: [],
        rules: { email: ['required', 'unique:users,email'] },
        messages: {},
        attributes: {},
      }),
    /validation rule "unique" needs opts\.db/
  );
  // A request with no db-touching rule passes without a binding.
  await rt.formRequest(FQCN, {
    hooks: [],
    rules: { email: ['required', 'email'] },
    messages: {},
    attributes: {},
  });
});
// The `url` rule through the FormRequest lifecycle: `ValidateAttributes::validateUrl`
// is `is_string($value) && Str::isUrl($value, $parameters)`, so a custom list replaces
// Laravel's default one and a non-string never passes. The rule was reachable only
// through a plain `new Validator(...)` probe before; this drives the FormRequest path a
// compiled app actually takes. Every expectation is the PHP 8.3 oracle's answer.
test('formrequest: the url rule', async () => {
  const run = (value, ...params) =>
    makeRt({}, { input: { site: value } }).formRequest(FQCN, {
      hooks: [],
      rules: { site: params.length ? ['url:' + params.join(',')] : ['url'] },
      messages: {},
      attributes: {},
    });
  const refuse = (value, ...params) =>
    assert.rejects(run(value, ...params), (e) => {
      assert.equal(e.name, 'ValidationException', 'expected 422 for ' + JSON.stringify(value));
      return true;
    });

  // Laravel accepts these.
  for (const [value, ...params] of [
    ['https://laravel.com/docs'],
    ['ftp://example.com/file'],
    ['wss://example.com/socket'],
    ['irc://example.com:6667/ch'],
    ['http://u:p@x.co:8080/a?b=1#c'],
    ['http://user:pa%40ss@example.com/x'],
    ['http://[::1]/x'],
    ['https://exämple.de/ä'],
    ['https://bücher.example/'],
    ['HTTP://X.CO'],            // the pattern is case-insensitive (`~...~ix`)
    ['http://x.co\n'],          // PCRE's `$` matches before a trailing newline
    ['another://x.co', 'another'],
    ['ftp://x.co', 'ftp', 'http'],
  ]) {
    await run(value, ...params);
  }

  // Laravel refuses these.
  for (const [value, ...params] of [
    ['x.co'],                   // scheme-less host
    ['example.com'],
    ['mailto:a@b.c'],           // `mailto` never carries `://`
    ['http://x.co '],           // only a NEWLINE may precede the end
    ['http://'],
    ['', ],                     // skipped -> see the next block
  ]) {
    if (value === '') continue; // an empty string passes (Laravel skips non-implicit rules)
    await refuse(value, ...params);
  }
  await refuse('http://x.co', 'ftp');   // the caller's list replaces the default one

  // Non-strings never pass; an empty string and an absent key do (Laravel skips a
  // non-implicit rule for an empty value, and `null` is NOT empty for this check).
  for (const value of [null, 42, ['http://x.co'], true, false]) await refuse(value);
  await run('');
});
