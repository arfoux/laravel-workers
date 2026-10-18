// kernel/auth.mjs — compiled-rung auth layer.
//
// Byte-for-byte ports of the laravel/framework 13.37 auth stack that the
// compiled rung executes instead of booting PHP:
//
//   Illuminate\Auth\SessionGuard
//   Illuminate\Auth\GuardHelpers          (trait, inlined into SessionGuard)
//   Illuminate\Auth\Recaller
//   Illuminate\Auth\AuthenticationException
//   Illuminate\Auth\EloquentUserProvider
//   Illuminate\Auth\AuthManager           (session driver subset)
//   Illuminate\Auth\Authenticatable       (trait -> applyAuthenticatable)
//   Illuminate\Auth\Middleware\Authenticate
//   Illuminate\Auth\Middleware\RedirectIfAuthenticated
//   Illuminate\Hashing\BcryptHasher       (+ AbstractHasher::check)
//   Illuminate\Support\Timebox
//
// Behavioural notes (all verified against a PHP 8.3 / Laravel 13.37 oracle):
//   - password_get_info() identifies ONLY `$2y$NN$` as bcrypt. bcryptjs emits
//     `$2a$`, so BcryptHasher#make() rewrites the prefix to `$2y$` — matching
//     Laravel's hasher on PHP 8.3 exactly (check()/needsRehash() semantics).
//   - SessionGuard#hashKey is the full `app.key` string, including any
//     `base64:` prefix (AuthManager::createSessionDriver passes it verbatim).
//   - SessionGuard#basic()/onceBasic() (HTTP basic auth) are NOT ported; they
//     fail loud instead of silently degrading.
//   - The Recaller constructor's `@unserialize(...) ?: $recaller` collapses to
//     three outcomes (original string / parsed string / non-string truthy
//     marker); only the marker direction can lose a login, never grant one.
//   - Accept-header negotiation (expectsJson) is ported for the header shapes
//     compiled apps meet and verified vector-by-vector against PHP.
//
// Everything here is async wherever the PHP original touches the session
// store, the database or bcrypt; the pure in-memory methods stay synchronous
// exactly like their PHP counterparts.

import bcrypt from 'bcryptjs';
import { sha1Hex, hmacSha256Hex } from './digest.mjs';
import { phpRandomString, phpTruthy } from './session.mjs';
import { phpFalsy } from './ratelimit.mjs';
import { timingSafeEqual } from './hash.mjs';

export class AuthError extends Error {
  constructor(message, phpClass = 'RuntimeException') {
    super(message);
    this.name = 'AuthError';
    this.phpClass = phpClass;
  }
}

const phpStr = (value) => (value === null || value === undefined ? '' : String(value));
const phpTrim = (value) => String(value).replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');

// ---------------------------------------------------------------------------
// Accept header negotiation (Symfony AcceptHeader/HeaderUtils subset).
// ---------------------------------------------------------------------------

/** HeaderUtils::split() for the shapes compiled apps meet. Quoted strings and
 *  whitespace around separators are respected; empty parts are dropped. */
export function phpHeaderSplit(header, separators) {
  if (!separators) throw new AuthError('At least one separator must be specified.');
  const sep = separators[0];
  const rest = separators.slice(1);
  const parts = splitHeaderLevel(phpTrim(String(header)), sep);
  const out = [];
  for (const part of parts) {
    if (part === '') continue;
    out.push(rest ? phpHeaderSplit(part, rest) : [part]);
  }
  return out;
}

function splitHeaderLevel(header, sep) {
  const out = [];
  let current = '';
  let inQuotes = false;
  let quotedComplete = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (inQuotes) {
      current += ch;
      if (ch === '\\' && i + 1 < header.length) {
        current += header[i + 1];
        i++;
      } else if (ch === '"') {
        inQuotes = false;
        quotedComplete = true;
      }
      continue;
    }
    if (ch === '"' && !quotedComplete) {
      inQuotes = true;
      current += ch;
      continue;
    }
    if (ch === sep) {
      out.push(phpTrim(current));
      current = '';
      quotedComplete = false;
      continue;
    }
    current += ch;
  }
  out.push(phpTrim(current));
  return out;
}

/** HeaderUtils::combine() subset: [name, value?] pairs -> attributes object. */
function combineHeaderPairs(pairs) {
  const out = {};
  for (const pair of pairs) {
    const name = pair[0];
    if (name === undefined) continue;
    out[name] = pair.length === 2 ? pair[1] : true;
  }
  return out;
}

function phpFloatCast(value) {
  if (typeof value === 'number') return value;
  if (value === true) return 1;
  if (value === false || value === null || value === undefined) return 0;
  const m = /^[ \t\n\r\v\f]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(String(value));
  return m ? parseFloat(m[1]) : 0;
}

/** PHP string coercion for attribute values (combine() yields `true` for bare
 *  flags; AcceptHeaderItem::setAttribute(string) coerces them to '1'). */
function phpAttrString(value) {
  if (typeof value === 'boolean') return value ? '1' : '';
  if (value === null || value === undefined) return '';
  return String(value);
}

class AcceptItem {
  constructor(value, attributes, index) {
    this.value = value;
    this.quality = Object.prototype.hasOwnProperty.call(attributes, 'q')
      ? phpFloatCast(attributes.q)
      : 1.0;
    this.attributes = {};
    for (const name of Object.keys(attributes)) {
      const lower = name.toLowerCase();
      if (lower === 'q') continue;
      this.attributes[lower] = phpAttrString(attributes[name]);
    }
    this.index = index;
    this.canonical = this.buildCanonicalKey();
  }

