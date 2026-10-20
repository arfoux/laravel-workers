// shadow/scenarios/lw-constructs-app.mjs — the construct-coverage app.
//
// Every route of the constructs fixture (11 app routes) is replayed against the
// real PHP app and the compiled worker. The steps that need an authenticated
// user walk the Breeze-shaped login flow first (the guest request to
// /dashboard bootstraps the session and the CSRF token, exactly like a browser).
//
// The `expect: 'diverges'` steps are *known* divergences: a bcrypt digest has a
// random salt, so the build-time snapshot and the live render can never be
// byte-identical.

const EMAIL = 'u@example.com';
const PASSWORD = 'secret';
const BASIC = 'Basic ' + Buffer.from(`${EMAIL}:${PASSWORD}`).toString('base64');

export default {
  name: 'constructs',
  user: { id: 1, email: EMAIL, password: PASSWORD },
  fixtures: [
    {
      // The seed post is *older* than the frozen clock, so the
      // `orderByDesc('created_at')` order is deterministic on both sides (a tie
      // would leave the order to the database). It belongs to the shadow user
      // (id 1), so the policy answers "allowed" for it.
      sql:
        "INSERT INTO posts (id, title, body, published, user_id, created_at, updated_at) " +
        "VALUES (1, 'Hello Edge', 'First body', 1, 1, '2025-06-01 00:00:00', '2025-06-01 00:00:00')",
    },
  ],
  steps: [
    // The first request bootstraps the session (and the CSRF token): it uses the
    // jar so the session cookie is kept for the steps that follow.
    { label: 'GET /dashboard (guest)', method: 'GET', uri: '/dashboard', jar: true },
    {
      label: 'POST /login (wrong password)',
      method: 'POST',
      uri: '/login',
      jar: true,
      form: { _token: '@token', email: EMAIL, password: 'wrong' },
    },
    {
      // The JSON error path: a failed validation answers 422 with the
      // `{"message":...,"errors":{...}}` body (not a redirect back). It runs
      // while the visitor is still a guest, so the controller is reached.
      label: 'POST /login (wrong password, JSON)',
      method: 'POST',
      uri: '/login',
      jar: true,
      headers: { Accept: 'application/json' },
      form: { _token: '@token', email: EMAIL, password: 'wrong' },
    },
    {
      label: 'POST /login (authenticates)',
      method: 'POST',
      uri: '/login',
      jar: true,
      form: { _token: '@token', email: EMAIL, password: PASSWORD },
    },
    { label: 'GET /dashboard (authenticated)', method: 'GET', uri: '/dashboard', jar: true },
    {
      label: 'GET /dashboard (JSON)',
      method: 'GET',
      uri: '/dashboard',
      jar: true,
      headers: { Accept: 'application/json' },
    },
    { label: 'GET /posts (list)', method: 'GET', uri: '/posts', jar: true },
    { label: 'GET /posts/1 (show)', method: 'GET', uri: '/posts/1', jar: true },
    {
      // The implicit route-model binding: the model comes from the segment
      // (`showBound(Post $post)`), so the page is the same one.
      label: 'GET /posts/1/bound (the route-model binding)',
      method: 'GET',
      uri: '/posts/1/bound',
      jar: true,
    },
    {
      // A missing model is a 404 on both sides (Laravel's
      // ModelNotFoundException; the compiled binding answers 404 too).
      label: 'GET /posts/999/bound (a missing model)',
      method: 'GET',
      uri: '/posts/999/bound',
      jar: true,
      expect: 'diverges',
      why: "the 404 error page is a Laravel framework asset; the compiled side answers a status-only HTML page",
    },
    {
      // A view with a layout: the sections (@section) travel to the layout
      // (@yield) — the compiled side renders the same bytes.
      label: 'GET /posts/1/layout (a view with a layout)',
      method: 'GET',
      uri: '/posts/1/layout',
      jar: true,
    },
    {
      // The Gate: the policy check (the compiled policies answer it at the
      // edge). The user owns the post, so `update` is allowed and `denies` is
      // false; the class-level `viewAny` is allowed for a signed-in user.
      label: 'GET /gate-demo/1 (the policy check)',
      method: 'GET',
      uri: '/gate-demo/1',
      jar: true,
      expectBody: 'yes|no|yes',
    },
    {
      // The same check as a guest (no session): the policy does not allow
      // guests for `update`, so the answer is "no" (the method is not called),
      // and `viewAny` answers "no" too (the policy asks for a user).
      label: 'GET /gate-demo/1 (the policy check, guest)',
      method: 'GET',
      uri: '/gate-demo/1',
      expectBody: 'no|yes|no',
    },
    {
      label: 'POST /posts (FormRequest create)',
      method: 'POST',
      uri: '/posts',
      jar: true,
      form: { _token: '@token', title: 'Shadow Post', body: 'From the shadow harness', published: '1' },
    },
    { label: 'GET /posts (list after create)', method: 'GET', uri: '/posts', jar: true },
    {
      label: 'POST /posts (FormRequest validation failure)',
      method: 'POST',
      uri: '/posts',
      jar: true,
      form: { _token: '@token', body: 'no title' },
    },
    {
      label: 'PUT /posts/1 (update)',
      method: 'PUT',
      uri: '/posts/1',
      jar: true,
      form: { _token: '@token', title: 'Updated title' },
    },
    {
      label: 'PATCH /posts/1/title (property assignment)',
      method: 'PATCH',
      uri: '/posts/1/title',
      jar: true,
      form: { _token: '@token', title: 'Patched title' },
    },
    {
      label: 'DELETE /posts/1 (delete)',
      method: 'DELETE',
      uri: '/posts/1',
      jar: true,
      form: { _token: '@token' },
    },
    {
      // A missing Basic header: Laravel answers 401 with Symfony's
      // UnauthorizedHttpException. The status and the `WWW-Authenticate: Basic`
      // challenge match; the *error page* itself is a Laravel framework asset
      // (the compiled side answers a status-only HTML page).
      label: 'GET /admin (auth.basic, no header)',
      method: 'GET',
      uri: '/admin',
      expect: 'diverges',
      why: "Laravel's default 401 error page is a framework asset; the compiled side answers a status-only HTML page",
    },
    {
      label: 'GET /admin (auth.basic, valid credentials)',
      method: 'GET',
      uri: '/admin',
      headers: { Authorization: BASIC },
    },
    {
      // A snapshot is a *static asset*: the platform serves it without a session,
      // so the fair comparison is a guest request (no cookie jar). Both sides
      // then render the guest nav and the bodies are byte-identical.
      label: 'GET / (welcome snapshot, guest)',
      method: 'GET',
      uri: '/',
    },
    { label: 'GET /login (view snapshot)', method: 'GET', uri: '/login' },
    { label: 'GET /cache-demo (cache snapshot)', method: 'GET', uri: '/cache-demo' },
    {
      // The object store (the padanan for the app's local disk): the compiled
      // side writes to the D1 blob store (one row per object), the real app to
      // the local disk. Both sides read the object back, so the step proves the
      // put/get/exists round trip, not just the status. The fluent disk form
      // (`Storage::disk('local')`) is the same store - the default disk.
      label: 'POST /storage-demo (the object store)',
      method: 'POST',
      uri: '/storage-demo',
      jar: true,
      form: { _token: '@token' },
      // The body must carry the round trip: the value that was written and read
      // back, plus the `exists` answer. It also keeps the step from passing
      // vacuously (a route that does not exist would answer 404 on both sides).
      expectBody: 'hello-shadow|yes|yes|yes|no|hello-disk|yes|yes|yes|no',
    },
    {
      // The helper verbs: `today()` follows the request clock (the oracle
      // freezes Carbon, so both sides answer the same date), the abort
      // helpers are no-ops here, and `Log::` goes to the platform log.
      label: 'POST /verbs-demo (today/abort_if/Log)',
      method: 'POST',
      uri: '/verbs-demo',
      jar: true,
      form: { _token: '@token' },
      expectBody: '2026-01-01',
    },
    {
      // The flash: the redirect flashes into the session and the *next*
      // request reads it (the session payload is compared byte-wise).
      label: 'POST /flash-demo (the flash)',
      method: 'POST',
      uri: '/flash-demo',
      jar: true,
      form: { _token: '@token', title: 'Flash me' },
    },
    {
      label: 'GET /flash-target (the flash is read back)',
      method: 'GET',
      uri: '/flash-target',
      jar: true,
      expectBody: 'saved|Flash me',
    },
    {
      // The helper surface: env() (the build-time config dump is the
      // padanan), data_get(), tap(), session([...]), the cache() helper
      // and report() (the platform log).
      label: 'POST /helpers-demo (the helper surface)',
      method: 'POST',
      uri: '/helpers-demo',
      jar: true,
      form: { _token: '@token' },
      expectBody: 'local|2|v|yes|cached',
    },
    {
      // The Str family: the values are PHP-exact (slug/studly/title/ascii/
      // squish) - the oracle is the real Laravel.
      label: 'POST /str-demo (the Str family)',
      method: 'POST',
      uri: '/str-demo',
      jar: true,
      form: { _token: '@token' },
      expectBody: 'hello-world|HelloWorld|Hello World|Hello World|Hello World',
    },
    {
      // A thrown exception: both sides answer 500. The bodies differ -
      // Laravel's error page is a framework asset, the compiled side answers
      // a status-only HTML page (the same documented divergence as the 401).
      label: 'POST /throw-demo (a thrown exception)',
      method: 'POST',
      uri: '/throw-demo',
      jar: true,
      form: { _token: '@token' },
      expect: 'diverges',
      why: "the 500 error page is a Laravel framework asset; the compiled side answers a status-only HTML page",
    },
    {
      // A bcrypt digest has a random salt, so the two bodies can never be equal.
      // The step declares the *shape* both sides must have.
      label: 'GET /hash-demo (bcrypt digest, random salt)',
      method: 'GET',
      uri: '/hash-demo',
      shape: '^\\$2y\\$\\d{2}\\$[./A-Za-z0-9]{53}$',
    },
    {
      label: 'POST /logout',
      method: 'POST',
      uri: '/logout',
      jar: true,
      form: { _token: '@token' },
    },
  ],
};
