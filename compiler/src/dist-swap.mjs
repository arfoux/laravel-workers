// compiler/src/dist-swap.mjs — the atomic swap of the build output.
//
// The build writes every artifact into `<dist>.building` and calls commitDist()
// only after its LAST check passed. A build that fails therefore leaves the
// previous `dist/` untouched: an operator (or a watcher, or CI) can never pick
// up a half-written artifact, and the bundler never sees a `dist` whose
// generated modules were not emitted yet.
//
// Windows detail: a running `wrangler dev` (or an editor) can hold a handle on
// `dist/` or a subdirectory, so the rename can fail even though every file is
// closed. The fallback wipes the contents and keeps the locked directory
// shells — the build rewrites everything anyway.
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Remove a directory tree, tolerating a locked entry. */
function wipe(dir, onLocked) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return;
  } catch {
    /* a handle is held — wipe what can be wiped */
  }
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    try {
      rmSync(join(dir, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      if (onLocked) onLocked(join(dir, entry));
    }
  }
}

/**
 * Move the finished staging directory into place.
 *
 * The previous `dist/` is renamed aside first and deleted only AFTER the new
 * one landed: a crash between the two renames leaves the old build recoverable
 * under `<dist>.old-*` (the next build sweeps those), never a mix of both.
 *
 * @param {string} staging the directory the build wrote
 * @param {string} final the directory the app (and wrangler) reads
 * @param {(path: string) => void} [onLocked] told about each entry it cannot delete
 */
export function commitDist(staging, final, onLocked) {
  if (!existsSync(staging)) {
    throw new Error('commitDist: the staging directory ' + staging + ' does not exist');
  }
  const previous = final + '.old-' + Date.now();
  let moved = false;
  if (existsSync(final)) {
    try {
      renameSync(final, previous);
      moved = true;
    } catch {
      wipe(final, onLocked);
    }
  }
  renameSync(staging, final);
  if (moved) {
    try {
      rmSync(previous, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* locked — the `dist.old-*` sweep removes it on the next build */
    }
  }
}

/** Throw the staging directory away (a failed build). */
export function discardStaging(staging) {
  try {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* still locked — the next build wipes it */
  }
}
