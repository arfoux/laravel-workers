// kernel/cache.mjs — Cache (KV or memory+TTL), with tags
//
// Also ports Laravel's `database` cache store (Illuminate\Cache\DatabaseStore,
// 13.37) to D1 — the driver the compiled rung uses for `throttle:n,m` and the
// `Cache` facade. Semantics mirror the vendor line-for-line:
//   - keys are prefixed inside the store (Repository::itemKey is the identity);
//   - values are `serialize()`d, and a NUL byte triggers base64 (the SQLite /
//     Postgres rule — compare `Illuminate\Cache\DatabaseStore::serialize`);
//   - expiration is an integer second timestamp; expired rows are read-then-deleted;
//   - `add` is INSERT OR IGNORE, `put` is an upsert, `forever` is +315360000s.
// Known divergence: D1 has no interactive transactions, so increment/decrement
// are a read-then-write (Laravel wraps them in a transaction). Documented in COMPILED.md.
import { phpSerialize, phpUnserialize } from './php-serialize.mjs';

/** Illuminate\Cache\Repository::FLEXIBLE_CREATED_KEY_PREFIX */
export const FLEXIBLE_CREATED_KEY_PREFIX = 'illuminate:cache:flexible:created:';
const FOREVER_SECONDS = 315360000;

/** PHP is_numeric() for the value shapes a cache row can hold. */
function phpIsNumericValue(value) {
  if (typeof value === 'number') return true;
  if (typeof value === 'string') {
    return /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(value);
  }
  return false;
}

