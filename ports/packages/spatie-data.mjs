// Port of spatie/laravel-data v4.23.1 — DTO creation from a validated payload.
//
// In Laravel: `UserData::from($request->validated())` hydrates a typed DTO and
// `UserData::validateAndCreate($payload)` (or a FormRequest + DTO) runs the
// declared rules, returning a 422 error bag on failure. This port keeps the two
// halves — validate (subset of Laravel rule strings) then hydrate into a plain
// class instance exposing the same shape/serialization as the PHP DTO.
//
// D1 schema (this cluster owns the table):
//   CREATE TABLE IF NOT EXISTS lw_dtos (
//     id        INTEGER PRIMARY KEY AUTOINCREMENT,
//     name      TEXT NOT NULL,
//     email     TEXT NOT NULL UNIQUE,
//     age       INTEGER,
//     raw_json  TEXT NOT NULL,        -- echo of the hydrated DTO
//     created_at TEXT NOT NULL DEFAULT (datetime('now'))
//   );
//   Call ensureSchema(env) once from the wrangler init/migration, or lazily
//   from the handler (the table survives because workers share the binding).

import { validate, hydrate, errorBag } from '../../kernel/packages/validate.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';

// The DTO. Mirrors a `UserData` class: plain constructor, declared typed fields
// (nullable -> `undefined` when absent), a rules() method, and toJson().
export class UserData {
  constructor(name, email, age) {
    this.name = name;   // string, required
    this.email = email; // string, required, must be email
    this.age = age;     // integer|null, optional
  }

  static rules() {
    return { name: 'required|min:2', email: 'required|email', age: 'integer|min:1' };
  }

  // spatie/laravel-data serializes a DTO with its transformed type/name/fields.
  toJson() {
    return {
      name: this.name,
      email: this.email,
      age: this.age ?? null,
    };
  }
}

export function ensureSchema(env) {
  return env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS lw_dtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      age INTEGER,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
}

// POST /data (the ported route) — hydrate + validate a payload into a DTO and
// persist a copy so the test exercises real D1 reads/writes.
export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  try {
    await ensureSchema(env);

    const payload = (ctx.body && typeof ctx.body === 'object') || Array.isArray(ctx.body)
      ? ctx.body
      : {};

    const rules = UserData.rules();
    const result = validate(payload, rules);
    if (!result.valid) {
      return {
        status: 422,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(errorBag(result.errors)),
      };
    }

    // Hydrate the validated bag into the DTO (drops unknown/undefined fields).
    const dto = hydrate(UserData, result.data, ['name', 'email', 'age']);
    const json = dto.toJson();

    await env.DB.prepare(
      'INSERT INTO lw_dtos (name, email, age, raw_json) VALUES (?1, ?2, ?3, ?4)'
    ).bind(json.name, json.email, json.age, JSON.stringify(json)).run();

    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: json }),
    };
  } catch (err) {
    return {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: String((err && err.message) || err) }),
    };
  }
}
