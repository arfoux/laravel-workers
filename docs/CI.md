# CI

![Verdict](verdict.svg)

Three layers. Knowing which layer owns what is the whole point: the tool
decides whether the app can run at the edge, the reporter says so in public, and
the pipeline is yours.

| Layer | What | Where | Owns |
|---|---|---|---|
| tool | `npx laravel-workers build` / `deploy` | your app | the verdict (`READINESS`) |
| reporter | `action/verdict` | this repo | one sticky PR comment + job summary |
| pipeline | `ci.yml`, `deploy.yml` (yours) or `app-check.yml`, `app-deploy.yml` (ours) | your repo or this one | when to run which |

The tool never posts; the reporter never builds; the pipeline never decides.
That split is why a green check means something specific.

## Canonical pattern (copy into the app)

Two jobs: check on every pull request, ship on `main`.

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main] }

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      # ... php, node, npm ci, npm run build, cp .env.example .env
      # No composer: `vendor-lite` provisions a composer-free vendor tree from
      # composer.lock (the e2e job exercises that path). Install composer only
      # in a job that runs `php artisan test` — require-dev (PHPUnit) is never
      # provisioned by vendor-lite.
      - name: Random app_key (never production)
        run: |
          KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
          echo "APP_KEY=base64:${KEY}" >> "$GITHUB_ENV"
      - name: Edge build (--strict)
        run: |
          set -o pipefail
          npx laravel-workers build --no-cache 2>&1 | tee edge-build.log
      - name: Verdict
        if: always()
        uses: arfoux/laravel-workers/action/verdict@v1
```

`deploy.yml` on `main` runs `npx laravel-workers deploy --mode 3 --yes` with
`APP_KEY` and the Cloudflare token, then Verdict with `comment: false` (summary
only — nothing to comment on a merge).

Two details that are not optional:

- **`--no-cache`** — a cache hit prints no `READINESS` block, so the gate is
  empty and Verdict reports `BUILD FAILED`.
- **a valid random `APP_KEY`** in the check job — compiling error views boots
  Laravel; a malformed key fails the build with
  `Unsupported cipher or incorrect key length`.

## Official workflows (optional convenience)

If the app's pipeline matches the defaults, skip the copying and call these.
They are trigger-agnostic — call them from `pull_request`, `push` to `main`, or
`workflow_dispatch`; they only do what their name says.

```yaml
jobs:
  check:
    uses: arfoux/laravel-workers/.github/workflows/app-check.yml@v1
    permissions: { contents: read, pull-requests: write, issues: write }

  ship:
    if: github.ref == 'refs/heads/main'
    uses: arfoux/laravel-workers/.github/workflows/app-deploy.yml@v1
    secrets: inherit
    with:
      app-url: https://my-app.example.workers.dev
```

`app-check.yml` assumes the app is a normal Laravel app with `package-lock.json`
and `.env.example`; it takes `php-version`, `node-version`, `working-directory`,
`build-args`, `lint`, `tests`. `app-deploy.yml` takes `app-url` (required),
`mode`, `schema` (`''` | `skip` | `apply`) and needs `APP_KEY` +
`CLOUDFLARE_API_TOKEN` secrets and a `CLOUDFLARE_ACCOUNT_ID` variable.

`app-deploy.yml` runs **no composer**: `deploy` provisions a composer-free vendor
tree from `composer.lock` (vendor-lite). `app-check.yml` keeps one composer step
only because `tests` runs PHPUnit from require-dev, which vendor-lite never
provisions; a check with `tests: ''` does not need it either.

Because they encode assumptions, they are **convenience, not the contract**: the
documented pattern above is the contract. Fork them if an app deviates.

Naming rules, so the repo stays legible:

- `app-*` = for app repositories; the repo's own `ci.yml`/`publish.yml` stay
  unprefixed.
- No trigger names (`*-pr`, `*-main`): the caller picks the trigger.
- `doctor` stays what it is — local preflight checks (PHP, vendor, wrangler,
  deploy state). **Verdict** is the reporter, not a checker.

Versioning: pin `@v1` (a moving major tag updated on release). The workflows and
the action are published together with the npm package, so `@v1` always matches
a released `laravel-workers`.

## Verdict — the reporter

Reads the log of `npx laravel-workers build --no-cache` and publishes one
comment plus the job summary.

| Input | Default | Meaning |
|---|---|---|
| `log` | `edge-build.log` | log of the build (or of `deploy`) |
| `comment` | `true` | `false` keeps the summary, skips the comment |

```markdown
<!-- verdict -->
<img src="https://github.com/arfoux/laravel-workers/raw/main/docs/logo.png?raw=1" width="20" height="20" align="top"> **laravel-workers** · edge gate

