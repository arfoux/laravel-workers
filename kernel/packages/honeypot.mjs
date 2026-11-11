// kernel/packages/honeypot.mjs — spatie/laravel-honeypot port (kernel half).
//
// Parity target: spatie/laravel-honeypot. The package protects a form from
// bots with two hidden fields rendered into the form:
//   - a NAME field (a randomly-named text input a real user never sees, so it
//     stays empty; a bot that auto-fills every input fills it),
//   - a TIME field (a timestamp captured when the form was rendered; a real
//     user takes a few seconds to submit, a bot submits near-instantly).
// On submit the server rejects the request when the name field is filled OR the
// elapsed time since render is below a minimum delta.
//
// Edge disclosure: the upstream package encrypts the timestamp with the app
// key (via `Crypt`) so a bot can't forge an old timestamp. There is no shared
// app key / no `Crypt` on the edge, so this port encodes the render timestamp
// as base36 in the clear. That stops the naive "fill everything + submit
// instantly" bot the field exists for, but it is NOT tamper-proof — a bot that
// reads the field can pre-age it. Documented, not hidden. Signing the value
// would need an env secret; see the notes at the bottom.
//
// The kernel exports three pure functions:
//   generateFieldName()            -> a unique honeypot name-field name
//   renderHoneypot(opts)           -> hidden-field HTML for a form
//   validateHoneypot(body, minDeltaMs, opts) -> { valid, reason }
// They are side-effect-free (validate takes an injectable `now` for tests) and
// read/write only plain objects + strings, so they run on the edge and in a
// unit test unchanged.

const DEFAULT_TIME_FIELD = '_hp_time';
const NAME_PREFIX = '_hp_name_';

// Minimal HTML attribute escaper — field names are generated (safe charset) but
// a caller may pass its own, so escape anyway. Never build HTML from raw user
// input; the name value is never echoed back.
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// A unique name-field name. The suffix is the render time in base36, so two
// forms rendered in the same millisecond collide only if a caller also reuses
// the same field — callers should render per-request. Keeping the timestamp in
// the name (not just the value) mirrors the upstream "random name" goal: a bot
// can't hardcode the field it must skip. When two calls land in the same
// millisecond a monotonic counter is appended (`.1`, `.2`, ...) so the name is
// always unique even then.
let lastTs = -1;
let seq = 0;
export function generateFieldName() {
  const ts = Date.now();
  const base = NAME_PREFIX + ts.toString(36);
  if (ts === lastTs) {
    seq += 1;
    return base + '.' + seq.toString(36);
  }
  lastTs = ts;
  seq = 0;
  return base;
}

// Render the honeypot as hidden HTML. Returns the two-field block wrapped in a
// visually-hidden container (display:none + aria-hidden) so screen readers skip
// it and the name input is never shown to a real user.
//
// opts:
//   nameFieldName  — override the generated name field (default generateFieldName())
//   timeFieldName  — name of the timestamp field (default '_hp_time')
//   minDeltaMs     — echoed only as a data-attribute for client-side parity (informational)
//   now            — render timestamp (default Date.now()); injectable for tests
export function renderHoneypot(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const nameField = opts.nameFieldName || generateFieldName();
  const timeField = opts.timeFieldName || DEFAULT_TIME_FIELD;
  const timeValue = now.toString(36);

  return (
    '<div style="display:none" aria-hidden="true">' +
    `<input type="text" name="${esc(nameField)}" value="" tabindex="-1" autocomplete="off">` +
    `<input type="hidden" name="${esc(timeField)}" value="${esc(timeValue)}">` +
    '</div>'
  );
}

// Parse the render timestamp out of the time field. Accepts the base36 string
// renderHoneypot produces, a plain decimal string, or a number. Returns the
// epoch ms, or null when the field is absent/blank/unparseable.
function parseRenderTime(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (/^[0-9a-z]+$/i.test(s)) {
    const n = parseInt(s, 36);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Validate a submitted body against the honeypot. Returns { valid, reason }:
//   { valid: true,  reason: null }
//   { valid: false, reason: 'missing_name_field' }  — the name field wasn't posted
//   { valid: false, reason: 'filled' }              — the name field has a value
//   { valid: false, reason: 'missing_time_field' }  — the time field wasn't posted
//   { valid: false, reason: 'time' }                — submitted faster than minDeltaMs
//
// body        — the parsed POST body (plain object). Anything else is treated as empty.
// minDeltaMs  — minimum elapsed ms between render and submit (default 1000).
// opts.now    — injectable "current time" for deterministic tests (default Date.now()).
// opts.timeFieldName — override the timestamp field name (default '_hp_time').
export function validateHoneypot(body, minDeltaMs = 1000, opts = {}) {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const timeField = opts.timeFieldName || DEFAULT_TIME_FIELD;
  const min = Number.isFinite(minDeltaMs) ? minDeltaMs : 1000;

  // 1. The honeypot name field must be present (it is always rendered) and empty.
  const nameKey = Object.keys(data).find(
    (k) => k === '_hp_name' || k.startsWith(NAME_PREFIX)
  );
  if (nameKey === undefined) {
    return { valid: false, reason: 'missing_name_field' };
  }
  const nameVal = data[nameKey];
  if (nameVal !== undefined && nameVal !== null && String(nameVal).trim() !== '') {
    return { valid: false, reason: 'filled' };
  }

  // 2. The render timestamp must be present and old enough.
  const ts = parseRenderTime(data[timeField]);
  if (ts === null) {
    return { valid: false, reason: 'missing_time_field' };
  }
  if (now - ts < min) {
    return { valid: false, reason: 'time' };
  }

  return { valid: true, reason: null };
}

// Note on tamper-proofing: to sign the timestamp (HMAC over `timeValue` with an
// env secret, verified in validateHoneypot) the secret must reach the kernel.
// The port handler can pass `opts.secret`/`opts.verify` once such a primitive
// exists; the pure functions above leave room for it without a breaking change.