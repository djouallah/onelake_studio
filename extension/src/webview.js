'use strict';
// =============================================================================
// webview.js — where the panel's page is, packaged or from a checkout
// =============================================================================
// extension/app/ is the panel's tracked source; stage-webview.mjs copies it, with the
// README and a build stamp, to extension/webview/ for packaging. An installed extension
// serves webview/; F5 from a checkout serves app/ and reads the repo's README.
// =============================================================================

const vscode = require('vscode');

let resolved = null;

async function webviewRoot(extensionUri, { dev = false } = {}) {
  if (resolved) return resolved;
  const packaged = vscode.Uri.joinPath(extensionUri, 'webview');
  const checkout = {
    page: vscode.Uri.joinPath(extensionUri, 'app'),
    readme: vscode.Uri.joinPath(extensionUri, '..', 'README.md'),
  };
  // Under F5 the tracked source wins even when a packaged copy exists: a local package
  // leaves extension/webview/ behind, and an F5 that silently served that snapshot would
  // run yesterday's page under yesterday's build stamp.
  if (dev) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(checkout.page, 'index.html'));
      return (resolved = checkout);
    } catch (_) {}
  }
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(packaged, 'index.html'));
    resolved = { page: packaged, readme: vscode.Uri.joinPath(packaged, 'README.md') };
  } catch (_) {
    resolved = checkout;
  }
  return resolved;
}

module.exports = { webviewRoot };