  /** AcceptHeader::getCanonicalKey(): media params (lowercased, q dropped)
   *  sorted by name, `name=value` joined with ';' (values quoted when they
   *  contain whitespace/;,=), appended to the raw value. */
  buildCanonicalKey() {
    const names = Object.keys(this.attributes).sort();
    const parts = [];
    for (const name of names) {
      const value = this.attributes[name];
      if (value === null) {
        parts.push(name);
        continue;
      }
      const quoted = /[\s;,=]/.test(value)
        ? '"' + value.replace(/["\\]/g, (m) => '\\' + m) + '"'
        : value;
      parts.push(name + '=' + quoted);
    }
    return this.value + (parts.length ? ';' + parts.join(';') : '');
  }

  /** AcceptHeaderItem::__toString() (debug parity; negotiation uses the
   *  canonical key, not this). */
  toString() {
    let str = this.value + (this.quality < 1 ? ';q=' + String(this.quality) : '');
    const entries = Object.entries(this.attributes);
    if (entries.length) {
      str += '; ' + entries.map(([key, value]) => key + '=' + value).join(';');
    }
    return str;
  }
}

/** AcceptHeader::fromString() subset -> AcceptItem[] (unsorted). */
export function parseAcceptHeader(headerValue) {
  const items = [];
  if (headerValue === null || headerValue === undefined) return items;
  const parts = phpHeaderSplit(phpStr(headerValue), ',;=');
  parts.forEach((pairs, index) => {
    const first = pairs.shift() ?? [''];
    items.push(new AcceptItem(first[0] ?? '', combineHeaderPairs(pairs), index));
  });
  return items;
}

/** AcceptHeader::all(): sorted by quality desc, first-seen order on ties. */
export function sortAcceptItems(items) {
  return [...items].sort((a, b) => (b.quality - a.quality) || (a.index - b.index));
}

/** Symfony Request::getAcceptableContentTypes():
 *  `array_map('strval', array_keys(AcceptHeader::fromString($h)->all()))`
 *  — i.e. the canonical keys (q stripped, params normalized, sorted by
 *  quality desc/index asc). Items sharing a canonical key collapse, the
 *  later one winning (array key overwrite in AcceptHeader::add()). */
export function getAcceptableContentTypes(request) {
  const byKey = new Map();
  for (const item of parseAcceptHeader(requestHeader(request, 'Accept'))) {
    byKey.set(item.canonical, item);
  }
  return sortAcceptItems([...byKey.values()]).map((item) => item.canonical);
}

function requestHeader(request, name) {
  if (!request || typeof request.header !== 'function') return null;
  const value = request.header(name);
  return value === undefined ? null : value;
}

/** Request::ajax(): X-Requested-With === 'XMLHttpRequest' (Symfony). */
export function requestAjax(request) {
  return requestHeader(request, 'X-Requested-With') === 'XMLHttpRequest';
}

/** Request::pjax(): X-PJAX == true (PHP loose comparison). */
export function requestPjax(request) {
  return phpTruthy(requestHeader(request, 'X-PJAX'));
}

/** Request::acceptsAnyContentType(). */
export function acceptsAnyContentType(request) {
  const acceptable = getAcceptableContentTypes(request);
  return acceptable.length === 0 || acceptable[0] === '*/*' || acceptable[0] === '*';
}

/** Request::wantsJson(): Str::contains(strtolower($accept[0]), ['/json', '+json']). */
export function requestWantsJson(request) {
  const acceptable = getAcceptableContentTypes(request);
  if (!acceptable.length) return false;
  const first = String(acceptable[0]).toLowerCase();
  return first.includes('/json') || first.includes('+json');
}

/** Request::expectsJson(). */
export function requestExpectsJson(request) {
  return (
    (requestAjax(request) && !requestPjax(request) && acceptsAnyContentType(request)) ||
    requestWantsJson(request)
  );
}

// ---------------------------------------------------------------------------
// Illuminate\Support\Timebox.
// ---------------------------------------------------------------------------

export class Timebox {
  constructor() {
    this.earlyReturn = false;
  }

  async call(callback, microseconds = 200000) {
    let exception = null;
    let result;
    const start = Date.now();
    try {
      result = await callback(this);
    } catch (caught) {
      exception = caught;
    }
    const remainder = Math.trunc(microseconds - (Date.now() - start) * 1000);
    if (!this.earlyReturn && remainder > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(remainder / 1000)));
    }
    if (exception !== null) throw exception;
    return result;
  }

  returnEarly() {
    this.earlyReturn = true;
    return this;
  }

  dontReturnEarly() {
    this.earlyReturn = false;
    return this;
  }
}

// ---------------------------------------------------------------------------
// Illuminate\Hashing\BcryptHasher (+ AbstractHasher::check / ::info).
// ---------------------------------------------------------------------------

const BCRYPT_2Y_RE = /^\$2y\$(\d{2})\$[./A-Za-z0-9]{53}$/;

export class BcryptHasher {
  constructor({ rounds = 12, verify = false, limit = null } = {}) {
    this.rounds = rounds;
    this.verifyAlgorithm = verify;
    this.limit = limit;
  }

  /** AbstractHasher::info() — password_get_info() as measured on PHP 8.3:
   *  only `$2y$NN$` is identified as bcrypt; `$2a$`/`$2b$`/`$2x$` and every
   *  other shape report algo null / 'unknown' / no options. */
  info(hashedValue) {
    const m = BCRYPT_2Y_RE.exec(phpStr(hashedValue));
    if (m) return { algo: '2y', algoName: 'bcrypt', options: { cost: parseInt(m[1], 10) } };
    return { algo: null, algoName: 'unknown', options: [] };
  }

