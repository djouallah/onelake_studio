// =============================================================================
// docview.js — turn a document result into HTML for the Pretty view.
//
// Three renderers behind one tab, chosen by paths.js docKind():
//   json     -> re-indented and escaped into a <pre>
//   text     -> escaped into a <pre>, byte for byte
//   markdown -> marked + DOMPurify
//
// Only the markdown branch needs the parser, so both libraries are imported on the first
// markdown render — a .sql macro or a JSON blob renders with nothing loaded at all. They
// ship inside the extension (cdn.js).
// =============================================================================
import { docKind, escapeHtml } from './paths.js';
import { PINS, npmEsm } from './cdn.js';

let _md = null;   // { marked, purify } once loaded

export async function renderMarkdown(text) {
  if (!_md) {
    const [m, d] = await Promise.all([import(npmEsm(PINS.marked)), import(npmEsm(PINS.dompurify))]);
    const purify = (d.default || d)(window);
    // read_text() renders files the user did not author, and this page holds
    // OneLake tokens — marked's output is never inserted unsanitized, and no
    // rendered link ever gets an opener back into this window.
    purify.addHook('afterSanitizeAttributes', node => {
      // Only an image carried in the document itself can be drawn: a relative one (the
      // README's screenshot) has nothing to resolve against in this page, which has no
      // <base>, and the panel's CSP (img-src, src/panel.js) blocks a remote one. Either
      // is hidden rather than drawn as a broken icon.
      if (node.tagName === 'IMG' && !/^(data|blob):/i.test(node.getAttribute('src') || '')) {
        node.setAttribute('hidden', '');
      }
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

// Returns { html, kind } — the kind is what the tab reports it did, so "Pretty"
// never has to be taken on faith. `ext` is the source file's extension when there is one;
// see docKind for why a .yml cannot be told from markdown without it.
export async function renderDocument(text, ext = '') {
  const kind = docKind(text, ext);
  if (kind === 'json')
    return { kind, html: `<pre class="doc">${escapeHtml(JSON.stringify(JSON.parse(String(text).trim()), null, 2))}</pre>` };
  if (kind === 'text')
    return { kind, html: `<pre class="doc">${escapeHtml(text)}</pre>` };
  return { kind, html: await renderMarkdown(text) };
}
