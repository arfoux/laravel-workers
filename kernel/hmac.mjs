// kernel/hmac.mjs — the one async HMAC-SHA256 primitive at the edge, in every
// encoding a caller needs: raw bytes, lowercase hex, base64 (and base64url via
// `hmacSha256Bytes` + `packages/b64url.mjs`, which is what the URL signer does).
//
// PHP's `hash_hmac('sha256', $data, $key)` is synchronous; WebCrypto's sign()
// is async, so every caller here is async. The digest is byte-identical to PHP
// (verified against the vendor oracle in the package tests).
//
// `kernel/digest.mjs` carries the SYNCHRONOUS twin of this rule — a manual
// RFC 2104 implementation used where the caller cannot await (the password-hash
// MAC in `auth.mjs`). It is named `hmacSha256HexSync` on purpose: the two
// written the same way would take their arguments in opposite orders and one of
// them returns a `Promise`, so a wrong import reads as a silent bug.
//
// This rule was written five times — the webhook verifiers
// (packages/webhook.mjs), the Pusher signers (packages/broadcast.mjs), the
// signed-value/URL ports (packages/signedurl.mjs), the Mollie webhook
// (ports/packages/mollie-webhook.mjs) and the storage signed-URL MAC
// (storage.mjs) — and had already drifted (one copy used `globalThis.crypto`
// and skipped the `String()` coercion). A second copy drifts silently (#697).

import { bytesToHex, bytesToBase64 } from './digest.mjs';

const enc = new TextEncoder();

/**
 * HMAC-SHA256 over `message`, keyed with `secret`, as raw bytes — the WebCrypto
 * `importKey`/`sign` pair, written once. Everything below (and the URL signer's
 * base64url shape) encodes these bytes differently; the signature itself is the
 * same rule, so it lives once (#697).
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<Uint8Array>}
 */
export async function hmacSha256Bytes(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
  return new Uint8Array(sig);
}

/**
 * HMAC-SHA256 over `message`, keyed with `secret`, as lowercase hex.
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<string>}
 */
export async function hmacSha256Hex(secret, message) {
  return bytesToHex(await hmacSha256Bytes(secret, message));
}

/**
 * HMAC-SHA256 over `message`, keyed with `secret`, as base64.
 *
 * The spatie webhook signature scheme: `base64(HMAC-SHA256(secret, rawBody))`.
 * Written twice — the receiving endpoint (ports/packages/webhook-client.mjs)
 * and the sending client (ports/packages/webhook-server.mjs) — with the same
 * rule and only a loop style apart. One copy, so it cannot drift (#697).
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<string>}
 */
export async function hmacSha256Base64(secret, message) {
  return bytesToBase64(await hmacSha256Bytes(secret, message));
}

export default { hmacSha256Bytes, hmacSha256Hex, hmacSha256Base64 };
