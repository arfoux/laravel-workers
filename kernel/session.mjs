// kernel/session.mjs — Illuminate\Session\Store parity (Laravel 11+/13.x).
//
// Implements the session layer of the compiled rung:
//   - PhpSessionStore: byte-for-byte Store semantics — dot-notation Arr::get/
//     set/forget, the _flash.old/_flash.new lifecycle (including the gapped
//     PHP array shapes produced by array_merge/array_unique/array_diff) and
//     Store::save() payload bytes (json_encode or serialize per app config
//     session.serialization).
//   - CookieJar + CookieSessionHandler: the edge-native "cookie" driver
//     ({data,expires} envelope, forget-on-destroy, Symfony cookie rendering
//     happens in kernel/cookies.mjs).
//   - DatabaseSessionHandler: the "database" driver on D1 (payload is
//     base64(json|serialize), last_activity bookkeeping, request/user info).
//
// Verified against PHP 8.3 via tools/php-session-oracle.php in
// kernel/tests/session.test.mjs.
//
// Representation notes (PHP array -> JS):
//   - Internally every PHP array is a plain JS object keyed by string; the two
//     encoders (phpJsonEncode/phpSerialize) emit identical bytes for dense
//     objects and lists, so no information is lost.
//   - Public reads (get/all/only/...) return "outward" copies: dense objects
//     become JS arrays, everything else stays an object. PHP arrays are value
//     types, so copies are actually more faithful than references.
//   - Known, documented limits: integer-like keys beyond 2^53 lose identity
//     (same caveat as php-serialize), JS reorders integer-like object keys
//     ascending, and int-key cast rules follow PHP ("-0"/"+0"/"00" stay
//     string keys).
//   - marshalErrorBag/prepareErrorBagForSerialization (ViewErrorBag) are
//     intentionally not modelled: the net effect on stored bytes is the
//     identity for well-formed {format,messages} payloads, which is what the
//     worker stores. Template-layer error access is handled in the view
//     runtime instead.
//
// Handler I/O is async (D1 is), so start/save/migrate/invalidate/regenerate
// return promises; everything else is synchronous like PHP.

import { phpJsonEncode, phpJsonDecode } from './php-json.mjs';
import { phpSerialize, phpUnserialize } from './php-serialize.mjs';
import { makeCookie } from './cookies.mjs';
import { table } from './db.mjs';

export class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionError';
  }
}

export const SESSION_ID_LENGTH = 40;

// ---------------------------------------------------------------------------
// PHP array helpers (internal representation: plain JS objects, string keys).
// ---------------------------------------------------------------------------

const INT_KEY_RE = /^-?(?:0|[1-9][0-9]*)$/;

export function isPlainObject(v) {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isPhpArrayValue(v) {
  return Array.isArray(v) || isPlainObject(v);
}

function hasKey(container, key) {
  // PHP casts canonical decimal string keys to ints; lookup by string form is
  // equivalent for our object representation. "-0"/"+0"/"00" stay strings,
  // matching PHP (verified).
  return Object.prototype.hasOwnProperty.call(container, String(key));
}

function rawGet(container, key) {
  return container[String(key)];
}

function assignKey(container, key, value) {
  container[String(key)] = value;
}

function resolveDefault(def) {
  return typeof def === 'function' ? def() : def;
}

/** Deep-convert a user value into the internal PHP-array representation. */
export function toInternal(value) {
  if (Array.isArray(value)) {
    const out = {};
    for (let i = 0; i < value.length; i++) assignKey(out, i, toInternal(value[i]));
    return out;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = toInternal(value[k]);
    return out;
  }
  return value;
}

/** Deep-convert internal representation back to a user-facing value. */
export function toOutward(value) {
  if (Array.isArray(value)) return value.map(toOutward);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    let dense = true;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== String(i)) {
        dense = false;
        break;
      }
    }
    if (dense) return keys.map((k) => toOutward(value[k]));
    const out = {};
    for (const k of keys) out[k] = toOutward(value[k]);
    return out;
  }
  return value;
}

