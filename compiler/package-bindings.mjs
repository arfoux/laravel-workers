// compiler/package-bindings.mjs — M3: package facade → kernel primitive table.
//
// The Laravel packages whose surface is genuinely a thin HTTP/DB call (a token
// mint, an OAuth exchange, a webhook signature check, a broadcast channel
// auth, an outbound notification POST) map onto the kernel/package primitives
// that already ship (kernel/packages/*.mjs). This table is the single source
// of truth the compiler guard reads: for each facade FQCN it names the rt
// primitive (`rt.<primitive>`), the methods that ARE ported (facade method → the
// primitive's function name), and which of those compile to an `await`-ed call.
//
// Anything a facade method needs that is NOT a thin call (the Cashier billing
// portal, the Socialite driver matrix, Stripe's full SDK, a Notification's mail
// channel) is deliberately ABSENT here, so it still hits the catch-all LW003
// "unknown class/static" and refuses loudly — the same honesty rule the
// STORAGE/SESSION facade guards follow. This is a substitution, not Laravel's
// own implementation; the disclosure lives in the per-package docs.
//
// A binding entry:
//   facade    — the short name as written in source (`Sanctum::...`)
//   fqcn      — the full class (`Laravel\Sanctum`), also matched
//   primitive — the rt member (`rt.token`) the call compiles to
//   methods   — an OBJECT map: the facade method as written in source -> the
//               primitive function the call compiles to (`rt.token.<fn>(...)`)
//   async     — the primitive function NAMES (the values above) that are async
//               at the edge and must be awaited

export const PACKAGE_BINDINGS = [
  {
    facade: 'Sanctum',
    fqcn: 'Laravel\\Sanctum',
    primitive: 'token',
    methods: {
      create: 'createPersonalAccessToken',
      verify: 'verifyPersonalAccessToken',
      bearer: 'bearerToken',
      random: 'randomString',
    },
    async: ['createPersonalAccessToken', 'verifyPersonalAccessToken'],
  },
  {
    facade: 'Socialite',
    fqcn: 'Laravel\\Socialite\\Facades\\Socialite',
    primitive: 'oauth',
    methods: {
      authorizeUrl: 'authorizeUrl',
      verifyState: 'verifyState',
      exchangeCode: 'exchangeCode',
      fetchUser: 'fetchUser',
    },
    async: ['exchangeCode', 'fetchUser'],
  },
  {
    facade: 'Cashier',
    fqcn: 'Laravel\\Cashier\\Cashier',
    primitive: 'webhook',
    methods: {
      verifyStripe: 'verifyStripeSignature',
      verifyPaddle: 'verifyPaddleSignature',
      verifyLemon: 'verifyLemonSignature',
      timingSafeEqual: 'timingSafeEqual',
    },
    async: ['verifyStripeSignature', 'verifyPaddleSignature', 'verifyLemonSignature'],
  },
  {
    facade: 'Stripe',
    fqcn: 'Stripe\\Stripe',
    primitive: 'webhook',
    methods: {
      verifyStripe: 'verifyStripeSignature',
      verifyPaddle: 'verifyPaddleSignature',
      verifyLemon: 'verifyLemonSignature',
      timingSafeEqual: 'timingSafeEqual',
    },
    async: ['verifyStripeSignature', 'verifyPaddleSignature', 'verifyLemonSignature'],
  },
  {
    facade: 'Broadcast',
    fqcn: 'Illuminate\\Support\\Facades\\Broadcast',
    primitive: 'broadcast',
    methods: {
      isPrivateChannel: 'isPrivateChannel',
      signChannelAuth: 'signChannelAuth',
      presenceAuth: 'presenceAuth',
      buildAuthQueryString: 'buildAuthQueryString',
      verifyChannelAuth: 'verifyChannelAuth',
    },
    async: ['signChannelAuth', 'presenceAuth', 'buildAuthQueryString', 'verifyChannelAuth'],
  },
  {
    facade: 'Notification',
    fqcn: 'Illuminate\\Support\\Facades\\Notification',
    primitive: 'notify',
    methods: {
      normalisePayload: 'normalisePayload',
      jsonPort: 'jsonPort',
      basicAuthHeader: 'basicAuthHeader',
      bearerAuthHeader: 'bearerAuthHeader',
      formUrlEncoded: 'formUrlEncoded',
      multipartForm: 'multipartForm',
      mapProviderResponse: 'mapProviderResponse',
      resolveFetch: 'resolveFetch',
    },
    async: ['mapProviderResponse'],
  },
];

// Build the lookup the transpiler guard uses: both the short facade name and
// the FQCN key to the same binding, so `Sanctum::create()` and
// `\Laravel\Sanctum::create()` land on the same primitive. Each entry carries
// the facade-method → primitive-function map (for the emitted call) and the
// async set (for the `await`), and the facade-method names that the 'allowed:
// ...' refusal message lists.
export function buildPackageBindingIndex() {
  const index = new Map();
  for (const binding of PACKAGE_BINDINGS) {
    index.set(binding.facade, {
      primitive: binding.primitive,
      methods: new Map(Object.entries(binding.methods)),
      async: new Set(binding.async),
      allowed: Object.keys(binding.methods),
    });
    index.set(binding.fqcn, {
      primitive: binding.primitive,
      methods: new Map(Object.entries(binding.methods)),
      async: new Set(binding.async),
      allowed: Object.keys(binding.methods),
    });
  }
  return index;
}

export default PACKAGE_BINDINGS;
