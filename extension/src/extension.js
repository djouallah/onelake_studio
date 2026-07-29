'use strict';
// =============================================================================
// extension.js — activation, and the reason this extension exists
// =============================================================================
// The web app cannot sign a user in without them first registering an Entra SPA
// application in their own tenant, and there is no way around that in a browser:
// Entra only sends CORS headers for auth-code+PKCE against an `spa`-typed redirect
// URI, so device code flow is not available to a page either.
//
// In VS Code none of that applies. getSession('microsoft', …) goes through VS Code's
// own first-party application, which can impersonate for Azure resources — so the
// user signs in with the same prompt they already use for GitHub, and registers
// nothing. `offline_access` is what makes the session survive a reload; without it
// the refresh token is not issued and every restart is a fresh sign-in.
// =============================================================================

const vscode = require('vscode');
const { join } = require('node:path');
const { startProxy } = require('./proxy');
const { openPanel, closePanel, postToPanel, postLive } = require('./panel');
const { createCatalog } = require('./catalog');
const { LakehouseTree } = require('./tree');
const { siteRoot } = require('./site');

// The same scope site/auth.js asks MSAL for. OneLake accepts tokens in the storage
// audience only, and this one covers both the data reads and the Iceberg catalog.
const SCOPES = ['https://storage.azure.com/user_impersonation', 'offline_access'];

function scopesFor() {
  const tenant = vscode.workspace.getConfiguration('onelakeStudio').get('tenantId', '').trim();
  // A guest in someone else's tenant has to say so; the home tenant is the default.
  return tenant ? [...SCOPES, `VSCODE_TENANT:${tenant}`] : SCOPES;
}

// `options` is passed straight through: the command handler asks with createIfNone (and,
// for a switch, clearSessionPreference), while the proxy's per-request calls ask for
// neither. That matters — DuckDB fires requests in bursts, and a prompt per request
// would be unusable.
function getToken(options) {
  return vscode.authentication.getSession('microsoft', scopesFor(), options)
    .then(s => (s && s.accessToken) || null, () => null);
}

// getSession is an RPC into the account provider, and the proxy was making one PER READ.
// Opening a table is dozens of range reads, so that lookup — not OneLake, not DuckDB —
// was most of the wait, and it is the whole reason the panel felt slower than the browser
// build, where the service worker holds the token in memory and adds nothing.
//
// Cached with a short life rather than for the token's own hour: the point is to collapse
// a burst, and a stale one costs a single retry (proxy.js asks again with `fresh` when a
// read comes back 401). Anything that can change the answer clears it outright.
const TOKEN_TTL_MS = 60_000;
let cachedToken = null;   // { token, at }

function forgetToken() { cachedToken = null; }

async function proxyToken({ fresh = false } = {}) {
  if (!fresh && cachedToken && Date.now() - cachedToken.at < TOKEN_TTL_MS) return cachedToken.token;
  const token = await getToken({ createIfNone: false });
  cachedToken = token ? { token, at: Date.now() } : null;
  return token;
}

let proxy = null;

// Nothing about a slow read is visible from the webview: DuckDB's requests never pass
// through the page, so it cannot see how many there were, how big, how long OneLake took,
// or whether anything was answered locally. This is the only place that knows, and
// "OneLake Studio" in the Output panel is where it says so. Idle by default — an output
// channel costs nothing until somebody opens it.
let out = null;
function logRead(e) {
  tally(e);
  if (!out) return;
  // A STORE line is a background fill settling — the download that makes the next read
  // of that object local. It is not a read anyone waited for, and it says so.
  const filling = e.cache === 'store' || e.cache === 'store-failed';
  // A hit whose disk lookup was slow says so; a hit whose TOTAL is slow while the lookup
  // was instant means the request sat somewhere before the cache was even asked.
  const where = e.cache === 'hit' ? (e.lookupMs > 100 ? `cache (lookup ${e.lookupMs}ms)` : 'cache')
    : filling ? 'background fill'
    : [e.tokenMs > 5 ? `token ${e.tokenMs}ms` : '', `net ${e.netMs}ms`].filter(Boolean).join(' + ');
  const status = filling ? (e.cache === 'store' ? 'ok' : 'ERR') : String(e.status);
  const size = e.bytes ? ` ${(e.bytes / 1024).toFixed(0)}KB` : '';
  const path = e.path.length > 64 ? '…' + e.path.slice(-63) : e.path;
  // The verdict is its own column. A first-ever download that was kept and a cache that
  // failed to keep it both said just "net Xms", and a user reading the log concluded —
  // reasonably — that nothing was being cached at all.
  const verdict = e.cache === 'store-failed' ? 'FAIL ' : (e.cache || '').padEnd(5);
  out.appendLine(
    `${String(e.ms).padStart(6)}ms  ${e.method.padEnd(4)} ${status.padEnd(3)} ${verdict}` +
    `${size.padStart(9)}  ${where.padEnd(24)} ${e.range || ''} ${path}` +
    (e.error ? `  !! ${e.error}` : ''));
}

