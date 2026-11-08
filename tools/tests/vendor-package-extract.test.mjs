// tools/tests/vendor-package-extract.test.mjs — a package directory that EXISTS is a complete one.
//
// `provision()` in tools/vendor-lite.mjs resumes on `existsSync(pkgDir)`: an
// existing package directory means "installed, do not fetch it again". The old
// extraction copied entries straight into that directory, so an interrupted copy
// (a locked file on Windows, a full disk) left the directory behind and every
// later build silently skipped the package — a half-extracted vendor tree that
// stayed cached forever (#752). The extraction now unpacks into a sibling
// staging directory and swaps it in with one `renameSync`, which is the only
// mutation of the destination: either the directory is complete, or it is not
// there at all.
//
// The archive root is decided too: the old code took the FIRST top-level entry
// blindly, so a multi-root archive shipped only part of the package with no
// word, and an archive of bare files threw a confusing readdir error. Exactly
// one root directory is the shape every packagist/GitHub dist archive has;
// anything else is refused by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { extractPackageZip } from '../vendor-lite.mjs';

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

/** A minimal (deflate) zip, built here so the test needs no network and no `zip` binary. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data);
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, comp]);
    locals.push(local);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
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
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-pkg-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const write = (dir, name, buf) => writeFileSync(join(dir, name), buf);

test('a one-root package lands complete, staging gone, nested files intact', () => {
  withTmp((dir) => {
    const zip = join(dir, 'pkg.zip');
    write(dir, 'pkg.zip', makeZip([
      { name: 'name-1.0/composer.json', data: '{"name":"x/y"}' },
      { name: 'name-1.0/src/Deep/File.php', data: '<?php // deep' },
    ]));
    const dest = join(dir, 'vendor', 'x', 'y');
    extractPackageZip(zip, dest);
    assert.equal(readFileSync(join(dest, 'composer.json'), 'utf8'), '{"name":"x/y"}');
    assert.equal(readFileSync(join(dest, 'src', 'Deep', 'File.php'), 'utf8'), '<?php // deep');
    // No staging directory and no half-swapped leftovers next to it.
    assert.deepEqual(readdirSync(join(dir, 'vendor', 'x')), ['y']);
    assert.deepEqual(readdirSync(join(dir, 'vendor')), ['x']);
  });
});

test('an archive with two roots is refused by name, and leaves NO package directory', () => {
  withTmp((dir) => {
    write(dir, 'two.zip', makeZip([
      { name: 'one/a.txt', data: 'a' },
      { name: 'two/b.txt', data: 'b' },
    ]));
    const dest = join(dir, 'vendor', 'x', 'y');
    assert.throws(() => extractPackageZip(join(dir, 'two.zip'), dest), /two top-level entries \(one, two\)|expected exactly one root directory/);
    // The invariant the resume check depends on: a refused extraction must not
    // leave the directory the next build trusts.
    assert.deepEqual(readdirSync(join(dir, 'vendor', 'x')), []);
  });
});

test('a stale directory from an older run is replaced, never merged into', () => {
  withTmp((dir) => {
    write(dir, 'pkg.zip', makeZip([{ name: 'name-1.0/composer.json', data: '{}' }]));
    const dest = join(dir, 'vendor', 'x', 'y');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'left-from-a-partial-copy.txt'), 'stale');
    extractPackageZip(join(dir, 'pkg.zip'), dest);
    assert.deepEqual(readdirSync(dest), ['composer.json']);
  });
});

test('an archive of bare files (no root directory) lands as the package itself', () => {
  withTmp((dir) => {
    write(dir, 'flat.zip', makeZip([
      { name: 'composer.json', data: '{"name":"flat/pkg"}' },
      { name: 'LICENSE', data: 'MIT' },
    ]));
    const dest = join(dir, 'vendor', 'flat', 'pkg');
    extractPackageZip(join(dir, 'flat.zip'), dest);
    assert.deepEqual(readdirSync(dest).sort(), ['LICENSE', 'composer.json']);
    assert.equal(readFileSync(join(dest, 'composer.json'), 'utf8'), '{"name":"flat/pkg"}');
  });
});

test('files beside a directory are ambiguous, so they are refused rather than guessed', () => {
  withTmp((dir) => {
    write(dir, 'mixed.zip', makeZip([
      { name: 'composer.json', data: '{}' },
      { name: 'src/Thing.php', data: '<?php' },
    ]));
    const dest = join(dir, 'vendor', 'm', 'p');
    assert.throws(() => extractPackageZip(join(dir, 'mixed.zip'), dest), /expected exactly one root directory/);
    assert.deepEqual(readdirSync(join(dir, 'vendor', 'm')), []);
  });
});

test('an empty package root still installs as an empty package directory', () => {
  withTmp((dir) => {
    write(dir, 'empty.zip', makeZip([{ name: 'empty-1.0/', data: '' }]));
    const dest = join(dir, 'vendor', 'e', 'p');
    extractPackageZip(join(dir, 'empty.zip'), dest);
    // The resume check trusts the directory name ("exists = installed"), so an
    // empty root still has to land one: the swap used to run with no staging
    // source and threw ENOENT naming the temp path (#820).
    assert.deepEqual(readdirSync(dest), []);
    assert.deepEqual(readdirSync(join(dir, 'vendor', 'e')), ['p']);
  });
});
