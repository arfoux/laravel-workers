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
- refusal: paket Fortify tak terkompilasi (provider-nya mengawat kelas action + closure `Fortify::authenticateUsing()`/`confirmPasswordsUsing()`). `Fortify\` → LW002. **2FA (TOTP) belum punya modul kernel** (tak ada simbol `totp`/`otp` di `kernel/`/`tools/`) — login ber-2FA harus lewat port atau fail loud.
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
- port: `ports/spatie-permission.mjs` menjawab `hasRole`/`hasPermissionTo`/`hasAnyRole` lewat skema D1 `roles`/`permissions`/`model_has_roles`/`model_has_permissions`; disambungkan via `registry.json → guards` atau closure `Gate::before`.
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
- refusal: Reverb adalah proses server WebSocket long-running (`php artisan reverb:start`, socket ReactPHP) di port TCP — edge-impossible. Build menolak listener `ShouldBroadcast` (LW002) + facade `Broadcast` (LW002).
- substitution: server WS Reverb → pihak ketiga kompatibel-Pusher / Ably / Durable Object yang bicara protokol Pusher; config Echo `host`/`authEndpoint` diarahkan ke sana.
- test: oracle PHP menangkap `/broadcasting/auth` (token + data user base64); probe e2e: route terkompilasi menjawab token identik.

### laravel/echo v2.6.3
- verdict: **port** (client-only) — Echo = klien JS browser/Node, tak pernah menyentuh PHP terkompilasi; terhubung ke hub kompatibel-Pusher lewat WSS dan POST ke `authEndpoint` (route auth terkompilasi).
- port: tak ada di repo; bootstrap Echo app dikirim apa adanya dari bundle app.
- test: probe e2e — muat halaman, pastikan WS terhubung ke host terkonfigurasi dan endpoint auth mengembalikan token bertanda-tangan edge.

### pusher/pusher-php-server v7.3.0
- verdict: **port** — auth token SDK (`socket_id`+`channel_name` → `{key}.{HMAC-SHA256}`) = HMAC murni, direproduksi WebCrypto byte-for-byte; trigger = POST HTTPS ke REST API Pusher dgn auth_signature query-string = `fetch`.
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

## Sumber & catatan metode

- Grounding repo: `COMPILED.md` §8b (M68) + tabel limit + construct audit; `tools/integrations.json`; `MAP.md`; `tools/docs-check.mjs`.
- Versi paket: Packagist / npm / newreleases / GitHub releases (live saat riset, 2026-11-10).
- Verifikasi HMAC: `hash_hmac('sha256', …)` (hex+base64) PHP 8.3.30 == Node `createHmac` byte-for-byte (diukur kluster Realtime).
- Item `[INFERENCE]` = tak bisa dipastikan dari sumber; disebut eksplisit.
