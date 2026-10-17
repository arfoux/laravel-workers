// kernel/storage.mjs — Workers Storage padanan (M7). R2 or memory.
export function createStorage({ r2 } = {}) {
  if (r2 && typeof r2.put === 'function') {
    return {
      async put(key, body) { await r2.put(key, body); return key; },
      async get(key) { const obj = await r2.get(key); if (!obj) return null; return obj; },
      async delete(key) { await r2.delete(key); },
      url(key) { return '/r2/' + key; },
    };
  }
  const mem = new Map();
  return {
    _mem: mem,
    async put(key, body) { mem.set(key, body); return key; },
    async get(key) { const v = mem.get(key); return v !== undefined ? { body: v } : null; },
    async delete(key) { mem.delete(key); },
    url(key) { return '/r2/' + key; },
  };
}
export default { createStorage };
