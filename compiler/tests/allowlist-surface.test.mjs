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
  VALIDATOR_METHODS,
  FILE_METHODS,
  REQUEST_CALL,
  REQUEST_ASYNC,
  REQUEST_NO_CHAIN,
} from '../src/transpiler.mjs';
import { Validator } from '../../kernel/validator.mjs';
import { buildRequest } from '../../kernel/http.mjs';
import { Model } from '../../kernel/model.mjs';
import { ARR_METHODS, arr as arrHelpers } from '../../kernel/arr.mjs';
import { Collection } from '../../kernel/collections.mjs';
import { LengthAwarePaginator } from '../../kernel/paginator.mjs';
import { PACKAGE_BINDINGS } from '../package-bindings.mjs';
import * as kernelToken from '../../kernel/packages/token.mjs';
import * as kernelOauth from '../../kernel/packages/oauth.mjs';
import * as kernelWebhook from '../../kernel/packages/webhook.mjs';
import * as kernelBroadcast from '../../kernel/packages/broadcast.mjs';
import * as kernelNotifyHttp from '../../kernel/packages/notify-http.mjs';

// The rt primitive each binding compiles to — the SAME modules buildRt exposes
// as rt.token / rt.oauth / rt.webhook / rt.broadcast / rt.notify.
const KERNEL_PRIMITIVES = {
  token: kernelToken,
  oauth: kernelOauth,
  webhook: kernelWebhook,
  broadcast: kernelBroadcast,
  notify: kernelNotifyHttp,
};

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
  // And one it does not have is not (`lazy()` needs a LazyCollection,
  // which the edge does not compile).
  assert.equal(COLLECTION_METHODS.has('lazy'), false);
});

test('allowlist: the allowed model methods answer what Laravel answers', () => {
  // A name in the allowlist is not enough: it must answer Laravel's VALUE.
  // Two did not. `toJson()` answers a JSON STRING (Model.php:2094) - the
  // kernel's `toJSON()` is the JS protocol hook and answers an OBJECT, so a
  // compiled `$post->toJSON()` (the same call in PHP, where method names are
  // case-insensitive) sent an object where Laravel sends a string.
  // `getDirty()` answers a KEY => VALUE map (HasAttributes.php:2341), not the
  // list of keys the kernel used to answer.
  class Post extends Model {}
  Post.table = 'posts';
  Post.primaryKey = 'id';
  Post.fillable = ['title', 'body'];
  const post = new Post({ title: 'K2', body: 'a/b' });

  assert.deepEqual(post.getDirty(), { title: 'K2', body: 'a/b' });
  assert.equal(post.isDirty('title'), true);
  assert.equal(post.isDirty('nope'), false);
  // `isDirty($attributes = null)` reads func_get_args() (HasAttributes.php:
  // 2262-2267): the array form AND the varargs form are legal, and either
  // attribute being dirty answers true.
  assert.equal(post.isDirty(['title', 'body']), true);
  assert.equal(post.isDirty('title', 'nope'), true);
  assert.equal(post.isDirty('nope', 'nada'), false);
  // The string is PHP's json_encode, not JSON.stringify: the expectation is a
  // LITERAL, so a swap back to JSON.stringify fails (PHP escapes the slash).
  assert.equal(typeof post.toJson(), 'string');
  assert.equal(post.toJson(), '{"title":"K2","body":"a\\/b"}');
  // The protocol hook stays an object: JSON.stringify / phpJsonEncode read it,
  // and PHP's JsonSerializable is what a model is there (Laravel has no
  // `toJSON()` method).
  assert.equal(typeof post.toJSON(), 'object');
  assert.deepEqual(post.toJSON(), post.toArray());
});

