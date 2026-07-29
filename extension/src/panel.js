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
const { siteRoot } = require('./site');

// A webview is a sandboxed iframe with no CSP of its own, so this is the only thing
// between the page and the network.
//   'unsafe-eval'    — WebAssembly.instantiate is refused without it. `wasm-unsafe-eval`
//                      alone does NOT work in a VS Code webview.
//   worker-src blob: — DuckDB builds its worker from a Blob that importScripts the CDN.
//   connect-src      — the proxy, jsDelivr (duckdb-wasm, and marked/dompurify which the
//                      doc view lazy-loads), the DuckDB extension repository, and
//                      cspSource, which is how DuckDB reads the packaged README that the
//                      landing query renders.
function csp(webview, nonce, proxyOrigin) {
  return [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}' 'unsafe-eval' https://cdn.jsdelivr.net`,
    `worker-src blob:`,
    `connect-src ${webview.cspSource} ${proxyOrigin} https://cdn.jsdelivr.net https://extensions.duckdb.org`,
  ].join('; ');
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

// The page cannot be told to open a table until it exists, and it does not exist for
// several seconds — DuckDB is a wasm bundle plus four extensions off a CDN. A click in the
// tree that lands in that window must not be dropped, so it waits here until app.js says
// it is listening. Only the last one is kept: they are all "show me this", and replaying a
// queue of them would open four tables in a row to arrive where one click asked for.
let pending = null;
let ready = false;

function postToPanel(msg) {
  if (current && ready) current.webview.postMessage(msg);
  else pending = msg;
}

async function openPanel(context, proxy) {
  if (current) { current.reveal(vscode.ViewColumn.Active); return current; }

  const { site: siteUri, readme: readmeUri } = await siteRoot(context.extensionUri);
  const panel = vscode.window.createWebviewPanel(
    'onelakeStudio', 'OneLake Studio', vscode.ViewColumn.Active, {
      enableScripts: true,
      // DuckDB spends real time and network booting; tearing it down whenever the tab
      // loses focus would make the extension feel broken.
      retainContextWhenHidden: true,
      // The README's directory is the site directory when packaged, and the repo root
      // under F5 — listing both costs nothing and keeps the fallback readable.
      localResourceRoots: [siteUri, vscode.Uri.joinPath(readmeUri, '..')],
    });

  try {
    panel.webview.html = await buildHtml(panel.webview, siteUri, {
      // The proxy attaches the bearer token, so the page needs no credential of its own
      // and never holds one — strictly better than the browser build, where it does.
      auth: 'none',
      // Everything the app does differently in here hangs off this one word.
      host: 'vscode',
      dfsOrigin: proxy.dfsOrigin,
      tableOrigin: proxy.tableOrigin,
      // The landing query reads this instead of raw.githubusercontent.com, which the CSP
      // above has no business allowing. It also documents the version that is installed
      // rather than whatever is on main.
      readmeUrl: panel.webview.asWebviewUri(readmeUri).toString(),
    }, `http://127.0.0.1:${proxy.port}`);
  } catch (e) {
    panel.dispose();
    throw e;
  }

  panel.webview.onDidReceiveMessage(msg => {
    if (!msg || msg.type !== 'ready') return;
    ready = true;
    if (pending) { panel.webview.postMessage(pending); pending = null; }
  }, null, context.subscriptions);

  panel.onDidDispose(() => { current = null; ready = false; }, null, context.subscriptions);
  current = panel;
  return panel;
}

// Disposing the panel is how switching account takes effect: the engine's resolved-metadata
// and manifest caches, and Cache Storage, all live in the webview, so the old identity's data
// goes with it. Rebinding the token alone would leave the previous account's tables on screen.
function closePanel() {
  pending = null;
  if (current) current.dispose();   // onDidDispose nulls `current` and clears `ready`
}

module.exports = { openPanel, closePanel, postToPanel };
