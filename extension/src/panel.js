'use strict';
// =============================================================================
// panel.js — the webview that hosts the app
// =============================================================================
// site/index.html is loaded as-is, not forked. Only three things are done to it, all in
// html.js: asset paths become webview URIs, config.js is replaced by an injected object
// (that is the whole adapter — `auth: 'none'` plus the proxy's two origins), and a CSP is
// added. Everything else — app.js, data.js, paths.js, the .bim view, the Stats card — is
// the same code the web app runs, which is the point of the exercise.
// =============================================================================

const vscode = require('vscode');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { rewriteHtml } = require('./html');

// A webview is a sandboxed iframe with no CSP of its own, so this is the only thing
// between the page and the network.
//   'unsafe-eval'    — WebAssembly.instantiate is refused without it. `wasm-unsafe-eval`
//                      alone does NOT work in a VS Code webview.
//   worker-src blob: — DuckDB builds its worker from a Blob that importScripts the CDN.
//   connect-src      — the proxy, jsDelivr (duckdb-wasm, and marked/dompurify which the
//                      doc view lazy-loads), and the DuckDB extension repository.
function csp(webview, nonce, proxyOrigin) {
  return [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}' 'unsafe-eval' https://cdn.jsdelivr.net`,
    `worker-src blob:`,
    `connect-src ${proxyOrigin} https://cdn.jsdelivr.net https://extensions.duckdb.org`,
  ].join('; ');
}

// Packaged, site/ is copied inside the extension by copy-site.mjs. Under F5 from a
// checkout that copy does not exist yet, so fall back to the repo's own site/ — which
// also means an edit to the web app shows up in the panel on reload, with no build step.
async function siteRoot(extensionUri) {
  const packaged = vscode.Uri.joinPath(extensionUri, 'site');
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(packaged, 'index.html'));
    return packaged;
  } catch (_) {
    return vscode.Uri.joinPath(extensionUri, '..', 'site');
  }
}

async function buildHtml(webview, siteUri, cfg, proxyOrigin) {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(siteUri, 'index.html'));
  const nonce = crypto.randomBytes(16).toString('base64');
  return rewriteHtml(new TextDecoder('utf-8').decode(bytes), {
    assetUrl: name => webview.asWebviewUri(vscode.Uri.joinPath(siteUri, name)).toString(),
    nonce,
    config: cfg,
    cspContent: csp(webview, nonce, proxyOrigin),
  });
}

// One panel; invoking the command again reveals it rather than booting a second DuckDB.
let current = null;

async function openPanel(context, proxy) {
  if (current) { current.reveal(vscode.ViewColumn.Active); return current; }

  const siteUri = await siteRoot(context.extensionUri);
  const panel = vscode.window.createWebviewPanel(
    'onelakeStudio', 'OneLake Studio', vscode.ViewColumn.Active, {
      enableScripts: true,
      // DuckDB spends real time and network booting; tearing it down whenever the tab
      // loses focus would make the extension feel broken.
      retainContextWhenHidden: true,
      localResourceRoots: [siteUri],
    });

  try {
    panel.webview.html = await buildHtml(panel.webview, siteUri, {
      // The proxy attaches the bearer token, so the page needs no credential of its own
      // and never holds one — strictly better than the browser build, where it does.
      auth: 'none',
      dfsOrigin: proxy.dfsOrigin,
      tableOrigin: proxy.tableOrigin,
    }, `http://127.0.0.1:${proxy.port}`);
  } catch (e) {
    panel.dispose();
    throw e;
  }

  panel.onDidDispose(() => { current = null; }, null, context.subscriptions);
  current = panel;
  return panel;
}

// Disposing the panel is how switching account takes effect: the engine's resolved-metadata
// and manifest caches, and Cache Storage, all live in the webview, so the old identity's data
// goes with it. Rebinding the token alone would leave the previous account's tables on screen.
function closePanel() {
  if (current) current.dispose();   // onDidDispose nulls `current`
}

module.exports = { openPanel, closePanel };