test('allowlist: every Arr method the compiler allows exists on rt.Arr', () => {
  // Arr::except() is not an app nicety — Blade's own compiled view-data filter
  // is Arr::except(...) on Laravel 11.0-11.42, so a view dies without it.
  const surface = surfaceOf(arrHelpers);
  const missing = [...ARR_METHODS].filter((name) => !surface.has(name));
  assert.deepEqual(missing, [], `rt.Arr has no ${missing.join(', ')}() — the call would throw at request time`);
  assert.ok(ARR_METHODS.has('except'), 'Arr::except() must be allowed: Blade emits it');
});
test('allowlist: every validator method exists on the kernel Validator', () => {
  // A `withValidator(Validator $validator)` hook calls the validator directly
  // (transpile: a typed receiver consults VALIDATOR_METHODS), so a name the
  // kernel lacks compiles green and throws "is not a function" at request time.
  const surface = surfaceOf(Validator.prototype);
  const missing = [...VALIDATOR_METHODS.keys()].filter((name) => !surface.has(name));
  assert.deepEqual(missing, [], `the kernel Validator has no ${missing.join(', ')}() - the call would 500`);
  // The BAG methods are reached through the chain, so they must NOT be here:
  // PHP's Validator has no isEmpty()/getMessages()/toArray()/isNotEmpty().
  for (const bagOnly of ['isEmpty', 'isNotEmpty', 'getMessages', 'toArray']) {
    assert.ok(!VALIDATOR_METHODS.has(bagOnly), `${bagOnly}() is a MessageBag method - it belongs on the chain`);
  }
});
test('allowlist: every request method exists on the kernel request object', () => {
  // `$request->input()` etc. compile to plain calls on the object buildRequest()
  // answers; a name it lacks is the same silent 500.
  const req = buildRequest({ method: 'GET', path: '/', query: {}, headers: {}, body: '', cookies: {} });
  const names = [...REQUEST_CALL, ...REQUEST_ASYNC, ...REQUEST_NO_CHAIN];
  const missing = names.filter((name) => typeof req[name] !== 'function');
  assert.deepEqual(missing, [], `the kernel request has no ${missing.join(', ')}() - the call would 500`);
});
test('allowlist: every file method exists on the kernel uploaded file', () => {
  // `$request->file('x')` answers the UploadedFile the kernel builds from the
  // multipart body; FILE_METHODS must be a subset of its surface.
  const boundary = 'LWGUARD';
  const bytes = new Uint8Array(
    Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="avatar"; filename="a.png"\r\n' +
        'Content-Type: image/png\r\n\r\nabc\r\n' +
        `--${boundary}--\r\n`,
      'utf8'
    )
  );
  // buildRequest parses the multipart body itself (the content-type header
  // is what selects the parser), exactly as the worker passes it in.
  const req = buildRequest({
    method: 'POST',
    path: '/upload',
    query: {},
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: bytes,
    cookies: {},
  });
  const file = req.file('avatar');
  assert.ok(file, 'the uploaded file must be on the request');
  const missing = [...FILE_METHODS].filter((name) => typeof file[name] !== 'function');
  assert.deepEqual(missing, [], `the kernel uploaded file has no ${missing.join(', ')}() - the call would 500`);
});

// M3: every method a package binding allowlists must exist on the kernel
// primitive the call compiles to (`rt.<primitive>.<method>`), and every method
// the binding marks async must actually be an async function (so the `await`
// the transpiler emits is not wrapping a sync value, which would break
// `await`-ing code that reads a property off the result).
test('allowlist: every package binding method exists on its kernel primitive', () => {
  for (const binding of PACKAGE_BINDINGS) {
    const primitive = KERNEL_PRIMITIVES[binding.primitive];
    assert.ok(primitive, `binding ${binding.facade}: no kernel primitive '${binding.primitive}'`);
    // `methods` maps the facade method (source) -> the primitive function name
    // (emitted call); the VALUE must exist on the rt primitive.
    const primitiveFns = Object.values(binding.methods);
    const missing = primitiveFns.filter((name) => typeof primitive[name] !== 'function');
    assert.deepEqual(
      missing,
      [],
      `binding ${binding.facade} -> rt.${binding.primitive}: the kernel primitive has no ${missing.join(', ')}() - the call would 500`
    );
    const notAsync = binding.async.filter((name) => primitive[name]?.constructor?.name !== 'AsyncFunction');
    assert.deepEqual(
      notAsync,
      [],
      `binding ${binding.facade}: ${notAsync.join(', ')}() marked async but is not an async function - the emitted await would be wrong`
    );
    // Every name marked async must be one of the emitted primitive functions.
    const unknownAsync = binding.async.filter((name) => !primitiveFns.includes(name));
    assert.deepEqual(
      unknownAsync,
      [],
      `binding ${binding.facade}: async lists ${unknownAsync.join(', ')} which is not an emitted method`
    );
  }
});
