// kernel/packages/webpush-crypto.mjs — Web Push encryption (RFC 8291) + VAPID
// authentication (RFC 8292) primitives for the webpush notification port.
//
// Parity target: Laravel's `laravel-notification-channels/webpush` (the
// `WebPushChannel`). That channel encrypts a payload to a browser subscription
// (ECDH P-256 + HKDF + AES-128-GCM, the `aes128gcm` content encoding) and
// authenticates the request with a VAPID JWT (ES256). Both are pure WebCrypto
// on the edge, so they port 1:1 — no socket, no long-running work.
//
// Edge disclosure: NONE algorithmic. The one real constraint is that a
// service worker + PushManager live in the BROWSER, not the Worker — the
// subscription (endpoint + p256dh + auth keys) must already have been created
// client-side and stored (D1 `webpush_subscriptions`). This helper does the
// server-side encrypt + VAPID sign only.
//
// Exports:
//   encryptAes128Gcm(authSecret, serverKeys, payload) -> { ciphertext: Uint8Array }
//   buildVapidHeader(endpoint, vapidPriv, subject)     -> Promise<string>  // "vapid t=.., k=.."
//   vapidPublicKeyBase64url(vapidPriv)                 -> Promise<string>  // for key rotation/UI
import { resolveFetch } from './notify-http.mjs';
import { b64url as b64urlFromBytes, b64urlToBytes } from './b64url.mjs';

// Re-exported: these were this module's public surface before the shared
// `b64url.mjs` existed; keep the names importable from here.
export { b64urlFromBytes, b64urlToBytes };

function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// --- P-256 scalar math (to derive the VAPID public key from its 32-byte scalar)
// WebCrypto cannot import an EC PRIVATE key without the matching public x/y, and
// VAPID keys are conventionally stored as just the base64url private scalar. We
// therefore derive the public point G*d ourselves. Only used by the VAPID path.

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const A = P - 3n;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

function modP(x) { return ((x % P) + P) % P; }
function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}
function modInverse(a) { return modPow(modP(a), P - 2n, P); }

// Affine point add. Points are [x, y] bigints; null = point at infinity.
function pointAdd(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  if (x1 === x2 && modP(y1 + y2) === 0n) return null;
  let lam;
  if (x1 === x2 && y1 === y2) {
    lam = modP(3n * x1 * x1 + A) * modInverse(2n * y1) % P;
  } else {
    lam = modP(y2 - y1) * modInverse(modP(x2 - x1)) % P;
  }
  const x3 = modP(lam * lam - x1 - x2);
  const y3 = modP(lam * (x1 - x3) - y1);
  return [x3, y3];
}

function scalarMult(k, point) {
  let result = null;
  let addend = point;
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    k >>= 1n;
  }
  return result;
}

function bigIntTo32(n) {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i -= 1) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

// Derive the uncompressed P-256 public key (65 bytes, 0x04||X||Y) from a
// 32-byte private scalar.
function deriveP256Public(privateScalarBytes) {
  let d = 0n;
  for (const b of privateScalarBytes) d = (d << 8n) | BigInt(b);
  const [x, y] = scalarMult(d, [GX, GY]);
  return concatBytes(Uint8Array.of(0x04), bigIntTo32(x), bigIntTo32(y));
}

// --- RFC 8291: aes128gcm content encoding ----------------------------------

const RECORD_SIZE = 4096; // rs; single record for typical notification payloads

function lengthPrefix(bytes) {
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

// Encrypt `payload` to a browser subscription. Returns the full `aes128gcm`
// request body (header + ciphertext) as a Uint8Array.
//
// authSecret : base64url string — the subscription's `auth` (16 bytes).
// serverKeys : {
//   clientPublicKey    : Uint8Array — raw uncompressed P-256 (subscription `p256dh`),
//   ephemeralPrivateKey: CryptoKey  — the server's ephemeral ECDH private key,
//   ephemeralPublicKey : Uint8Array — matching raw uncompressed public (65 bytes),
// }
// payload    : string | Uint8Array.
export async function encryptAes128Gcm(authSecret, serverKeys, payload) {
  const auth = b64urlToBytes(authSecret);
  const clientPub = serverKeys.clientPublicKey;
  const ephPriv = serverKeys.ephemeralPrivateKey;
  const ephPub = serverKeys.ephemeralPublicKey;
  const plaintext = typeof payload === 'string' ? new TextEncoder().encode(payload) : Uint8Array.from(payload);

  // 1. ECDH shared secret (ephemeral private x client public).
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importRawP256(clientPub) },
      ephPriv,
      256,
    ),
  );

  // 2. Fresh salt for this message.
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 3. HKDF: IKM = concat(shared, auth); PRK = HKDF-Extract(salt, IKM).
  //    WebCrypto folds extract+expand into one deriveBits per output.
  const ikm = concatBytes(shared, auth);
  const hkdfKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  // context = length_prefixed(ephemeral_public_key)  (aes128gcm: only the ephemeral key)
  const context = lengthPrefix(ephPub);

  const cek = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF', hash: 'SHA-256', salt,
        info: concatBytes(new TextEncoder().encode('Content-Encoding: aes128gcm'), Uint8Array.of(0x00), context),
      },
      hkdfKey, 128,
    ),
  );
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF', hash: 'SHA-256', salt,
        info: concatBytes(new TextEncoder().encode('Content-Encoding: nonce'), Uint8Array.of(0x00), context),
      },
      hkdfKey, 96,
    ),
  );

  // 4. Pad plaintext: payload || 0x02 || zeros to (rs - 16).
  const block = new Uint8Array(RECORD_SIZE - 16);
  block.set(plaintext, 0);
  block[plaintext.length] = 0x02;

  // 5. AES-128-GCM encrypt (no additional authenticated data).
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, block),
  );

  // 6. Header: salt(16) || rs(4, BE) || keyid_len(1) || ephemeral_pub.
  const header = concatBytes(
    salt,
    Uint8Array.of(
      (RECORD_SIZE >> 24) & 0xff, (RECORD_SIZE >> 16) & 0xff,
      (RECORD_SIZE >> 8) & 0xff, RECORD_SIZE & 0xff,
    ),
    Uint8Array.of(ephPub.length),
    ephPub,
  );
  return { ciphertext: concatBytes(header, ct) };
}

