// kernel/packages/gtm.mjs — Google Tag Manager injection helpers for the edge.
// This is the edge-rendered equivalent of the two snippets Google documents
// for GTM-XXXXXX: a JS loader + `dataLayer.push()` for the head and a
// <noscript> iframe for right after <body>. No network is performed here —
// these are pure HTML/JS string builders the caller can inline into a page
// shell or a Blade-rendered partial served by the Worker.

// Escape the GTM container id so a stray value can't break out of an attribute
// or a JS string literal. GTM ids are ASCII letters + digits, but we don't
// trust our callers.
function safeGtmId(gtmId) {
  return String(gtmId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
}

// gtmScript('GTM-XXXXXX') → the standard head snippet. The inline JS uses a
// dataLayer bootstrap, sets `gtm.js` and triggers the iframe loader when
// document.scripts is available (skips it in a service worker — there is no
// DOM there, so the loader would throw).
export function gtmScript(gtmId) {
  const id = safeGtmId(gtmId);
  if (!id) return '';
  return `<!-- Google Tag Manager -->\n<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${id}');</script>\n<!-- End Google Tag Manager -->\n`;
}

// gtmDataLayer(['event', {…}]) or gtmDataLayer([{…}]) → an inline <script>
// that pushes the given data onto the existing (or newly-created) dataLayer
// array. Callers pass an array of `push()` arguments, e.g.
//   gtmDataLayer(['ecommerce_purchase', { transaction_id: '1234' }])
export function gtmDataLayer(dataLayer) {
  const args = Array.isArray(dataLayer) ? dataLayer : [dataLayer];
  const entries = args
    .map((arg) => (typeof arg === 'string' ? `'${arg.replace(/'/g, "\\'")}'` : JSON.stringify(arg)))
    .join(',\n  ');
  return `<script>\nwindow.dataLayer = window.dataLayer || [];\nwindow.dataLayer.push(${entries});\n</script>\n`;
}

// gtmNoScript('GTM-XXXXXX') → the noscript fallback iframe. Google requires
// this to be the first element inside <body>; placement is the caller's job.
export function gtmNoScript(gtmId) {
  const id = safeGtmId(gtmId);
  if (!id) return '';
  return `<!-- Google Tag Manager (noscript) -->\n<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${id}"\nheight="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>\n<!-- End Google Tag Manager (noscript) -->\n`;
}
