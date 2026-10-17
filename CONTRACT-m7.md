# CONTRACT-m7 — Services: Mail/Queue/Cache/Storage/Scheduler (frozen 2026-10-18)

M7 ships kernel service shims — Workers-native padanan for Laravel services.
All are pure ESM, zero deps (except Mail uses fetch, Storage is R2 REST via env). No D1 writes yet; each service can be unit-tested with mock bindings. Extends W7: the five services every Laravel app touches.

## Artifacts

- `kernel/mail.mjs` — `createMailer({ transport, from? })` → `{ send({ to, subject, html|text, from? }) }`. `transport: 'resend'` (fetch to `api.resend.com/emails`, `RESEND_API_KEY` env), `transport: 'log'` (in-memory, for tests), `transport: 'noop'`. Two-sided parity: Laravel `Mail::send` → HTTP; edge `mail.send` → same HTTP.
- `kernel/queue.mjs` — `createQueue({ binding? })` → `{ push(queue, job), pop(queue) }`. Binding `env.QUEUE` = Cloudflare Queues; fallback `memory` (Map) for tests and free-tier without Queues. Job shape `{ id, payload, attempts }`.
- `kernel/cache.mjs` — `createCache({ kv?, ttlMs? })` → `{ get, put, forget, remember }`. KV binding `env.CACHE_KV` (eventual consistency noted); fallback `memory` (Map+TTL). `remember(key, ttl, cb)` padanan for tagged cache via plain keys.
- `kernel/storage.mjs` — `createStorage({ r2? })` → `{ put, get, delete, url }`. R2 binding `env.STORAGE` (S3-compatible); `url` returns signed-URL stub. Fallback `memory`.
- `kernel/scheduler.mjs` — `defineSchedule(fn) → { run(trigger) }` with cron matcher `* * * * *`. Single-trigger padanan: one Worker cron entry dispatches to scheduler. Tests prove `*`/`*/5`/`1,2`/`5-10` + day/month names.
- `kernel/tests/services.test.mjs` — 18 subtests across the five services (mock fetch/KV/R2/Queue, memory fallbacks, scheduler cron matching incl. day-of-week `0|7` = Sunday).
- `bin` / `package.json` — `test` now includes `services.test.mjs`.

## API (frozen, excerpt)

```js
import { createMailer } from '../mail.mjs'
const mail = createMailer({ transport: 'resend', from: 'noreply@example.com' })
await mail.send({ to: 'a@b.co', subject: 'hi', html: '<p>hi</p>' }) // → { id }

import { createQueue } from '../queue.mjs'
const q = createQueue({ binding: env.QUEUE })
await q.push('emails', { to: 'a@b.co' })

import { createCache } from '../cache.mjs'
const cache = createCache({ kv: env.CACHE_KV })
await cache.remember('key', 60000, async () => expensive())

import { createStorage } from '../storage.mjs'
const storage = createStorage({ r2: env.STORAGE })
await storage.put('avatars/1.jpg', bytes)
```

## CI

- `npm test` → `router` + `db` + `hash` + `encrypter` + `validator` + `services` (46+ tests). `npm run test:corpus` unchanged. No real KV/R2/QUEUE required (memory mocks). Green on `main`.

## Territory

- `laravel-workers/kernel/*` only. `nearFind` local-only; later M8 wires a demo `mail` port via Resend (when user configures `RESEND_API_KEY`).
