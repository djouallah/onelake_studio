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
const { openPanel, closePanel, revealPanel, postToPanel, postLive } = require('./panel');
const { createCatalog } = require('./catalog');
const { createStore } = require('./store');
const { createOneLake } = require('./onelake');
const { createFabric, exportPath, EXPORT_DIR } = require('./fabric');
const { LakehouseTree } = require('./tree');
const { siteRoot } = require('./site');

// The same scope site/auth.js asks MSAL for. OneLake accepts tokens in the storage
// audience only, and this one covers both the data reads and the Iceberg catalog. It is
// the only scope sign-in asks for; the Fabric API's (below) is asked for separately, and
// only once someone expands a workspace's semantic models.
const SCOPES = ['https://storage.azure.com/user_impersonation', 'offline_access'];

function withTenant(scopes) {
  const tenant = vscode.workspace.getConfiguration('onelakeStudio').get('tenantId', '').trim();
  // A guest in someone else's tenant has to say so; the home tenant is the default.
  return tenant ? [...scopes, `VSCODE_TENANT:${tenant}`] : scopes;
}

function scopesFor() { return withTenant(SCOPES); }

// `options` is passed straight through: the command handler asks with createIfNone (and,
// for a switch, clearSessionPreference), while the proxy's per-request calls ask for
// neither. That matters — DuckDB fires requests in bursts, and a prompt per request
// would be unusable.
function getSession(options) {
  return vscode.authentication.getSession('microsoft', scopesFor(), options);
}

// Why the last sign-in produced no token. A null used to mean "cancelled" whatever the
// cause, so a wrong tenant or a provider failure told the user they had cancelled.
let lastAuthError = null;

function getToken(options) {
  return getSession(options).then(
    s => { lastAuthError = null; return (s && s.accessToken) || null; },
    e => {
      lastAuthError = e;
      if (out) out.appendLine(`sign-in failed: ${(e && e.message) || e}`);
      return null;
    });
}

