// kernel/tests/upload.test.mjs — the upload (a multipart body) at the edge.
//
// The file object is what `$request->file('x')` returns: the metadata of the
// part (the name, the type the browser declared, the size) + the store (the
// app's default disk). The rules follow Laravel 13:
//   - getClientOriginalName(): the basename (Symfony's File::getName()),
//   - getClientOriginalExtension(): pathinfo(originalName, EXTENSION),
//   - getClientMimeType(): the type the browser declared,
//   - getSize(): the bytes,
//   - store()/storeAs(): the disk-relative path of the object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from '../http.mjs';
import { createStorage } from '../storage.mjs';
import { Validator } from '../validator.mjs';

const BOUNDARY = '----lwUploadBoundary';

function multipart(parts) {
  let body = '';
  for (const part of parts) {
    body += `--${BOUNDARY}\r\n`;
    body += `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) body += `; filename="${part.filename}"`;
    body += '\r\n';
    if (part.type) body += `Content-Type: ${part.type}\r\n`;
    body += '\r\n';
    body += part.content;
    body += '\r\n';
  }
  body += `--${BOUNDARY}--\r\n`;
  return new TextEncoder().encode(body);
}

function uploadRequest(parts, options = {}) {
  return buildRequest(
    {
      method: 'POST',
      url: 'http://localhost/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: multipart(parts),
    },
    options
  );
}

// A 1x1 PNG header (signature + IHDR): the `image`/`mimes` rules are a header
// read, so the bytes must go through the multipart body unchanged.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

// A real 1x1 JPEG (SOI + APP0/JFIF + DQT + SOF0 + SOS + EOI): `mimes:jpeg` must
// accept it, which is why the fixture decodes from base64 instead of hand-typing
// marker bytes (audit #857).
const JPEG_BYTES = new Uint8Array(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAx' +
      'NDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEA' +
      'AD8AKp//2Q==',
    'base64'
  )
);

function multipartBytes(parts) {
  const chunks = [];
  const enc = new TextEncoder();
  for (const part of parts) {
    let head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.type) head += `Content-Type: ${part.type}\r\n`;
    head += '\r\n';
    chunks.push(enc.encode(head));
    chunks.push(part.bytes !== undefined ? part.bytes : enc.encode(part.content));
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${BOUNDARY}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function uploadRequestBinary(parts, options = {}) {
  return buildRequest(
    {
      method: 'POST',
      url: 'http://localhost/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: multipartBytes(parts),
    },
    options
  );
}

test('upload: the file metadata is Laravel\'s (the basename, the type, the size)', () => {
  const req = uploadRequest([
    { name: 'title', content: 'Shadow upload' },
    { name: 'avatar', filename: 'a b.txt', type: 'text/plain', content: 'hello file' },
  ]);
  const file = req.file('avatar');
  assert.equal(file.getClientOriginalName(), 'a b.txt');
  assert.equal(file.getClientOriginalExtension(), 'txt');
  assert.equal(file.getClientMimeType(), 'text/plain');
  assert.equal(file.getSize(), 10);
  assert.equal(file.isValid(), true);
  assert.equal(new TextDecoder().decode(file.get()), 'hello file');
});

test('upload: the original name is the basename (Symfony\'s File::getName())', () => {
  const req = uploadRequest([
    { name: 'avatar', filename: 'dir/sub/photo.png', type: 'image/png', content: 'x' },
  ]);
  assert.equal(req.file('avatar').getClientOriginalName(), 'photo.png');
  assert.equal(req.file('avatar').getClientOriginalExtension(), 'png');
});

test('upload: a field with name[] holds an array of files', () => {
  const req = uploadRequest([
    { name: 'photos[]', filename: 'a.txt', type: 'text/plain', content: 'a' },
    { name: 'photos[]', filename: 'b.txt', type: 'text/plain', content: 'bb' },
  ]);
  const photos = req.file('photos');
  assert.equal(Array.isArray(photos), true);
  assert.equal(photos.length, 2);
  assert.equal(photos[0].getClientOriginalName(), 'a.txt');
  assert.equal(photos[1].getSize(), 2);
});

// PHP registers a FILE name through the SAME `php_register_variable_ex()` rule
// as a field name, so `name="post[image]"` is `$_FILES['post']['image']` - a MAP,
// not a part to drop. Measured against a live PHP 8.3 server (`php -S` + `curl
// -F 'post[image]=@f'`, the real rfc1867 parser):
//   post[image] -> $_FILES['post']['image']   a map
//   a[b][c]     -> $_FILES['a']['b']['c']     nested maps
//   k[0]        -> $_FILES['k'][0]            a list (json_encode emits `[..]`)
//   a.b, 'a b'  -> $_FILES['a_b']             the base-name rule (dots/spaces -> _)
//   x[y][]      -> $_FILES['x']['y'][0]
// The old bespoke walk read the NEXT bracket key to pick the shape, so
// `post[image]` built `files.post = []` and the upload vanished: a valid form
// failed `required` (422) or the controller read null and 500'd (audit #848,
// #886).
test('upload: a bracketed file name nests like $_FILES (map, index, base-name rule)', () => {
  const req = uploadRequest([
    { name: 'post[title]', content: 't' },
    { name: 'post[image]', filename: 'a.txt', content: 'A' },
    { name: 'a[b][c]', filename: 'b.txt', content: 'B' },
    { name: 'k[0]', filename: 'c.txt', content: 'C' },
    { name: 'a.b', filename: 'd.txt', content: 'D' },
    { name: 'x[y][]', filename: 'e.txt', content: 'E' },
    { name: 'photos[]', filename: 'f.txt', content: 'F' },
  ]);
  assert.equal(req.hasFile('post.image'), true);
  assert.equal(req.file('post.image').getClientOriginalName(), 'a.txt');
  assert.equal(req.hasFile('a.b.c'), true);
  assert.equal(req.file('a.b.c').getClientOriginalName(), 'b.txt');
  // `k[0]` is a LIST: PHP's `$_FILES['k']` json_encodes as `[..]`.
  assert.deepEqual(
    req.file('k').map((f) => f.getClientOriginalName()),
    ['c.txt']
  );
  // A dot in the BASE name becomes `_`, so the dot gets its usual nested read.
  assert.equal(req.hasFile('a_b'), true);
  assert.equal(req.file('a_b').getClientOriginalName(), 'd.txt');
  assert.equal(req.file('x.y')[0].getClientOriginalName(), 'e.txt');
  assert.deepEqual(
    req.allFiles().photos.map((f) => f.getClientOriginalName()),
    ['f.txt']
  );
});

// InteractsWithInput::hasFile() (:218-236) is
// `array_any(array_wrap($this->file($key)), fn ($f) => $f instanceof SplFileInfo
// && $f->getPath() !== '')`: a MAP answers TRUE where its own values are files
// and FALSE where a further map sits in between. Probed on the live PHP 8.3
// server with `$_FILES['a']['b']['c']` + `$_FILES['post']['image']`:
//   hasFile('post') = true, hasFile('post.image') = true,
//   hasFile('a') = false,  hasFile('a.b') = true, hasFile('a.b.c') = true,
//   hasFile('k') = true,   hasFile('k.0') = true, hasFile('nope') = false
// The kernel called `isValid()` on whatever came back, so `hasFile('post')` for
// a nested file name THREW (audit #848).
test('upload: hasFile follows array_wrap + isValidFile over a nested name', () => {
  const req = uploadRequest([
    { name: 'post[image]', filename: 'a.txt', content: 'A' },
    { name: 'a[b][c]', filename: 'b.txt', content: 'B' },
    { name: 'k[0]', filename: 'c.txt', content: 'C' },
  ]);
  assert.equal(req.hasFile('post'), true);
  assert.equal(req.hasFile('post.image'), true);
  assert.equal(req.hasFile('a'), false);
  assert.equal(req.hasFile('a.b'), true);
  assert.equal(req.hasFile('a.b.c'), true);
  assert.equal(req.hasFile('k'), true);
  assert.equal(req.hasFile('k.0'), true);
  assert.equal(req.hasFile('nope'), false);
  // A field-only key is not a file.
  const fieldsOnly = uploadRequest([{ name: 'title', content: 't' }]);
  assert.equal(fieldsOnly.hasFile('title'), false);
});

// InteractsWithInput::all() (:87-105) merges the files into the input
// RECURSIVELY (`array_replace_recursive($input, $this->allFiles(), $input)`),
// and a replaced key keeps its ORIGINAL position. Probed on the live server:
//   all() = {"post":{"title":..,"image":..}, "a":.., "a_b":.., ..}
// The kernel's shallow union answered `post` = the input's own `{title}` only -
// the upload vanished from `all()`, so `Model::create($request->all())` and any
// echo of `all()` diverged (audit #849).
test('upload: all() merges the uploaded files into the input recursively', () => {
  const req = uploadRequest([
    { name: 'post[title]', content: 't' },
    { name: 'post[image]', filename: 'a.txt', content: 'A' },
    { name: 'zz', content: 'z' },
    { name: 'photos[]', filename: 'f.txt', content: 'F' },
  ]);
  const all = req.all();
  // The input's key first, then the file-only keys - PHP's array_replace_recursive.
  assert.deepEqual(Object.keys(all), ['post', 'zz', 'photos']);
  assert.deepEqual(Object.keys(all.post), ['title', 'image']);
  assert.equal(all.post.title, 't');
  assert.equal(all.post.image.getClientOriginalName(), 'a.txt');
  assert.equal(all.photos[0].getClientOriginalName(), 'f.txt');
  // `input()` itself stays the fields only.
  assert.deepEqual(req.input(), { post: { title: 't' }, zz: 'z' });
});

// A field called `__proto__` is ordinary DATA in PHP (`$_FILES['__proto__']`,
// and `$_FILES['x']['__proto__']` for `x[__proto__]` - probed on the live
// server). The file tree used a plain `out[key] = ..` walk, which SETS THE
// PROTOTYPE for that one name: the upload disappeared from `Object.keys()` and
// the returned object carried the wrong prototype (audit #887).
test('upload: a file named __proto__ stays data (no prototype write)', () => {
  const req = uploadRequest([
    { name: '__proto__', filename: 'p.txt', content: 'P' },
    { name: 'x[__proto__]', filename: 'q.txt', content: 'Q' },
  ]);
  assert.equal(Object.prototype.filename, undefined);
  const all = req.allFiles();
  assert.equal(Object.getPrototypeOf(all), Object.prototype);
  assert.deepEqual(Object.keys(all), ['__proto__', 'x']);
  // own-property read (a `all.__proto__` read would reach the prototype).
  assert.equal(Object.getOwnPropertyDescriptor(all, '__proto__').value.getClientOriginalName(), 'p.txt');
  assert.deepEqual(Object.keys(all.x), ['__proto__']);
  assert.equal(Object.getOwnPropertyDescriptor(all.x, '__proto__').value.getClientOriginalName(), 'q.txt');
});

test('upload: storeAs() writes the object and returns the disk-relative path', async () => {
  const storage = createStorage({});
  const req = uploadRequest(
    [{ name: 'avatar', filename: 'a.txt', type: 'text/plain', content: 'hello file' }],
    { storage, defaultDisk: 'local' }
  );
  const path = await req.file('avatar').storeAs('uploads', 'demo.txt');
  // FilesystemAdapter::putFileAs(): trim($path.'/'.$name, '/').
  assert.equal(path, 'uploads/demo.txt');
  assert.equal(await storage.getText('uploads/demo.txt'), 'hello file');
});

test('upload: store() uses a random name (Str::random(40)) + the extension', async () => {
  const storage = createStorage({});
  const req = uploadRequest(
    [{ name: 'avatar', filename: 'a.txt', type: 'text/plain', content: 'hello file' }],
    { storage, defaultDisk: 'local', randomString: (n) => 'a'.repeat(n) }
  );
  const path = await req.file('avatar').store('uploads');
  assert.equal(path, 'uploads/' + 'a'.repeat(40) + '.txt');
  assert.equal(await storage.getText(path), 'hello file');
});

test('upload: a named disk fails loud (the edge has one object store)', async () => {
  const storage = createStorage({});
  const req = uploadRequest(
    [{ name: 'avatar', filename: 'a.txt', type: 'text/plain', content: 'hello file' }],
    { storage, defaultDisk: 'local' }
  );
  await assert.rejects(
    () => req.file('avatar').storeAs('uploads', 'demo.txt', { disk: 'public' }),
    /named disk needs a bucket of its own/
  );
});

test('upload: without an object store the store fails loud', async () => {
  const req = uploadRequest(
    [{ name: 'avatar', filename: 'a.txt', type: 'text/plain', content: 'hello file' }],
    { defaultDisk: 'local' }
  );
  await assert.rejects(() => req.file('avatar').store('uploads'), /no object store/);
});

test('validation: the file rule needs an uploaded file', async () => {
  const req = uploadRequest([
    { name: 'avatar', filename: 'a.txt', type: 'text/plain', content: 'hello file' },
  ]);
  const v = new Validator(req.all(), { avatar: 'file' });
  assert.equal(await v.passes(), true);
  const bad = new Validator({ avatar: 'not a file' }, { avatar: 'file' });
  assert.equal(await bad.passes(), false);
  assert.deepEqual(bad.errors().avatar, ['The avatar field must be a file.']);
});

test('validation: the size rules of a file are in kilobytes (Laravel 13)', async () => {
  const req = uploadRequest([
    { name: 'avatar', filename: 'a.txt', type: 'text/plain', content: 'hello file' },
  ]);
  const data = req.all();
  // 10 bytes = 0.009765625 KB: a 1 KB limit passes, a 0 KB limit fails.
  assert.equal(await new Validator(data, { avatar: 'max:1' }).passes(), true);
  assert.equal(await new Validator(data, { avatar: 'min:1' }).passes(), false);
  const failed = new Validator(data, { avatar: 'max:0' });
  assert.equal(await failed.passes(), false);
  assert.deepEqual(failed.errors().avatar, ['The avatar field must not be greater than 0 kilobytes.']);
});

test('validation: `mimes`/`mimetypes` answer for sniffable image formats (a header read)', async () => {
  // PHP asks finfo for the file's CONTENT type; the edge sniffs the image
  // HEADER (kernel/image.mjs), so the rule answers for the formats that read
  // can name and fails loud for every other parameter.
  const png = uploadRequestBinary([
    { name: 'avatar', filename: 'a.png', type: 'image/png', bytes: PNG_BYTES },
  ]).file('avatar');
  const jpeg = uploadRequestBinary([
    { name: 'avatar', filename: 'a.jpg', type: 'image/jpeg', bytes: JPEG_BYTES },
  ]).file('avatar');
  const txt = uploadRequest([
    { name: 'avatar', filename: 'a.txt', type: 'text/plain', content: 'hello file' },
  ]).file('avatar');

  assert.equal(await new Validator({ avatar: png }, { avatar: 'mimes:png' }).passes(), true);
  assert.equal(await new Validator({ avatar: png }, { avatar: 'mimes:jpg,png' }).passes(), true);
  assert.equal(await new Validator({ avatar: png }, { avatar: 'mimes:jpg' }).passes(), false);
  // Laravel MERGES the two names: `ValidatesAttributes::validateMimes()`
  // (:1764-1766) adds 'jpg' AND 'jpeg' to the parameters as soon as either is
  // named, because Symfony's guessExtension() answers "jpg" for image/jpeg.
  // So `mimes:jpeg` accepts a real JPEG (audit #857 - the kernel used to reject
  // it, and the comment here claimed Laravel did too).
  assert.equal(await new Validator({ avatar: jpeg }, { avatar: 'mimes:jpeg' }).passes(), true);
  assert.equal(await new Validator({ avatar: jpeg }, { avatar: 'mimes:jpg' }).passes(), true);
  assert.equal(await new Validator({ avatar: jpeg }, { avatar: 'mimes:jpeg,png' }).passes(), true);
  assert.equal(await new Validator({ avatar: jpeg }, { avatar: 'mimes:png' }).passes(), false);
  assert.equal(await new Validator({ avatar: png }, { avatar: 'mimes:jpeg' }).passes(), false);
  assert.equal(
    await new Validator({ avatar: png }, { avatar: 'mimetypes:image/png' }).passes(),
    true
  );
  assert.equal(
    await new Validator({ avatar: png }, { avatar: 'mimetypes:image/jpeg' }).passes(),
    false
  );
  // finfo would answer text/plain for this one: not in the list.
  assert.equal(await new Validator({ avatar: txt }, { avatar: 'mimes:png,jpg' }).passes(), false);
  // A parameter the edge cannot answer stays loud (pdf content is not a header
  // the edge can recognise).
  assert.throws(() => new Validator({}, { avatar: 'mimes:pdf' }), /not compiled for "pdf"/);
  assert.throws(() => new Validator({}, { avatar: 'mimetypes:application/pdf' }), /not compiled for "application\/pdf"/);

  // `image` and `dimensions` are getimagesize(), a HEADER read the edge
  // reproduces (kernel/image.mjs) - they compile. An ABSENT field skips them
  // (Laravel only runs a non-required rule on a present value - a probe:
  // both PASS on an empty input), while a present non-image fails.
  assert.equal(await new Validator({}, { avatar: 'image' }).passes(), true);
  assert.equal(await new Validator({}, { avatar: 'dimensions:min_width=1' }).passes(), true);
  assert.equal(
    await new Validator({ avatar: 'not bytes' }, { avatar: 'image' }).passes(),
    false
  );
});

test('upload: the files are not flashed back into the form', () => {
  const req = uploadRequest([
    { name: 'title', content: 'Shadow upload' },
    { name: 'avatar', filename: 'a.txt', type: 'text/plain', content: 'hello file' },
  ]);
  const all = req.all();
  assert.equal(all.avatar.getSize(), 10);
  // RedirectResponse::removeFilesFromInput() drops the file values.
  for (const key of Object.keys(all)) {
    if (all[key] && all[key].__uploadedFile) delete all[key];
  }
  assert.equal('avatar' in all, false);
  assert.equal(all.title, 'Shadow upload');
});

test('upload: a file whose CONTENT contains the boundary is not truncated', () => {
  // PHP's rfc1867 parser (ext/standard/rfc1867.c): the delimiter is
  // CRLF + "--boundary" - the boundary bytes inside the file's content are
  // content, not a delimiter. The edge searched the bare bytes, so such a file
  // ended the part early.
  const content = `before --${BOUNDARY} after`;
  const req = uploadRequest([{ name: 'avatar', filename: 'a.txt', content }]);
  const file = req.file('avatar');
  assert.ok(file, 'the file is there');
  assert.equal(file.getSize(), content.length, 'the whole content is the file');
  assert.equal(new TextDecoder().decode(file.get()), content);
});
test('upload: a bracketed field name is a PHP nested array (rfc1867 -> php_register_variable_ex)', () => {
  // Measured on the PHP 8.3 SAPI: a multipart field named `a[b]` is
  // `$_POST['a']['b']` and `c[]=1&c[]=2` is the list ["1","2"] — the multipart
  // parser registers names through the same rule as parse_str(), not literally.
  const req = uploadRequest([
    { name: 'a[b]', content: 'v' },
    { name: 'c[]', content: '1' },
    { name: 'c[]', content: '2' },
    { name: 'plain', content: 'x' },
  ]);
  assert.equal(req.input('a.b'), 'v');
  assert.deepEqual(req.input('c'), ['1', '2']);
  assert.equal(req.input('plain'), 'x');
});

test('upload: a hostile field/file name never mutates Object.prototype', () => {
  // A key named `__proto__` is ordinary DATA in PHP; the JS writer must use
  // own-property writes (kernel/own-key.mjs) or Object.prototype is polluted
  // for the whole isolate.
  const baseline = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
  const cases = [
    [{ name: 'a[__proto__][polluted]', content: '1' }],
    [{ name: '__proto__[polluted]', content: '1' }],
    [{ name: 'a[constructor][prototype][polluted]', content: '1' }],
    [{ name: 'a[__proto__][x]', filename: 'f.txt', content: 'hi' }],
    [{ name: 'a[constructor][prototype][y]', filename: 'f.txt', content: 'hi' }],
    [{ name: '__proto__[z]', filename: 'f.txt', content: 'hi' }],
  ];
  for (const parts of cases) {
    const label = parts[0].name;
    const req = uploadRequest(parts);
    assert.equal(
      Object.getOwnPropertyNames(Object.prototype).sort().join(','),
      baseline,
      `Object.prototype mutated by ${label}`
    );
    assert.equal(Object.prototype.polluted, undefined, `polluted leaked from ${label}`);
    // The value stayed data: it is reachable through the request's bag.
    if (parts[0].filename === undefined) {
      assert.equal(JSON.stringify(req.all()).includes('"polluted"'), true, `${label} lost the value`);
    }
  }
  assert.equal(Object.prototype.z, undefined);
});
