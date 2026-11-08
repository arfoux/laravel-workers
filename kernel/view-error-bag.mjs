// kernel/view-error-bag.mjs - `$errors` for a compiled view.
//
// ShareErrorsFromSession (Illuminate/Foundation/Http/Middleware/
// ShareErrorsFromSession.php) shares the session's `errors` value into every
// view as `$errors`, a ViewErrorBag (Illuminate/Support/ViewErrorBag.php). The
// compiled Blade turns `@error('x') ... @enderror` into
//
// $__bag = $errors->getBag('default'); if ($__bag->has('x')): ... $__bag->first('x') ... endif;
//
// so a view with @error needs the bag even when no validation failed - the
// session value is simply absent and every bag is empty.
//
// The shapes the kernel stores (kernel/validation.mjs `sessionErrorBag`) are
// { default: { format: ':message', messages: { field: 'msg' | ['a','b'] } } }
//
// Every expectation below was verified against framework 13.x with the PHP
// oracle (MessageBag/ViewErrorBag from the vendor tree), not read off the
// source alone.
import { phpJsonEncode } from './php-json.mjs';

/** MessageBag.php:31 - `protected $format = ':message';`. */
const DEFAULT_FORMAT = ':message';

/**
 * A key of the bag holds a PHP `array<string>`; a value written by `add()`,
 * `merge()` or a hand-built map can still be a bare string
 * (`array_merge_recursive(['a' => ['z']], ['b' => 'y'])` keeps `'y'` scalar),
 * so every reader normalises through here.
 */
function listOf(value) {
  return Array.isArray(value) ? value : [value];
}

/**
 * Illuminate\Support\Str::is() the way `getMessagesForWildcardKey()` uses it
 * (Str.php: `preg_quote($pattern, '#')` then `str_replace('\*', '.*', …)`,
 * anchored `#^…\z#u`): a `*` glob over the WHOLE string, case sensitive.
 * `\z` has no JS flag equivalent, so the end anchor is a lookahead.
 */
function wildcardMatch(pattern, value) {
  const source = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp('^' + source + '(?![\\s\\S])', 'u').test(String(value));
}

/**
 * A bag from the kernel's stored shape ({ format, messages }), a message map,
 * or a ready MessageBag.
 */
function toBag(value) {
  if (value instanceof MessageBag) return value;
  if (value && typeof value === 'object' && typeof value.messages === 'object') {
    return new MessageBag(value.messages, value.format || DEFAULT_FORMAT);
  }
  return new MessageBag(value || {});
}

/** Illuminate/Support/MessageBag.php - the bag a view reads its errors from. */
export class MessageBag {
  /** MessageBag.php:33-41: each key holds `array_unique((array) $value)`. */
  constructor(messages = {}, format = DEFAULT_FORMAT) {
    this.messages = {};
    this.format = format || DEFAULT_FORMAT;
    for (const [key, value] of Object.entries(messages || {})) {
      const list = [];
      for (const message of listOf(value)) {
        if (!list.includes(message)) list.push(message);
      }
      this.messages[String(key)] = list;
    }
  }

  /** MessageBag::keys() (:47-50). */
  keys() {
    return Object.keys(this.messages);
  }

  /** MessageBag::add() (:59-66) - only a unique `(key, message)` is appended. */
  add(key, message) {
    if (this.isUnique(key, message)) {
      const k = String(key);
      if (!Object.prototype.hasOwnProperty.call(this.messages, k)) this.messages[k] = [];
      this.messages[k].push(message);
    }
    return this;
  }

  /** MessageBag::addIf() (:76-79). */
  addIf(boolean, key, message) {
    return boolean ? this.add(key, message) : this;
  }

  /** MessageBag::isUnique() (:88-93) - `! in_array($message, $messages[$key])`. */
  isUnique(key, message) {
    const list = this.messages[String(key)];
    if (list === undefined) return true;
    return !listOf(list).includes(message);
  }

  /**
   * MessageBag::merge() (:101-108) - `array_merge_recursive` for the common
   * (string field key) case: an existing key gains the new messages, a new key
   * keeps the incoming value as it is (a scalar stays scalar; every reader goes
   * through `listOf()`).
   */
  merge(messages) {
    const incoming = messages instanceof MessageBag ? messages.getMessages() : messages || {};
    for (const [key, value] of Object.entries(incoming)) {
      const k = String(key);
      if (Object.prototype.hasOwnProperty.call(this.messages, k)) {
        this.messages[k] = listOf(this.messages[k]).concat(listOf(value));
      } else {
        this.messages[k] = value;
      }
    }
    return this;
  }

  /**
   * MessageBag::has() (:118-130): an empty bag has nothing; `null` asks
   * `any()`; an array (or variadic arguments) asks for ALL keys.
   */
  has(key = null, ...rest) {
    if (this.isEmpty()) return false;
    if (key === null || key === undefined) return this.any();
    const keys = Array.isArray(key) ? key : [key, ...rest];
    return keys.every((k) => this.first(k) !== '');
  }

