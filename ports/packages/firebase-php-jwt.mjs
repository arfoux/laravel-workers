// Port of the Firebase Admin / firebase-php-jwt verify flow — validating a
// Firebase ID token at the edge.
//
// Route seam: registry.json → "ports": {
//   "POST /auth/firebase/verify": "firebase-php-jwt:verify",
// }
//
// What runs at the edge (parity with kreait/firebase-php + firebase/php-jwt):
//   • the client sends { idToken } (the ID token a Firebase web/mobile SDK mints);
//   • the handler fetches Firebase's public signing keys — the JWKS at
//     `https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com`
//     (RS256 x509 certs, keyed by `kid`), or the JWK form at
//     `.../metadata/jwk/securetoken@system.gserviceaccount.com` — either is
//     accepted;
//   • it verifies the RS256 signature against the key matching the token's
//     `kid`, then checks the Firebase ID-token claims: `iss`
//     (`https://securetoken.google.com/<projectId>`), `aud` (`<projectId>`),
//     `exp`, and that `sub` is non-empty — the exact checks the Admin SDK's
//     `verifyIdToken` performs.
//   • returns the decoded payload (`{ sub, email, name, picture, ... }`) on
//     success.
//
// Config (env): FIREBASE_PROJECT_ID (required, the claims check needs it),
// FIREBASE_JWKS_URL (optional override — the default is Google's cert endpoint).
//
// Edge disclosure: the JWKS fetch is one HTTPS GET (cache-friendly, `max-age`
// honoured by Google's endpoint). Verification is pure WebCrypto
// RSASSA-PKCS1-v1_5 SHA-256. No sockets, no PHP runtime.
//
// Free tier: 1 subrequest per (cache-miss) verify + 1 RSA verify — irrelevant
// against Workers limits. Cache the key set in module scope for the isolate's
// life to keep the common path at zero subrequests.

import { resolveFetch } from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx, jsonResponse as json } from '../../kernel/packages/port-ctx.mjs';
import { b64urlToBytes } from '../../kernel/packages/b64url.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const RS_ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

const DEFAULT_JWKS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

function decodeSegment(seg) {
  return JSON.parse(dec.decode(b64urlToBytes(seg)));
}

// --- key material ------------------------------------------------------------

// Firebase's default endpoint returns X.509 **certificates** (PEM), not bare
// public keys. WebCrypto's `importKey('spki', …)` only accepts the embedded
// SubjectPublicKeyInfo, so peel the cert's TLV wrapper:
//   Certificate     ::= SEQUENCE { tbsCertificate SEQUENCE,
//                                 signatureAlgorithm SEQUENCE,
//                                 signatureValue BIT STRING }
//   tbsCertificate  ::= SEQUENCE { [0] version EXPLICIT, serial INTEGER,
//                                  signature SEQUENCE, issuer SEQUENCE,
//                                  validity SEQUENCE, subject SEQUENCE,
//                                  subjectPublicKeyInfo SEQUENCE, [3] extensions, ... }
// Walk the fixed field order forward (the optional [0] version tag is skipped
// when present) — the SPKI is the SEQUENCE right after the subject. A ~25-line
// DER walk beats a 40 kB ASN.1 lib.
function spkiFromCertificateDer(der) {
  const readTlv = (i, tag) => {
    if (der[i] !== tag) throw new Error(`unexpected DER tag 0x${der[i].toString(16)} at ${i}`);
    const first = der[i + 1];
    let len;
    let header;
    if (first < 0x80) {
      len = first;
      header = 2;
    } else {
      const n = first & 0x7f;
      len = 0;
      for (let k = 0; k < n; k += 1) len = len * 256 + der[i + 2 + k];
      header = 2 + n;
    }
    return { start: i, header, len, end: i + header + len };
  };
  const cert = readTlv(0, 0x30); // Certificate SEQUENCE
  const tbs = readTlv(cert.start + cert.header, 0x30); // tbsCertificate SEQUENCE
  let p = tbs.start + tbs.header;
  if (der[p] === 0xa0) p = readTlv(p, 0xa0).end; // optional [0] EXPLICIT version
  const serial = readTlv(p, 0x02); // CertificateSerialNumber INTEGER
  const signature = readTlv(serial.end, 0x30); // AlgorithmIdentifier
  const issuer = readTlv(signature.end, 0x30); // Name
  const validity = readTlv(issuer.end, 0x30); // Validity
  const subject = readTlv(validity.end, 0x30); // Name
  const spki = readTlv(subject.end, 0x30); // SubjectPublicKeyInfo
  return der.slice(spki.start, spki.end);
}

