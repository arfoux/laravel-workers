# Riset Paket Laravel Terkenal di laravel-workers (Edge)

> Status: **riset** (bukan implementasi). Metode: 12 subagent paralel, masing-masing satu kluster paket,
> grounding ke `COMPILED.md` §8b (M68), `tools/integrations.json`, `MAP.md`, + versi Packagist/npm live.
> Prinsip repo: *compiled / port / substitute / special / refuse* — tidak ada degradasi senyap (fail loud).
> Setiap substitusi algoritma/backend **wajib** diberi disclosure. Verdict `refuse` dipilah
> *edge-impossible* vs *infra/daemon* vs *dev-only*.
>
> Dibuat: 2026-11-10. Versi paket = terbaru saat riset (Packagist/npm).

## Ringkasan verdict

| Kluster | compile | port | substitute | special | refuse |
|---|---|---|---|---|---|
| Auth & Identity | breeze, laravel/ui | sanctum, socialite, jetstream, spatie-permission | — | fortify | passport |
| Queues & Schedule | queue(database), schedule(dump) | sqs, horizon-metrics, spatie-queueable-action | queue(redis) | sync-driver, batching | horizon |
| Realtime / WebSockets | — | echo, pusher-php-server | soketi (as hub) | — | reverb, beyondcode-websockets |
| Search | — | scout(+meili/algolia/typesense) | scout-database(FTS5), tntsearch | — | scout-collection |
| Media & Files | — | medialibrary, sitemap, tags, sluggable, activitylog, translatable, model-states | intervention-image, flysystem | — | laravel-backup |
| Dokumen & Export | — | dompdf, snappy, laravel-pdf, excel | league/csv | — | — |
| Cache/Session/RL | cache(database), session(database/cookie), ratelimit(D1) | laravel/lock | cache(redis/memcached/file/dynamodb), predis, memcached | — | phpredis, octane |
| Forms/Data/Dev | — | laravel-data, laravel-settings, query-builder, laravel-enum | laravel-cors | — | form-builder, pest, dusk, envoy, pint, larastan, prompts, tinker |
| Admin & Livewire | — | — | — | livewire(install-only), tallstackui | volt, filament, filament-media-plugin |
| Observability & Dev | — | sentry-laravel | log-viewer | — | debugbar, clockwork, pail, telescope, tinker, ray |
| Billing | — | cashier(Stripe), cashier-paddle, lemonsqueezy | — | spark | — |
| HTTP & Integrasi | — | guzzle, stripe-php | aws-sdk-php(S3→R2) | — | Http facade |
| AI & Agent | — | laravel/ai, laravel/mcp, prism-php/prism, openai-php/laravel | — | laravel/boost |
| Frontend SPA | folio, wayfinder | inertia-laravel | — | prompts (dev-only) |
| Observability dashboards | — | pulse, bugsnag-laravel | — | nightwatch |
| Admin panels | — | — | — | nova, orchid, backpack, moonshine, encore |
| Spatie HTTP middleware | blade-comments | responsecache, csp, honeypot | route-attributes (build-time) | — |
| Spatie webhooks | — | webhook-client, webhook-server | — | — |
| Spatie misc | — | menu, navigation, html, options, site-search, analytics | fractal | personal-data-export |
| Spatie media extras | — | laravel-glide | — | browsershot, image-optimizer |
| 2FA & security | — | bacon-qr (SVG) | google2fa, one-time-passwords | robthree/twofactorauth (dep) |
| Notification channels | — | telegram, discord, expo, fcm, webpush, onesignal | — | — |
| Auth extras | — | jwt-auth, firebase-php-jwt, auth0 | kreait-firebase | — |
| Filament ecosystem | — | — | — | settings-plugin, shield, plugin-skeleton, media-plugin |
| Livewire ecosystem | — | — | flux, wireui | livewire-alert, livewire-wizard |
| SEO & URLs | — | seotools, googletagmanager | eloquent-sluggable | — |

## Catatan koreksi klaim repo (dari subagent)

- `MAP.md:511` & `READINESS.md:82` masih menulis Passport "OAuth endpoints compile" — **usang**;
  `COMPILED.md` §8b M68 sudah memutuskan paket = `refuse`, endpoint = `port`.
- `MAP.md:531/537` menandai Sanctum/Socialite `ph2/ph3` — M68 sudah menutup keduanya `port`.
- `tools/docs-check.mjs` `PAGES` (baris 123) **belum** punya slot untuk
  `spatie/laravel-permission`, `jetstream`, `breeze`, `fortify`, `laravel/ui` — lima halaman
  auth/identity di luar gerbang docs hari ini.
- Livewire: satu-satunya dukungan yang ADA = pembuangan guard Blade komponen
  (`compiler/src/livewire-markers.mjs`) agar app ber-Livewire tetap build hijau — **bukan** runtime
  Livewire. Tidak ada modul kernel `livewire`/`filament`/`volt`.
- `PACKAGES-RESEARCH.md:95` ("2FA (TOTP) belum punya modul kernel") — **usang**: `kernel/packages/totp.mjs`
  sudah ada (base32, HMAC-SHA1 WebCrypto, RFC 6238/4226, ±1 window, `otpauth://`, recovery codes),
  diuji RFC test vector di `tools/tests/packages-fortify-2fa.test.mjs`; `fortify-two-factor.mjs`
  melayani 4 route. Perbaiki kalimat itu saat eksekusi.
- **Streaming belum ada di pipeline route port** (temuan kluster AI): `kernel/router.mjs:277-289`
  `dispatch()` meng-*throw* `"handler returned invalid response shape"` untuk body port yang bukan
  `string | Uint8Array | null`, dan `src/worker.mjs:81` `toResponse()` hanya meneruskan `res.body`.
  Tidak ada `ReadableStream`/`text/event-stream`/SSE di repo (grep 0). Klaim M68 "streaming answer is
  a ReadableStream ... native to a Worker" **belum benar untuk route ports** — runtime harus diperluas
  dulu (kontrak body port + `dispatch`) sebelum port AI bisa streaming (`laravel/ai::stream()`,
  `prism->stream()`, `openai-php createStreamed()`, SSE MCP). Prasyarat tunggal untuk semua streaming.

---

---

## Auth & Identity

### laravel/sanctum v4.3.3
- verdict: **port** — token auth = lookup D1. Session guard + `personal_access_tokens` (kolom token ter-hash) + abilities + middleware `auth:sanctum` 1:1 via lapisan session terkompilasi (`kernel/auth.mjs`, M14/M15).
- refusal: paket Sanctum tak pernah terkompilasi (provider-nya mendaftarkan guard+middleware; vendor service provider di luar lingkup). Route terkompilasi yang me-resolve `Sanctum::` → fail loud (LW002).
- port: pembaca `Authorization: Bearer` → hash → D1 `personal_access_tokens`; abilities dicek terhadap baris ter-hash; mode SPA cookie memakai session guard yang ada.
- substitution: — (D1 sudah store yang disanksikan).
- test: probe e2e (login → mint token → request bearer → guard `user()`); paritas hash token + daftar ability.
- free-tier: 1 tulis baris D1 per mint token, 1 baca terindeks per request bearer — jauh di bawah 100k tulis/hari.

### laravel/passport v13.10.0
- verdict: **refuse** (paket) / **port** untuk separuh HTTP. Klaim `MAP.md:511` ("OAuth endpoints compile") **usang** dan bertentangan dengan tabel M68; `COMPILED.md` §8b kanonik.
- edge: route OAuth2 adalah route biasa — `authorize`/`token`/`refresh` dijawab lewat D1 `oauth_clients`/`oauth_tokens` + lapisan session/cookie yang ada. Penandatanganan RS256 via WebCrypto; kunci privat dari worker secret.
- refusal: provider Passport mengikat League OAuth2 authorization server — vendor service provider, tak pernah terkompilasi. Route terkompilasi yang me-resolve `Passport\Passport` → LW002.
- substitution: kunci berbasis file → env worker-secret (`passport:keys` menulis file lokal yang edge tak bisa baca) — wajib disclosure.
- test: siklus e2e authorize→consent→token→refresh; verifikasi RS256 terhadap endpoint JWKS.

### laravel/socialite v5.31.0
- verdict: **port** — tarian OAuth = dua panggilan `fetch` + session: bangun redirect authorize, verifikasi `state` callback, tukar code→token, lalu login lewat session guard terkompilasi. Config provider dibaca dari dump `services` beku.
- refusal: paket tak terkompilasi (kelas provider + binding `SocialiteManager` = kode vendor); `Socialite::` → LW002.
- port: satu handler per provider (`{provider}/redirect`, `{provider}/callback`) di `ports/<slug>.mjs` di bawah `registry.json`; state di session terkompilasi; user dipersist lewat guard.
- test: e2e terhadap stub provider, membandingkan byte redirect URL + round-trip `state`; paritas token exchange via upstream tiruan.

### laravel/fortify v1.41.0
- verdict: **special** — alur berbentuk Fortify adalah controller TERKOMPILASI (klaim repo, `COMPILED.md:267`); paket Fortify sendiri = port/refuse.
- edge: login/register/logout/forgot/reset/verify terkompilasi sebagai controller — validate → attempt → regenerate → intended, throttled via RateLimiter kernel, reset token di D1, kirim mail lewat outbox mailable kernel. Middleware `password.confirm` terkompilasi.
- refusal: paket Fortify tak terkompilasi (provider-nya mengawat kelas action + closure `Fortify::authenticateUsing()`/`confirmPasswordsUsing()`). `Fortify\` → LW002. **2FA (TOTP) sudah punya modul kernel** (`kernel/packages/totp.mjs`: base32, HMAC-SHA1 WebCrypto, RFC 6238/4226, ±1 window, `otpauth://`, recovery codes — diuji RFC test vector di `tools/tests/packages-fortify-2fa.test.mjs`); login ber-2FA melayani 4 route di `ports/packages/fortify-two-factor.mjs`.
- port: `ports/fortify.mjs` untuk kustomisasi berbasis closure; route vendor Fortify dideklarasikan di `registry.json`.
- test: `login-flow.test.mjs` + `auth.test.mjs` sudah membuktikan byte alur; tambah probe dump `features` Fortify yang menolak `twoFactorAuthentication` aktif tanpa port.

### laravel/jetstream v5.5.3
- verdict: **port** (kode kit terkompilasi; paket Jetstream = refuse) — seluruh yang Jetstream kirim adalah kode app: auth stack berbentuk Fortify, API-token stack = Sanctum, keduanya sudah compile/port. Kelas action (`CreateNewUser`, CRUD profil/tim) = kelas terkompilasi biasa.
- refusal: paket Jetstream (provider + lapisan komponen Livewire/Inertia) tak terkompilasi. Jetstream 5 default Livewire 3; repo menandai Livewire hard/di luar v1 (`MAP.md:229`) — app Jetstream di stack Livewire hanya membangun view halaman jadi byte flag-off; interaksi komponen → LW002 di guard morph.
- port: action profil/tim terkompilasi langsung; respons Inertia JSON = port Inertia fase-3; komponen Livewire = port tulis-tangan per komponen.
- substitution: frontend morph-diff Livewire → Blade terkompilasi + port JSON Inertia; disclosure bahwa permukaan SPA interaktif bukan milik vendor.

### laravel/breeze v2.4.2
- verdict: **compile** (terdekat ke skeleton) — Breeze tak mengirim runtime paket; instalasinya = route + controller + view Blade + scaffolding Inertia/Vue, semua kode app yang dikompilasi build. Stack Blade terkompilasi 1:1.
- refusal: preset Inertia/Vue/React tak terkompilasi sebagai SPA (frontend = port JSON Inertia fase-3); skrip instalasi Breeze = `php artisan breeze:install` lokal (dev-only).
- port: tak ada untuk stack Blade; preset Inertia butuh port JSON Inertia.
- test: shadow pada app skeleton Breeze: register → login → logout → reset → verify → password.confirm, tiap status/body dibandingkan PHP 8.3.