// ---------------------------------------------------------------------------
// What the panel's indicator shows
// ---------------------------------------------------------------------------
// The provenance of a read is only knowable here, and it was only ever written to an
// output channel — which is not where anyone looks when something feels slow. So it goes
// on screen, in the panel's status bar.
//
// Not per read: opening a table is hundreds of them, and an indicator that flickers once
// per request reports the mechanism instead of the answer. They are gathered into a burst
// — everything between one idle gap and the next — so what shows up is "the thing you just
// waited for", which is the question being asked.
const BURST_IDLE_MS = 500;    // this much quiet ends a burst
const POST_EVERY_MS = 250;    // ...and it is reported no more often than this while running

let burst = null;
let postTimer = null, idleTimer = null;

function tally(e) {
  if (!burst) burst = { reads: 0, hits: 0, misses: 0, skips: 0, stores: 0,
                        cacheBytes: 0, netBytes: 0, storeBytes: 0, netMs: 0 };
  if (e.cache === 'store' || e.cache === 'store-failed') {
    // A background fill is not a read anyone waited for, so it is not one of `reads` —
    // but its bytes are real network spend, counted apart so the indicator can disclose
    // the download without calling it part of what the user waited on. A failed fill
    // shows in the log; there is nothing of it to count.
    if (e.cache === 'store') { burst.stores++; burst.storeBytes += e.bytes || 0; }
  } else {
    burst.reads++;
    if (e.cache === 'hit') { burst.hits++; burst.cacheBytes += e.bytes || 0; }
    else {
      if (e.cache === 'skip') burst.skips++; else burst.misses++;
      burst.netBytes += e.bytes || 0;
      burst.netMs += e.netMs || 0;
    }
  }
  if (!postTimer) postTimer = setTimeout(() => { postTimer = null; postReads(); }, POST_EVERY_MS);
  clearTimeout(idleTimer);
  // The settled number is the one worth reading, and it is also the one that arrives after
  // the last response — so the burst is reported once more when the reads stop, and the
  // next read after that starts a new one.
  idleTimer = setTimeout(() => { postReads(); burst = null; }, BURST_IDLE_MS);
}

function postReads() {
  if (!burst) return;
  // storedBytes, not cacheSize() — the latter walks the whole directory, which is fine for
  // a command someone invoked and not for something on a 250ms timer.
  const c = proxy ? proxy.cacheStatus() : null;
  postLive({
    type: 'reads',
    ...burst,
    cacheOff: c && !c.usable ? (c.problem || 'caching is off') : '',
    cacheStored: c ? c.storedBytes : 0,
    cacheMax: c ? c.maxBytes : 0,
  });
}

const GB = 1024 * 1024 * 1024;
function cacheMaxBytes() {
  const gb = vscode.workspace.getConfiguration('onelakeStudio').get('dataCacheGB', 20);
  // 0 means "do not cache", which is a real answer for a machine short on disk — and
  // Number.MAX_SAFE_INTEGER is not one, so a negative or nonsense value falls back.
  return Number.isFinite(gb) && gb >= 0 ? Math.round(gb * GB) : 20 * GB;
}

