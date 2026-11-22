// tools/path-safety.mjs — guard primitives shared by the snapshot-name and
// port-slug validators. Both guards face the same operator-supplied strings and
// the same Windows path rules, so the checks live once instead of drifting.

import { lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// Windows resolves these to devices even when a file extension is appended, and
// it strips trailing dots/spaces before comparing the name. `CONIN$`/`CONOUT$`
// and the superscript digits of COM¹…COM³ are real aliases too.
const WINDOWS_DEVICE_RE =
  /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CLOCK\$|CONIN\$|CONOUT\$)(?:\.|$)/i;

/**
 * Why `value` is unsafe as a relative output name (segments joined by "/"), or
 * null when it is safe. Callers add their own prefix/absolute-path rules and
 * turn the reason into their own operator-facing error.
 */
export function unsafeNameReason(value) {
  const text = String(value);
  if (text.includes('\\')) return 'backslash separators are not allowed (use "/")';
  if (/^[A-Za-z]:/.test(text)) return 'drive-letter paths are not allowed';
  // NUL bytes, newlines and C0/C1 controls are invalid in file names at best;
  // at worst they truncate a generated string or a native path.
  if (/[\u0000-\u001F\u007F-\u009F]/.test(text)) return 'control characters are not allowed';
  if (text.includes(':')) return '":" is not allowed (Windows alternate data streams and device paths)';
  if (/%2e|%2f|%5c/i.test(text)) return 'percent-encoded dots or separators are not allowed';
  for (const segment of text.split('/')) {
    if (segment === '') return 'empty path segments are not allowed';
    if (segment === '.' || segment === '..') return `"${segment}" path segments are not allowed`;
    // Windows drops trailing dots and spaces when it opens a path component,
    // so `.. `, `. ` and `foo.` are NOT the harmless names they look like.
    // \s also covers Unicode spaces (NBSP, thin space, ideographic space, ...).
    if (/[.\s]$/u.test(segment)) return 'path segments may not end in "." or whitespace';
    if (WINDOWS_DEVICE_RE.test(segment)) return 'Windows device names are not allowed';
  }
  return null;
}

/**
 * Refuse a lexically-contained `target` whose path passes through a symlink or
 * junction under `root`: the lexical checks cannot see that such a component
 * redirects the write outside the root. `lstatSync` (not statSync) is required
 * so the link itself is inspected; Windows reports junctions as symlinks here.
 * Missing components end the walk — the caller creates them itself.
 * Returns the resolved absolute target.
 */
export function assertNoSymlinkComponents(root, target) {
  const base = resolve(root);
  const out = resolve(base, String(target));
  const rel = relative(base, out);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error(
      `refusing ${JSON.stringify(String(target))}: it resolves outside ${base} (${out})`
    );
  }
  let current = base;
  for (const part of rel.split(sep)) {
    if (part === '' || part === '.') continue;
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) break;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `refusing ${JSON.stringify(String(target))}: ${current} is a symlink or junction under ${base}; a write through it could escape the root`
      );
    }
  }
  return out;
}
