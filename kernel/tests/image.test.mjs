// kernel/tests/image.test.mjs
//
// Covers kernel/image.mjs: byte-identical store/read through the storage
// handle, header-only dimension reads (what getimagesize() does for Laravel's
// `image` rule), and the loud refusal of resize/crop/convert/watermark.
//
// Fixtures are hand-built headers with the values baked in - no PHP runs at
// test time. Laravel ground truth:
//   - Storage::put() writes the bytes unchanged:
//     Illuminate/Filesystem/FilesystemAdapter::put()
//   - dimensions come from PHP's getimagesize():
//     Illuminate/Http/File::dimensions()
//   - the `image` validation rule is getimagesize() !== false:
//     Illuminate/Validation/Concerns/ValidatesAttributes::validateImage()
// So the contract under test is: same bytes in and out, dimensions read from
// the header, and no pretend-pixel-editing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { imageInfo, storeImage, readImage, resizeImage, cropImage, convertImage, watermarkImage } from '../image.mjs';

// --- fixture builders -------------------------------------------------------

// `flat(Infinity)` does NOT descend into a Uint8Array (it is not an Array), so
// a fixture that nests one would silently collapse to a single byte - the
// WebP builder nests its payload. Flatten both kinds.
const bytes = (...parts) => {
  const out = [];
  for (const part of parts.flat(Infinity)) {
    if (part instanceof Uint8Array) out.push(...part);
    else out.push(part);
  }
  return Uint8Array.from(out);
};