function pemBodyToBytes(pem) {
  const body = String(pem)
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('empty PEM');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Import one PEM block (a certificate or a bare SPKI public key) as a verify key.
async function importPem(pem) {
  const der = pemBodyToBytes(pem);
  let spki = der;
  try {
    spki = spkiFromCertificateDer(der);
  } catch {
    // Already a bare SubjectPublicKeyInfo — import it as-is.
  }
  return crypto.subtle.importKey('spki', spki, RS_ALG, false, ['verify']);
}

// Normalise every shape a Firebase key endpoint can hand us into `{ kid → CryptoKey }`.
//  - `{ keys: [jwk...] }` (the JWK endpoint) — one CryptoKey per JWK.
//  - `{ <kid>: "<PEM cert|public key>", ... }` (the x509 endpoint) — peel the SPKI
//    out of the certificate (or take the bare key) and import that.
async function importKeySet(doc) {
  const keys = new Map();
  if (doc && Array.isArray(doc.keys)) {
    for (const jwk of doc.keys) {
      if (!jwk || !jwk.kid || jwk.kty !== 'RSA') continue;
      const key = await crypto.subtle.importKey('jwk', jwk, RS_ALG, false, ['verify']);
      keys.set(String(jwk.kid), key);
    }
    return keys;
  }
  for (const [kid, pem] of Object.entries(doc || {})) {
    if (typeof pem !== 'string') continue;
    keys.set(String(kid), await importPem(pem));
  }
  return keys;
}

// Module-scope cache: `{ url → Promise<Map<kid, CryptoKey>> }`. A failed fetch is
// not cached so a transient Google hiccup retries on the next token.
const keyCache = new Map();

async function loadKeys(env, fetchImpl) {
  const url = env.FIREBASE_JWKS_URL || DEFAULT_JWKS_URL;
  if (keyCache.has(url)) return keyCache.get(url);
  const p = (async () => {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res || !res.ok) throw new Error(`firebase jwks fetch failed (${res ? res.status : 'no response'})`);
    const doc = await res.json();
    const keys = await importKeySet(doc);
    if (!keys.size) throw new Error('firebase jwks contained no usable keys');
    return keys;
  })();
  keyCache.set(url, p);
  p.catch(() => keyCache.delete(url));
  return p;
}

// --- claim checks ------------------------------------------------------------

function claimsOk(payload, projectId) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= nowSec) return 'token has expired';
  if (typeof payload.iat === 'number' && payload.iat > nowSec + 60) return 'token used before issued';
  const iss = `https://securetoken.google.com/${projectId}`;
  if (payload.iss !== iss) return 'token has wrong issuer';
  if (payload.aud !== projectId) return 'token has wrong audience';
  if (!payload.sub || typeof payload.sub !== 'string') return 'token has no subject';
  return null;
}


// POST /auth/firebase/verify — {idToken} → decoded payload
export async function handleVerify(ctx, env) {
  try {
    const projectId = env.FIREBASE_PROJECT_ID;
    if (!projectId) return json(500, { error: 'FIREBASE_PROJECT_ID is not configured' });
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    const idToken = body.idToken || body.id_token;
    if (typeof idToken !== 'string' || !idToken) {
      return json(422, { error: 'The idToken field is required.' });
    }
    const parts = idToken.split('.');
    if (parts.length !== 3) return json(401, { error: 'invalid token' });
    let header;
    let payload;
    try {
      header = decodeSegment(parts[0]);
      payload = decodeSegment(parts[1]);
    } catch {
      return json(401, { error: 'invalid token' });
    }
    if (header.alg !== 'RS256' || !header.kid) return json(401, { error: 'invalid token' });

    const fetchImpl = resolveFetch(env);
    const keys = await loadKeys(env, fetchImpl);
    const key = keys.get(String(header.kid));
    if (!key) return json(401, { error: 'unknown signing key (kid)' });
    let ok = false;
    try {
      ok = await crypto.subtle.verify(RS_ALG, key, b64urlToBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    } catch {
      ok = false;
    }
    if (!ok) return json(401, { error: 'invalid signature' });

    const claimError = claimsOk(payload, String(projectId));
    if (claimError) return json(401, { error: claimError });

    return json(200, { ok: true, user: payload });
  } catch (err) {
    return json(502, { error: String((err && err.message) || err) });
  }
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  if (ctx.method === 'POST') return handleVerify(ctx, env);
  return json(404, { message: `Unknown firebase verify route (${ctx.method}).` });
}