  /** MessageBag::hasAny() (:139-144): an empty bag has nothing; else ANY key. */
  hasAny(keys = [], ...rest) {
    if (this.isEmpty()) return false;
    const list = Array.isArray(keys) ? keys : [keys, ...rest];
    return list.some((k) => this.has(k));
  }

  /** MessageBag::missing() (:156-161). */
  missing(key = null, ...rest) {
    const keys = Array.isArray(key) ? key : [key, ...rest];
    return !this.hasAny(keys);
  }

  /**
   * MessageBag::first() (:170-177): a key answers through `get()`, a missing
   * key answers `''` (`Arr::first($messages, null, '')`); a wildcard key
   * answers the first message of its first matching key.
   */
  first(key = null, format = null) {
    const messages = key === null || key === undefined ? this.all(format) : this.get(key, format);
    const values = Array.isArray(messages) ? messages : Object.values(messages || {});
    if (!values.length) return '';
    const firstMessage = values[0];
    return Array.isArray(firstMessage) ? (firstMessage.length ? firstMessage[0] : '') : firstMessage;
  }

  /**
   * MessageBag::get() (:186-201): the exact key, else a `*` wildcard map keyed
   * by the matching message keys, else `[]`.
   */
  get(key, format = null) {
    const k = String(key);
    if (Object.prototype.hasOwnProperty.call(this.messages, k)) {
      return this.transform(listOf(this.messages[k]), this.checkFormat(format), k);
    }
    if (k.includes('*')) return this.getMessagesForWildcardKey(k, format);
    return [];
  }

  /** MessageBag::getMessagesForWildcardKey() (:211-219). */
  getMessagesForWildcardKey(key, format) {
    const out = {};
    for (const [messageKey, messages] of Object.entries(this.messages)) {
      if (wildcardMatch(key, messageKey)) {
        out[messageKey] = this.transform(listOf(messages), this.checkFormat(format), messageKey);
      }
    }
    return out;
  }

  /** MessageBag::all() (:227-237) - every message, every key, flattened. */
  all(format = null) {
    const fmt = this.checkFormat(format);
    const all = [];
    for (const [key, messages] of Object.entries(this.messages)) {
      all.push(...this.transform(listOf(messages), fmt, key));
    }
    return all;
  }

  /**
   * MessageBag::unique() (:246-249) - `array_unique($this->all($format))`.
   * PHP keeps the source keys of the survivors (a gap shows up only when
   * `unique()` itself is json_encoded); a plain list is what a `foreach` walks.
   */
  unique(format = null) {
    return [...new Set(this.all(format))];
  }

  /** MessageBag::forget() (:257-262). */
  forget(key) {
    delete this.messages[String(key)];
    return this;
  }

  /** MessageBag::transform() (:272-283) - `:message` / `:key` placeholders. */
  transform(messages, format, messageKey) {
    if (format === ':message') return listOf(messages).slice();
    // str_replace([':message', ':key'], …) walks the searches in order, so a
    // `:key` inside the message text is replaced in the second pass too.
    return listOf(messages).map((message) =>
      String(format).replaceAll(':message', String(message)).replaceAll(':key', String(messageKey))
    );
  }

  /** MessageBag::checkFormat() (:293-296) - `$format ?: $this->format`. */
  checkFormat(format) {
    return format || this.format;
  }

  /** MessageBag::messages() (:303-306). */
  messages() {
    return this.getMessages();
  }

  /** MessageBag::getMessages() (:313-316). */
  getMessages() {
    return this.messages;
  }

  /** MessageBag::getMessageBag() (:323-326) - the bag itself. */
  getMessageBag() {
    return this;
  }

  /** MessageBag::getFormat() (:333-336). */
  getFormat() {
    return this.format;
  }

  /** MessageBag::setFormat() (:344-349) - `$format ?: ':message'`. */
  setFormat(format = DEFAULT_FORMAT) {
    this.format = format || DEFAULT_FORMAT;
    return this;
  }

  /** MessageBag::isEmpty() (:356-359). */
  isEmpty() {
    return !this.any();
  }

  /** MessageBag::isNotEmpty() (:366-369). */
  isNotEmpty() {
    return this.any();
  }

  /** MessageBag::any() (:376-379). */
  any() {
    return this.count() > 0;
  }

  /** MessageBag::count() (:386-389) - `count($messages, COUNT_RECURSIVE) - count($messages)`: the leaf messages. */
  count() {
    let total = 0;
    for (const messages of Object.values(this.messages)) total += listOf(messages).length;
    return total;
  }

  /** MessageBag::toArray() (:396-399) / jsonSerialize() (:407-410). */
  toArray() {
    return this.getMessages();
  }

  jsonSerialize() {
    return this.toArray();
  }

  /** MessageBag::toJson() (:418-421) - PHP's json_encode of the message map. */
  toJson(options = 0) {
    void options;
    return phpJsonEncode(this.jsonSerialize());
  }

  /** `MessageBag::__toString()` (:437-440) is `toJson()`. */
  toString() {
    return this.toJson();
  }

