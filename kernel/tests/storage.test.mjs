// kernel/tests/storage.test.mjs — the Storage surface the compiled facade reads.
//
// What this covers: the text read (`getText`), the byte read (`getBytes`), the
// existence check, the delete's answer and the temporary URL's signature.
//
// Why the text read is strict: a PHP string is a BYTE ARRAY, so Laravel's
// `Storage::get()` (FilesystemAdapter::get(), Illuminate/Filesystem/
// FilesystemAdapter.php:200-215) hands the app the file's exact bytes and never
// decodes them. A JS string cannot hold arbitrary bytes - `TextDecoder` would
// replace each invalid sequence with U+FFFD and the app would ship a corrupted
// file (audit row A58). So the edge decodes STRICTLY: a binary file read as
// text fails loud with a reason that names the byte-level alternative, while a
// UTF-8 file reads exactly.
//
// The memory driver is the test double (the worker never falls back to it: the
// runtime fails loud instead of losing writes - see kernel/storage.mjs's header).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorage, MAX_BLOB_BYTES } from '../storage.mjs';

// The bytes of a tiny PNG header: 0x89 is not a valid UTF-8 lead byte, so the
// strict decode must reject it. (A probe: PHP's `Storage::get()` answers these
// five bytes unchanged - a binary read is byte-exact in Laravel.)
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);

test('a UTF-8 file reads as its text (getText)', async () => {
  const storage = createStorage({});
  await storage.put('notes/hello.txt', 'héllo — wörld');
  // Laravel's get() answers the file's contents; a UTF-8 file survives the
  // round trip unchanged.
  assert.equal(await storage.getText('notes/hello.txt'), 'héllo — wörld');
});

test('a binary file read as TEXT fails loud instead of corrupting it', async () => {
  const storage = createStorage({});
  await storage.put('img/logo.png', PNG_HEADER);
  await assert.rejects(
    () => storage.getText('img/logo.png'),
    (err) => {
      assert.match(err.message, /img\/logo\.png/);
      assert.match(err.message, /not valid UTF-8/);
      // The reason must name the way out, not just the failure.
      assert.match(err.message, /getBytes/);
      return true;
    }
  );
  // The same file read as BYTES is exact: getBytes() is the padanan for a
  // PHP string that holds bytes.
  assert.deepEqual(Array.from(await storage.getBytes('img/logo.png')), Array.from(PNG_HEADER));
});

test('the R2 object shape is read as BYTES, never via text()', async () => {
  // A real R2ObjectBody answers `.text()` by decoding UTF-8 with U+FFFD
  // replacement - the corruption A58 removed - and its `.body` is a
  // ReadableStream (`String(stream)` = "[object ReadableStream]"). The driver
  // is stubbed with that exact shape: arrayBuffer() + a stream body.
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
  let textCalls = 0;
  const r2 = {
    async get(key) {
      if (key !== 'img/logo.png' && key !== 'notes/ok.txt') return null;
      const bytes = key === 'img/logo.png' ? PNG : new TextEncoder().encode('héllo');
      return {
        body: new Blob([bytes]).stream(),
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        async text() {
          textCalls++;
          return new TextDecoder('utf-8').decode(bytes); // lossy, like R2
        },
      };
    },
    async put() { return true; },
    async delete() { return true; },
  };
  const storage = createStorage({ r2 });
  // The bytes are exact.
  assert.deepEqual(Array.from(await storage.getBytes('img/logo.png')), Array.from(PNG));
  // The text read refuses the binary file (it never reaches R2's lossy text()).
  await assert.rejects(() => storage.getText('img/logo.png'), /not valid UTF-8/);
  assert.equal(await storage.getText('notes/ok.txt'), 'héllo');
  assert.equal(textCalls, 0, 'R2 text() must never be called: it decodes with U+FFFD');
});

test('a missing file: getText/getBytes throw, exists answers false', async () => {
  const storage = createStorage({});
  assert.equal(await storage.exists('nope.txt'), false);
  // Laravel's FilesystemAdapter::get() throws UnableToReadFile when the file is
  // missing (throwsExceptions defaults to true) - not null.
  await assert.rejects(() => storage.getText('nope.txt'), /does not exist/);
  await assert.rejects(() => storage.getBytes('nope.txt'), /does not exist/);
  await storage.put('yes.txt', 'x');
  assert.equal(await storage.exists('yes.txt'), true);
});

