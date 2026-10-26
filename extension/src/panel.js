'use strict';
// =============================================================================
// panel.js — the webview that hosts the app
// =============================================================================
// The page is a view and nothing else. It holds no credential, opens no connection and
// loads nothing from the network: every DuckDB statement and every OneLake read goes over
// one message channel to the host (host.js), and its few libraries ship inside the
// extension (vendor/, served as webview resources).
// =============================================================================

const vscode = require('vscode');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { rewriteHtml } = require('./html');
const { answer } = require('./host');
const { siteRoot } = require('./site');
const { PINS } = require('./vendored');

// A webview is a sandboxed iframe with no CSP of its own, so this is the only thing
// between the page and the network — and the page needs none. Its scripts are its own and
// the vendored libraries, both webview resources (cspSource); it connects to nothing.
// No 'unsafe-eval', no wasm, no worker: the engine is native in the host. A script in
// this page can send SQL to that engine, so a CDN — or any origin — that could put a
// script here would be a complete machine; there is none to put one.
function csp(webview, nonce) {
  return [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `connect-src ${webview.cspSource}`,
    // Neither is covered by default-src. A <base> would re-point every relative script
    // URL; a form could post page content anywhere.
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}

async function buildHtml(webview, siteUri, cfg) {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(siteUri, 'index.html'));
  const nonce = crypto.randomBytes(16).toString('base64');
  return rewriteHtml(new TextDecoder('utf-8').decode(bytes), {
    assetUrl: name => webview.asWebviewUri(vscode.Uri.joinPath(siteUri, name)).toString(),
    nonce,
    config: cfg,
    cspContent: csp(webview, nonce),
  });
}

// One panel; invoking the command again reveals it rather than booting a second DuckDB.
let current = null;

// The page cannot be told to open a table until it exists and its engine is up — on a
// first run that includes DuckDB loading its extensions. A click in the tree that lands in
// that window must not be dropped, so it waits here until app.js says it is listening.
// Only the last one is kept: they are all "show me this", and replaying a
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

// The page's one channel to the host (host.js): DuckDB statements and OneLake reads,
// answered here. postMessage THROWS once the panel is disposed, and a call can settle after
// exactly that — a query still streaming when the tab is closed. Nobody is listening; the
// result is simply dropped rather than becoming an unhandled rejection.
function wireEngine(panel, engine, methods = {}) {
  const post = msg => { try { panel.webview.postMessage(msg); } catch (_) {} };
  return msg => answer({ methods, engine }, msg, post);
}

// Single-flight: two near-simultaneous opens (a tree click racing the Open command) must
// not create two panels — the check on `current` alone has an await between it and the
// assignment, and the loser of that race was orphaned holding an engine bridge forever.
let opening = null;

function openPanel(context, opts = {}) {
  if (current) { current.reveal(vscode.ViewColumn.Active); return Promise.resolve(current); }
  if (!opening) {
    opening = openPanelUncontended(context, opts).finally(() => { opening = null; });
  }
  return opening;
}

async function openPanelUncontended(context, { onOpened, onBoot, onBootFailed, engine, host } = {}) {
  const { site: siteUri, readme: readmeUri } = await siteRoot(context.extensionUri,
    { dev: context.extensionMode === vscode.ExtensionMode.Development });
  const vendorUri = vscode.Uri.joinPath(context.extensionUri, 'vendor');
  const panel = vscode.window.createWebviewPanel(
    'onelakeStudio', 'OneLake Studio', vscode.ViewColumn.Active, {
      enableScripts: true,
      // DuckDB spends real time and network booting; tearing it down whenever the tab
      // loses focus would make the extension feel broken.
      retainContextWhenHidden: true,
      // The page, and the vendored libraries it imports. Nothing else on disk.
      localResourceRoots: [siteUri, vendorUri],
    });
  // The activity bar already has this icon; the editor tab was getting the generic one.
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'onelake.svg');

  try {
    panel.webview.html = await buildHtml(panel.webview, siteUri, {
      // The host reads OneLake for the page, which holds no credential of its own.
      auth: 'none',
      // Everything the app does differently in here hangs off this one word.
      host: 'vscode',
      // Where the vendored libraries are (cdn.js builds every URL from it), and which
      // versions — src/vendored.js, the same list vendor.mjs shipped.
      vendorBase: panel.webview.asWebviewUri(vendorUri).toString(),
      pins: PINS,
      // The landing query reads the packaged README. A filesystem path, not a webview
      // URI: the query runs in the host, where DuckDB is, and the engine's lockdown lets
      // it read exactly this file.
      readmeUrl: readmeUri.fsPath,
    });
  } catch (e) {
    panel.dispose();
    throw e;
  }

  const onEngineCall = engine ? wireEngine(panel, engine, host) : null;
  // The panel's own listeners die with the panel. Pushed onto context.subscriptions they
  // piled up — one more pair per panel ever opened in the window.
  const disposables = [];

  panel.webview.onDidReceiveMessage(msg => {
    if (!msg) return;
    if (msg.type === 'engine-call') {
      if (onEngineCall) onEngineCall(msg);
      else panel.webview.postMessage({ type: 'engine-error', id: msg.id,
        message: 'the native engine is not available in this build' });
    } else if (msg.type === 'ready') {
      ready = true;
      if (pending) { panel.webview.postMessage(pending); pending = null; }
    } else if (msg.type === 'boot-failed') {
      // The engine did not come up, so `ready` never will — a click parked in `pending`
      // is not going to be delivered, and holding it silently was this failure's old
      // shape: a spinner that never moves and a message that never comes.
      pending = null;
      if (onBootFailed) onBootFailed(String(msg.message || 'the engine failed to start'));
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
  }, null, disposables);

  panel.onDidDispose(() => {
    current = null; ready = false;
    // A query still scanning for a tab that no longer exists is pure cost — CPU, and a
    // OneLake read that nobody will see.
    if (engine) engine.call('cancel').catch(() => {});
    for (const d of disposables.splice(0)) { try { d.dispose(); } catch (_) {} }
  }, null, disposables);
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

// The panel already on screen, brought forward — and nothing else. A tree click on a
// second table used to repeat the whole open: an account-provider RPC, the README lookup,
// the engine check. None of it can have changed while the panel lives (a sign-out or an
// account switch closes it), so a click on a live panel is a reveal and a message.
function revealPanel() {
  if (!current) return false;
  current.reveal(vscode.ViewColumn.Active);
  return true;
}

module.exports = { openPanel, closePanel, revealPanel, postToPanel, postLive };
