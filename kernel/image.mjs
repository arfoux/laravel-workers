// kernel/image.mjs
//
// The image edge: store/read image BYTES, read their header, and refuse every
// pixel-editing operation loudly.
//
// WHAT THE EDGE CAN DO (and why it is byte-identical to Laravel):
//   Laravel never edits an image either. `Storage::put()` hands the bytes to
//   the filesystem driver unchanged (Illuminate/Filesystem/FilesystemAdapter
//   ::put()), and "image" metadata is PHP's getimagesize(), a HEADER read:
//   Illuminate/Http/File::dimensions() returns getimagesize(), and the `image`
//   validation rule is getimagesize() !== false
//   (Illuminate/Validation/Concerns/ValidatesAttributes::validateImage()).
//   So this module is two byte copies (through kernel/storage.mjs) plus a
//   header parse for PNG/JPEG/GIF/WebP/BMP/AVIF - no decoding, no pixels.
//
// WHAT THE EDGE CANNOT DO:
//   resize / crop / convert / watermark need GD or Imagick. Neither exists in
//   a Worker, and the app's vendor tree has no intervention/image (Laravel
//   itself ships no image manipulation). The dangerous failure mode is not an
//   exception, it is SILENCE: store the original, return success, and ship a
//   4000px photo where the app expected a 200px thumbnail. So these calls
//   throw, and the message names the two things that actually work:
//     1. Cloudflare Images at request time - env.IMAGES.input(stream)
//        .transform({ width, height, fit }).output(), or a
//        /cdn-cgi/image/<options>/<url> URL for a public object.
//     2. Resize before the upload, on the client / in the app that produced
//        the file, and store that result with storeImage().
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - No EXIF orientation handling (getimagesize() does not apply it either).
//   - No pixel/CRC validation: a truncated PNG with a readable IHDR is
//     accepted, exactly as getimagesize() would accept it.
//   - No format conversion of any kind; bytes in are bytes out.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// The HEIF/HEIC `ftyp` brands (ISO/IEC 23008-12 and the Apple/MPEG variants).
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

const MIME = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  avif: 'image/avif',
});

// Raster operations Laravel apps usually ask intervention/image for. Each one
// needs a pixel engine; each one is refused with the same escape hatch.
const RASTER_OPS = Object.freeze({
  resize: 'change the pixel dimensions',
  crop: 'cut a rectangle out of the pixels',
  convert: 're-encode the pixels in another format',
  watermark: 'draw pixels over the image',
});

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