// Which identity the cache, the engine and the bridge currently belong to. Hashed, so the
// directory name says nothing about who the user is.
function accountKey(session) {
  if (!session || !session.account) return null;
  const tenant = vscode.workspace.getConfiguration('onelakeStudio').get('tenantId', '').trim();
  return require('node:crypto').createHash('sha256')
    .update(`${session.account.id}|${tenant}`).digest('hex').slice(0, 16);
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

function forgetToken() { cachedToken = null; cachedFabric = null; fabricAudience = null; }

async function proxyToken({ fresh = false } = {}) {
  if (!fresh && cachedToken && Date.now() - cachedToken.at < TOKEN_TTL_MS) return cachedToken.token;
  const token = await getToken({ createIfNone: false });
  cachedToken = token ? { token, at: Date.now() } : null;
  return token;
}

// The Fabric REST API — semantic models live there, not in OneLake. It takes a token in
// its own audience, or in Power BI's, which it also accepts; whichever VS Code's account
// provider will issue is remembered for the session. Asked for the SAME account the
// storage session belongs to, so the tree can never list one user's models and write into
// another user's lakehouse.
const FABRIC_AUDIENCES = [
  'https://api.fabric.microsoft.com/.default',
  'https://analysis.windows.net/powerbi/api/.default',
];
let fabricAudience = null;
let cachedFabric = null;   // { token, at }

const isCancel = e => /cancel|did not consent/i.test(String((e && e.message) || e));

async function fabricToken({ fresh = false, createIfNone = false } = {}) {
  if (!fresh && !createIfNone && cachedFabric && Date.now() - cachedFabric.at < TOKEN_TTL_MS) {
    return cachedFabric.token;
  }
  const storage = await getSession({ createIfNone: false }).catch(() => null);
  if (!storage) return null;
  let lastErr = null;
  for (const aud of fabricAudience ? [fabricAudience] : FABRIC_AUDIENCES) {
    try {
      const s = await vscode.authentication.getSession('microsoft',
        withTenant([aud, 'offline_access']), { createIfNone, account: storage.account });
      if (s) {
        fabricAudience = aud;
        cachedFabric = { token: s.accessToken, at: Date.now() };
        return s.accessToken;
      }
    } catch (e) {
      lastErr = e;
      if (out) out.appendLine(`fabric sign-in (${aud}) failed: ${(e && e.message) || e}`);
      if (isCancel(e)) return null;   // said no once; do not ask again for the other audience
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// The cache-first OneLake layer (onelake.js), built at activation and shared by the tree,
// the panel and everything else that reads OneLake.
let onelake = null;

let proxy = null;
let proxyStarting = null;   // in-flight startProxy, so two callers cannot start two servers

// Nothing about a slow read is visible from the webview: DuckDB's requests never pass
// through the page, so it cannot see how many there were, how big, how long OneLake took,
// or whether anything was answered locally. This is the only place that knows, and
// "OneLake Studio" in the Output panel is where it says so. Idle by default — an output
// channel costs nothing until somebody opens it.
let out = null;
let statusItem = null;

// Errors worth a toast are worth their diagnosis: every one of these has a longer story
// in the output channel, and 'Show Log' is the difference between a user who can say what
// happened and one who can only say it failed.
function showError(msg) {
  vscode.window.showErrorMessage(msg, 'Show Log').then(pick => {
    if (pick === 'Show Log' && out) out.show(true);
  });
}

function logRead(e) {
  tally(e);
  if (!out) return;
  // A STORE line is a background fill settling — the download that makes the next read
  // of that object local. It is not a read anyone waited for, and it says so.
  const filling = e.cache === 'store' || e.cache === 'store-failed';
  // A hit whose disk lookup was slow says so; a hit whose TOTAL is slow while the lookup
  // was instant means the request sat somewhere before the cache was even asked.
  const where = e.vendor ? 'packaged'
    : e.cache === 'hit' ? (e.lookupMs > 100 ? `cache (lookup ${e.lookupMs}ms)` : 'cache')
    : filling ? 'background fill'
    : [e.tokenMs > 5 ? `token ${e.tokenMs}ms` : '', `net ${e.netMs}ms`].filter(Boolean).join(' + ');
  const status = filling ? (e.cache === 'store' ? 'ok' : 'ERR') : String(e.status);
  const size = e.bytes ? ` ${(e.bytes / 1024).toFixed(0)}KB` : '';
  const path = e.path.length > 64 ? '…' + e.path.slice(-63) : e.path;
  // The verdict is its own column. A first-ever download that was kept and a cache that
  // failed to keep it both said just "net Xms", and a user reading the log concluded —
  // reasonably — that nothing was being cached at all.
  const verdict = e.cache === 'store-failed' ? 'FAIL ' : (e.cache || '').padEnd(5);
  // Reads the website made through the VS Code sign-in, told apart from the panel's.
  const who = e.listener === 'bridge' ? 'web ' : '';
  out.appendLine(
    `${String(e.ms).padStart(6)}ms  ${who}${e.method.padEnd(4)} ${status.padEnd(3)} ${verdict}` +
    `${size.padStart(9)}  ${where.padEnd(24)} ${e.range || ''} ${path}` +
    (e.error ? `  !! ${e.error}` : ''));
}

// The click, measured end to end. The per-read lines say where each request's time went;
// this line is the number the user actually lived through — click to on-screen — which
// includes everything the reads cannot see: the catalog, the worker, the rendering. When
// an OPEN line is seconds and the read lines under it are milliseconds, the time went to
// one of those, and that difference is the diagnosis.
// The other half of a slow boot. Every line in the read log above is the proxy answering;
// these are the engine's own stages — creating the DuckDB instance, loading its extensions
// (from the vsix, or downloaded on first run). The engine host and the page both report
// here, so a boot whose reads are all fast hits and whose total is slow says which it was.
function logBoot(m) {
  if (!out) return;
  const stages = Array.isArray(m.stages) ? m.stages : [];
  out.appendLine(
    `${String(Number(m.totalMs) || 0).padStart(6)}ms  BOOT engine ready` +
    (m.quiet ? ' (engine reconnected)' : ''));
  for (const s of stages) {
    out.appendLine(`${String(Number(s.ms) || 0).padStart(6)}ms       ${s.stage}`);
  }
  // Which optional formats this session has is decided at boot and nowhere visible
  // after it — this line is the answer to "why is .xlsx greyed out".
  if (m.capabilities) {
    const missing = Object.entries(m.capabilities).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) out.appendLine(`        formats unavailable this session: ${missing.join(', ')}`);
  }
}

function logOpened(m) {
  if (!out) return;
  const what = m.kind === 'table' ? 'metadata + stats on screen'
             : m.kind === 'rows' ? 'rows on screen'
             : 'file on screen';
  const label = String(m.label || '').slice(0, 80);
  out.appendLine(
    `${String(Number(m.ms) || 0).padStart(6)}ms  OPEN ${label} — click to ${what}`);
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
  // The same burst, in the editor's own status bar — the panel's indicator is invisible
  // the moment its tab is hidden, which is exactly when a long-running query is being
  // waited on from somewhere else.
  if (statusItem) {
    statusItem.text = `$(database) OneLake ${fmtBytes(burst.cacheBytes)} cache · ${fmtBytes(burst.netBytes)} net`;
    statusItem.tooltip = `OneLake Studio — last burst: ${burst.reads} read(s), ` +
      `${burst.hits} from disk, ${burst.misses + burst.skips} from the network` +
      (c && c.storedBytes ? `; ${fmtBytes(c.storedBytes)} cached on disk` : '') +
      `. Click for the read log.`;
    statusItem.show();
  }
}

const GB = 1024 * 1024 * 1024;
function cacheMaxBytes() {
  const gb = vscode.workspace.getConfiguration('onelakeStudio').get('dataCacheGB', 20);
  // 0 means "do not cache", which is a real answer for a machine short on disk — and
  // Number.MAX_SAFE_INTEGER is not one, so a negative or nonsense value falls back.
  return Number.isFinite(gb) && gb >= 0 ? Math.round(gb * GB) : 20 * GB;
}

// How long a catalog answer is served from disk with no network check at all. The user's
// number, because it IS the trade: bigger means table opens skip the catalog's
// seconds-per-call for longer, and a new snapshot takes that much longer to show up.
function catalogTtlMs() {
  const min = vscode.workspace.getConfiguration('onelakeStudio').get('catalogTtlMinutes', 5);
  return Number.isFinite(min) && min >= 0 ? Math.round(min * 60 * 1000) : 5 * 60 * 1000;
}

const fmtBytes = n => n >= GB ? `${(n / GB).toFixed(1)} GB`
                   : n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB`
                   : `${Math.round(n / 1024)} KB`;

async function ensureProxy(context) {
  if (proxy) return proxy;
  // Single-flight: the `if` above has an await between it and the assignment below, and
  // two near-simultaneous callers (a tree click racing the Open command) used to start
  // two servers — the loser leaked, listening with a live secret until the window closed.
  if (!proxyStarting) {
    proxyStarting = startProxyOnce(context).finally(() => { proxyStarting = null; });
  }
  return proxyStarting;
}

// The account the running proxy's cache belongs to (see accountKey).
let proxyAccount = null;
let legacyCacheSwept = false;

async function startProxyOnce(context) {
  const max = cacheMaxBytes();
  const session = await getSession({ createIfNone: false }).catch(() => null);
  proxyAccount = accountKey(session);
  // One cache directory PER ACCOUNT. A hit is answered without a token, so a cache keyed
  // by URL alone served account A's bytes to account B — in another window, after a
  // switch made from the Accounts menu, or after a tenant change. Per-account directories
  // make that impossible, and switching back finds its cache still warm.
  const root = join(context.globalStorageUri.fsPath, 'onelake-data-v2');
  // The old, shared directory: whoever it belonged to, nobody may be served from it now.
  if (!legacyCacheSwept) {
    legacyCacheSwept = true;
    require('node:fs/promises').rm(join(context.globalStorageUri.fsPath, 'onelake-data'),
      { recursive: true, force: true }).catch(() => {});
  }
  proxy = await startProxy({
    getToken: proxyToken,
    // The immutable Iceberg files sw.js keeps for the browser build, plus whatever the
    // website reads through the bridge. Far larger than the browser's copy, because the
    // browser's limit is a storage quota and this is a directory: bytes here cost disk,
    // and fetching them again costs seconds. A limit of zero is a real answer for a
    // machine short on disk, and it means no cache at all.
    cacheDir: max > 0 ? join(root, proxyAccount || 'signed-out') : null,
    cacheMaxBytes: max,
    cacheTtlMs: catalogTtlMs(),
    // The webview's libraries ship inside the extension (vendor.mjs at package time); the
    // proxy serves them from here before cache or network.
    vendorDir: join(context.extensionUri.fsPath, 'vendor'),
    onLog: logRead,
  });

  // Said once, at the top of the log, because every question about speed starts here.
  // A cache that could not make its directory looks exactly like one that is working
  // and never hitting: both are just "slow". The size comes from the start-up sweep when
  // it finishes; waiting for a second full walk here held the first panel open behind it.
  const c = proxy.cacheStatus();
  if (out) {
    out.appendLine(c.usable
      ? `cache: ${fmtBytes(c.maxBytes)} max in ${c.dir}`
      : `cache: OFF — ${c.problem}${c.dir ? ` (${c.dir})` : ''}`);
    if (c.usable) {
      const p = proxy;
      p.cacheIdle().then(() => {
        if (proxy === p && out) out.appendLine(`cache: ${fmtBytes(p.cacheStatus().storedBytes)} on disk`);
      }).catch(() => {});
    }
    out.appendLine(
      'columns: total | method | status | verdict | bytes | where the time went | range | path');
    out.appendLine(
      '  hit  = served from disk (a stale catalog answer is served instantly and refreshed' +
      ' behind)    miss = fetched, and KEPT    skip = fetched, not kept');
    out.appendLine(
      '  STORE ok = a background download kept the whole object, so its next read is local');
  }
  return proxy;
}

// A new identity gets a new proxy: a cache of its own, and new secrets for the panel and
// the bridge — origins handed to a page under the old account stop working at once.
async function restartProxy(context) {
  await stopBridge();
  if (proxyStarting) await proxyStarting.catch(() => {});
  const p = proxy;
  proxy = null;
  proxyAccount = null;
  if (p) await p.close().catch(() => {});
  if (bridgeWanted()) ensureBridge(context).catch(() => {});
}

// ---------------------------------------------------------------------------
// The bridge: the website, signed in with this window's VS Code account
// ---------------------------------------------------------------------------
// The website needs an Entra app registration to sign in by itself. When VS Code is
// running it does not have to: it can read OneLake through a second listener on the
// proxy — a fixed port it can find, an exact origin list, the two OneLake routes and
// /pair — and the token stays here. MSAL remains the website's fallback.
const DEFAULT_SITE = 'https://studio.projectscontrols.com';
const TRUSTED_KEY = 'onelakeStudio.bridge.trustedOrigins';

let bridge = null;
let bridgeStarting = null;

const bridgeConfig = () => {
  const c = vscode.workspace.getConfiguration('onelakeStudio');
  const origins = (c.get('bridge.origins', [DEFAULT_SITE]) || [])
    .map(o => String(o).trim().replace(/\/+$/, '')).filter(o => /^https?:\/\/[^/]+$/i.test(o));
  return { enabled: c.get('bridge.enabled', true), port: c.get('bridge.port', 47731), origins };
};
const bridgeWanted = () => { const b = bridgeConfig(); return b.enabled && b.origins.length > 0; };

function ensureBridge(context) {
  if (bridge) return Promise.resolve(bridge);
  if (!bridgeWanted()) return Promise.resolve(null);
  if (!bridgeStarting) {
    bridgeStarting = (async () => {
      const { port, origins } = bridgeConfig();
      const p = await ensureProxy(context);
      try {
        bridge = await p.startBridge({ port, origins, onPair: origin => pairPrompt(context, origin) });
        if (out) out.appendLine(`bridge: http://127.0.0.1:${bridge.port} for ${origins.join(', ')}`);
      } catch (e) {
        bridge = null;
        if (out) out.appendLine(e && e.code === 'EADDRINUSE'
          ? `bridge: port ${port} is taken — another VS Code window is probably serving the website; this one will not.`
          : `bridge: could not start — ${(e && e.message) || e}`);
      }
      return bridge;
    })().finally(() => { bridgeStarting = null; });
  }
  return bridgeStarting;
}

