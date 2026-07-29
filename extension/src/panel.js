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
//   worker-src blob: — DuckDB builds its worker from a Blob that importScripts the proxy.
//   script-src proxy — the engine boots THROUGH the proxy's /cdn route now (dynamic
//                      import of the duckdb module, the worker's importScripts): both are
//                      script loads. The CDN hosts stay listed as the fallback when the
//                      proxied fetch fails.
//   connect-src      — the proxy (data reads AND the wasm fetch inside the worker), the
//                      CDNs as fallback, and cspSource, which is how DuckDB reads the
//                      packaged README that the landing query renders.
function csp(webview, nonce, proxyOrigin) {
  return [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}' 'unsafe-eval' ${proxyOrigin} https://cdn.jsdelivr.net`,
    `worker-src blob:`,
    `connect-src ${webview.cspSource} ${proxyOrigin} https://cdn.jsdelivr.net https://extensions.duckdb.org https://community-extensions.duckdb.org`,
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

// For messages that describe the present rather than ask for something: read counts, cache
// state. Deliberately NOT buffered — `pending` holds exactly one message, so parking a
// stat there would throw away the click that is waiting to be delivered, and a stat
// replayed after a boot describes reads the user has long since stopped waiting for.
function postLive(msg) {
  if (current && ready) current.webview.postMessage(msg);
}

async function openPanel(context, proxy, { onOpened, onBoot } = {}) {
  if (current) { current.reveal(vscode.ViewColumn.Active); return current; }

  const { site: siteUri, readme: readmeUri } = await siteRoot(context.extensionUri,
    { dev: context.extensionMode === vscode.ExtensionMode.Development });
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
      // Boot bytes come off the disk cache through this: the wasm, the worker, the
      // extensions. Without it every panel open re-downloaded ~40MB before the first
      // click could do anything.
      cdnOrigin: proxy.cdnOrigin,
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
    if (!msg) return;
    if (msg.type === 'ready') {
      ready = true;
      if (pending) { panel.webview.postMessage(pending); pending = null; }
    } else if (msg.type === 'show-log') {
      // The read indicator in the panel's status bar is clickable, and this is what it
      // does: the breakdown it summarises lives in the output channel.
      vscode.commands.executeCommand('onelakeStudio.showLog');
    } else if (msg.type === 'boot' && onBoot) {
      // The engine timing itself. Its stages happen inside the webview and the worker,
      // where the proxy's log cannot see them — which is how a boot spending half a
      // minute compiling wasm produced a read log of nothing but 1ms hits.
      onBoot(msg);
    } else if (msg.type === 'opened' && onOpened) {
      // The page timed a click from arrival to rendered and is reporting the total —
      // the one number the per-read lines cannot add up to, because the wait includes
      // everything between the reads: the worker, the catalog, the rendering.
      onOpened(msg);
    }
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

module.exports = { openPanel, closePanel, postToPanel, postLive };
