// compiler/src/dist-swap.mjs — the atomic swap of the build output.
//
// The build writes every artifact into `<dist>.building` and calls commitDist()
// only after its LAST check passed. A build that fails therefore leaves the
// previous `dist/` untouched: an operator (or a watcher, or CI) can never pick
// up a half-written artifact, and the bundler never sees a `dist` whose
// generated modules were not emitted yet.
//
// Windows detail: a running `wrangler dev` (or an editor) can hold a handle on
// a directory inside `dist/`, so the rename can fail even though every file is
// closed. commitDist never destroys the old build to work around that: a
// blocked swap fails loud and leaves the finished build under `<dist>.building`
// (see #734).
import { existsSync, renameSync, rmSync } from 'node:fs';

/**
 * Move the finished staging directory into place.
 *
 * The previous `dist/` is renamed aside first and deleted only AFTER the new
 * one landed: a crash between the two renames leaves the old build recoverable
 * under `<dist>.old-*`, never a mix of both. A FAILED second rename (a handle
 * still open on `dist/`) renames the previous build straight back, so a failed
 * swap never leaves the app without a `dist/`.
 *
 * When even the rename-aside is blocked, the swap REFUSES: the old `dist/`
 * cannot be moved and deleting it in place would be the only way to continue —
 * which is exactly the way to lose a working build (the second rename fails on
 * the same handle and the app is left with a partial tree). The error names the
 * staging directory so the finished build is not lost either.
 *
 * @param {string} staging the directory the build wrote
 * @param {string} final the directory the app (and wrangler) reads
 */
export function commitDist(staging, final) {
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
      // The rename-aside itself is blocked (a handle on a directory inside
      // `dist/`, which Windows refuses even when the files are closed). Wiping
      // in place can only DELETE the old build — a later rename(staging, final)
      // still fails while the handle is held, and the app is then left with a
      // partial tree (the locked entry only). Refuse before the build touches
      // anything instead: the old `dist/` stays exactly as it was.
      throw new Error(
        'commitDist: cannot move ' + final + ' aside (a process still holds a handle on it, ' +
        'usually `wrangler dev`/an editor) — the build is complete under ' + staging + '; ' +
        'stop that process and re-run the build. The previous ' + final + ' was left untouched.'
      );
    }
  }
  try {
    renameSync(staging, final);
  } catch (err) {
    // The new build could not land (a handle is still open on `dist/`).
    // Put the previous one back so the app never ends up WITHOUT a dist and
    // has to wait for another build; the rename-aside is reversible exactly
    // for this case.
    if (moved) {
      try {
        renameSync(previous, final);
      } catch {
        /* even the restore is locked: the build stays under `previous` on disk */
        err.message +=
          ' (the previous build was moved aside and could not be restored; it is at ' +
          previous + ')';
        throw err;
      }
      err.message += ' (the previous build was restored)';
    } else {
      // Nothing was moved aside — the staging tree is complete and valid.
      err.message += ' (the finished build is at ' + staging + ')';
    }
    throw err;
  }
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