### spatie/laravel-permission v8.5.0
- verdict: **port** — pemeriksaan role/permission mengalir lewat pipeline terkompilasi (`can:` middleware + `Gate` terkompilasi), tapi jawaban spatie hidup di kode vendor.
- refusal: paket tak terkompilasi (provider mendaftarkan permission registrar + directive Blade + cache per-user); trait `HasRoles` = kode vendor. `Spatie\Permission\` → LW002. Team-scoped + wildcard `*` jadi tugas port.
- port: `ports/packages/permission.mjs` menjawab `hasRole`/`hasPermissionTo`/`hasAnyRole` lewat skema D1 `roles`/`permissions`/`model_has_roles`/`model_has_permissions`; disambungkan via `registry.json → guards` atau closure `Gate::before`.
- identity: route seam-nya (`GET/POST /model/{modelType}/{modelKey}/...`) butuh identitas guard (`ctx.user()`/`ctx.user_id`) → `401` tanpa itu, sebelum tulis D1: anonim = oracle role + eskalasi (`assign-role` ke model key apa pun). Route params tetap data, bukan identitas.
- substitution: tabel cache Eloquent spatie → cache store kernel (KV/D1) — disclosure.
- test: seed role/permission di D1, jalankan `can:` middleware + `Gate::denies()` di shadow run, bandingkan jawaban PHP 8.3; pastikan pemeriksaan kedua tak mengeluarkan query ekstra.

### laravel/ui v4.6.3
- verdict: **compile** (scaffold legacy) — scaffolding Auth `laravel/ui` = controller pra-Breeze yang dibangun di atas trait `AuthenticatesUsers`/`RegistersUsers`. Trait itu terkompilasi (`attempt`/`login`/`logout`/`guest`/`intended` ada di `kernel/auth.mjs`); middleware `auth.basic` tersambung; view Blade terkompilasi.
- refusal: skrip instalasi `php artisan ui:auth` = langkah lokal dev-only; pipeline aset preset (Bootstrap/Vue/React via Mix) = kode app — app berbasis Mix butuh asetnya prebuilt.
- port: tak ada untuk controller; penyajian aset statis via `registry.json` bila Blade terkompilasi mereferensi file ber-hash Mix.
- test: `routes-dump.php` harus mengembangkan `Route::auth()` ke set route yang sama dengan `route:list`; shadow run byte login/register/reset.

## Queues, Jobs & Schedule

### laravel/horizon v5.50.1
- verdict: **refuse** (infra/daemon + redis) — `MAP.md:491`: "Redis dashboard; padanan CF dashboard".
- edge: tidak ada 1:1. D1 `lw_redis` (`kernel/redis.mjs`) hanya subset cache-shape (get/set/del/ttl/incr); drain cron sudah melaporkan `{ran, failed}` per invocation.
- refusal: Redis server (infra — pub/sub/streams/Lua/MULTI → `RedisUnsupportedError`); daemon `horizon:work`+`horizon:snapshot` (edge-impossible: Worker tanpa long-lived process); dashboard (dev-only); `Horizon::` di route terkompilasi → LW002.
- port: ganti dashboard → CF Workers Analytics / `wrangler tail` + port yang merekam throughput job ke D1 (pola `pulse`).

### queue drivers redis/sqs/database/sync (framework 13.37)
- verdict: **database=compile · sync=special · redis=substitute · sqs=port**.
- edge: **database** — `Job::dispatch()` → `rt.queuePush` menulis D1 `lw_jobs` (payload phpJson parity), cron drain `rt.queueDrain` (retry/3-attempt). **sync** — inline.
- refusal: driver redis tak ada (`Queue` facade refuse LW002); **sqs** vendor `SqsQueue` tak terkompilasi; `Queue::push(class-string)` refuse.
- port: **sqs** → port handler POST ke SQS REST + SigV4-HMAC via WebCrypto `[INFERENCE]` detail SigV4.
- substitution: redis queue → D1 `lw_jobs` (disclosure: tanpa server; pemilihan driver `config/queues.php` tak dibaca dispatcher terkompilasi `[INFERENCE]`).

### laravel/schedule (framework 13.37)
- verdict: **compile** (dump) + **port** (delivery) — build dump schedule → `dist/src/schedule.generated.mjs` + `dist/cron.json`; handler `scheduled()` evaluasi due events via `kernel/scheduler.mjs` (`cronMatches`/`dueEvents` timezone-aware).
- refusal: delivery asinkron — due event dikirim lewat binding produser `QUEUE`; tanpa binding → `dropped: [...]` + `console.warn` + gap DECLARED; artisan tak jalan di edge.
- port: consumer di luar worker ini (CF Queues consumer); HTTP face `POST /__lw/cron` (LW_CRON_SECRET) memirror trigger + drain.
- test: `schedule-utc.test.mjs` (sweep 14 hari); `worker-entry.test.mjs` (drain cron).

### spatie/laravel-queueable-action v2.16.2
- verdict: **port** — action = kode app biasa; `execute()` inline jalan 1:1; bentuk async lewat jalur D1 `lw_jobs`.
- refusal: trait `QueueableAction` bukan 4 bus-trait Laravel yang diizinkan (`compiler/src/classes.mjs`, A96) — body yang memanggil `$this->dispatch()` → LW002; auto-discovery provider tak terkompilasi.
- port: buang trait; bungkus action dalam `app/Jobs` terkompilasi yang memanggil `execute()`, dispatch via `Job::dispatch()` → cron drain.
- substitution: trait dispatch → wrapper job eksplisit (disclosure: async lewat cron drain, bukan saat request).

### job batching + failure handling (framework 13.37)
- verdict: **special** (parsial) — retry `attempts` dgn backoff 0, drop setelah 3, `{ran, failed}`, DELETE-on-success; unknown job di-delete + dihitung failed.
- refusal: `Bus::batch()`/`Bus::chain()` → facade `Bus` tak terkompilasi (LW002); tabel `job_batches` tak ada; `failed_jobs` **tidak** di-populate (divergence); backoff array per-job tak dihormati drain (selalu 0).
- port: port merekam baris gagal ke tabel ber-shape `failed_jobs`; port batching mengelola `job_batches`.

### laravel/horizon metrics
- verdict: **port** — drain melaporkan `{ran, failed}` + kolom `attempts`; port merekam sample per drain ke D1 `lw_job_metrics`; CF dashboard = half-live.
- substitution: Redis snapshot → tabel D1 + CF analytics (disclosure: polled per drain, bukan gauge per-second).

## Realtime / WebSockets

Grounding: HMAC-SHA256 (hex+base64) byte-identical PHP 8.3.30 ↔ Node crypto → WebCrypto edge bisa menandatangani auth token Pusher persis.

### laravel/reverb v1.12.0
- verdict: **refuse** (paket = server WS) / port untuk endpoint auth — `Broadcast::routes()` mendaftarkan `/broadcasting/auth` sebagai route POST biasa: rung terkompilasi menjawabnya dan WebCrypto menandatangani token privat/presence dgn app secret.
- identity: channel `private-`/`presence-` wajib punya identitas dari guard platform (`ctx.user()` / `ctx.user_id` tulisan `middlewarePorts`) — Laravel menolak channel guarded tanpa user (`Broadcaster::auth()`), dan `user_id` presence diambil dari `$user->getAuthIdentifier()`, bukan dari body. Tanpa identitas → `401`; `channel_data.user_id` kiriman pemanggil tidak pernah dibaca.
- refusal: Reverb adalah proses server WebSocket long-running (`php artisan reverb:start`, socket ReactPHP) di port TCP — edge-impossible. Build menolak listener `ShouldBroadcast` (LW002) + facade `Broadcast` (LW002).
- substitution: server WS Reverb → pihak ketiga kompatibel-Pusher / Ably / Durable Object yang bicara protokol Pusher; config Echo `host`/`authEndpoint` diarahkan ke sana.
- test: oracle PHP menangkap `/broadcasting/auth` (token + data user base64); probe e2e: route terkompilasi menjawab token identik.

### laravel/echo v2.6.3
- verdict: **port** (client-only) — Echo = klien JS browser/Node, tak pernah menyentuh PHP terkompilasi; terhubung ke hub kompatibel-Pusher lewat WSS dan POST ke `authEndpoint` (route auth terkompilasi).
- port: tak ada di repo; bootstrap Echo app dikirim apa adanya dari bundle app.
- test: probe e2e — muat halaman, pastikan WS terhubung ke host terkonfigurasi dan endpoint auth mengembalikan token bertanda-tangan edge.

### pusher/pusher-php-server v7.3.0
- verdict: **port** — auth token SDK (`socket_id`+`channel_name` → `{key}.{HMAC-SHA256}`) = HMAC murni, direproduksi WebCrypto byte-for-byte; trigger = POST HTTPS ke REST API Pusher dgn auth_signature query-string = `fetch`.
- identity: idem reverb — channel guarded butuh identitas guard (`ctx.user()`/`ctx.user_id`); `user_id` presence dari identitas itu, bukan `channel_data` body; tanpa identitas → `401`. Route seam `/broadcast` (trigger) juga butuh identitas: `triggerEvent()` di app code in-process, tapi HTTP route anonim = injeksi event ke channel apa pun dgn secret app → `401` tanpa guard.
- refusal: paket tak terkompilasi (vendor SDK) → LW002 pada resolve langsung.
- substitution: panggilan SDK PHP → tanda-tangan WebCrypto + `fetch` REST (disclosure: protokol & signature sama, tanpa proses server).
- test: oracle PHP menandatangani auth token + REST URL; paritas token & query string edge byte-for-byte.

### beyondcode/laravel-websockets v1.14.1
- verdict: **refuse** (daemon Ratchet/ReactPHP + abandoned sejak 2022). Hanya endpoint auth yang berlanjut — identik dgn Reverb.

### soketi @soketi/soketi v1.6.1
- verdict: **refuse** (sebagai dep terkompilasi) / **substitute** (sebagai hub) — server WS protokol-Pusher berbentuk binary Node; bisa menjadi hub pengganti. Hosting di CF = DO yang bicara protokol Pusher + auth HMAC di edge.

## Search

Pola sama dgn 8 halaman M68: paket vendor (provider + trait + Engine) tak pernah terkompilasi → `Scout::`/`->search()` di route = refused LW002; sisi edge (HTTP/D1) diangkut port handler.

### laravel/scout v11.9.0
- verdict: **port** — kontrak `Searchable` utuh (`toSearchableArray()`, `where()`, `paginate()`, filter soft-delete); sync index = observer pada `save()` → baris job D1 (pola M63).
- refusal: ScoutServiceProvider + trait `Searchable` + kelas `Engine` = vendor → LW002.
- port: `ports/scout-<engine>.mjs` per engine, didaftar di `registry.json`; build fail loud bila model pakai `Searchable` tapi tak ada engine port, atau `scout.queue` aktif tanpa cron trigger (job tak pernah jalan = silent no-op → ditolak).
- test: shadow/PHP oracle — route `search()` dgn driver PHP nyata vs port; kunci = ranking `hits` + pagination.

### meilisearch/meilisearch-php v1.x (v2.0.0-beta.8)
- verdict: **port** — search = POST `fetch` ke `/indexes/{uid}/search` + PUT settings; bentuk `hits`/`estimatedTotalHits` dipertahankan 1:1.
- substitution: guzzle HTTP client → `fetch` global (disclosure satu kalimat).
- port: `ports/scout-meilisearch.mjs` — host/key dari worker secret; PUT settings sekali saat build.

### algolia/algoliasearch-client-php v4.51.0
- verdict: **port** — search = POST `fetch` `/1/indexes/{name}/query` dgn header `X-Algolia-*`.
- port: `ports/scout-algolia.mjs` — APP_ID + API key dari worker secret; `query`/`attributesToRetrieve`/`facetFilters` = kontrak SDK dipertahankan.

### typesense/laravel-scout-typesense-driver + typesense-php
- verdict: **port** — search = GET `fetch` `/collections/{name}/documents/search`; `query_by`/`sort_by` dari config.

### laravel/scout — database engine
- verdict: **substitute** — `SCOUT_DRIVER=database` tanpa service eksternal: D1 punya FTS5 (MAP.md "D1 FTS fallback (padanan)").
- refusal: engine bawaan pakai fulltext MySQL/PG (`MATCH…AGAINST`/tsvector) — D1 = SQLite, 1:1 mustahil; dialect selain sqlite fail loud.
- substitution: fulltext MySQL/PG → D1 FTS5; semantic pgvector → CF Vectorize. Disclosure: rank = SQLite BM25, skor ≠ relevansi MySQL `MATCH…AGAINST`, tak byte-parity.
- test: oracle — query fulltext vs implementasi sqlite FTS5; diverge rank didokumentasikan, bukan senyap.

### laravel/scout — collection engine
- verdict: **refuse** — engine in-memory memuat SEMUA model ke memori; edge tanpa lazy collection / memori PHP (M64/M67). Dev-only. Build fail loud bila `SCOUT_DRIVER=collection`.

### teamtnt/tntsearch
- verdict: **substitute** — index SQLite in-process TNT → D1 FTS5. Disclosure: stemming/BM25 TNT ≠ FTS5, relevansi tak byte-parity. `[INFERENCE]` skor belum diverifikasi (repo belum punya oracle TNT).

## Media & Files

### spatie/laravel-medialibrary v11.23.11
- verdict: **port** (permukaan media) + **substitute** (conversions) — unggah byte → R2/D1-blob (`kernel/storage.mjs`); baris `media` D1 (model/collection/file_name/mime/size/disk); sajikan byte via route port — byte-identical store/read.
- refusal: paket vendor (`HasMedia`) → LW002; **conversions** (resize/crop/watermark) edge-impossible — tanpa GD/Imagick, `kernel/image.mjs` `RASTER_OPS` fail loud.
- substitution: konversi piksel → Cloudflare Images `env.IMAGES.input(stream).transform({width,height,fit}).output()` / `/cdn-cgi/image/<opts>/<url>`. Disclosure: varian dihasilkan CF Images, bukan PHP.

### spatie/laravel-backup v10.3.3
- verdict: **refuse** (edge-impossible) — mysqldump/pg_dump child process + `ZipArchive` + job long-running; tak ada di Worker. Export 500 MB dalam satu request memicu CPU kill — harus di luar edge.

### spatie/laravel-sitemap v8.2.0
- verdict: **port** — XML sitemap = string build dari tabel route terkompilasi + aset statis; `lastmod` dari model `updated_at`. Port handler `GET /sitemap.xml`.

### spatie/laravel-tags v4.12.0
- verdict: **port** — tags = pivot `tags`+`taggables` di atas Eloquent/D1 terkompilasi; `belongsToMany` + `attach/detach/sync/toggle` sudah terkompilasi (M64).

### spatie/laravel-sluggable v4.0.6
- verdict: **port** — slug = `Str::slug` (kernel `str.mjs`, tabel portable-ascii — #294 byte-identical) + lookup unik di D1. Build membaca `$sluggable` → hook beforeSave (slug + loop suffix unik).

### spatie/laravel-activitylog v4.x
- verdict: **port** — log = baris D1 `activity_log` pada event model; observer terkompilasi menulis baris; `activity()->log()` port helper; `causer`/`subject` polymorphic via morph map.
- free-tier: satu tulis D1 ekstra per mutasi → membatasi cap 100k/hari di hot path.

### spatie/laravel-translatable v6.15.0
- verdict: **port** — terjemahan = JSON di kolom model; accessor terkompilasi membaca JSON per `app.locale` + fallback; `whereTranslationLike` → `json_extract(...)`.

### spatie/laravel-model-states v2.14.3
- verdict: **port** — state = nilai kolom + kelas state; custom cast class terkompilasi; build memancarkan cast state + peta transition→target yang diizinkan; penolakan melempar nama exception PHP.

### intervention/image v3.x
- verdict: **substitute** (paketnya refuse) — yang Laravel butuhkan terkompilasi: `imageInfo` header-only (PNG/JPEG/GIF/WebP/BMP/AVIF) menjawab `dimensions()` + rule `image` (byte-identical, tanpa decode).
- refusal: **raster ops** (resize/crop/convert/watermark) edge-impossible — GD/Imagick absen; `RASTER_OPS` fail loud (tak pernah senyap).
- substitution: edit piksel → Cloudflare Images. Disclosure: varian dimensi dari CF Images, bukan PHP GD.

### league/flysystem v3.36.0 (local/S3/R2)
- verdict: **substitute** — facade `Storage::` terkompilasi ke `kernel/storage.mjs` di atas **R2** (`env.R2`) atau **D1 blob** (`lw_blobs`); `put/get/getBytes/exists/delete` + URL bertanda-tangan HMAC sementara.
- refusal: adapter Flysystem = PHP vendor → LW002; driver **local** edge-impossible (tak ada FS lokal); **named disk** refuse (bucket sendiri; R2 minta kartu); SFTP butuh raw TCP.
- substitution: disk local → R2/D1-blob; adapter S3 → endpoint S3-compatible R2.

## Dokumen & Export

### barryvdh/laravel-dompdf v3.1.2
- verdict: **port** — route unduhan biasa; byte PDF mengalir sebagai body `ReadableStream` dgn `Content-Type: application/pdf` (sudah di peta MIME `kernel/http.mjs`).
- refusal: paket + `dompdf/dompdf` = kode PHP murni yang tak terkompilasi; `Pdf::loadView()` → facade → LW002. Layout HTML→PDF + pembacaan metrik font tak bisa jalan di rung PHP edge.
- substitution: `dompdf/dompdf` (PHP) → engine HTML→PDF JS/WASM atau layanan render HTTP. Disclosure: byte keluaran adalah milik engine, bukan dompdf — paritas per-dokumen, bukan byte-for-byte.
- free-tier: layout WASM in-worker membakar budget CPU 10ms/50ms pada dokumen besar; jalur layanan HTTP (outbound `fetch`) menjaga CPU datar.

### barryvdh/laravel-snappy v1.0.5
- verdict: **port** — separuh HTTP sama; Snappy menjalankan `wkhtmltopdf`/`wkhtmltoimage` via `proc_open` (`knplabs/knp-snappy`) — Worker tanpa child process/binary → render lokal edge-impossible.
- substitution: binary wkhtml → layanan render HTTP (Gotenberg / Cloudflare Browser Run). Disclosure: engine berbeda (Chromium vs WebKit wkhtml); keanehan render wkhtmltopdf tak direproduksi 1:1.

### spatie/laravel-pdf v2.13.1
- verdict: **port** — paket sudah mengirim driver berbasis fetch yang jalan native di Worker: **Cloudflare driver** (Browser Run API: satu `fetch`, tanpa Node/Chrome) dan **Gotenberg driver** (HTTP API).
- refusal: driver Browsershot (default) butuh Node+Chromium; driver dompdf = PHP murni; keduanya tak terkompilasi (`Pdf::` facade → LW002).
- substitution: binary Chrome lokal → Cloudflare Browser Run (driver resmi paket — disclosure paling ringan).
- free-tier: Browser Run free = 6 req/menit + 10 menit/hari.

### maatwebsite/excel v4.0.6
- verdict: **port** — penulis CSV = output string murni; data baris dari D1. Export queued/batched = Paid-only.
- refusal: XLSX butuh `php_zip`+`php_xml`+`php_gd2` (ekstensi C PHP yang tak diekspos Worker); `phpoffice/phpspreadsheet`+`Excel::` = vendor → LW002.
- substitution: penulis XLSX PhpSpreadsheet → lib XLSX JS (`kernel/xlsx.mjs`/SheetJS); CSV → emitter CSV edge. Disclosure: style/formula/chart di luar permukaan lib JS dibuang loud.
- free-tier: XLSX in-worker (zip+XML) berisiko p95 pada sheet besar; CSV murah.

### league/csv v9.29.0
- verdict: **substitute** — baca/tulis CSV = teks murni; `text/csv` ada di peta MIME; `str_getcsv` PHP sudah di-port (`strGetcsv` di `kernel/validator.mjs`).
- port: `kernel/csv.mjs` mengekspos metode ber-shape `Writer`/`Reader` (`insertOne`/`insertAll`/`fetchAll`, delimiter/bom/escape).
- substitution: `League\Csv\Writer/Reader` → modul CSV edge di atas aturan `strGetcsv`. Disclosure: wire format (RFC4180, BOM, delimiter, escape `\`) mengikuti default PHP.

## Cache, Session, Rate-Limit

### predis/predis v3.7.1
- verdict: **refuse** (edge-impossible) — klien RESP PHP murni di atas socket TCP; Workers tanpa raw socket. Juga tak terpakai — app mencapainya lewat `Cache::store('redis')`/`session.driver=redis`, keduanya refuse.
- substitution: socket Redis → D1 (`lw_redis`) atau KV; Upstash REST via `fetch` opsional.

### phpredis (ekstensi C pecl)
- verdict: **refuse** — ekstensi C PHP; edge menjalankan JS, tanpa PHP runtime, tanpa pemuatan ekstensi. Edge-impossible + dev-only.

### memcached (driver cache/pecl)
- verdict: **refuse** — tanpa socket + tanpa daemon; build gate menghentikan route yang membaca `rt.cache()` bila `cache.driver !== 'database'` (store berbeda = divergensi senyap).

### laravel/octane v2.23.0
- verdict: **refuse** (N/A infra) — Octane mem-boot server PHP long-running (Swoole/RoadRunner/FrankenPHP); edge tanpa proses long-lived dan tanpa PHP. Tooling boot, bukan kode app. Handler terkompilasi menggantikan loop request Octane sepenuhnya.

### cache driver redis/memcached/dynamodb/file
- verdict: **substitute** (hanya `database` yang jalan) — `database` terkompilasi 1:1 ke D1 (`DatabaseCacheStore`, oracle-verified M18). Driver lain fail build untuk route yang menyentuh cache — store non-database akan divergensi senyap.
- substitution: redis/memcached/dynamodb/file → store `database` D1.

### session driver redis/database
- verdict: **compile** (`database`) / redis **refuse** — `database` → D1 via `DatabaseSessionHandler` (payload base64 json|serialize, `last_activity`, gc); `cookie` → `CookieSessionHandler` terenkripsi stateless (nol tulis D1).
- refusal: `session.driver` wajib `database`|`cookie` saat build; `redis` melempar saat request; `array` melempar; `SESSION_ENCRYPT` tak didukung.

### rate limiter backends
- verdict: **compile** (backend D1) / backend redis/KV **refuse/pending** — middleware `throttle:60,1` + `RateLimiter::for()` terkompilasi; berjalan di store cache `database` D1 (M18). Header `X-RateLimit-*` oracle-verified (M12).
- refusal: facade `RateLimiter` (18 metode) LW002; limiter hanya bisa memakai store cache `database`, jadi backend redis ditolak gate driver cache yang sama.
- catatan: `increment` = baca-lalu-tulis (D1 tanpa transaksi interaktif) — race di bawah konkurensi, ditandai tak atomik.

### laravel/lock (Cache lock / `Locks`)
- verdict: **refuse** (API belum terkompilasi) — substitute siap: `cache_locks` tabel + config `cache.lock_table` sudah di-dump (`config-dump.mjs:290`); port bisa mengimplementasikan `acquire/release/blocked/owner`. Durable Objects = jawaban platform untuk lock/counter atomik.

## Forms, Data & Dev-Tooling

### spatie/laravel-data v4.23.1
- verdict: **port** — bentuk DTO = kode app biasa; `Data::from($request)` setara (validasi via validator terkompilasi, hydrate) jalan; `->toArray()`/`->json()` native.
- refusal: base `Data`, `Optional`, atribut `CastWith`/`TransformerWith` + `DataServiceProvider` = vendor → LW002. Casting Eloquent via relasi → LW003.
- port: modul DTO-sebagai-kelas-app + helper kernel `dataFrom()`; deklarasikan grup config `data` di `registry.json`.

### spatie/laravel-settings v3.10.1
- verdict: **port** — driver DB → D1 `settings` (group+key+json); `Settings::get/set` → `DB::table('settings')`; cache di `Cache::*` terkompilasi.
- refusal: `Settings` + provider/facade = vendor → LW002. Driver `file`/`disk` edge-impossible (tak ada FS lokal).
- substitution: driver `file` → baris D1. Disclosure: settings dipersist di D1, bukan file JSON.
- catatan: repo sudah pernah kena — cachet fatal di dalam spatie/laravel-settings tanpa provider terdaftar (`tools/vendor-lite.mjs:395`).

### spatie/laravel-query-builder v7.3.7
- verdict: **port** — `allowedFilters`/`allowedSorts`/`allowedFields` → `where`/`orderBy`/`select` yang dijawab query builder kernel di jalur `table()`.
- refusal: `QueryBuilder`/`QueryBuilderRequest` + provider = vendor (LW002). `allowedIncludes`/`allowedAppends` memakai relasi Eloquent / `->append()` → LW003.
- port: handler port mem-parsing `filter[...]`/`sort`/`fields[...]` → membangun rantai `DB::table()` per allowlist.

### spatie/laravel-enum v3.x (beku)
- verdict: **port** — helper statis `::toArray()`/`::values()`/`::names()`/`::random()`/`::from()`/`::tryFrom()` = statis biasa yang bisa dibawa kelas enum terkompilasi.
- refusal: baca kasus `State::ACTIVE` langsung fail loud LW002 (case ≠ skalar); `->value`/`->name`/`::cases()` = port. Trait `HasLabels`/`HasComparison`/`HasAttributes` = vendor (LW002). Paket beku di base spatie/enum — usang kini PHP punya enum native.
- port: kelas dasar enum terkompilasi `kernel/enum.mjs`.

### kris/laravel-form-builder ~1.17 (beku)
- verdict: **refuse** — port komponen-form Symfony yang menyasar API Laravel 5–8; terakhir mendukung L5.5, mendahului L13. `FormBuilder`/`form()`/field-type + provider = vendor → LW002.
- port: tak direkomendasikan — permukaan view terkompilasi sudah menjawab `@csrf`/`method_field()`/`@error`/`$errors`; tulis helper `Form` terkompilasi tulis-tangan.

### barryvdh/laravel-cors v3.0.0
- verdict: **substitute** — platform Workers menjawab preflight CORS — `OPTIONS` tak terkompilasi (build fail loud); header CORS per-respons dipancarkan worker (`src/worker.mjs`) atau Cloudflare.
- refusal: middleware `HandleCors` (paket + framework) tak terkompilasi — middleware non-framework-built di stack app mendarat di `middleware.prevented` dan menjawab 500.
- substitution: middleware paket → CORS level platform/worker. Disclosure: CORS ditegakkan config edge runtime, bukan middleware paket; nilai `config/cors.php` harus dicerminkan ke config worker.

### Dev-only (refuse, tak pernah ship): pestphp/pest v5, laravel/dusk v8.x `[INFERENCE]`, laravel/envoy v2.x `[INFERENCE]`, laravel/pint v1.x `[INFERENCE]`, nunomaduro/larastan v3.14.0, laravel/prompts 0.3.25+, laravel/tinker v3.0.2.
- edge: tak ada — PHP CLI / TTY / ChromeDriver / SSH / static-analysis / REPL. Worker tanpa child process, stdin persisten, browser, atau socket SSH.
- port: tak ada. Jalankan lokal/CI. Gerbang paritas repo (shadow harness, PHP oracle, `gate:cpu`) adalah stand-in sisi CI.

## Admin & Livewire

Versi: livewire/livewire **v4.4.8**, livewire/volt **v1.11.2**, filament/filament **v5.11.2**, tallstackui/tallstackui **v4.7.1**.

### livewire/livewire v4.4.8
- verdict: **special** — "install-only" sudah jalan: app yang sekadar memasang Livewire tetap build hijau; view route dikompilasi ke byte Livewire **flag-off** (`compiler/src/livewire-markers.mjs` membuang guard komponen `ExtendBlade::isRenderingLivewireComponent()` + `SupportCompiledWireKeys`, diukur pada Livewire 4.4.8).
- refusal: **runtime komponen Livewire tak ada di edge** — tak ada lifecycle `mount`/`render`, morphing, `wire:model`/`wire:click`, round-trip request komponen. Kelas komponen (punya `render()`/`mount()`) → **LW004** dgn hint port (`compiler/src/controller.mjs:462-465`). Endpoint `/livewire/*` dari provider vendor di luar scan route → wajib dideklarasi di `registry.json` (`tools/routes-dump.mjs:462-468`).
- substitution: interaktivitas Livewire → fetch + komponen non-Livewire; disclosure: tak ada mekanisme reaktivasi server-driven Livewire.

### livewire/volt v1.11.2
- verdict: **refuse** — Volt = API fungsional di atas Livewire; tiap komponen Volt adalah komponen Livewire. Tanpa runtime Livewire, Volt tak punya apa pun yang bisa dijawab edge. `Livewire\Volt\…` → LW002.

### filament/filament v5.11.2
- verdict: **refuse** — Filament 5.x = Server-Driven UI di atas Livewire (Alpine+Tailwind); panel/resource/page/table/form/widget/notification semuanya komponen Livewire. Ratusan komponen Blade/Livewire + renderer SDUI vendor tak terkompilasi; route panel `/admin/…` = komponen Livewire → LW004.
- port: hanya **data** — dashboard/handler sendiri yang membaca/menulis D1 (menggantikan CRUD panel), bukan Filament.
- substitution: panel Filament → app Laravel biasa + komponen Blade terkompilasi + handler D1; disclosure: UI & interaksi Filament (modal, action, filter/pagination live) tak dipertahankan.

### filament/spatie-laravel-media-library-plugin v5.11.2
- verdict: **refuse** — bergantung Filament (semua komponen Livewire → LW002/LW004) + MediaLibrary. Butuh Filament; konversi raster MediaLibrary mustahil di edge (raster ops ditolak `kernel/image.mjs`); hanya `image`/`dimensions` (header) yang terkompilasi.
- substitution: field MediaLibrary Filament → unggah langsung ke R2 (pre-signed) + baris D1; tanpa conversion/formats/registries Spatie.

### tallstackui/tallstackui v4.7.1 (TALL-UI)
- verdict: **special** — paket paling kompatibel di kluster: suite komponen Blade (butuh livewire `^4.3.0` untuk sebagian komponen interaktif). Komponen Blade murni (button, card, icon) yang dipakai di view route terkompilasi bersama view (Blade compile 1:1).
- refusal: **komponen berbasis Livewire** (dropdown/modal/interaktif dgn `wire:`) mati tanpa runtime Livewire (LW004 pada class, guard di-strips); facade `TallStackUi::` + provider vendor → LW002.
- substitution: komponen Livewire TallStackUI → komponen Blade statis + Alpine/fetch lokal; disclosure: perilaku reaktif tak dipertahankan.
- catatan: `dennisvandalen/tall-ui` di Packagist = paket kosong; TallStackUI dinilai sebagai kit TALL-UI nyata `[INFERENCE — nama ambigu]`.

## Observability & Dev

Semua grounding versi: telescope v5.27.0, debugbar v4.4.5, clockwork v5.3.5, pail v1.2.7, tinker v3.0.2, log-viewer v3.24.2, ray v1.43.9, sentry-laravel v4.29.0. Kluster ini hampir seluruhnya **dev-only** → refusal sesuai `MAP.md:259-261`. Kernel tak pernah compile service provider vendor (M68).

### barryvdh/laravel-debugbar v4.4.5 — **refuse** (dev-only). Semua collector (query/log/request) hidup lewat service provider+middleware yang tak bisa compile. Substitution: timing per-request → D1 `lw_metrics` + `wrangler tail`.

### itsgoingd/clockwork v5.3.5 — **refuse** (dev-only + edge-impossible). Data ke file `storage/clockwork` via `Storage::disk('local')` (tak ada FS lokal, `MAP.md:216`).

### laravel/pail v1.2.7 — **refuse** (dev-only + edge-impossible). Artisan command men-tail file log lokal pakai pcntl + polling; edge tanpa child process/FS. Substitution: `wrangler tail`.

### laravel/telescope v5.27.0 — **refuse** (dev-only). `MAP.md:541` sudah memutuskan "local debugger" / NOT APPLICABLE AT EDGE.

### laravel/tinker v3.0.2 — **refuse** (dev-only + edge-impossible). psysh REPL memakai readline/stdin terus-menerus — Worker tanpa stdin persisten.

### opcodesio/log-viewer v3.24.2 — **substitute** (backend storage). Backend membaca `storage/logs/*.log` via `Storage::disk('local')` — edge tanpa FS lokal; frontend route perlu provider (dev-only backend). Substitution: default disk → D1 blob/R2.

### sentry/sentry-laravel v4.29.0 — **port**. `report()` terkompilasi mengirim exception; SDK dsn = `fetch` ke `ingest.sentry.io` (HTTPS native). SDK vendor (client/transport/spans/breadcrumbs) → LW002. Substitution: breadcrumbs/spans → mapping manual (disclosure: bukan full SDK; error event 1:1).

### spatie/laravel-ray v1.43.9 — **refuse** (edge-impossible). `ray()` memakai provider + Socket client ke Ray desktop app lokal — Worker tanpa socket persisten.

**Ringkasan:** 7 refuse (semua dev-only; 4 juga edge-impossible: pail/tinker/ray/clockwork-fs), 1 port (sentry-laravel), 1 substitute (log-viewer). Tak ada yang **compile** penuh.

## HTTP & Integrasi

### guzzlehttp/guzzle 7.16.x (7-line; framework pin ^7)
- verdict: **port** — satu panggilan eksternal = satu `fetch` (native Worker); kernel sudah memakai `fetchImpl || globalThis.fetch` untuk mail/R2.
- refusal: paket = vendor tak terkompilasi; route yang mereferensi `GuzzleHttp\Client` → LW002/LW003. Connection pooling/keep-alive & streamed body di luar `ReadableStream` tak ada (edge-impossible).
- substitution: Guzzle client → `fetch`; disclosure: tanpa socket reuse / persistent conn, respons = satu body (tanpa lazy stream).

### Laravel HTTP client (`Http` facade, framework 13.x)
- verdict: **refuse** (kompilasi di MAP.md baru aspirasional) — facade ada di `FACADE_NAMES` tapi tanpa pemetaan `rt.*`/handler (`COMPILED.md:792`). Ke-99 metode facade ditolak saat build (LW002) — dev-only, tanpa gap senyap.
- port: `ports/<slug>.mjs` per endpoint, atau modul klien kernel ala `PendingRequest` (`withToken`/`asForm`/`acceptJson`/`retry`) di atas `fetch`.
- catatan: baris ✅ di `MAP.md:217` = `[INFERENCE]` rencana, **belum diimplementasi** — `compiler/src/transpiler.mjs` tak punya handler `Http`.
- free-tier: cap 50 subrequest/request = langit-langit keras untuk fan-out.

### stripe/stripe-php v19.x
- verdict: **port** (sama dgn halaman `billing`) — REST Stripe = HTTPS; verifikasi signature = WebCrypto HMAC (pola `cashier-paddle`).
- substitution: SDK client → `fetch` mentah + helper request-signing kecil; disclosure: tanpa auto-retry/idempotency-key, tanpa objek API bertipe.

### aws/aws-sdk-php v3.403.x (S3 → R2)
- verdict: **substitute** — baca/tulis objek = HTTPS + SigV4 (WebCrypto HMAC-SHA256 menandatangani SigV4); R2 bicara API S3.
- refusal: SDK (vendor, Guzzle-backed) tak terkompilasi (LW002); rantai kredensial STS, kms/transcribe dll. melampaui permukaan S3-compat R2 (infra).
- port: adapter storage/kernel yang memirror `Storage::put/get/exists/delete` (repo sudah punya `kernel/storage.mjs` → R2 bila ter-bind, else D1 blob — M30).

## Billing

Port seam: `registry.json → "ports": { "<route>": "<slug>" }`, file `ports/<slug>.mjs` `export default async function handle(ctx, env) → {status,headers,body}` (prioritas tertinggi). Semua skema webhook = HMAC-SHA256 atas string kanonik, memakai preseden kernel verbatim: `kernel/encrypter.mjs` `importHmacKey` + `crypto.subtle.sign`, `timingSafeEqual` constant-time; `kernel/storage.mjs` `hmacHex`.

### laravel/cashier (Stripe) v16.9.0
- verdict: **port** — Stripe HTTPS: checkout `sessions.create→redirect`, verifikasi webhook, portal `billing_portal.sessions.create→redirect`, state subscription di D1 (termasuk kolom meter v16) — semua 1:1.
- refusal: trait `Billable` + service provider = vendor, build tak compile service provider → resolve Cashier LW002. Charge kartu tetap di Stripe (off-edge by design, PCI).
- port: `ports/stripe-webhook.mjs` + `ports/stripe-checkout.mjs`; registry routes `/stripe/webhook`, `/stripe/*/checkout`, `/billing/portal`; secret `env.STRIPE_SECRET`/`STRIPE_WEBHOOK_SECRET`. D1: `subscriptions`, `subscription_items` (+`meter_id`/`meter_event_name`) + kolom billable `stripe_id`/`pm_type`/`pm_last_four`/`trial_ends_at`.
- test: probe — bangun event, tanda-tangani `t.payload` HMAC-SHA256 WebCrypto, POST → 200+baris D1; secret salah → 401; replay idempoten → state tunggal.
- free-tier: ≤1 tulis D1/event; HMAC CPU dapat diabaikan.

### laravel/cashier-paddle v2.8.1
- verdict: **port** — Paddle Billing HTTPS: checkout + portal = fetch; webhook = `Paddle-Signature` HMAC; state trial/pause di D1.
- refusal: sama dgn Stripe — provider + trait `Billable` tak terkompilasi (LW002); pembayaran off-edge (Paddle MoR).
- port: `ports/paddle-webhook.mjs`; registry `/paddle/webhook`; D1: `customers`, `subscriptions` (paddle_id/status/trial_ends_at/paused_at), `subscription_items`, `transactions` — migrasi v2.8.1.
- test: tanda-tangani `ts:body` HMAC-SHA256 (`Paddle-Signature` `ts=…;h1=…`), kunci salah 401, valid → baris; cek toleransi ±5 menit.

### laravel/spark v6 (spark-stripe v6.2.0 / spark-paddle v6.0.0)
- verdict: **special** — Spark = starter-kit komersial (repo privat `spark.laravel.com`, butuh composer-auth + lisensi), bukan paket biasa. Runtime = Cashier/Stripe/Paddle → separuh fetch/D1 webhook sama berlaku; frontend Inertia/Vue = Vite-statis (cocok).
- refusal: seluruh pohon vendor Spark tak terkompilasi (LW002); `spark:install`/artisan + migrasi lokal-saja; unduhan butuh auth lisensi.
- port: pakai ulang port cashier untuk `/stripe/webhook`; D1: migrasi Spark → `subscriptions`/`subscription_items` + `teams` untuk multi-tenant. `[INFERENCE]` nama tabel persis tak terverifikasi.
- substitution: UI plan-switch/portal Spark → port handler + fetch + API Stripe/Paddle; disclosure.

### lemonsqueezy/laravel v1.9.0
- verdict: **port** — catatan: `laravel/lemon-squeezy` tidak ada; resmi = `lemonsqueezy/laravel` (github lmsqueezy/laravel).
- edge: LS HTTPS — checkout URL + `urls.customer_portal` = fetch/redirect; webhook `X-Signature` HMAC-SHA256(hex) atas raw body.
- refusal: service provider + trait `Billable` tak terkompilasi (LW002); pembayaran off-edge (LS MoR).
- port: `ports/lemon-webhook.mjs`; registry `/lemon-squeezy/webhook`; D1: `lemon_squeezy_customers`, `_subscriptions`, `_orders`, `_license_keys`, `_license_key_instances` (migrasi v1.9.0 terverifikasi).
- test: tanda-tangani raw body `X-Signature`; valid → 200+baris, invalid → 401; event `subscription.updated` (proration) memperbarui baris.

### Lintas-kluster: webhook HMAC + D1 + checkout/portal/proration
- Tiga skema = HMAC-SHA256 atas string kanonik: Stripe `Stripe-Signature` `t=…,v1=…` atas `${t}.${payload}` (±5 menit); Paddle `Paddle-Signature` `ts=…;h1=…` atas `${ts}:${body}`; LS `X-Signature` atas body. WebCrypto async — tidak masalah, route webhook tak panas.
- Checkout: `fetch` POST API provider → 302 ke URL hosted. Portal: Stripe `billing_portal.sessions.create` / Paddle `customer_portal_sessions` / LS `urls.customer_portal` → redirect.
- Proration: didelegasikan ke sisi server (Stripe `proration_behavior=create_prorations`; Paddle otomatis; LS `proration:true`). Disclosure: edge TIDAK PERNAH menghitung proration — matematika provider, fungsi 1:1; webhook `invoice.paid`/`subscription.updated` hasilnya hanya mencatat baris D1.
- D1: diturunkan dari migrasi app oleh `tools/schema-compile.php` → `dist/schema.sql` (dibangun + diterapkan deploy mode 2), jadi tabel di atas mendarat di D1 tanpa diubah. Tambahan satu-satunya: tabel replay-guard (`lw_webhook_events`, PK event-id) untuk idempotensi.

---

## Spatie Tenancy & Health

### spatie/laravel-multitenancy v4.3.1
- verdict: **port** — resolusi tenant = lookup D1 per request + boot tenant context sebelum handler; sisanya mengalir lewat pipeline terkompilasi.
- edge: `FindTenant`/`NeedsTenant` middleware → langkah pre-dispatch di kernel; `tenants()` morph map (class→table+id) = data statis; `currentTenant()`/`getTenantKey()` = helper state per request.
- refusal: paket vendor (`MultitenancyServiceProvider`, trait `BelongsToTenant`, closure `makeCurrentTenantUsing`/`getTenantUsing`, task `afterTenantCreated`) → LW002. `Spatie\Multitenancy\` → LW002.
- port: `ports/multitenancy.mjs` — `tenant` global middleware: baca `landlord` domain / header / subdomain (`kernel/router.mjs` domain `{sub}.example.com`, M18) → lookup D1 `landlord.tenants` (PK `id`, kolom `name`/`domain`/`database`) → simpan di `ctx.tenant`; `findForTenant()` helper untuk query ter-scope. Registry `registry.json → middleware["tenant"]`. `[INFERENCE]` nama kolom persis dari migrasi v4 default; verifikasi saat implementasi.
- substitution: task `MakeTenantCurrent`/migrasi per-tenant → satu D1 shared dengan kolom `tenant_id` (SCOPING lewat `findForTenant`), BUKAN multi-database. Disclosure: edge = single-DB tenant-scoped, bukan DB-per-tenant Spatie.
- test: unit — lookup domain→tenant dari D1; e2e probe — `GET /api/x` tanpa tenant → 404 (NeedsTenant), dengan tenant → handler menerima `ctx.tenant.id`.
- free-tier: 1 baca D1 terindeks (domain unique) per request tenant-scoped — 100k/hari cukup.
- evidence: GitHub releases (4.3.1, di atas 4.3.0 2026-10-26); repo `kernel/router.mjs` domain matching ada.

### spatie/laravel-health v1.40.6
- verdict: **compile** (routes terkompilasi) + **port** (check checker) — endpoint `Health::routes()` = route GET biasa → snapshot statis / handler terkompilasi; hasil check = daftar named results yang dijawab handler port.
- edge: route register (`/health`, `/health/json`, `/health/{check}`) mendarat di `routeTable`; middleware `health` → deny saat not configured; format JSON/HTML = render terkompilasi.
- refusal: paket vendor (`HealthServiceProvider`, facade `Health`, checker built-in yang menyentuh Redis/MySQL/phpredis socket/disk) → LW002. `Spatie\Health\` → LW002. Checker `UsedDiskSpace`, `RedisCheck`, `DatabaseCheck` (mysql/pgsql driver) edge-impossible (tanpa FS/socket/persist).
- port: `ports/health.mjs` — `GET /health` handler: jalankan daftar check dari `config('health.checks')` → masing-masing check port (D1 ping via `kernel/db.mjs`, cache read/write via `kernel/cache.mjs`, schedule heartbeat via D1 `health_check_result_histories`) → agregat `ok`/`failed` + HTTP 200/503. Registry `/health` + `/health/json`.
- substitution: checker Redis/phpredis → HTTP ping (atau skip + disclosure); UsedDiskSpace → R2 `head` size; DatabaseCheck → D1 ping. Disclosure: checker = port JS 1:1 semantik, bukan kode vendor.
- test: unit — masing-masing check port → `{ok:true/false,label}`; e2e — `GET /health/json` jawab 200 `{ok:true}` saat semua sehat, 503 saat satu gagal (matikan D1 stub).
- free-tier: hanya diakses probe monitor; 1 baca/tulis D1 per run — di bawah cap.
- evidence: GitHub releases 1.40.6 (di atas 1.40.5 6d ago, 1.40.4 2026-10-26); repo sudah bilang `health:'/up'` framework route 404 di edge (`tools/routes-dump.mjs:407-420`, CHANGELOG #628) — port `/health` menutup gap itu.

### spatie/laravel-onboard v2.6.3
- verdict: **port** — onboarding steps = state per-user di D1; middleware `onboard` redirect bila belum selesai; trait `GetsOnboardingSteps` = kode app yang terkompilasi.
- edge: `steps()`/`complete()`/`inProgressOrFinished()` dihitung dari kolom user; middleware `CheckOnboarding` membaca flag dan redirect.
- refusal: paket vendor (`OnboardServiceProvider`, `OnboardingSteps` collection, config closure `configureUsing`) → LW002; trait di model user = kode vendor.
- port: `ports/onboard.mjs` — middleware `onboard`: baca `user.onboarded_at` (atau kolom step di `lw_users`) → redirect `/onboarding/{next}` bila belum; handler port `GET /onboarding` render checklist + `POST /onboarding/{step}/complete` set flag di D1.
- substitution: — (kolom flag di `lw_users`).
- test: unit — `inProgressOrFinished()` true bila semua step flag set; e2e — user baru hit `/dashboard` → 302 `/onboarding`; selesaikan step → 200.
- free-tier: 1 baca D1 per request user (sudah di-auth path), 1 tulis per step selesai — cukup.
- evidence: GitHub CHANGELOG 2.6.3 (2026-02-26, "Add Laravel 13 compatibility"); Packagist.

### spatie/laravel-welcome-notification v2.5.0
- verdict: **port** — welcome mail = `Mail::to($user)->send(...)` lewat `kernel/mail.mjs` (sudah terkompilasi); tautan set-password = signed URL (`kernel/packages/signedurl.mjs`, pola `temporarySignedRoute`).
- edge: `sendWelcomeNotification()` di controller/user creation → compiled call; `WelcomeNotification` mailable → compiled mailable + view Blade; route `{token}` set-password → handler port.
- refusal: paket vendor (`WelcomeNotification` class extends `Notification` (queue channel), `WelcomeNotificationServiceProvider`, `sendWelcomeNotification` trait method bila di-trait vendor) → LW002. Notifikasi lewat `Notification::send()` (channel database/mail) = port notification cluster terpisah.
- port: `ports/welcome-notification.mjs` — `POST /welcome/accept/{token}` (verify signed token → form set password → D1 update `password`+`welcome_valid_until` null); `kernel/packages/signedurl.mjs` untuk token HMAC + expiry.
- substitution: — (mail + signed URL sudah kernel).
- test: unit — token HMAC + expiry diverifikasi byte-identical dengan oracle `signedurl`; e2e — buat user → mail keluar (log transport outbox) → klik link → set password → login.
- free-tier: 1 mail Resend/log per welcome (di luar cap D1), 1 update D1 saat set password — cukup.
- evidence: Packagist 2.5.0 (2026-02-22); GitHub repo synced 2026-10-22.

### Lintas-kluster: tenant context + health route + mail/signed-URL
- Ketiganya menumpang infrastruktur yang SUDAH ADA di kernel: domain matching (M18), signed URL (Fortify email-verification port), compiled mailable (M5 mail budget), D1 lookup. Tak ada prasyarat baru.
- Gap repo yang ditutup port health: `GET /up` framework-registered yang sampai #628 masih 404 di edge (`tools/routes-dump.mjs:407-420`). Port `/health` = cara idiomatik Spatie untuk menutup gap yang sama.
- Multitenancy = satu-satunya paket di kluster ini yang MENYENTUH hot path (lookup per request). Health/onboard/welcome = cold path.

**Rekomendasi prioritas eksekusi: spatie/laravel-health** — verdict compile+port paling murah, menutup gap `/up` yang sudah tercatat (#628) tanpa prasyarat baru, tak menyentuh hot path, dan bisa diverifikasi e2e (200/503) dalam satu handler port.

---

## AI & Agent

### laravel/ai v1.3.0 (2026-10-19)
- verdict: **port** — provider call = HTTPS `fetch`; prompt/messages = kode app terkompilasi.
- edge: 1:1 untuk non-streaming generate (OpenAI/Anthropic/Gemini/Groq via `config/ai.php` dump + secret), **tool-use** (tools = compiled app classes; loop `tool_calls` → dispatch → lanjut), structured output, embeddings, conversation D1 (`agent_conversations`/`_messages`).
- refusal: paket tak terkompilasi (`Ai::`/`agent()` → LW002); **`stream()` tak bisa 1:1 hari ini** — lihat catatan koreksi streaming.
- port: `ports/packages/ai-sdk.mjs` + registry `/ai/*`; D1 tabel di atas; secrets `OPENAI_API_KEY` dkk.
- test: probe e2e `POST /ai/chat` non-stream → paritas + D1 row; oracle JSON tool-call.
- free-tier: 1 subrequest fetch + 0–2 D1 tulis; 10ms CPU OK (fetch menunggu I/O). muat (non-stream).
- evidence: Packagist v1.3.0; laravel.com/docs/13.x/ai-sdk.md.

### laravel/mcp v1.1.2 (2026-10-26)
- verdict: **port** (web half); `local` = **refuse** (stdio).
- edge: server web 1:1 — `initialize`/`tools/list`/`tools/call`/`prompts`/`resources` → JSON-RPC via route terkompilasi; tools = compiled app classes; auth OAuth/Sanctum via lapisan yang ada.
- refusal: transport **stdio** (`local` server, `mcp:start` Artisan) = edge-impossible (tak ada child process). SSE transport ikut gap streaming.
- port: `ports/packages/mcp.mjs` (router JSON-RPC → compiled tool registry); tanpa D1 wajib.
- test: MCP Inspector / probe e2e `tools/call` argumen known.
- free-tier: murni JSON + subrequest; muat.
- evidence: Packagist v1.1.2; laravel.com/docs/13.x/mcp.md.

### prism-php/prism v0.103.0 (2026-11-07)
- verdict: **port** — `Prism::text()` = HTTPS fetch; tool-use = compiled classes; conversation = D1.
- edge: non-streaming + function calling 1:1; structured output.
- refusal: `->stream()` = ReadableStream → gap runtime (sama). Paket tak terkompilasi → LW002.
- port: `ports/packages/prism.mjs`; D1 `prism_*`; secrets API key.
- test: probe e2e non-stream + tool-call oracle.
- free-tier: muat; streaming menunggu runtime-stream.
- evidence: Packagist p2 v0.103.0.

### openai-php/laravel v0.22.0 (2026-10-31)
- verdict: **port** — wrapper `OpenAI::client()` di atas `openai-php/client` (Guzzle→fetch).
- edge: non-streaming chat/completions, function calling (tool_calls loop), embeddings 1:1.
- refusal: `createStreamed()`/SSE = gap streaming (sama); paket tak terkompilasi → LW002.
- port: `ports/packages/openai-php.mjs`; tanpa D1 wajib; secret `OPENAI_API_KEY`.
- test: probe e2e chat non-stream; unit decode tool_calls.
- free-tier: muat.
- evidence: Packagist v0.22.0.

### laravel/boost v2.10.4 (2026-10-29)
- verdict: **refuse** (**dev-only**) — alat AI dev, `require-dev`, CLI + MCP stdio + `symfony/process`.
- refusal: seluruh permukaan di mesin dev (child process) — edge-impossible di Worker.
- port: tak ada. MCP server Boost = local/stdio → ikut refusal MCP.
- evidence: Packagist v2.10.4; MAP `boost ⛔`.

**Prioritas: perluas dulu kontrak body port untuk `ReadableStream`** (prasyarat semua streaming), lalu `ports/packages/ai-sdk.mjs` (laravel/ai) — satu paket mencakup 4 provider + tool-use + D1.

---

## Frontend SPA

### inertiajs/inertia-laravel v3.6.0 (2026-10-30)
- verdict: **port**
- edge: seluruh kontrak server Inertia 1:1 — `Inertia::render()` non-XHR = HTML shell (Blade terkompilasi), `X-Inertia` header = JSON `{component, props, url, version, ...}`; `share()` di-resolve saat build.
- refusal: `inertia:start-ssr` (`inertia-node`) = edge-impossible (butuh Node child process); CSR jadi jalur.
- port: `ports/packages/inertia.mjs` — set `X-Inertia`/`Vary: Accept`, `303` setelah X-Inertia PUT/PATCH/DELETE/QUERY, `409 + X-Inertia-Location` saat version mismatch; flag `frontend.inertia`; tanpa D1.
- test: unit dump controller `inertia('Page', [...])` → JSON page-object vs PHP oracle; probe e2e version mismatch → 409.
- free-tier: muat.
- evidence: Packagist v3.6.0 (PR #925/#927); MAP.md:229 "Inertia feasible (JSON port) phase 3".

### laravel/folio v1.2.0
- verdict: **compile** (dump path→route) + **port** ringan (middleware per-path).
- edge: Blade `views/pages/**` → route terkompilasi saat build (`Folio::path()->uri()->middleware()`, index, `[param]`/`{param}`, nested).
- refusal: subdomain routing (`->domain()`) = edge-impossible di Workers single-zone [INFERENCE]; render-hook closure vendor tak terkompilasi.
- port: generator `Folio::path` di dump fase routes; `ports/packages/folio-middleware.mjs` untuk middleware per-path.
- test: `routes:list` Folio vs `dist/src/routes.generated.mjs`.
- free-tier: netral.
- evidence: Packagist v1.2.0; MAP `folio ⛔ NOT ported`.

### laravel/wayfinder v0.1.23 (2026-10-16)
- verdict: **compile** (build-time generator) — vendor tak pernah hidup di edge.
- edge: output TypeScript dari route terkompilasi dihasilkan di build → artefak statis; `QUERY` method didukung.
- refusal: `wayfinder:generate` = dev-only; `laravel/ranger`+`surveyor` butuh DB scan di build.
- port: bukan runtime; `tools/wayfinder-dump.mjs` baca `dist/src/routes.generated.mjs` → emit `resources/js/wayfinder.ts`.
- test: golden-file `routes.ts` vs referensi PHP.
- free-tier: nol dampak runtime.
- evidence: Packagist v0.1.23 (Beta/API unstable).

**Prioritas: inertia-laravel dulu** (fase-3 MAP, permukaan terkecil, preseden untuk Jetstream/Breeze/Spark).

---

## Observability dashboards

### laravel/pulse v2.x (di integrations.json sebagai 'pulse')
- verdict: **port** — dashboard = route terkompilasi + D1 table + fetch ke sumber.
- edge: rekaman data (recorders) → D1 writes; halaman dashboard → compiled view; filter/range → query param.
- refusal: node stats (Octane/supervisor) = infra; tak relevan tanpa itu.
- port: `ports/packages/pulse.mjs` + registry `/pulse/*`; D1 `pulse_aggregates`, `pulse_entries`.
- test: probe e2e — tulis sample entry → halaman dashboard menampilkan agregasi.
- free-tier: D1 writes muat (jauh di bawah 100k/hari); data ringkas.
- evidence: laravel.com/docs/13.x/pulse.md; integrations.json M68.

### laravel/nightwatch
- verdict: **refuse** (**infra/daemon**) — agent terinstall di server asli, streaming telemetry ke layanan Nightwatch.
- refusal: butuh server dengan agent; edge tak punya.
- port: tak ada.
- evidence: laravel.com/docs/13.x/nightwatch.md.

### bugsnag/bugsnag-laravel
- verdict: **port** — `Bugsnag::notifyException()` = POST JSON ke API Bugsnag (`notify.bugsnag.com`).
- edge: exception → POST payload (error class, message, stacktrace ringkas) via fetch; `notify()` di compiled `catch`/error path.
- refusal: native Breadcrumbs dari kernel events — sebagai port eksplisit saja.
- port: `ports/packages/bugsnag.mjs` + `notify.bugsnag.com`; secret `BUGSNAG_API_KEY`; tanpa D1.
- test: unit fake-fetch URL + payload shape; e2e — lempar error → request Bugsnag tercatat.
- free-tier: 1 fetch/error; muat.
- evidence: Packagist; api.bugsnag.com/docs.

**Prioritas: pulse** — paling dipakai, menutup observability in-app tanpa dependensi eksternal.

---

## Admin panels

### laravel/nova, orchid/platform, backpack/crud, moonshine, encore/laravel-admin
- verdict: **refuse** (**edge-impossible**) untuk keseluruhan; sebagian kecil **compile/port** bila dipakai.
- edge: resource/index/show/CRUD = pola app yang terkompilasi bila ditulis ulang; tapi tak ada yang memaksa ini.
- refusal: masing-masing butuh: asset/Vite pipeline penuh + `Table`/`Form` builder runtime besar (orchid), scaffolding + konvensi kelas vendor luas (backpack), publisher asset + Blade liveview + `nova` CLI (Nova tertutup/licensed), enum/menu system (moonshine), asset + CRUD grid (encore). Semua memuat layer runtime yang edge tak bisa boot → degradasi senyap dihindari = refuse.
- port: — (bukan port yang masuk akal; lebih baik app memakai compiled view + D1 langsung).
- substitution: Filament (sudah port-pipeline) atau compiled Laravel table/form DIY.
- free-tier: n/a (refuse).
- evidence: Packagist masing-masing; MAP admin panel tak menandai.

---

## Spatie HTTP middleware

### spatie/laravel-responsecache
- verdict: **port** — cache full-page di D1 `cache_response` (path+query sebagai key), serve bila tidak expired; purge pada POST/PUT/PATCH/DELETE.
- edge: middleware cache-before + cache-after + invalidation 1:1; `CacheResponse`/`DoNotCacheResponse` via penanda.
- refusal: paket tak terkompilasi (middleware vendor) → LW002.
- port: `kernel/packages/response-cache.mjs` + compiled middleware; D1 `cache_response` (`path, hash, body, headers, ttl`).
- test: oracle — request kedua 200 + header `X-Cache: hit`; purge setelah POST.
- free-tier: 1 D1 read/hit; muat.
- evidence: Packagist; README.

### spatie/laravel-csp
- verdict: **port** — bangun `Content-Security-Policy` header dari config dump + compiled nonce.
- edge: nonce per-request + `@cspNonce` directive terkompilasi; policy dari config.
- refusal: paket tak terkompilasi (facade `Csp::` + middleware vendor).
- port: `kernel/packages/csp.mjs` + compiled middleware; nonce di `dist` runtime; tanpa D1.
- test: oracle — header CSP string identik + nonce berubah per request.
- free-tier: muat.
- evidence: Packagist; README.

### spatie/laravel-honeypot
- verdict: **port** — render hidden field (name/timestamp) di form + validasi POST.
- edge: `@honeypot` directive terkompilasi; `Honeypot::ensure` sebagai middleware compiled.
- refusal: paket tak terkompilasi.
- port: `kernel/packages/honeypot.mjs` + compiled middleware; tanpa D1 (cek delta timestamp).
- test: oracle — POST tanpa field → 403; dengan field fresh → pass.
- free-tier: muat.
- evidence: Packagist; README.

### spatie/laravel-route-attributes
- verdict: **special** (build-time) — baca `#[Route(...)]`/`#[Get]` di controller app saat dump fase routes → route terkompilasi.
- edge: atribut di kelas app = kode app, dibaca build; tak ada runtime vendor.
- refusal: paket PHP (spatie/phpunit-attributes, attribute parser) tidak dijalankan di edge.
- port: `tools/route-attributes-dump.php` (pola `tools/*-dump.php`).
- test: atribut → route:list identik.
- free-tier: netral.
- evidence: Packagist; README.

### spatie/laravel-blade-comments
- verdict: **compile** — precompiler komentar Blade `{{-- --}}` → hapus saat build (Blade parser sudah support `{{--`).
- edge: tak ada runtime vendor; komentar dihapus saat kompilasi Blade.
- refusal: paket tak terkompilasi.
- port: tidak perlu — sudah didukung transpiler `{{--`/`--}}`.
- test: view berkomentar → output tanpa komentar.
- free-tier: netral.
- evidence: Packagist; README.

**Prioritas: response-cache** — paling dipakai, dampak free-tier terbesar (hemat origin).

---

## Spatie webhooks

### spatie/laravel-webhook-client
- verdict: **port**
- edge: signature verification (HMAC SHA256 via WebCrypto) + event dispatch ke compiled handlers; D1 `webhook_calls` table.
- refusal: paket tak terkompilasi (facade `WebhookClient`, job queue). Queue `webhook_calls` = sync/queue (drain terkompilasi).
- port: `ports/packages/webhook-client.mjs` + `kernel/packages/webhook.mjs` (sudah ada untuk Stripe/Paddle/Lemon — dipakai ulang); D1 `webhook_calls` (`id, name, payload, exception, processed_at`).
- test: oracle — payload + signature benar → processed; salah → 400.
- free-tier: 1 D1 tulis + drain; muat.
- evidence: Packagist; README.

### spatie/laravel-webhook-server
- verdict: **port**
- edge: kirim webhook → `webhook_calls` + POST ke endpoint; retry via queue drain; signature HMAC.
- refusal: paket tak terkompilasi (facade + job).
- port: `ports/packages/webhook-server.mjs` + kernel helper; D1 `webhook_calls` (tabel sama).
- identity: route seam `/webhook-server/send` butuh caller terautentikasi (`ctx.user()`/`ctx.user_id` a `middlewarePorts` guard) → `401` tanpa itu; app code memanggil `signPayload` in-process, dan `headers` dari caller tak pernah menggantikan `webhook-signature`/`webhook-timestamp` kanonik.
- test: unit fake-fetch — signature benar di header.
- free-tier: 1 fetch + D1 tulis; muat.
- evidence: Packagist; README.

**Prioritas: webhook-client** — menutup verifikasi inbound yang sama dengan Stripe/Paddle (kernel/packages/webhook.mjs sudah ada).

---

## Spatie misc A

### spatie/laravel-menu v4.2.2 (2026-02-21)
- verdict: **port** — builder murni PHP → HTML; `->action()`/`->route()` 1:1 dengan URL terkompilasi; `setActiveFromRequest()` baca path request.
- refusal: paket tak terkompilasi (`MenuServiceProvider` + alias `Menu` → LW003); macro `Menu::macro` di provider/closure.
- port: `kernel/packages/menu.mjs` (builder fluent + renderer HTML) + dump definisi macro saat build; tanpa D1.
- test: oracle — HTML menu path `/about` vs `/contact` (active state).
- free-tier: 0 D1; muat.
- evidence: Packagist p2 v4.2.2; 3.1M unduhan.

### spatie/laravel-navigation v1.3.0 (2024-09-20)
- verdict: **port** — **renderless** (output JSON: `tree()`, `breadcrumbs()`, `current()`); active dari URL.
- refusal: facade `Navigation::` + provider = vendor → LW003.
- port: `kernel/packages/navigation.mjs` (builder `add/addIf/section` → JSON); item di-dump build; branch `addIf` dievaluasi runtime.
- test: oracle — `tree()` + `breadcrumbs()` untuk path identik.
- free-tier: 0 D1; muat.
- evidence: Packagist p2 v1.3.0.

### spatie/laravel-html v3.13.0 (2026-02-22)
- verdict: **port** — elemen immutable & deterministik; `old()` terkompilasi.
- refusal: `Html` facade + helper `html()` (autoload files) = vendor → LW001/LW003.
- port: `kernel/packages/html.mjs` — subset elemen (`span/div/input/email/select/...`) + runtime helper `html()`; tanpa D1.
- test: oracle — string HTML + kasus old-value.
- free-tier: 0 D1; muat.
- evidence: Packagist p2 v3.13.0.

### spatie/laravel-options v1.3.0 (2026-04-07)
- verdict: **port** — transform murni → array `label`/`value` (`forEnum/forArray/forModels/forStates`, `sort/filter/append/nullable/only/except`, `toArray/toJson`, `toValidationRule`).
- refusal: facade `Options::` + provider = vendor → LW003; `forEnum` butuh enum cases (dump build).
- port: `kernel/packages/options.mjs` + enum cases di-dump; `forModels` lewat query D1; tanpa D1 sendiri.
- test: unit — `forEnum->toArray()` + `nullable('Gandalf')` + `toValidationRule()`.
- free-tier: muat.
- evidence: Packagist p2 v1.3.0.

### spatie/laravel-email — **TIDAK ADA**
- verdict: **refuse** (bukan soal edge) — Packagist API `p2/spatie/laravel-email.json` → HTTP 404; tidak ada di daftar paket Spatie.
- kandidat terdekat: `spatie/laravel-mailcoach-mailer` (**port**), `spatie/laravel-newsletter` (**port**), `spatie/laravel-database-mail-templates` (**port** tabel `mail_templates`).
- **Prioritas: spatie/laravel-menu** (3.1M unduhan, terkandung, pola dump provider bisa dipakai ulang).

---

## Spatie misc B

### spatie/laravel-personal-data-export
- verdict: **refuse** (**edge-impossible**) [INFERENCE versi].
- edge: paket ini menjadwalkan job yang membuat ZIP dari model user + media — butuh file-system + zip library + job; edge tanpa FS.
- refusal: pembuatan ZIP + file output = edge-impossible; job async menulis file.
- port: — (bisa port jalur download JSON darurat, tapi bukan paket penuh).
- substitution: export JSON stream (R2) bila perlu.
- free-tier: n/a.
- evidence: Packagist; README.

### spatie/laravel-site-search
- verdict: **port** — index ke meilisearch/typesense (scout sudah port) + query route.
- edge: `SiteSearch::index()` → push dokumen; `search()` → query scout (sudah ada).
- refusal: paket tak terkompilasi (facade + model observer).
- port: `ports/packages/site-search.mjs` + registry `/search`; D1 `site_search_indexes`.
- test: unit — index → meili push; search → meili query.
- free-tier: subrequest meili; muat.
- evidence: Packagist; README.

### spatie/laravel-analytics
- verdict: **port** — fetch Google Analytics Reporting API v4 (OAuth service account) → laporan.
- edge: auth service-account (JWT RS256, WebCrypto) + fetch GA4 API; route laporan compiled view.
- refusal: paket tak terkompilasi; Google SDK `google/apiclient` berat.
- port: `ports/packages/analytics.mjs` + `kernel/packages/google-auth.mjs` (JWT mint); secret service-account JSON.
- test: unit fake-fetch — JWT header/klaim benar; response GA4 dipetakan.
- free-tier: 1 fetch + D1 cache laporan; muat.
- evidence: Packagist; GA4 API docs.

### spatie/laravel-fractal
- verdict: **substitute** — `Fractal::collection()` transformer → serialisasi JSON di compiled app (transformer = kode app).
- edge: transformer bisa langsung dipanggil sebagai function app.
- refusal: paket tak terkompilasi (facade).
- port: tidak perlu; substitusi = app memanggil transformer → JSON.
- substitution: `->collection($items, fn($x) => [...])` → compiled closure. Disclosure: kehilangan pagination/`?include` otomatis Fractal.
- free-tier: muat.
- evidence: Packagist; README.

**Prioritas: spatie/laravel-site-search** — memakai pipeline scout yang sudah port.

---

## Spatie media extras

### spatie/browsershot
- verdict: **refuse** (**edge-impossible**) — butuh headless Chrome/Puppeteer + FS.
- refusal: subproses Chrome, rendering HTML→PNG/PDF, file output — semuanya tak ada di edge.
- port: tak ada.
- substitution: screenshot/PDF via layanan eksternal (Bannerbear, ApiFlash) → fetch.
- free-tier: n/a.
- evidence: Packagist; README.

### spatie/laravel-glide
- verdict: **port** — `GlideImage::render()` → URL gambar; server = route yang memproses param resize/crop.
- edge: param transform → URL; server handler = port yang memproses via external image service (imgproxy/Cloudflare Image Resizing).
- refusal: proses gambar lokal (intervention di `spatie/image` → sudah port/substitute).
- port: `ports/packages/glide.mjs` + registry `/img/{path}`; substitusi ke Cloudflare Image Resizing (free 100k/mo).
- test: probe e2e — `/img/x.jpg?w=200` → respons resized.
- free-tier: CF Image Resizing free tier muat.
- evidence: Packagist; README.

### spatie/image-optimizer
- verdict: **refuse** (**infra**) — butuh binari `jpegoptim`/`optipng`/`pngquant` (optimizer CLI) di build/server.
- refusal: optimasi saat upload butuh subproses; edge tak bisa.
- port: tak ada.
- substitution: CF Image Resizing auto-optimize.
- free-tier: n/a.
- evidence: Packagist; README.

**Prioritas: laravel-glide** — menutup URL transform, memakai CF Image Resizing gratis.

---

## 2FA & security

### pragmarx/google2fa
- verdict: **substitute** — TOTP sudah ada di `kernel/packages/totp.mjs` (base32, HMAC-SHA1 WebCrypto, RFC 6238/4226, ±1 window, `otpauth://`, recovery codes, diuji RFC test vector).
- edge: generate/verify code 1:1.
- refusal: paket tak terkompilasi (library PHP `paragonie/constant_time_encoding`).
- port: tak perlu; `kernel/packages/totp.mjs` sudah cover.
- test: RFC 6238 test vector (sudah di `tools/tests/packages-fortify-2fa.test.mjs`).
- free-tier: n/a (murni CPU).
- evidence: Packagist; RFC 6238.

### bacon/bacon-qr-code
- verdict: **port** (SVG) / **refuse** (PNG).
- edge: QR data → SVG string (deterministik) bisa port; PNG butuh GD/image lib.
- refusal: PNG render (GD, zlib) — tak ada di edge; pakai external API untuk PNG.
- port: `kernel/packages/qrcode.mjs` — encoder QR (byte mode, error correction) → SVG; tanpa D1.
- test: decode SVG dengan reader eksternal; compare data byte.
- free-tier: muat.
- evidence: Packagist; README.

### spatie/laravel-one-time-passwords
- verdict: **substitute** — OTP via totp primitif + D1 `one_time_passwords` (`id, code, valid_until, used_at`).
- edge: generate/validate code, TTL, one-time.
- refusal: paket tak terkompilasi.
- port: `kernel/packages/otp.mjs` + D1; atau reuse `kernel/packages/totp.mjs`.
- test: unit — kode expire/used → reject.
- free-tier: D1 writes muat.
- evidence: Packagist; README.

### robthree/twofactorauth
- verdict: **refuse** (dependency) — library PHP dengan beberapa backend (Google2FA); konsumen sebaiknya pakai totp primitif.
- refusal: paket PHP tak terkompilasi; tak ada nilai tambah di edge.
- port: tak ada; gunakan `kernel/packages/totp.mjs`.
- evidence: Packagist; README.

**Koreksi sudah ditambahkan ke "Catatan koreksi klaim repo": 2FA SUDAH punya modul kernel (`totp.mjs`).**

---

## Notification channels

### laravel-notification-channels/telegram v8.0.0
- verdict: **port** — POST JSON ke `api.telegram.org/bot{TOKEN}/sendMessage` (chat_id, text, parse_mode, reply_markup); transport HTTP murni.
- port: `ports/packages/telegram-notification.mjs`; env `TELEGRAM_BOT_TOKEN`; payload `{to|chat_id, body|text, parse_mode?, keyboard?}`; registry `/notify/telegram`.
- test: unit fake-fetch — URL + body; 422 tanpa chat_id; 500 tanpa token; 0 fetch.
- free-tier: 1 fetch/kirim; muat.
- evidence: Packagist v8.0.0 (2026-09-04).

### laravel-notification-channels/discord
- verdict: **port** — (a) webhook URL verbatim `POST {webhookUrl}` JSON; (b) bot API `api/v10/channels/{id}/messages` + Bearer.
- port: `ports/packages/discord-notification.mjs`; env `DISCORD_WEBHOOK_URL`/`DISCORD_BOT_TOKEN`; payload `{webhook|to, content|body, embeds?, username?, avatar_url?}`.
- test: unit fake-fetch — webhook tanpa auth; bot path + Bearer.
- free-tier: 1 fetch/kirim; muat.
- evidence: laravel-notification-channels.com/discord.

### laravel-notification-channels/expo v2.5.0
- verdict: **port** — `POST exp.host/--/api/v2/push/send` JSON; opsional Bearer accessToken.
- port: `ports/packages/expo-notification.mjs`; env `EXPO_ACCESS_TOKEN`; payload `{to|token, title?, body|text, ...}`; registry `/notify/expo`.
- test: unit fake-fetch — status `ok` mapping; 429/4xx diteruskan.
- free-tier: 1 fetch/kirim; muat.
- evidence: Packagist v2.5.0 (2026-10-04).

### laravel-notification-channels/fcm v6.2.0
- verdict: **port** — FCM HTTP v1: JWT RS256 dari service-account JSON → OAuth2 token → `fcm.googleapis.com/v1/projects/{id}/messages:send`.
- port: `ports/packages/fcm-notification.mjs` + `kernel/packages/fcm-oauth.mjs` (JWT mint + token cache); env `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON`.
- substitution: `kreait/firebase-php` → 2 fetch sendiri. **Disclosure: satu-satunya yang mengganti dependensi vendor dengan kode kripto sendiri.**
- test: unit dua tahap — mint (JWT header/klaim) + send (Bearer + URL); token expire → mint ulang.
- free-tier: 2 subrequest (1 bila cache); muat.
- evidence: Packagist v6.2.0; firebase docs auth-server.

### laravel-notification-channels/webpush v13.0.1
- verdict: **port** — RFC 8291 `aes128gcm` (ECDH P-256 + HKDF + AES-128-GCM) + RFC 8292 VAPID ES256 → `POST <endpoint>`.
- port: `ports/packages/webpush-notification.mjs` + `kernel/packages/webpush-crypto.mjs`; env `VAPID_*`; **D1 `webpush_subscriptions`** (`id, endpoint UNIQUE, p256dh, auth`).
- substitution: `minishlink/web-push` → helper WebCrypto. **Disclosure: enkripsi RFC 8291/8292 ditulis sendiri.**
- test: unit — decrypt jalur penerima; VAPID JWT `aud`/`exp`; 410/403 diteruskan.
- free-tier: 1 fetch + D1 read; muat.
- evidence: Packagist v13.0.1; RFC 8291/8292.

### laravel-notification-channels/onesignal v2.8.1
- verdict: **port** — `POST api.onesignal.com/notifications` + `Authorization: Basic {REST_API_KEY}`.
- port: `ports/packages/onesignal-notification.mjs`; env `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY`; payload `{to|playerIds|externalUserIds|segments, ...}`.
- test: unit fake-fetch — header Basic + body app_id/include_player_ids/contents.en.
- free-tier: 1 fetch/kirim; muat.
- evidence: Packagist v2.8.1.

**Prioritas: telegram** (paling kecil, preseden ketiga pola `/notify/*`); lalu discord → expo → onesignal → fcm → webpush (dua terakhir bawa helper + D1 baru).

---

## Auth extras

### tymon/php-open-source-saver/jwt-auth
- verdict: **port** — JWT (HS256/RS256) via WebCrypto (sama primitif passport).
- edge: `JWTAuth::attempt()` → token; `auth:api` guard → parse token (header Bearer).
- refusal: paket tak terkompilasi (facade + guard).
- port: `ports/packages/jwt-auth.mjs` + `kernel/packages/token.mjs` (reuse); D1 `users` lookup; secret `JWT_SECRET`/`JWT_PRIVATE_KEY`.
- test: unit — token mint → verify; expired → 401.
- free-tier: muat (murni WebCrypto).
- evidence: Packagist; README.

### firebase/php-jwt
- verdict: **port** — JWT encode/decode (RS256/HS256) via WebCrypto.
- edge: verifikasi token dari Firebase/Auth0 → decode header/payload/signature.
- refusal: paket PHP tak terkompilasi.
- port: `kernel/packages/token.mjs` (reuse) — expose `jwtVerify`/`jwtSign`.
- test: unit — token RFC → verify; signature salah → 401.
- free-tier: muat.
- evidence: Packagist; README.

### kreait/laravel-firebase
- verdict: **substitute** — Firebase Auth/RDBMS via REST API + JWT mint (reuse `kernel/packages/token.mjs`).
- edge: `auth()->signInWithEmailAndPassword()` → POST REST; FCM via `kernel/packages/fcm-oauth.mjs`.
- refusal: paket tak terkompilasi (SDK besar).
- substitution: fetch ke `identitytoolkit.googleapis.com` + JWT (service-account). Disclosure: kehilangan SDK admin helper.
- test: unit fake-fetch — endpoint + payload.
- free-tier: muat.
- evidence: Packagist; Firebase REST docs.

### auth0/auth0-php
- verdict: **port** — universal login callback → token exchange (fetch) + JWT verify (WebCrypto).
- edge: `auth0()->getUser()` → POST `/oauth/token` + decode JWT.
- refusal: paket tak terkompilasi (SDK).
- port: `ports/packages/auth0.mjs`; env `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID/SECRET`; D1 `users` lookup.
- test: unit fake-fetch — token exchange + JWT verify.
- free-tier: 1 fetch; muat.
- evidence: Packagist; Auth0 docs.

**Prioritas: jwt-auth** — reuse primitif passport/token yang sudah ada.

---

## Filament ecosystem

### filament/spatie-laravel-settings-plugin, filament-shields, filament-plugin-skeleton, filament-spatie-media-library
- verdict: **refuse** (**edge-impossible**) untuk plugin berbasis Livewire (semua plugin Filament berjalan di atas Livewire runtime yang tak ada).
- edge: resource classes (form/table/schema) = kode app yang IDEALLY terkompilasi — tapi plugin meng-extend Livewire komponen vendor.
- refusal: plugin memakai Livewire/`Filament` facade/`Asset` — tak bisa boot di edge; media-library plugin bergantung pada `spatie/laravel-medialibrary` (sudah port pipeline, tapi plugin Livewire-nya tak terkompilasi).
- port: — (bukan port yang masuk akal; plugin = konfigurasi Filament).
- substitution: Form/Table builder via compiled Laravel view (tidak lewat Livewire).
- free-tier: n/a.
- evidence: Packagist; Filament docs.

---

## Livewire ecosystem

### wireui/wireui
- verdict: **special** — komponen Livewire; pola yang sama seperti Livewire core (dump komponen → port tulis-tangan per komponen).
- edge: komponen basic (button/input/badge) = Blade + kecil, bisa port tulis-tangan; yang kompleks (modal, notify) perlu runtime Livewire.
- refusal: Livewire runtime tak ada → komponen yang bergantung wiring JS/Livewire tak bisa.
- port: `ports/packages/wireui-*.mjs` per komponen yang dipakai; D1 tidak wajib.
- substitution: Flux UI / Tailwind UI via Blade statis.
- free-tier: muat.
- evidence: Packagist; README.

### fluxui/flux
- verdict: **special** — Flux = Tailwind + Blade components + Livewire; komponen basic port tulis-tangan, yang Livewire-aware tak bisa.
- edge: `flux:button`, `flux:input` = Blade statis → compile.
- refusal: `flux:modal`/`flux:toast` Livewire-backed → tak bisa.
- port: per komponen yang dipakai.
- free-tier: muat.
- evidence: fluxui.com; README.

### jantinnerezo/livewire-alert
- verdict: **refuse** (**dev-only**/edge-impossible) — terikat runtime Livewire + dispatch browser event.
- refusal: butuh Livewire event loop di browser; tak ada runtime.
- port: tak ada.
- substitution: Toast via inline JS/Blade.
- free-tier: n/a.
- evidence: Packagist; README.

