// kernel/tests/view-error-bag.test.mjs — `$errors` inside a compiled view.
//
// ShareErrorsFromSession shares the session's `errors` value into EVERY view as
// a ViewErrorBag; the compiled Blade of `@error('x') ... @enderror` calls
// `$errors->getBag('default')`, `->has($key)` and `->first($key)`. Without the
// bag a view with @error died at render time ("Cannot read properties of
// undefined (reading 'getBag')") even when the session held no errors at all.
//
// Every expectation below was produced by running the same calls through the
// vendor classes (framework 13.x, PHP 8.3) and copying the answer:
//   has([])=true, hasAny([])=false, missing([])=true, has('a','b')=true,
//   has(null)=true (false on an empty bag), first() = the first message overall,
//   get('items.*') = a map keyed by the matching keys, first('items.*') = the
//   first message of the first match, count() = the leaf messages,
//   unique() = the distinct messages, merge() appends for an existing key and
//   keeps a scalar for a new one, getFormat() = ':message' and an empty format
//   argument falls back to it (checkFormat `?:`), __toString() = the JSON of
//   the messages, ViewErrorBag::hasBag() exists for a name that was put even
//   when its bag is empty and defaults to 'default', count()/any()/isEmpty()
//   and every other unknown method speak about the DEFAULT bag, `$errors->default`
//   answers a fresh UNSTORED bag (mutating it changes nothing), and
//   json_encode($errors) is `{}`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageBag, ViewErrorBag, viewErrorBag } from '../view-error-bag.mjs';

test('MessageBag: first/has/get/all/any/count follow Laravel', () => {
  const bag = new MessageBag({ name: 'Nama wajib diisi.', tags: ['Tidak valid.', 'Terlalu panjang.'] });
  assert.equal(bag.first('name'), 'Nama wajib diisi.');
  assert.equal(bag.first('missing'), '');
  assert.equal(bag.first(), 'Nama wajib diisi.');
  assert.equal(bag.has('name'), true);
  assert.equal(bag.has('missing'), false);
  assert.deepEqual(bag.get('tags'), ['Tidak valid.', 'Terlalu panjang.']);
  assert.deepEqual(bag.all(), ['Nama wajib diisi.', 'Tidak valid.', 'Terlalu panjang.']);
  assert.equal(bag.any(), true);
  assert.equal(bag.count(), 3);
  assert.equal(bag.isEmpty(), false);
  assert.equal(bag.isNotEmpty(), true);
  assert.deepEqual(bag.keys(), ['name', 'tags']);
  assert.equal(new MessageBag().isEmpty(), true);
  assert.equal(new MessageBag().any(), false);
  assert.equal(new MessageBag().count(), 0);
});

test('MessageBag: has/hasAny/missing take a list or variadic keys (vendor: array_all/array_any)', () => {
  const bag = new MessageBag({ a: 'first', b: ['x', 'y'] });
  assert.equal(bag.has(['a', 'b']), true);
  assert.equal(bag.has('a', 'b'), true);
  assert.equal(bag.has('a', 'zz'), false);
  assert.equal(bag.has([]), true, 'array_all over an empty list is true');
  assert.equal(bag.has(null), true, 'null asks any()');
  assert.equal(bag.hasAny(['a', 'zz']), true);
  assert.equal(bag.hasAny([]), false);
  assert.equal(bag.missing([]), true);
  assert.equal(bag.missing('a'), false);
  assert.equal(bag.missing('a', 'b'), false);
  assert.equal(new MessageBag().has(null), false, 'an empty bag has nothing, even for null');
  assert.equal(new MessageBag().hasAny('a'), false);
});

test('MessageBag: a wildcard key answers a map, first() its first match', () => {
  const bag = new MessageBag({ 'items.0': 'one', 'items.1': ['two', 'three'], z: 'zz' });
  assert.deepEqual(bag.get('items.*'), { 'items.0': ['one'], 'items.1': ['two', 'three'] });
  assert.equal(bag.first('items.*'), 'one');
  assert.deepEqual(bag.get('nope'), []);
  assert.deepEqual(bag.get('items.*', '<p>:message</p>'), {
    'items.0': ['<p>one</p>'],
    'items.1': ['<p>two</p>', '<p>three</p>'],
  });
});