async function stopBridge() {
  if (bridgeStarting) await bridgeStarting.catch(() => {});
  const b = bridge;
  bridge = null;
  if (b) await b.close().catch(() => {});
}

// One question per origin at a time: a page that retries must not stack modals.
const pairing = new Map();

async function pairPrompt(context, origin) {
  const session = await getSession({ createIfNone: false }).catch(() => null);
  if (!session) return { allowed: false };
  const account = session.account.label;
  const trusted = context.globalState.get(TRUSTED_KEY, []);
  if (trusted.includes(origin)) return { allowed: true, account };
  if (pairing.has(origin)) return pairing.get(origin);
  const ask = (async () => {
    const pick = await vscode.window.showWarningMessage(
      `Allow ${origin} to read OneLake as ${account}?`,
      {
        modal: true,
        detail: 'The website will read OneLake with this VS Code window\'s Microsoft sign-in, ' +
          'through a port on 127.0.0.1. The token itself never leaves VS Code. ' +
          'Allow only a site you opened yourself. ' +
          '"OneLake Studio: Forget Websites Allowed to Use the VS Code Sign-in" takes it back.',
      },
      'Allow Once', 'Always Allow');
    if (pick === 'Always Allow') {
      await context.globalState.update(TRUSTED_KEY, [...new Set([...trusted, origin])]);
    }
    if (out) out.appendLine(`bridge: ${origin} ${pick ? `allowed (${pick.toLowerCase()})` : 'refused'}`);
    return { allowed: !!pick, account };
  })().finally(() => pairing.delete(origin));
  pairing.set(origin, ask);
  return ask;
}

