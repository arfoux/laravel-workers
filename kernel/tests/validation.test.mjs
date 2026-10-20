// kernel/tests/validation.test.mjs — $request->validate() → ValidationException
// → redirect-back (or 422 JSON), the way Illuminate renders it.
//
// Unit section: the exception surface + the on-disk error-bag shape.
// Pipeline section: a compiled `web` route whose handler calls
// `ctx.request.validate()` and the compiled HTTP kernel renders the failure
// (302 + flashed errors/_old_input, or 422 JSON for expectsJson). The 1:1 PHP
// oracle diff lives in the E2E suite; here we assert the compiled behaviour
// against hand-checked Laravel shapes and, where the payload is written, against
// the json session bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ValidationException,
  validationExceptionWithMessages,
  installValidation,
  summarizeValidation,
  sessionErrorBag,
  DEFAULT_DONT_FLASH,
} from '../validation.mjs';
import { handleHttp } from '../http.mjs';
import { normalizeTable } from '../router.mjs';
import { applyAuthenticatable } from '../auth.mjs';
import { Model } from '../model.mjs';

// The kernel's session save() reads `auth.guard().id()` for the user_id column;
// a fake authenticatable keeps the auth manager resolvable without a real app.
class LWFakeUser extends Model {}
LWFakeUser.table = 'users';
applyAuthenticatable(LWFakeUser);
const MODELS = { 'App\\Models\\User': LWFakeUser };

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Older Node without node:sqlite: the pipeline section skips.
}
const noSqlite = DatabaseSync ? false : 'node:sqlite unavailable (needs Node >= 22)';

// ---------------------------------------------------------------------------
// unit — ValidationException surface
// ---------------------------------------------------------------------------

test('summarizeValidation matches ValidationException::summarize()', () => {
  assert.equal(summarizeValidation({}), 'The given data was invalid.');
  assert.equal(summarizeValidation({ email: ['The email field is required.'] }), 'The email field is required.');
  assert.equal(
    summarizeValidation({ email: ['The email field is required.'], password: ['The password field is required.'] }),
    'The email field is required. (and 1 more error)'
  );
  assert.equal(
    summarizeValidation({
      a: ['one'],
      b: ['two'],
      c: ['three'],
    }),
    'one (and 2 more errors)'
  );
});

test('ValidationException carries status 422, the error bag, and lwKernel (rethrow marker)', () => {
  const errors = { email: ['The email field is required.'] };
  const e = new ValidationException(errors);
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'ValidationException');
  assert.equal(e.status, 422);
  assert.equal(e.errorBag, 'default');
  assert.equal(e.redirectTo, null);
  assert.equal(e.lwKernel, true);
  assert.deepEqual(e.errors(), errors);
  assert.equal(e.message, 'The email field is required.');

  const bagged = new ValidationException(errors, { errorBag: 'login', redirectTo: '/back' });
  assert.equal(bagged.errorBag, 'login');
  assert.equal(bagged.redirectTo, '/back');
});

test('sessionErrorBag matches Store::prepareErrorBagForSerialization (json)', () => {
  assert.deepEqual(sessionErrorBag('default', { email: ['nope'] }), {
    default: { format: ':message', messages: { email: ['nope'] } },
  });
  assert.deepEqual(DEFAULT_DONT_FLASH, ['current_password', 'password', 'password_confirmation']);
});

test('validationExceptionWithMessages mirrors ValidationException::withMessages (Arr::wrap + dedupe)', () => {
  // `Arr::wrap()` a scalar, dedupe an array through MessageBag::add (keep-first).
  const e = validationExceptionWithMessages({
    email: 'These credentials do not match our records.',
    password: ['too short', 'too short', 'weak'],
  });
  assert.ok(e instanceof ValidationException);
  assert.deepEqual(e.errors(), {
    email: ['These credentials do not match our records.'],
    password: ['too short', 'weak'],
  });
  assert.equal(e.status, 422);
  assert.equal(e.lwKernel, true);
  assert.equal(e.message, 'These credentials do not match our records. (and 2 more errors)');
});

// ---------------------------------------------------------------------------
// unit — installValidation (Request::validate / validateWithBag)
// ---------------------------------------------------------------------------

function fakeRequest(data) {
  return { all: () => ({ ...data }) };
}

test('installValidation: valid data returns validated()', async () => {
  const req = installValidation(fakeRequest({ email: 'a@b.com', password: 'longenough' }));
  const validated = await req.validate({ email: 'required|email', password: 'required|min:8' });
  assert.deepEqual(validated, { email: 'a@b.com', password: 'longenough' });
});

test('installValidation: invalid data throws ValidationException with errors', async () => {
  const req = installValidation(fakeRequest({ email: 'nope' }));
  await assert.rejects(
    () => req.validate({ email: 'required|email' }),
    (e) => {
      assert.ok(e instanceof ValidationException);
      assert.deepEqual(Object.keys(e.errors()), ['email']);
      assert.match(e.errors().email[0], /valid email/);
      assert.equal(e.errorBag, 'default');
      return true;
    }
  );
});

