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

test('validation: a rule that reads the content type fails loud (mimes)', () => {
  assert.throws(
    () => new Validator({}, { avatar: 'mimes:png' }),
    /mimes validation rule is not compiled.*finfo/s
  );
  assert.throws(() => new Validator({}, { avatar: 'image' }), /not compiled/);
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
