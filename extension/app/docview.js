// =============================================================================
// docview.js — turn a document result into HTML for the Pretty view.
//
// Three renderers behind one tab, chosen by paths.js docKind():
//   json     -> re-indented and escaped into a <pre>
//   text     -> escaped into a <pre>, byte for byte
//   markdown -> marked + DOMPurify
//
// Only the markdown branch needs the parser, so both dependencies are lazily imported
// from the CDN on the first markdown render — a .sql macro or a JSON blob renders with
// no network at all. Pinned ESM from jsDelivr, same pattern as sql.js (data.js) and
// msal (auth.js).
// =============================================================================
import { docKind, escapeHtml } from './paths.js';

// Routed through the extension's loopback proxy when its config names a cdnOrigin —
// same disk-cached boot path as duckdb itself in data.js, so the first markdown render
// of a session does not stall on a CDN fetch the webview cannot cache.
const CDN_ORIGIN = (typeof window !== 'undefined' &&
  (window.ONELAKE_STUDIO_CONFIG || {}).cdnOrigin) || '';
const withCdn = url => (CDN_ORIGIN ? url.replace(/^https:\/\//, CDN_ORIGIN + '/') : url);

const MARKED_ESM = 'https://cdn.jsdelivr.net/npm/marked@18.0.7/+esm';
const DOMPURIFY_ESM = 'https://cdn.jsdelivr.net/npm/dompurify@3.4.12/+esm';

let _md = null;   // { marked, purify } once loaded

// Proxied first, direct CDN if the route fails — a markdown render must degrade to
// slower, never to broken.
const importDoc = async url => {
  if (CDN_ORIGIN) {
    try { return await import(withCdn(url)); } catch (_) { /* fall through */ }
  }
  return import(url);
};

export async function renderMarkdown(text) {
  if (!_md) {
    const [m, d] = await Promise.all([importDoc(MARKED_ESM), importDoc(DOMPURIFY_ESM)]);
    const purify = (d.default || d)(window);
    // read_text() renders files the user did not author, and this page holds
    // OneLake tokens — marked's output is never inserted unsanitized, and no
    // rendered link ever gets an opener back into this window. Images stay
    // allowed on purpose: this is a docs viewer and README badges are the point;
    // the remote-fetch exposure is accepted.
    purify.addHook('afterSanitizeAttributes', node => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    _md = { marked: m.marked || m.default, purify };
  }
  const html = _md.marked.parse(String(text), { gfm: true, async: false });
  return _md.purify.sanitize(html);
}

// Returns { html, kind, mount? } — the kind is what the tab reports it did, so "Pretty"
// never has to be taken on faith. `ext` is the source file's extension when there is one;
// see docKind for why a .yml cannot be told from markdown without it. A renderer that
// needs the DOM after insertion (the .bim diagram measures cards to route its edges)
// also returns mount(el), which showDoc calls once the element is visible.
export async function renderDocument(text, ext = '') {
  // A .bim IS JSON, but re-indented JSON is not what a semantic model looks like —
  // bimview draws its tables and relationships instead. Anything that stops this
  // (parse failure, no tables) falls through to the plain JSON/text branches below.
  if (String(ext).toLowerCase().replace(/^\./, '').replace(/\.(gz|zst)$/, '') === 'bim') {
    try {
      const parsed = JSON.parse(String(text).trim());
      if (Array.isArray(parsed?.model?.tables) && parsed.model.tables.length) {
        const { renderBim } = await import('./bimview.js');
        return { kind: 'bim', ...renderBim(parsed) };
      }
    } catch (_) { /* not a parseable model after all */ }
  }
  const kind = docKind(text, ext);
  if (kind === 'json')
    return { kind, html: `<pre class="doc">${escapeHtml(JSON.stringify(JSON.parse(String(text).trim()), null, 2))}</pre>` };
  if (kind === 'text')
    return { kind, html: `<pre class="doc">${escapeHtml(text)}</pre>` };
  return { kind, html: await renderMarkdown(text) };
}
