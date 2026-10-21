// kernel/mailable.mjs — the Mailable base (Laravel's Illuminate\Mail\Mailable).
//
// The compiled mailable extends this: the class compiler emits the app's own
// methods (build(), ...) and this base provides Laravel's surface plus the
// payload the mailer sends.
//
// Laravel's Mailable declares PUBLIC fields (Illuminate\Mail\Mailable:
// `public $subject; public $from = []; public $to = []; public $cc = [];
// public $bcc = []; public $replyTo = []; public $view; public $textView;
// public $viewData = [];`) AND fluent setters with the same names
// (`subject()`, `view()`, `with()`, ...). PHP keeps the field and the method
// apart; JavaScript does not - a field would shadow the method. So the base
// keeps its values in private fields (`__subject`, ...) and the payload reads
// the private value first, then the public field (so `public $subject = 'X'`
// and `$this->subject('X')` both work).
//
// The payload is Laravel's message shape: { from, to, cc, bcc, replyTo,
// subject, html, text }. The html is the compiled view (the runtime renders it
// with the mailable's data - Laravel's buildViewData(): the PUBLIC properties
// merged with the with() data).
export class Mailable {
  constructor() {
    // The private values (the fluent setters write them).
    this.__subject = undefined;
    this.__from = undefined;
    this.__to = undefined;
    this.__cc = undefined;
    this.__bcc = undefined;
    this.__replyTo = undefined;
    this.__view = undefined;
    this.__textView = undefined;
    this.__viewData = undefined;
    this.__html = undefined;
    this.__text = undefined;
  }

  // ---- Laravel's fluent surface (every setter returns the mailable) ----
  subject(value) {
    this.__subject = value == null ? null : String(value);
    return this;
  }
  view(name, data) {
    this.__view = String(name);
    if (data && typeof data === 'object') {
      this.__viewData = Object.assign({}, this.__viewData || {}, data);
    }
    return this;
  }
  with(data) {
    if (data && typeof data === 'object') {
      this.__viewData = Object.assign({}, this.__viewData || {}, data);
    }
    return this;
  }
  from(address, name) {
    this.__from = appendAddress(this.__from || this.from || [], address, name);
    return this;
  }
  to(address, name) {
    this.__to = appendAddress(this.__to || this.to || [], address, name);
    return this;
  }
  cc(address, name) {
    this.__cc = appendAddress(this.__cc || this.cc || [], address, name);
    return this;
  }
  bcc(address, name) {
    this.__bcc = appendAddress(this.__bcc || this.bcc || [], address, name);
    return this;
  }
  replyTo(address, name) {
    this.__replyTo = appendAddress(this.__replyTo || this.replyTo || [], address, name);
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
  // Laravel: Mailable::send() calls build() first (the envelope + the view).
  async __lwMail(rt) {
    const r = rt || this.__rt || null;
    if (typeof this.build === 'function') await this.build(r);
    const subject = this.__subject !== undefined ? this.__subject : this.subject;
    const view = this.__view !== undefined ? this.__view : this.view;
    const viewData = this.__viewData !== undefined ? this.__viewData : this.viewData;
    const from = this.__from !== undefined ? this.__from : this.from;
    const to = this.__to !== undefined ? this.__to : this.to;
    const cc = this.__cc !== undefined ? this.__cc : this.cc;
    const bcc = this.__bcc !== undefined ? this.__bcc : this.bcc;
    const replyTo = this.__replyTo !== undefined ? this.__replyTo : this.replyTo;
    // The app may set the public field (`public $html`) or call the setter
    // (`$this->html(...)`) - a prototype method is never the value.
    const publicHtml = typeof this.html === 'function' ? undefined : this.html;
    const publicText = typeof this.text === 'function' ? undefined : this.text;
    let html = this.__html !== undefined ? this.__html : publicHtml;
    if (html == null && view) {
      // Laravel's buildViewData(): the mailable's PUBLIC properties merged with
      // the with() data (the with() data wins).
      const data = Object.assign({}, publicProperties(this), viewData || {});
      const rendered = r ? r.view(view, data) : null;
      // The runtime's view() answers a response; the mail's html is its body.
      // Laravel's View::render() does NOT trim the output, so the raw body is
      // used here (the response path trims - that is Laravel's HTTP path).
      html = rendered && rendered.body !== undefined ? String(rendered.body) : '';
    }
    return {
      from: from && from.length ? from[0] : null,
      to: to || [],
      cc: cc || [],
      bcc: bcc || [],
      replyTo: replyTo || [],
      subject: subject == null ? null : String(subject),
      html: html == null ? null : String(html),
      text: this.__text !== undefined ? this.__text : publicText == null ? null : String(publicText),
    };
  }
}

// Laravel's Mailable::setAddress() APPENDS the recipient and the list is
// deduped by address (the LAST occurrence wins).
function appendAddress(list, address, name) {
  const out = Array.isArray(list) ? list.slice() : [];
  const addr = { address: String(address), name: name == null ? null : String(name) };
  const at = out.findIndex((a) => a && a.address === addr.address);
  if (at >= 0) out[at] = addr;
  else out.push(addr);
  return out;
}

// The mailable's PUBLIC properties (Laravel's buildViewData()).
function publicProperties(mailable) {
  const out = {};
  for (const key of Object.keys(mailable)) {
    if (key.startsWith('__')) continue;
    if (['viewData', 'view', 'textView', 'subject', 'from', 'to', 'cc', 'bcc', 'replyTo', 'html', 'text', 'build'].includes(key)) continue;
    out[key] = mailable[key];
  }
  return out;
}

export default Mailable;
