// kernel/tests/csrf.test.mjs — compiled-rung CSRF parity vs the PHP 8.3 oracle.
//
// One tools/php-csrf-oracle.php process covers every section:
//   - Str::is vectors        → kernel/csrf.mjs strIs()
//   - normalizeQueryString   → kernel/csrf.mjs normalizeQueryString()
//   - PreventRequestForgery  → kernel/csrf.mjs PreventRequestForgery, run
//     against the real middleware from the fresh-app vendor tree, the real
//     encrypter and a real Illuminate\Http\Request backed by a recording
//     Store (no DB).
//
// The oracle's XSRF cookie is compared as parsed FIELDS (name/value/expires/
// path/domain/secure/http_only/raw/same_site/partitioned), never as
// Cookie::__toString() bytes: Symfony reads native time() for Max-Age, not
// the frozen Carbon clock. Expiry parity is instead proven exactly by
// deriving the JS clock from the oracle cookie: jsNow = expires - 60*lifetime.
//
// Documented divergences are asserted directly (shapes the oracle cannot be
// compared byte-for-byte against):
//   - nested/malformed bracket keys throw CsrfError
//   - invalid UTF-8 / lone-surrogate percent-decoding throws CsrfError
//   - non-BMP top-level query keys and > MAX_SAFE_INTEGER int keys throw
//   - preg_quote escape-set literals (probed against PHP 8.3)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CsrfError,
  TokenMismatchError,
  OriginMismatchError,
  pregQuote,
  strIs,
  normalizeQueryString,
  requestIs,
  requestFullUrlIs,
  requestPath,
  requestDecodedPath,
  requestUrl,
  requestFullUrl,
  PreventRequestForgery,
} from '../csrf.mjs';
import { PhpSessionStore } from '../session.mjs';
import { ResponseCookies } from '../cookies.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const oraclePath = path.resolve(testsDir, '..', '..', 'tools', 'php-csrf-oracle.php');
const PHP = process.env.PHP_BIN || 'php';
const APP_ROOT =
  process.env.LW_LARAVEL_APP ||
  'C:\\Users\\HP\\AppData\\Local\\Temp\\opencode\\lw-fresh-e2e\\fresh-app';

const TOKEN_A = 'A'.repeat(40);
const TOKEN_B = 'B'.repeat(40);
const FIXED_ID = 'a1'.repeat(20); // 40 chars, alnum

// ---------------------------------------------------------------------------
// Oracle payload (single process, all sections).
// ---------------------------------------------------------------------------

const STRIS_VECTORS = [
  { pattern: 'stripe/*', value: 'stripe/webhook' },
  { pattern: 'a.b', value: 'axb' }, // preg_quote escapes the dot
  { pattern: 'a.b', value: 'a.b' },
  { pattern: '*', value: 'anything' },
  { pattern: 'admin/*', value: 'admin' }, // 'admin/*' requires the slash
  { pattern: 'api/v1/*', value: 'API/v1/x', ignore_case: true },
  { pattern: 'café/*', value: 'café/x' },
  { pattern: 'a+b', value: 'aab' },
  { pattern: '($)', value: 'x($)y' },
  { pattern: 'foo', value: 'foobar' },
  { pattern: '**/x', value: 'a/b/x' },
  { pattern: 'web*', value: 'web' },
  { pattern: '', value: '' }, // pattern === subject shortcut
  { pattern: '5', value: 5 }, // (string) cast of the value
  { pattern: '*', value: 123 },
  { pattern: ['nope', 'ba*'], value: 'bar' }, // array of patterns
  { pattern: 'a*b', value: 'a/b' }, // '*' crosses '/'
  // escapes that PHP emits but JS 'u'-mode regexes reject as identity
  // escapes (\: \? \= \# \-) plus the \000 → \x00 NUL conversion
  { pattern: 'http://host/a?x=*', value: 'http://host/a?x=1' },
  { pattern: 'page#*', value: 'page#top' },
  { pattern: 'a-b*', value: 'a-bc' },
  { pattern: 'a\u0000*', value: 'a\u0000b' },
];

