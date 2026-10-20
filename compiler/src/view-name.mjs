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

export function viewFileName(view) {
  const name = String(view == null ? '' : view);
  // The illegal characters (< > : " / \ | ? *) and the control codes.
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-');
  // A name that starts with a dot would be hidden; an empty one would break
  // the path.
  return safe.replace(/^\.+/, '_') || '_';
}

export default { viewFileName };
