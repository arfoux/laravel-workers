# Security policy

## Reporting a vulnerability

Report privately through GitHub's
[security advisory form](https://github.com/arfoux/laravel-workers/security/advisories/new)
(“Report a vulnerability”). If you cannot use it, open a normal issue that says
only that you have a security report — with no details — and ask for a private
channel.

Please include:

- the version (`npm ls laravel-workers`, or the tag) and the host OS;
- what you ran (the CLI command, the app shape) and what happened;
- the smallest input that shows it — a Blade template, a route, a config line,
  a schema, or the generated `dist/` file — and the observed vs expected result;
- if you already have one, a proof of concept that does not touch a live
  deployment.

We aim to acknowledge within 3 working days and to ship a fix or a documented
mitigation within 30 days. We will credit you in `CHANGELOG.md` unless you ask
otherwise.

## Scope

In scope:

- the compiled artifact's runtime behaviour: auth/CSRF/session handling,
  password hashing, cookie signing, encryption, the D1 query builder, template
  escaping, and anything that lets a request read or write data it should not;
- the build-time toolchain: a source file that makes `laravel-workers build`
  read, execute, or write outside the app directory, or that makes the dumped
  code diverge from PHP without failing the build (a *silent wrong answer* is a
  security bug here, not just a correctness bug);
- the published package: anything that lets a dependency, a tarball, or an
  install hook run unexpected code.

Out of scope:

- vulnerabilities in dependencies that have not been used yet (report those
  upstream; Dependabot tracks them here);
- a misspelled secret, a permissive Cloudflare binding, or an app-level
  authorization bug the Laravel app itself would also have — the compiler is
  not expected to defend against the app's own source;
- findings that need the ability to modify the app's source, `vendor/`, the
  build output, or the deploy credentials;
- resource exhaustion that only reproduces with an unrealistic request rate
  (the free-plan CPU limits are documented in `README.md`).

## Supported versions

| Version | Supported |
| --- | --- |
| latest `0.x` release | yes, on a best-effort basis |
| older tags | no — upgrade first |

There is no LTS: `0.x` is pre-1.0, so fixes ship in the next patch release.