const QS_VECTORS = [
  'b=2&a=1',
  'a=1&a=2',
  'x=hello+world&y=%2F',
  'k=%C3%A9',
  '10=a&9=b',
  'a',
  'a=',
  '=x&b=1',
  'b%5Bc%5D=1&a=2',
  'a=1&&b=2',
  'flag&z=1',
  'B=1&b=2',
  '~=~&*=*',
  'dup=1&dup=2&dup=3',
  'a=1&a[b]=2',
  'a[b]=1&a[c]=2&a=3',
  'z=1&a=2&m=3',
  '',
  'x=%00&y=1',
  'a.b=1&a-c=2',
  'a=two%20words&b=1',
  'a[]=1&a[]=2',
  'a[5]=x&a[]=y',
  'a[b.c]=1',
  'a[b c]=1',
  'a[0]=x&a[]=y',
  'a[]=y&a[0]=x',
  'a[01]=z',
  'a[b]=1&a[b]=2',
  'a[b]=1&a[]=2',
  // extras: negative/plus inner keys, append interplay, plus/space value
  'a[-1]=x',
  'a[-1]=x&a[]=y',
  'a[+1]=x',
  'a[]=1&a[]=2&a[0]=3',
  'a[]=y&a[5]=x',
  'q=%2B+%20',
];

const MW_CASES = [
  { name: 'GET reading verb adds cookie', method: 'GET', uri: 'http://localhost/', session: { token: TOKEN_A } },
  {
    name: 'POST valid _token param passes',
    method: 'POST',
    uri: 'http://localhost/forms',
    params: { _token: TOKEN_A },
    session: { token: TOKEN_A },
  },
  {
    name: 'POST wrong token throws',
    method: 'POST',
    uri: 'http://localhost/forms',
    params: { _token: TOKEN_B },
    session: { token: TOKEN_A },
  },
  {
    name: 'POST missing session token throws',
    method: 'POST',
    uri: 'http://localhost/forms',
    params: { _token: TOKEN_A },
    session: {},
  },
  {
    name: 'except pattern passes',
    method: 'POST',
    uri: 'http://localhost/stripe/webhook',
    except: ['stripe/*'],
    session: { token: TOKEN_A },
  },
  {
    name: 'X-XSRF valid decrypt passes',
    method: 'POST',
    uri: 'http://localhost/forms',
    session: { token: TOKEN_A },
    x_xsrf: { mode: 'valid' },
  },
  {
    name: 'X-XSRF garbage throws',
    method: 'POST',
    uri: 'http://localhost/forms',
    session: { token: TOKEN_A },
    x_xsrf: { mode: 'garbage' },
  },
  {
    name: 'same-origin origin passes without token',
    method: 'POST',
    uri: 'http://localhost/forms',
    headers: { 'Sec-Fetch-Site': 'same-origin' },
    session: { token: TOKEN_A },
  },
  {
    name: 'same-site without allow throws',
    method: 'POST',
    uri: 'http://localhost/forms',
    headers: { 'Sec-Fetch-Site': 'same-site' },
    session: { token: TOKEN_A },
  },
  {
    name: 'same-site with allow passes',
    method: 'POST',
    uri: 'http://localhost/forms',
    headers: { 'Sec-Fetch-Site': 'same-site' },
    allow_same_site: true,
    session: { token: TOKEN_A },
  },
  {
    name: 'origin only mismatch throws',
    method: 'POST',
    uri: 'http://localhost/forms',
    origin_only: true,
    session: { token: TOKEN_A },
  },
  {
    name: 'origin only GET passes without cookie',
    method: 'GET',
    uri: 'http://localhost/',
    origin_only: true,
    session: { token: TOKEN_A },
  },
  {
    name: 'X-CSRF-TOKEN header passes',
    method: 'POST',
    uri: 'http://localhost/forms',
    headers: { 'X-CSRF-TOKEN': TOKEN_A },
    session: { token: TOKEN_A },
  },
  {
    name: 'falsy _token falls back to X-CSRF-TOKEN',
    method: 'POST',
    uri: 'http://localhost/forms',
    params: { _token: '0' },
    headers: { 'X-CSRF-TOKEN': TOKEN_A },
    session: { token: TOKEN_A },
  },
  {
    name: 'empty _token falls back to X-CSRF-TOKEN',
    method: 'POST',
    uri: 'http://localhost/forms',
    params: { _token: '' },
    headers: { 'X-CSRF-TOKEN': TOKEN_A },
    session: { token: TOKEN_A },
  },
  {
    name: 'except full-url with raw-order query still throws',
    method: 'POST',
    uri: 'http://localhost/hooks?b=2&a=1',
    except: ['http://localhost/hooks?b=2&a=1'],
    session: { token: TOKEN_A },
  },
  {
    name: 'except trailing slash trimmed',
    method: 'POST',
    uri: 'http://localhost/stripe/webhook/',
    except: ['/stripe/*/'],
    session: { token: TOKEN_A },
  },
  {
    name: 'except root pattern passes on root path',
    method: 'POST',
    uri: 'http://localhost/',
    except: ['/'],
    session: { token: TOKEN_A },
  },
  {
    name: 'except duplicates dedupe (keep first)',
    method: 'POST',
    uri: 'http://localhost/stripe/webhook',
    except: ['stripe/*', 'stripe/*'],
    session: { token: TOKEN_A },
  },
  {
    name: 'wrong XSRF prefix still passes (remove strips 41 chars)',
    method: 'POST',
    uri: 'http://localhost/forms',
    session: { token: TOKEN_A },
    x_xsrf: { mode: 'wrong_prefix' },
  },
  {
    name: 'HEAD reading verb passes',
    method: 'HEAD',
    uri: 'http://localhost/',
    session: { token: TOKEN_A },
  },
  {
    name: 'valid token + custom next response',
    method: 'POST',
    uri: 'http://localhost/forms',
    params: { _token: TOKEN_A },
    session: { token: TOKEN_A },
    next_status: 201,
    next_body: 'created',
  },
];