// Real DuckDB, in this process. Built once and kept for the window's lifetime: an engine
// costs ~17ms to create but its four extensions are downloaded on first use, and doing
// that per panel open is the mistake the wasm build could not avoid.
//
// Loaded lazily so a failure to load the native binding — an unsupported platform, a vsix
// built for another architecture — surfaces when the panel opens, with a message, rather
// than taking activation down with it.
let engine = null;
// The editor's proxy, for DuckDB's own downloads and reads: VS Code's `http.proxy` setting
// first, then the environment variables the editor itself would honour.
function editorProxy() {
  const configured = vscode.workspace.getConfiguration('http').get('proxy', '');
  return configured || process.env.HTTPS_PROXY || process.env.https_proxy ||
         process.env.HTTP_PROXY || process.env.http_proxy || '';
}

// `readme` is the one file outside DuckDB's own directories the engine may read (the
// landing query) — see the lockdown in engine-host.js.
function ensureEngine(context, { readme } = {}) {
  if (engine) return engine;
  try {
    const { createEngineHost } = require('./engine-host');
    engine = createEngineHost({
      allowedPaths: readme ? [readme] : [],
      httpProxy: editorProxy(),
      // Fetched for this vsix's platform at package time (fetch-extensions.mjs); a first
      // run offline, or behind a proxy DuckDB cannot use, still has its extensions.
      bundledExtensions: join(context.extensionUri.fsPath, 'duckdb-extensions'),
      // Beside the data cache, so the four extensions are downloaded once per install
      // rather than once per session — and never into the user's own ~/.duckdb, where
      // they would outlive the extension that fetched them.
      extensionDir: join(context.globalStorageUri.fsPath, 'duckdb-extensions'),
      onLog: logBoot,
      // A failed optional extension is worth a line where someone will find it.
      onWarn: w => out && out.appendLine(w),
      // DuckDB talks to OneLake itself now, so it needs the bearer the proxy used to
      // attach on its behalf. Same cached, silent token — reads must never prompt.
      // Options pass through so the engine's auth retry can say { fresh: true } and
      // actually get PAST this cache — asking it again inside the 60s window returns
      // the very token that just expired, and the retry becomes a no-op.
      getToken: opts => proxyToken(opts),
      memoryLimit: vscode.workspace.getConfiguration('onelakeStudio').get('engineMemoryLimit', '').trim(),
    });
  } catch (e) {
    out && out.appendLine(`native DuckDB unavailable: ${e.message}`);
    showError(
      `OneLake Studio could not load DuckDB for this platform (${process.platform}-${process.arch}): ${e.message}`);
    engine = null;
  }
  return engine;
}