  async make(value, options = {}) {
    if (this.limit) {
      const bytes = new TextEncoder().encode(phpStr(value)).length;
      if (bytes > this.limit) {
        throw new AuthError(
          `Value is too long to hash. Value must be less than ${this.limit} bytes.`,
          'InvalidArgumentException',
        );
      }
    }
    const salt = await bcrypt.genSalt(Number(this.cost(options)));
    const hash = await bcrypt.hash(phpStr(value), salt);
    if (!hash) throw new AuthError('Bcrypt hashing not supported.');
    // Laravel's hasher runs under PHP 8.3 where password_hash() emits `$2y$`.
    // bcryptjs emits `$2a$`; both are the same algorithm, but
    // password_get_info()/password_needs_rehash() treat `$2a$` as "unknown",
    // so the stored value MUST carry the `$2y$` prefix for 1:1 parity.
    return hash.replace(/^\$2[abxy]\$/, '$2y$');
  }

  async check(value, hashedValue, options = {}) {
    if (hashedValue === null || hashedValue === undefined || phpStr(hashedValue) === '') return false;
    if (this.verifyAlgorithm && !this.isUsingCorrectAlgorithm(hashedValue)) {
      throw new AuthError('This password does not use the Bcrypt algorithm.');
    }
    return bcrypt.compare(phpStr(value), phpStr(hashedValue));
  }

  /** password_needs_rehash($hashedValue, PASSWORD_BCRYPT, ['cost' => cost]). */
  needsRehash(hashedValue, options = {}) {
    const info = this.info(hashedValue);
    if (info.algoName !== 'bcrypt') return true;
    return info.options.cost !== Number(this.cost(options));
  }

  verifyConfiguration(hashedValue) {
    return this.isUsingCorrectAlgorithm(hashedValue) && this.isUsingValidOptions(hashedValue);
  }

  isUsingCorrectAlgorithm(hashedValue) {
    return this.info(hashedValue).algoName === 'bcrypt';
  }

  isUsingValidOptions(hashedValue) {
    const { options } = this.info(hashedValue);
    if (!Number.isInteger(options.cost)) return false;
    if (options.cost > this.rounds) return false;
    return true;
  }

  setRounds(rounds) {
    this.rounds = parseInt(rounds, 10);
    return this;
  }

  cost(options = {}) {
    return options.rounds ?? this.rounds;
  }
}

// ---------------------------------------------------------------------------
// Illuminate\Auth\Recaller.
// ---------------------------------------------------------------------------

const NON_STRING_MARKER = Symbol('php-unserialize-non-string');

/** PHP `@unserialize($value, ['allowed_classes' => false]) ?: $value` collapse
 *  for the shapes a recaller cookie can carry. Returns either the original
 *  string (parse failed / parsed falsy), a parsed non-empty string, or the
 *  NON_STRING_MARKER (parsed a truthy non-string — Recaller#properString()
 *  then fails and the login is rejected). */