let oracleCache = null;

function runOracleOnce() {
  const payload = {
    app_root: APP_ROOT,
    stris: STRIS_VECTORS,
    qs: QS_VECTORS,
    middleware: { cases: MW_CASES },
  };
  const result = spawnSync(PHP, [oraclePath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LW_LARAVEL_APP: APP_ROOT },
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `php-csrf-oracle failed (exit ${result.status}): ${result.stderr}`
  );
  return JSON.parse(result.stdout);
}

function oracle() {
  if (oracleCache === null) oracleCache = runOracleOnce();
  return oracleCache;
}

// ---------------------------------------------------------------------------
// JS-side harness.
// ---------------------------------------------------------------------------

class OrphanHandler {
  constructor() {
    this.mem = new Map();
  }
  async read(id) {
    return this.mem.get(id) ?? '';
  }
  async write(id, data) {
    this.mem.set(id, data);
    return true;
  }
  async destroy(id) {
    return this.mem.delete(id);
  }
}

async function makeSession(csrfCase) {
  const store = new PhpSessionStore({ handler: new OrphanHandler(), id: FIXED_ID });
  await store.start();
  for (const [key, value] of Object.entries(csrfCase.session?.data ?? {})) {
    store.put(key, value);
  }
  if (csrfCase.session?.token !== undefined) {
    store.put('_token', csrfCase.session.token);
  }
  return store;
}

class LwFakeRequest {
  constructor({ method, uri, params, headers, session }) {
    const url = new URL(uri);
    this._method = String(method).toUpperCase();
    this._uri = uri;
    this._pathInfo = url.pathname;
    this._rawQuery = url.search ? url.search.slice(1) : '';
    this._params = params ?? {};
    this._headers = new Map(
      Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)])
    );
    this._session = session;
  }
  method() {
    return this._method;
  }
  input(key) {
    return Object.prototype.hasOwnProperty.call(this._params, key) ? this._params[key] : null;
  }
  header(name) {
    const value = this._headers.get(String(name).toLowerCase());
    return value === undefined ? null : value;
  }
  session() {
    return this._session;
  }
  path() {
    return requestPath(this._pathInfo);
  }
  decodedPath() {
    return requestDecodedPath(this._pathInfo);
  }
  url() {
    return requestUrl(this._uri);
  }
  fullUrl() {
    return requestFullUrl(this._uri, this._pathInfo, this._rawQuery, '');
  }
  is(...patterns) {
    return requestIs(this, patterns);
  }
  fullUrlIs(...patterns) {
    return requestFullUrlIs(this, patterns);
  }
}

