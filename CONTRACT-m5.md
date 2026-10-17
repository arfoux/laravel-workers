# CONTRACT-m5 — Hash + Encrypter parity (frozen 2026-10-18)

M5 ships kernel modules `hash`/`encrypter` — two-sided parity with Laravel:
PHP app hashes/encrypts, Workers edge decrypts/verifies/checks, and JS-side
encrypts that PHP decrypts. No D1 writes, no app model.

## Artifacts

- `kernel/hash.mjs` — `make`/`check`/`needsRehash` wrapping bcrypt, Worker-compatible.
  Uses `bcryptjs` (pure JS, no native) to match Laravel `BcryptHasher`.
- `kernel/encrypter.mjs` — `encryptString`/`decryptString` (AES-256-CBC + HMAC SHA-256),
  byte-compatible with `Illuminate\Encryption\Encrypter` (serialize=false path).
  Promoted from `spikes/encrypter/js-encrypter.mjs` (+ WebCrypto only).
- `kernel/tests/hash.test.mjs` — bcrypt round-trip, wrong-password, needsRehash.
- `kernel/tests/encrypter.test.mjs` — JS round-trip, random-IV uniqueness, MAC
  tamper, wrong-key, empty/long/unicode payloads (no PHP vendor required).
  Full PHP↔JS parity remains in `spikes/encrypter/test.mjs` (requires `php`+vendor).
- `package.json` — add `bcryptjs@2.4.3`, `package-lock.json` lock.

## API (frozen)

- `import { make, check, needsRehash } from '../hash.mjs'` — `make` async, `check` async.
- `import { encryptString, decryptString } from '../encrypter.mjs'` — both async,
  args `plaintext: string, keyBase64: string` / `payloadB64: string, keyBase64: string`.

## CI

- `npm test` now `node --test kernel/tests/router.test.mjs kernel/tests/db.test.mjs kernel/tests/hash.test.mjs kernel/tests/encrypter.test.mjs`
- `npm run test:corpus` unchanged.
- No D1, no deploy secrets; green on `main`.

## Territory

- `laravel-workers/kernel/*` + `laravel-workers/compiler/*` + `spikes/encrypter/*` (reference).
- No `nearFind` push; nearFind local-only still ports `dbcheck` via D1 builder.
