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

test('validation: `mimes` fails loud, `image`/`dimensions` compile (a header read)', async () => {
  // `mimes` compares the type finfo SNIFFS the content for, and the edge has
  // only the type the browser declared - so the build refuses it.
  assert.throws(
    () => new Validator({}, { avatar: 'mimes:png' }),
    /mimes validation rule is not compiled.*finfo/s
  );
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
