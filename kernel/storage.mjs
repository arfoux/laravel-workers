// kernel/storage.mjs — Storage (R2 or memory), with temporary (HMAC-signed) URLs
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function makeStorage({ r2, secret: cfgSecret, mem } = {}) {
  const isR2 = r2 && typeof r2.put === 'function';
  const base = isR2 ? {
    async put(key, body) { await r2.put(key, body); return key; },
    async get(key) { const obj = await r2.get(key); if (!obj) return null; return obj; },
    async delete(key) { await r2.delete(key); },
    url(key) { return '/r2/' + key; },
  } : {
    _mem: mem,
    async put(key, body) { mem.set(key, body); return key; },
    async get(key) { const v = mem.get(key); return v !== undefined ? { body: v } : null; },
    async delete(key) { mem.delete(key); },
    url(key) { return '/r2/' + key; },
  };

  // Laravel's Storage::get() returns the file *contents* (a string), not the
  // object handle — the compiled facade needs the text.
  async function getText(key) {
    const obj = await base.get(key);
    if (obj === null || obj === undefined) return null;
    if (typeof obj.text === 'function') return obj.text();
    if (typeof obj.body === 'string') return obj.body;
    if (obj.body !== undefined && obj.body !== null) return String(obj.body);
    return null;
  }

  // Laravel's Storage::exists() — a boolean, not a handle.
  async function exists(key) {
    const obj = await base.get(key);
    return obj !== null && obj !== undefined;
  }

  async function temporaryUrl(key, ttlMs, opts = {}) {
    const secret = (opts && opts.secret) !== undefined ? opts.secret : cfgSecret;
    if (!secret) throw new Error('storage temporaryUrl requires a secret');
    const ms = ttlMs !== undefined ? ttlMs : 0;
    const expires = Date.now() + ms;
    const sig = await hmacHex(secret, key + ':' + expires);
    return '/r2/' + key + '?expires=' + expires + '&sig=' + sig;
  }

  async function verifyTemporaryUrl(url, secretArg) {
    const secret = secretArg !== undefined ? secretArg : cfgSecret;
    if (!secret) throw new Error('storage verifyTemporaryUrl requires a secret');
    let u;
    try { u = new URL(url, 'http://local'); } catch { return false; }
    const path = u.pathname;
    const prefix = '/r2/';
    if (!path.startsWith(prefix)) return false;
    const key = decodeURIComponent(path.slice(prefix.length));
    const expires = Number(u.searchParams.get('expires'));
    const sig = u.searchParams.get('sig');
    if (!expires || !sig) return false;
    if (Date.now() > expires) return false;
    const expected = await hmacHex(secret, key + ':' + expires);
    return expected === sig;
  }

  return Object.assign({}, base, { temporaryUrl, verifyTemporaryUrl, getText, exists });
}

export function createStorage({ r2, secret } = {}) {
  const mem = new Map();
  return makeStorage({ r2, secret, mem });
}
export default { createStorage };