/** Arr::get($array, $key, $default) — dot notation, PHP semantics. */
export function arrGetInternal(array, key, def = null) {
  if (!isPhpArrayValue(array)) return resolveDefault(def);
  if (key === null || key === undefined) return array;
  if (hasKey(array, key)) return rawGet(array, key);
  const k = String(key);
  if (!k.includes('.')) return resolveDefault(def);
  let current = array;
  for (const segment of k.split('.')) {
    if (isPhpArrayValue(current) && hasKey(current, segment)) {
      current = rawGet(current, segment);
    } else {
      return resolveDefault(def);
    }
  }
  return current;
}

/** Arr::set(&$array, $key, $value) — creates nested arrays, replaces scalars. */
export function arrSetInternal(root, key, value) {
  const keys = String(key).split('.');
  let container = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const segment = keys[i];
    let child = hasKey(container, segment) ? rawGet(container, segment) : undefined;
    if (child === null || child === undefined || !isPhpArrayValue(child)) {
      child = {};
      assignKey(container, segment, child);
    } else if (Array.isArray(child) || !isPlainObject(child)) {
      child = toInternal(child);
      assignKey(container, segment, child);
    }
    container = child;
  }
  assignKey(container, keys[keys.length - 1], value);
  return root;
}

/** Arr::forget(&$array, $keys) — direct key first, then dot-path walk. */
export function arrForgetInternal(root, keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  if (list.length === 0) return;
  for (const key of list) {
    if (key === null || key === undefined) continue;
    if (hasKey(root, key)) {
      delete root[String(key)];
      continue;
    }
    const parts = String(key).split('.');
    let container = root;
    let ok = true;
    while (parts.length > 1) {
      const part = parts.shift();
      const exists = hasKey(container, part) && rawGet(container, part) !== null;
      if (exists && isPhpArrayValue(rawGet(container, part))) {
        container = rawGet(container, part);
      } else {
        ok = false;
        break;
      }
    }
    if (ok) delete container[String(parts[0])];
  }
}

function entriesOf(container) {
  if (Array.isArray(container)) return container.map((v, i) => [i, v]);
  return Object.entries(container);
}

function entriesValues(container) {
  if (Array.isArray(container)) return container.slice();
  if (isPlainObject(container)) return Object.keys(container).map((k) => container[k]);
  return [];
}

/** PHP `$array[] = $value` on the internal representation (max int key + 1). */
function appendInternal(container, value) {
  if (container !== null && container !== undefined && !isPhpArrayValue(container)) {
    // PHP 8: "Cannot use a scalar value as an array" (null auto-vivifies).
    throw new SessionError(`Cannot use a scalar value as an array (push onto ${JSON.stringify(container)})`);
  }
  const out = isPhpArrayValue(container) ? { ...container } : {};
  let next = 0;
  for (const key of Object.keys(out)) {
    if (INT_KEY_RE.test(key)) {
      const n = Number(key);
      if (Number.isSafeInteger(n) && n >= 0 && n + 1 > next) next = n + 1;
    }
  }
  out[String(next)] = value;
  return out;
}

/** array_merge renumbers integer keys, string keys overwrite. */
function phpArrayMergeInternal(a, b) {
  const out = {};
  let next = 0;
  for (const source of [a, b]) {
    for (const [k, v] of entriesOf(isPhpArrayValue(source) ? source : {})) {
      if (INT_KEY_RE.test(String(k))) {
        out[String(next++)] = v;
      } else {
        out[String(k)] = v;
      }
    }
  }
  return out;
}

/** array_unique (SORT_STRING: compare as strings, first occurrence wins). */
function phpArrayUniqueInternal(container) {
  const out = {};
  const seen = new Set();
  for (const [k, v] of entriesOf(container)) {
    const s = String(v);
    if (seen.has(s)) continue;
    seen.add(s);
    out[String(k)] = v;
  }
  return out;
}

/** array_diff (compares values as strings). */
function phpArrayDiffInternal(a, b) {
  const exclude = new Set(entriesOf(b).map(([, v]) => String(v)));
  const out = {};
  for (const [k, v] of entriesOf(a)) {
    if (!exclude.has(String(v))) out[String(k)] = v;
  }
  return out;
}