function ascii(b, o, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

function startsWith(b, sig, o = 0) {
  if (b.length < o + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[o + i] !== sig[i]) return false;
  return true;
}

function pngSize(b) {
  // IHDR is the first chunk: length(4) "IHDR"(4) width(4) height(4).
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function gifSize(b) {
  if (b.length < 10) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

// Walk the JPEG marker segments until the first SOFn frame header. This is the
// same header walk getimagesize() performs; entropy-coded data (after SOS) is
// never touched.
function jpegSize(b) {
  let o = 2; // past SOI (FF D8)
  while (o + 3 < b.length) {
    if (b[o] !== 0xff) return null;
    let marker = b[o + 1];
    while (marker === 0xff && o + 2 < b.length) {
      o++;
      marker = b[o + 1];
    }
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    if (marker === 0xd9) return null; // EOI before any frame header
    if (marker === 0xda) return null; // SOS before any frame header
    const len = u16be(b, o + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // payload: precision(1) height(2) width(2) components(1) ...
      if (o + 9 >= b.length) return null;
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    o += 2 + len;
  }
  return null;
}

function webpSize(b) {
  const kind = ascii(b, 12, 4);
  if (kind === 'VP8X') {
    // The chunk header is at 12 ("VP8X"), its size at 16, and the payload at
    // 20: flags/reserved(4), canvas-width-1(3, LE), canvas-height-1(3, LE).
    // So the width starts at 24 and the height at 27 (an RFC 9649 chunk).
    if (b.length < 30) return null;
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  if (kind === 'VP8 ') {
    // payload: frame tag(3) start code 9D 01 2A(3) width(2, LE, 14 bits) height(2, LE, 14 bits)
    if (b.length < 30) return null;
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    // payload: signature 0x2F(1) then 14-bit width-1 / 14-bit height-1, LE bits.
    if (b.length < 25) return null;
    if (b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function bmpSize(b) {
  // BITMAPINFOHEADER: width(4, LE, signed) at 18, height(4, LE, signed) at 22.
  // A negative height means a top-down bitmap; the dimension is its magnitude.
  if (b.length < 26) return null;
  const width = i32le(b, 18);
  const height = i32le(b, 22);
  return { width: Math.abs(width), height: Math.abs(height) };
}

function avifSize(b) {
  // ISOBMFF: the ispe box holds width(4, BE) height(4, BE) after size+type+flags.
  const at = indexOfAscii(b, 'ispe', 12);
  if (at < 0 || at + 16 > b.length) return null;
  return { width: u32be(b, at + 8), height: u32be(b, at + 12) };
}

function indexOfAscii(b, needle, from) {
  const first = needle.charCodeAt(0);
  for (let i = from; i + needle.length <= b.length; i++) {
    if (b[i] !== first) continue;
    let hit = true;
    for (let j = 1; j < needle.length; j++) {
      if (b[i + j] !== needle.charCodeAt(j)) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/**
 * Read an image header. Returns { format, mime, width, height } or null when
 * the bytes are not an image getimagesize() would recognise.
 *
 * Pure: reads the buffer, never copies or decodes it.
 */
export function imageInfo(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('imageInfo: bytes must be a Uint8Array');
  }

  let format = null;
  let size = null;

  if (startsWith(bytes, PNG_SIGNATURE)) {
    format = 'png';
    size = pngSize(bytes);
  } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    format = 'jpeg';
    size = jpegSize(bytes);
  } else if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
    format = 'gif';
    size = gifSize(bytes);
  } else if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    format = 'webp';
    size = webpSize(bytes);
  } else if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    format = 'bmp';
    size = bmpSize(bytes);
  } else if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    // The ISOBMFF family: AVIF and HEIC/HEIF share the container, and the
    // `ftyp` brand is what tells them apart. getimagesize() on PHP 8.3
    // answers AVIF; HEIC/HEIF are in Laravel's own `image` list
    // (ValidatesAttributes::validateImage(), :1539-1548), so the edge must
    // recognise them too instead of answering "not an image".
    if (brand === 'avif' || brand === 'avis') {
      format = 'avif';
      size = avifSize(bytes);
    } else if (HEIC_BRANDS.has(brand)) {
      format = brand === 'heic' || brand === 'heix' || brand === 'heim' || brand === 'heis' ? 'heic' : 'heif';
      // The canvas lives in the same ispe box; a file whose box is not there
      // still IS an image, so the size stays null and the caller decides.
      size = avifSize(bytes) || { width: null, height: null };
    }
  }

  if (format === null || size === null) return null;
  // A container image whose `ispe` box is absent is still an image (the
  // `image` rule only asks whether it IS one); its dimensions are unknown.
  return { format, mime: MIME[format], width: size.width, height: size.height };
}

function assertKey(key, fn) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError(fn + ': key must be a non-empty storage path string');
  }
  const segments = key.split('/');
  if (segments.includes('..')) {
    throw new Error(
      fn + ': the key "' + key + '" contains ".." and would escape the storage root ' +
        '(Flysystem rejects traversal instead of resolving it)'
    );
  }
}

function assertBytes(bytes, fn) {
  if (bytes instanceof Uint8Array) return bytes;
  throw new TypeError(
    fn + ': bytes must be a Uint8Array (a PHP string is a byte array; a JS string is not - ' +
      'read the file with storage.getBytes() or fs.readFile(), not as text)'
  );
}

/**
 * Store image bytes at `key`. The bytes are handed to the storage layer
 * unchanged, exactly like Illuminate\Filesystem\FilesystemAdapter::put().
 *
 * Returns the stored metadata: { key, format, mime, width, height, size }.
 * format/mime/width/height are null when the bytes are not a recognised
 * image - put() does not inspect content, and Laravel's `image` rule is where
 * getimagesize() gates the upload.
 */
export async function storeImage(storage, key, bytes) {
  if (!storage || typeof storage.put !== 'function') {
    throw new TypeError('storeImage: storage must be the handle from kernel/storage.mjs (put)');
  }
  assertKey(key, 'storeImage');
  const data = assertBytes(bytes, 'storeImage');
  const info = imageInfo(data);
  await storage.put(key, data);
  return {
    key,
    format: info === null ? null : info.format,
    mime: info === null ? null : info.mime,
    width: info === null ? null : info.width,
    height: info === null ? null : info.height,
    size: data.length,
  };
}

/**
 * Read image bytes at `key` plus their header metadata.
 *
 * Bytes come back untouched (the storage layer already owns the buffer), which
 * is the point: PHP hands the app a byte array, so re-encoding here would be a
 * silent corruption. A key that is not an image fails loud - the same bytes
 * would fail getimagesize(), i.e. Laravel's `image` rule.
 *
 * Returns { key, bytes, format, mime, width, height }.
 */
export async function readImage(storage, key) {
  if (!storage || typeof storage.getBytes !== 'function') {
    throw new TypeError('readImage: storage must be the handle from kernel/storage.mjs (getBytes)');
  }
  assertKey(key, 'readImage');
  const bytes = await storage.getBytes(key);
  if (bytes === null || bytes === undefined) {
    throw new Error('readImage: storage returned no bytes for "' + key + '"');
  }
  const data = assertBytes(bytes, 'readImage');
  const info = imageInfo(data);
  if (info === null) {
    throw new Error(
      'readImage: the file "' + key + '" is not an image - getimagesize() cannot read its header, ' +
        'so Laravel\'s `image` validation rule rejects it too; use storage.getBytes() for non-image files'
    );
  }
  return { key, bytes: data, format: info.format, mime: info.mime, width: info.width, height: info.height };
}

function refuseRasterOp(op) {
  throw new Error(
    'image ' + op + ': the edge cannot ' + RASTER_OPS[op] + ' - PHP\'s GD and Imagick extensions do ' +
      'not exist in a Cloudflare Worker, and the app\'s vendor tree has no intervention/image ' +
      '(Laravel ships no image manipulation of its own). Storing the original and reporting success ' +
      'would hand the app the wrong bytes. Do one of: (1) store the original with ' +
      'storeImage(storage, key, bytes) and produce the variant at request time with Cloudflare ' +
      'Images - env.IMAGES.input(stream).transform({ width, height, fit }).output(), or a ' +
      '/cdn-cgi/image/<options>/<url> URL for a public object; (2) ' + op + ' before the upload, on ' +
      'the client or in the service that produced the file, and store that result.'
  );
}

/** Refused: needs a pixel engine (see the module header). */
export function resizeImage() {
  refuseRasterOp('resize');
}

/** Refused: needs a pixel engine (see the module header). */
export function cropImage() {
  refuseRasterOp('crop');
}

/** Refused: needs a pixel engine (see the module header). */
export function convertImage() {
  refuseRasterOp('convert');
}

/** Refused: needs a pixel engine (see the module header). */
export function watermarkImage() {
  refuseRasterOp('watermark');
}