const fmtBytes = n => n >= GB ? `${(n / GB).toFixed(1)} GB`
                   : n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB`
                   : `${Math.round(n / 1024)} KB`;

async function ensureProxy(context) {
  if (!proxy) {
    const max = cacheMaxBytes();
    proxy = await startProxy({
      getToken: proxyToken,
      // The immutable Iceberg files sw.js keeps for the browser build. Without it the
      // panel re-downloaded every parquet footer and row group on every open, which the
      // website has not done since the worker started caching them. Far larger than the
      // browser's copy, because the browser's limit is a storage quota and this is a
      // directory: bytes here cost disk, and fetching them again costs seconds.
      // A limit of zero is a real answer for a machine short on disk, and it means no
      // cache at all rather than a cache that evicts everything it writes.
      cacheDir: max > 0 ? join(context.globalStorageUri.fsPath, 'onelake-data') : null,
      cacheMaxBytes: max,
      onLog: logRead,
    });
    context.subscriptions.push({ dispose: () => proxy && proxy.close() });

    // Said once, at the top of the log, because every question about speed starts here.
    // A cache that could not make its directory looks exactly like one that is working
    // and never hitting: both are just "slow".
    const c = proxy.cacheStatus();
    if (out) {
      out.appendLine(c.usable
        ? `cache: ${fmtBytes(c.maxBytes)} max in ${c.dir} (currently ${fmtBytes(await proxy.cacheSize())})`
        : `cache: OFF — ${c.problem}${c.dir ? ` (${c.dir})` : ''}`);
      out.appendLine(
        'columns: total | method | status | verdict | bytes | where the time went | range | path');
      out.appendLine(
        '  hit  = served from disk    miss = fetched, and KEPT for next time' +
        '    skip = fetched, never stored (not an immutable object)');
      out.appendLine(
        '  STORE ok = a background download kept the whole object, so its next read is local');
    }
  }
  return proxy;
}

async function show(context, options) {
  const token = await getToken(options);
  if (!token) {
    vscode.window.showWarningMessage(
      'OneLake Studio needs a Microsoft account to reach OneLake. Sign-in was cancelled.');
    return false;
  }
  await openPanel(context, await ensureProxy(context));
  return true;
}

// The tree and the welcome view are two states of one view: the welcome buttons show
// while this is false. Kept in a context key rather than asked for on every render, so a
// collapsed tree costs no token lookups.
let signedIn = false;
async function setSignedIn(value) {
  signedIn = value;
  await vscode.commands.executeCommand('setContext', 'onelakeStudio.signedIn', value);
}

async function activate(context) {
  out = vscode.window.createOutputChannel('OneLake Studio');
  context.subscriptions.push(out);

  const { site } = await siteRoot(context.extensionUri,
    { dev: context.extensionMode === vscode.ExtensionMode.Development });
  // Listing goes straight to OneLake on the VS Code token — the proxy is for DuckDB's
  // range reads, which run in the webview and cannot set a header of their own.
  const catalog = createCatalog({
    // Same cache as the proxy's: expanding one item is a handful of calls, and they have
    // no more business asking the account provider once each than a range read does.
    getToken: proxyToken,
    siteFsPath: site.fsPath,
  });
  const tree = new LakehouseTree({ catalog, isSignedIn: () => signedIn });

  await setSignedIn(!!await getToken({ createIfNone: false }));

  // Opening a table means: make sure a panel exists, then tell it what to show. The panel
  // buffers the message if DuckDB is still booting.
  async function openInPanel(msg) {
    if (!await show(context, { createIfNone: true })) return;
    postToPanel(msg);
  }

  context.subscriptions.push(
    vscode.window.createTreeView('onelakeStudio.explorer', {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),

    vscode.commands.registerCommand('onelakeStudio.refresh', n => tree.refresh(n)),

    vscode.commands.registerCommand('onelakeStudio.showLog', () => out.show(true)),

    // Reading the same table twice should be quick, and if it is not, this is how to
    // prove the cache is the reason rather than assume it. It also answers "what is this
    // costing me on disk", which is the fair question to ask of a twenty-gigabyte default.
    vscode.commands.registerCommand('onelakeStudio.clearCache', async () => {
      if (!proxy) {
        vscode.window.showInformationMessage('OneLake Studio: nothing cached yet.');
        return;
      }
      const was = await proxy.cacheSize();
      await proxy.clearCache();
      vscode.window.showInformationMessage(
        `OneLake Studio: cleared ${fmtBytes(was)} of cached OneLake data.`);
    }),

    vscode.commands.registerCommand('onelakeStudio.openTable', n => openInPanel({
      type: 'open-table',
      workspace: n.workspace, item: n.item, schema: n.schema, table: n.table,
    })),

    vscode.commands.registerCommand('onelakeStudio.openFile', n => openInPanel({
      type: 'open-file', workspace: n.workspace, item: n.item, path: n.path, bytes: n.bytes,
    })),

    vscode.commands.registerCommand('onelakeStudio.open', async () => {
      try {
        await show(context, { createIfNone: true });
        await setSignedIn(!!await getToken({ createIfNone: false }));
        tree.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`OneLake Studio could not start: ${(e && e.message) || e}`);
      }
    }),

    // Signing in is what the welcome view offers when there is no session; it exists so
    // that button has something to call that does not also open a panel.
    vscode.commands.registerCommand('onelakeStudio.signIn', async () => {
      try {
        await getToken({ createIfNone: true });
        await setSignedIn(!!await getToken({ createIfNone: false }));
        tree.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Could not sign in: ${(e && e.message) || e}`);
      }
    }),

    // VS Code owns the account, so an extension cannot sign anyone out — that is the
    // Accounts menu in the bottom left. What it CAN do is stop reusing the remembered
    // choice, which is what someone with two tenants actually wants.
    vscode.commands.registerCommand('onelakeStudio.switchAccount', async () => {
      try {
        // Closed before asking: whichever account is picked, the panel on screen belongs to
        // the previous one, and its cached tables should not survive the switch. The tree
        // holds the same kind of stale answer, so it is emptied on the way out too.
        closePanel();
        forgetToken();                              // the cached one belongs to the account being left
        if (proxy) await proxy.clearCache();        // ...and so do the bytes it read
        tree.refresh();
        await show(context, { createIfNone: true, clearSessionPreference: true });
        await setSignedIn(!!await getToken({ createIfNone: false }));
        tree.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Could not switch account: ${(e && e.message) || e}`);
      }
    }),

    // Covers the other direction: signing out from the Accounts menu, or a token revoked
    // elsewhere. The proxy picks up whatever is current on its next request by itself, so
    // this only exists to make the failure a sentence instead of a wall of 401s.
    vscode.authentication.onDidChangeSessions(async e => {
      if (e.provider.id !== 'microsoft') return;
      forgetToken();
      const live = !!await getToken({ createIfNone: false });
      await setSignedIn(live);
      tree.refresh();
      if (!live && proxy) {
        closePanel();
        await proxy.clearCache();
        vscode.window.showInformationMessage(
          'OneLake Studio signed out — the Microsoft account is no longer available.');
      }
    }),
  );
}

function deactivate() {
  return proxy ? proxy.close() : undefined;
}

module.exports = { activate, deactivate };