### andrewdwallo/laravel-livewire-wizard
- verdict: **refuse** (**edge-impossible**) — wizard multi-step dengan Livewire state.
- refusal: Livewire runtime.
- port: tak ada.
- substitution: step form via session state terkompilasi.
- free-tier: n/a.
- evidence: Packagist; README.

---

## SEO & URLs

### artesaos/seotools
- verdict: **port** — meta tags builder → string HTML dari config dump (`SEO::setTitle`, `setDescription`, `openGraph`).
- edge: `{!! SEO::generate() !!}` → meta tags; setTitle/Description 1:1.
- refusal: paket tak terkompilasi (facade + service provider).
- port: `kernel/packages/seo.mjs` — builder meta + OG/JSON-LD; tanpa D1.
- test: oracle — tag HTML identik.
- free-tier: muat.
- evidence: Packagist; README.

### spatie/laravel-googletagmanager
- verdict: **port** — `@gtag` directive → script tag + dataLayer; consent mode.
- edge: kode JS snippet = Blade partial terkompilasi; GTM id dari config.
- refusal: paket tak terkompilasi (blade directive vendor).
- port: `kernel/packages/gtm.mjs` (atau compiled Blade partial) + config dump; tanpa D1.
- test: oracle — script src + dataLayer identik.
- free-tier: muat.
- evidence: Packagist; README.

### cviebrock/eloquent-sluggable
- verdict: **substitute** — generasi slug sudah ada di `ports/packages/sluggable.mjs` (sluggable port sudah cover).
- edge: slug from title + unique suffix — sama.
- refusal: paket tak terkompilasi (trait model).
- port: tak perlu; `ports/packages/sluggable.mjs` + event `saving` terkompilasi.
- substitution: hook model → `sluggable` port. Disclosure: kehilangan konfigurasi trait lanjutan (translatable slug, incrementing).
- free-tier: muat.
- evidence: Packagist; README.

**Prioritas: seotools** — menutup meta/OG paling dipakai.

---

## Sumber & catatan metode

- Grounding repo: `COMPILED.md` §8b (M68) + tabel limit + construct audit; `tools/integrations.json`; `MAP.md`; `tools/docs-check.mjs`.
- Versi paket: Packagist / npm / newreleases / GitHub releases (live saat riset, 2026-11-10).
- Verifikasi HMAC: `hash_hmac('sha256', …)` (hex+base64) PHP 8.3.30 == Node `createHmac` byte-for-byte (diukur kluster Realtime).
- Item `[INFERENCE]` = tak bisa dipastikan dari sumber; disebut eksplisit.
