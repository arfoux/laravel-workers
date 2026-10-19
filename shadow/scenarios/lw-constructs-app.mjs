// shadow/scenarios/lw-constructs-app.mjs — the construct-coverage app.
//
// Every route of the constructs fixture (10 app routes) is replayed against the
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
      // would leave the order to the database).
      sql:
        "INSERT INTO posts (id, title, body, published, created_at, updated_at) " +
        "VALUES (1, 'Hello Edge', 'First body', 1, '2025-06-01 00:00:00', '2025-06-01 00:00:00')",
    },
  ],
  steps: [
    // The guest request bootstraps the session (and the CSRF token).
    { label: 'GET /dashboard (guest)', method: 'GET', uri: '/dashboard' },
    {
      label: 'POST /login (wrong password)',
      method: 'POST',
      uri: '/login',
      jar: true,
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
    { label: 'GET /posts (list)', method: 'GET', uri: '/posts', jar: true },
    { label: 'GET /posts/1 (show)', method: 'GET', uri: '/posts/1', jar: true },
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
      label: 'GET /admin (auth.basic, no header)',
      method: 'GET',
      uri: '/admin',
    },
    {
      label: 'GET /admin (auth.basic, valid credentials)',
      method: 'GET',
      uri: '/admin',
      headers: { Authorization: BASIC },
    },
    {
      label: 'GET / (welcome snapshot)',
      method: 'GET',
      uri: '/',
      expect: 'diverges',
      why: 'a snapshot is prerendered at build time — the nav cannot know the visitor session',
    },
    { label: 'GET /login (view snapshot)', method: 'GET', uri: '/login' },
    { label: 'GET /cache-demo (cache snapshot)', method: 'GET', uri: '/cache-demo' },
    {
      label: 'GET /hash-demo (bcrypt salt is random)',
      method: 'GET',
      uri: '/hash-demo',
      expect: 'diverges',
      why: 'bcrypt uses a random salt, so the snapshot and the live render differ',
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
