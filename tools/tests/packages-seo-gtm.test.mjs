// tools/tests/packages-seo-gtm.test.mjs — unit tests for the SEO meta builder
// and the Google Tag Manager injection helpers.
//
// Run: node --test tools/tests/packages-seo-gtm.test.mjs
//
// No network, no DOM: both modules are pure HTML/JS string builders. The
// assertions check the exact tag shapes (names, properties, content) plus the
// escaping of hostile input (`</script>`, quotes, angle brackets) so neither
// builder can be turned into an HTML/JS injection vector.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SeoBuilder, seoMeta } from '../../kernel/packages/seo.mjs';
import { gtmScript, gtmDataLayer, gtmNoScript } from '../../kernel/packages/gtm.mjs';

test('SeoBuilder: empty builder generates an empty string', () => {
  const html = new SeoBuilder().generate();
  assert.equal(html, '');
});

test('SeoBuilder: title, description, canonical and robots', () => {
  const html = new SeoBuilder()
    .title('My Page')
    .description('My description')
    .canonical('https://example.com/my-page')
    .robots('index,follow')
    .generate();

  assert.match(html, /<title>My Page<\/title>/);
  assert.match(html, /<meta name="description" content="My description">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/my-page">/);
  assert.match(html, /<meta name="robots" content="index,follow">/);
});

test('SeoBuilder: openGraph emits all standard OG tags', () => {
  const html = new SeoBuilder()
    .title('My Page')
    .openGraph({
      title: 'OG Title',
      description: 'OG Description',
      image: 'https://example.com/og.png',
      url: 'https://example.com/og',
      type: 'article',
    })
    .generate();

  assert.match(html, /<meta property="og:title" content="OG Title">/);
  assert.match(html, /<meta property="og:description" content="OG Description">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/example\.com\/og\.png">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/example\.com\/og">/);
  assert.match(html, /<meta property="og:type" content="article">/);
});

test('SeoBuilder: openGraph falls back to builder title/description', () => {
  const html = new SeoBuilder()
    .title('Builder Title')
    .description('Builder Desc')
    .openGraph({ url: 'https://example.com/x', type: 'website' })
    .generate();

  assert.match(html, /<meta property="og:title" content="Builder Title">/);
  assert.match(html, /<meta property="og:description" content="Builder Desc">/);
});

test('SeoBuilder: twitter defaults card to summary_large_image when og:image present', () => {
  const html = new SeoBuilder()
    .openGraph({ image: 'https://example.com/og.png' })
    .generate();

  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
});

test('SeoBuilder: twitter explicit card wins, no image → summary', () => {
  const html1 = new SeoBuilder().twitter({ card: 'summary' }).generate();
  assert.match(html1, /<meta name="twitter:card" content="summary">/);

  const html2 = new SeoBuilder()
    .twitter({ card: 'player', title: 'TW Title', description: 'TW Desc', image: 'https://example.com/tw.png' })
    .generate();
  assert.match(html2, /<meta name="twitter:card" content="player">/);
  assert.match(html2, /<meta name="twitter:title" content="TW Title">/);
  assert.match(html2, /<meta name="twitter:description" content="TW Desc">/);
  assert.match(html2, /<meta name="twitter:image" content="https:\/\/example\.com\/tw\.png">/);
});

test('SeoBuilder: twitter without card defaults to summary_large_image when image given', () => {
  const html = new SeoBuilder()
    .twitter({ image: 'https://example.com/tw.png' })
    .generate();
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
});

test('SeoBuilder: jsonLd serialises object and emits ld+json script', () => {
  const html = new SeoBuilder()
    .jsonLd({ '@context': 'https://schema.org', '@type': 'Article', headline: 'Hello' })
    .generate();

  assert.match(html, /<script type="application\/ld\+json">/);
  // JSON-LD payload is raw JSON (script bodies are not HTML-escaped).
  assert.match(html, /"@type":"Article"/);
  assert.match(html, /<\/script>/);
});

test('SeoBuilder: jsonLd escapes </script> inside JSON payload', () => {
  const payload = JSON.stringify({ description: '</script><script>alert(1)</script>' });
  const html = new SeoBuilder().jsonLd(payload).generate();

  // The raw `</script>` from the payload must not appear unescaped.
  assert.ok(!html.includes('</script><script>alert(1)'), 'raw </script> must be escaped');
  // The opening `<script>alert(1)` stays raw (only `</script` is escaped).
  assert.match(html, /<script>alert\(1\)/);
  // After unescaping the ld+json block, JSON.parse still yields the original.
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  const block = m.exec(html)[1];
  const restored = JSON.parse(block);
  assert.equal(restored.description, '</script><script>alert(1)</script>');
});

test('SeoBuilder: multiple jsonLd blocks are emitted in order', () => {
  const html = new SeoBuilder()
    .jsonLd({ '@type': 'Article' })
    .jsonLd({ '@type': 'BreadcrumbList' })
    .generate();

  const articleIdx = html.indexOf('Article');
  const crumbIdx = html.indexOf('BreadcrumbList');
  assert.ok(articleIdx !== -1 && crumbIdx !== -1);
  assert.ok(articleIdx < crumbIdx);
});

test('SeoBuilder: HTML-escapes hostile title/description', () => {
  const html = new SeoBuilder()
    .title('<script>"onmouseover="alert(1)</script>')
    .description('"quoted" <b>bold</b> & ampersand')
    .generate();

  // No raw angle bracket or quote can break out.
  assert.ok(!html.includes('<script>"onmouseover'), 'raw script tag must be escaped');
  assert.match(html, /<title>&lt;script&gt;/);
  assert.match(html, /content="&quot;quoted&quot; &lt;b&gt;bold&lt;\/b&gt; &amp; ampersand">/);
});

test('SeoBuilder: no duplicate description when set twice', () => {
  const html = new SeoBuilder()
    .description('A')
    .description('B')
    .openGraph({ description: 'C' })
    .generate();

  // Last call wins for the generic description; og.description overrides it
  // for og:description.
  const count = (html.match(/name="description"/g) || []).length;
  assert.equal(count, 1);
  assert.match(html, /<meta name="description" content="B">/);
  assert.match(html, /<meta property="og:description" content="C">/);
});

test('seoMeta: one-shot helper builds everything', () => {
  const html = seoMeta({
    title: 'Hello',
    description: 'World',
    canonical: 'https://example.com/',
    openGraph: { image: 'https://example.com/og.png' },
    jsonLd: [{ '@type': 'WebSite' }],
  });
  assert.match(html, /<title>Hello<\/title>/);
  assert.match(html, /<meta name="description" content="World">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/">/);
  assert.match(html, /<meta property="og:image"/);
  assert.match(html, /<script type="application\/ld\+json">/);
});

// ── GTM ──────────────────────────────────────────────────────────────────────

test('gtmScript: emits the standard head snippet with the container id', () => {
  const html = gtmScript('GTM-ABC123');
  assert.match(html, /GTM-ABC123/);
  assert.match(html, /googletagmanager\.com\/gtm\.js\?id=/);
  assert.match(html, /window,document,'script','dataLayer','GTM-ABC123'/);
  assert.match(html, /j\.async=true/);
});

test('gtmScript: invalid container id produces empty string', () => {
  assert.equal(gtmScript(''), '');
  assert.equal(gtmScript(undefined), '');
  assert.equal(gtmScript(null), '');
});

test('gtmDataLayer: pushes string event and object payload', () => {
  const html = gtmDataLayer(['ecommerce_purchase', { transaction_id: '1234', value: 99.95 }]);
  assert.match(html, /window\.dataLayer = window\.dataLayer \|\| \[\];/);
  assert.match(html, /window\.dataLayer\.push\(/);
  assert.match(html, /'ecommerce_purchase'/);
  assert.match(html, /"transaction_id":"1234"/);
});

test('gtmDataLayer: accepts a non-array argument', () => {
  const html = gtmDataLayer({ event: 'page_view' });
  assert.match(html, /window\.dataLayer\.push\(\{"event":"page_view"\}\)/);
});

test('gtmNoScript: emits the noscript iframe with the container id', () => {
  const html = gtmNoScript('GTM-ABC123');
  assert.match(html, /<noscript>/);
  assert.match(html, /<iframe src="https:\/\/www\.googletagmanager\.com\/ns\.html\?id=GTM-ABC123"/);
  assert.match(html, /display:none;visibility:hidden/);
  assert.match(html, /<\/noscript>/);
});

test('gtmNoScript: invalid container id produces empty string', () => {
  assert.equal(gtmNoScript(''), '');
  assert.equal(gtmNoScript(undefined), '');
});

test('GTM ids containing hostile characters are sanitised', () => {
  // gtmId values are not user-typable in practice, but the helpers must not
  // forward them verbatim into an attribute or JS literal.
  const s = gtmScript('GTM-ABC" onmouseover="alert(1)');
  assert.ok(!s.includes('"onmouseover'), 'hostile quote in gtm id must be stripped');
  const n = gtmNoScript('GTM-ABC"><script>');
  assert.ok(!n.includes('<script>'), 'hostile tag in gtm id must be stripped');
});
