// src/worker.mjs — compiled Worker entry point
//   fetch -> kernel/http.mjs (EncryptCookies -> StartSession -> CSRF -> route middleware)
//        -> kernel/router.mjs handler -> cookies/session persisted back onto the response.
//
// Everything the compiled rung does not support fails loud inside handleHttp; this
// file only adapts the Workers Request/Response boundary.
import { normalizeTable } from '../kernel/router.mjs';
import { handleHttp } from '../kernel/http.mjs';
import { createDatabaseCache } from '../kernel/cache.mjs';
import { createMailer } from '../kernel/mail.mjs';
import { createStorage } from '../kernel/storage.mjs';
import { createQueue } from '../kernel/queue.mjs';
import { dueEvents } from '../kernel/scheduler.mjs';
import { routeTable, handlers, builtAt } from './routes.generated.mjs';
import { events as scheduleEvents } from './schedule.generated.mjs';
import config from './config.generated.mjs';
import { models } from './models.generated.mjs';
import { renderErrorView } from './error-renderer.mjs';

const table = normalizeTable(routeTable);

// Every method the router may dispatch. Anything else falls through to assets.
const DISPATCH_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// The `database` cache driver compiled to D1 backs `throttle:n,m` and the Cache
// facade. Only built when the app's default cache store IS `database`; any other
// driver leaves it null, and a `throttle` route then fails loud inside handleHttp.
function makeCache(env) {
  if (!env || !env.DB || config['cache.driver'] !== 'database') return null;
  return createDatabaseCache({ db: env.DB, config });
}

// The Storage padanan: the app's local disk is object storage at the edge (there
// is no local filesystem). R2 when the app binds it, else the D1 blob store (one
// row per object in `lw_blobs` - no extra Cloudflare product, no card). With
// neither, `Storage::` fails loud inside the handler instead of writing into a
// per-isolate memory map.
function makeStorage(env) {
  if (!env) return null;
  if (env.R2) return createStorage({ r2: env.R2, secret: config['app.key'] });
  if (env.DB) return createStorage({ d1: env.DB, secret: config['app.key'] });
  return null;
}

// The log padanan: the platform log (the Workers console). The app's log
// file has no place at the edge.
function makeLogger() {
  return (level, message, context) => {
    const line = '[' + String(level) + '] ' + String(message);
    if (context !== undefined && context !== null) console.log(line, JSON.stringify(context));
    else console.log(line);
    return null;
  };
}
// The mailer: `log` (default, no network), `noop` or `resend`.
function makeMail(env) {
  return createMailer({
    transport: config['mail.driver'] || 'log',
    from: config['mail.from.address'] || undefined,
    fetchImpl: env && typeof env.fetch === 'function' ? env.fetch.bind(env) : undefined,
  });
}

// The queue: a CF Queues binding when the app has one, else the in-memory
// fallback (a port can push either way).
function makeQueue(env) {
  return createQueue({ binding: env && env.QUEUE ? env.QUEUE : null });
}

function toResponse(res, method) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers || {})) {
    if (v !== undefined && v !== null) headers.set(k, String(v));
  }
  for (const cookie of res.setCookie || []) headers.append('set-cookie', cookie);
  return new Response(method === 'HEAD' ? null : res.body, { status: res.status, headers });
}

// The Cloudflare Cron Trigger: the app's dumped schedule fires here, and every
// due event is queued for the app runtime that still exists (the edge triggers,
// it does not run artisan).
async function runSchedule(env, now = new Date()) {
  const due = dueEvents(scheduleEvents, now);
  if (due.length === 0) return { due: [], queued: [] };
  const queue = makeQueue(env);
  const queued = [];
  for (const ev of due) {
    const job = {
      name: ev.name,
      expression: ev.expression,
      command: ev.command,
      timezone: ev.timezone || null,
    };
    await queue.push('laravel-schedule', job);
    queued.push(job.name);
  }
  return { due: due.map((e) => e.name), queued };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // The cron trigger also has an HTTP face (`POST /__lw/cron`), so an app
    // (or a wrangler dev session) can fire the schedule by hand.
    if (url.pathname === '/__lw/cron' && request.method === 'POST') {
      const out = await runSchedule(env, new Date());
      return Response.json({ ok: true, ...out });
    }

    if (DISPATCH_METHODS.has(request.method)) {
      const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
      const db = env && env.DB ? env.DB : null;
      const res = await handleHttp(
        {
          method: request.method,
          url: request.url,
          // Multiple headers of the same name arrive comma-joined, like PHP's
          // $_SERVER. `set-cookie` never appears on requests, so this is lossless.
          headers: Object.fromEntries(request.headers),
          body,
        },
        {
          table,
          handlers,
          config,
          env,
          db,
          cache: makeCache(env),
          storage: makeStorage(env),
          log: makeLogger(),
          mail: makeMail(env),
          queue: makeQueue(env),
          models,
          renderErrorView,
        }
      );
      if (res) return toResponse(res, request.method);
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, worker: 'laravel-workers', builtAt });
    }

    return env.ASSETS.fetch(request);
  },

  // The Cloudflare Cron Trigger entry point (`scheduled`).
  async scheduled(env, ctx) {
    const out = await runSchedule(env, new Date());
    return { ok: true, ...out };
  },
};
