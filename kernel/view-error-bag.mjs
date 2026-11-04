// kernel/view-error-bag.mjs — `$errors` for a compiled view.
//
// ShareErrorsFromSession (Illuminate/Foundation/Http/Middleware/
// ShareErrorsFromSession.php) shares the session's `errors` value into every
// view as `$errors`, a ViewErrorBag (Illuminate/Support/ViewErrorBag.php). The
// compiled Blade turns `@error('x') … @enderror` into
//
//   $__bag = $errors->getBag('default'); if ($__bag->has('x')): … $__bag->first('x') … endif;
//
// so a view with @error needs the bag even when no validation failed — the
// session value is simply absent and every bag is empty.
//
// The shapes the kernel stores (kernel/validation.mjs `sessionErrorBag`) are
//   { default: { format: ':message', messages: { field: 'msg' | ['a','b'] } } }

/** Illuminate/Support/MessageBag.php — the read surface a view uses. */
export class MessageBag {
  constructor(messages = {}) {
    // Messages are keyed by field; a field holds one message or a list.
    this.messages = {};
    for (const [key, value] of Object.entries(messages || {})) {
      this.messages[String(key)] = Array.isArray(value) ? value.map(String) : [String(value)];
    }
  }

  /** MessageBag::first($key, $format = null): the first message or ''. */
  first(key, format = null) {
    const list = this.messages[String(key)] || [];
    const message = list.length ? String(list[0]) : '';
    return format === null ? message : String(format).replace(':message', message);
  }

  /** MessageBag::get($key, $format = null): every message for the key. */
  get(key, format = null) {
    const list = this.messages[String(key)] || [];
    return format === null ? list.slice() : list.map((m) => String(format).replace(':message', m));
  }

  /** MessageBag::has($key): a non-empty first message exists. */
  has(key) {
    return this.first(key) !== '';
  }

  /** MessageBag::hasAny($keys). */
  hasAny(keys) {
    return [].concat(keys).some((k) => this.has(k));
  }

  /** MessageBag::all($format = null): every message, flat. */
  all(format = null) {
    const out = [];
    for (const key of Object.keys(this.messages)) out.push(...this.get(key, format));
    return out;
  }

  /** MessageBag::keys(). */
  keys() {
    return Object.keys(this.messages);
  }

  /** MessageBag::isEmpty() / isNotEmpty(). */
  isEmpty() {
    return this.all().length === 0;
  }

  isNotEmpty() {
    return !this.isEmpty();
  }

  /** MessageBag::any(): any message at all. */
  any() {
    return this.isNotEmpty();
  }

  /** MessageBag::count(). */
  count() {
    return this.all().length;
  }

  /** MessageBag::getMessages(). */
  getMessages() {
    return this.messages;
  }

  /** MessageBag::__toString(): the messages as `<ul>…</ul>`. */
  toString() {
    if (this.isEmpty()) return '';
    const items = this.all((m) => m).map((m) => '<li>' + String(m).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>');
    return '<ul>' + items.join('') + '</ul>';
  }

  toJSON() {
    return this.messages;
  }
}

/** Illuminate/Support/ViewErrorBag.php. */
export class ViewErrorBag {
  constructor(bags = {}) {
    this.bags = {};
    for (const [name, bag] of Object.entries(bags || {})) {
      this.bags[String(name)] = bag instanceof MessageBag ? bag : new MessageBag(bag);
    }
  }

  /** ViewErrorBag::getBag($name): the bag, or an empty one (not stored). */
  getBag(name) {
    const key = String(name);
    return Object.prototype.hasOwnProperty.call(this.bags, key) ? this.bags[key] : new MessageBag();
  }

  /** ViewErrorBag::hasBag($name). */
  hasBag(name) {
    const key = String(name);
    if (!Object.prototype.hasOwnProperty.call(this.bags, key)) return false;
    return this.bags[key].isNotEmpty();
  }

  /** ViewErrorBag::put($name, $bag). */
  put(name, bag) {
    this.bags[String(name)] = bag instanceof MessageBag ? bag : new MessageBag(bag);
    return this;
  }

  /** ViewErrorBag::getBags(). */
  getBags() {
    return this.bags;
  }

  /** ViewErrorBag::any(): any bag holds a message. */
  any() {
    return Object.values(this.bags).some((bag) => bag.isNotEmpty());
  }

  /** ViewErrorBag::isEmpty() / isNotEmpty(). */
  isEmpty() {
    return !this.any();
  }

  isNotEmpty() {
    return this.any();
  }

  /** ViewErrorBag::count(): the number of messages, all bags. */
  count() {
    return Object.values(this.bags).reduce((total, bag) => total + bag.count(), 0);
  }
}

/**
 * Decode the session's `errors` value into a ViewErrorBag.
 *
 * @param {unknown} stored the session value ({ bag: { format, messages } }),
 *   a plain field=>message map (a test fixture), or null.
 */
export function viewErrorBag(stored) {
  if (!stored || typeof stored !== 'object') return new ViewErrorBag();

  // The kernel's own shape: one or more bags, each { format, messages }.
  const bags = {};
  let matched = false;
  for (const [name, value] of Object.entries(stored)) {
    if (value && typeof value === 'object' && value.messages && typeof value.messages === 'object') {
      bags[name] = value.messages;
      matched = true;
    }
  }
  if (matched) return new ViewErrorBag(bags);

  // A plain field=>message map is the `errors` key of a session payload a test
  // or a port wrote: treat it as the default bag.
  return new ViewErrorBag({ default: stored });
}