test('MessageBag: the :message/:key format placeholder', () => {
  const bag = new MessageBag({ name: 'wajib diisi.' });
  assert.equal(bag.first('name', 'Nama: :message'), 'Nama: wajib diisi.');
  assert.equal(bag.first('name', 'Nama: :message|:key'), 'Nama: wajib diisi.|name');
  assert.deepEqual(bag.all('<p>:message</p>'), ['<p>wajib diisi.</p>']);
  assert.deepEqual(bag.get('name', ''), ['wajib diisi.'], 'an empty format falls back to getFormat()');
  assert.equal(bag.getFormat(), ':message');
  assert.deepEqual(bag.setFormat('<i>:message</i>').get('name'), ['<i>wajib diisi.</i>']);
  assert.deepEqual(new MessageBag({ a: 'x' }, ':message').all(), ['x']);
});

test('MessageBag: add/addIf dedupe, merge and unique follow Laravel', () => {
  const bag = new MessageBag();
  bag.add('k', 'v').add('k', 'v').addIf(false, 'k', 'no').addIf(true, 'k', 'w');
  assert.deepEqual(bag.getMessages(), { k: ['v', 'w'] });
  bag.merge({ k: ['m'], new: 'n' });
  assert.deepEqual(bag.getMessages(), { k: ['v', 'w', 'm'], new: 'n' });
  assert.deepEqual(bag.get('new'), ['n'], 'a merged scalar is still readable as a message');
  assert.deepEqual(new MessageBag({ a: ['x', 'x', 'y'], b: 'x' }).unique(), ['x', 'y']);
  assert.deepEqual(new MessageBag({ a: '1', b: '2' }).forget('a').getMessages(), { b: ['2'] });
  assert.equal(new MessageBag({ a: 'x' }).getMessageBag().first('a'), 'x');
  assert.deepEqual(new MessageBag({ a: 'x' }).toArray(), { a: ['x'] });
});

test('MessageBag: __toString/toJson answer the JSON of the messages', () => {
  const bag = new MessageBag({ a: 'x' });
  assert.equal(String(bag), '{"a":["x"]}');
  assert.equal(bag.toJson(), '{"a":["x"]}');
  assert.equal(JSON.stringify(bag), '{"a":["x"]}');
  assert.equal(String(new MessageBag()), '[]', 'PHP json_encode([]) is []');
});

test('ViewErrorBag: getBag answers an empty bag for an unknown name (not stored)', () => {
  const errors = new ViewErrorBag({ default: { name: 'x' } });
  assert.equal(errors.getBag('default').first('name'), 'x');
  assert.equal(errors.getBag('other').any(), false);
  assert.equal(errors.hasBag('other'), false, 'hasBag() is false for a name that was never put');
  assert.deepEqual(Object.keys(errors.getBags()), ['default']);
});

test('ViewErrorBag: hasBag() names the presence, defaults to "default", even for an empty bag', () => {
  const errors = new ViewErrorBag();
  assert.equal(errors.hasBag(), false);
  assert.equal(errors.hasBag('default'), false);
  errors.put('login', new MessageBag());
  assert.equal(errors.hasBag('login'), true, 'an empty bag is still a bag that was put');
  assert.equal(errors.getBag('login').isEmpty(), true);
  assert.equal(errors.hasBag(), false, 'putting another name does not create "default"');
});

