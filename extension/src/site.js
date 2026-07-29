'use strict';
// =============================================================================
// site.js — where the web app's files are, packaged or from a checkout
// =============================================================================
// copy-site.mjs puts site/ (and the README the landing query reads) inside the extension
// before packaging. Under F5 from a checkout that copy does not exist, so both fall back
// to the repo — which is also what makes an edit to the web app show up in the panel on
// reload with no build step. The panel needs URIs for the webview; the catalog needs a
// plain path to import paths.js from. One answer, resolved once, for both.
// =============================================================================

const vscode = require('vscode');

let resolved = null;

async function siteRoot(extensionUri) {
  if (resolved) return resolved;
  const packaged = vscode.Uri.joinPath(extensionUri, 'site');
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(packaged, 'index.html'));
    resolved = { site: packaged, readme: vscode.Uri.joinPath(packaged, 'README.md') };
  } catch (_) {
    resolved = {
      site: vscode.Uri.joinPath(extensionUri, '..', 'site'),
      readme: vscode.Uri.joinPath(extensionUri, '..', 'README.md'),
    };
  }
  return resolved;
}

module.exports = { siteRoot };
