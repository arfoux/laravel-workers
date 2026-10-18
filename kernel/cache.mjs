// kernel/cache.mjs — Cache (KV or memory+TTL), with tags
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
export default { createCache };
