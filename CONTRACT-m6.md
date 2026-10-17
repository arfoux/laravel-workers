# CONTRACT-m6 — Validation + FormRequest kernel (frozen 2026-10-18)

M6 ships `kernel/validator.mjs` — Laravel-like validation for Workers, pure ESM, zero deps, WebCrypto-free. No D1 writes, no app model. Covers W6 core: rules parsing, `nullable`/`sometimes`, string/numeric/array length checks, `confirmed`/`same`/`different`, `in`/`not_in`/`regex`, `email`/`url`/`date`, and error flows (422-shape `errors()`).

## Artifacts

- `kernel/validator.mjs` — `Validator` class + `validate(data, rules, messages?)` helper. Async `passes()`/`fails()` to allow future DB rules (`unique`/`exists` stub). Field rules accept string `required|string|min:8` or array `['required','email']`. Field presence: `sometimes` skips when absent; `nullable` skips other rules when value is null/empty-string. Messages: `messages['field.rule']` overrides, fallback to defaults.
- `kernel/tests/validator.test.mjs` — 12 subtests: required/nullable/sometimes, string/int/numeric/boolean/array, min/max/between/size, email/url/date, in/not_in, same/different/confirmed, regex/not_regex, wildcard absent handling, custom messages, validated() filtering.
- `package.json` — `test` now includes `kernel/tests/validator.test.mjs`.
- `bin/laravel-workers.mjs` — `test` + `test:hash` updated, new `test:validator` alias.

## API (frozen)

```js
import { Validator, validate } from '../validator.mjs'
const v = new Validator({ email: 'a@b.co', pw: 'secret123', pw_confirmation: 'secret123' }, {
  email: 'required|email',
  pw: 'required|string|min:8|confirmed',
}, { 'pw.confirmed': 'Konfirmasi tidak cocok.' })
await v.passes() // boolean
await v.fails()  // boolean
v.errors()       // Record<string, string[]>
v.validated()    // Record<string, any> — only fields that passed
// helper
await validate(data, rules, messages?) // { ok, errors, validated }
```

Supported rules (frozen subset, 22): `required` `nullable` `sometimes` `string` `integer` `numeric` `boolean` `array` `email` `url` `date` `alpha` `alpha_num` `alpha_dash` `min:n` `max:n` `between:min,max` `size:n` `in:a,b` `not_in:a,b` `same:field` `different:field` `confirmed` `regex:/p/flags` `not_regex:/p/flags`. Pipe-string or array input; `regex:` value preserves `|` inside pattern.

## CI

- `npm test` → `router` + `db` + `hash` + `encrypter` + `validator` (28 tests total incl. 12 validator subtests), `npm run test:corpus` unchanged. Green on `main`.

## Territory

- `laravel-workers/kernel/*` only. `nearFind` remains local-only; no `unique`/`exists` DB hits in M6 (stubbed as pass with `// TODO D1` comment for M7).