// Closing the engine is what revokes its credentials: the azure secret and every ATTACH
// hold the access token BY VALUE, so an engine that outlives the sign-out keeps reading
// OneLake for as long as the token lasts. Cheap to rebuild — ensureEngine does it lazily
// on the next open, and a warm boot is ~300ms.
async function resetEngine() {
  const e = engine;
  engine = null;
  if (e) await e.close().catch(() => {});
}

async function show(context, options) {
  if (revealPanel()) return true;
  const token = await getToken(options);
  if (!token) {
    const why = lastAuthError ? `Sign-in failed: ${lastAuthError.message || lastAuthError}`
                              : 'Sign-in was cancelled.';
    vscode.window.showWarningMessage(
      `OneLake Studio needs a Microsoft account to reach OneLake. ${why}`);
    return false;
  }
  // The engine is not optional any more — there is no wasm fallback to degrade to — so a
  // platform whose binding will not load is told plainly instead of being handed a panel
  // that boots to a spinner and never moves.
  const { readme } = await siteRoot(context.extensionUri,
    { dev: context.extensionMode === vscode.ExtensionMode.Development });
  const eng = ensureEngine(context, { readme: readme.fsPath });
  if (!eng) return false;
  // A target from the page, reduced to the four strings it may carry.
  const ref = x => ({ lh: { workspace: String(x.workspace), item: String(x.item) },
                      t: { schema: String(x.schema || ''), table: String(x.table) } });
  await openPanel(context, await ensureProxy(context), {
    onOpened: logOpened, onBoot: logBoot, engine: eng,
    host: {
      'onelake.table': x => { const { lh, t } = ref(x);
        return onelake.table(lh, t, { onWait: message => postLive({ type: 'status', message }) }); },
      'onelake.peek': x => { const { lh, t } = ref(x);
        return onelake.peek(lh, t, sql => eng.call('query', [sql])); },
    },
    // The page could not bring the engine up. Everything it buffered is already gone;
    // this is the toast that stops the failure being a spinner that never moves.
    // A panel whose engine never came up answers no click again, so the toast offers the
    // one thing that helps: a fresh panel and a fresh boot.
    onBootFailed: m => {
      vscode.window.showErrorMessage(`OneLake Studio's engine failed to start: ${m}`, 'Reload', 'Show Log')
        .then(async pick => {
          if (pick === 'Show Log' && out) out.show(true);
          if (pick === 'Reload') {
            closePanel();
            await resetEngine();
            vscode.commands.executeCommand('onelakeStudio.open');
          }
        });
    },
  });
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

// The exact commit this window is running. Installed build: the stamp copy-site.mjs wrote
// into site/version.js at package time (already '+dirty'-labelled when the tree was).
// Dev: ask git directly, and label a dirty tree the same way — HEAD alone would name a
// commit that does not contain the edits actually running.
function buildCommit(context, dev) {
  if (dev) {
    try {
      const { execSync } = require('node:child_process');
      const opts = { encoding: 'utf8', cwd: context.extensionUri.fsPath };
      let commit = execSync('git rev-parse HEAD', opts).trim().slice(0, 7);
      if (execSync('git status --porcelain', opts).trim()) commit += '+dirty';
      return commit;
    } catch (_) { return 'dev'; }
  }
  try {
    const stamp = require('node:fs').readFileSync(
      join(context.extensionUri.fsPath, 'site', 'version.js'), 'utf8');
    const m = /commit:\s*"([^"]+)"/.exec(stamp);
    if (m) return m[1];
  } catch (_) {}
  return 'unknown';
}

