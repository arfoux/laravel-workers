// compiler/tests/rt-request.test.mjs — the request-bound helpers of the runtime.
//
//   env('NAME')            — a Worker BINDING is the edge's environment; the
//                            four APP_* keys still fold through the config dump,
//                            and a key that is neither refuses (there is no .env
//                            at the edge). A compiled controller that reads a
//                            deployment secret (a FormRequest fallback hash) must
//                            get the binding, not a throw.
//   rt.formRequest(...)    — the compiled lifecycle. A rule-only FormRequest has
//                            no hooks (the dump reported none), so the runtime
//                            validates the inline rules against the live request
//                            and answers validator.validated(); a hook the dump
//                            DID report forces the compiled class and the
//                            lifecycle calls it (see
//                            formrequest-lifecycle.test.mjs). A
//                            failure raises the kernel's ValidationException
//                            (302/422, not a TypeError).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRt } from '../runtime/rt-from-context.mjs';

const request = (data = {}) => ({
  all: () => ({ ...data }),
  input: (key, def = null) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : def),
  expectsJson: () => false,
});

test('env(): a Worker binding answers before the config mapping', () => {
  const rt = buildRt(null, { strict: true, http: { env: { SEAL_KEY: 'from-binding' } } });
  assert.equal(rt.env('SEAL_KEY'), 'from-binding');
  // A key that is neither a binding nor a compiled config key is REFUSED (the
  // rung's loud-failure rule: there is no .env at the edge, and a silent null
  // would hide a binding the deployment forgot to declare).
  assert.throws(() => rt.env('SEAL_KEY_ID'), /neither a Worker binding nor a compiled config key/);
});

test('env(): the APP_* keys fold through the config dump', () => {
  const rt = buildRt(null, { strict: true, config: { 'app.env': 'production' } });
  assert.equal(rt.env('APP_ENV'), 'production');
});

test('formRequest(): a rule-only request validates the live input and answers validated()', async () => {
  const rt = buildRt(null, { strict: true, http: { request: request({ name: 'Warga Uji' }) } });
  const validated = await rt.formRequest('App\\Http\\Requests\\Profile\\UpdateProfileRequest', {
    rules: { name: ['required', 'string', 'max:100'] },
    messages: { 'name.required': 'Nama lengkap wajib diisi.' },
  });
  assert.deepEqual(validated, { name: 'Warga Uji' });
});

test('formRequest(): a failure raises the kernel ValidationException (not a TypeError)', async () => {
  const rt = buildRt(null, { strict: true, http: { request: request({ name: '' }) } });
  await assert.rejects(
    rt.formRequest('App\\Http\\Requests\\Profile\\UpdateProfileRequest', {
      rules: { name: ['required', 'string'] },
      messages: { 'name.required': 'Nama lengkap wajib diisi.' },
    }),
    (error) => {
      assert.equal(error.name, 'ValidationException');
      assert.equal(error.status, 422);
      assert.equal(error.lwKernel, true, 'the kernel renders it (redirect + flash), it is not flattened');
      assert.equal(error.errors().name[0], 'Nama lengkap wajib diisi.');
      return true;
    }
  );
});