/** Oracle cookie fields → JS naming (http_only → httpOnly, same_site → sameSite). */
function jsCookieFields(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    expires: cookie.expires,
    path: cookie.path,
    domain: cookie.domain ?? null,
    secure: !!cookie.secure,
    http_only: !!cookie.httpOnly,
    raw: !!cookie.raw,
    same_site: cookie.sameSite ?? null,
    partitioned: !!cookie.partitioned,
  };
}

/** Oracle cookie (PHP) → the same field shape jsCookieFields returns. */
function phpCookieFields(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    expires: cookie.expires,
    path: cookie.path,
    domain: cookie.domain ?? null,
    secure: !!cookie.secure,
    http_only: !!cookie.http_only,
    raw: !!cookie.raw,
    same_site: cookie.same_site ?? null,
    partitioned: !!cookie.partitioned,
  };
}

const PHP_TO_JS_ERROR = {
  'Illuminate\\Session\\TokenMismatchException': 'TokenMismatchError',
  'Illuminate\\Http\\Exceptions\\OriginMismatchException': 'OriginMismatchError',
};

async function runJsCase(csrfCase, phpCase, out) {
  PreventRequestForgery.flushState();
  if (csrfCase.except?.length) PreventRequestForgery.except(csrfCase.except);
  if (csrfCase.allow_same_site) PreventRequestForgery.setAllowSameSite(true);
  if (csrfCase.origin_only) PreventRequestForgery.useOriginOnly(true);

  const lifetime = out.session_config.lifetime;
  const phpExpires = phpCase.cookies?.[0]?.expires;
  const clock =
    typeof phpExpires === 'number'
      ? () => phpExpires - 60 * lifetime
      : () => Date.now() / 1000;

  const middleware = new PreventRequestForgery({
    sessionConfig: out.session_config,
    keyBase64: out.app_key_base64,
    clock,
  });

  const session = await makeSession(csrfCase);

  const headers = { ...(csrfCase.headers ?? {}) };
  if (csrfCase.x_xsrf) headers['X-XSRF-TOKEN'] = phpCase.x_xsrf_sent;

  const request = new LwFakeRequest({
    method: csrfCase.method ?? 'GET',
    uri: csrfCase.uri ?? 'http://localhost/',
    params: csrfCase.params ?? {},
    headers,
    session,
  });

  const result = { error: null, threw: null, status: null, body: null, cookies: null };
  try {
    const response = await middleware.handle(request, async () => ({
      status: csrfCase.next_status ?? 200,
      body: csrfCase.next_body ?? 'ok',
      headers: new Headers(),
      cookies: new ResponseCookies(),
    }));
    result.status = response.status;
    result.body = response.body;
    result.cookies = response.cookies.list().map(jsCookieFields);
  } catch (error) {
    result.error = error;
    result.threw = { class: error && error.name, message: error && error.message };
    result.cookies = null;
  }
  result.should_add_cookie = middleware.shouldAddXsrfTokenCookie();
  result.excluded_paths = middleware.getExcludedPaths();
  result.session_token = request.session().token();
  return result;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test('Str::is vectors match the PHP 8.3 oracle', () => {
  const out = oracle();
  assert.equal(out.stris.length, STRIS_VECTORS.length);
  const js = STRIS_VECTORS.map((vector) =>
    strIs(vector.pattern, vector.value, vector.ignore_case ?? false)
  );
  assert.deepEqual(js, out.stris);
});

test('preg_quote matches the probed PHP 8.3 escape set', () => {
  // Default delimiter '#': the 21-char escape set, NUL → \000, and the
  // characters PHP leaves alone (probed empirically against PHP 8.3).
  assert.equal(pregQuote('a#b'), 'a\\#b');
  // '#' is escaped unconditionally since PHP 7.3, whatever the delimiter.
  assert.equal(pregQuote('a#b', '/'), 'a\\#b');
  assert.equal(pregQuote('a/b', '#'), 'a/b');
  // A delimiter outside the special set is escaped only when passed.
  assert.equal(pregQuote('a@b', '@'), 'a\\@b');
  assert.equal(pregQuote('a@b'), 'a@b');
  assert.equal(pregQuote('a=b'), 'a\\=b');
  assert.equal(pregQuote('a-b'), 'a\\-b');
  assert.equal(pregQuote('a:b'), 'a\\:b');
  assert.equal(pregQuote('\0'), '\\000');
  assert.equal(pregQuote('a\0b'), 'a\\000b');
  assert.equal(pregQuote('a&b, c;d@e_f~g h%i\'j"k'), 'a&b, c;d@e_f~g h%i\'j"k');
  assert.equal(pregQuote('a,b'), 'a,b');
  assert.equal(pregQuote('a$b'), 'a\\$b');
  assert.equal(pregQuote('a^b'), 'a\\^b');
  assert.equal(
    pregQuote('!*()+,-.:<>=?[]{|}$^'),
    '\\!\\*\\(\\)\\+,\\-\\.\\:\\<\\>\\=\\?\\[\\]\\{\\|\\}\\$\\^'
  );
  assert.equal(pregQuote('\\'), '\\\\');
});

test('normalizeQueryString matches the PHP 8.3 oracle', () => {
  const out = oracle();
  assert.equal(out.qs.length, QS_VECTORS.length);
  const js = QS_VECTORS.map((qs) => normalizeQueryString(qs));
  assert.deepEqual(js, out.qs);
});

test('normalizeQueryString fails loud on unsupported shapes', () => {
  // Nested/deeper bracket keys: parse_str orthography is not implemented.
  assert.throws(() => normalizeQueryString('a[x][y]=1'), CsrfError);
  assert.throws(() => normalizeQueryString('a[b]=1&a[b][c]=2'), CsrfError);
  // Malformed brackets (stray text after ']').
  assert.throws(() => normalizeQueryString('a[x]y=1'), CsrfError);
  // Invalid UTF-8 and CESU-8 lone surrogates from percent-escapes.
  assert.throws(() => normalizeQueryString('%C0%AF=1'), CsrfError);
  assert.throws(() => normalizeQueryString('%ED%A0%80=1'), CsrfError);
  // Non-BMP top-level keys (PHP byte order vs JS UTF-16 order).
  assert.throws(() => normalizeQueryString('\u{1F600}=1'), CsrfError);
  // Integer keys beyond the JS safe range.
  assert.throws(() => normalizeQueryString('a[9007199254740992]=x'), CsrfError);
});

test('PreventRequestForgery middleware parity against PHP 8.3 oracle', async () => {
  const out = oracle();
  assert.equal(out.middleware.length, MW_CASES.length);

  for (let i = 0; i < MW_CASES.length; i++) {
    const phpCase = out.middleware[i];
    const label = `case ${i} (${phpCase.name})`;
    const jsCase = await runJsCase(MW_CASES[i], phpCase, out);

    if (phpCase.threw) {
      assert.ok(jsCase.threw, `${label}: JS did not throw (PHP threw ${phpCase.threw.class})`);
      assert.equal(
        jsCase.threw.class,
        PHP_TO_JS_ERROR[phpCase.threw.class] ?? phpCase.threw.class,
        `${label}: exception class`
      );
      const expectedCtor =
        phpCase.threw.class === 'Illuminate\\Http\\Exceptions\\OriginMismatchException'
          ? OriginMismatchError
          : TokenMismatchError;
      assert.ok(
        jsCase.error instanceof expectedCtor,
        `${label}: JS error is not a ${expectedCtor.name} instance`
      );
      assert.equal(jsCase.threw.message, phpCase.threw.message, `${label}: exception message`);
    } else {
      assert.equal(
        jsCase.threw,
        null,
        `${label}: JS threw ${jsCase.threw && jsCase.threw.class}: ${jsCase.threw && jsCase.threw.message}`
      );
      assert.equal(jsCase.status, phpCase.status, `${label}: status`);
      assert.equal(jsCase.body, phpCase.body, `${label}: body`);
      assert.deepEqual(
        jsCase.cookies,
        (phpCase.cookies ?? []).map(phpCookieFields),
        `${label}: cookie fields (name/value/expires/path/domain/secure/http_only/raw/same_site/partitioned)`
      );
    }

    assert.equal(
      jsCase.should_add_cookie,
      phpCase.should_add_cookie,
      `${label}: shouldAddXsrfTokenCookie()`
    );
    assert.deepEqual(jsCase.excluded_paths, phpCase.excluded_paths, `${label}: excluded paths`);
    if (MW_CASES[i].session?.token !== undefined) {
      assert.equal(jsCase.session_token, phpCase.session_token, `${label}: session token`);
    }
  }

  PreventRequestForgery.flushState();
});
