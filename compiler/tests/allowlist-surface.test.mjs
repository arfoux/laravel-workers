// compiler/tests/allowlist-surface.test.mjs — the allowlists match the kernel.
//
// The transpiler lets a method call through when its name is in an allowlist:
// MODEL_INSTANCE_METHODS (a model variable), INSTANCE_DB_METHODS (a model
// method whose compiled call takes the database binding), PAGINATOR_METHODS (a
// paginator), COLLECTION_METHODS (a relation read, derived from the kernel's
// Collection).
// A name in an allowlist that the kernel object does NOT have compiles green and
// then throws "is not a function" at request time - a 500 where Laravel answers.
// That is the failure mode this repo treats as the worst one, and it shipped
// once (an inline relation chain skipped the allowlist entirely: A87).
//
// The contract: every allowlisted name exists on the object the call compiles
// to. The one documented exception is the paginator's `links()`, which the
// runtime attaches per instance (`rt.paginate`) because it renders a view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_INSTANCE_METHODS,
  INSTANCE_DB_METHODS,
  PAGINATOR_METHODS,
  COLLECTION_METHODS,
} from '../src/transpiler.mjs';
import { Model } from '../../kernel/model.mjs';
import { Collection } from '../../kernel/collections.mjs';
import { LengthAwarePaginator } from '../../kernel/paginator.mjs';

const surfaceOf = (proto) => new Set(Object.getOwnPropertyNames(proto));

test('allowlist: every model instance method exists on the kernel Model', () => {
  const surface = surfaceOf(Model.prototype);
  const missing = [...MODEL_INSTANCE_METHODS].filter((name) => !surface.has(name));
  assert.deepEqual(missing, [], `the kernel Model has no ${missing.join(', ')}() — the call would 500`);
});

test('allowlist: every db-carrying model method exists on the kernel Model', () => {
  // The compiled call passes the database binding, so the method MUST exist or
  // the request dies with "is not a function". `push()` was here once and the
  // kernel did not have it: `$post->push()` compiled green and 500'd.
  const surface = surfaceOf(Model.prototype);
  const missing = [...INSTANCE_DB_METHODS].filter((name) => !surface.has(name));
  assert.deepEqual(missing, [], `the kernel Model has no ${missing.join(', ')}() — the call would 500`);
  // The two sets together are what a compiled model call may name, so a method
  // that needs the binding is never also in the plain set without it.
  for (const name of INSTANCE_DB_METHODS) {
    assert.ok(MODEL_INSTANCE_METHODS.has(name), `${name}() takes the binding, so it must also be an allowed instance method`);
  }
});

test('allowlist: every paginator method exists on the kernel paginator', () => {
  // `links()` is attached by rt.paginate (it renders the compiled pagination
  // view), so it is the one name the prototype does not carry.
  const surface = surfaceOf(LengthAwarePaginator.prototype);
  const attached = new Set(['links']);
  const missing = [...PAGINATOR_METHODS].filter((name) => !surface.has(name) && !attached.has(name));
  assert.deepEqual(missing, [], `the kernel paginator has no ${missing.join(', ')}() — the call would 500`);
});

test('allowlist: the Collection allowlist IS the kernel Collection surface', () => {
  // Derived, not hand-written: a method the kernel adds is callable at once,
  // and one it lacks can never be allowed.
  const surface = surfaceOf(Collection.prototype);
  assert.deepEqual(
    [...COLLECTION_METHODS].sort(),
    [...surface].filter((n) => n !== 'constructor').sort()
  );
  // The methods a compiled app actually calls are there.
  for (const name of ['count', 'pluck', 'first', 'isEmpty', 'sum', 'toArray']) {
    assert.ok(COLLECTION_METHODS.has(name), `Collection.${name}() must be allowed`);
  }
  // And one it does not have is not.
  assert.equal(COLLECTION_METHODS.has('sliding'), false);
});