export function phpUnserializeLenient(value) {
  if (typeof value !== 'string') return value;
  if (/^a:0:\{\}$/.test(value)) return value;
  if (/^a:[1-9][0-9]*:\{/.test(value)) return NON_STRING_MARKER;
  if (/^O:[0-9]+:"/.test(value)) return NON_STRING_MARKER;
  if (/^C:[0-9]+:"/.test(value)) return NON_STRING_MARKER;
  if (/^E:[0-9]+:"/.test(value)) return NON_STRING_MARKER;
  const strMatch = /^s:([0-9]+):"/.exec(value);
  if (strMatch) {
    const len = parseInt(strMatch[1], 10);
    const bytes = new TextEncoder().encode(value);
    const prefixBytes = new TextEncoder().encode(`s:${strMatch[1]}:"`).length;
    if (
      bytes.length >= prefixBytes + len + 2 &&
      bytes[prefixBytes + len] === 0x22 &&
      bytes[prefixBytes + len + 1] === 0x3b
    ) {
      const str = new TextDecoder().decode(bytes.slice(prefixBytes, prefixBytes + len));
      return str === '' ? value : str;
    }
    return value;
  }
  if (/^N;$/.test(value)) return value;
  if (/^b:0;$/.test(value)) return value;
  if (/^b:1;$/.test(value)) return NON_STRING_MARKER;
  if (/^i:-?0;$/.test(value)) return value;
  if (/^i:-?[0-9]+;$/.test(value)) return NON_STRING_MARKER;
  if (/^d:-?0(?:\.0*)?;$/.test(value)) return value;
  if (/^d:-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?;$/.test(value)) return NON_STRING_MARKER;
  if (/^d:(?:NAN|INF);$/.test(value)) return NON_STRING_MARKER;
  return value;
}

function phpExplodeLimit(value, delimiter, limit) {
  const parts = String(value).split(delimiter);
  if (!limit || parts.length <= limit) return parts;
  const head = parts.slice(0, limit - 1);
  head.push(parts.slice(limit - 1).join(delimiter));
  return head;
}

export class Recaller {
  constructor(recaller) {
    this.recaller = phpUnserializeLenient(recaller);
  }

  id() {
    return phpExplodeLimit(this.recaller, '|', 3)[0];
  }

  token() {
    return phpExplodeLimit(this.recaller, '|', 3)[1];
  }

  hash() {
    return phpExplodeLimit(this.recaller, '|', 4)[2];
  }

  valid() {
    return this.properString() && this.hasAllSegments();
  }

  properString() {
    return typeof this.recaller === 'string' && this.recaller.includes('|');
  }

  hasAllSegments() {
    const segments = String(this.recaller).split('|');
    const first = phpTrim(segments[0] ?? '');
    const second = phpTrim(segments[1] ?? '');
    return segments.length >= 3 && first !== '' && second !== '';
  }

  segments() {
    return String(this.recaller).split('|');
  }
}

// ---------------------------------------------------------------------------
// Illuminate\Auth\Authenticatable (trait -> applyAuthenticatable).
// ---------------------------------------------------------------------------

/** Applies the Authenticatable trait contract onto a compiled Model class.
 *  Existing methods are never overwritten (the compiler may emit overrides). */
export function applyAuthenticatable(ModelClass) {
  const proto = ModelClass.prototype;

  if (typeof proto.getKeyName !== 'function') {
    proto.getKeyName = function getKeyName() {
      return this.constructor.primaryKey ?? 'id';
    };
  }
  if (typeof proto.getAuthIdentifierName !== 'function') {
    proto.getAuthIdentifierName = function getAuthIdentifierName() {
      return this.getKeyName();
    };
  }
  if (typeof proto.getAuthIdentifier !== 'function') {
    proto.getAuthIdentifier = function getAuthIdentifier() {
      return this.get(this.getAuthIdentifierName()) ?? null;
    };
  }
  if (typeof proto.getAuthIdentifierForBroadcasting !== 'function') {
    proto.getAuthIdentifierForBroadcasting = function getAuthIdentifierForBroadcasting() {
      return this.getAuthIdentifier();
    };
  }
  if (typeof proto.getAuthPasswordName !== 'function') {
    proto.getAuthPasswordName = function getAuthPasswordName() {
      if (this.authPasswordName !== undefined) return this.authPasswordName;
      if (this.constructor.authPasswordName !== undefined) return this.constructor.authPasswordName;
      return 'password';
    };
  }
  if (typeof proto.getAuthPassword !== 'function') {
    proto.getAuthPassword = function getAuthPassword() {
      return this.get(this.getAuthPasswordName()) ?? null;
    };
  }
  if (typeof proto.getRememberTokenName !== 'function') {
    proto.getRememberTokenName = function getRememberTokenName() {
      if (this.rememberTokenName !== undefined) return this.rememberTokenName;
      if (this.constructor.rememberTokenName !== undefined) return this.constructor.rememberTokenName;
      return 'remember_token';
    };
  }
  if (typeof proto.getRememberToken !== 'function') {
    proto.getRememberToken = function getRememberToken() {
      const name = this.getRememberTokenName();
      if (phpFalsy(name)) return null;
      return phpStr(this.get(name));
    };
  }
  if (typeof proto.setRememberToken !== 'function') {
    proto.setRememberToken = function setRememberToken(value) {
      const name = this.getRememberTokenName();
      if (phpFalsy(name)) return;
      this.set(name, value);
    };
  }
  return ModelClass;
}

export const authenticatable = applyAuthenticatable;

// ---------------------------------------------------------------------------
// Illuminate\Auth\EloquentUserProvider.
// ---------------------------------------------------------------------------

export class EloquentUserProvider {
  constructor(hasher, model, db) {
    this.hasher = hasher;
    this.model = model;
    this.db = db;
    this.queryCallback = null;
  }

  async retrieveById(identifier) {
    const model = this.createModel();
    return this.newModelQuery(model).where(model.getAuthIdentifierName(), identifier).first();
  }

  async retrieveByToken(identifier, token) {
    const model = this.createModel();
    const found = await this.newModelQuery(model)
      .where(model.getAuthIdentifierName(), identifier)
      .first();
    if (found === null || found === undefined) return null;
    const rememberToken = found.getRememberToken();
    return (rememberToken && timingSafeEqual(rememberToken, token)) ? found : null;
  }

  async updateRememberToken(user, token) {
    user.setRememberToken(token);
    const timestamps = user.timestamps;
    user.timestamps = false;
    await user.save(this.db);
    user.timestamps = timestamps;
  }

  async retrieveByCredentials(credentials) {
    const filtered = {};
    for (const key of Object.keys(credentials || {})) {
      if (!String(key).includes('password')) filtered[key] = credentials[key];
    }
    if (Object.keys(filtered).length === 0) return null;
    const query = this.newModelQuery();
    for (const key of Object.keys(filtered)) {
      const value = filtered[key];
      if (Array.isArray(value)) {
        query.whereIn(key, value);
      } else if (typeof value === 'function') {
        value(query);
      } else {
        query.where(key, value);
      }
    }
    return query.first();
  }

  async validateCredentials(user, credentials) {
    const plain = credentials ? credentials.password : null;
    if (plain === null || plain === undefined) return false;
    const authPassword = user.getAuthPassword();
    if (authPassword === null || authPassword === undefined) return false;
    return this.hasher.check(plain, authPassword);
  }

  async rehashPasswordIfRequired(user, credentials, force = false) {
    if (!this.hasher.needsRehash(user.getAuthPassword()) && !force) return;
    user.forceFill({ [user.getAuthPasswordName()]: await this.hasher.make(credentials.password) });
    await user.save(this.db);
  }

  createModel() {
    return new this.model();
  }

  newModelQuery(model = null) {
    const base = model ?? this.createModel();
    const query = base.constructor.query(this.db);
    if (typeof this.queryCallback === 'function') this.queryCallback(query);
    return query;
  }

  getHasher() {
    return this.hasher;
  }

  setHasher(hasher) {
    this.hasher = hasher;
    return this;
  }

  getModel() {
    return this.model;
  }

  setModel(model) {
    this.model = model;
    return this;
  }

  getQueryCallback() {
    return this.queryCallback;
  }

  withQueryCallback(callback) {
    this.queryCallback = callback;
    return this;
  }
}

// ---------------------------------------------------------------------------
// Illuminate\Auth\Events (plain event objects, dispatched through `events`).
// ---------------------------------------------------------------------------

export const AuthEvents = {
  Attempting: 'Illuminate\\Auth\\Events\\Attempting',
  Validated: 'Illuminate\\Auth\\Events\\Validated',
  Login: 'Illuminate\\Auth\\Events\\Login',
  Authenticated: 'Illuminate\\Auth\\Events\\Authenticated',
  Failed: 'Illuminate\\Auth\\Events\\Failed',
  Logout: 'Illuminate\\Auth\\Events\\Logout',
  CurrentDeviceLogout: 'Illuminate\\Auth\\Events\\CurrentDeviceLogout',
  OtherDeviceLogout: 'Illuminate\\Auth\\Events\\OtherDeviceLogout',
};

const SESSION_GUARD_CLASS = 'Illuminate\\Auth\\SessionGuard';

// ---------------------------------------------------------------------------
// Illuminate\Auth\SessionGuard (+ GuardHelpers).
// ---------------------------------------------------------------------------

export class SessionGuard {
  /** Mirrors the PHP constructor signature one-for-one:
   *  ($name, UserProvider $provider, Session $session, ?Request $request,
   *   ?Timebox $timebox, bool $rehashOnLogin, int $timeboxDuration,
   *   ?string $hashKey) */
  constructor(
    name,
    provider,
    session,
    request = null,
    timebox = null,
    rehashOnLogin = true,
    timeboxDuration = 200000,
    hashKey = null,
  ) {
    this.name = name;
    this.provider = provider;
    this.session = session;
    this.request = request;
    this.timebox = timebox ?? new Timebox();
    this.rehashOnLogin = rehashOnLogin;
    this.timeboxDuration = timeboxDuration;
    this.hashKey = hashKey;
    // `user`/`viaRemember` are prototype methods (GuardHelpers); backing state
    // must live under different names or own properties shadow the methods.
    this._user = null;
    this.loggedOut = false;
    this.recallAttempted = false;
    this.lastAttempted = null;
    this._viaRemember = false;
    this.rememberDuration = 576000; // minutes, SessionGuard vendor default (400 days)
    this.cookieJar = null;
    this.events = null;
    this.hasher = null;
    this.strRandom = null;
  }

  // -- user resolution ------------------------------------------------------

  async user() {
    if (this.loggedOut) return null;
    if (this._user !== null) return this._user;

    const id = this.session.get(this.getName());
    if (id !== null && id !== undefined) {
      const found = await this.provider.retrieveById(id);
      if (found) {
        this._user = found;
        this.fireAuthenticatedEvent(found);
      }
    }

    if (this._user === null) {
      const recaller = this.recaller();
      if (recaller !== null) {
        this._user = await this.userFromRecaller(recaller);
        if (this._user) {
          await this.updateSession(this._user.getAuthIdentifier());
          this.fireLoginEvent(this._user, true);
        }
      }
    }

    return this._user ?? null;
  }

  async userFromRecaller(recaller) {
    if (!recaller.valid() || this.recallAttempted) return null;

    this.recallAttempted = true;

    const user = await this.provider.retrieveByToken(recaller.id(), recaller.token());
    this._viaRemember = user !== null && user !== undefined;

    if (!this._viaRemember) return null;

    const userPassword = user.getAuthPassword();
    if (typeof userPassword !== 'string') return null;

    const recallerHash = recaller.hash();
    return (
      timingSafeEqual(this.hashPasswordForCookie(userPassword), recallerHash) ||
      timingSafeEqual(userPassword, recallerHash)
    ) ? user : null;
  }

  recaller() {
    if (this.request === null || this.request === undefined) return null;
    const value = requestCookie(this.request, this.getRecallerName());
    if (phpTruthy(value)) return new Recaller(value);
    return null;
  }

  async id() {
    if (this.loggedOut) return null;
    const user = await this.user();
    return user ? user.getAuthIdentifier() : this.session.get(this.getName());
  }

  // -- login / logout -------------------------------------------------------

  async once(credentials = {}) {
    this.fireAttemptEvent(credentials);

    if (await this.validate(credentials)) {
      await this.rehashPasswordIfRequired(this.lastAttempted, credentials);
      this.setUser(this.lastAttempted);
      return true;
    }

    this.fireFailedEvent(this.lastAttempted, credentials);
    return false;
  }

  async onceUsingId(id) {
    const user = await this.provider.retrieveById(id);
    if (user !== null && user !== undefined) {
      this.setUser(user);
      return user;
    }
    return false;
  }

  async validate(credentials = {}) {
    const user = await this.provider.retrieveByCredentials(credentials);
    this.lastAttempted = user;
    return this.hasValidCredentials(user, credentials);
  }

  async hasValidCredentials(user, credentials) {
    const validated =
      user !== null && user !== undefined && (await this.provider.validateCredentials(user, credentials));
    if (validated) this.fireValidatedEvent(user);
    return validated;
  }

  async attempt(credentials = {}, remember = false) {
    return this.timebox.call(async (timebox) => {
      this.fireAttemptEvent(credentials, remember);
      const user = await this.provider.retrieveByCredentials(credentials);
      this.lastAttempted = user;

      if (await this.hasValidCredentials(user, credentials)) {
        await this.rehashPasswordIfRequired(user, credentials);
        await this.login(user, remember);
        timebox.returnEarly();
        return true;
      }

      this.fireFailedEvent(user, credentials);
      return false;
    }, this.timeboxDuration);
  }

  async attemptWhen(credentials = {}, callbacks = null, remember = false) {
    return this.timebox.call(async (timebox) => {
      this.fireAttemptEvent(credentials, remember);
      const user = await this.provider.retrieveByCredentials(credentials);
      this.lastAttempted = user;

      if ((await this.hasValidCredentials(user, credentials)) && (await this.shouldLogin(callbacks, user))) {
        await this.rehashPasswordIfRequired(user, credentials);
        await this.login(user, remember);
        timebox.returnEarly();
        return true;
      }

      this.fireFailedEvent(user, credentials);
      return false;
    }, this.timeboxDuration);
  }

  async shouldLogin(callbacks, user) {
    const list = callbacks === null || callbacks === undefined
      ? []
      : Array.isArray(callbacks) ? callbacks : [callbacks];
    for (const callback of list) {
      if (!(await callback(user, this))) return false;
    }
    return true;
  }

  async rehashPasswordIfRequired(user, credentials) {
    if (this.rehashOnLogin) {
      await this.provider.rehashPasswordIfRequired(user, credentials);
    }
  }

  async loginUsingId(id, remember = false) {
    const user = await this.provider.retrieveById(id);
    if (user !== null && user !== undefined) {
      await this.login(user, remember);
      return user;
    }
    return false;
  }

  async login(user, remember = false) {
    await this.updateSession(user.getAuthIdentifier());

    const passwordHash = user.getAuthPassword();
    if (phpTruthy(passwordHash)) {
      this.session.put('password_hash_' + this.name, this.hashPasswordForCookie(passwordHash));
    }

    if (remember) {
      this.ensureRememberTokenIsSet(user);
      this.queueRecallerCookie(user);
    }

    this.fireLoginEvent(user, remember);
    this.setUser(user);
  }

  async updateSession(id) {
    this.session.put(this.getName(), id);
    await this.session.regenerate(true);
  }

  ensureRememberTokenIsSet(user) {
    if (phpFalsy(user.getRememberToken())) {
      this.cycleRememberToken(user);
    }
  }

  queueRecallerCookie(user) {
    this.getCookieJar().queue(this.createRecaller(
      phpStr(user.getAuthIdentifier()) + '|' +
      phpStr(user.getRememberToken()) + '|' +
      this.hashPasswordForCookie(user.getAuthPassword()),
    ));
  }

  createRecaller(value) {
    return this.getCookieJar().make(this.getRecallerName(), value, this.getRememberDuration());
  }

  async cycleRememberToken(user) {
    const random = this.strRandom ?? ((length) => phpRandomString(length));
    const token = random(60);
    user.setRememberToken(token);
    await this.provider.updateRememberToken(user, token);
  }

  hashPasswordForCookie(passwordHash) {
    return hmacSha256Hex(passwordHash ?? '', this.hashKey ?? 'base-key-for-password-hash-mac');
  }

  async logout() {
    const user = await this.user();

    this.clearUserDataFromStorage();

    if (this._user !== null && this._user !== undefined && user !== null && !phpFalsy(user.getRememberToken())) {
      await this.cycleRememberToken(user);
    }

    this.fire(AuthEvents.Logout, { user });
    this._user = null;
    this.loggedOut = true;
  }

  async logoutCurrentDevice() {
    const user = await this.user();

    this.clearUserDataFromStorage();

    this.fire(AuthEvents.CurrentDeviceLogout, { user });
    this._user = null;
    this.loggedOut = true;
  }

  clearUserDataFromStorage() {
    this.session.remove(this.getName());
    this.getCookieJar().unqueue(this.getRecallerName());
    if (this.recaller() !== null) {
      this.getCookieJar().queue(this.getCookieJar().forget(this.getRecallerName()));
    }
  }

  async logoutOtherDevices(password) {
    if (!(await this.user())) return;

    await this.rehashUserPasswordForDeviceLogout(password);

    if (this.recaller() !== null || this.getCookieJar().hasQueued(this.getRecallerName())) {
      this.queueRecallerCookie(await this.user());
    }

    this.fire(AuthEvents.OtherDeviceLogout, { user: await this.user() });
  }

  async rehashUserPasswordForDeviceLogout(password) {
    const user = await this.user();
    if (!(await this.getHasher().check(password, user.getAuthPassword()))) {
      throw new AuthError(
        'The given password does not match the current password.',
        'InvalidArgumentException',
      );
    }

    await this.provider.rehashPasswordIfRequired(user, { password }, true);
  }

  // -- guard helpers --------------------------------------------------------

  async check() {
    return (await this.user()) !== null;
  }

  async guest() {
    return !(await this.check());
  }

  async authenticate() {
    const user = await this.user();
    if (user !== null && user !== undefined) return user;
    throw new AuthenticationException();
  }

  hasUser() {
    return this._user !== null;
  }

  getUser() {
    return this._user;
  }

  setUser(user) {
    this._user = user;
    this.loggedOut = false;
    this.fireAuthenticatedEvent(user);
    return this;
  }

  forgetUser() {
    this._user = null;
    return this;
  }

  getProvider() {
    return this.provider;
  }

  setProvider(provider) {
    this.provider = provider;
  }

  getLastAttempted() {
    return this.lastAttempted;
  }

  viaRemember() {
    return this._viaRemember;
  }

  // -- HTTP basic auth: not ported, fail loud ------------------------------

  async basic(..._args) {
    throw new AuthError(
      'SessionGuard::basic() (HTTP basic authentication) is not supported by the compiled rung.',
      'UnsupportedError',
    );
  }

  async onceBasic(..._args) {
    throw new AuthError(
      'SessionGuard::onceBasic() (HTTP basic authentication) is not supported by the compiled rung.',
      'UnsupportedError',
    );
  }

  // -- wiring / accessors ---------------------------------------------------

  getName() {
    return 'login_' + this.name + '_' + sha1Hex(SESSION_GUARD_CLASS);
  }

  getRecallerName() {
    return 'remember_' + this.name + '_' + sha1Hex(SESSION_GUARD_CLASS);
  }

  getRememberDuration() {
    return this.rememberDuration;
  }

  setRememberDuration(minutes) {
    this.rememberDuration = minutes;
    return this;
  }

  getCookieJar() {
    if (this.cookieJar === null) {
      throw new AuthError('Cookie jar has not been set.');
    }
    return this.cookieJar;
  }

  setCookieJar(jar) {
    this.cookieJar = jar;
  }

  getDispatcher() {
    return this.events;
  }

  setDispatcher(events) {
    this.events = events;
  }

  getHasher() {
    if (this.hasher !== null) return this.hasher;
    if (this.provider && typeof this.provider.getHasher === 'function') {
      return this.provider.getHasher();
    }
    throw new AuthError('Auth hasher is not configured.');
  }

  setHasher(hasher) {
    this.hasher = hasher;
  }

  getSession() {
    return this.session;
  }

  getRequest() {
    return this.request;
  }

  setRequest(request) {
    this.request = request;
  }

  getTimebox() {
    return this.timebox;
  }

  attempting(callback) {
    if (this.events && typeof this.events.listen === 'function') {
      this.events.listen(AuthEvents.Attempting, callback);
    }
    return this;
  }

  // -- events ---------------------------------------------------------------

  fire(className, props) {
    if (this.events === null) return;
    this.events.dispatch({ class: className, guard: this.name, ...props });
  }

  fireAttemptEvent(credentials, remember = false) {
    this.fire(AuthEvents.Attempting, { credentials, remember });
  }

  fireLoginEvent(user, remember = false) {
    this.fire(AuthEvents.Login, { user, remember });
  }

  fireValidatedEvent(user) {
    this.fire(AuthEvents.Validated, { user });
  }

  fireAuthenticatedEvent(user) {
    this.fire(AuthEvents.Authenticated, { user });
  }

  fireFailedEvent(user, credentials) {
    this.fire(AuthEvents.Failed, { user, credentials });
  }
}

function requestCookie(request, name) {
  const cookies = request.cookies;
  if (cookies === null || cookies === undefined) return null;
  if (typeof cookies.get === 'function') {
    const value = cookies.get(name);
    return value === undefined ? null : value;
  }
  return Object.prototype.hasOwnProperty.call(cookies, name) ? cookies[name] : null;
}

// ---------------------------------------------------------------------------
// Illuminate\Auth\AuthenticationException.
// ---------------------------------------------------------------------------

export class AuthenticationException extends Error {
  static redirectToCallback = null;

  constructor(message = 'Unauthenticated.', guards = [], redirectTo = null) {
    super(message);
    this.name = 'AuthenticationException';
    this._guards = guards;
    this._redirectTo = redirectTo;
  }

  guards() {
    return this._guards;
  }

  redirectTo(request) {
    if (phpTruthy(this._redirectTo)) return this._redirectTo;
    if (AuthenticationException.redirectToCallback) {
      return AuthenticationException.redirectToCallback(request);
    }
    return null;
  }

  static redirectUsing(callback) {
    AuthenticationException.redirectToCallback = callback;
  }
}

// ---------------------------------------------------------------------------
// Illuminate\Auth\AuthManager (session-driver subset) + createAuthManager.
// ---------------------------------------------------------------------------

export class AuthManager {
  constructor({
    config,
    db = null,
    session = null,
    request = null,
    cookieJar = null,
    events = null,
    hasher = null,
    strRandom = null,
    timeboxDuration = null,
    rehashOnLogin = null,
    hashKey = null,
    redirect = null,
  } = {}) {
    if (!config) throw new AuthError('createAuthManager requires the compiled config object.');
    this.config = config;
    this.db = db;
    this.session = session;
    this.request = request;
    this.cookieJar = cookieJar;
    this.events = events;
    this.hasher = hasher;
    this.strRandom = strRandom;
    this.timeboxDuration = timeboxDuration;
    this.rehashOnLogin = rehashOnLogin;
    this.hashKey = hashKey;
    this.redirect = redirect;
    this.guards = new Map();
    this.userResolver = (name = null) => this.guard(name).user();
  }

  /** shouldUse($name): enum_value($name) ?: default; setDefaultDriver. */
  shouldUse(name) {
    const driver = phpTruthy(name) ? name : this.getDefaultDriver();
    this.setDefaultDriver(driver);
    this.userResolver = (n = null) => this.guard(n).user();
    return this;
  }

  getDefaultDriver() {
    return this.config['auth.defaults.guard'];
  }

  setDefaultDriver(name) {
    this.config['auth.defaults.guard'] = name;
  }

  guard(name = null) {
    const guardName = name ?? this.getDefaultDriver();
    if (!this.guards.has(guardName)) {
      this.guards.set(guardName, this.resolve(guardName));
    }
    return this.guards.get(guardName);
  }

  resolve(name) {
    const config = this.config['auth.guards.' + name];
    if (!config) throw new AuthError(`Auth guard [${name}] is not defined.`, 'InvalidArgumentException');
    switch (config.driver) {
      case 'session':
        return this.createSessionDriver(name, config);
      default:
        throw new AuthError(
          `Auth driver [${config.driver}] is not supported by the compiled rung (session only).`,
          'UnsupportedError',
        );
    }
  }

  createSessionDriver(name, config) {
    const guard = new SessionGuard(
      name,
      this.createUserProvider(config.provider ?? null),
      this.session,
      null,
      null,
      this.rehashOnLogin ?? true,
      this.timeboxDuration ?? 200000,
      this.hashKey ?? null,
    );

    guard.strRandom = this.strRandom ?? ((length) => phpRandomString(length));

    if (this.cookieJar) guard.setCookieJar(this.cookieJar);
    if (this.events) guard.setDispatcher(this.events);
    if (this.request) guard.setRequest(this.request);
    if (this.hasher) guard.setHasher(this.hasher);
    if (config.remember !== undefined) guard.setRememberDuration(config.remember);

    return guard;
  }

  createUserProvider(provider = null) {
    const config = this.config['auth.providers.' + provider];
    if (!config) {
      throw new AuthError(`Auth user provider [${provider}] is not defined.`, 'InvalidArgumentException');
    }
    switch (config.driver) {
      case 'eloquent':
        return this.createEloquentProvider(config);
      default:
        throw new AuthError(
          `Auth user provider driver [${config.driver}] is not supported by the compiled rung (eloquent only).`,
          'UnsupportedError',
        );
    }
  }

  createEloquentProvider(config) {
    return new EloquentUserProvider(this.hasher, config.model, this.db);
  }

  // -- guard forwarders (what the Auth facade proxies) ----------------------

  user(name = null) {
    return this.guard(name).user();
  }

  check(name = null) {
    return this.guard(name).check();
  }

  guest(name = null) {
    return this.guard(name).guest();
  }

  id(name = null) {
    return this.guard(name).id();
  }

  authenticate(name = null) {
    return this.guard(name).authenticate();
  }

  attempt(credentials = {}, remember = false, name = null) {
    return this.guard(name).attempt(credentials, remember);
  }

  attemptWhen(credentials = {}, callbacks = null, remember = false, name = null) {
    return this.guard(name).attemptWhen(credentials, callbacks, remember);
  }

  once(credentials = {}, name = null) {
    return this.guard(name).once(credentials);
  }

  onceUsingId(id, name = null) {
    return this.guard(name).onceUsingId(id);
  }

  validate(credentials = {}, name = null) {
    return this.guard(name).validate(credentials);
  }

  login(user, remember = false, name = null) {
    return this.guard(name).login(user, remember);
  }

  loginUsingId(id, remember = false, name = null) {
    return this.guard(name).loginUsingId(id, remember);
  }

  logout(name = null) {
    return this.guard(name).logout();
  }

  logoutCurrentDevice(name = null) {
    return this.guard(name).logoutCurrentDevice();
  }

  logoutOtherDevices(password, name = null) {
    return this.guard(name).logoutOtherDevices(password);
  }

  hasUser(name = null) {
    return this.guard(name).hasUser();
  }

  getUser(name = null) {
    return this.guard(name).getUser();
  }

  setUser(user, name = null) {
    return this.guard(name).setUser(user);
  }

  forgetUser(name = null) {
    return this.guard(name).forgetUser();
  }
}

export function createAuthManager(options) {
  return new AuthManager(options);
}

// ---------------------------------------------------------------------------
// Illuminate\Auth\Middleware\Authenticate.
// ---------------------------------------------------------------------------

const AUTHENTICATE_CLASS = 'Illuminate\\Auth\\Middleware\\Authenticate';
const REDIRECT_IF_AUTHENTICATED_CLASS = 'Illuminate\\Auth\\Middleware\\RedirectIfAuthenticated';

export class Authenticate {
  static redirectToCallback = null;

  constructor(auth, _opts = {}) {
    this.auth = auth;
  }

  static using(guard, ...others) {
    return `${AUTHENTICATE_CLASS}:${[guard, ...others].join(',')}`;
  }

  async handle(request, next, ...guards) {
    await this.authenticate(request, guards);
    return next(request);
  }

  async authenticate(request, guards) {
    if (!guards.length) guards = [null];

    for (const guard of guards) {
      if (await this.auth.guard(guard).check()) {
        return this.auth.shouldUse(guard);
      }
    }

    await this.unauthenticated(request, guards);
  }

  async unauthenticated(request, guards) {
    throw new AuthenticationException(
      'Unauthenticated.',
      guards,
      requestExpectsJson(request) ? null : this.redirectTo(request),
    );
  }

  redirectTo(request) {
    if (Authenticate.redirectToCallback) {
      return Authenticate.redirectToCallback(request);
    }
    return null;
  }

  static redirectUsing(callback) {
    Authenticate.redirectToCallback = callback;
  }
}

// ---------------------------------------------------------------------------
// Illuminate\Auth\Middleware\RedirectIfAuthenticated.
// ---------------------------------------------------------------------------

export class RedirectIfAuthenticated {
  static redirectToCallback = null;

  constructor(auth, { redirect = null, routeRegistry = null } = {}) {
    this.auth = auth;
    this.redirect = redirect ?? ((url) => ({ status: 302, location: url }));
    this.routeRegistry = routeRegistry;
  }

  static using(guard, ...others) {
    return `${REDIRECT_IF_AUTHENTICATED_CLASS}:${[guard, ...others].join(',')}`;
  }

  async handle(request, next, ...guards) {
    const list = guards.length ? guards : [null];

    for (const guard of list) {
      if (await this.auth.guard(guard).check()) {
        return this.redirect(this.redirectTo(request));
      }
    }

    return next(request);
  }

  redirectTo(request) {
    return RedirectIfAuthenticated.redirectToCallback
      ? RedirectIfAuthenticated.redirectToCallback(request)
      : this.defaultRedirectUri();
  }

  defaultRedirectUri() {
    const registry = this.routeRegistry;
    if (registry) {
      for (const uri of ['dashboard', 'home']) {
        if (registry.has(uri)) return registry.route(uri);
      }
      const routes = registry.get('GET') ?? {};
      for (const uri of ['dashboard', 'home']) {
        if (routes[uri] !== undefined) return '/' + uri;
      }
    }
    return '/';
  }

  static redirectUsing(callback) {
    RedirectIfAuthenticated.redirectToCallback = callback;
  }
}

export default {
  AuthError,
  AuthEvents,
  AuthManager,
  Authenticate,
  AuthenticationException,
  BcryptHasher,
  EloquentUserProvider,
  Recaller,
  RedirectIfAuthenticated,
  SessionGuard,
  Timebox,
  acceptsAnyContentType,
  applyAuthenticatable,
  authenticatable,
  createAuthManager,
  getAcceptableContentTypes,
  parseAcceptHeader,
  phpHeaderSplit,
  phpUnserializeLenient,
  requestAjax,
  requestExpectsJson,
  requestPjax,
  requestWantsJson,
  sortAcceptItems,
};
