// kernel/packages/url-signer.mjs — spatie/laravel-url-signer port.
//
// Two operations, exposing a URL to third parties that expires and that cannot
// be tampered with without invalidating the signature:
//
//   sign(url, expiresSeconds, secret) -> `${url}${sep}expires=${expires}&signature=${sig}`
//   validate(url, secret)             -> { valid, expired }
//
// The signature is a base64url HMAC-SHA256 over `${url}${sep}expires=${expires}`,
// keyed with `secret`, and `expires` is a unix timestamp in the future
// (`now + expiresSeconds`). Verification recomputes the MAC and compares it
// constant-time (mirrors PHP `hash_equals()`), then enforces that `expires` is
// still in the future. This is the same shape Laravel's `URL::signedRoute` /
// spatie's `Sha256UrlSigner` produce: `?expires=..&signature=..` in the query
// string, with the raw URL preserved.

import { timingSafeEqual } from './webhook.mjs';
import { b64url } from './b64url.mjs';
import { hmacSha256Bytes } from '../hmac.mjs';

// Sign the given `url` for `expiresSeconds` from now. Returns the signed URL.
export async function sign(url, expiresSeconds, secret) {
  const expires = Math.floor(Date.now() / 1000) + Number(expiresSeconds);
  const sep = String(url).includes('?') ? '&' : '?';
  const message = `${url}${sep}expires=${expires}`;
  const signature = b64url(await hmacSha256Bytes(secret, message));
  return `${message}&signature=${signature}`;
}

// Verify a previously signed URL. Returns `{ valid: true }` when the MAC
// matches and the expiry is still in the future; `{ valid: false, expired: true }`
// when the MAC is good but the URL has aged past `expires`; `{ valid: false }`
// on a bad MAC or a malformed URL.
export async function validate(url, secret, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof url !== 'string') return { valid: false };
  const sigMatch = /[?&]signature=([^&]+)/.exec(url);
  const expMatch = /[?&]expires=(\d+)/.exec(url);
  if (!sigMatch || !expMatch) return { valid: false };
  const signature = sigMatch[1];
  const expires = Number(expMatch[1]);
  if (now > expires) return { valid: false, expired: true };
  const unsignedUrl = url.replace(/[?&]signature=[^&]+/, '');
  const expect = b64url(await hmacSha256Bytes(secret, unsignedUrl));
  return timingSafeEqual(expect, signature) ? { valid: true } : { valid: false };
}