  /**
   * The JS protocol hook (`JSON.stringify`), the same split the kernel's Model
   * uses (kernel/model.mjs:1035): `toJson()` is `json_encode()` (a STRING),
   * `toJSON()` is `jsonSerialize()` (the value). The kernel's JSON encoder
   * reads it too, so `json_encode($validator->errors())` writes the map.
   */
  toJSON() {
    return this.toArray();
  }
}

// The kernel's JSON encoder tells a PHP kind by a marker on the constructor
// (kernel/php-json.mjs - `instanceof` cannot be used: the compiled property
// proxy replaces the prototype): a MessageBag is JsonSerializable
// (`jsonSerialize()` -> the message map), so `json_encode($bag)` writes that
// map instead of failing loud.
Object.defineProperty(MessageBag, '__lwMessageBag', { value: true });

/**
 * Illuminate/Support/ViewErrorBag.php.
 *
 * The vendor reaches the bag's methods through `__call()`/`__get()` (:94-115),
 * so `$errors->isEmpty()` and `$errors->count()` speak about the DEFAULT bag -
 * a second bag (`$errors->getBag('login')`) is only visible through `getBag()`
 * / `hasBag()`. JS has no `__call`, so the same forwarding is installed
 * explicitly for every public bag method below (and `default` as a getter).
 */
export class ViewErrorBag {
  constructor(bags = {}) {
    this.bags = {};
    for (const [name, bag] of Object.entries(bags || {})) this.put(name, bag);
  }

  /** ViewErrorBag::hasBag() (:27-30) - `isset($this->bags[$key])`: the name is
   *  present, even when the bag it holds is empty. Defaults to `'default'`. */
  hasBag(name = 'default') {
    return Object.prototype.hasOwnProperty.call(this.bags, String(name));
  }

  /** ViewErrorBag::getBag() (:38-41) - `Arr::get($this->bags, $key) ?: new MessageBag`:
   *  an unknown name answers a FRESH empty bag that is NOT stored. */
  getBag(name) {
    const key = String(name);
    return Object.prototype.hasOwnProperty.call(this.bags, key) ? this.bags[key] : new MessageBag();
  }

  /** ViewErrorBag::getBags() (:48-51). */
  getBags() {
    return this.bags;
  }

  /** ViewErrorBag::put() (:60-65). */
  put(name, bag) {
    this.bags[String(name)] = toBag(bag);
    return this;
  }

  /** ViewErrorBag::count() (:82-85) - the DEFAULT bag's message count. */
  count() {
    return this.getBag('default').count();
  }

  /** ViewErrorBag::any() (:72-75) - `count() > 0`, the default bag again. */
  any() {
    return this.count() > 0;
  }

  /** ViewErrorBag::__get() (:105-108) - `$errors->default`. */
  get default() {
    return this.getBag('default');
  }

  /** ViewErrorBag::__toString() (:127-130) - the default bag's JSON. */
  toString() {
    return this.getBag('default').toString();
  }

  /** The vendor keeps its bags in a PROTECTED property and implements neither
   *  JsonSerializable nor Arrayable, so `json_encode($errors)` is `{}`. */
  toJSON() {
    return {};
  }
}

// ViewErrorBag::__call() (:94-97) forwards every unknown method to the default
// bag. The vendor's protected bag methods (transform/checkFormat/isUnique/
// getMessagesForWildcardKey) are skipped: PHP raises "Call to protected
// method" for those, so they must not become reachable through `$errors`.
// The marker tells kernel/php-json.mjs the PHP answer for `json_encode($errors)`
// is `{}` (bags are protected there, and the class is not JsonSerializable).
Object.defineProperty(ViewErrorBag, '__lwViewErrorBag', { value: true });
const PROTECTED_BAG_METHODS = new Set([
  'constructor',
  'toJSON',
  'isUnique',
  'transform',
  'checkFormat',
  'getMessagesForWildcardKey',
]);
for (const name of Object.getOwnPropertyNames(MessageBag.prototype)) {
  if (PROTECTED_BAG_METHODS.has(name) || name in ViewErrorBag.prototype) continue;
  ViewErrorBag.prototype[name] = function delegated(...args) {
    return this.getBag('default')[name](...args);
  };
}

/**
 * Decode the session's `errors` value into a ViewErrorBag: the kernel's own
 * stored shape ({ bag: { format, messages } } - a test fixture or a payload a
 * port wrote) or a plain field=>message map (then the default bag).
 */
export function viewErrorBag(stored) {
  if (!stored || typeof stored !== 'object') return new ViewErrorBag();
  const bags = {};
  let matched = false;
  for (const [name, value] of Object.entries(stored)) {
    if (value && typeof value === 'object' && value.messages && typeof value.messages === 'object') {
      bags[name] = new MessageBag(value.messages, value.format || DEFAULT_FORMAT);
      matched = true;
    }
  }
  if (matched) return new ViewErrorBag(bags);
  // A plain field=>message map is the `errors` key of a session payload a test
  // or a port wrote: treat it as the default bag.
  return new ViewErrorBag({ default: stored });
}