/** array_intersect_key($array, array_flip($keys)) — top level only. */
function phpArrayIntersectKeyInternal(container, keys) {
  const flip = new Set((Array.isArray(keys) ? keys : [keys]).map(String));
  const out = {};
  for (const [k, v] of entriesOf(container)) {
    if (flip.has(String(k))) out[String(k)] = v;
  }
  return out;
}

/** array_replace($a, $b): $b wins, $a keeps its order, new keys appended. */
function phpArrayReplaceInternal(a, b) {
  const out = {};
  for (const [k, v] of entriesOf(a)) out[String(k)] = v;
  for (const [k, v] of entriesOf(b)) out[String(k)] = v;
  return out;
}

function countPhpValue(v) {
  if (v === null || v === undefined) return 0;
  if (Array.isArray(v)) return v.length;
  if (isPlainObject(v)) return Object.keys(v).length;
  return 1;
}

/** PHP truthiness for handler payload strings ('' and '0' are falsy). */
export function phpTruthy(v) {
  return !(v === '' || v === '0' || v === false || v === 0 || v === null || v === undefined);
}

function phpNumericOperand(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return 0;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  throw new SessionError(`Unsupported operand for numeric operation: ${JSON.stringify(v)}`);
}

// ---------------------------------------------------------------------------
// Random ids (Str::random).
// ---------------------------------------------------------------------------

function defaultRandomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Str::random($length): base64 minus "/" "+" "=", exact length. */
export function phpRandomString(length, randomBytes = defaultRandomBytes) {
  let out = '';
  while (out.length < length) {
    const size = length - out.length;
    const bytesSize = Math.ceil(size / 3) * 3;
    const bytes = randomBytes(bytesSize);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const chunk = btoa(bin).replace(/[/+=]/g, '');
    out += chunk.slice(0, size);
  }
  return out;
}

/** Store::isValidId: 40 chars, ctype_alnum (ASCII). */
export function isValidSessionId(id) {
  return typeof id === 'string' && id.length === SESSION_ID_LENGTH && /^[A-Za-z0-9]+$/.test(id);
}

// ---------------------------------------------------------------------------
// PhpSessionStore — Illuminate\Session\Store.
// ---------------------------------------------------------------------------

export class PhpSessionStore {
  constructor({ name = 'laravel_session', handler, id = null, serialization = 'php', clock = null } = {}) {
    if (!handler) throw new SessionError('PhpSessionStore requires a session handler');
    if (serialization !== 'php' && serialization !== 'json') {
      throw new SessionError(`Unsupported session serialization "${serialization}" (expected "php" or "json")`);
    }
    this.name = name;
    this.handler = handler;
    this.serialization = serialization;
    this.clock = clock || (() => Math.floor(Date.now() / 1000));
    this.attributes = {};
    this.started = false;
    this.setId(id);
  }

  // ---- lifecycle ---------------------------------------------------------

  async start() {
    await this.loadSession();
    if (!this.has('_token')) this.regenerateToken();
    this.started = true;
    return true;
  }

  async loadSession() {
    this.attributes = phpArrayReplaceInternal(this.attributes, await this.readFromHandler());
  }

  async readFromHandler() {
    const data = await this.handler.read(this.getId());
    if (phpTruthy(data)) {
      let decoded;
      if (this.serialization === 'json') {
        try {
          decoded = phpJsonDecode(String(data));
        } catch {
          decoded = null;
        }
      } else {
        try {
          decoded = phpUnserialize(String(data));
        } catch {
          decoded = false;
        }
      }
      if (decoded !== false && isPhpArrayValue(decoded)) return toInternal(decoded);
    }
    return {};
  }

  async save() {
    this.ageFlashData();
    const payload =
      this.serialization === 'json' ? phpJsonEncode(this.attributes) : phpSerialize(this.attributes);
    await this.handler.write(this.getId(), payload);
    this.started = false;
  }

  // ---- attribute access --------------------------------------------------

  all() {
    return toOutward(this.attributes);
  }

  get(key, def = null) {
    return toOutward(arrGetInternal(this.attributes, key, resolveDefault(def)));
  }

  put(key, value = null) {
    if (Array.isArray(key) || isPlainObject(key)) {
      for (const [k, v] of entriesOf(key)) this.setInternal(k, v);
    } else {
      this.setInternal(key, value);
    }
  }

