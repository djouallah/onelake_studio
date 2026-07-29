'use strict';
// =============================================================================
// site.js — where the extension's copy of the app is, packaged or from a checkout
// =============================================================================
// extension/app/ is the extension's OWN, TRACKED copy of the web app — forked from
// site/ at the user's explicit instruction: site/ is the deployed website and extension
// work must never touch it. Changes for the panel land in app/ only; the website ports
// them when its owner chooses. copy-site.mjs turns app/ into the packaged site/
// artifact (stamped version.js, README for the landing query) at build time.
//
// The panel needs URIs for the webview; the catalog needs a plain path to import
// paths.js from. One answer, resolved once, for both.
// =============================================================================

const vscode = require('vscode');

let resolved = null;

async function siteRoot(extensionUri, { dev = false } = {}) {
  if (resolved) return resolved;
  const packaged = vscode.Uri.joinPath(extensionUri, 'site');
  const checkout = {
    site: vscode.Uri.joinPath(extensionUri, 'app'),
    readme: vscode.Uri.joinPath(extensionUri, '..', 'README.md'),
  };
  // Under F5 the tracked source wins even when a packaged copy exists: copy-site.mjs
  // leaves extension/site/ behind after a local package, and an F5 that silently served
  // that snapshot would run yesterday's app — wearing yesterday's build stamp, which is
  // the one lie the stamp exists to prevent. Dev serves app/ (stamped "dev"); an
  // installed build has no checkout to prefer.
  if (dev) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(checkout.site, 'index.html'));
      return (resolved = checkout);
    } catch (_) {}
  }
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(packaged, 'index.html'));
    resolved = { site: packaged, readme: vscode.Uri.joinPath(packaged, 'README.md') };
  } catch (_) {
    resolved = checkout;
  }
  return resolved;
}

module.exports = { siteRoot };
