// kernel/packages/seo.mjs — SEO meta builder for the edge. Mirrors the small
// subset of `artesaos/seotools` / `spatie/laravel-seo` that the edge actually
// needs: title, description, canonical, robots, Open Graph, Twitter cards and
// JSON-LD, all rendered to a single HTML meta string.
//
// All tag values — titles, attributes, URLs — go through the shared html
// escape (`e()`, kernel/str.mjs), so an attribute can never break out of its
// quotes. `jsonLd()` is passed through as-is (only escaped for `</script>`
// safety) because callers supply their own serialised JSON, e.g.
// `JSON.stringify(article)`.

import { escapeHtml } from '../str.mjs';

// Safe sequence for `</script>` inside JSON-LD so the JSON block cannot close
// the script tag early.
function escapeJsonLd(data) {
  return String(data).replaceAll('</script', '<\\/script');
}

// Render a `<meta name="..." content="...">` tag.
function meta(name, content) {
  if (content === undefined || content === null || content === '') return '';
  return `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">\n`;
}

// Render a `<meta property="..." content="...">` tag.
function property(prop, content) {
  if (content === undefined || content === null || content === '') return '';
  return `<meta property="${escapeHtml(prop)}" content="${escapeHtml(content)}">\n`;
}

// Render a `<link rel="..." href="...">` tag.
function link(rel, href) {
  if (!href) return '';
  return `<link rel="${escapeHtml(rel)}" href="${escapeHtml(href)}">\n`;
}

export class SeoBuilder {
  constructor() {
    this._title = '';
    this._description = '';
    this._canonical = '';
    this._robots = '';
    this._og = {};
    this._twitter = {};
    this._jsonLd = [];
  }

  // t: string — sets both <title> and og:title/twitter:title default.
  title(t) {
    if (t !== undefined && t !== null && String(t) !== '') this._title = String(t);
    return this;
  }

  description(d) {
    if (d !== undefined && d !== null && String(d) !== '') this._description = String(d);
    return this;
  }

  canonical(url) {
    if (url) this._canonical = url;
    return this;
  }

  // robots: single directive string, e.g. 'noindex,nofollow' or 'index,follow'.
  robots(value) {
    if (value) this._robots = String(value).trim();
    return this;
  }

  // og: object with any of {title, description, image, url, type, siteName}.
  // The other standard OG keys (locale, etc.) can be passed too — every key is
  // emitted as `<meta property="og:{key}" ...>`.
  openGraph(og) {
    if (og && typeof og === 'object') this._og = { ...this._og, ...og };
    return this;
  }

  // twitter: {card, title, description, image}. card defaults to 'summary_large_image'.
  twitter(tw) {
    if (tw && typeof tw === 'object') this._twitter = { ...this._twitter, ...tw };
    return this;
  }

  // jsonLd(data): data is already-serialised JSON (a string) or an object
  // which is JSON.stringify'd here. Multiple calls append multiple <script> blocks.
  jsonLd(data) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    if (payload !== undefined && payload !== null && payload !== '') {
      this._jsonLd.push(payload);
    }
    return this;
  }

  // generate() → single HTML string containing all emitted tags (newline-terminated).
  generate() {
    const seen = new Set();
    const lines = [];

    const once = (marker, line) => {
      if (seen.has(marker)) return;
      seen.add(marker);
      if (line !== '') lines.push(line);
    };

    // <title>
    once('title', this._title ? `<title>${escapeHtml(this._title)}</title>\n` : '');

    // Generic meta
    const description = this._description || this._og.description || '';
    once('description', meta('description', description));
    if (this._canonical) once('canonical', link('canonical', this._canonical));
    if (this._robots) once('robots', meta('robots', this._robots));

    // Open Graph — required keys first in a stable order, then any extras.
    const og = this._og;
    const ogOrder = ['type', 'title', 'description', 'url', 'image', 'site_name'];
    for (const key of ogOrder) {
      const value = og[key] ?? (key === 'title' ? this._title : key === 'description' ? description : undefined);
      if (value !== undefined && value !== null && String(value) !== '') {
        once(`og:${key}`, property(`og:${key}`, value));
      }
    }
    for (const key of Object.keys(og)) {
      if (!ogOrder.includes(key)) {
        const value = og[key];
        if (value !== undefined && value !== null && String(value) !== '') {
          once(`og:${key}`, property(`og:${key}`, value));
        }
      }
    }

    // Twitter cards.
    const tw = this._twitter;
    // Twitter cards are only emitted when there is something to render.
    const hasTwitterContent = tw.card || tw.image || tw.title || tw.description
      || this._og.image || this._og.description || this._title;
    if (hasTwitterContent) {
      const twCard = tw.card || (this._og.image || tw.image ? 'summary_large_image' : 'summary');
      once('twitter:card', meta('twitter:card', twCard));
    }
    once('twitter:title', meta('twitter:title', tw.title ?? this._title));
    once('twitter:description', meta('twitter:description', tw.description ?? description));
    if (tw.image) once('twitter:image', meta('twitter:image', tw.image));

    // JSON-LD
    for (const json of this._jsonLd) {
      lines.push(`<script type="application/ld+json">${escapeJsonLd(json)}</script>\n`);
    }

    return lines.filter((l) => l !== '').join('');
  }
}

// Convenience one-shot: build + generate in a single call.
export function seoMeta(options = {}) {
  const b = new SeoBuilder();
  if (options.title) b.title(options.title);
  if (options.description) b.description(options.description);
  if (options.canonical) b.canonical(options.canonical);
  if (options.robots) b.robots(options.robots);
  if (options.openGraph) b.openGraph(options.openGraph);
  if (options.twitter) b.twitter(options.twitter);
  if (options.jsonLd) {
    for (const item of Array.isArray(options.jsonLd) ? options.jsonLd : [options.jsonLd]) b.jsonLd(item);
  }
  return b.generate();
}