  replace(attributes) {
    this.put(attributes);
  }

  remember(key, callback) {
    const value = this.get(key);
    if (value !== null) return value;
    const result = callback();
    this.put(key, result);
    return result;
  }

  pull(key, def = null) {
    const value = arrGetInternal(this.attributes, key, resolveDefault(def));
    arrForgetInternal(this.attributes, [key]);
    return toOutward(value);
  }

  remove(key) {
    return this.pull(key);
  }

  push(key, value) {
    const current = arrGetInternal(this.attributes, key, {});
    this.setInternal(key, appendInternal(current, value));
  }

  increment(key, amount = 1) {
    const next = phpNumericOperand(this.get(key) ?? 0) + phpNumericOperand(amount);
    this.put(key, next);
    return next;
  }

  decrement(key, amount = 1) {
    return this.increment(key, -phpNumericOperand(amount));
  }

  forget(keys) {
    let list;
    if (Array.isArray(keys)) list = keys;
    else if (isPlainObject(keys)) list = entriesValues(keys);
    else list = [keys];
    arrForgetInternal(this.attributes, list);
  }

  flush() {
    this.attributes = {};
  }

  has(...args) {
    const keys = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return keys.every((k) => arrGetInternal(this.attributes, k, null) !== null);
  }

  hasAny(...args) {
    const keys = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return keys.some((k) => arrGetInternal(this.attributes, k, null) !== null);
  }

  exists(...args) {
    // Store::exists($key) — array form or func_get_args() variadic.
    const keys = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    const placeholder = {};
    return keys.every((k) => arrGetInternal(this.attributes, k, placeholder) !== placeholder);
  }

  missing(keyOrKeys) {
    return !this.exists(keyOrKeys);
  }

  only(keys) {
    return toOutward(phpArrayIntersectKeyInternal(this.attributes, keys));
  }

  except(keys) {
    const copy = toInternal(this.attributes);
    arrForgetInternal(copy, Array.isArray(keys) ? keys : [keys]);
    return toOutward(copy);
  }

  hasOldInput(key = null) {
    const old = this.getOldInput(key);
    return key === null ? countPhpValue(old) > 0 : old !== null;
  }

  getOldInput(key = null, def = null) {
    const base = arrGetInternal(this.attributes, '_old_input', {});
    return toOutward(arrGetInternal(base, key, resolveDefault(def)));
  }

  // ---- flash data --------------------------------------------------------

  flash(key, value = true) {
    this.put(key, value);
    this.push('_flash.new', key);
    this.removeFromOldFlashData([key]);
  }

  now(key, value) {
    this.put(key, value);
    this.push('_flash.old', key);
  }

  reflash() {
    this.mergeNewFlashes(entriesValues(arrGetInternal(this.attributes, '_flash.old', {})));
    this.setInternal('_flash.old', {});
  }

  keep(...args) {
    const keys = args.length === 0 ? [] : args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    this.mergeNewFlashes(keys);
    this.removeFromOldFlashData(keys);
  }

  flashInput(value) {
    this.flash('_old_input', value);
  }

  mergeNewFlashes(keys) {
    const values = phpArrayUniqueInternal(
      phpArrayMergeInternal(arrGetInternal(this.attributes, '_flash.new', {}), toInternal(keys))
    );
    this.setInternal('_flash.new', values);
  }

  removeFromOldFlashData(keys) {
    this.setInternal(
      '_flash.old',
      phpArrayDiffInternal(arrGetInternal(this.attributes, '_flash.old', {}), toInternal(keys))
    );
  }

  ageFlashData() {
    const old = arrGetInternal(this.attributes, '_flash.old', {});
    arrForgetInternal(this.attributes, entriesValues(old));
    this.setInternal('_flash.old', arrGetInternal(this.attributes, '_flash.new', {}));
    this.setInternal('_flash.new', {});
  }

  // ---- ids & tokens ------------------------------------------------------

  isStarted() {
    return this.started;
  }

  getName() {
    return this.name;
  }

  setName(name) {
    this.name = name;
  }

  id() {
    return this.getId();
  }

  getId() {
    return this.id;
  }

  setId(id) {
    this.id = isValidSessionId(id) ? id : this.generateSessionId();
    return this.id;
  }

