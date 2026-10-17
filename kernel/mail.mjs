// kernel/mail.mjs — Workers mail padanan (M7). Pure ESM, fetch only.
export function createMailer({ transport = 'log', from: defaultFrom, fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const sent = [];
  return {
    // for tests
    outbox: sent,
    async send({ to, subject, html, text, from } = {}) {
      const payload = { from: from || defaultFrom || 'noreply@example.com', to, subject, html, text };
      if (transport === 'noop') return { id: 'noop' };
      if (transport === 'log') { sent.push(payload); return { id: 'log-' + (sent.length) }; }
      if (transport === 'resend') {
        // env.RESEND_API_KEY expected; in tests fetchImpl is mocked
        const key = (typeof process !== 'undefined' && process.env && process.env.RESEND_API_KEY) || 'test-key';
        const res = await f('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: payload.from, to: [payload.to].flat(), subject: payload.subject, html: payload.html, text: payload.text }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error('resend ' + res.status + ' ' + body);
        }
        const json = await res.json();
        return { id: json.id || 'resend' };
      }
      throw new Error('unknown transport ' + transport);
    },
  };
}
export default { createMailer };
