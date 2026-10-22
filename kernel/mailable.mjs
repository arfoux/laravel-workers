// kernel/mailable.mjs — the Mailable base (Laravel's Illuminate\Mail\Mailable).
//
// The compiled mailable extends this: the class compiler emits the app's own
// methods (Laravel calls the mailable's own `build()` when it has one -
// Illuminate\Mail\Mailable: `if (method_exists($this, 'build')) { Container::getInstance()->call([$this, 'build']); }` -
// and the class's helpers)
// and this base provides Laravel's surface plus the payload the mailer sends.
//
// Laravel's Mailable declares PUBLIC fields (Illuminate\Mail\Mailable:
// `public $subject; public $from = []; public $to = []; public $cc = [];
// public $bcc = []; public $replyTo = []; public $view; public $textView;
// public $viewData = [];`) AND fluent setters with the same names
// (`subject()`, `view()`, `with()`, ...). PHP keeps the field and the method
// apart; JavaScript does not - a field would shadow the method. So the base
// keeps its values in private fields (`__subject`, ...) and the payload reads
// the private value first, then the PUBLIC field - and the fallback is
// TYPE-CHECKED (a prototype method is not a value).
//
// The payload is Laravel's message shape: { from, to, cc, bcc, replyTo,
// subject, html, text }. The html (and the text) are the compiled views
// (the runtime renders them with the mailable's data - Laravel's
// buildViewData(): the PUBLIC properties merged with the with() data).
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
    this.__from = appendAddress(this.__from || publicList(this, 'from'), address, name);
    return this;
  }
  to(address, name) {
    this.__to = appendAddress(this.__to || publicList(this, 'to'), address, name);
    return this;
  }
  cc(address, name) {
    this.__cc = appendAddress(this.__cc || publicList(this, 'cc'), address, name);
    return this;
  }
  bcc(address, name) {
    this.__bcc = appendAddress(this.__bcc || publicList(this, 'bcc'), address, name);
    return this;
  }
  replyTo(address, name) {
    this.__replyTo = appendAddress(this.__replyTo || publicList(this, 'replyTo'), address, name);
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
    const subject = this.__subject !== undefined ? this.__subject : publicString(this, 'subject');
    const view = this.__view !== undefined ? this.__view : publicString(this, 'view');
    const textView = this.__textView !== undefined ? this.__textView : publicString(this, 'textView');
    const viewData = this.__viewData !== undefined ? this.__viewData : publicMap(this, 'viewData');
    const from = this.__from !== undefined ? this.__from : publicList(this, 'from');
    const to = this.__to !== undefined ? this.__to : publicList(this, 'to');
    const cc = this.__cc !== undefined ? this.__cc : publicList(this, 'cc');
    const bcc = this.__bcc !== undefined ? this.__bcc : publicList(this, 'bcc');
    const replyTo = this.__replyTo !== undefined ? this.__replyTo : publicList(this, 'replyTo');
    const html = this.__html !== undefined ? this.__html : publicString(this, 'html');
    const text = this.__text !== undefined ? this.__text : publicString(this, 'text');
    // Laravel: Mailable::buildView() answers `$this->view` when the mailable
    // has no html, no markdown and no views, and Mailer::render(null) throws
    // `InvalidArgumentException: Invalid view.` (probed with the vendored
    // framework). The edge used to send a mail with a null body instead - a
    // silent 200 where Laravel answers 500.
    if (html == null && !view && !textView) throw new Error('Invalid view.');
    // The views: Laravel renders the mailable's view (and its text twin).
    const data = Object.assign({}, publicProperties(this), viewData || {});
    let renderedHtml = html;
    if (renderedHtml == null && view) {
      // Laravel's View::render() returns the RAW output (the HTTP response path
      // trims - the mail does not).
      const rendered = r ? r.view(view, data, { raw: true }) : null;
      renderedHtml = rendered && rendered.body !== undefined ? String(rendered.body) : '';
    }
    let renderedText = text;
    if (renderedText == null && textView) {
      const rendered = r ? r.view(textView, data, { raw: true }) : null;
      renderedText = rendered && rendered.body !== undefined ? String(rendered.body) : '';
    }
    return {
      from: from && from.length ? from[0] : null,
      to: to || [],
      cc: cc || [],
      bcc: bcc || [],
      replyTo: replyTo || [],
      subject: subject == null ? null : String(subject),
      html: renderedHtml == null ? null : String(renderedHtml),
      text: renderedText == null ? null : String(renderedText),
    };
  }
}

// Laravel's Mailable::setAddress() APPENDS the recipient; the list is deduped
// by address and the LAST occurrence wins (at its own position).
function appendAddress(list, address, name) {
  const out = Array.isArray(list) ? list.slice() : [];
  const addr = { address: String(address), name: name == null ? null : String(name) };
  const at = out.findIndex((a) => a && a.address === addr.address);
  if (at >= 0) out[at] = addr;
  else out.push(addr);
  return out;
}

// The PUBLIC field of the mailable - type-checked (a prototype method is not a
// value).
function publicString(mailable, key) {
  const v = mailable[key];
  return typeof v === 'string' ? v : undefined;
}
function publicList(mailable, key) {
  const v = mailable[key];
  return Array.isArray(v) ? v : [];
}
function publicMap(mailable, key) {
  const v = mailable[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
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
