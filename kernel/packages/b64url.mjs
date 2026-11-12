// kernel/packages/b64url.mjs — base64url (RFC 4648 §5, unpadded) for the
// package ports. One implementation: the JWT/assertion mints (apple, fcm-oauth,
// google-oauth, passport, webpush-crypto), the signed-value/URL ports
// (signedurl, url-signer) and the jwt-auth/firebase-php-jwt ports all encode
// and decode the same way, and a second copy drifts silently (#697).
//
// `b64url` is the historical name in the signed-value ports; the crypto ports
// called the same function `b64urlFromBytes`. Both names are the SAME function
// here — import whichever reads better at the call site.

/** Raw bytes -> unpadded base64url string. */
export function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Unpadded base64url string -> raw bytes (the inverse of `b64url`). */
export function b64urlToBytes(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  const bin = atob(b64 + '='.repeat(pad));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
