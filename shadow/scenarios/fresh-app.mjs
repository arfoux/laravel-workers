// shadow/scenarios/fresh-app.mjs — the Breeze-shaped fresh app.
//
// The same harness, a second app: the login flow, the auth-guarded dashboard,
// the post list/detail and the logout. It proves the harness is not tied to
// one app shape.

const EMAIL = 'u@example.com';
const PASSWORD = 'secret';

export default {
  name: 'fresh',
  user: { id: 1, email: EMAIL, password: PASSWORD },
  fixtures: [
    {
      // The seed post is *older* than the frozen clock, so the
      // `orderByDesc('created_at')` order is deterministic on both sides.
      sql:
        "INSERT INTO posts (id, title, body, published, created_at, updated_at) " +
        "VALUES (1, 'Hello Edge', 'First body', 1, '2025-06-01 00:00:00', '2025-06-01 00:00:00')",
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
      label: 'POST /login (authenticates)',
      method: 'POST',
      uri: '/login',
      jar: true,
      form: { _token: '@token', email: EMAIL, password: PASSWORD },
    },
    { label: 'GET /dashboard (authenticated)', method: 'GET', uri: '/dashboard', jar: true },
    { label: 'GET /posts (list)', method: 'GET', uri: '/posts', jar: true },
    { label: 'GET /posts/1 (show)', method: 'GET', uri: '/posts/1', jar: true },
    // The API surface: a resource that nests resources (the encoder resolves
    // them with the live request) and json_encode() of a resource.
    { label: 'GET /posts/1/resource (nested resource)', method: 'GET', uri: '/posts/1/resource', query: { probe: 'hello' } },
    { label: 'GET /posts/1/json (json_encode of a resource)', method: 'GET', uri: '/posts/1/json', query: { probe: 'hello' } },
    {
      // A snapshot is a *static asset*: the platform serves it without a session,
      // so the fair comparison is a guest request (no cookie jar).
      label: 'GET / (welcome snapshot, guest)',
      method: 'GET',
      uri: '/',
    },
    { label: 'GET /login (view snapshot)', method: 'GET', uri: '/login' },
    {
      label: 'POST /logout',
      method: 'POST',
      uri: '/logout',
      jar: true,
      form: { _token: '@token' },
    },
    { label: 'GET /dashboard (after logout)', method: 'GET', uri: '/dashboard', jar: true },
  ],
};