function u32be(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u32le(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function u16le(n) {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u16be(n) {
  return [(n >>> 8) & 0xff, n & 0xff];
}
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

// 24x16 PNG: signature + IHDR(length, "IHDR", width, height).
function png(width, height) {
  return bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, u32be(13), ascii('IHDR'), u32be(width), u32be(height), 8, 6, 0, 0, 0, [0, 0, 0, 0]);
}

// GIF89a, 3x2 (logical screen descriptor is little-endian).
function gif(width, height) {
  return bytes(ascii('GIF89a'), u16le(width), u16le(height), 0x00, 0x00, 0x00);
}

// SOI + SOF0: length 17, precision 8, height, width, 3 components.
function jpeg(width, height) {
  return bytes(
    0xff, 0xd8, // SOI
    0xff, 0xc0, u16be(17), 8, u16be(height), u16be(width),
    3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1
  );
}

// RIFF/WEBP + VP8X: canvas width-1 / height-1 stored as 24-bit LE.
function webpVp8x(width, height) {
  const payload = bytes([0, 0, 0, 0], [(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, ((width - 1) >> 16) & 0xff], [(height - 1) & 0xff, ((height - 1) >> 8) & 0xff, ((height - 1) >> 16) & 0xff]);
  const body = bytes(ascii('WEBP'), ascii('VP8X'), u32le(payload.length), payload);
  return bytes(ascii('RIFF'), u32le(body.length), body);
}

// BITMAPINFOHEADER: signed width at 18, signed height at 22.
function bmp(width, height) {
  const b = new Uint8Array(26);
  b[0] = 0x42; // 'B'
  b[1] = 0x4d; // 'M'
  b.set(u32le(26), 2); // file size
  b.set(u32le(40), 14); // DIB header size
  b.set(u32le(width >>> 0), 18);
  b.set(u32le(height >>> 0), 22);
  return b;
}

// ftyp brand "avif" followed by an ispe box (width/height big-endian).
function avif(width, height) {
  return bytes(
    u32be(24), ascii('ftyp'), ascii('avif'), u32be(0), ascii('mif1'), ascii('avif'),
    u32be(20), ascii('ispe'), u32be(0), u32be(width), u32be(height)
  );
}

// --- storage double ---------------------------------------------------------

function memoryStorage(initial = new Map()) {
  const puts = [];
  return {
    puts,
    files: initial,
    async put(key, value) {
      puts.push([key, value]);
      initial.set(key, value);
    },
    async getBytes(key) {
      if (!initial.has(key)) throw new Error('storage get: the file "' + key + '" does not exist');
      return initial.get(key);
    },
  };
}

// --- header parsing ---------------------------------------------------------

test('imageInfo reads PNG dimensions from IHDR', () => {
  assert.deepEqual(imageInfo(png(24, 16)), { format: 'png', mime: 'image/png', width: 24, height: 16 });
});

test('imageInfo reads JPEG dimensions from the first SOFn segment', () => {
  assert.deepEqual(imageInfo(jpeg(3, 2)), { format: 'jpeg', mime: 'image/jpeg', width: 3, height: 2 });
});

test('imageInfo reads GIF dimensions (little-endian screen descriptor)', () => {
  assert.deepEqual(imageInfo(gif(3, 2)), { format: 'gif', mime: 'image/gif', width: 3, height: 2 });
});

test('imageInfo reads WebP VP8X canvas dimensions', () => {
  assert.deepEqual(imageInfo(webpVp8x(640, 480)), { format: 'webp', mime: 'image/webp', width: 640, height: 480 });
});

test('imageInfo reads BMP dimensions and keeps top-down bitmaps positive', () => {
  assert.deepEqual(imageInfo(bmp(7, 9)), { format: 'bmp', mime: 'image/bmp', width: 7, height: 9 });
  // Negative height = top-down DIB; the dimension is the magnitude.
  const topDown = bmp(7, -9);
  assert.equal(imageInfo(topDown).height, 9);
});

test('imageInfo reads AVIF dimensions from the ispe box', () => {
  assert.deepEqual(imageInfo(avif(800, 600)), { format: 'avif', mime: 'image/avif', width: 800, height: 600 });
});

test('imageInfo returns null for bytes getimagesize() would reject', () => {
  assert.equal(imageInfo(bytes(ascii('not an image'))), null);
  assert.equal(imageInfo(new Uint8Array(0)), null);
  // A PNG signature with no IHDR is not a readable image.
  assert.equal(imageInfo(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), null);
});

test('imageInfo refuses non-byte input instead of guessing', () => {
  assert.throws(() => imageInfo('image/png'), /Uint8Array/);
});

// --- storeImage -------------------------------------------------------------

test('storeImage hands the exact bytes to storage.put and reports metadata', async () => {
  const data = png(24, 16);
  const storage = memoryStorage();

  const meta = await storeImage(storage, 'avatars/me.png', data);

  assert.equal(storage.puts.length, 1);
  assert.equal(storage.puts[0][0], 'avatars/me.png');
  assert.equal(storage.puts[0][1], data, 'the same buffer must reach the store, not a copy or a re-encode');
  assert.deepEqual(meta, { key: 'avatars/me.png', format: 'png', mime: 'image/png', width: 24, height: 16, size: data.length });
});

test('storeImage stores non-image bytes unchanged (put does not inspect content)', async () => {
  const data = bytes(ascii('hello'));
  const storage = memoryStorage();

  const meta = await storeImage(storage, 'notes/hello.txt', data);

  assert.equal(storage.puts[0][1], data);
  assert.deepEqual(meta, { key: 'notes/hello.txt', format: null, mime: null, width: null, height: null, size: 5 });
});

test('storeImage refuses a JS string: a PHP string is a byte array, a JS string is not', async () => {
  await assert.rejects(() => storeImage(memoryStorage(), 'a.png', 'png-bytes'), /Uint8Array/);
});

test('storeImage refuses a key that escapes the storage root', async () => {
  const storage = memoryStorage();
  await assert.rejects(() => storeImage(storage, '../../etc/passwd', png(1, 1)), /\.\./);
  assert.equal(storage.puts.length, 0, 'nothing may be written for a refused key');
});

// --- readImage --------------------------------------------------------------

test('readImage returns the stored bytes untouched plus header metadata', async () => {
  const data = jpeg(1200, 800);
  const storage = memoryStorage(new Map([['photos/cat.jpg', data]]));

  const img = await readImage(storage, 'photos/cat.jpg');

  assert.equal(img.bytes, data, 'bytes must come back as the stored buffer, not a re-encode');
  assert.deepEqual(img, { key: 'photos/cat.jpg', bytes: data, format: 'jpeg', mime: 'image/jpeg', width: 1200, height: 800 });
});

test('readImage fails loud on a non-image, naming getimagesize()', async () => {
  const storage = memoryStorage(new Map([['data.bin', bytes(1, 2, 3)]]));
  await assert.rejects(() => readImage(storage, 'data.bin'), /not an image[\s\S]*getimagesize\(\)/);
});

test('readImage propagates the storage miss (Laravel throws UnableToReadFile)', async () => {
  await assert.rejects(() => readImage(memoryStorage(), 'missing.png'), /does not exist/);
});

test('readImage refuses a storage handle without getBytes', async () => {
  await assert.rejects(() => readImage({}, 'a.png'), /getBytes/);
});

// --- refused raster operations ----------------------------------------------

for (const [name, fn, op] of [
  ['resizeImage', resizeImage, 'resize'],
  ['cropImage', cropImage, 'crop'],
  ['convertImage', convertImage, 'convert'],
  ['watermarkImage', watermarkImage, 'watermark'],
]) {
  test(name + ' refuses loudly and names the supported alternative', () => {
    assert.throws(
      () => fn(),
      (err) => {
        assert.match(err.message, new RegExp('image ' + op + ':'));
        assert.match(err.message, /GD and Imagick/);
        assert.match(err.message, /intervention\/image/);
        assert.match(err.message, /storeImage\(storage, key, bytes\)/);
        assert.match(err.message, /env\.IMAGES\.input|cdn-cgi\/image/);
        return true;
      }
    );
  });
}