async function importRawP256(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

// --- RFC 8292: VAPID JWT (ES256) -------------------------------------------

// WebCrypto's ECDSA `sign` emits the signature as a raw r||s octet string
// (IEEE P1363, 64 bytes for P-256) — the exact ES256 JWS form. A few older
// engines returned ASN.1 DER instead; detect and convert those. No-op on the
// already-raw form.
//
// LENGTH IS THE DISCRIMINATOR, and it has to be: a raw r||s signature starts
// with a random byte, so 1 in 256 of them starts with 0x30 — the DER SEQUENCE
// tag. Reading one of those as DER threw 'bad ECDSA sig' (which the webpush
// port turns into a 500), or, when the following raw bytes happened to look
// like DER integers, silently returned a truncated/garbage signature. A raw
// P-256 signature is exactly 64 bytes and DER for the same curve is 70-72, so
// `length === 64` is raw, full stop. (This is the flake behind the red
// `ci` run on main 2026-11-11, run 43032251265: 1 failure in 2040 tests.)
export function toRawSignature(sig) {
  const der = sig;
  if (der.length === 64) return der; // the r||s form itself, whatever the bytes
  if (der.length >= 8 && der[0] === 0x30) {
    let idx = 2; // skip 0x30 + total len
    if (der[idx] !== 0x02) throw new Error('bad ECDSA sig');
    idx += 1;
    const rlen = der[idx]; idx += 1;
    const r = der.slice(idx, idx + rlen); idx += rlen;
    if (der[idx] !== 0x02) throw new Error('bad ECDSA sig');
    idx += 1;
    const slen = der[idx]; idx += 1;
    const s = der.slice(idx, idx + slen); idx += slen;
    // Both integers consumed and nothing left over: a DER signature that does
    // not add up is a broken signature, not something to decode best-effort.
    if (r.length > 33 || s.length > 33 || idx !== der.length) {
      throw new Error('bad ECDSA sig');
    }
    // Right-align each INTEGER's value in 32 bytes. The offset is measured from
    // the SLICED value: a DER INTEGER that carried a 0x00 pad is 33 bytes, so
    // `32 - r.length` was -1 and `set()` threw a RangeError for any r (or s)
    // with the high bit set — half of all real signatures.
    const rRaw = r.slice(-32);
    const sRaw = s.slice(-32);
    const rOut = new Uint8Array(32); rOut.set(rRaw, 32 - rRaw.length);
    const sOut = new Uint8Array(32); sOut.set(sRaw, 32 - sRaw.length);
    return concatBytes(rOut, sOut);
  }
  return sig;
}

// Build and sign the VAPID JWT for an endpoint. Returns the full
// `Authorization: vapid t=<jwt>, k=<base64url public key>` header value.
//
// vapidPriv : base64url string — the 32-byte VAPID private scalar.
// subject   : a `mailto:` or `https:` contact URI (required by RFC 8292).
export async function buildVapidHeader(endpoint, vapidPriv, subject, { now = Math.floor(Date.now() / 1000) } = {}) {
  const endpointUrl = new URL(endpoint);
  const aud = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const privBytes = b64urlToBytes(vapidPriv);
  const pubBytes = deriveP256Public(privBytes);

  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64urlFromBytes(pubBytes.slice(1, 33)),
    y: b64urlFromBytes(pubBytes.slice(33, 65)),
    d: b64urlFromBytes(privBytes),
  };
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );

  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp: now + 12 * 3600, sub: subject };
  const signingInput = `${b64urlFromBytes(new TextEncoder().encode(JSON.stringify(header)))}.${b64urlFromBytes(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput)),
  );
  const jwt = `${signingInput}.${b64urlFromBytes(toRawSignature(sig))}`;
  return `vapid t=${jwt}, k=${b64urlFromBytes(pubBytes)}`;
}

// Expose the VAPID public key (base64url, 65-byte raw) derived from the private
// scalar — used when registering the key with a push service / showing it in UI.
export function vapidPublicKeyBase64url(vapidPriv) {
  return b64urlFromBytes(deriveP256Public(b64urlToBytes(vapidPriv)));
}

// Re-export for the port's thin handler.
export { resolveFetch };
