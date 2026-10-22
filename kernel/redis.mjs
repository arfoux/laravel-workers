// Redis store for the Cloudflare Workers edge.
//
// WHAT THIS COVERS
//   The subset of `Illuminate\Cache\RedisStore` that survives on top of D1:
//   get / set / del / exists / incr / decr / ttl / expire, plus the lazy
//   expiry sweep that DatabaseStore uses (kernel/cache.mjs many()).
//
// WHAT THE EDGE CANNOT DO
//   There is no Redis server here. `lw_redis` is a D1 table, so the commands
//   that need a server (pub/sub, streams, Lua, MULTI/pipeline) are REFUSED
//   loudly instead of silently degrading. See RedisUnsupportedError.
//
// WHY THE TTL SHAPES LOOK LIKE THIS
//   RedisStore::put() stores with SETEX and clamps the TTL:
//       $result = $this->connection()->setex(
//           $this->prefix.$key, (int) max(1, $seconds), $this->serialize($value)
//       );
//   (vendor/laravel/framework/src/Illuminate/Cache/RedisStore.php)
//   so a ttl of 0 or -5 means "one second", NOT "forever" and NOT "delete".
//   A NULL ttl takes the forever() path and is stored with expiration NULL.
//   That is deliberately different from DatabaseStore, where a non-positive
//   ttl forgets the key (Repository::put(), Cache/Repository.php:367-380):
//   RedisStore has no such branch, and we mirror RedisStore.
//
//   TTL answers are Redis's own: -2 when the key does not exist (or has just
//   expired), -1 when the key exists without an expiry, otherwise the
//   remaining seconds. Redis rounds the millisecond TTL to the nearest second
//   (`(ttl+500)/1000` in ttlGenericCommand), so 1500 ms of life answers 2.
//
// STORAGE
//   Values are tagged so PHP scalar types round-trip through the TEXT column:
//   `i:` integer, `s:` string, `j:` JSON for everything else. Redis itself
//   stores only strings; the tag is what keeps `get('k')` returning the same
//   type Laravel's serializer would. Bare numeric text is still accepted by
//   incr/decr so a row written by a real INCR remains readable.

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** DDL for the table this store expects. */
export const LW_REDIS_SCHEMA = `CREATE TABLE IF NOT EXISTS lw_redis (
  "key" TEXT PRIMARY KEY,
  "value" TEXT NOT NULL,
  "expiration" INTEGER
)`;

export class RedisUnsupportedError extends Error {
  constructor(command, reason) {
    super(`Redis ${command} is not supported by the lw_redis edge store: ${reason}`);
    this.name = 'RedisUnsupportedError';
    this.code = 'LW_REDIS_UNSUPPORTED';
    this.command = command;
  }
}

function encodeValue(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`lw_redis cannot store non-finite number ${String(value)}`);
    }
    if (Number.isInteger(value)) return `i:${value}`;
    return `j:${JSON.stringify(value)}`;
  }
  if (typeof value === 'string') return `s:${value}`;
  return `j:${JSON.stringify(value === undefined ? null : value)}`;
}

function decodeValue(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  switch (text.slice(0, 2)) {
    case 'i:':
      return Number(text.slice(2));
    case 's:':
      return text.slice(2);
    case 'j:':
      return JSON.parse(text.slice(2));
    default:
      // Untagged row (e.g. written by a real Redis INCRBY): Redis semantics
      // say GET returns the string.
      return text;
  }
}

function integerArgument(value, command) {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) {
    throw new Error(`ERR value is not an integer or out of range (${command} argument: ${String(value)})`);
  }
  return Math.trunc(n);
}

