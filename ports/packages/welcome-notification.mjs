// Port: spatie/laravel-welcome-notification — POST /welcome-notify.
//
// The package sends a welcome notification to a freshly-registered user through
// whatever mail/notification driver Laravel is configured with. The SMTP
// transport is a raw socket (:25/:587) that Workers forbids, so on the edge the
// welcome mail is dispatched over one of the two HTTP mail drivers already
// ported in this cluster — Mailgun or Postmark. This handler is a thin router:
// it validates the {email, name, mailProvider} payload, composes the welcome
// subject/body, then delegates to the existing `mailgun-mail` / `postmark-mail`
// handlers so the provider request-building, auth and response mapping stay in
// exactly one place (both reuse kernel/packages/notify-http.mjs).
//
// Payload (ctx.body): { email (required), name?, mailProvider: 'mailgun'|'postmark',
//   mailgunDomain?, mailgunKey?, postmarkToken? }.
// Provider credentials may instead come from env (MAILGUN_DOMAIN/MAILGUN_SECRET,
// POSTMARK_TOKEN). Postmark additionally needs a verified sender — set
// POSTMARK_FROM in env (the delegated handler enforces it). The provider's HTTP
// response is mapped 1:1 to {status, headers, body}; a thrown fetch becomes 502.
import { jsonPort } from '../../kernel/packages/notify-http.mjs';
import { normalizePortCtx } from '../../kernel/packages/port-ctx.mjs';
import mailgun from './mailgun-mail.mjs';
import postmark from './postmark-mail.mjs';

// Compose the standard notification payload for a welcome mail.
function welcomePayload(email, name) {
  const subject = name ? `Welcome, ${name}!` : 'Welcome!';
  const body = `Hi${name ? ` ${name}` : ''}, welcome aboard — we're glad you joined.`;
  return { to: email, subject, body };
}

export default async function handle(ctx, env) {
  ctx = normalizePortCtx(ctx);
  const req = (ctx && ctx.body) || {};
  const email = typeof req.email === 'string' ? req.email.trim() : '';
  if (!email) {
    return jsonPort({ error: "welcome notification requires a non-empty 'email'" }, 422);
  }

  const name = typeof req.name === 'string' ? req.name.trim() : '';
  const provider = String(req.mailProvider || (env && env.MAIL_PROVIDER) || '').toLowerCase();
  const inner = { body: welcomePayload(email, name), query: {}, params: {} };

  if (provider === 'mailgun') {
    return mailgun(inner, {
      ...env,
      MAILGUN_DOMAIN: req.mailgunDomain || (env && env.MAILGUN_DOMAIN),
      MAILGUN_SECRET: req.mailgunKey || (env && env.MAILGUN_SECRET),
    });
  }

  if (provider === 'postmark') {
    return postmark(inner, {
      ...env,
      POSTMARK_TOKEN: req.postmarkToken || (env && env.POSTMARK_TOKEN),
    });
  }

  return jsonPort(
    { error: "unsupported mailProvider: expected 'mailgun' or 'postmark'" },
    422
  );
}
