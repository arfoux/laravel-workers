// kernel/mail.mjs — Mail (log/noop/resend)
//
// The surface is Laravel's: `Mail::to($user)->send($mailable)`,
// `Mail::send($mailable)`, `Mail::raw($text, $callback)`. The compiled rung
// calls it exactly like the app does, so a listener (or a controller) that
// sends a mail needs no port.
//
// The message is a flat payload: { from, to, cc, bcc, replyTo, subject, html,
// text } — the recipients are a string or an array of them, exactly like
// Laravel's message. A compiled Mailable hands its payload over through
// `__lwMail()` (the compiler emits it).
export function createMailer({ transport = 'log', from: defaultFrom, key: keyOpt, fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const sent = [];

  // The recipients: a string, an array of them, a model (an email + a name).
  const addresses = (value) => {
    if (value === null || value === undefined) return [];
    if (typeof value === 'string') return value === '' ? [] : [{ address: value, name: null }];
    if (Array.isArray(value)) return value.flatMap(addresses);
    if (typeof value === 'object') {
      if (typeof value.email === 'string') return [{ address: value.email, name: value.name || null }];
      if (value.address) return [{ address: String(value.address), name: value.name || null }];
    }
    throw new Error('mail(): the recipient is not an address (a string, an array of them, or a model with an email)');
  };
  // Laravel's message: one address is a string, more are an array; no address
  // at all is null.
  const flat = (list) => (list.length === 1 ? list[0].address : list.map((a) => a.address));
  const oneOrMany = (list) => (list && list.length ? flat(list) : null);
  const many = (list) => (list && list.length ? list.map((a) => a.address) : []);
  // The recipients: the mailable's own + the pending's, appended and deduped by
  // address (Laravel's Mailable::setAddress()).
  const mergeAddresses = (own, extra) => {
    // Laravel's Mailable::setAddress(): the list is deduped by address and the
    // LAST occurrence wins - at its own position (reverse()->unique('address')
    // ->reverse()).
    const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
    const all = [];
    for (const a of asList(own)) all.push(a);
    for (const a of asList(extra)) all.push(a);
    const seen = new Set();
    const reversed = [];
    for (let k = all.length - 1; k >= 0; k--) {
      const a = all[k];
      const address = typeof a === 'string' ? a : a && a.address;
      if (!address || seen.has(address)) continue;
      seen.add(address);
      reversed.push(typeof a === 'string' ? { address: String(a), name: null } : a);
    }
    return reversed.reverse();
  };

  // The transport: the payload goes out (the log, the noop, the resend API).
  const deliver = async (payload) => {
    if (transport === 'noop') return { id: 'noop' };
    if (transport === 'log') {
      sent.push(payload);
      return { id: 'log-' + sent.length };
    }
    if (transport === 'resend') {
      // The key: the Worker's env (wrangler secret put RESEND_API_KEY), else
      // process.env (nodejs_compat), else the test fallback.
      const key = keyOpt || (typeof process !== 'undefined' && process.env && process.env.RESEND_API_KEY) || 'test-key';
      // Resend rejects requests without a User-Agent (403, code 1010), so the
      // header is explicit rather than left to the client.
      const res = await f('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'laravel-workers (Cloudflare Workers)' },
        body: JSON.stringify(resendBody(payload)),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error('resend ' + res.status + ' ' + body);
      }
      const json = await res.json();
      return { id: json.id || 'resend' };
    }
    throw new Error('unknown transport ' + transport);
  };

  // The Resend payload: the required fields always, the optional ones only
  // when present (an empty array or a null text is omitted, not sent).
  const resendBody = (payload) => {
    const body = {
      from: payload.from,
      to: [payload.to].flat(),
      subject: payload.subject,
    };
    const cc = [payload.cc || []].flat();
    const bcc = [payload.bcc || []].flat();
    const replyTo = [payload.replyTo || []].flat();
    if (cc.length) body.cc = cc;
    if (bcc.length) body.bcc = bcc;
    if (replyTo.length) body.reply_to = replyTo;
    if (payload.html) body.html = payload.html;
    if (typeof payload.text === 'string' && payload.text.length) body.text = payload.text;
    return body;
  };

  // The payload of a mailable (the compiled one) or of a plain object.
  // Laravel's message shape: `to` is a string for one address and an array for
  // more; `cc`/`bcc`/`replyTo` are always arrays.
  const normalizeTo = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    if (!Array.isArray(v)) return null;
    return v.length === 1 ? v[0].address : v.map((a) => (typeof a === 'string' ? a : a.address));
  };
  const normalizeMany = (v) => {
    if (v === null || v === undefined) return [];
    if (typeof v === 'string') return [v];
    if (!Array.isArray(v)) return [];
    return v.map((a) => (typeof a === 'string' ? a : a.address));
  };
  const payloadOf = async (message) => {
    let base;
    if (message && typeof message.__lwMail === 'function') base = await message.__lwMail();
    else if (message && typeof message === 'object' && !Array.isArray(message)) base = message;
    else throw new Error('mail(): the message is not a payload (a compiled Mailable or an object with to/subject/html)');
    return base;
  };
  // ONE builder for every path (the pending, the facade's send, the raw/html):
  // the recipients are merged (the mailable's own + the pending's, appended and
  // deduped by address) and then shaped like Laravel's message (to: a string for
  // one address, an array for more; cc/bcc/replyTo: always arrays).
  const buildPayload = async (pendingValues, message) => {
    const base = await payloadOf(message);
    const p = pendingValues || {};
    return {
      // Laravel's $from is a LIST; the payload's from is a string for one address and an
      // array for more (like to) - the app's mail.from is a string.
      from: p.from || oneOrMany(mergeAddresses(base.from, [])) || defaultFrom || 'noreply@example.com',
      to: oneOrMany(mergeAddresses(base.to, p.to)),
      cc: many(mergeAddresses(base.cc, p.cc)),
      bcc: many(mergeAddresses(base.bcc, p.bcc)),
      replyTo: many(mergeAddresses(base.replyTo, p.replyTo)),
      subject: base.subject == null ? null : base.subject,
      html: base.html === undefined ? null : base.html,
      text: base.text === undefined ? null : base.text,
    };
  };

  // Laravel's PendingMail: the recipients + the envelope, then send().
  const pending = () => {
    // The values live in their own fields: the Laravel-named members are the
    // fluent setters (so `p.to` is a function, not the list).
    const p = {
      __to: [],
      __cc: [],
      __bcc: [],
      __replyTo: [],
      __subject: null,
      __locale: null,
      from: null,
    };
    p.to = (value) => {
      p.__to = addresses(value);
      return p;
    };
    p.cc = (value) => {
      p.__cc = addresses(value);
      return p;
    };
    p.bcc = (value) => {
      p.__bcc = addresses(value);
      return p;
    };
    p.replyTo = (value) => {
      p.__replyTo = addresses(value);
      return p;
    };
    p.subject = (value) => {
      p.__subject = value;
      return p;
    };
    p.locale = (value) => {
      p.__locale = value;
      return p;
    };
    // The message: the pending recipients win over the mailable's own.
    const build = (message) =>
      buildPayload({ from: p.from, to: p.__to, cc: p.__cc, bcc: p.__bcc, replyTo: p.__replyTo }, message);
    p.send = async (message) => deliver(await build(message));
    p.sendNow = p.send;
    // A queued mail: the edge pushes it to the queue, but nothing consumes
    // the queue (the worker has no queue consumer) — the mail would never go
    // out. It fails loud instead of vanishing.
    p.queue = () => {
      throw new Error(
        'mail(): the queued mail is not delivered at the edge — the worker has no queue consumer, so the mail would never go out'
      );
    };
    p.later = p.queue;
    return p;
  };

  return {
    // for tests
    outbox: sent,
    transport,
    // Laravel: Mail::to($user) — the recipients + the envelope, then send().
    to(address, name) {
      const p = pending();
      p.__to = name ? [{ address: String(address), name }] : addresses(address);
      return p;
    },
    cc(address, name) {
      const p = pending();
      p.__cc = name ? [{ address: String(address), name }] : addresses(address);
      return p;
    },
    bcc(address, name) {
      const p = pending();
      p.__bcc = name ? [{ address: String(address), name }] : addresses(address);
      return p;
    },
    // Laravel: Mail::send($mailable) — the mailable's own envelope.
    async send(message) {
      return deliver(await buildPayload({}, message));
    },
    async sendNow(message) {
      return deliver(await buildPayload({}, message));
    },
    // Laravel: Mail::raw($text, $callback) — the callback fills the message.
    async raw(text, callback) {
      const payload = { text: String(text) };
      if (typeof callback === 'function') await callback(payload);
      return deliver({
        from: payload.from || defaultFrom || 'noreply@example.com',
        to: payload.to === undefined ? null : payload.to,
        cc: payload.cc === undefined ? null : payload.cc,
        bcc: payload.bcc === undefined ? null : payload.bcc,
        replyTo: payload.replyTo === undefined ? null : payload.replyTo,
        subject: payload.subject || null,
        html: null,
        text: payload.text,
      });
    },
    // Laravel: Mail::html($html, $callback).
    async html(html, callback) {
      const payload = { html: String(html) };
      if (typeof callback === 'function') await callback(payload);
      return deliver({
        from: payload.from || defaultFrom || 'noreply@example.com',
        to: payload.to === undefined ? null : payload.to,
        cc: payload.cc === undefined ? null : payload.cc,
        bcc: payload.bcc === undefined ? null : payload.bcc,
        replyTo: payload.replyTo === undefined ? null : payload.replyTo,
        subject: payload.subject || null,
        html: payload.html,
        text: null,
      });
    },
    // Laravel: Mail::queue($mailable) — no consumer at the edge.
    queue() {
      throw new Error(
        'mail(): the queued mail is not delivered at the edge — the worker has no queue consumer, so the mail would never go out'
      );
    },
    later() {
      throw new Error(
        'mail(): the queued mail is not delivered at the edge — the worker has no queue consumer, so the mail would never go out'
      );
    },
  };
}

export default { createMailer };
