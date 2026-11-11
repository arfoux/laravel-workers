// kernel/packages/html.mjs — tiny fluent HTML element builder (no D1, no DOM).
// Parity with a subset of Spatie's html-element helpers: enough to compose
// form controls and wrappers server-side without templating.
//
//   const el = html('input', { type: 'email', name: 'email' }).class('form-control');
//   el.render(); // <input type="email" name="email" class="form-control">
//
//   html('div', { class: 'wrap' })
//     .text('Hello')
//     .append(html('span').text('world'))
//     .render();
//   // <div class="wrap">Hello<span>world</span></div>
//
// Supported tags (self-closing set is enforced):
//   span, div, p, input, button, select, option, a, img

const VOID_TAGS = new Set(['input', 'img']);

const ALLOWED_TAGS = new Set([
  'span',
  'div',
  'p',
  'input',
  'button',
  'select',
  'option',
  'a',
  'img',
]);

export class HtmlElement {
  constructor(tag, attrs = {}) {
    if (!ALLOWED_TAGS.has(tag)) {
      throw new Error(`html: unsupported tag "${tag}"`);
    }
    this.tag = tag;
    this.attrs = { ...attrs };
    this.children = [];
    this.textContent = null;
  }

  // Add (or merge) CSS classes. Accepts a string or an array.
  class(...classes) {
    const flat = classes.flat().filter(Boolean);
    const existing = this.attrs.class ? String(this.attrs.class).split(/\s+/) : [];
    const merged = [...existing, ...flat].filter(Boolean);
    this.attrs.class = [...new Set(merged)].join(' ');
    return this;
  }

  // Set a single attribute.
  attr(name, value) {
    this.attrs[name] = value;
    return this;
  }

  // Set the element's own text (rendered before any child elements).
  text(str) {
    this.textContent = str;
    return this;
  }

  // Append a child element or raw string.
  append(child) {
    this.children.push(child);
    return this;
  }

  // Alias — matches the task signature `children`.
  children(...kids) {
    for (const k of kids) this.children.push(k);
    return this;
  }

  render() {
    const attrs = serializeAttrs(this.attrs);
    if (VOID_TAGS.has(this.tag)) {
      return `<${this.tag}${attrs}>`;
    }
    const inner = [];
    if (this.textContent !== null && this.textContent !== undefined) {
      inner.push(escapeHtml(this.textContent));
    }
    for (const child of this.children) {
      inner.push(typeof child === 'string' ? escapeHtml(child) : child.render());
    }
    return `<${this.tag}${attrs}>${inner.join('')}</${this.tag}>`;
  }
}

export function html(tag, attrs) {
  return new HtmlElement(tag, attrs || {});
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serializeAttrs(attrs) {
  let out = '';
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    out += v === true ? ` ${escapeHtml(k)}` : ` ${escapeHtml(k)}="${escapeHtml(v)}"`;
  }
  return out;
}

export default { HtmlElement, html };