test('installValidation: validateWithBag tags the named error bag', async () => {
  const req = installValidation(fakeRequest({ email: '' }));
  await assert.rejects(
    () => req.validateWithBag('login', { email: 'required' }),
    (e) => {
      assert.equal(e.errorBag, 'login');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// pipeline — compiled kernel rendering
// ---------------------------------------------------------------------------

const KEY = Buffer.alloc(32, 7).toString('base64');

function baseConfig(overrides = {}) {
  return {
    'app.key': 'base64:' + KEY,
    'session.driver': 'database',
    'session.cookie': 'laravel_session',
    'session.lifetime': 120,
    'session.expire_on_close': false,
    'session.serialization': 'json',
    'session.table': 'sessions',
    'session.path': '/',
    'session.domain': null,
    'session.secure': null,
    'session.http_only': true,
    'session.same_site': 'lax',
    'session.encrypt': false,
    'csrf.except': ['probe/validate'],
    'cookies.except': [],
    'auth.defaults.guard': 'web',
    'auth.guards.web': { driver: 'session', provider: 'users' },
    'auth.providers.users': { driver: 'eloquent', model: 'App\\Models\\User' },
    ...overrides,
  };
}

function d1(sqlite) {
  return {
    prepare(sql) {
      let params = [];
      return {
        bind(...p) {
          params = p;
          return this;
        },
        async all() {
          const st = sqlite.prepare(sql);
          const rows = params.length ? st.all(...params) : st.all();
          return { results: rows.map((r) => ({ ...r })) };
        },
        async first() {
          const st = sqlite.prepare(sql);
          const row = params.length ? st.get(...params) : st.get();
          return row ? { ...row } : null;
        },
        async run() {
          const st = sqlite.prepare(sql);
          const info = params.length ? st.run(...params) : st.run();
          return {
            success: true,
            meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid ?? 0) },
          };
        },
      };
    },
  };
}

function makeDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NULL,
      ip_address TEXT NULL,
      user_agent TEXT NULL,
      payload TEXT NOT NULL,
      last_activity INTEGER NOT NULL
    );
  `);
  return { sqlite, db: d1(sqlite) };
}

const RULES = { email: 'required|email', password: 'required|min:8' };

const HANDLERS = {
  'POST /probe/validate': async (ctx) => {
    const validated = await ctx.request.validate(RULES);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validated),
    };
  },
};

const ROUTES = [{ uri: '/probe/validate', methods: ['POST'], middleware: ['web'] }];

async function post(config, { accept = 'text/html', referer = 'http://localhost/form', form } = {}) {
  const { sqlite, db } = makeDb();
  const headers = { host: 'localhost', accept, referer, 'user-agent': 'Symfony' };
  const body = new URLSearchParams(form).toString();
  headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = await handleHttp(
    { method: 'POST', url: 'http://localhost/probe/validate', headers, body },
    {
      table: normalizeTable(ROUTES),
      handlers: HANDLERS,
      config,
      env: { DB: db },
      db,
      models: MODELS,
      clock: () => 1792336827,
      randomString: (n) => 'A'.repeat(n),
      clientIp: '127.0.0.1',
    }
  );
  const rows = sqlite.prepare('SELECT * FROM sessions').all().map((r) => ({ ...r }));
  return { res, rows };
}

function payloadOf(rows) {
  assert.equal(rows.length, 1, 'expected exactly one session row');
  // The database session handler stores the payload base64-encoded (Laravel
  // DatabaseSessionHandler::write does `base64_encode($data)`).
  return JSON.parse(Buffer.from(String(rows[0].payload), 'base64').toString('utf8'));
}

test('pipeline: failed validation redirects back and flashes errors + old input', { skip: noSqlite }, async () => {
  const { res, rows } = await post(baseConfig(), {
    form: {
      email: 'not-an-email',
      password: 'short',
      password_confirmation: 'short',
      name: 'Ada',
      _token: 'whatever',
    },
  });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'http://localhost/form');

  const payload = payloadOf(rows);
  assert.deepEqual(payload.errors, {
    default: {
      format: ':message',
      messages: {
        email: ['The email field must be a valid email address.'],
        password: ['The password field must be at least 8 characters.'],
      },
    },
  });
  assert.deepEqual(payload._old_input, {
    email: 'not-an-email',
    name: 'Ada',
    _token: 'whatever',
  });
  assert.ok(!('password' in payload._old_input), 'password must not be flashed');
  assert.ok(!('password_confirmation' in payload._old_input), 'password_confirmation must not be flashed');
  assert.ok(payload._flash.old.includes('errors'));
  assert.ok(payload._flash.old.includes('_old_input'));
});

test('pipeline: failed validation falls back to the session previous URL when no Referer', { skip: noSqlite }, async () => {
  const { res } = await post(baseConfig(), { referer: '', form: { email: '', _token: 'x' } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'http://localhost');
});

test('pipeline: expectsJson validation failure is a 422 JSON body with no flash', { skip: noSqlite }, async () => {
  const { res, rows } = await post(baseConfig(), {
    accept: 'application/json',
    form: { email: '', password: 'short', _token: 'x' },
  });

  assert.equal(res.status, 422);
  assert.equal(res.headers['content-type'], 'application/json');
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.message, 'The email field is required. (and 1 more error)');
  assert.deepEqual(parsed.errors, {
    email: ['The email field is required.'],
    password: ['The password field must be at least 8 characters.'],
  });
  const payload = payloadOf(rows);
  assert.ok(!('errors' in payload), 'json validation failures must not flash an error bag');
  assert.ok(!('_old_input' in payload), 'json validation failures must not flash old input');
});

test('pipeline: valid data reaches the controller and is not flashed', { skip: noSqlite }, async () => {
  const { res, rows } = await post(baseConfig(), {
    accept: 'application/json',
    form: { email: 'a@b.com', password: 'longenough', _token: 'x' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { email: 'a@b.com', password: 'longenough' });
  const payload = payloadOf(rows);
  assert.ok(!('errors' in payload));
  assert.ok(!('_old_input' in payload));
});

test('pipeline: php session serialization fails loud for validation redirects', { skip: noSqlite }, async () => {
  await assert.rejects(
    () => post(baseConfig({ 'session.serialization': 'php' }), { form: { email: '', _token: 'x' } }),
    /session\.serialization=json/
  );
});