  isValidId(id) {
    return isValidSessionId(id);
  }

  generateSessionId() {
    return phpRandomString(SESSION_ID_LENGTH);
  }

  token() {
    return arrGetInternal(this.attributes, '_token', null);
  }

  regenerateToken() {
    this.setInternal('_token', phpRandomString(SESSION_ID_LENGTH));
  }

  // ---- migration ---------------------------------------------------------

  async invalidate() {
    this.flush();
    return this.migrate(true);
  }

  async regenerate(destroy = false) {
    const result = await this.migrate(destroy);
    this.regenerateToken();
    return result;
  }

  async migrate(destroy = false) {
    if (destroy) await this.handler.destroy(this.getId());
    this.setExists(false);
    this.setId(this.generateSessionId());
    return true;
  }

  // ---- previous request --------------------------------------------------

  hasPreviousUri() {
    return this.previousUrl() !== null;
  }

  previousUrl() {
    return arrGetInternal(this.attributes, '_previous.url', null);
  }

  setPreviousUrl(url) {
    this.setInternal('_previous.url', url);
  }

  previousRoute() {
    return arrGetInternal(this.attributes, '_previous.route', null);
  }

  setPreviousRoute(route) {
    this.setInternal('_previous.route', route);
  }

  passwordConfirmed() {
    this.setInternal('auth.password_confirmed_at', this.clock());
  }

  // ---- handler -----------------------------------------------------------

  getHandler() {
    return this.handler;
  }

  setHandler(handler) {
    return (this.handler = handler);
  }

  setExists(value) {
    if (this.handler && typeof this.handler.setExists === 'function') this.handler.setExists(value);
  }

  // ---- internals ---------------------------------------------------------

  setInternal(key, value) {
    if (key === null || key === undefined) {
      this.attributes = toInternal(value);
      return;
    }
    arrSetInternal(this.attributes, key, toInternal(value));
  }
}

// ---------------------------------------------------------------------------
// CookieJar (Illuminate\Cookie\CookieJar subset used by the session drivers).
// ---------------------------------------------------------------------------

export class CookieJar {
  constructor({ path = '/', domain = null, secure = null, sameSite = 'lax', clock = null } = {}) {
    this.defaultPath = path;
    this.defaultDomain = domain;
    this.defaultSecure = secure;
    this.defaultSameSite = sameSite;
    this.clock = clock || (() => Math.floor(Date.now() / 1000));
    this.queued = new Map(); // name -> Map(path -> cookie)
  }

  make(name, value, minutes = 0, path = null, domain = null, secure = null, httpOnly = true, raw = false, sameSite = null) {
    const p = path ? path : this.defaultPath;
    const d = domain ? domain : this.defaultDomain;
    const s = typeof secure === 'boolean' ? secure : this.defaultSecure;
    const ss = sameSite ? sameSite : this.defaultSameSite;
    const time = minutes == 0 ? 0 : this.clock() + minutes * 60; // eslint-disable-line eqeqeq
    return makeCookie(name, value, time, { path: p, domain: d, secure: s, httpOnly, raw, sameSite: ss });
  }

  forget(name, path = null, domain = null) {
    return this.make(name, null, -2628000, path, domain);
  }

  queue(first, ...rest) {
    const cookie =
      first !== null && typeof first === 'object' && typeof first.name === 'string' && 'expires' in first
        ? first
        : this.make(first, ...rest);
    if (!this.queued.has(cookie.name)) this.queued.set(cookie.name, new Map());
    this.queued.get(cookie.name).set(cookie.path ?? '/', cookie);
    return cookie;
  }

  list() {
    const out = [];
    for (const paths of this.queued.values()) {
      for (const cookie of paths.values()) out.push(cookie);
    }
    return out;
  }

  flushQueuedCookies() {
    this.queued = new Map();
  }
}

// ---------------------------------------------------------------------------
// CookieSessionHandler — Illuminate\Session\CookieSessionHandler.
// ---------------------------------------------------------------------------

export class CookieSessionHandler {
  constructor({ jar, minutes = 120, expireOnClose = false, clock = null } = {}) {
    if (!jar) throw new SessionError('CookieSessionHandler requires a CookieJar');
    this.jar = jar;
    this.minutes = minutes;
    this.expireOnClose = expireOnClose;
    this.clock = clock || (() => Math.floor(Date.now() / 1000));
    this.requestCookies = {};
  }

