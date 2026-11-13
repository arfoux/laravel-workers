// kernel/packages/passport.mjs — the crypto core of the laravel/passport v13
// port. RS256 JWT signing/verification through WebCrypto, JWKS export, and
// PKCE S256 (RFC 7636) — all the parts of an OAuth authorization server that
// are pure math and run natively on the edge.
//
// Parity target: Passport mints access tokens as RS256 JWTs whose header is
// `{ alg: RS256, typ: JWT, kid }` and verifies its own tokens with the public
// half of the same keypair. `oauth:jwks` exposes the public key as a JWK. Keys
// never live in code — the caller injects PEM (`PASSPORT_PRIVATE_KEY`,
// `PASSPORT_PUBLIC_KEY`) from env secrets.

import { b64url, b64urlToBytes, pemToDer } from './b64url.mjs';
import { verifyJwtSignature } from './jwt.mjs';

const enc = new TextEncoder();
const RS_ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

// --- PEM → DER (PKCS#8 private / SPKI public); see b64url.mjs#pemToDer ------

export async function importPrivateKey(pemPkcs8) {
  return crypto.subtle.importKey('pkcs8', pemToDer(pemPkcs8, 'Passport private key'), RS_ALG, false, ['sign']);
}

export async function importPublicKey(pemSpki) {
  return crypto.subtle.importKey('spki', pemToDer(pemSpki, 'Passport public key'), RS_ALG, true, ['verify']);
}

// --- RS256 JWT -------------------------------------------------------------

// Sign an arbitrary JSON payload as an RS256 JWT. `kid` is optional but
// Passport sets it so /oauth/jwks can be keyed by the same id.
export async function signJwt(payload, privatePem, { kid, now = Math.floor(Date.now() / 1000) } = {}) {
  const header = { alg: 'RS256', typ: 'JWT', ...(kid ? { kid } : {}) };
  const signingInput = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const key = await importPrivateKey(privatePem);
  const sig = await crypto.subtle.sign(RS_ALG, key, enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

// Verify an RS256 JWT with the public PEM. Returns the decoded payload on a
// valid signature, else null. Callers enforce `exp`/`nbf` themselves (they get
// the full payload back). The envelope is `kernel/packages/jwt.mjs`'s — the
// jwt-auth port verifies its HS256 tokens with the same one.
export async function verifyJwt(token, publicPem) {
  return verifyJwtSignature(token, {
    alg: 'RS256',
    algorithm: RS_ALG,
    importKey: () => importPublicKey(publicPem),
  });
}

// --- JWKS ------------------------------------------------------------------

// Export the public PEM as a `{ keys: [jwk] }` document (RFC 7517). This is
// what GET /oauth/jwks serves so resource servers verify tokens offline.
export async function jwks(publicPem, kid) {
  const key = await importPublicKey(publicPem);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return {
    keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', ...(kid ? { kid } : {}) }],
  };
}

// --- PKCE (RFC 7636) -------------------------------------------------------

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(verifier)));
  return b64url(new Uint8Array(digest));
}

// S256: challenge == base64url(sha256(verifier)). Constant-time compare.
export async function verifyPkce(verifier, challenge, method = 'S256') {
  if (method !== 'S256') return false;
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false;
  const computed = await pkceChallenge(verifier);
  // reuse webhook's constant-time string compare via a local re-impl (avoid a
  // cross-primitive import here to keep this module dependency-free).
  if (computed.length !== challenge.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i += 1) diff |= computed.charCodeAt(i) ^ challenge.charCodeAt(i);
  return diff === 0;
}

// RFC 7636 §4.1: code_verifier is 43-128 chars from a high-entropy alphabet.
// We mint from CSPRNG bytes mapped into [A-Za-z0-9-._~].
export function generateCodeVerifier(randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = randomBytes(64);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
