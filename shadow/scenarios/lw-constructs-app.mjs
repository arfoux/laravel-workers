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
    {
      // Two more posts (older than the seed one): the paginator needs more
      // than one page to answer the same pages, the URLs and the items.
      sql:
        "INSERT INTO posts (id, title, body, published, user_id, created_at, updated_at) " +
        "VALUES (2, 'Second Post', 'Second body', 1, 1, '2025-05-01 00:00:00', '2025-05-01 00:00:00')",
    },
    {
      sql:
        "INSERT INTO posts (id, title, body, published, user_id, created_at, updated_at) " +
        "VALUES (3, 'Third Post', 'Third body', 1, 1, '2025-04-01 00:00:00', '2025-04-01 00:00:00')",
    },
    {
      // The hasMany fixture: two comments on post 1, one on post 2.
      sql:
        "INSERT INTO comments (id, post_id, body, created_at, updated_at) VALUES " +
        "(1, 1, 'First comment', '2025-06-01 01:00:00', '2025-06-01 01:00:00'), " +
        "(2, 1, 'Second comment', '2025-06-01 02:00:00', '2025-06-01 02:00:00'), " +
        "(3, 2, 'Third comment', '2025-05-01 01:00:00', '2025-05-01 01:00:00')",
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
      // A hasMany relation read as a PROPERTY (`$post->comments`): Eloquent
      // loads it lazily - the edge must query the comments of that post.
      label: 'GET /relation-demo (hasMany as a property)',
      method: 'GET',
      uri: '/relation-demo',
      jar: true,
    },
    {
      // The inverse (`$comment->post`): a BelongsTo - one model.
      label: 'GET /belongs-to-demo (belongsTo as a property)',
      method: 'GET',
      uri: '/belongs-to-demo',
      jar: true,
    },
    {
      // An API RESOURCE: the controller answers `new PostResource($post)` and
      // Laravel's Router wraps it in a ResourceResponse - `{"data": {...},
      // "meta": {...}}` (JsonResource::toArray + with()).
      label: 'GET /resource-demo (an API resource)',
      method: 'GET',
      uri: '/resource-demo',
      jar: true,
    },
    {
      // `response()->json($paginator)`: the paginator IS JsonSerializable
      // (LengthAwarePaginator::jsonSerialize -> toArray), so the body is its
      // array - the key order, the `links` labels and the URLs included.
      label: 'GET /posts-paginated-json (response()->json($paginator))',
      method: 'GET',
      uri: '/posts-paginated-json',
      jar: true,
    },
    {
      // The query page, on the COMPILED controller: the paginator reads
      // `?page=2` from the request (Laravel's Paginator::resolveCurrentPage()).
      label: 'GET /posts-paginated-json?page=2 (the compiled paginator reads the query)',
      method: 'GET',
      uri: '/posts-paginated-json',
      query: { page: '2' },
      jar: true,
    },
    {
      // `response()->json($model)`: PHP's json_encode honours the model's
      // JsonSerializable (toArray()), so the body is the model's own JSON.
      label: 'GET /json-model-demo (response()->json($model))',
      method: 'GET',
      uri: '/json-model-demo',
    },
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
      jar: true,      why: "the 404 error page is a Laravel framework asset; the compiled side answers a status-only HTML page",
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
      // The automatic OPTIONS response: Laravel's router answers 200 with an
      // empty body and the Allow header (the verbs the URI accepts) when the
      // method does not match a route. The compiled side answers the same.
      label: 'OPTIONS /posts (the automatic OPTIONS response)',
      method: 'OPTIONS',
      uri: '/posts',
      expectHeader: { allow: 'GET,HEAD,POST' },
    },
    {
      // The method is not allowed: Laravel raises
      // MethodNotAllowedHttpException. The app has no errors/405 view, so the
      // framework's error renderer answers 500 (the Symfony error page) — the
      // compiled side answers the same status.
      label: 'POST /posts/1 (the method is not allowed)',
      method: 'POST',
      uri: '/posts/1',      expectStatus: 500,
      why: 'the 500 error page is a Laravel framework asset; the compiled side answers a status-only page (the status is the same)',
    },
    {
      // The paginator (LengthAwarePaginator): the same total, the same pages,
      // the same items and the same URLs as the real Laravel.
      label: 'GET /posts-paginated (the paginator)',
      method: 'GET',
      uri: '/posts-paginated',
      jar: true,
    },
    {
      // The second page: the page comes from the request (`?page=2`).
      //
      // The second page: the page comes from the request (`?page=2`).
      label: 'GET /posts-paginated?page=2 (the second page)',
      method: 'GET',
      uri: '/posts-paginated',
      query: { page: '2' },
      jar: true,
    },
    {
      // The pagination links: the view renders the paginator (the compiled
      // `pagination::tailwind` - the same markup as the real Laravel).
      label: 'GET /posts-paginated-view (the pagination links)',
      method: 'GET',
      uri: '/posts-paginated-view',
      jar: true,
    },
    {
      // The event dispatch: the listener is a class, so the build compiles it
      // (at the edge there is no listener runtime). The listener writes to the
      // post, so the answer shows the effect (Laravel dispatches it
      // synchronously).
      label: 'POST /event-demo (the event dispatch - EVERY listener runs)',
      method: 'POST',
      uri: '/event-demo',
      jar: true,
      form: { _token: '@token' },
      // Laravel runs every listener of an event (only an answer of false stops
      // the chain): the first listener writes the body, the second one the
      // title. The edge must answer both.
      expectBody: 'notified|notified twice',
    },
    {
      // The mail: a mailable is a class, so the build compiles it (and its
      // view). The mail goes out; the harness compares the FIELDS the real app
      // sent with the fields the edge sent (not the log line).
      label: 'POST /mail-demo (the mailable)',
      method: 'POST',
      uri: '/mail-demo',
      jar: true,
      form: { _token: '@token' },
      expectBody: 'sent',
      expectMails: 1,
    },
    {
      // The mail through a LISTENER: the route dispatches an event, the
      // listener sends the mailable, and the mailable renders its OWN view
      // through the ROUTE's runtime. The route never names the mailable, so
      // the route's own view map does not carry that view - the edge must
      // render it anyway.
      label: 'POST /listener-mail-demo (the mailable a listener sends)',
      method: 'POST',
      uri: '/listener-mail-demo',
      jar: true,
      form: { _token: '@token' },
      expectBody: 'sent',
      expectMails: 1,
    },
    {
      // The mailable in the PROPERTY form (`public $view = 'mail.property';`
      // + the empty constructor `make:mail` scaffolds): Laravel reads the
      // public field, and the compiled instance must carry it.
      label: 'POST /property-mail-demo (the mailable in the property form)',
      method: 'POST',
      uri: '/property-mail-demo',
      jar: true,
      form: { _token: '@token' },
      expectBody: 'sent',
      expectMails: 1,
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
      label: 'POST /posts (the FormRequest hook prepares the input)',
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
      // The model is gone: `response()->json(null)` is Symfony's
      // `$data ??= new \ArrayObject()` -> "{}" (JsonResponse.php:47).
      label: 'GET /json-model-demo (missing model -> {})',
      method: 'GET',
      uri: '/json-model-demo',
      jar: true,
      expectBody: '{}',
    },
    {
      // A missing Basic header: Laravel answers 401 with Symfony's
      // UnauthorizedHttpException. The status and the `WWW-Authenticate: Basic`
      // challenge match; the *error page* itself is a Laravel framework asset
      // (the compiled side answers a status-only HTML page).
      label: 'GET /admin (auth.basic, no header)',
      method: 'GET',
      uri: '/admin',      why: "Laravel's default 401 error page is a framework asset; the compiled side answers a status-only HTML page",
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
    // The image rules: `image` is a header read (getimagesize), and
    // `dimensions` applies its named checks to the same header
    // (ValidatesAttributes::validateImage/validateDimensions). The PNG is a
    // real 3x2 file, so the oracle's getimagesize() answers 3x2.
    {
      label: 'POST /upload-image-demo (a 3x2 PNG passes image+dimensions)',
      method: 'POST',
      uri: '/upload-image-demo',
      jar: true,
      multipart: {
        fields: { _token: '@token', title: 'photo' },
        files: [{
          name: 'photo',
          filename: 'tiny.png',
          type: 'image/png',
          contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAADUlEQVR42mNk+M9QzwAEYgH9Wj0mNwAAAABJRU5ErkJggg==',
        }],
      },
    },
    {
      label: 'POST /upload-image-demo (a text file fails the image rule)',
      method: 'POST',
      uri: '/upload-image-demo',
      jar: true,
      multipart: {
        fields: { _token: '@token', title: 'photo' },
        files: [{
          name: 'photo',
          filename: 'note.txt',
          type: 'text/plain',
          content: 'not an image',
        }],
      },
    },
    {
      label: 'POST /upload-image-min-demo (the dimensions check fails: 3 < 4000)',
      method: 'POST',
      uri: '/upload-image-min-demo',
      jar: true,
      multipart: {
        fields: { _token: '@token', title: 'photo' },
        files: [{
          name: 'photo',
          filename: 'tiny.png',
          type: 'image/png',
          contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAADUlEQVR42mNk+M9QzwAEYgH9Wj0mNwAAAABJRU5ErkJggg==',
        }],
      },
    },
    {
      // A GLOBAL Gate::define() ability with a STRING callback
      // (`[AbilityGate::class, 'canPublish']`): the build compiles the class and
      // the kernel's gate runs it. A guest reaches the callback (its first
      // parameter is nullable), so it answers "denied" - Laravel's own answer.
      label: 'POST /gate-global-demo (a global Gate::define ability)',
      method: 'POST',
      uri: '/gate-global-demo',
      jar: true,
      form: { _token: '@token' },
      expectBody: 'allowed',
    },
    {
      // A QUEUED job: Laravel's `database` driver writes a `jobs` row and a
      // worker consumes it later; the edge writes `lw_jobs` and the cron
      // trigger drains it. The route's own answer is the same on both sides
      // (the work happens after the response).
      label: 'POST /queue-demo (a queued job)',
      method: 'POST',
      uri: '/queue-demo',
      jar: true,
      form: { _token: '@token' },
      expectBody: 'queued',
    },
    {
      // A TYPED route parameter: PHP 8 coerces the numeric segment ("42" ->
      // 42) and throws a TypeError for a non-numeric one (a 500).
      label: 'GET /int-param-demo/42 (a typed int parameter)',
      method: 'GET',
      uri: '/int-param-demo/42',
      expectBody: 'n=42',
    },
    {
      label: 'GET /int-param-demo/abc (a typed int parameter, TypeError)',
      method: 'GET',
      uri: '/int-param-demo/abc',
    },
    {
      // The upload (a multipart body): the file's metadata, the store (the
      // app's default disk) and the bytes that come back from it. The name is
      // fixed (`storeAs`), so the path is the same on both sides - the random
      // name of `store()` cannot be compared byte-wise.
      label: 'POST /upload-demo (the upload)',
      method: 'POST',
      uri: '/upload-demo',
      jar: true,
      multipart: {
        fields: { _token: '@token', title: 'Shadow upload' },
        files: [{ name: 'avatar', filename: 'shadow.txt', type: 'text/plain', content: 'hello file' }],
      },
      expectBody: 'shadow.txt|txt|text/plain|10|uploads/shadow-upload.txt|10|hello file',
    },
    {
      // The size rule of a file is in kilobytes (Laravel's
      // `(string) ($file->getSize() / 1024)`): the file is 10 bytes, so the
      // 0 KB limit fails. The JSON path answers 422 with the message.
      label: 'POST /upload-strict-demo (the file is too big)',
      method: 'POST',
      uri: '/upload-strict-demo',
      jar: true,
      headers: { Accept: 'application/json' },
      multipart: {
        fields: { _token: '@token', title: 'Shadow upload' },
        files: [{ name: 'avatar', filename: 'shadow.txt', type: 'text/plain', content: 'hello file' }],
      },
      expectStatus: 422,
    },
    {
      // The FormRequest hooks: the compiled lifecycle runs them in Laravel's
      // order (prepareForValidation -> authorize -> the validator over
      // validationData() -> withValidator -> after -> the rules ->
      // passedValidation). The JSON answer shows what the hooks produced:
      // `extra` is NULL (validationData() narrowed the data, so the field
      // never reached the rules or `validated()`) and `passedValidation` is
      // "ran" (the hook merged it in after the rules passed).
      label: 'POST /hooked-request-demo (the FormRequest hooks run)',
      method: 'POST',
      uri: '/hooked-request-demo',
      jar: true,
      headers: { Accept: 'application/json' },
      form: { _token: '@token', title: 'Hello hooks', flag: 'ok', extra: 'not-validated' },
      expectStatus: 200,
    },
    {
      // withValidator() registered an after() callback on the validator: the
      // callback runs after the rules pass and the message it adds is the
      // 422 body.
      label: 'POST /hooked-request-demo (withValidator refuses the flag)',
      method: 'POST',
      uri: '/hooked-request-demo',
      jar: true,
      headers: { Accept: 'application/json' },
      form: { _token: '@token', title: 'Hello hooks', flag: 'with-validator' },
      expectStatus: 422,
    },
    {
      // after() RETURNED the callback Laravel registers on the validator.
      label: 'POST /hooked-request-demo (after refuses the flag)',
      method: 'POST',
      uri: '/hooked-request-demo',
      jar: true,
      headers: { Accept: 'application/json' },
      form: { _token: '@token', title: 'Hello hooks', flag: 'after' },
      expectStatus: 422,
    },
    {
      // authorize() returns false -> Laravel raises the 403
      // (ValidatesWhenResolvedTrait::failedAuthorization), NOT a skipped route
      // and NOT a 422.
      label: 'POST /hooked-request-demo (authorize() denies)',
      method: 'POST',
      uri: '/hooked-request-demo',
      jar: true,
      headers: { Accept: 'application/json' },
      form: { _token: '@token', title: 'Hello hooks', deny: 'yes' },
      expectStatus: 403,
    },
    {
      // The size rule's message is Laravel 13's own ("... must not be greater
      // than 255 characters."): the compiled side uses the same texts (the
      // app's lang file wins - the build dumps it with the translations).
      label: 'PUT /posts/1 (a too long title)',
      method: 'PUT',
      uri: '/posts/1',
      jar: true,
      headers: { Accept: 'application/json' },
      form: { _token: '@token', title: 'x'.repeat(300) },
      expectStatus: 422,
      expectBody: 'The title field must not be greater than 255 characters.',
    },
    {
      // Several files in one field (`photos[]`): the names, the count and the
      // total size are the same on both sides.
      label: 'POST /upload-multi-demo (several files in one field)',
      method: 'POST',
      uri: '/upload-multi-demo',
      jar: true,
      multipart: {
        fields: { _token: '@token' },
        files: [
          { name: 'photos[]', filename: 'a.txt', type: 'text/plain', content: 'aaa' },
          { name: 'photos[]', filename: 'b.txt', type: 'text/plain', content: 'bbbb' },
        ],
      },
      expectBody: '2|a.txt,b.txt|7',
    },
    {
      // The free path's limit: the D1 blob store holds 1.5 MB per object, the
      // local disk has no limit. The compiled side fails loud (a 500 with the
      // limit in the message), the real app stores the file.
      label: 'POST /upload-big-demo (a file bigger than the D1 blob limit)',
      method: 'POST',
      uri: '/upload-big-demo',
      jar: true,
      multipart: {
        fields: { _token: '@token', title: 'Shadow upload' },
        files: [{ name: 'avatar', filename: 'big.txt', type: 'text/plain', content: 'x'.repeat(1600000) }],
      },      why: 'the D1 blob store (the free path) holds at most 1.5 MB per object - the compiled side fails loud, the local disk has no limit',
      expect: 'diverges',
      divergence: 'the D1 blob store (the free path) caps an object at 1.5 MB - the compiled side fails loud where the local disk has no limit (a platform limit, not a Laravel rule)',
    
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
      form: { _token: '@token' },      why: "the 500 error page is a Laravel framework asset; the compiled side answers a status-only HTML page",
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
