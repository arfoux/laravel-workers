// kernel/mailable.mjs — the Mailable base (Laravel's Illuminate\Mail\Mailable).
//
// The compiled mailable extends this: the class compiler emits the app's own
// methods (build(), ...) and this base provides Laravel's fluent surface
// (subject(), view(), with(), from(), cc(), bcc(), replyTo(), to()) plus
// __lwMail() - the flat payload the mailer sends.
//
// The payload is Laravel's message shape: { from, to, cc, bcc, replyTo,
// subject, html, text }. The html is the compiled view (the runtime renders
// it with the mailable's data) - Laravel renders the mailable's view too,
// so the bytes can be compared.
export class Mailable {
  constructor() {
    this.__to = [];
    this.__cc = [];
    this.__bcc = [];
    this.__replyTo = [];
    this.__from = null;
    this.__subject = null;
    this.__html = null;
    this.__text = null;
    this.__view = null;
    this.__viewData = {};
    this.__data = {};
  }

  // ---- Laravel's fluent surface (every setter returns the mailable) ----
  subject(value) {
    this.__subject = value == null ? null : String(value);
    return this;
  }
  view(name, data) {
    this.__view = String(name);
    if (data && typeof data === 'object') Object.assign(this.__viewData, data);
    return this;
  }
  with(data) {
    if (data && typeof data === 'object') Object.assign(this.__data, data);
    return this;
  }
  from(address, name) {
    this.__from = { address: String(address), name: name == null ? null : String(name) };
    return this;
  }
  to(address, name) {
    this.__to.push({ address: String(address), name: name == null ? null : String(name) });
    return this;
  }
  cc(address, name) {
    this.__cc.push({ address: String(address), name: name == null ? null : String(name) });
    return this;
  }
  bcc(address, name) {
    this.__bcc.push({ address: String(address), name: name == null ? null : String(name) });
    return this;
  }
  replyTo(address, name) {
    this.__replyTo.push({ address: String(address), name: name == null ? null : String(name) });
    return this;
  }
  text(value) {
    this.__text = value == null ? null : String(value);
    return this;
  }
  html(value) {
    this.__html = value == null ? null : String(value);
    return this;
  }

  // ---- the payload the mailer sends ----
  // The view: the runtime renders the compiled view with the mailable's data
  // (rt.view(name, data)) - Laravel renders the mailable's view too, so the
  // bytes can be compared.
  async __lwMail(rt) {
    const r = rt || this.__rt || null;
    // Laravel: Mailable::send() calls build() first (the envelope + the view).
    if (typeof this.build === 'function') await this.build();
    let html = this.__html;
    if (html === null && this.__view) {
      const data = Object.assign({}, this.__data, this.__viewData);
      // The runtime's view() answers a response (the body is the rendered
      // view) - the mail's html is that body.
      const rendered = r ? r.view(this.__view, data) : null;
      html = rendered && rendered.body !== undefined ? rendered.body : rendered;
    }
    return {
      from: this.__from,
      to: this.__to,
      cc: this.__cc,
      bcc: this.__bcc,
      replyTo: this.__replyTo,
      subject: this.__subject,
      html: html == null ? null : String(html),
      text: this.__text,
    };
  }
}

export default Mailable;
