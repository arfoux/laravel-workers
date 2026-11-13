// kernel/packages/b64url.mjs — base64url (RFC 4648 §5, unpadded) for the
// package ports. One implementation: the JWT/assertion mints (apple, fcm-oauth,
// google-oauth, passport, webpush-crypto), the signed-value/URL ports
// (signedurl, url-signer) and the jwt-auth/firebase-php-jwt ports all encode
// and decode the same way, and a second copy drifts silently (#697).
//
// `b64url` is the historical name in the signed-value ports; the crypto ports
// called the same function `b64urlFromBytes`. Both names are the SAME function
// here — import whichever reads better at the call site.
//
// `pemToDer` lives here too: a key or certificate arrives PEM-armoured or as
// the bare base64 body, and decoding it is the same `b64urlToBytes` once the
// armour comes off.

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

/**
 * A PEM-armoured blob — or the bare base64 body — to DER bytes.
 *
 * Five sites decode a PEM this way: Apple's `.p8` (PKCS#8), the FCM and Google
 * service accounts (PKCS#8), Passport's RS256 keypair (PKCS#8 + SPKI) and the
 * Firebase key endpoint (an X.509 cert or a bare SPKI key). The armour is
 * stripped generically, so all five shapes go through here; a copy per site
 * drifts silently (#697). `label` names the key in the two errors, so a broken
 * one says which it was.
 */
export function pemToDer(raw, label = 'private key') {
  const text = String(raw || '').trim();
  if (!text) throw new Error(`${label} is empty`);
  const body = text
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error(`${label} has no key body`);
  return b64urlToBytes(body);
}