async function activate(context) {
  out = vscode.window.createOutputChannel('OneLake Studio');
  context.subscriptions.push(out);

  // The read indicator, visible even when the panel's tab is not. Hidden until the first
  // burst — a status bar item with nothing to say is noise.
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.name = 'OneLake Studio';
  statusItem.command = 'onelakeStudio.showLog';
  context.subscriptions.push(statusItem);

  // Which build is this window actually running? Bottom left, always visible: version,
  // EXACT commit, and 'dev' when it is the F5 checkout rather than an installed vsix.
  // Exists because "I clicked X and nothing is there" is unanswerable until both sides
  // know they are looking at the same build. Same stamp discipline as copy-site.mjs:
  // '+dirty' whenever the code running is not exactly the commit named.
  const version = (context.extension && context.extension.packageJSON &&
                   context.extension.packageJSON.version) || '?';
  const dev = context.extensionMode === vscode.ExtensionMode.Development;
  const commit = buildCommit(context, dev);
  const buildItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
  buildItem.name = 'OneLake Studio build';
  buildItem.text = `$(database) OneLake ${version} · ${commit}${dev ? ' · dev' : ''}`;
  buildItem.tooltip = dev
    ? `OneLake Studio ${version} at commit ${commit}, running from the checkout (F5) — the panel serves extension/app/`
    : `OneLake Studio ${version}, packaged at commit ${commit}`;
  buildItem.command = 'onelakeStudio.showLog';
  buildItem.show();
  context.subscriptions.push(buildItem);

  // A failure past this point used to be INVISIBLE: activation dies half-way, the view
  // renders as an empty pane — no tree, no welcome content, no message anywhere. The
  // rest of activate is guarded so that shape can never be silent again.
  try {
    await activateInner(context);
    out.appendLine(`activated ${version} ${commit}${dev ? ' (dev)' : ''} — signed in: ${signedIn}`);
  } catch (e) {
    out.appendLine(`ACTIVATION FAILED: ${(e && e.stack) || e}`);
    showError(`OneLake Studio failed to activate: ${(e && e.message) || e}`);
    throw e;
  }
}

