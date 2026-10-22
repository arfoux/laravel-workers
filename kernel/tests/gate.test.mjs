// kernel/tests/gate.test.mjs — Illuminate\Auth\Access\Gate at the edge.
//
// Ground truth: Illuminate/Auth/Access/Gate.php (the vendored Laravel 13),
// probed with PHP 8.3:
//   - raw(): the `before` callbacks answer a NON-NULL result and short-circuit
//     (:558-568); otherwise the ability runs; the `after` callbacks see the
//     result (:428-453);
//   - allows/denies (:326-341), check = ALL (:350-355), any (:364-367),
//     none (:376-379), authorize throws AuthorizationException with
//     "This action is unauthorized.";
//   - a GUEST reaches a callback only when its first parameter is nullable or
//     defaults to null (parameterAllowsGuests(), :529-533 via
//     canBeCalledWithUser(), :463-480) - otherwise Laravel answers false
//     WITHOUT calling it (a probe: a `fn ($user) => true` ability answers false
//     for a guest);
//   - an ability nobody defines answers false (the empty closure,
//     resolveAuthCallback(), :642-644);
//   - a policy method answers when the first argument is a model that has one
//     (:621-627).
//
// No PHP runs at test time.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGate, GateResponse, AuthorizationError } from '../gate.mjs';

const user = { email: 'admin@example.test' };

test('a global ability answers with the user, and false for a guest that is not allowed', async () => {
  const gate = createGate({
    user: () => user,
    abilities: {
      'is-admin': { fn: (u) => u !== null && u.email === 'admin@example.test', guestAllowed: true },
    },
  });
  assert.equal(await gate.allows('is-admin'), true);
  assert.equal(await gate.denies('is-admin'), false);
});

test('a guest is not called when the ability does not allow guests', async () => {
  let called = 0;
  const gate = createGate({
    user: () => null,
    abilities: {
      // `fn ($user) => true` - a non-nullable parameter: Laravel answers false
      // without calling it (canBeCalledWithUser(), :463-480).
      'needs-user': { fn: () => { called++; return true; }, guestAllowed: false },
      // `fn ($user = null) => true` - guests are allowed.
      'always-true': { fn: () => { called++; return true; }, guestAllowed: true },
    },
  });
  assert.equal(await gate.allows('needs-user'), false);
  assert.equal(called, 0, 'the guest must not reach the callback');
  assert.equal(await gate.allows('always-true'), true);
  assert.equal(called, 1);
});

test('an ability nobody defines answers false (the empty closure)', async () => {
  const gate = createGate({ user: () => user, abilities: {} });
  assert.equal(await gate.allows('nope'), false);
});

test('check = ALL, any = ONE, none = NOT any', async () => {
  const gate = createGate({
    user: () => user,
    abilities: {
      a: { fn: () => true, guestAllowed: true },
      b: { fn: () => false, guestAllowed: true },
    },
  });
  assert.equal(await gate.check(['a', 'a']), true);
  assert.equal(await gate.check(['a', 'b']), false);
  // check() on an empty list is true (every() on an empty collection).
  assert.equal(await gate.check([]), true);
  assert.equal(await gate.any(['b', 'a']), true);
  assert.equal(await gate.any(['b']), false);
  assert.equal(await gate.none(['b']), true);
  assert.equal(await gate.none(['a']), false);
});

test('a policy method answers for a model subject', async () => {
  const post = { constructor: { name: 'Post' } };
  const gate = createGate({
    user: () => user,
    aliases: { Post: 'App\\Models\\Post' },
    policies: {
      'App\\Models\\Post': {
        methods: {
          update: (u, subject) => subject === post && u === user,
        },
      },
    },
  });
  assert.equal(await gate.allows('update', post), true);
  // The same ability without the subject has no policy callback: false.
  assert.equal(await gate.allows('update'), false);
});

test('before short-circuits on a non-null answer; after may replace the result', async () => {
  const seen = [];
  const gate = createGate({
    user: () => user,
    abilities: { a: { fn: () => true, guestAllowed: true } },
    before: [(u, ability) => (ability === 'a' ? false : null)],
    after: [(u, ability, args, result) => { seen.push(result); return null; }],
  });
  assert.equal(await gate.allows('a'), false, 'before answered false and the ability never ran');
  assert.deepEqual(seen, [false], 'after saw the before result');

  const gate2 = createGate({
    user: () => user,
    abilities: { a: { fn: () => true, guestAllowed: true } },
    after: [(u, ability, args, result) => (result ? new GateResponse(true) : null)],
  });
  assert.equal(await gate2.allows('a'), true);
});

test('authorize throws Laravel\'s AuthorizationException (a 403)', async () => {
  const gate = createGate({
    user: () => user,
    abilities: { no: { fn: () => false, guestAllowed: true } },
  });
  await assert.rejects(
    () => gate.authorize('no'),
    (err) => {
      assert.ok(err instanceof AuthorizationError);
      assert.equal(err.status, 403);
      assert.equal(err.message, 'This action is unauthorized.');
      return true;
    }
  );
  // A Response carries its own message and status.
  const gate2 = createGate({
    user: () => user,
    abilities: { resp: { fn: () => new GateResponse(false, 'Nope, custom.', 403), guestAllowed: true } },
  });
  await assert.rejects(() => gate2.authorize('resp'), /Nope, custom\./);
});
