// compiler/src/view-name.mjs — the view name -> the compiled file name.
//
// A view name is a dotted path (`posts.index`) or a namespaced one
// (`pagination::tailwind` - the framework's pagination views). The `::` is not
// a legal character in a file name on Windows, so the compiled modules use a
// sanitized name; the *view name* (the key of the views map) stays the real
// one, so the runtime asks for `pagination::tailwind` and gets the module.
//
// Keep in sync with build.mjs (it writes the modules) and controller.mjs (it
// imports them).

// The sanitized name is a FILE name in the build output (`views/<name>.mjs` and
// `contexts/<name>.mjs`), and the handler imports it by that name. Two DIFFERENT
// view names can sanitize to the same file - `a/b` and `a-b` both answer
// `a-b`, and `pagination::tailwind` collides with a literal
// `pagination--tailwind` - and the build would silently overwrite one view with
// the other: the wrong view is served, with no build error. The map is
// module-global (one build per process), so a second, DIFFERENT view answering
// an already-used file name stops the build instead.
const usedFileNames = new Map();

export function viewFileName(view) {
  const name = String(view == null ? '' : view);
  // The illegal characters (< > : " / \ | ? *) and the control codes.
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-');
  // A name that starts with a dot would be hidden; an empty one would break
  // the path.
  const file = safe.replace(/^\.+/, '_') || '_';
  // #352/#366: the guard must be CASE-INSENSITIVE. The build writes these
  // modules to a local filesystem (Windows and macOS are case-insensitive by
  // default), so `Posts.Index` and `posts.index` — two genuinely different
  // views on Linux — land on the same file on the build machine and one
  // silently overwrites the other. Refuse instead.
  const key = file.toLowerCase();
  const previous = usedFileNames.get(key);
  if (previous !== undefined && previous !== name) {
    throw new Error(
      'two view names sanitize to the same compiled file name "' + file + '" (case-insensitively): ' +
        JSON.stringify(previous) + ' and ' + JSON.stringify(name) +
        ' — the build would write one module over the other and serve the wrong view; rename one of the views'
    );
  }
  usedFileNames.set(key, name);
  return file;
}

export default { viewFileName };
