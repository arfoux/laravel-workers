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