test('ViewErrorBag: count()/any()/isEmpty()/first() speak about the DEFAULT bag', () => {
  const errors = new ViewErrorBag({ default: { a: '1' }, login: { b: ['2', '3'] } });
  assert.equal(errors.count(), 1);
  assert.equal(errors.any(), true);
  assert.equal(errors.has('a'), true);
  assert.equal(errors.has('b'), false, 'the login bag is only visible through getBag()');
  assert.equal(errors.first('b'), '');
  assert.equal(errors.getBag('login').count(), 2);
  assert.equal(errors.getBag('login').first('b'), '2');

  const other = new ViewErrorBag({ default: { a: '1' }, login: { b: '2' } });
  other.getBag('login').forget('b');
  assert.equal(other.any(), true, 'a later mutation of another bag never moves the default bag');
  assert.equal(new ViewErrorBag().isEmpty(), true);
  assert.equal(new ViewErrorBag().count(), 0);
});

test('ViewErrorBag: $errors->default is a fresh unstored bag, __toString is the default bag', () => {
  const errors = new ViewErrorBag({ default: { a: 'x' } });
  assert.equal(errors.default.first('a'), 'x');
  const empty = new ViewErrorBag();
  empty.default.add('a', 'A');
  assert.equal(empty.count(), 0, 'mutating $errors->default changes nothing (getBag())');
  assert.equal(empty.hasBag('default'), false);
  assert.equal(String(empty), '[]');
  assert.equal(String(errors), '{"a":["x"]}');
  assert.equal(JSON.stringify(errors), '{}', 'json_encode($errors) is {} (protected bags)');
});

test('ViewErrorBag: an unknown method forwards to the default bag (__call)', () => {
  const errors = new ViewErrorBag({ default: { a: ['x', 'y'] } });
  assert.equal(errors.isNotEmpty(), true);
  assert.equal(errors.getMessages().a.length, 2);
  assert.deepEqual(errors.all(), ['x', 'y']);
  assert.equal(errors.get('a', '!: :message').length, 2);
  assert.equal(errors.toJson(), '{"a":["x","y"]}');
  assert.equal(errors.getFormat(), ':message');
  assert.equal(errors.isUnique, undefined, 'protected bag methods stay unreachable (PHP: Call to protected method)');
  assert.equal(errors.checkFormat, undefined);
});

test('phpJsonEncode: a bag writes the message map, a ViewErrorBag writes {}', async () => {
  const { phpJsonEncode } = await import('../php-json.mjs');
  const bag = new MessageBag({ a: 'x' });
  assert.equal(phpJsonEncode(bag), '{"a":["x"]}', 'json_encode($bag) (vendor oracle)');
  assert.equal(phpJsonEncode(new MessageBag()), '[]', 'json_encode([]) is []');
  assert.equal(
    phpJsonEncode({ message: 'The email field is required.', errors: bag }),
    '{"message":"The email field is required.","errors":{"a":["x"]}}',
    'a bag nested in a response body (the 422 shape)'
  );
  assert.equal(phpJsonEncode(new ViewErrorBag({ default: { a: 'x' } })), '{}', 'json_encode($errors) (vendor oracle)');
});

test('viewErrorBag(): decodes the kernel session shape', () => {
  // kernel/validation.mjs sessionErrorBag(): { <bag>: { format, messages } }
  const errors = viewErrorBag({
    default: { format: ':message', messages: { email: 'Email tidak cocok.' } },
  });
  assert.equal(errors.getBag('default').first('email'), 'Email tidak cocok.');
});

test('viewErrorBag(): keeps the bag\'s own format from the session shape', () => {
  const errors = viewErrorBag({
    default: { format: 'Nama: :message', messages: { email: 'Email tidak cocok.' } },
  });
  assert.equal(errors.getBag('default').getFormat(), 'Nama: :message');
  assert.equal(errors.getBag('default').first('email'), 'Nama: Email tidak cocok.');
});

test('viewErrorBag(): a null session value is an empty bag (the normal page)', () => {
  const errors = viewErrorBag(null);
  assert.equal(errors.any(), false);
  assert.equal(errors.getBag('default').has('anything'), false);
  assert.equal(viewErrorBag(undefined).isEmpty(), true);
});

test('viewErrorBag(): a plain field=>message map is the default bag', () => {
  const errors = viewErrorBag({ name: 'wajib diisi.' });
  assert.equal(errors.getBag('default').first('name'), 'wajib diisi.');
});