async function activateInner(context) {
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
  // Semantic models and the .bim export: Fabric's token for the model, the storage one
  // (the same cache the catalog uses) for the one file the export writes.
  const fabric = createFabric({ getFabricToken: fabricToken, getStorageToken: proxyToken });

  // What the extension knows about OneLake, kept on disk per account and served from there
  // first (onelake.js). One directory per identity — a hashed account id — so nobody is
  // ever shown another account's listings, and switching back finds its cache still warm.
  const storeRoot = join(context.globalStorageUri.fsPath, 'onelake-store-v1');
  const storeFor = key => createStore({ dir: join(storeRoot, key || 'signed-out'), ttlMs: catalogTtlMs() });
  let storeAccount = accountKey(await getSession({ createIfNone: false }).catch(() => null));
  onelake = createOneLake({
    catalog,
    store: storeFor(storeAccount),
    prefetchEnabled: () => vscode.workspace.getConfiguration('onelakeStudio').get('prefetchMetadata', true),
  });
  // Called wherever the identity may have moved; a no-op when it has not.
  async function rebindStore() {
    const key = accountKey(await getSession({ createIfNone: false }).catch(() => null));
    if (key === storeAccount) return;
    storeAccount = key;
    onelake.useStore(storeFor(key));
  }
  context.subscriptions.push({ dispose: onelake.onRefreshFailed((what, e) => {
    // The cached answer stays on screen; why it could not be refreshed goes here.
    if (out) out.appendLine(`refresh of ${what.kind} ${[what.workspace, what.item, what.schema, what.table]
      .filter(Boolean).join('/')} failed — ${(e && e.message) || e}`);
  }) });

  const tree = new LakehouseTree({
    onelake,
    fabric,
    hasFabric: async () => !!await fabricToken().catch(() => null),
    isSignedIn: () => signedIn,
    // A listing failure becomes an error NODE, but the stack behind it goes here.
    log: m => out && out.appendLine(m),
  });

  await setSignedIn(!!await getToken({ createIfNone: false }));

  // Opening a table means: make sure a panel exists, then tell it what to show. The panel
  // buffers the message if DuckDB is still booting. Boot is multi-second work with no
  // editor-side sign of life until now — withProgress is that sign.
  const showWithProgress = options => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Opening OneLake Studio…' },
    () => show(context, options));

  async function openInPanel(msg) {
    if (!await showWithProgress({ createIfNone: true })) return;
    postToPanel(msg);
  }

  // A semantic model's definition, exported to the one place the extension writes:
  // <lakehouse>/Files/semantic_models/<model>.bim, in a lakehouse of the model's own
  // workspace. Then opened, which is the point — the panel reads a .bim as its model.
  async function exportBim(n) {
    if (!n || n.kind !== 'semanticModel') {
      vscode.window.showInformationMessage(
        'OneLake Studio: pick a semantic model under a workspace\'s "Semantic models" in the OneLake tree.');
      return;
    }
    try {
      const { hasFilesArea } = await catalog.paths();
      const lakehouses = (await catalog.listItems(n.workspace)).filter(it => hasFilesArea(it.name));
      if (!lakehouses.length) {
        showError(`${n.workspace} has no lakehouse to export ${n.model} into — the .bim goes to ` +
                  `a lakehouse's Files/${EXPORT_DIR}/ in the model's own workspace.`);
        return;
      }
      let item = lakehouses[0].name;
      if (lakehouses.length > 1) {
        const pick = await vscode.window.showQuickPick(
          lakehouses.map(l => ({ label: l.name.replace(/\.[^.]+$/, ''), description: 'Lakehouse', item: l.name })),
          { placeHolder: `Export ${n.model} into which lakehouse's Files/${EXPORT_DIR}/?` });
        if (!pick) return;
        item = pick.item;
      }
      const rel = exportPath(item, n.model);
      if (await fabric.exists(n.workspace, rel)) {
        const ok = await vscode.window.showWarningMessage(
          `${rel} already exists. Replace it with ${n.model}'s current definition?`, { modal: true }, 'Replace');
        if (ok !== 'Replace') return;
      }
      const bytes = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting ${n.model}` },
        async progress => {
          progress.report({ message: 'reading its definition from Fabric…' });
          const b = await fabric.getBim(n.workspace, n.modelId);
          progress.report({ message: `writing ${rel}…` });
          await fabric.writeExport(n.workspace, rel, b);
          return b;
        });
      if (out) out.appendLine(`exported ${n.model} -> ${n.workspace}/${rel} (${fmtBytes(bytes.length)})`);
      tree.refresh({ kind: 'dir', workspace: n.workspace, item, dir: '' });
      await openInPanel({ type: 'open-file', workspace: n.workspace, item, path: rel, bytes: bytes.length });
    } catch (e) {
      if (out) out.appendLine(`export of ${n.model} failed — ${(e && e.stack) || e}`);
      showError(`Could not export ${n.model}: ${(e && e.message) || e}`);
    }
  }

  context.subscriptions.push(
    vscode.window.createTreeView('onelakeStudio.explorer', {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),

    // The panel keeps table metadata across lakehouse switches now, so the refresh button
    // is what tells it to forget: a refresh exists to ask OneLake again, there too.
    vscode.commands.registerCommand('onelakeStudio.refresh', n => {
      tree.refresh(n);
      postLive({ type: 'reset' });
    }),

    vscode.commands.registerCommand('onelakeStudio.showLog', () => out.show(true)),

    // Reading the same table twice should be quick, and if it is not, this is how to
    // prove the cache is the reason rather than assume it. It also answers "what is this
    // costing me on disk", which is the fair question to ask of a twenty-gigabyte default.
    vscode.commands.registerCommand('onelakeStudio.clearCache', async () => {
      // Two caches: the listings and table metadata the tree and panel are served from,
      // and — when the website bridge has run — the data files it read.
      const meta = await onelake.size();
      const data = proxy ? await proxy.cacheSize() : 0;
      if (!meta && !data) {
        vscode.window.showInformationMessage('OneLake Studio: the cache is empty.');
        return;
      }
      // Everything deleted here is re-read from OneLake at OneLake's speed, which is the
      // whole reason the cache exists — so it is asked first.
      const pick = await vscode.window.showWarningMessage(
        `Delete ${fmtBytes(meta + data)} of cached OneLake data? Listings and tables will be read from OneLake again.`,
        { modal: true }, 'Delete');
      if (pick !== 'Delete') return;
      await onelake.clear();
      if (proxy) await proxy.clearCache();
      postLive({ type: 'reset' });
      tree.redraw();
      vscode.window.showInformationMessage(
        `OneLake Studio: cleared ${fmtBytes(meta + data)} of cached OneLake data.`);
    }),

    vscode.commands.registerCommand('onelakeStudio.openTable', n => openInPanel({
      type: 'open-table',
      workspace: n.workspace, item: n.item, schema: n.schema, table: n.table,
    })),

    vscode.commands.registerCommand('onelakeStudio.openFile', n => openInPanel({
      type: 'open-file', workspace: n.workspace, item: n.item, path: n.path, bytes: n.bytes,
    })),

    // The tree's "Sign in to list semantic models" node. A command of its own, because the
    // Fabric API's consent is a separate prompt and must only ever follow a click.
    vscode.commands.registerCommand('onelakeStudio.signInFabric', async () => {
      try {
        if (await fabricToken({ createIfNone: true })) tree.redraw();
      } catch (e) {
        showError(`Could not sign in to the Fabric API: ${(e && e.message) || e}`);
      }
    }),

    vscode.commands.registerCommand('onelakeStudio.exportBim', n => exportBim(n)),

    vscode.commands.registerCommand('onelakeStudio.open', async () => {
      try {
        await showWithProgress({ createIfNone: true });
        await setSignedIn(!!await getToken({ createIfNone: false }));
        await rebindStore();
        tree.redraw();
      } catch (e) {
        showError(`OneLake Studio could not start: ${(e && e.message) || e}`);
      }
    }),

    // Signing in is what the welcome view offers when there is no session; it exists so
    // that button has something to call that does not also open a panel.
    vscode.commands.registerCommand('onelakeStudio.signIn', async () => {
      try {
        await getToken({ createIfNone: true });
        await setSignedIn(!!await getToken({ createIfNone: false }));
        await rebindStore();
        tree.redraw();
      } catch (e) {
        showError(`Could not sign in: ${(e && e.message) || e}`);
      }
    }),

    // VS Code owns the account, so an extension cannot sign anyone out — that is the
    // Accounts menu in the bottom left. What it CAN do is stop reusing the remembered
    // choice, which is what someone with two tenants actually wants.
    vscode.commands.registerCommand('onelakeStudio.switchAccount', async () => {
      try {
        // Ask FIRST. Tearing down before the picker meant that cancelling it still cost
        // the panel, the engine and up to twenty gigabytes of cache — for a switch that
        // never happened.
        const picked = await getToken({ createIfNone: true, clearSessionPreference: true });
        if (!picked) return;
        // Now the teardown is FOR something: the panel on screen and the engine's secrets
        // belong to the account being left. Its cache does not need deleting — it is that
        // account's own directory, and a new proxy opens the new account's.
        closePanel();
        forgetToken();
        await resetEngine();
        await restartProxy(context);
        await rebindStore();
        tree.redraw();
        await showWithProgress({ createIfNone: true });
        await setSignedIn(!!await getToken({ createIfNone: false }));
        tree.redraw();
      } catch (e) {
        showError(`Could not switch account: ${(e && e.message) || e}`);
      }
    }),

    // Covers the other direction: signing out from the Accounts menu, or a token revoked
    // elsewhere. The proxy signs per request and recovers by itself; the ENGINE does not —
    // its azure secret and ATTACHes hold the token by value, so it is closed here, or a
    // signed-out window keeps reading OneLake for as long as the old token lasts.
    //
    // A DIFFERENT account — chosen from the Accounts menu rather than Switch Account — is
    // the same teardown as a switch. It used to change nothing: the session was still
    // "live", so the panel, the engine and the cache carried on as the previous user.
    vscode.authentication.onDidChangeSessions(async e => {
      if (e.provider.id !== 'microsoft') return;
      forgetToken();
      const session = await getSession({ createIfNone: false }).catch(() => null);
      await setSignedIn(!!session);
      // Signed out: what was cached for that account is not left behind on disk.
      if (!session) await onelake.clear().catch(() => {});
      await rebindStore();
      tree.redraw();
      if (!session) {
        closePanel();
        await resetEngine();
        if (proxy) await proxy.clearCache();
        if (proxy) await restartProxy(context);
        vscode.window.showInformationMessage(
          'OneLake Studio signed out — the Microsoft account is no longer available.');
      } else if (proxy && accountKey(session) !== proxyAccount) {
        closePanel();
        await resetEngine();
        await restartProxy(context);
        vscode.window.showInformationMessage(
          `OneLake Studio is now using ${session.account.label}.`);
      }
    }),

    // Settings are read where they are used, but two of them configure things that are
    // already built by then. Saying so beats silently applying at the next window reload.
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('onelakeStudio.tenantId')) {
        // The cached token, the engine's secrets, the cache and the bridge's origins all
        // belong to the tenant being left.
        forgetToken();
        await rebindStore();
        tree.redraw();
        if (proxy) {
          closePanel();
          await resetEngine();
          await restartProxy(context);
        }
      }
      if (proxy && (e.affectsConfiguration('onelakeStudio.dataCacheGB') ||
                    e.affectsConfiguration('onelakeStudio.catalogTtlMinutes') ||
                    e.affectsConfiguration('onelakeStudio.bridge'))) {
        vscode.window.showInformationMessage(
          'OneLake Studio: cache and website-bridge settings apply after the window is reloaded.');
      }
    }),

    // The website, opened already pointed at this window: the `#vscode` fragment tells it
    // to look for the bridge straight away rather than offer its own sign-in first.
    vscode.commands.registerCommand('onelakeStudio.openInBrowser', async () => {
      const { origins, enabled } = bridgeConfig();
      if (!enabled || !origins.length) {
        const pick = await vscode.window.showWarningMessage(
          'The website bridge is turned off (onelakeStudio.bridge.enabled).', 'Open Settings');
        if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'onelakeStudio.bridge');
        return;
      }
      if (!await getToken({ createIfNone: true })) return;
      await setSignedIn(true);
      await ensureBridge(context);
      const origin = origins.length === 1 ? origins[0]
        : await vscode.window.showQuickPick(origins, { placeHolder: 'Which website?' });
      if (origin) vscode.env.openExternal(vscode.Uri.parse(`${origin}/#vscode`));
    }),

    vscode.commands.registerCommand('onelakeStudio.forgetTrustedSites', async () => {
      const trusted = context.globalState.get(TRUSTED_KEY, []);
      await context.globalState.update(TRUSTED_KEY, []);
      // A page that already paired holds origins with the bridge's secret in them; a new
      // proxy makes those dead now rather than at the next reload.
      if (proxy) { closePanel(); await restartProxy(context); }
      vscode.window.showInformationMessage(trusted.length
        ? `OneLake Studio: forgot ${trusted.join(', ')}. They will ask again next time.`
        : 'OneLake Studio: no website was allowed to use the VS Code sign-in.');
    }),
  );

  // Listening from startup, so the website finds VS Code without anyone opening the
  // panel first. Never prompts: a page's /pair only asks once someone is signed in, and
  // a busy port (another window) just means that window is the bridge.
  if (bridgeWanted()) ensureBridge(context).catch(() => {});
}

function deactivate() {
  // The burst timers hold the process open if they are live at shutdown.
  clearTimeout(postTimer);
  clearTimeout(idleTimer);
  // The engine holds a native database handle and a temp directory; closing it is what
  // releases both. Settled together so a slow engine shutdown cannot strand the proxy's.
  return Promise.all([
    proxy ? proxy.close() : undefined,   // closes the bridge listener with it
    engine ? engine.close() : undefined,
  ]);
}

module.exports = { activate, deactivate };
