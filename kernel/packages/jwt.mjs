// kernel/packages/jwt.mjs — the compact-JWS verify envelope.
//
// Two verifiers in the fleet check a JWT the same way and differ only in the
// algorithm and the key: the kernel's RS256 one (`passport.mjs`, the OAuth
// authorization server verifying its own tokens with the public half of its
// keypair) and the jwt-auth port's HS256 one (a shared secret). The envelope —
// three dot-separated parts, a JSON header, the `alg` claim, the signature over
// `{header}.{payload}`, a JSON payload, `null` for anything that is wrong — was
// spelled out twice, and a fix to one copy (an `alg` that must be rejected, a
// decode that must not throw) would silently miss the other.
//
// `importKey` is a thunk, not a key: both callers import the key only AFTER the
// header's `alg` claim has been checked, so a garbage token never costs a key
// import — and an unusable key keeps throwing exactly where it did before.

import { b64urlToBytes } from './b64url.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Verify a compact JWS and return its payload, or `null` when anything about it
 * is wrong (part count, header, `alg`, signature, payload). `alg` is the JWS
 * `alg` the caller accepts, `algorithm` the WebCrypto algorithm handed to
 * `crypto.subtle.verify`, and `importKey()` returns the verifying CryptoKey.
 */
export async function verifyJwtSignature(token, { alg, algorithm, importKey }) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header;
  try {
    header = JSON.parse(dec.decode(b64urlToBytes(h)));
  } catch {
    return null;
  }
  if (header.alg !== alg) return null;
  const key = await importKey();
  let ok = false;
  try {
    ok = await crypto.subtle.verify(algorithm, key, b64urlToBytes(s), enc.encode(`${h}.${p}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    return JSON.parse(dec.decode(b64urlToBytes(p)));
  } catch {
    return null;
  }
}
