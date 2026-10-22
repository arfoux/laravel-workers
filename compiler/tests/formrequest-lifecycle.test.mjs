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
function makeRt(methods) {
  const request = {
    all: () => ({ title: 'ok' }),
    input: (key, def = null) => (key === 'title' ? 'ok' : def),
  };
  return buildRt(
    {},
    {
      http: { request },
      // The validator is constructed with rt.db() (the unique/exists rules read
      // the database); these rules never touch it, so a stub is enough.
      db: { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [] }), first: async () => null, run: async () => ({ success: true, meta: {} }) }) },
      classes: {
        [FQCN]: { base: 'formRequest', ctor: () => ({}), deps: [], methods },
      },
    }
  );
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