  now() {
    return this.clock();
  }

  validateId(id) {
    return Object.prototype.hasOwnProperty.call(this.requestCookies, id);
  }

  async read(sessionId) {
    const raw = this.requestCookies[sessionId];
    const value = raw === '' || raw === '0' || raw === null || raw === undefined ? '' : raw;
    let decoded = null;
    if (value !== '') {
      try {
        decoded = JSON.parse(value);
      } catch {
        decoded = null;
      }
    }
    if (
      decoded !== null &&
      typeof decoded === 'object' &&
      !Array.isArray(decoded) &&
      decoded.expires !== undefined &&
      decoded.expires !== null &&
      this.now() <= decoded.expires
    ) {
      return decoded.data;
    }
    return '';
  }

  async write(sessionId, data) {
    this.jar.queue(
      sessionId,
      phpJsonEncode({ data, expires: this.now() + this.minutes * 60 }),
      this.expireOnClose ? 0 : this.minutes
    );
    return true;
  }

  async destroy(sessionId) {
    this.jar.queue(this.jar.forget(sessionId));
    return true;
  }

  async gc() {
    return 0;
  }

  setRequest(cookieMap) {
    this.requestCookies = cookieMap || {};
    return this;
  }
}

// ---------------------------------------------------------------------------
// DatabaseSessionHandler — Illuminate\Session\DatabaseSessionHandler on D1.
// ---------------------------------------------------------------------------

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToUtf8(b64) {
  let bin;
  try {
    bin = atob(String(b64));
  } catch {
    throw new SessionError('Invalid base64 payload in sessions table');
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class DatabaseSessionHandler {
  constructor({ db, table: tableName = 'sessions', minutes = 120, clock = null, exists = false, info = null } = {}) {
    if (!db) throw new SessionError('DatabaseSessionHandler requires a D1 binding');
    this.db = db;
    this.table = tableName;
    this.minutes = minutes;
    this.clock = clock || (() => Math.floor(Date.now() / 1000));
    this.exists = exists;
    this.info = info; // () => ({ user_id, ip_address, user_agent })
  }

  now() {
    return this.clock();
  }

  query() {
    return table(this.db, this.table);
  }

  expired(row) {
    return (
      !!row &&
      row.last_activity !== undefined &&
      row.last_activity !== null &&
      Number(row.last_activity) < this.now() - this.minutes * 60
    );
  }

  async validateId(id) {
    const row = await this.query().where('id', id).first();
    return row !== null && row !== undefined;
  }

  async read(sessionId) {
    const row = await this.query().where('id', sessionId).first();
    if (this.expired(row)) {
      this.exists = true;
      return '';
    }
    if (row !== null && row !== undefined && row.payload !== undefined && row.payload !== null) {
      this.exists = true;
      return base64ToUtf8(row.payload);
    }
    return '';
  }

  defaultPayload(data) {
    const payload = { payload: utf8ToBase64(data), last_activity: this.now() };
    if (this.info) {
      const extra = this.info() || {};
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined) payload[k] = v;
      }
    }
    return payload;
  }

  async write(sessionId, data) {
    const payload = this.defaultPayload(data);
    if (!this.exists) await this.read(sessionId);
    if (this.exists) {
      await this.query().where('id', sessionId).update(payload);
    } else {
      try {
        await this.query().insert({ ...payload, id: sessionId });
      } catch {
        await this.query().where('id', sessionId).update(payload);
      }
    }
    this.exists = true;
    return this.exists;
  }

  async destroy(sessionId) {
    await this.query().where('id', sessionId).delete();
    return true;
  }

  async gc(lifetime) {
    return this.query().where('last_activity', '<=', this.now() - lifetime).delete();
  }

  setExists(value) {
    this.exists = value;
    return this;
  }
}

export default {
  SessionError,
  SESSION_ID_LENGTH,
  isValidSessionId,
  phpRandomString,
  PhpSessionStore,
  CookieJar,
  CookieSessionHandler,
  DatabaseSessionHandler,
};
