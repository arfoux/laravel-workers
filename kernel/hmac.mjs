// kernel/hmac.mjs — the one async HMAC-SHA256 → lowercase-hex primitive.
//
// PHP's `hash_hmac('sha256', $data, $key)` is synchronous; WebCrypto's sign()
// is async, so every caller here is async. The digest is byte-identical to PHP
// (verified against the vendor oracle in the package tests).
//
// This rule was written five times — the webhook verifiers
// (packages/webhook.mjs), the Pusher signers (packages/broadcast.mjs), the
// signed-value/URL ports (packages/signedurl.mjs), the Mollie webhook
// (ports/packages/mollie-webhook.mjs) and the storage signed-URL MAC
// (storage.mjs) — and had already drifted (one copy used `globalThis.crypto`
// and skipped the `String()` coercion). A second copy drifts silently (#697).

const enc = new TextEncoder();

/**
 * HMAC-SHA256 over `message`, keyed with `secret`, as lowercase hex.
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<string>}
 */
export async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default { hmacSha256Hex };
