// kernel/storage.mjs — Storage (R2, D1 or memory), with temporary (HMAC-signed) URLs
//
// The edge has no local filesystem, so Laravel's local disk needs a store:
//   - R2   (`env.R2`)  — the real object store; the worker uses it when bound.
//   - D1   (`env.DB`)  — the blob store: one row per object in `lw_blobs`.
//                        No extra Cloudflare product, no card: the free plan
//                        covers it (100k row writes/day, 5M row reads/day).
//   - memory          — tests only; the worker never falls back to it (the
//                        runtime fails loud instead of losing writes).
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// The D1 blob store: one row per object.
export const BLOB_TABLE = 'lw_blobs';
export const BLOB_DDL =
  'CREATE TABLE IF NOT EXISTS "' + BLOB_TABLE + '" (' +
  '"key" TEXT PRIMARY KEY, "body" TEXT NOT NULL, "size" INTEGER NOT NULL DEFAULT 0, ' +
  '"created_at" TEXT NOT NULL)';
// D1 caps a row at 2 MB; keep headroom for the row overhead.
export const MAX_BLOB_BYTES = 1500000;

// The table check is cached per D1 binding (one probe per isolate, not per
// request): the probe succeeds when the table exists, otherwise it is created.
const blobTableReady = new WeakMap();

async function ensureBlobTable(d1) {
  let ready = blobTableReady.get(d1);
  if (!ready) {
    ready = (async () => {
      try {
        await d1.prepare('SELECT 1 FROM "' + BLOB_TABLE + '" LIMIT 1').first();
      } catch {
        await d1.prepare(BLOB_DDL).run();
      }
    })();
    blobTableReady.set(d1, ready);
  }
  return ready;
}

function makeStorage({ r2, d1, secret: cfgSecret, mem } = {}) {
  const isR2 = r2 && typeof r2.put === 'function';
  const isD1 = !isR2 && d1 && typeof d1.prepare === 'function';
  const base = isR2 ? {
    kind: 'r2',
    prefix: '/r2/',
    // Laravel's FilesystemAdapter::put() returns a bool, not the path.
    async put(key, body) { await r2.put(key, body); return true; },
    async get(key) { const obj = await r2.get(key); if (!obj) return null; return obj; },
    async delete(key) {
      // Laravel's delete() answers false when the file was missing; R2's delete
      // is silent, so the existence is checked first (when the binding can).
      if (typeof r2.head === 'function') {
        const head = await r2.head(key);
        if (!head) return false;
      }
      await r2.delete(key);
      return true;
    },
    url(key) { return '/r2/' + key; },
  } : isD1 ? {
    kind: 'd1',
    prefix: '/storage/',
    async put(key, body) {
      await ensureBlobTable(d1);
      const text = typeof body === 'string' ? body : body === null || body === undefined ? '' : String(body);
      const size = new TextEncoder().encode(text).length;
      if (size > MAX_BLOB_BYTES) {
        throw new Error(
          'storage put: the object is ' + size + ' bytes - the D1 blob store holds at most ' +
            MAX_BLOB_BYTES + ' bytes per object (bind an R2 bucket for bigger files)'
        );
      }
      await d1
        .prepare('INSERT OR REPLACE INTO "' + BLOB_TABLE + '" ("key","body","size","created_at") VALUES (?,?,?,?)')
        .bind(key, text, size, new Date().toISOString())
        .run();
      return true;
    },
    async get(key) {
      await ensureBlobTable(d1);
      const row = await d1.prepare('SELECT "body" FROM "' + BLOB_TABLE + '" WHERE "key" = ?').bind(key).first();
      return row === null || row === undefined ? null : { body: row.body };
    },
    async delete(key) {
      await ensureBlobTable(d1);
      const info = await d1.prepare('DELETE FROM "' + BLOB_TABLE + '" WHERE "key" = ?').bind(key).run();
      const changes = Number(info && info.meta && info.meta.changes);
      // Laravel answers false when the file was missing.
      return Number.isFinite(changes) ? changes > 0 : true;
    },
    url(key) { return '/storage/' + key; },
  } : {
    kind: 'memory',
    prefix: '/r2/',
    _mem: mem,
    async put(key, body) { mem.set(key, body); return true; },
    async get(key) { const v = mem.get(key); return v !== undefined ? { body: v } : null; },
    async delete(key) { return mem.delete(key); },
    url(key) { return '/r2/' + key; },
  };

  // Laravel's Storage::get() returns the file *contents* (a string), not the
  // object handle — the compiled facade needs the text. A missing file is not
  // null: Laravel's FilesystemAdapter::get() throws UnableToReadFile (the
  // default `throwsExceptions`), so the compiled side fails loud too.
  async function getText(key) {
    const obj = await base.get(key);
    if (obj === null || obj === undefined) {
      throw new Error('storage get: the file "' + key + '" does not exist');
    }
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
    return base.prefix + key + '?expires=' + expires + '&sig=' + sig;
  }

  async function verifyTemporaryUrl(url, secretArg) {
    const secret = secretArg !== undefined ? secretArg : cfgSecret;
    if (!secret) throw new Error('storage verifyTemporaryUrl requires a secret');
    let u;
    try { u = new URL(url, 'http://local'); } catch { return false; }
    const path = u.pathname;
    const prefix = base.prefix;
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

export function createStorage({ r2, d1, secret } = {}) {
  const mem = new Map();
  return makeStorage({ r2, d1, secret, mem });
}
export default { createStorage };
