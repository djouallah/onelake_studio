'use strict';
// =============================================================================
// html.js — turning site/index.html into webview HTML
// =============================================================================
// Pure string work, deliberately kept clear of the `vscode` module so it can be unit
// tested against the real site/index.html by `npm test`. That matters more than it
// looks: every step below is a regex against a file that belongs to the web app and
// changes without this extension in mind. A tag rename would not throw — the webview
// would just come up blank, or worse, come up working but reading the web app's own
// config and pointing DuckDB straight at OneLake with no token.
//
// So each rewrite reports whether it actually matched, and the caller refuses to build
// a page when one did not.
// =============================================================================

// Replaces <script src="config.js"> with an inline config object.
//
// Replaced rather than deleted: version.js and sw-register.js are classic scripts whose
// order relative to it the page relies on. And it must be replaced rather than left
// alone — config.js is the web app's own file, and letting it win would leave the page
// with the default OneLake origins, i.e. unsigned reads.
function injectConfig(html, nonce, config) {
  const re = /<script src="config\.js"><\/script>/;
  return {
    html: html.replace(re, `<script nonce="${nonce}">window.ONELAKE_STUDIO_CONFIG = ${JSON.stringify(config)};</script>`),
    ok: re.test(html),
  };
}

// Rewrites every local script src to a webview URI. app.js's own relative imports
// (./paths.js, ./data.js) resolve against its module URL, which lands in the same
// directory, so they need nothing.
function rewriteAssets(html, assetUrl) {
  let n = 0;
  const out = html.replace(/<script(\s[^>]*?)?\ssrc="(?!https?:)([^"]+)"/g, (m, attrs, src) => {
    n++;
    return `<script${attrs || ''} src="${assetUrl(src)}"`;
  });
  return { html: out, ok: n > 0, count: n };
}

// The preconnects name OneLake, which nothing in the webview talks to directly — the
// proxy does. `default-src 'none'` would refuse them and log an error per load.
function dropOneLakePreconnect(html) {
  return html.replace(/\s*<link rel="preconnect" href="https:\/\/onelake\.[^"]*"[^>]*>/g, '');
}

function addCsp(html, cspContent) {
  const re = /<\/head>/;
  return {
    html: html.replace(re, `  <meta http-equiv="Content-Security-Policy" content="${cspContent}" />\n</head>`),
    ok: re.test(html),
  };
}

// Throws rather than returning a broken page: a webview that loads the wrong config is
// worse than one that does not load, because it would read OneLake unsigned.
function rewriteHtml(html, { assetUrl, nonce, config, cspContent }) {
  const problems = [];

  const cfg = injectConfig(html, nonce, config);
  if (!cfg.ok) problems.push('no <script src="config.js"> to replace — the injected config would not win');

  const assets = rewriteAssets(cfg.html, assetUrl);
  if (!assets.ok) problems.push('no local <script src> tags found to rewrite');

  const csp = addCsp(dropOneLakePreconnect(assets.html), cspContent);
  if (!csp.ok) problems.push('no </head> to put the CSP in');

  if (problems.length) {
    throw new Error(`site/index.html is not the shape this extension expects: ${problems.join('; ')}`);
  }
  return csp.html;
}

module.exports = { rewriteHtml };
