// kernel/tests/multipart.test.mjs — direct coverage of the multipart/form-data
// parser: names go through the SAME PHP bag rule as query strings, and uploaded
// bytes stay bytes. The body is built here from raw bytes, no external binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMultipart } from '../multipart.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

function buildMultipart(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(
      enc.encode(`--${boundary}\r\n${part.head.join('\r\n')}\r\n\r\n`)
    );
    chunks.push(part.body);
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  return body;
}

function disposition(name, filename, mime) {
  let cd = `Content-Disposition: form-data; name="${name}"`;
  if (filename !== undefined) cd += `; filename="${filename}"`;
  const head = [cd];
  if (mime !== undefined) head.push(`Content-Type: ${mime}`);
  return head;
}

const boundary = '----lwMultipartProbe';
const contentType = `multipart/form-data; boundary="${boundary}"`;

test('parseMultipart shapes post[image] as a nested file map', () => {
  const body = buildMultipart(boundary, [
    { head: disposition('post[image]', 'pic.png', 'image/png'), body: enc.encode('PNGDATA') },
  ]);
  const { files, fields } = parseMultipart(body, contentType);
  assert.deepEqual(Object.keys(fields), []);
  assert.deepEqual(Object.keys(files), ['post']);
  assert.deepEqual(Object.keys(files.post), ['image']);
  const file = files.post.image;
  assert.equal(file.name, 'post[image]');
  assert.equal(file.filename, 'pic.png');
  assert.equal(file.mime, 'image/png');
  assert.equal(file.size, 7);
  assert.deepEqual(file.bytes, enc.encode('PNGDATA'));
  assert.equal(file.__part, true);
});

test('parseMultipart appends photos[] uploads into a list', () => {
  const body = buildMultipart(boundary, [
    { head: disposition('photos[]', 'one.txt', 'text/plain'), body: enc.encode('ONE') },
    { head: disposition('photos[]', 'two.txt', 'text/plain'), body: enc.encode('TWO') },
  ]);
  const { files } = parseMultipart(body, contentType);
  assert.ok(Array.isArray(files.photos));
  assert.equal(files.photos.length, 2);
  assert.deepEqual(files.photos.map((f) => f.filename), ['one.txt', 'two.txt']);
  assert.deepEqual(files.photos.map((f) => dec.decode(f.bytes)), ['ONE', 'TWO']);
  assert.deepEqual(files.photos.map((f) => f.size), [3, 3]);
});

test('parseMultipart shapes field names with dots and brackets like parse_str()', () => {
  const body = buildMultipart(boundary, [
    { head: disposition('a.b'), body: enc.encode('dot-value') },
    { head: disposition('user[name]'), body: enc.encode('Ada') },
    { head: disposition('c[]'), body: enc.encode('1') },
    { head: disposition('c[]'), body: enc.encode('2') },
  ]);
  const { fields, files } = parseMultipart(body, contentType);
  assert.deepEqual(Object.keys(files), []);
  assert.deepEqual(JSON.parse(JSON.stringify(fields)), {
    a_b: 'dot-value',
    user: { name: 'Ada' },
    c: ['1', '2'],
  });
});

test('parseMultipart keeps raw file bytes even when they contain the boundary bytes', () => {
  // The delimiter is CRLF + "--boundary"; a bare "--boundary" inside a file is
  // content, not the end of the part.
  const inner = enc.encode(`BIN--${boundary}MORE`);
  const body = buildMultipart(boundary, [
    { head: disposition('f', 'b.bin', 'application/octet-stream'), body: inner },
  ]);
  const { files } = parseMultipart(body, contentType);
  assert.deepEqual(files.f.bytes, inner);
  assert.equal(files.f.size, inner.length);
  assert.equal(dec.decode(files.f.bytes), `BIN--${boundary}MORE`);
});

test('parseMultipart writes untrusted names as own data, without prototype pollution', () => {
  const body = buildMultipart(boundary, [
    { head: disposition('x[__proto__][p]'), body: enc.encode('4') },
    { head: disposition('toString'), body: enc.encode('safe') },
  ]);
  const { fields } = parseMultipart(body, contentType);
  assert.equal(Object.getPrototypeOf(fields.x), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(fields.x, '__proto__'), true);
  assert.equal(fields.x.__proto__.p, '4');
  assert.equal(fields.toString, 'safe');
  assert.equal(({}).p, undefined);
  assert.equal(typeof ({}).toString, 'function');
});

test('parseMultipart rejects malformed input instead of guessing', () => {
  assert.throws(() => parseMultipart('not bytes', contentType), /must be the raw bytes/);
  const body = buildMultipart(boundary, [{ head: disposition('a'), body: enc.encode('1') }]);
  assert.throws(() => parseMultipart(body, 'multipart/form-data'), /boundary is missing/);
  assert.throws(() => parseMultipart(enc.encode('no delimiter here'), contentType), /no boundary/);
});