/** PHP (int) cast for the value shapes a cache row can hold. */
function phpIntCastValue(value) {
  if (value === null || value === undefined || value === false) return 0;
  if (value === true) return 1;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === 'string') {
    const m = /^[ \t\n\r\v\f]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(value);
    if (!m) return 0;
    const n = /[.eE]/.test(m[1]) ? parseFloat(m[1]) : parseInt(m[1], 10);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

function phpValue(value) {
  return typeof value === 'function' ? value() : value;
}

// PHP base64_encode/decode over the byte string. phpSerialize emits raw bytes as
// one-code-unit-per-byte; mask to keep the base64 alphabet on the original bytes.
function base64EncodeBytes(str) {
  let bin = '';
  for (let i = 0; i < str.length; i++) bin += String.fromCharCode(str.charCodeAt(i) & 0xff);
  return btoa(bin);
}
function base64DecodeBytes(b64) {
  const bin = atob(String(b64));
  return bin;
}

/**
 * Illuminate\Cache\DatabaseStore (+ the Repository-level methods the kernel's
 * RateLimiter calls: get/has/put/add/increment/decrement/forever/forget).
 *
 * @param {object} db                 D1 binding (prepare/bind/all/first/run)
 * @param {object} [options]
 * @param {string} [options.table]     cache table (default "cache")
 * @param {string} [options.prefix]    cache key prefix (config cache.prefix)
 * @param {string} [options.lockTable] cache_locks table
 * @param {() => number} [options.clock] integer-second clock
 */
export class DatabaseCacheStore {
  constructor(db, options = {}) {
    if (!db || typeof db.prepare !== 'function') {
      throw new Error('DatabaseCacheStore: a D1 binding is required');
    }
    this.db = db;
    this.table = options.table || 'cache';
    this.prefix = options.prefix || '';
    this.lockTable = options.lockTable || 'cache_locks';
    this._clock = typeof options.clock === 'function' ? options.clock : () => Math.floor(Date.now() / 1000);
  }

  getPrefix() {
    return this.prefix;
  }
  setPrefix(prefix) {
    this.prefix = String(prefix);
    return this;
  }
  /** InteractsWithTime::currentTime() */
  currentTime() {
    return this._clock();
  }

  /** DatabaseStore::serialize() — base64 when the payload carries a NUL byte. */
  _serialize(value) {
    const result = phpSerialize(value);
    return result.includes('\u0000') ? base64EncodeBytes(result) : result;
  }
  /** DatabaseStore::unserialize() — a value with no ":" / ";" is base64. */
  _unserialize(value) {
    let v = String(value);
    if (!v.includes(':') && !v.includes(';')) v = base64DecodeBytes(v);
    return phpUnserialize(v);
  }

  async many(keys) {
    const out = {};
    for (const k of keys) out[k] = null;
    if (keys.length === 0) return out;
    const prefixed = keys.map((k) => this.prefix + k);
    const placeholders = prefixed.map(() => '?').join(', ');
    const { results } = await this.db
      .prepare(`SELECT "key", "value", "expiration" FROM ${this.table} WHERE "key" IN (${placeholders})`)
      .bind(...prefixed)
      .all();
    const now = this.currentTime();
    const live = new Map();
    const expired = [];
    for (const row of results || []) {
      if (row.expiration > now) live.set(row.key, row);
      else expired.push(row.key);
    }
    if (expired.length) await this._forgetManyIfExpired(expired);
    for (const k of keys) {
      const row = live.get(this.prefix + k);
      if (row) out[k] = this._unserialize(row.value);
    }
    return out;
  }

  /** Repository::get(key, default) */
  async get(key, defaultValue = null) {
    const value = (await this.many([key]))[key];
    return value === null ? phpValue(defaultValue) : value;
  }

  /** Repository::has(key) — ! is_null(get(key)) */
  async has(key) {
    return (await this.get(key)) !== null;
  }

  /** DatabaseStore::putMany() — one upsert per row (D1 has no multi-row upsert). */
  async putMany(values, seconds) {
    const expiration = this.currentTime() + phpIntCastValue(seconds);
    let changes = 0;
    for (const [key, value] of Object.entries(values)) {
      const res = await this.db
        .prepare(
          `INSERT INTO ${this.table} ("key", "value", "expiration") VALUES (?, ?, ?)
           ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "expiration" = excluded."expiration"`
        )
        .bind(this.prefix + key, this._serialize(value), expiration)
        .run();
      changes += Number((res && res.meta && res.meta.changes) || 0);
    }
    return changes > 0;
  }

  /** DatabaseStore::put() */
  async put(key, value, seconds) {
    return this.putMany({ [key]: value }, seconds);
  }

  /** DatabaseStore::add() — INSERT OR IGNORE, false when the key already lives. */
  async add(key, value, seconds) {
    if ((await this.get(key)) !== null) return false;
    const res = await this.db
      .prepare(`INSERT OR IGNORE INTO ${this.table} ("key", "value", "expiration") VALUES (?, ?, ?)`)
      .bind(this.prefix + key, this._serialize(value), this.currentTime() + phpIntCastValue(seconds))
      .run();
    return Number((res && res.meta && res.meta.changes) || 0) > 0;
  }

  /** DatabaseStore::forever() */
  async forever(key, value) {
    return this.put(key, value, FOREVER_SECONDS);
  }

  /** DatabaseStore::increment() */
  async increment(key, amount = 1) {
    return this._incrementOrDecrement(key, amount, (current, by) => current + by);
  }

  /** DatabaseStore::decrement() */
  async decrement(key, amount = 1) {
    return this._incrementOrDecrement(key, amount, (current, by) => current - by);
  }

  async _incrementOrDecrement(key, amount, callback) {
    const prefixed = this.prefix + key;
    const row = await this.db
      .prepare(`SELECT "value" FROM ${this.table} WHERE "key" = ?`)
      .bind(prefixed)
      .first();
    if (row === null || row === undefined) return false;
    const current = this._unserialize(row.value);
    const next = callback(phpIntCastValue(current), phpIntCastValue(amount));
    if (!phpIsNumericValue(current)) return false;
    await this.db
      .prepare(`UPDATE ${this.table} SET "value" = ? WHERE "key" = ?`)
      .bind(this._serialize(next), prefixed)
      .run();
    return next;
  }

  /** DatabaseStore::remember() — get or compute+store. */
  async remember(key, seconds, callback) {
    const value = await this.get(key);
    if (value !== null) return value;
    const result = typeof callback === 'function' ? await callback() : callback;
    await this.put(key, result, seconds);
    return result;
  }

  /** Repository::pull() — get then forget. */
  async pull(key, defaultValue = null) {
    const value = await this.get(key);
    await this.forget(key);
    return value === null ? phpValue(defaultValue) : value;
  }
  /** DatabaseStore::forget() — also clears the flexible-created marker. */
  async forget(key) {
    const keys = [this.prefix + key, this.prefix + FLEXIBLE_CREATED_KEY_PREFIX + key];
    await this.db
      .prepare(`DELETE FROM ${this.table} WHERE "key" IN (?, ?)`)
      .bind(...keys)
      .run();
    return true;
  }

  async _forgetManyIfExpired(prefixedKeys) {
    const keys = [];
    for (const k of prefixedKeys) {
      keys.push(k);
      const bare = k.startsWith(this.prefix) ? k.slice(this.prefix.length) : k;
      keys.push(this.prefix + FLEXIBLE_CREATED_KEY_PREFIX + bare);
    }
    const placeholders = keys.map(() => '?').join(', ');
    await this.db
      .prepare(`DELETE FROM ${this.table} WHERE "key" IN (${placeholders}) AND "expiration" <= ?`)
      .bind(...keys, this.currentTime())
      .run();
    return true;
  }

  /** DatabaseStore::touch() */
  async touch(key, seconds) {
    const now = this.currentTime();
    const res = await this.db
      .prepare(`UPDATE ${this.table} SET "expiration" = ? WHERE "key" = ? AND "expiration" > ?`)
      .bind(now + phpIntCastValue(seconds), this.prefix + key, now)
      .run();
    return Number((res && res.meta && res.meta.changes) || 0) > 0;
  }

  /** DatabaseStore::flush() */
  async flush() {
    await this.db.prepare(`DELETE FROM ${this.table}`).run();
    return true;
  }
}

/**
 * Build the D1-backed cache store from the flat generated config
 * (cache.driver / cache.table / cache.prefix / cache.lock_table).
 */
export function createDatabaseCache({ db, config = {}, clock } = {}) {
  return new DatabaseCacheStore(db, {
    table: config['cache.table'] || 'cache',
    prefix: config['cache.prefix'] || '',
    lockTable: config['cache.lock_table'] || 'cache_locks',
    clock,
  });
}

function normalizeTags(names) {
  if (typeof names === 'string') names = [names];
  if (!Array.isArray(names) || names.length === 0) throw new Error('tags requires a non-empty array');
  return names.map(n => String(n));
}

export function createCache({ kv, ttlMs = 60000, secret } = {}) {
  let base;
  let readIndex, writeIndex;

  if (kv && typeof kv.get === 'function') {
    base = {
      async get(key) { const v = await kv.get(key, 'text'); return v === null ? null : JSON.parse(v); },
      async put(key, value, ttl) {
        const opts = ttl ? { expirationTtl: Math.ceil(ttl / 1000) } : undefined;
        await kv.put(key, JSON.stringify(value), opts);
      },
      async forget(key) { await kv.delete(key); },
      async remember(key, ttl, cb) {
        const hit = await kv.get(key, 'text');
        if (hit !== null) return JSON.parse(hit);
        const val = await cb();
        await kv.put(key, JSON.stringify(val), { expirationTtl: Math.ceil(ttl / 1000) });
        return val;
      },
    };
    readIndex = async (tag) => {
      const v = await kv.get('_tc:' + tag, 'text');
      if (v === null) return new Set();
      try { return new Set(JSON.parse(v)); } catch { return new Set(); }
    };
    writeIndex = async (tag, set) => {
      if (set.size === 0) await kv.delete('_tc:' + tag);
      else await kv.put('_tc:' + tag, JSON.stringify([...set]));
    };
  } else {
    const mem = new Map(); // key -> { value, exp }
    base = {
      _mem: mem,
      async get(key) {
        const e = mem.get(key);
        if (!e) return null;
        if (e.exp !== null && Date.now() > e.exp) { mem.delete(key); return null; }
        return e.value;
      },
      async put(key, value, ttl) {
        const ms = ttl !== undefined ? ttl : ttlMs;
        const exp = ms ? Date.now() + ms : null;
        mem.set(key, { value, exp });
      },
      async forget(key) { mem.delete(key); },
      async remember(key, ttl, cb) {
        const hit = await this.get(key);
        if (hit !== null) return hit;
        const val = await cb();
        await this.put(key, val, ttl);
        return val;
      },
    };
    const tagIndex = new Map();
    readIndex = async (tag) => tagIndex.get(tag) || new Set();
    writeIndex = async (tag, set) => {
      if (set.size === 0) tagIndex.delete(tag);
      else tagIndex.set(tag, new Set(set));
    };
  }

  function makeView(tags) {
    return {
      async get(key) { return base.get(key); },
      async put(key, value, ttl) {
        await base.put(key, value, ttl);
        for (const tag of tags) {
          const idx = await readIndex(tag);
          idx.add(key);
          await writeIndex(tag, idx);
        }
      },
      async forget(key) {
        await base.forget(key);
        for (const tag of tags) {
          const idx = await readIndex(tag);
          if (idx.delete(key)) await writeIndex(tag, idx);
        }
      },
      async remember(key, ttl, cb) {
        const hit = await base.get(key);
        if (hit !== null) return hit;
        const val = await cb();
        await this.put(key, val, ttl);
        return val;
      },
      async flush() {
        const keys = new Set();
        for (const tag of tags) {
          const idx = await readIndex(tag);
          for (const k of idx) keys.add(k);
        }
        for (const k of keys) await base.forget(k);
        for (const tag of tags) await writeIndex(tag, new Set());
      },
    };
  }

  const cache = Object.assign({}, base, {
    tags(names) {
      const tags = normalizeTags(names);
      return makeView(tags);
    },
  });
  // preserve _mem/_store refs already in base spread
  return cache;
}
export default { createCache, DatabaseCacheStore, createDatabaseCache };
