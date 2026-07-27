// =============================================================================
// docview.js — markdown -> sanitized HTML for the Pretty result view.
//
// Both dependencies are lazily imported from the CDN on the first pretty render,
// so a user who never queries a document never fetches them. Pinned ESM from
// jsDelivr, same pattern as sql.js (data.js) and msal (auth.js).
// =============================================================================
const MARKED_ESM = 'https://cdn.jsdelivr.net/npm/marked@18.0.7/+esm';
const DOMPURIFY_ESM = 'https://cdn.jsdelivr.net/npm/dompurify@3.4.12/+esm';

let _md = null;   // { marked, purify } once loaded

export async function renderMarkdown(text) {
  if (!_md) {
    const [m, d] = await Promise.all([import(MARKED_ESM), import(DOMPURIFY_ESM)]);
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
