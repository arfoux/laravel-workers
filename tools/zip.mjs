// tools/zip.mjs — a minimal ZIP reader, so provisioning never depends on an
// external `unzip`.
//
// WHY: `vendor-lite` and `php-provision` used to shell out to `unzip` with no
// fallback. On a clean Windows box (no Git-Bash/MSYS/7-Zip) that binary does
// not exist, so provisioning a PHP interpreter or a vendor tree failed with
// `spawnSync unzip ENOENT` - while every other tool in this package is pure
// JavaScript on purpose. The reader keeps that property: Node's own
// `zlib.inflateRawSync` does the work.
//
// WHAT IT COVERS: the shapes these two callers actually download (a GitHub
// zipball and the windows.php.net PHP zip): STORE (0) and DEFLATE (8) entries,
// directories, and the sizes read from the CENTRAL DIRECTORY (a streamed zip
// leaves the local header sizes at 0 - the data descriptor - so they must not
// be trusted). Anything else (ZIP64, encryption, other compression methods)
// throws, and the caller may fall back to the system `unzip`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Find the End Of Central Directory record (it ends the file, + a comment). */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    // A stray 0x06054b50 inside a file name or a comment would otherwise
    // pass for the record: the candidate must describe an archive that ENDS
    // here (22 fixed bytes + its comment) and lives on a single disk with
    // every entry in the central directory (offsets 4/6/8/10).
    if (i + 22 > buf.length) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen !== buf.length) continue;
    const disk = buf.readUInt16LE(i + 4);
    const cdDisk = buf.readUInt16LE(i + 6);
    const entriesDisk = buf.readUInt16LE(i + 8);
    const entriesTotal = buf.readUInt16LE(i + 10);
    if (disk !== 0 || cdDisk !== 0 || entriesDisk !== entriesTotal) continue;
    return i;
  }
  return -1;
}

/**
 * Extract `zipPath` into `destDir`.
 * @returns {{files: number, dirs: number}}
 */
export function extractZip(zipPath, destDir) {
  const buf = readFileSync(zipPath);
  const eocd = findEocd(buf);
  if (eocd === -1) throw new Error(`zip: not a zip file (no end-of-central-directory): ${zipPath}`);

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error('zip: ZIP64 archives are not supported by the built-in reader');
  }

  const realDest = resolve(destDir);
  let at = cdOffset;
  let files = 0;
  let dirs = 0;

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== CD_SIG) throw new Error('zip: corrupt central directory');
    const method = buf.readUInt16LE(at + 10);
    const compSize = buf.readUInt32LE(at + 20);
    const uncompSize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const flags = buf.readUInt16LE(at + 8);
    at += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error(`zip: encrypted entry "${name}" is not supported`);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('zip: ZIP64 entry is not supported by the built-in reader');
    }

    // Zip Slip: an entry may not escape the destination (a `..` segment or an
    // absolute path would otherwise write anywhere).
    const target = resolve(join(realDest, name));
    if (target !== realDest && !target.startsWith(realDest + sep)) {
      throw new Error(`zip: entry "${name}" escapes the destination directory`);
    }
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true });
      dirs++;
      continue;
    }

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`zip: corrupt local header for "${name}"`);
    // The LOCAL header carries its own name/extra lengths (they may differ from
    // the central directory's), so the data offset is computed from them.
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    let data;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(`zip: compression method ${method} is not supported ("${name}")`);
    }
    if (uncompSize !== 0 && data.length !== uncompSize) {
      throw new Error(`zip: "${name}" inflated to ${data.length} bytes, the directory says ${uncompSize}`);
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    files++;
  }

  return { files, dirs };
}

export default { extractZip };
