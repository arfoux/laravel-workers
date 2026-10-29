// tools/tests/zip.test.mjs — the built-in ZIP reader the provisioning relies on.
//
// WHY THIS EXISTS: `vendor-lite` and `php-provision` download real composer
// dist zips and the windows.php.net interpreter zip and now extract them in
// process (a clean Windows box has no `unzip`). The reader has to get the
// boring cases right (nested directories, empty and binary files) and refuse
// the ones it does not implement (ZIP64, encrypted entries, another compression
// method) loudly, because a wrong byte here becomes an executed PHP file. The
// fixtures are built here with zlib so the test does not depend on the network
// or on an external `zip` binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { extractZip } from '../zip.mjs';

const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a zip by hand so the test can produce shapes a library would not
 * (STORE method, streamed entry with a data descriptor, a hostile name).
 */
function makeZip(entries, opts = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data);
    const comp = e.store ? data : deflateRawSync(data);
    const method = e.store ? 0 : 8;
    const crc = crc32(data);
    const streamed = !!e.descriptor;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(streamed ? 8 : 0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(streamed ? 0 : crc, 14);
    lh.writeUInt32LE(streamed ? 0 : comp.length, 18);
    lh.writeUInt32LE(streamed ? 0 : data.length, 22);
    lh.writeUInt16LE(name.length, 26);

    const parts = [lh, name, comp];
    if (streamed) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc, 4);
      d.writeUInt32LE(comp.length, 8);
      d.writeUInt32LE(data.length, 12);
      parts.push(d);
    }
    const local = Buffer.concat(parts);
    locals.push(local);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(streamed ? 8 : 0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'lw-ziptest-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
function tree(dir, base = '') {
  let acc = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) acc = acc.concat(tree(p, `${base}${e.name}/`));
    else acc.push(`${base}${e.name}`);
  }
  return acc.sort();
}

test('extracts nested, empty and binary entries byte for byte (DEFLATE and STORE)', () => {
  const { dir, done } = sandbox();
  try {
    const binary = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256));
    const zipPath = join(dir, 'a.zip');
    writeFileSync(
      zipPath,
      makeZip([
        { name: 'pkg/composer.json', data: '{"name":"psr/log"}\n' },
        { name: 'pkg/src/LoggerInterface.php', data: '<?php\ninterface LoggerInterface {}\n' },
        { name: 'pkg/empty.txt', data: '' },
        { name: 'pkg/bin/data.bin', data: binary, store: true },
      ])
    );
    // Expected bytes live outside the destination so they are compared, not copied.
    const want = join(dir, 'want');
    mkdirSync(join(want, 'pkg/src'), { recursive: true });
    mkdirSync(join(want, 'pkg/bin'), { recursive: true });
    writeFileSync(join(want, 'pkg/composer.json'), '{"name":"psr/log"}\n');
    writeFileSync(join(want, 'pkg/src/LoggerInterface.php'), '<?php\ninterface LoggerInterface {}\n');
    writeFileSync(join(want, 'pkg/empty.txt'), '');
    writeFileSync(join(want, 'pkg/bin/data.bin'), binary);

    const out = join(dir, 'out');
    const stats = extractZip(zipPath, out);
    assert.equal(stats.files, 4);
    assert.deepEqual(tree(out), tree(want));
    for (const rel of tree(want)) assert.equal(sha(join(out, rel)), sha(join(want, rel)), rel);
  } finally {
    done();
  }
});

test('reads sizes from the central directory for a streamed (data descriptor) entry', () => {
  const { dir, done } = sandbox();
  try {
    const zipPath = join(dir, 'd.zip');
    writeFileSync(zipPath, makeZip([{ name: 's.txt', data: 'streamed\n', descriptor: true }]));
    const out = join(dir, 'out');
    extractZip(zipPath, out);
    assert.equal(readFileSync(join(out, 's.txt'), 'utf8'), 'streamed\n');
  } finally {
    done();
  }
});

test('refuses an entry that escapes the destination (Zip Slip)', () => {
  const { dir, done } = sandbox();
  try {
    const zipPath = join(dir, 'slip.zip');
    writeFileSync(zipPath, makeZip([{ name: '../../evil.txt', data: 'pwned' }]));
    const out = join(dir, 'out');
    assert.throws(() => extractZip(zipPath, out), /escapes the destination/);
    assert.equal(readdirSync(dir).includes('evil.txt'), false);
  } finally {
    done();
  }
});

test('refuses ZIP64 and non-zip input instead of extracting something wrong', () => {
  const { dir, done } = sandbox();
  try {
    const z64 = join(dir, 'z64.zip');
    writeFileSync(z64, makeZip([{ name: 'a.txt', data: 'x' }], { zip64: true }));
    assert.throws(() => extractZip(z64, join(dir, 'o1')), /ZIP64/);

    const junk = join(dir, 'junk.zip');
    writeFileSync(junk, Buffer.from('this is not a zip file at all'));
    assert.throws(() => extractZip(junk, join(dir, 'o2')), /not a zip file/);
  } finally {
    done();
  }
});
