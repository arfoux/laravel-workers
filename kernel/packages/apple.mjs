// kernel/packages/apple.mjs — Sign in with Apple client-secret minting + ID-token decode.
//
// Apple has NO OAuth client secret you can read from a config — the server must
// MINT one at request time. That secret is a JWT signed with the developer
// portal's P-256 private key (the `.p8` file) using ES256:
//
//   header:  { alg: ES256, kid: <10-char key id> }
//   payload: { iss: <team id>, iat: <now>, exp: <now + ttl>, aud: "https://appleid.apple.com", sub: <client id> }
//
// Apple requires `exp - iat` to be at most 6 months (15 777 000 s) and rejects
// a key id-bearing header without the matching `kid`, so `keyId` is honoured
// (Apple's docs name it mandatory for the client-secret exchange).
//
// The ES256 signature is WebCrypto's native ECDSA (P-256 / SHA-256), whose
// `sign()` output is already the raw R||S concatenation the JOSE ES256 format
// calls for — no DER re-encoding, unlike an RSA path. Signing is stateless and
// fast, so a fresh secret is minted per callback; there is nowhere safe to cache
// a bearer credential on the edge.
//
// Edge disclosure: NONE. Pure WebCrypto (importKey pkcs8, ECDSA sign, SHA-256)
// plus base64url — no socket, no key server, no token cache. This is the
// substitute for `firebase/php-jwt`'s `JWT::encode` in Laravel's Sign-in-with-
// Apple provider (laravel/socialite's `AppleProvider`).
//
// Config comes from the caller (the port reads env): teamId, clientId, the .p8
// key and optionally the 10-char keyId.

/** The Apple token endpoint an authorization code is exchanged at. */
export const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
/** The Apple authorize endpoint the browser is redirected to first. */
export const APPLE_AUTHORIZE_URL = 'https://appleid.apple.com/auth/authorize';
/** Apple's hard cap on `exp - iat`: 6 months in seconds. */
export const APPLE_MAX_CLIENT_SECRET_TTL = 15_777_000;
/** The `aud` claim the client secret and the id_token both carry. */
export const APPLE_ISSUER = 'https://appleid.apple.com';

// --- base64url ---------------------------------------------------------------

function b64urlFromBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlToBytes(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  const bin = atob(b64 + '='.repeat(pad));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Read the `.p8` (a PKCS#8 EC P-256 private key, base64 DER — with or without
// the PEM armour Apple's downloader wraps it in) into DER bytes. Exported so a
// test can assert the parse directly.
export function p8DerFromB64(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Apple .p8 private key is empty');
  const body = text
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/-----BEGIN EC PRIVATE KEY-----/g, '')
    .replace(/-----END EC PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('Apple .p8 private key has no key body');
  return b64urlToBytes(body);
}

/**
 * Mint an Apple client secret — an ES256 JWT signed with the team's P-256 `.p8`
 * key. Returns `{ assertion, header, payload }` (the payload carries iat/exp/
 * aud/iss/sub so a test can assert them without re-parsing the JWT).
 *
 * @param {object}  o
 * @param {string}  o.teamId       Apple Developer team id (10 chars), the `iss`.
 * @param {string}  o.clientId     The service/bundle id, the `sub`.
 * @param {string}  o.p8PrivateKey The .p8 PKCS8 key, PEM or raw base64.
 * @param {string}  [o.keyId]      The 10-char key id, the header `kid`.
 * @param {number}  [o.ttlSeconds] Secret lifetime in seconds (capped at 6 months).
 * @param {number}  [o.now]        Epoch seconds for `iat`/`exp` (tests freeze it).
 */
export async function mintClientSecret({
  teamId,
  clientId,
  p8PrivateKey,
  keyId,
  ttlSeconds = APPLE_MAX_CLIENT_SECRET_TTL,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  if (!teamId) throw new Error('Apple client secret needs teamId');
  if (!clientId) throw new Error('Apple client secret needs clientId');
  if (!p8PrivateKey) throw new Error('Apple client secret needs p8PrivateKey');

  const key = await crypto.subtle.importKey(
    'pkcs8',
    p8DerFromB64(p8PrivateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const iat = Math.floor(now);
  // Apple rejects a secret that outlives 6 months; a caller's larger ttl is
  // silently capped rather than producing an exchange Apple will refuse.
  const ttl = Math.min(Math.floor(ttlSeconds) || 0, APPLE_MAX_CLIENT_SECRET_TTL);

  const header = { alg: 'ES256', typ: 'JWT' };
  if (keyId) header.kid = String(keyId);
  const payload = {
    iss: String(teamId),
    iat,
    exp: iat + ttl,
    aud: APPLE_ISSUER,
    sub: String(clientId),
  };

  const enc = new TextEncoder();
  const signingInput = `${b64urlFromBytes(enc.encode(JSON.stringify(header)))}.${b64urlFromBytes(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(signingInput)
  );
  const assertion = `${signingInput}.${b64urlFromBytes(new Uint8Array(sig))}`;
  return { assertion, header, payload };
}

/**
 * Decode a JWT id_token — `header.payload.signature`, base64url — into its
 * parts. The signature segment is kept as the raw base64url string (Apple
 * returns the id_token in the callback body AND the exchange response; this
 * helper only DECODES — offline signature verification is the JWKS path of the
 * firebase-php-jwt port, composed by a caller that needs it).
 */
export function decodeIdToken(assertion) {
  if (typeof assertion !== 'string' || !assertion) {
    throw new Error('id_token is not a JWT string');
  }
  const parts = String(assertion).split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new Error('id_token is not a well-formed 3-part JWT');
  }
  const dec = new TextDecoder();
  const header = JSON.parse(dec.decode(b64urlToBytes(parts[0])));
  const payload = JSON.parse(dec.decode(b64urlToBytes(parts[1])));
  return { header, payload, signature: parts[2] };
}

export default { mintClientSecret, decodeIdToken, APPLE_TOKEN_URL, APPLE_AUTHORIZE_URL, APPLE_ISSUER };
