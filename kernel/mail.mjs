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
export function createMailer({ transport = 'log', from: defaultFrom, fetchImpl } = {}) {
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
  // Laravel's message: one address is a string, more are an array.
  const flat = (list) => (list.length === 1 ? list[0].address : list.map((a) => a.address));

  // The transport: the payload goes out (the log, the noop, the resend API).
  const deliver = async (payload) => {
    if (transport === 'noop') return { id: 'noop' };
    if (transport === 'log') {
      sent.push(payload);
      return { id: 'log-' + sent.length };
    }
    if (transport === 'resend') {
      // env.RESEND_API_KEY expected; in tests fetchImpl is mocked
      const key = (typeof process !== 'undefined' && process.env && process.env.RESEND_API_KEY) || 'test-key';
      const res = await f('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: payload.from,
          to: [payload.to].flat(),
          cc: [payload.cc || []].flat(),
          bcc: [payload.bcc || []].flat(),
          reply_to: [payload.replyTo || []].flat(),
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
        }),
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

  // The payload of a mailable (the compiled one) or of a plain object.
  const payloadOf = (message) => {
    if (message && typeof message.__lwMail === 'function') return message.__lwMail();
    if (message && typeof message === 'object' && !Array.isArray(message)) return message;
    throw new Error('mail(): the message is not a payload (a compiled Mailable or an object with to/subject/html)');
  };

  // Laravel's PendingMail: the recipients + the envelope, then send().
  const pending = () => {
    const p = {
      to: [],
      cc: [],
      bcc: [],
      replyTo: [],
      from: null,
      subject: null,
      locale: null,
    };
    p.to = (value) => {
      p.to = addresses(value);
      return p;
    };
    p.cc = (value) => {
      p.cc = addresses(value);
      return p;
    };
    p.bcc = (value) => {
      p.bcc = addresses(value);
      return p;
    };
    p.replyTo = (value) => {
      p.replyTo = addresses(value);
      return p;
    };
    p.subject = (value) => {
      p.subject = value;
      return p;
    };
    p.locale = (value) => {
      p.locale = value;
      return p;
    };
    // The message: the pending recipients win over the mailable's own.
    const build = (message) => {
      const base = payloadOf(message);
      return {
        from: p.from || base.from || defaultFrom || 'noreply@example.com',
        to: p.to.length ? flat(p.to) : base.to === undefined ? null : base.to,
        cc: p.cc.length ? flat(p.cc) : base.cc === undefined ? null : base.cc,
        bcc: p.bcc.length ? flat(p.bcc) : base.bcc === undefined ? null : base.bcc,
        replyTo: p.replyTo.length ? flat(p.replyTo) : base.replyTo === undefined ? null : base.replyTo,
        subject: p.subject || base.subject || null,
        html: base.html === undefined ? null : base.html,
        text: base.text === undefined ? null : base.text,
      };
    };
    p.send = async (message) => deliver(build(message));
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
      if (name) p.to = [{ address: String(address), name }];
      else p.to(address);
      return p;
    },
    cc(address, name) {
      const p = pending();
      if (name) p.cc = [{ address: String(address), name }];
      else p.cc(address);
      return p;
    },
    bcc(address, name) {
      const p = pending();
      if (name) p.bcc = [{ address: String(address), name }];
      else p.bcc(address);
      return p;
    },
    // Laravel: Mail::send($mailable) — the mailable's own envelope.
    async send(message) {
      return deliver(payloadOf(message));
    },
    async sendNow(message) {
      return deliver(payloadOf(message));
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
