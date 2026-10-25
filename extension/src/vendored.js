'use strict';
// The packages the webview loads off jsDelivr, pinned. One list, read by three places that
// must agree: vendor.mjs downloads exactly these, proxy.js's unsecreted /npm route serves
// nothing else, and panel.js's CSP names nothing else. A version bumped in one of them
// and not the others fails closed — a refused import — rather than quietly widening what
// the page may run.
const VENDORED = [
  { name: 'sql.js', version: '1.13.0' },
  { name: 'marked', version: '18.0.7' },
  { name: 'dompurify', version: '3.4.12' },
];

// `/npm/<name>@<version>/` — the path prefix every file of a vendored package lives under.
const VENDORED_PREFIXES = VENDORED.map(p => `/npm/${p.name}@${p.version}/`);

module.exports = { VENDORED, VENDORED_PREFIXES };
