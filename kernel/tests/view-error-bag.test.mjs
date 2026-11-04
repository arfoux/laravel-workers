// kernel/tests/view-error-bag.test.mjs — `$errors` inside a compiled view.
//
// ShareErrorsFromSession shares the session's `errors` value into EVERY view as
// a ViewErrorBag; the compiled Blade of `@error('x') … @enderror` calls
// `$errors->getBag('default')`, `->has($key)` and `->first($key)`. Without the
// bag a view with @error died at render time ("Cannot read properties of
// undefined (reading 'getBag')") even when the session held no errors at all.
//
// The expectations are Laravel's own: MessageBag::first() answers '' for a
// missing key (MessageBag.php:100-107), has() is `first() !== ''` (:122-125),
// Collection-like any()/count()/isEmpty() follow Collection.php, and
// ViewErrorBag::getBag() answers a FRESH empty bag for an unknown name
// (ViewErrorBag.php:63-66) — it does not add it to the bag set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageBag, ViewErrorBag, viewErrorBag } from '../view-error-bag.mjs';

test('MessageBag: first/has/get/all/any/count follow Laravel', () => {
  const bag = new MessageBag({ name: 'Nama wajib diisi.', tags: ['Tidak valid.', 'Terlalu panjang.'] });
  assert.equal(bag.first('name'), 'Nama wajib diisi.');
  assert.equal(bag.first('missing'), '');
  assert.equal(bag.has('name'), true);
  assert.equal(bag.has('missing'), false);
  assert.deepEqual(bag.get('tags'), ['Tidak valid.', 'Terlalu panjang.']);
  assert.deepEqual(bag.all(), ['Nama wajib diisi.', 'Tidak valid.', 'Terlalu panjang.']);
  assert.equal(bag.any(), true);
  assert.equal(bag.count(), 3);
  assert.equal(bag.isEmpty(), false);
  assert.deepEqual(bag.keys(), ['name', 'tags']);
  assert.equal(new MessageBag().isEmpty(), true);
  assert.equal(new MessageBag().any(), false);
});

test('MessageBag: the :message format placeholder', () => {
  const bag = new MessageBag({ name: 'wajib diisi.' });
  assert.equal(bag.first('name', 'Nama: :message'), 'Nama: wajib diisi.');
  assert.deepEqual(bag.all('<p>:message</p>'), ['<p>wajib diisi.</p>']);
});

test('ViewErrorBag: getBag answers an empty bag for an unknown name (not stored)', () => {
  const errors = new ViewErrorBag({ default: { name: 'x' } });
  assert.equal(errors.getBag('default').first('name'), 'x');
  assert.equal(errors.getBag('other').any(), false);
  assert.equal(errors.hasBag('other'), false, 'hasBag() is false for a name that was never put');
  assert.deepEqual(Object.keys(errors.getBags()), ['default']);
});

test('ViewErrorBag: any()/count() aggregate every bag', () => {
  const errors = new ViewErrorBag({ default: { a: '1' }, login: { b: ['2', '3'] } });
  assert.equal(errors.any(), true);
  assert.equal(errors.count(), 3);
  assert.equal(errors.hasBag('login'), true);
  assert.equal(new ViewErrorBag().isEmpty(), true);
});

test('viewErrorBag(): decodes the kernel session shape', () => {
  // kernel/validation.mjs sessionErrorBag(): { <bag>: { format, messages } }
  const errors = viewErrorBag({
    default: { format: ':message', messages: { email: 'Email tidak cocok.' } },
  });
  assert.equal(errors.getBag('default').first('email'), 'Email tidak cocok.');
});

test('viewErrorBag(): a null session value is an empty bag (the normal page)', () => {
  const errors = viewErrorBag(null);
  assert.equal(errors.any(), false);
  assert.equal(errors.getBag('default').has('anything'), false);
});

test('viewErrorBag(): a plain field=>message map is the default bag', () => {
  const errors = viewErrorBag({ name: 'wajib diisi.' });
  assert.equal(errors.getBag('default').first('name'), 'wajib diisi.');
});