### Verdict: RUNS WITH DECLARED GAPS

**1 declared gap** — the app answers it; it ships as-is.

**7/7 routes** handled · **13 tables** in `dist/schema.sql` · commit `deadbee`

<details><summary>Readiness report</summary> … </details>

<sub>Verdict · edge gate for `owner/repo`</sub>
```

- **Sticky**: the body starts with `<!-- verdict -->`; the bot edits its own
  previous comment instead of adding one per push.
- **Forks**: read-only token → comment skipped, the build result stands.
- **Exit code 0 always**: it reports, it never replaces the build verdict.
- No `READINESS` block → `BUILD FAILED` plus the last 40 log lines.
- `GITHUB_STEP_SUMMARY` gets the same body, so `deploy` runs have the verdict
  too.

### Comment as your own app

The comment is posted with `github.token` by default, so it is authored by
`github-actions[bot]`. To have it authored by **your** bot — its own name and
avatar — register a GitHub App and hand Verdict an installation token:

1. **Settings → Developer settings → GitHub Apps → New GitHub App.** Homepage can
   be the repo. Permissions: **Pull requests: Read and write**, **Issues: Read and
   write**, **Contents: Read-only**. Nothing else. Install it on the repository
   (or organisation) that runs the build.
2. On the app page, **Generate a private key** (`.pem`), and note the **App ID**.
3. Store the key as a repository secret (the workflow reads this name):

   ```bash
   gh secret set LW_APP_PRIVATE_KEY < app.pem
   ```

4. Pass the App ID to the reusable workflow:

   ```yaml
   jobs:
     check:
       uses: arfoux/laravel-workers/.github/workflows/app-check.yml@v1
       secrets: inherit              # LW_APP_PRIVATE_KEY
       with:
         app-id: ${{ vars.LW_APP_ID }}   # or a literal id
   ```

`app-check.yml` mints the token with
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token)
and passes it to Verdict, which prefers it over `github.token`. Two things to know
before opting in:

- **An app token carries write**, so a pull request from a **fork** never gets one:
  that step is skipped and the comment falls back to `github.token` (read-only on
  forks, so the comment is skipped and only the job summary is published).
  Deliberate, not a limitation.
- The private key is a real credential — same handling as `CLOUDFLARE_API_TOKEN`:
  a repository secret, never committed. Rotate it from the app page; a revoked key
  only costs the comment (exit code is 0 either way).

With no app configured there is **nothing to install and no secret**: the reporter
still carries the laravel-workers mark, it is just posted by `github-actions[bot]`.

## Before you deploy

| Key | Value | If wrong |
|---|---|---|
| `APP_URL` | `https://<worker>.workers.dev` | baked into the artifact: `url()`, redirects, signed URLs point to localhost |
| `CACHE_STORE` | `database` | `file` = no cache, and the login throttle goes **fail-open** without an error |
| `LOG_LEVEL` | `warning` | debug logs per request |
| `APP_KEY` | one stable `base64:` string | a new key per deploy reads every old cookie/session as garbage |

Env wins over `.env` (same mechanism as `APP_KEY`), so production values belong
in the workflow, not in a committed file.

