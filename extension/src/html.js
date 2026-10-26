'use strict';
// =============================================================================
// html.js — the panel's page, filled in
// =============================================================================
// app/index.html is the extension's own template with four placeholders:
//
//   {{base}}    the webview URI of the page's directory (scripts, stylesheets)
//   {{nonce}}   the CSP nonce on the two script tags
//   {{csp}}     the Content-Security-Policy, in the page's own <meta>
//   {{config}}  the injected config object, as JSON
//
// Pure string work, clear of the `vscode` module so it is unit tested against the real
// template. A placeholder the template lost is an error, not a page that comes up blank.
// =============================================================================

const PLACEHOLDERS = ['base', 'nonce', 'csp', 'config'];

const attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function renderPage(template, { base, nonce, csp, config }) {
  for (const p of PLACEHOLDERS) {
    if (!template.includes(`{{${p}}}`)) throw new Error(`panel template has no {{${p}}}`);
  }
  // `<` is escaped so no config value can ever close the script tag from inside the JSON.
  const json = JSON.stringify(config || {}).replace(/</g, '\\u003c');
  const values = { base: String(base).replace(/\/+$/, ''), nonce: attr(nonce), csp: attr(csp), config: json };
  // A function replacer: `$&` or `$'` in a value (a README path is user-shaped) must not
  // be expanded by replace().
  return template.replace(/\{\{(base|nonce|csp|config)\}\}/g, (_, k) => values[k]);
}

module.exports = { renderPage };