export class RedisStore {
  /**
   * @param {object} db D1 database handle (prepare/bind/all/run).
   * @param {object} [options]
   * @param {string} [options.table='lw_redis']
   * @param {string} [options.prefix=''] RedisStore's $prefix, prepended to keys.
   * @param {() => number} [options.now] Clock returning epoch milliseconds.
   */
  constructor(db, options = {}) {
    if (!db || typeof db.prepare !== 'function') {
      throw new TypeError('RedisStore requires a D1 database handle with prepare()');
    }
    const table = options.table || 'lw_redis';
    if (!IDENTIFIER.test(table)) throw new TypeError(`invalid lw_redis table name: ${table}`);
    this.db = db;
    this.table = table;
    this.prefix = options.prefix || '';
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  _key(key) {
    return this.prefix + String(key);
  }

  async _select(key) {
    const { results } = await this.db
      .prepare(`SELECT "value", "expiration" FROM ${this.table} WHERE "key" = ?`)
      .bind(this._key(key))
      .all();
    return (results && results[0]) || null;
  }

  async _upsert(key, value, expiration) {
    await this.db
      .prepare(
        `INSERT INTO ${this.table} ("key", "value", "expiration") VALUES (?, ?, ?)
         ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "expiration" = excluded."expiration"`
      )
      .bind(this._key(key), value, expiration)
      .run();
  }

  async _delete(key) {
    const res = await this.db
      .prepare(`DELETE FROM ${this.table} WHERE "key" = ?`)
      .bind(this._key(key))
      .run();
    return Number((res && res.meta && res.meta.changes) || 0);
  }

  /** Row that Redis would still answer for; expired rows are reaped here. */
  async _live(key) {
    const row = await this._select(key);
    if (!row) return null;
    const expiration = row.expiration === null || row.expiration === undefined ? null : Number(row.expiration);
    if (expiration !== null && expiration <= this.now()) {
      await this._delete(key);
      return null;
    }
    return { value: row.value, expiration };
  }

  /** RedisStore::get() — null when the key is missing or expired. */
  async get(key) {
    const row = await this._live(key);
    return row ? decodeValue(row.value) : null;
  }

  /**
   * RedisStore::put() — SETEX with `max(1, $seconds)`, or plain SET when ttl
   * is null/undefined (the forever() path).
   */
  async set(key, value, ttlSeconds = null) {
    const stored = encodeValue(value);
    const ttl = ttlSeconds === undefined || ttlSeconds === null ? null : integerArgument(ttlSeconds, 'SET');
    const expiration = ttl === null ? null : this.now() + Math.max(1, ttl) * 1000;
    await this._upsert(key, stored, expiration);
    return true;
  }

  /** Redis DEL — number of keys actually removed (0 or 1 here). */
  async del(key) {
    const row = await this._live(key);
    if (!row) return 0;
    return await this._delete(key) > 0 ? 1 : 0;
  }

  /** Redis EXISTS — 0 or 1. */
  async exists(key) {
    return (await this._live(key)) ? 1 : 0;
  }

  /** Redis TTL — -2 missing, -1 no expiry, otherwise remaining seconds. */
  async ttl(key) {
    const row = await this._live(key);
    if (!row) return -2;
    if (row.expiration === null) return -1;
    return Math.round((row.expiration - this.now()) / 1000);
  }

  /**
   * Redis EXPIRE — 1 when the key existed, 0 when it did not. A non-positive
   * ttl deletes the key (Redis does the same) and still answers 1.
   */
  async expire(key, seconds) {
    const ttl = integerArgument(seconds, 'EXPIRE');
    const row = await this._live(key);
    if (!row) return 0;
    if (ttl <= 0) {
      await this._delete(key);
      return 1;
    }
    await this.db
      .prepare(`UPDATE ${this.table} SET "expiration" = ? WHERE "key" = ?`)
      .bind(this.now() + ttl * 1000, this._key(key))
      .run();
    return 1;
  }

  /** RedisStore::increment() — Redis INCRBY, TTL preserved. */
  async incr(key, amount = 1) {
    return this._incrBy(key, integerArgument(amount, 'INCRBY'));
  }

  /** RedisStore::decrement() — Redis DECRBY, TTL preserved. */
  async decr(key, amount = 1) {
    return this._incrBy(key, -integerArgument(amount, 'DECRBY'));
  }

  async _incrBy(key, delta) {
    const row = await this._live(key);
    let current = 0;
    if (row) {
      const text = String(row.value);
      if (text.startsWith('i:')) current = Number(text.slice(2));
      else if (/^-?\d+$/.test(text)) current = Number(text);
      else throw new Error(`ERR value is not an integer or out of range (key ${this._key(key)})`);
      if (!Number.isSafeInteger(current)) {
        throw new Error(`ERR value is not an integer or out of range (key ${this._key(key)})`);
      }
    }
    const next = current + delta;
    if (!Number.isSafeInteger(next)) {
      throw new Error('ERR increment or decrement would overflow');
    }
    await this._upsert(key, `i:${next}`, row ? row.expiration : null);
    return next;
  }

  // --- Commands that need a real Redis server ---------------------------

  publish() {
    throw new RedisUnsupportedError('PUBLISH', 'D1 has no pub/sub channels; use Cloudflare Queues or Durable Objects to fan out.');
  }

  subscribe() {
    throw new RedisUnsupportedError('SUBSCRIBE', 'D1 cannot hold a long-lived subscription socket; use Cloudflare Queues or Durable Objects.');
  }

  xadd() {
    throw new RedisUnsupportedError('XADD', 'D1 has no stream type; use a table with an autoincrement column or Cloudflare Queues.');
  }

  eval() {
    throw new RedisUnsupportedError('EVAL', 'there is no Lua runtime on the edge for this store; express the operation as SQL.');
  }

  pipeline() {
    throw new RedisUnsupportedError('PIPELINE', 'D1 has no MULTI/pipeline; batch the statements explicitly with db.batch().');
  }
}

export default RedisStore;
