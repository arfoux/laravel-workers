// kernel/cache.mjs — Cache (KV or memory+TTL)
export function createCache({ kv, ttlMs = 60000 } = {}) {
  if (kv && typeof kv.get === 'function') {
    return {
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
  }
  const mem = new Map(); // key -> { value, exp }
  return {
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
}
export default { createCache };