Runtime bindings (not baked, read by ports): `wrangler secret put` / `vars`.
Config groups that are dumped are visible in the artifact; check before
assuming:

```bash
grep -c "SEAL_KEY" dist/src/config.generated.mjs   # 0 = not baked
```

## Cloudflare token

Dashboard → My Profile → API Tokens → Create Custom Token:

| Scope | Access |
|---|---|
| Account → Workers Scripts | Edit |
| Account → D1 | Edit |
| Account → Account Settings | Read |

`wrangler login` (OAuth) is a local convenience; CI needs this token.

## Schema and data

`deploy --mode 3` = build + ensure D1 + schema + deploy, in one process.
Schema is stateful: empty D1 → applied; tables present → **refused** unless a
recorded hash proves the schema is already applied (`--skip-schema` /
`--schema=apply` are the only ways past); schema hash changed → refused. A CI
checkout has no `lw-state.json`, so on a populated D1 `--yes` refuses by
default — pass `schema: skip` (the reusable workflow's input) when the tables
are already current.
`dist/schema.sql` is `CREATE TABLE` only — apply it once.

Data comes after schema, as **data-only** SQL (no DDL), verified with
`wrangler d1 execute --remote --json`.

## Failure strings worth knowing

| Message | Meaning |
|---|---|
| `commitDist: cannot move … dist aside` | `dist/` locked by `wrangler dev`/editor; the previous `dist` is intact, the new build is in `dist.building` |
| `Unsupported cipher or incorrect key length` | `APP_KEY` malformed (needs `base64:` + 32 bytes), also in CI's random key |
| `schema drift: dist/schema.sql changed ...` | tables exist and the schema changed; decide `--skip-schema` (the D1 is current) or `--schema=apply` (re-run the snapshot deliberately — CREATE-only: it fails on a table that already exists and cannot add a column, so a `Schema::table` migration on a live D1 is applied by hand) |
| `schema state unknown: "<db>" already has N table(s) ...` | tables exist but no hash was ever recorded for this D1 (a CI checkout, or a database that predates the tool); decide `--skip-schema` or `--schema=apply` (CREATE-only, see the row above) |
| no `READINESS` in CI | cache hit; add `--no-cache` |
| `worth knowing (n): N migration(s) mutate an EXISTING table` | `dist/schema.sql` is CREATE-only, so a `Schema::table` migration cannot reach a D1 that already has the table — nothing to do for a fresh D1, apply the `ALTER` by hand for a populated one |
| `GET /up` 404 on the edge | health route registered in `bootstrap/app.php`, not a route file — declare it |
| login works, no rate-limit | `CACHE_STORE=file` at build; the throttle port fails open |
| an unknown path answers `404` with 0 B | the app's `wrangler.jsonc` has no `"not_found_handling": "404-page"` inside its `assets` block, so the ASSETS layer answers with Cloudflare's null-body 404 instead of `dist/public/404.html` — the build writes the file either way and names the line in a DECLARED finding |

## Badge

Static badges (no service needed). They state the verdict a run printed,
they do not update themselves:

```markdown
![verdict](https://img.shields.io/badge/verdict-RUNS%20ON%20THE%20EDGE-1FA37C)
![verdict](https://img.shields.io/badge/verdict-RUNS%20WITH%20DECLARED%20GAPS-E0A126)
```

A live badge would need a service that stores the last verdict; the Job Summary
and the PR comment are the live surface — the badge is documentation.

## Brand

The mark, the palette, the voice and the surface list live in one place —
**[docs/BRAND.md](BRAND.md)**. In reporter terms:

- **Name**: Verdict — what it posts, nothing more. Not a checker (`doctor` is),
  not a pipeline.
- The reporter renders the mark (`docs/logo.png`, 20 px) as the first line of
  every comment and job summary, after the `<!-- verdict -->` marker the sticky
  lookup matches on.
- The mark's geometry, the palette tokens, the voice rules and the recipe for
  pinning the action in your own repo are in BRAND.md; keep them there so a
  colour changes in one commit, not five.