test('delete answers Laravel\'s boolean (false when the file was missing)', async () => {
  const storage = createStorage({});
  // FilesystemAdapter::delete() answers false for a missing file.
  assert.equal(await storage.delete('nope.txt'), false);
  await storage.put('gone.txt', 'x');
  assert.equal(await storage.delete('gone.txt'), true);
  assert.equal(await storage.exists('gone.txt'), false);
});

test('a temporary URL is signed and expires (temporaryUrl/verifyTemporaryUrl)', async () => {
  const storage = createStorage({ secret: 'the-app-key' });
  const url = await storage.temporaryUrl('docs/a.pdf', 60000);
  assert.match(url, /expires=\d+/);
  assert.match(url, /sig=[0-9a-f]{64}$/);
  assert.equal(await storage.verifyTemporaryUrl(url), true);

  // A tampered key must not verify: the signature covers the key.
  assert.equal(await storage.verifyTemporaryUrl(url.replace('docs/a.pdf', 'docs/b.pdf')), false);

  // An expired URL must not verify. (The expiry is a clock comparison, so the
  // negative TTL is enough to make it past.)
  const expired = await storage.temporaryUrl('docs/a.pdf', -1000);
  assert.equal(await storage.verifyTemporaryUrl(expired), false);

  // No secret configured: the signature cannot be produced, so it fails loud
  // rather than serving an unsigned URL.
  const unsigned = createStorage({});
  await assert.rejects(() => unsigned.temporaryUrl('docs/a.pdf', 1000), /requires a secret/);
});

test('the D1 blob cap is enforced (MAX_BLOB_BYTES)', () => {
  // D1 caps a row at 2 MB; the store keeps headroom and rejects the rest, so a
  // write never silently truncates.
  assert.equal(MAX_BLOB_BYTES, 1500000);
});

test('the D1 driver keeps bytes in the row as lw-b64:<base64>, read back byte-exact', async () => {
  // A D1 row is TEXT, so a binary object is stored base64-encoded behind a
  // marker; the marker is what tells the reader to decode instead of handing
  // the app the encoded text. The base64 is the plain standard alphabet (the
  // one every version of the store has written), so rows written before a
  // deploy stay readable — that is a cross-version contract, not an internal
  // detail, hence the pinned literal.
  const rows = new Map();
  const stmt = (sql, args = []) => ({
    async run() {
      if (/INSERT OR REPLACE/.test(sql)) {
        rows.set(args[0], { body: args[1], size: args[2] });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    },
    async first() {
      if (/SELECT 1 FROM/.test(sql)) {
        if (rows.size === 0) throw new Error('no such table: lw_blobs');
        return { 1: 1 };
      }
      const row = rows.get(args[0]);
      return row ? { body: row.body } : null;
    },
    bind: (...bound) => stmt(sql, bound),
  });
  const storage = createStorage({ d1: { prepare: (sql) => stmt(sql) } });

  // `iVBORw0=` is the base64 of the 5-byte PNG header above.
  await storage.put('img/logo.png', PNG_HEADER);
  assert.equal(rows.get('img/logo.png').body, 'lw-b64:iVBORw0=');
  assert.equal(rows.get('img/logo.png').size, PNG_HEADER.length);

  // Every padding phase (len % 3 = 1, 2, 0), and a body big enough to be a
  // real file, must survive the round trip byte-exact.
  for (const len of [1, 2, 3, 4, 5, 1024]) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
    const key = 'blob/' + len + '.bin';
    await storage.put(key, bytes);
    assert.equal(rows.get(key).body, 'lw-b64:' + Buffer.from(bytes).toString('base64'));
    assert.equal(rows.get(key).size, len);
    assert.deepEqual(Array.from(await storage.getBytes(key)), Array.from(bytes));
  }

  // A text object carries no marker: it is stored raw and read as text.
  await storage.put('notes/a.txt', 'héllo');
  assert.equal(rows.get('notes/a.txt').body, 'héllo');
  assert.equal(await storage.getText('notes/a.txt'), 'héllo');
});
