// kernel/service-adapters.mjs — the framework services the edge can inject.
//
// A constructor dependency on a framework service (a mailer, a logger, the
// queue) cannot be built at the edge: there is no container there. The build
// resolves it to the edge adapter of that service instead — the live service
// the request context hands down.
//
// The compiler uses this map to resolve a dependency (and to refuse the ones
// that are not listed); the runtime uses it to hand the live service over.
// A service that is not listed fails loud at build time: the edge must never
// guess what a missing service is.

export const SERVICE_ADAPTERS = {
  'Illuminate\\Mail\\Mailer': 'mail',
  'Illuminate\\Contracts\\Mail\\Mailer': 'mail',
  'Illuminate\\Contracts\\Mail\\Factory': 'mail',
  'Illuminate\\Log\\Logger': 'log',
  'Illuminate\\Contracts\\Log\\Log': 'log',
  'Illuminate\\Log\\LogManager': 'log',
  'Illuminate\\Queue\\Queue': 'queue',
  'Illuminate\\Contracts\\Queue\\Queue': 'queue',
};

// The framework services the edge refuses to inject, with the reason. Their
// store at the edge is asynchronous (Workers KV / D1) while Laravel's is
// synchronous: a listener that reads the cache would get a promise, not the
// value — a silent divergence. The build stops instead.
export const REFUSED_SERVICES = {
  'Illuminate\\Cache\\Repository':
    "the cache at the edge is asynchronous (Workers KV), Laravel's is synchronous — a listener that reads the cache would get a promise, not the value",
  'Illuminate\\Contracts\\Cache\\Repository':
    "the cache at the edge is asynchronous (Workers KV), Laravel's is synchronous — a listener that reads the cache would get a promise, not the value",
  'Illuminate\\Database\\DatabaseManager':
    "the database at the edge is asynchronous (D1), Laravel's is synchronous — a listener that reads the database would get a promise, not the rows",
  'Illuminate\\Contracts\\Database\\DatabaseManager':
    "the database at the edge is asynchronous (D1), Laravel's is synchronous — a listener that reads the database would get a promise, not the rows",
  'Illuminate\\Database\\Connection':
    "the database at the edge is asynchronous (D1), Laravel's is synchronous — a listener that reads the database would get a promise, not the rows",
};

// The methods of an adapter that are asynchronous at the edge. The compiled
// class awaits them: a promise must never leak into a response.
export const ADAPTER_ASYNC = {
  mail: new Set(['send', 'sendNow', 'raw', 'html']),
  log: new Set(),
  queue: new Set(['push', 'later', 'bulk']),
};

export default { SERVICE_ADAPTERS, REFUSED_SERVICES, ADAPTER_ASYNC };
