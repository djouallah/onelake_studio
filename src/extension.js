'use strict';
// =============================================================================
// extension.js — activation, and the reason this extension exists
// =============================================================================
// Sign-in is VS Code's: getSession('microsoft', …) goes through VS Code's own
// first-party application, which can impersonate for Azure resources — so the user signs
// in with the prompt they already use for GitHub, and registers nothing. `offline_access` is what makes the session survive a reload; without it
// the refresh token is not issued and every restart is a fresh sign-in.
// =============================================================================

const vscode = require('vscode');
const { join, basename, dirname, relative, isAbsolute } = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const fsp = require('node:fs/promises');
const { registerQueryEditor } = require('./queryeditor');
const { setVariable, variablesIn, bindVariables, literal } = require('./querytext');
const { quoteIdent } = require('./sql');
const { openPanel, closePanel, revealPanel, panelColumn, dockBelowEditor, postToPanel, postLive, panelSettings } = require('./panel');
const { createCatalog } = require('./catalog');
const { createStore } = require('./store');
const { createOneLake, walkCached } = require('./onelake');
const { createHostMethods } = require('./host');
const { createFabric, modelFileName } = require('./fabric');
const { LakehouseTree } = require('./tree');
const { webviewRoot } = require('./webview');
const { fmtBytes, sqlKind, sqlName, sqlNameOf, sqlPart, displayName, MODEL_CATALOG, modelSqlName, stripBom } = require('./names');
const { createAgent } = require('./agent');
const { createSemViews } = require('./semviews');
const { serveBridge } = require('./bridge');
const { PINS } = require('./vendored');
const { planExport, writeExport, buildDist, writeMarker, readMarker, fingerprint, localChanges, vendorSize, zip, rayfinYml } = require('./exportapp');
const { createFabricApp, tenantOf } = require('./fabricapp');
const { createOneLakeWriter } = require('./onelakewrite');
const { mapPool } = require('./http');

// OneLake accepts tokens in the storage
// audience only, and this one covers both the data reads and the Iceberg catalog. It is
// the only scope sign-in asks for; the Fabric API's (below) is asked for separately, and
// only once someone expands a workspace's semantic models.
const SCOPES = ['https://storage.azure.com/user_impersonation', 'offline_access'];

// The onelakeStudio.tenantId setting: the tenant to sign in to, or '' for the home one.
const tenantSetting = () => vscode.workspace.getConfiguration('onelakeStudio').get('tenantId', '').trim();

function withTenant(scopes) {
  const tenant = tenantSetting();
  // A guest in someone else's tenant has to say so; the home tenant is the default.
  return tenant ? [...scopes, `VSCODE_TENANT:${tenant}`] : scopes;
}

function scopesFor() { return withTenant(SCOPES); }

// `options` is passed straight through: the command handler asks with createIfNone (and,
// for a switch, clearSessionPreference), while the per-request calls ask for neither.
// That matters — reads come in bursts, and a prompt per request would be unusable.
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

// Which identity the cache and the engine currently belong to. Hashed, so the
// directory name says nothing about who the user is.
function accountKey(session) {
  if (!session || !session.account) return null;
  const tenant = tenantSetting();
  return require('node:crypto').createHash('sha256')
    .update(`${session.account.id}|${tenant}`).digest('hex').slice(0, 16);
}

// Which account the saved queries belong to, as their folder's name: its sign-in name and the
// tenant setting, readable on disk (unlike accountKey's hash) — the queries are the user's own.
function queryAccountOf(session) {
  if (!session || !session.account) return null;
  const tenant = tenantSetting();
  return `${session.account.label}${tenant ? ` (${tenant})` : ''}`.replace(/[\\/:*?"<>|]+/g, '_');
}

// getSession is an RPC into the account provider; asked once per request, that lookup —
// not OneLake, not DuckDB — was most of a burst's wait. So the token is held briefly in
// memory: long enough to collapse a burst, short enough that a stale one costs a single
// retry (catalog.js and the engine ask again with `fresh` after a 401). Anything that can
// change the answer clears it outright.
const TOKEN_TTL_MS = 60_000;
let cachedToken = null;   // { token, at }

function forgetToken() { cachedToken = null; cachedFabric = null; fabricAudience = null; cachedApp = null; }

async function hostToken({ fresh = false } = {}) {
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

// A session in `aud` for the account the storage session belongs to, never another one.
async function sameAccountSession(aud, createIfNone, storage) {
  return vscode.authentication.getSession('microsoft',
    withTenant([aud, 'offline_access']), { createIfNone, account: storage.account });
}

async function fabricToken({ fresh = false, createIfNone = false } = {}) {
  if (!fresh && !createIfNone && cachedFabric && Date.now() - cachedFabric.at < TOKEN_TTL_MS) {
    return cachedFabric.token;
  }
  const storage = await getSession({ createIfNone: false }).catch(() => null);
  if (!storage) return null;
  let lastErr = null;
  for (const aud of fabricAudience ? [fabricAudience] : FABRIC_AUDIENCES) {
    try {
      const s = await sameAccountSession(aud, createIfNone, storage);
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

// Export to Fabric's token (fabricapp.js): the Fabric API's own audience, never Power BI's —
// the app item's workload routes are the Fabric API's. The same account as the storage
// session, as fabricToken asks. `createIfNone` on the button's click, which may prompt.
let cachedApp = null;   // { token, at }
async function appToken({ fresh = false, createIfNone = false } = {}) {
  if (!fresh && !createIfNone && cachedApp && Date.now() - cachedApp.at < TOKEN_TTL_MS) return cachedApp.token;
  const storage = await getSession({ createIfNone: false }).catch(() => null);
  if (!storage) return null;
  const s = await sameAccountSession(FABRIC_AUDIENCES[0], createIfNone, storage);
  cachedApp = s ? { token: s.accessToken, at: Date.now() } : null;
  return s ? s.accessToken : null;
}

// The cache-first OneLake layer (onelake.js), built at activation and shared by the tree,
// the panel and everything else that reads OneLake.
let onelake = null;

// Nothing about a slow read is visible from the webview: every OneLake request is the
// host's, so the page cannot see how many there were, how long OneLake took, or whether
// the answer came off disk. This is the only place that knows, and "OneLake Studio" in
// the Output panel is where it says so. Idle by default — an output channel costs nothing
// until somebody opens it.
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

// One line per OneLake answer: a request the catalog made (`net`, with its time and
// status), or an answer the store served from disk (`hit`) — the two things a slow click
// can be made of.
function logRead(e) {
  tally(e);
  if (!out) return;
  const where = e.cache === 'hit' ? 'disk' : 'OneLake';
  const status = e.cache === 'hit' ? '' : String(e.status || '');
  const size = e.bytes ? ` ${(e.bytes / 1024).toFixed(0)}KB` : '';
  const path = e.path.length > 72 ? '…' + e.path.slice(-71) : e.path;
  out.appendLine(
    `${String(e.ms || 0).padStart(6)}ms  ${(e.cache === 'hit' ? 'hit' : 'net').padEnd(4)} ${status.padEnd(3)}` +
    `${size.padStart(9)}  ${where.padEnd(8)} ${path}` + (e.error ? `  !! ${e.error}` : ''));
}

// The click, measured end to end. The per-read lines say where each request's time went;
// this line is the number the user actually lived through — click to on-screen — which
// includes everything the reads cannot see: the catalog, the worker, the rendering. When
// an OPEN line is seconds and the read lines under it are milliseconds, the time went to
// one of those, and that difference is the diagnosis.
// The other half of a slow boot. The read log above is OneLake answering; these are the
// engine's own stages — creating the DuckDB instance, loading its extensions
// (from the vsix, or downloaded on first run). The engine host and the page both report
// here, so a boot whose reads are all fast hits and whose total is slow says which it was.
function logBoot(m) {
  if (!out) return;
  const stages = Array.isArray(m.stages) ? m.stages : [];
  out.appendLine(
    `${String(Number(m.totalMs) || 0).padStart(6)}ms  BOOT ${String(m.what || 'engine ready').slice(0, 80)}` +
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

// The engine's catalog listed from the cache, which a first SHOW ALL TABLES waits for.
function logCatalog(m) {
  if (out) out.appendLine(`${String(m.ms).padStart(6)}ms  CATALOG ${m.count} tables and models listed`);
}

// Who is waiting for the page to say a file is on screen (a semantic model's progress
// notification, which stays up until then): { label, resolve }.
const openedWaiters = new Set();
function whenOpened(label, ms = 60_000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { openedWaiters.delete(w); resolve(false); }, ms);
    const w = { label, resolve: v => { clearTimeout(timer); resolve(v); } };
    openedWaiters.add(w);
  });
}

function logOpened(m) {
  for (const w of openedWaiters) {
    if (w.label === m.label) { openedWaiters.delete(w); w.resolve(true); }
  }
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
  burst.reads++;
  if (e.cache === 'hit') { burst.hits++; burst.cacheBytes += e.bytes || 0; }
  else { burst.misses++; burst.netBytes += e.bytes || 0; burst.netMs += e.ms || 0; }
  if (!postTimer) postTimer = setTimeout(() => { postTimer = null; postReads(); }, POST_EVERY_MS);
  clearTimeout(idleTimer);
  // The settled number is the one worth reading, and it is also the one that arrives after
  // the last response — so the burst is reported once more when the reads stop, and the
  // next read after that starts a new one.
  idleTimer = setTimeout(() => { postReads(); burst = null; }, BURST_IDLE_MS);
}

function postReads() {
  if (!burst) return;
  postLive({ type: 'reads', ...burst });
  // The same burst, in the editor's own status bar — the panel's indicator is invisible
  // the moment its tab is hidden, which is exactly when a long wait is being sat through
  // from somewhere else.
  if (statusItem) {
    statusItem.text = `$(database) OneLake ${burst.hits} from disk · ${burst.misses} from OneLake`;
    statusItem.tooltip = `OneLake Studio — last burst: ${burst.reads} answer(s), ` +
      `${burst.hits} from disk, ${burst.misses} from OneLake ` +
      `(${(burst.netMs / 1000).toFixed(1)}s). Click for the read log.`;
    statusItem.show();
  }
}

// How long a catalog answer is served from disk with no network check at all. The user's
// number, because it IS the trade: bigger means table opens skip the catalog's
// seconds-per-call for longer, and a new snapshot takes that much longer to show up.
function catalogTtlMs() {
  const min = vscode.workspace.getConfiguration('onelakeStudio').get('catalogTtlMinutes', 5);
  return Number.isFinite(min) && min >= 0 ? Math.round(min * 60 * 1000) : 5 * 60 * 1000;
}

// The same, for a table's metadata (the catalog's loadTable — the slow call): a day by
// default. A new snapshot shows after that, or at once after a Refresh of its lakehouse.
function tableTtlMs() {
  const h = vscode.workspace.getConfiguration('onelakeStudio').get('tableMetadataTtlHours', 24);
  return Number.isFinite(h) && h >= 0 ? Math.round(h * 3600 * 1000) : 24 * 3600 * 1000;
}

// How much the store of listings and table metadata may hold, per account.
function storeMaxBytes() {
  const mb = vscode.workspace.getConfiguration('onelakeStudio').get('metadataCacheMaxMB', 256);
  return (Number.isFinite(mb) && mb > 0 ? mb : 256) * 1024 * 1024;
}

// The disk cache's folder for all accounts: `file-cache-v1` under the folder the setting names,
// or under the extension's storage. Always our own subfolder, so deleting an old cache can
// never reach the user's files.
function fileCacheRootFor(context) {
  const chosen = vscode.workspace.getConfiguration('onelakeStudio').get('cacheDirectory', '').trim();
  if (chosen && !isAbsolute(chosen)) {
    if (out) out.appendLine(`cacheDirectory "${chosen}" is not a full path — using the default`);
    return join(context.globalStorageUri.fsPath, 'file-cache-v1');
  }
  return join(chosen || context.globalStorageUri.fsPath, 'file-cache-v1');
}

// Real DuckDB, in this process. Built once and kept for the window's lifetime: an engine
// costs ~17ms to create but its extensions are loaded on first use, and doing that per
// panel open would be paying it again for nothing.
//
// Loaded lazily so a failure to load the native binding — an unsupported platform, a vsix
// built for another architecture — surfaces when the panel opens, with a message, rather
// than taking activation down with it.
let engine = null;
let engineAccount = null;   // the account (fileCacheAccount) the engine was built for

// Calls of fn one at a time, each after the last has settled.
function serialized(fn) {
  let last = Promise.resolve();
  return (...args) => {
    const run = last.then(() => fn(...args));
    last = run.catch(() => {});
    return run;
  };
}
// The account's turn: Switch Account, a tenant change and the session handler each rebind,
// close the panel and reset the engine. Run in turn, a handler that fires during a switch
// finds the switch done (the account already bound) instead of closing the panel the switch
// just opened.
const accountTurn = serialized(body => body());

// The engine's disk cache of what it reads from OneLake (engine-host.js, cache_httpfs): one
// directory per account, like the store. Cached bytes are served without OneLake being
// asked, so they must never be served to a different account. Set at activation and
// whenever the account moves; null when signed out, which runs the engine without it.
let fileCacheRoot = null;
let fileCacheAccount = null;
const fileCacheDirFor = key => (fileCacheRoot && key ? join(fileCacheRoot, key) : null);

// The size of a directory's files, and their removal — for the disk cache.
async function dirBytes(dir) {
  if (!dir) return 0;
  let n = 0;
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    const st = await fsp.stat(join(dir, name)).catch(() => null);
    if (st && st.isFile()) n += st.size;
  }
  return n;
}
const removeDir = dir => (dir ? fsp.rm(dir, { recursive: true, force: true }).catch(() => {}) : Promise.resolve());
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
  // An engine holds its account's token and disk cache: one built before the account moved
  // is closed, with the panel over it, never handed to the new account.
  if (engine && engineAccount !== fileCacheAccount) {
    const old = engine;
    engine = null;
    closePanel();
    old.close().catch(() => {});
  }
  if (engine) return engine;
  try {
    engineAccount = fileCacheAccount;
    fileCacheRoot = fileCacheRootFor(context);
    const config = vscode.workspace.getConfiguration('onelakeStudio');
    const diskCacheGB = Math.max(0, Number(config.get('diskCacheMaxGB', 64)) || 0);
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
      onCatalog: logCatalog,
      // A failed optional extension is worth a line where someone will find it.
      onWarn: w => out && out.appendLine(w),
      // DuckDB talks to OneLake itself, on the same cached, silent token — reads must
      // never prompt.
      // Options pass through so the engine's auth retry can say { fresh: true } and
      // actually get PAST this cache — asking it again inside the 60s window returns
      // the very token that just expired, and the retry becomes a no-op.
      getToken: opts => hostToken(opts),
      memoryLimit: config.get('engineMemoryLimit', '').trim(),
      threads: Math.max(0, Math.floor(Number(config.get('engineThreads', 0)) || 0)),
      spillMaxGB: Math.max(0, Number(config.get('engineSpillMaxGB', 0)) || 0),
      maxRows: Math.min(1_000_000, Math.max(1000, Math.floor(Number(config.get('maxResultRows', 200_000)) || 200_000))),
      // 0 is no disk cache at all.
      fileCacheDir: diskCacheGB > 0 ? fileCacheDirFor(fileCacheAccount) : null,
      fileCacheMaxBytes: diskCacheGB * 1024 ** 3,
      resolveTable: ref => (resolveSqlTable ? resolveSqlTable(ref) : Promise.reject(new Error('OneLake Studio is still starting'))),
      catalogTables: () => (cachedSqlTables ? cachedSqlTables() : Promise.resolve([])),
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
// OneLake for as long as the token lasts. ensureEngine builds it again on the next open, in
// a few seconds.
async function resetEngine() {
  const e = engine;
  engine = null;
  if (e) await e.close().catch(() => {});
}

// Points the store and the engine's disk cache at the account now signed in; a no-op when
// it has not moved. Set by activateInner, which owns the store.
let rebindStore = async () => {};
// The semantic views this machine keeps (semviews.js), per account; set by activateInner.
let semviews = null;
// Export to Fabric (exportapp.js), the page's fabric.exportExplore; set by activateInner,
// which owns the agent's modules.
let exportExplore = null;
// A table's SQL name (lakehouse.ws.item.schema.table) -> what it reads, for the engine; and
// a semantic model's Direct Lake tables (by GUID) -> their SQL names. Set by activateInner,
// which owns the store, the Fabric API and the agent's modules.
let resolveSqlTable = null;
// Every table the store holds with its columns, for the engine's catalog (SHOW ALL TABLES)
// — read from the store alone, never from OneLake. Set by activateInner.
let cachedSqlTables = null;
// A semantic model a query names (semanticmodel.ws.model), opened: its local copy kept, and
// kept as a semantic view. Set by activateInner.
let openSqlModel = null;
let nameModelTables = null;
// The query editors' side of the panel (queryeditor.js): Edit SQL opens a new one, and a
// statement one sent comes back with how it went. Set by activateInner.
let editSql = null;
let queryDone = null;

// `place`: where the panel goes, for a query run from an editor (panel.js openPanel).
async function show(context, options, place) {
  if (revealPanel(place)) return true;
  const token = await getToken(options);
  if (!token) {
    const why = lastAuthError ? `Sign-in failed: ${lastAuthError.message || lastAuthError}`
                              : 'Sign-in was cancelled.';
    vscode.window.showWarningMessage(
      `OneLake Studio needs a Microsoft account to reach OneLake. ${why}`);
    return false;
  }
  // BEFORE the engine is built: a window that activated signed out and signs in right here
  // used to build its engine with no disk cache (fileCacheAccount still null) for the whole
  // session, and serve the panel from the signed-out store.
  await rebindStore();
  // A platform whose native binding will not load is told plainly, instead of being
  // handed a panel that boots to a spinner and never moves.
  const { readme } = await webviewRoot(context.extensionUri,
    { dev: context.extensionMode === vscode.ExtensionMode.Development });
  const eng = ensureEngine(context, { readme: readme.fsPath });
  if (!eng) return false;
  await openPanel(context, {
    onOpened: logOpened, onBoot: logBoot, engine: eng, build: buildInfo, place,
    host: createHostMethods({
      onelake, engine: eng, onStatus: message => postLive({ type: 'status', message }),
      saveFile, semviews, modelsDir: modelsFolder(),
      // A refusal is what Explore's info line says, not a failure of the export.
      exportExplore: x => (exportExplore ? exportExplore(x).catch(e => { if (e.declined) return e.message; throw e; })
        : Promise.reject(new Error('OneLake Studio is still starting'))),
      nameTables: list => (nameModelTables ? nameModelTables(list) : Promise.reject(new Error('OneLake Studio is still starting'))),
      copyText: text => vscode.env.clipboard.writeText(text),
      exportResult: x => exportResult(eng, x),
      openDocument: async ({ as, content }) => {
        // CSV as plain text unless an extension knows the language.
        const language = as === 'json' ? 'json' : (await vscode.languages.getLanguages()).includes('csv') ? 'csv' : 'plaintext';
        const doc = await vscode.workspace.openTextDocument({ language, content });
        await vscode.window.showTextDocument(doc, { preview: false });
      },
      editSql: x => (editSql ? editSql(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
      queryDone: x => { if (queryDone) queryDone(x); },
      openModel: x => (openSqlModel ? openSqlModel(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
    }),
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

// Where a semantic model's local copy is kept (fetchModel), for the tree, the command line
// and the panel alike: <folder>/<workspace>/<model>.yaml.
// What a new query (the Queries node's +) starts with. SHOW ALL TABLES is answered from the
// cache (cachedSqlTables), so it lists only the tables seen in the tree.
const NEW_QUERY_SQL = [
  '-- New query. A table is named lakehouse.workspace.item.schema.table.',
  '-- This lists only the tables cached on this machine: expand a lakehouse in the OneLake tree to add its tables.',
  'SHOW ALL TABLES;',
  '',
].join('\n');

function modelsFolder() {
  return join(os.homedir(), 'OneLakeStudio', 'semantic-models');
}

// Where a CSV or a OneLake file the panel saves goes: the editor's own save dialog,
// starting in the workspace folder (or the home directory), then a plain write.
// Export: every row of `sql`, written by the engine (engine-host.js exportTo) and moved to the
// file the user picks. Answers its path, or null when dismissed.
async function exportResult(eng, { sql, name }) {
  const { capabilities = {} } = await eng.call('info').catch(() => ({}));
  const formats = [
    { label: 'CSV', description: 'every row, with a header line', format: 'csv' },
    { label: 'Parquet', description: 'every row, its columns typed', format: 'parquet' },
    ...(capabilities.excel ? [{ label: 'Excel', description: 'every row, one sheet', format: 'xlsx' }] : []),
  ];
  const pick = await vscode.window.showQuickPick(formats, { title: 'Export the Query', placeHolder: 'Every row the query returns, to a file' });
  if (!pick) return null;
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  const base = folder ? folder.uri : vscode.Uri.file(os.homedir());
  const stem = String(name).replace(/[\\/:*?"<>|]+/g, '_') || 'query';
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(base, `${stem}.${pick.format}`),
    filters: { [pick.label]: [pick.format] },
  });
  if (!uri) return null;
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting to ${basename(uri.fsPath)}` }, async () => {
    const tmp = await eng.exportTo(sql, pick.format);
    try { await fsp.copyFile(tmp, uri.fsPath); } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
    return uri.fsPath;
  });
}

async function saveFile(name, bytes) {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  const base = folder ? folder.uri : vscode.Uri.file(os.homedir());
  const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(base, name) });
  if (!uri) return null;
  await vscode.workspace.fs.writeFile(uri, typeof bytes === 'function' ? await bytes() : bytes);
  return uri.fsPath;
}

// The tree and the welcome view are two states of one view: the welcome buttons show
// while this is false. Kept in a context key rather than asked for on every render, so a
// collapsed tree costs no token lookups.
let signedIn = false;
// Which build this window runs, for the panel's status bar: set at activation.
let buildInfo = {};
async function setSignedIn(value) {
  signedIn = value;
  await vscode.commands.executeCommand('setContext', 'onelakeStudio.signedIn', value);
}

// The exact commit this window is running. Installed build: the stamp stage-webview.mjs
// wrote into webview/build.json at package time (already '+dirty'-labelled when the tree was).
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
    const stamp = JSON.parse(require('node:fs').readFileSync(
      join(context.extensionUri.fsPath, 'webview', 'build.json'), 'utf8'));
    if (stamp && stamp.commit) return String(stamp.commit);
  } catch (_) {}
  return 'unknown';
}

// ---------------------------------------------------------------------------
// The agent skill (Claude Code, GitHub Copilot)
// ---------------------------------------------------------------------------
// bin/cli.mjs is this extension's modules from a shell; claude-skill/SKILL.md tells an agent
// when and how to run it. Installing writes the skill to ~/.claude/skills/onelake/ — read by
// Claude Code and by GitHub Copilot in VS Code, so one copy serves both — with the
// path of THIS install's cli.mjs filled in — a path that changes with every update, so a skill
// this extension wrote (it carries the marker) is rewritten at each activation. One the user
// wrote themselves, without the marker, is never touched unless they ask.
const SKILL_MARKER = 'Installed by the OneLake Studio extension';
const skillFile = () => join(os.homedir(), '.claude', 'skills', 'onelake', 'SKILL.md');

async function writeSkill(context) {
  const template = await fsp.readFile(join(context.extensionUri.fsPath, 'claude-skill', 'SKILL.md'), 'utf8');
  const cli = join(context.extensionUri.fsPath, 'bin', 'cli.mjs').replace(/\\/g, '/');
  const text = template.split('{{cli}}').join(cli);
  const file = skillFile();
  const before = await fsp.readFile(file, 'utf8').catch(() => null);
  if (before === text) return false;
  await fsp.mkdir(dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
  return true;
}

async function refreshSkill(context) {
  const before = await fsp.readFile(skillFile(), 'utf8').catch(() => null);
  if (before && before.includes(SKILL_MARKER) && await writeSkill(context)) {
    if (out) out.appendLine(`agent skill updated at ${skillFile()}`);
  }
}

async function installSkill(context) {
  const existing = await fsp.readFile(skillFile(), 'utf8').catch(() => null);
  if (existing && !existing.includes(SKILL_MARKER)) {
    const pick = await vscode.window.showWarningMessage(
      `${skillFile()} exists and was not written by OneLake Studio. Replace it?`, { modal: true }, 'Replace');
    if (pick !== 'Replace') return;
  }
  await writeSkill(context);
  vscode.window.showInformationMessage(
    'OneLake Studio: Claude Code and GitHub Copilot can now answer questions about your OneLake data and semantic models, ' +
    'through this extension while VS Code is open. It needs Node.js on PATH.',
    'Open Skill').then(pick => {
    if (pick === 'Open Skill') vscode.window.showTextDocument(vscode.Uri.file(skillFile()));
  });
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
  // know they are looking at the same build. Same stamp discipline as stage-webview.mjs:
  // '+dirty' whenever the code running is not exactly the commit named.
  const version = (context.extension && context.extension.packageJSON &&
                   context.extension.packageJSON.version) || '?';
  const dev = context.extensionMode === vscode.ExtensionMode.Development;
  const commit = buildCommit(context, dev);
  buildInfo = { version, commit, dev };
  const buildItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
  buildItem.name = 'OneLake Studio build';
  buildItem.text = `$(database) OneLake ${version} · ${commit}${dev ? ' · dev' : ''}`;
  buildItem.tooltip = dev
    ? `OneLake Studio ${version} at commit ${commit}, running from the checkout (F5) — the panel serves app/`
    : `OneLake Studio ${version}, packaged at commit ${commit}`;
  buildItem.command = 'onelakeStudio.showLog';
  buildItem.show();
  context.subscriptions.push(buildItem);

  // A failure past this point used to be INVISIBLE: activation dies half-way, the view
  // renders as an empty pane — no tree, no welcome content, no message anywhere. The
  // rest of activate is guarded so that shape can never be silent again.
  let started, failed;
  const ready = new Promise((resolve, reject) => { started = resolve; failed = reject; });
  ready.catch(() => {});   // reported below; whoever is waiting on it hears it too
  try {
    await activateInner(context, ready);
    started();
    // After an update the skill still names the previous install's cli.mjs. Not awaited:
    // nothing on screen depends on it.
    refreshSkill(context).catch(e => out.appendLine(`agent skill not refreshed: ${e.message}`));
    out.appendLine(`activated ${version} ${commit}${dev ? ' (dev)' : ''} — signed in: ${signedIn}`);
  } catch (e) {
    failed(e);
    out.appendLine(`ACTIVATION FAILED: ${(e && e.stack) || e}`);
    showError(`OneLake Studio failed to activate: ${(e && e.message) || e}`);
    throw e;
  }
}

async function activateInner(context, ready) {
  // Query editors (queryeditor.js): a saved query's file, or a new query opened here, untitled
  // until Save Query keeps it under Queries. Only these get Run, the lenses and the completions:
  // any other .sql file is its own extensions'.
  // First, and before any await: the sign-in below can queue behind other extensions for a minute
  // and more, and none of this needs to know who is signed in. What does waits for `ready`.
  const queriesRoot = () => join(os.homedir(), 'OneLakeStudio', 'queries');
  const tabUri = t => (t.input && t.input.uri ? t.input.uri.toString() : null);
  const openTabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs).map(tabUri).filter(Boolean);
  const isQueryFile = p => {
    const rel = p ? relative(queriesRoot(), p) : '';
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
  };
  // By where it is, whatever its language says: another SQL extension can take over a .sql
  // document's language (VS Code closes and reopens it to do so), and it is still a query here.
  // The title bar's buttons and the keys go by the same path in the window (package.json), so
  // they are there even while another extension holds this host, or before this one has started.
  const isQuery = doc => (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') && isQueryFile(doc.uri.fsPath);
  // Nothing to complete from yet: an empty answer, since the suggest widget waits for every answer.
  let isReady = false;
  ready.then(() => { isReady = true; }, () => {});
  context.subscriptions.push(
    ...registerQueryEditor({ isQuery,
                             run: (sql, x) => ready.then(() => runInPanel(sql, x)),
                             names: async () => (isReady ? completionNames() : { tables: [], models: [] }) }),
    // Save Query: a new query kept under Queries as "Query N", and its editor is that file from
    // then on. A saved query's editor just saves.
    vscode.commands.registerCommand('onelakeStudio.saveQuery', async uri => {
      // From the title bar the document comes with the command: the button shows on a query's
      // group while the panel has the focus, and then no text editor is the active one.
      const active = vscode.window.activeTextEditor;
      const target = uri instanceof vscode.Uri ? uri : active && active.document.uri;
      if (!target) return;
      const doc = await vscode.workspace.openTextDocument(target);
      if (!isQuery(doc)) return;
      if (!doc.isUntitled) { await doc.save(); return; }
      try {
        await ready;
        const saved = await saveNewQuery(doc.getText());
        // Closing the active editor is how it becomes the file, so its own editor is made active
        // first, in the group its tab is in: never the panel, or whatever was moved to meanwhile.
        const group = vscode.window.tabGroups.all.find(g => g.tabs.some(t => tabUri(t) === doc.uri.toString()));
        const ed = await vscode.window.showTextDocument(doc, { viewColumn: group ? group.viewColumn : undefined, preview: false });
        const column = ed.viewColumn;
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await vscode.window.showTextDocument(vscode.Uri.file(saved.path), { viewColumn: column, preview: false });
        vscode.window.setStatusBarMessage(`Saved as ${saved.name} under Queries — rename it there`, 4000);
      } catch (e) {
        showError(`Could not save the query: ${(e && e.message) || e}`);
      }
    }),
  );

  // Every OneLake request the extension makes goes through here, on the VS Code token,
  // and each one is a line in the read log.
  const catalog = createCatalog({
    getToken: hostToken,
    onRequest: logRead,
  });
  // Semantic models and their export: Fabric's token for the model, the storage one
  // (the same cache the catalog uses) for the one file the export writes.
  const fabric = createFabric({ getFabricToken: fabricToken });
  // Direct Lake item GUIDs -> the names the tree uses (nameModelTables), per account.
  const itemNames = new Map();

  // What the extension knows about OneLake, kept on disk per account and served from there
  // first (onelake.js). One directory per identity — a hashed account id — so nobody is
  // ever shown another account's listings, and switching back finds its cache still warm.
  const storeRoot = join(context.globalStorageUri.fsPath, 'onelake-store-v1');
  const storeFor = key => createStore({ dir: join(storeRoot, key || 'signed-out'), ttlMs: catalogTtlMs, maxBytes: storeMaxBytes() });
  const firstSession = await getSession({ createIfNone: false }).catch(() => null);
  let storeAccount = accountKey(firstSession);
  // The saved queries' account (queriesFolder): its own folder, by its sign-in name.
  let queryAccount = queryAccountOf(firstSession);
  fileCacheRoot = fileCacheRootFor(context);
  fileCacheAccount = storeAccount;
  onelake = createOneLake({
    catalog,
    store: storeFor(storeAccount),
    onHit: logRead,
    prefetchEnabled: () => vscode.workspace.getConfiguration('onelakeStudio').get('prefetchMetadata', true),
    tableTtlMs,
    // A workspace's semantic models are a listing too, kept in the same store.
    fabric,
  });
  // Semantic views: pointers to model files, kept per account in the extension's storage.
  // A view made or dropped is in the engine's catalog (SHOW ALL TABLES) by the next statement.
  semviews = createSemViews({ dir: join(context.globalStorageUri.fsPath, 'semantic-views'), onelake,
                              onChange: () => { if (engine) engine.catalogChanged(); } });
  semviews.useAccount(storeAccount);

  // Called wherever the identity may have moved; a no-op when it has not.
  // One at a time: two callers at once could both see the old account, or one return while
  // the other was still moving the store.
  rebindStore = serialized(async function rebindStore() {
    const session = await getSession({ createIfNone: false }).catch(() => null);
    const key = accountKey(session);
    if (key === storeAccount) return;
    storeAccount = key;
    // Workspace and item GUIDs belong to the account's tenant: listed again for the new one.
    fabric.reset();
    itemNames.clear();
    // Another account's saved queries, too.
    queryAccount = queryAccountOf(session);
    await adoptLooseQueries().catch(() => {});
    tree.queriesChanged();
    fileCacheAccount = key;   // the engine picks it up when it is next built
    onelake.useStore(storeFor(key));
    if (engine) engine.catalogChanged();
    semviews.useAccount(key);
  });
  // What the store holds moved: the engine's catalog is listed again before the next
  // statement that reads it.
  const catalogMoved = () => { if (engine) engine.catalogChanged(); };
  context.subscriptions.push({ dispose: onelake.onChanged(catalogMoved) },
                             { dispose: onelake.onTableRead(catalogMoved) });
  context.subscriptions.push({ dispose: onelake.onRefreshFailed((what, e) => {
    // The cached answer stays on screen; why it could not be refreshed goes here.
    if (out) out.appendLine(`refresh of ${what.kind} ${[what.workspace, what.item, what.schema, what.table]
      .filter(Boolean).join('/')} failed — ${(e && e.message) || e}`);
  }) });

  // Pinned workspaces, per Microsoft account, in VS Code's own storage: they survive
  // restarts and updates, and one account's pins never show up under another.
  const favKey = () => `onelakeStudio.favorites.${storeAccount || 'signed-out'}`;
  const favorites = {
    get: () => context.globalState.get(favKey(), []),
    set: list => context.globalState.update(favKey(), [...new Set(list)].sort((a, b) => a.localeCompare(b))),
  };

  // The explorer's top level: workspaces, or one heading per item type across them (tree.js
  // _byType) — the title-bar toggle, remembered across windows and restarts. The context key
  // picks which button shows.
  const GROUP_KEY = 'onelakeStudio.groupByType';
  const groupByType = () => context.globalState.get(GROUP_KEY, false);
  const setGrouped = async on => {
    await context.globalState.update(GROUP_KEY, on);
    await vscode.commands.executeCommand('setContext', 'onelakeStudio.groupedByType', on);
  };
  await vscode.commands.executeCommand('setContext', 'onelakeStudio.groupedByType', groupByType());

  const tree = new LakehouseTree({
    onelake,
    favorites,
    groupByType,
    fabric,
    hasFabric: async () => !!await fabricToken().catch(() => null),
    isSignedIn: () => signedIn,
    cachedModel: n => cachedModel(n),
    queries: { list: () => listQueries() },
    unsupportedModel: n => unsupportedModels.get(modelKey(n)) || null,
    iconPath: name => vscode.Uri.joinPath(context.extensionUri, 'media', `${name}.svg`),
    // A listing failure becomes an error NODE, but the stack behind it goes here.
    log: m => out && out.appendLine(m),
  });

  await setSignedIn(!!await getToken({ createIfNone: false }));

  // Opening a table means: make sure a panel exists, then tell it what to show. The panel
  // buffers the message if DuckDB is still booting. Boot is multi-second work with no
  // editor-side sign of life until now — withProgress is that sign.
  const showWithProgress = (options, place) => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Opening OneLake Studio…' },
    () => show(context, options, place));

  // Whether the panel is there to take it.
  async function openInPanel(msg, place) {
    if (!await showWithProgress({ createIfNone: true }, place)) return false;
    postToPanel(msg);
    return true;
  }

  // Saved queries: one .sql file each in ~/OneLakeStudio/queries/<account>/, beside the
  // downloaded models. They name their tables lakehouse.workspace.item.schema.table — names
  // that mean something in one tenant only — so each account (and tenant, when the
  // onelakeStudio.tenantId setting picks one) has its own, and signing in elsewhere shows
  // that account's. The tree lists them, and each opens in VS Code's editor as its file.
  // Signed out, there are none.
  function queriesFolder() {
    return queryAccount ? join(queriesRoot(), queryAccount) : null;
  }
  // Queries saved before they were kept per account sit loose in the root: they go to the
  // first account signed in, the one most likely to have saved them. Never over one there.
  async function adoptLooseQueries() {
    const dir = queriesFolder();
    if (!dir) return;
    const loose = (await fsp.readdir(queriesRoot(), { withFileTypes: true }).catch(() => []))
      .filter(e => e.isFile() && /\.sql$/i.test(e.name));
    if (!loose.length) return;
    await fsp.mkdir(dir, { recursive: true });
    for (const e of loose) {
      if (existsSync(join(dir, e.name))) continue;
      await fsp.rename(join(queriesRoot(), e.name), join(dir, e.name)).catch(() => {});
    }
    if (out) out.appendLine(`saved queries: ${loose.length} moved into ${dir}`);
  }
  adoptLooseQueries().then(() => tree.queriesChanged(), () => {});
  async function listQueries() {
    const dir = queriesFolder();
    if (!dir) return [];
    const files = await fsp.readdir(dir).catch(() => []);
    return files.filter(f => /\.sql$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map(f => ({ name: f.replace(/\.sql$/i, ''), path: join(dir, f) }));
  }
  // A name as a file name: what Windows refuses becomes _, and the .sql is ours to add.
  const queryStem = name => String(name).trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\.sql$/i, '');
  const queryPath = name => join(queriesFolder(), `${queryStem(name)}.sql`);
  const askQueryName = (title, value) => vscode.window.showInputBox({
    title, value, prompt: `Kept in ${queriesFolder()}`,
    validateInput: v => (queryStem(v) ? null : 'A query needs a name'),
  });
  // Saving over another query is asked first; saving the query that is open is just a save.
  async function mayReplace(path, current) {
    if (current && queryPath(current).toLowerCase() === path.toLowerCase()) return true;
    if (!existsSync(path)) return true;
    const pick = await vscode.window.showWarningMessage(`A query named ${basename(path, '.sql')} already exists.`,
      { modal: true }, 'Replace');
    return pick === 'Replace';
  }
  // A new query kept under Queries as the next free "Query N", with nothing asked (Rename in
  // the tree names it). Answers { name, path }.
  async function saveNewQuery(sql) {
    if (!queriesFolder()) throw new Error('sign in to save queries — they are kept per account');
    await fsp.mkdir(queriesFolder(), { recursive: true });
    const taken = new Set((await listQueries()).map(q => q.name.toLowerCase()));
    let n = 1;
    while (taken.has(`query ${n}`)) n++;
    const stem = `Query ${n}`;
    const path = queryPath(stem);
    await fsp.writeFile(path, String(sql ?? ''), 'utf8');
    tree.queriesChanged();
    return { name: stem, path };
  }

  // Where a query's results go (onelakeStudio.resultsLocation): under its editor, or beside it.
  const resultsBelow = () => vscode.workspace.getConfiguration('onelakeStudio').get('resultsLocation', 'below') !== 'beside';
  // A query editor opens where the panel is not covered by it for long. Results below: in the
  // panel's group, and the panel moves under it (dockBelowEditor). Beside: in another column.
  const queryColumn = () => {
    const p = panelColumn();
    if (p == null) return vscode.ViewColumn.Active;
    if (resultsBelow()) {
      // Beside the other queries, above the panel; the panel's own group only when it is the
      // one group there is (the panel then moves under it): never a new row per query.
      const other = [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors]
        .find(e => e && e.viewColumn != null && e.viewColumn !== p);
      return other ? other.viewColumn : p;
    }
    return p === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
  };
  async function showQuery(docOrUri, opts) {
    await vscode.window.showTextDocument(docOrUri, { viewColumn: queryColumn(), ...opts });
    if (resultsBelow()) await dockBelowEditor();
  }
  // The first "Query N" nothing holds: not a tab, a document, or a file, since VS Code refuses an
  // untitled document whose path is a file that exists. The path is what makes it a query, and
  // an absolute one is the same URI after a reload; File > Save writes there.
  function newQueryUri() {
    const inUse = new Set([...openTabs(), ...vscode.workspace.textDocuments.map(d => d.uri.toString())]);
    for (let n = 1; ; n++) {
      const path = join(queriesRoot(), `Query ${n}.sql`);
      const uri = vscode.Uri.file(path).with({ scheme: 'untitled' });
      if (!inUse.has(uri.toString()) && !existsSync(path)) return uri;
    }
  }
  async function openNewQuery(sql) {
    const uri = newQueryUri();
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = String(sql ?? '');
    if (text) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(0, 0), text);
      await vscode.workspace.applyEdit(edit);
    }
    await showQuery(doc);
  }
  const openSavedQuery = path => showQuery(vscode.Uri.file(path), { preview: false });
  editSql = ({ sql }) => openNewQuery(sql);

  // A statement sent to the panel waits here for the page's answer (host.queryDone).
  const runs = new Map();   // id -> resolve
  let runIds = 0;
  queryDone = x => {
    const settle = runs.get(x.id);
    if (settle) { runs.delete(x.id); settle(x); }
  };
  // Query variables for this session, by lower-cased name: SET VARIABLE in a query editor sets
  // one, getvariable('name') reads it, and one never set is asked for the first time it is read.
  const variables = new Map();
  async function bindQueryVariables(sql) {
    for (const name of variablesIn(sql)) {
      if (variables.has(name.toLowerCase())) continue;
      const typed = await vscode.window.showInputBox({
        title: `getvariable('${name}')`, prompt: `A value for ${name}, kept for this session (SET VARIABLE ${name} = … changes it)`,
        placeHolder: 'a number, or text (quoted for you)', ignoreFocusOut: true,
      });
      if (typed === undefined) return null;
      variables.set(name.toLowerCase(), literal(typed));
    }
    return bindVariables(sql, variables);
  }

  async function runInPanel(sql, { plan, title, column, key }) {
    // SET VARIABLE is the editor's, not the engine's: kept here and answered at once.
    const set = setVariable(sql);
    if (set) {
      // Bound now: DuckDB never holds the variables, so getvariable('a') in b's value would be NULL.
      const value = await bindQueryVariables(set.value);
      if (value == null) return null;
      variables.set(set.name.toLowerCase(), value);
      vscode.window.setStatusBarMessage(`OneLake Studio: ${set.name} = ${value}`, 5000);
      return { ok: true, error: null };
    }
    const bound = await bindQueryVariables(sql);
    if (bound == null) return null;
    sql = bound;
    const id = ++runIds;
    const answer = new Promise(resolve => runs.set(id, resolve));
    // A panel closed before it answered never will: the oldest wait is let go.
    if (runs.size > 20) { const [old] = runs.keys(); runs.get(old)(null); runs.delete(old); }
    const sent = await openInPanel({ type: plan ? 'plan-sql' : 'run-sql', id, sql, title, key },
                                   { beside: true, from: column, below: resultsBelow() });
    if (!sent) { runs.delete(id); return null; }
    return answer;
  }

  // Go to: every table, column, semantic model and measure the cache holds, in one search. A
  // pick opens it (a column or a measure: its table or model), or, from a query editor, its
  // button puts its SQL name at the cursor.
  async function goTo() {
    const editor = vscode.window.activeTextEditor;
    const intoEditor = editor && isQuery(editor.document);
    const button = intoEditor ? { iconPath: new vscode.ThemeIcon('insert'), tooltip: 'Put its SQL name in the query' }
                              : { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'Copy its SQL name' };
    const qp = vscode.window.createQuickPick();
    qp.title = 'Go to a Table, Column or Measure';
    qp.placeholder = 'Search what the cache holds: expand a lakehouse or open a model in the tree to add to it';
    qp.matchOnDescription = true;
    qp.busy = true;
    qp.show();
    const items = [];
    try {
      const { tables, models } = await completionNames();
      for (const t of tables) {
        const full = sqlName(t);
        items.push({ label: `$(table) ${t.table}`, description: full, detail: `${t.columns.length} columns`, sql: full, open: { table: t }, buttons: [button] });
        for (const c of t.columns) {
          items.push({ label: `$(symbol-field) ${c.name}`, description: `${full} · ${c.type || ''}`, sql: sqlPart(c.name), open: { table: t }, buttons: [button] });
        }
      }
      for (const m of models) {
        const full = modelSqlName(m.workspace, m.model);
        items.push({ label: `$(graph) ${m.model}`, description: full, detail: 'semantic model', sql: full, open: { model: m }, buttons: [button] });
        for (const name of m.measures) {
          items.push({ label: `$(symbol-function) ${name}`, description: `${full} · measure`, sql: `AGG(${quoteIdent(name)})`, open: { model: m }, buttons: [button] });
        }
      }
    } catch (e) {
      qp.dispose();
      return showError(`Could not read the cache: ${(e && e.message) || e}`);
    }
    qp.items = items;
    qp.busy = false;
    const put = async it => {
      if (intoEditor) await editor.edit(b => b.replace(editor.selection, it.sql));
      else { await vscode.env.clipboard.writeText(it.sql); vscode.window.setStatusBarMessage(`Copied ${it.sql}`, 3000); }
    };
    qp.onDidTriggerItemButton(async e => { qp.hide(); await put(e.item); });
    qp.onDidAccept(async () => {
      const it = qp.selectedItems[0];
      qp.hide();
      if (!it) return;
      if (it.open.table) {
        const t = it.open.table;
        await openInPanel({ type: 'open-table', workspace: t.workspace, item: t.itemDir, schema: t.schema, table: t.table });
      } else if (it.open.model) {
        const m = it.open.model;
        if (!m.modelId) return showError(`${m.model}: open it once from its workspace in the tree`);
        await openModel({ kind: 'semanticModel', workspace: m.workspace, model: m.model, modelId: m.modelId });
      }
    });
    qp.onDidHide(() => qp.dispose());
  }

  // What completion can name, from the cache alone (cachedSqlTables, below): every cached table
  // with its columns, every semantic model, and the measures and columns of a model kept as a
  // view (its local file; one in OneLake gives its name only). Read again after a minute.
  let namesKept = null;
  function completionNames() {
    if (namesKept && Date.now() - namesKept.at < 60_000) return namesKept.value;
    const value = (async () => {
      const found = cachedSqlTables ? await cachedSqlTables() : [];
      const tables = found.filter(f => f.kind !== MODEL_CATALOG && f.table).map(f => ({ ...f, columns: f.columns || [] }));
      const models = new Map();
      for (const f of found) {
        if (f.kind !== MODEL_CATALOG) continue;
        const key = `${f.workspace}|${f.model}`.toLowerCase();
        const m = models.get(key);
        if (m) m.modelId = m.modelId || f.modelId;
        else models.set(key, { workspace: f.workspace, model: f.model, modelId: f.modelId, measures: [], columns: [] });
      }
      for (const v of await semviews.list().catch(() => [])) {
        const m = v.schema && v.path && models.get(`${v.schema}|${v.name}`.toLowerCase());
        if (!m) continue;
        try {
          const { semantic, compiler } = await agent.modules();
          const bim = semantic.bimOf(v.path, await fsp.readFile(v.path, 'utf8'), compiler);
          for (const t of (bim.model || bim).tables || []) {
            for (const x of t.measures || []) m.measures.push(x.name);
            for (const c of t.columns || []) if (!c.isHidden) m.columns.push({ table: t.name, name: c.name });
          }
        } catch (_) { /* a file in OneLake, or one that cannot be read: its name alone */ }
      }
      return { tables, models: [...models.values()] };
    })();
    namesKept = { at: Date.now(), value };
    value.catch(() => { namesKept = null; });
    return value;
  }

  context.subscriptions.push(
    // Each query editor has its own last result: moving to one shows it in the panel, when the
    // panel is showing a query (not a table or a file someone opened).
    vscode.window.onDidChangeActiveTextEditor(ed => {
      if (ed && isQuery(ed.document)) postLive({ type: 'show-kept', key: ed.document.uri.toString() });
    }),
  );

  const modelPath = n => join(modelsFolder(),modelFileName(n.workspace).replace(/\.yaml$/, ''), modelFileName(n.model));

  // A model's local copy (fetchModel), when there is one: the tree's check mark.
  const modelKey = n => `${n.workspace}|${n.modelId}`;
  const cachedModel = n => (existsSync(modelPath(n)) ? modelPath(n) : null);

  // Models a click found it cannot open (Import, DirectQuery, Direct Lake over a SQL endpoint
  // or several lakehouses), for this session: key -> what kind it is. The tree marks them,
  // and a second click says so again without reading the definition from Fabric again.
  const unsupportedModels = new Map();
  const unsupportedNote = (n, mode) =>
    `${n.model} is ${mode}. OneLake Studio opens Direct Lake models over OneLake only.`;

  // The command line (cli.mjs) rings here: its questions are answered by THIS extension —
  // its sign-in, its cache, its engine — so an agent in a terminal reads what the tree and
  // the panel read, with no second sign-in and no second cache.
  const dev = context.extensionMode === vscode.ExtensionMode.Development;
  const agent = createAgent({
    onelake, semviews,
    modelPath: (ws, model) => modelPath({ workspace: ws, model }),
    engine: async () => {
      const { readme } = await webviewRoot(context.extensionUri, { dev });
      const eng = ensureEngine(context, { readme: readme.fsPath });
      if (!eng) throw new Error('DuckDB could not be loaded on this platform — see OneLake Studio: Show Read Log');
      return eng;
    },
    appDir: (await webviewRoot(context.extensionUri, { dev })).page.fsPath,
    vendorDir: join(context.extensionUri.fsPath, 'vendor'),
    daxSqlPin: PINS.daxSql,
    yamlPin: PINS.yaml,
    // `export`: Explore's own Export to Fabric (below), and the .yaml the tree wrote for a model.
    exportApp: x => (exportExplore ? exportExplore(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
    fetchModel: n => fetchModel(n, { fresh: true }),
    openModel: x => openSqlModel(x),
    nameTables: list => nameModelTables(list),
    signedIn: () => signedIn,
  });
  context.subscriptions.push(serveBridge({
    handle: (req, ctx) => {
      if (out) out.appendLine(`command line: ${(req && req.args || []).join(' ').slice(0, 120)}`);
      return agent.run(req, ctx);
    },
    log: m => out && out.appendLine(m),
  }));

  // A semantic model, opened from the tree or named by a query: its definition (Fabric's
  // getDefinition, TMSL), kept as a local copy in Apache Ossie — modelPath(n), ~/OneLakeStudio/
  // semantic-models/<workspace>/<model>.yaml — and read from there after. Nothing is written to OneLake, so a
  // user who may only read the workspace opens and queries a model all the same; Export to
  // Fabric is the one write (exportExplore). A model that is not Direct Lake over OneLake is
  // refused, and nothing is kept. `fresh` reads Fabric again, over the local copy.
  // `${workspace}|${model}|${fresh}`, lower-cased -> Promise<{ path, text }>: a fresh read never
  // joins one that may answer from the local copy.
  const fetching = new Map();
  function fetchModel(n, { fresh = false, say = () => {} } = {}) {
    const key = `${n.workspace}|${n.model}|${!!fresh}`.toLowerCase();
    if (!fetching.has(key)) fetching.set(key, (async () => {
      const path = modelPath(n);
      if (!fresh) {
        const kept = await fsp.readFile(path, 'utf8').catch(() => null);
        if (kept != null) return { path, text: kept };
      }
      say('reading its definition from Fabric…');
      const bim = await fabric.getBim(n.workspace, n.modelId);
      let doc;
      try { doc = JSON.parse(stripBom(Buffer.from(bim).toString('utf8'))); }
      catch (e) { throw new Error(`its definition is not TMSL: ${e.message}`); }
      const { semantic, compiler } = await agent.modules();
      if (!semantic.lakehousesOf(doc).length) {
        const mode = semantic.storageMode(doc);
        unsupportedModels.set(modelKey(n), mode);
        tree.modelChanged(n);
        throw Object.assign(new Error(unsupportedNote(n, mode)), { unsupported: true });
      }
      unsupportedModels.delete(modelKey(n));
      // lineWidth 0: a long DAX expression stays on its lines, not folded to the page's width.
      const text = compiler.stringifyYaml(compiler.tmslToOssie(doc, n.model), { lineWidth: 0 });
      await fsp.mkdir(dirname(path), { recursive: true });
      await fsp.writeFile(path, text);
      if (out) out.appendLine(`downloaded ${n.workspace}/${n.model} -> ${path} (${fmtBytes(Buffer.byteLength(text))})`);
      tree.modelChanged(n);
      return { path, text };
    })().finally(() => fetching.delete(key)));
    return fetching.get(key);
  }

  // The one OneLake writer (onelakewrite.js): Export to Fabric's .yaml, and nothing else.
  const writer = createOneLakeWriter({ getToken: hostToken });

  // Where Export to Fabric writes a model opened from its local copy: <lakehouse>/Files/
  // semantic_model/<model>.yaml, in the one lakehouse its Direct Lake expressions name (the app
  // reads it there at run time). Only worked out here; written once the export is approved.
  async function modelTarget(text, model) {
    if (!model || !model.workspace || !model.name) {
      throw new Error('Export to Fabric needs a model that is a OneLake file, or one opened from the tree');
    }
    const { semantic, compiler } = await agent.modules();
    const lakes = semantic.lakehousesOf(semantic.bimOf(modelFileName(model.name), text, compiler));
    if (lakes.length !== 1) {
      throw new Error(`${model.name} reads ${lakes.length} lakehouses: Export to Fabric needs a model over exactly one`);
    }
    const lh = await fabric.itemOf(lakes[0].workspace, lakes[0].item);
    if (!/\.Lakehouse$/i.test(lh.item)) throw new Error(`${model.name} reads ${lh.item}, which has no Files/ to keep its model in`);
    return { workspace: lh.workspace, item: lh.item, path: `${lh.item}/Files/semantic_model/${modelFileName(model.name)}` };
  }

  // A click on a model in the tree: its local copy (read from Fabric the first time), opened in
  // the panel. One progress notification from the click until the page says it is on screen.
  // Download Again (`fresh`) asks before it replaces the local copy.
  async function openModel(n, { fresh = false } = {}) {
    if (!n || n.kind !== 'semanticModel') return;
    const refused = !fresh && unsupportedModels.get(modelKey(n));
    if (refused) {
      vscode.window.showInformationMessage(unsupportedNote(n, refused));
      return;
    }
    try {
      if (fresh && existsSync(modelPath(n))) {
        const pick = await vscode.window.showWarningMessage(
          `Download ${n.model} from Fabric again, over its local copy?`, { modal: true, detail: modelPath(n) }, 'Download Again');
        if (pick !== 'Download Again') return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Opening ${n.model}` },
        async progress => {
          const say = message => progress.report({ message });
          const { path, text } = await fetchModel(n, { fresh, say });
          say('opening it in OneLake Studio…');
          const name = modelFileName(n.model);
          const opened = whenOpened(name);
          await openInPanel({ type: 'open-model', name, path, text, modelWorkspace: n.workspace, modelName: n.model });
          await opened;
        });
    } catch (e) {
      // Not Direct Lake over OneLake is not a failure: say what the model is, quietly.
      if (e && e.unsupported) {
        if (out) out.appendLine(`not opening ${n.workspace}/${n.model}: ${e.message}`);
        vscode.window.showInformationMessage(e.message);
        return;
      }
      if (out) out.appendLine(`opening ${n.model} failed — ${(e && e.stack) || e}`);
      showError(`Could not open ${n.model}: ${(e && e.message) || e}`);
    }
  }

  // A table's SQL name, found in OneLake. The parts are matched as DuckDB matches names,
  // ignoring case, against what the store lists (the tree's own listings, so a table the tree
  // has shown resolves without a request), and answered spelled as OneLake spells them.
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  resolveSqlTable = async ref => {
    const workspaces = await onelake.workspaces().catch(() => []);
    const ws = workspaces.find(w => same(w, ref.workspace)) || String(ref.workspace);
    let dir = ref.dir;
    if (!dir) {
      const items = await onelake.items(ws).catch(e => {
        throw new Error(`${sqlName(ref)}: workspace ${ref.workspace} could not be listed — ${e.message}`);
      });
      const hit = items.find(i => sqlKind(i.kind) === ref.kind && same(displayName(i.name), ref.item));
      if (!hit) throw new Error(`${sqlName(ref)}: there is no ${ref.kind} ${ref.item} in workspace ${ws}`);
      dir = hit.name;
    }
    const lh = { workspace: ws, item: dir };
    const listed = await onelake.tables(lh).catch(() => []);
    const t = listed.find(x => same(x.schema || 'dbo', ref.schema || 'dbo') && same(x.table, ref.table)) ||
              { schema: ref.schema || 'dbo', table: ref.table };
    let meta;
    try { meta = await onelake.table(lh, t); }
    catch (e) { throw new Error(`${sqlName(ref)}: ${e.message}`); }
    const named = { kind: ref.kind, workspace: ws, item: displayName(dir), schema: t.schema || 'dbo', table: t.table };
    return meta.empty
      ? { ...named, emptySql: (await agent.modules()).paths.emptyTableSql(meta.schemaFields) }
      : { ...named, metadataLocation: meta.metadataLocation };
  };

  // Every table the store has seen, with its columns, as its SQL name's parts: a walk of the
  // cache alone (the command line's `find` walks it the same way). A table whose columns were
  // never read is left out — a view needs columns, and opening its lakehouse reads them.
  cachedSqlTables = async () => {
    const { paths } = await agent.modules();
    const found = [];
    const all = await walkCached(onelake.cached);
    for (const w of (all && all.workspaces) || []) {
      // Its semantic models, as the Fabric listing has them: semanticmodel.ws.model.
      for (const m of w.models) found.push({ kind: MODEL_CATALOG, workspace: w.name, model: m.name, modelId: m.id });
      for (const it of w.items) {
        const kind = sqlKind(it.kind);
        if (!kind) continue;
        for (const t of it.tables || []) {
          const fields = t.meta && t.meta.schemaFields;
          if (!fields || !fields.length) continue;
          // itemDir: the item as the tree knows it (data.Lakehouse), to open the table there.
          const named = { kind, workspace: w.name, item: displayName(it.name), itemDir: it.name, schema: t.schema || 'dbo', table: t.table };
          found.push(t.meta.empty
            ? { ...named, emptySql: paths.emptyTableSql(fields) }
            : { ...named, columns: fields.map(f => ({ name: f.name, type: paths.icebergToDuckType(f.type) })) });
        }
      }
    }
    // And every model kept as a view: Fabric's, or a model file opened from a lakehouse's Files/.
    for (const v of await semviews.list()) {
      if (v.schema) found.push({ kind: MODEL_CATALOG, workspace: v.schema, model: v.name });
    }
    return found;
  };

  // A semantic model a query names that no view has yet: found in its workspace's model
  // listing (the cache's, else Fabric's), its local copy kept (fetchModel), and kept as a view.
  // Answers the view as semviews keeps it, with its text: { name, schema, path, text }.
  openSqlModel = async ({ workspace, model }) => {
    const full = modelSqlName(workspace, model);
    const workspaces = await onelake.workspaces().catch(() => []);
    const ws = workspaces.find(w => same(w, workspace)) || String(workspace);
    const pick = list => (list || []).find(m => same(m.name, model));
    const kept = await onelake.cached.models(ws);
    let hit = pick(kept && kept.value);
    if (!hit) {
      hit = pick(await onelake.models(ws).catch(e => {
        throw new Error(`${full}: the semantic models of ${ws} could not be listed — ${e.message}`);
      }));
    }
    if (!hit) throw new Error(`${full}: there is no semantic model ${model} in workspace ${ws}`);
    const { path } = await fetchModel({ workspace: ws, model: hit.name, modelId: hit.id });
    if (out) out.appendLine(`opened ${full} for a query, from ${path}`);
    return semviews.put(hit.name, path, ws);
  };

  // A semantic model's Direct Lake tables, which its expressions name by GUID, as SQL names:
  // [{ workspace, item (GUIDs), schema, table }] -> [name]. Fabric names each item once, ever, on
  // disk: every model is named each time the panel opens.
  nameModelTables = async list => {
    const out = [];
    for (const x of list) {
      const key = `${x.workspace}/${x.item}`.toLowerCase();
      if (!itemNames.has(key)) {
        const p = onelake.itemNamed(x.workspace, x.item);
        itemNames.set(key, p);
        p.catch(() => itemNames.delete(key));
      }
      const it = await itemNames.get(key);
      const kind = sqlKind(it.item.replace(/^.*\./, ''));
      if (!kind) throw new Error(`${it.workspace}/${it.item} holds no tables SQL can name`);
      out.push(sqlName({ kind, workspace: it.workspace, item: displayName(it.item), schema: x.schema, table: x.table }));
    }
    return out;
  };

  // Export to Fabric, from Explore: the model's Explore as a Fabric app (exportapp.js), its
  // local copy written to <the open folder>/<app>/ (asked for when no folder is open) —
  // and published from there over the Fabric REST API (fabricapp.js). The function's deploy
  // package ships in the vsix (fabric-function/, scripts/function-bundle.mjs). Answers what
  // Explore's info line says; a failure is thrown back to it, and logged. So is the user's No
  // (`declined`), which is no failure, but must not read as a publish on the command line.
  exportExplore = async ({ file, name, text, state, workspace, path, model }) => {
    const declined = message => Object.assign(new Error(message), { declined: true });
    try {
      // A model opened from its local copy is not in OneLake yet: it is written into its
      // lakehouse (modelTarget) once every question below has been answered — the one write
      // to OneLake a semantic model ever gets.
      const target = path ? null : await modelTarget(text, model);
      if (target) ({ workspace, path } = target);
      const plan = planExport(text, file, name, await agent.modules(), { workspace, path });
      const fnDir = join(context.extensionUri.fsPath, 'fabric-function');
      const [sourceZip, deployMetaData] = await Promise.all([
        fsp.readFile(join(fnDir, 'source.zip')), fsp.readFile(join(fnDir, 'deploymetadata.json'), 'utf8'),
      ]).catch(() => { throw new Error('this build has no function package (fabric-function/): run node scripts/function-bundle.mjs'); });
      const token = await appToken({ createIfNone: true });
      if (!token) throw new Error('not signed in to the Fabric API');

      // The folder: the one approved last time for this model, or else <the folder VS Code
      // has open>/<app>/, or else a picker. Never used unapproved: where it goes is shown, and
      // the export waits for an OK or another folder.
      const open = (vscode.workspace.workspaceFolders || [])[0];
      const key = `exportFolder:${plan.workspace}/${plan.lakehouse}/${plan.name}`;
      const remembered = context.globalState.get(key);
      let outDir = remembered && existsSync(remembered) ? remembered : open ? join(open.uri.fsPath, plan.name) : null;
      let prev = outDir;
      const pickFolder = async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
          defaultUri: vscode.Uri.file(prev ? dirname(prev) : os.homedir()),
          openLabel: 'Export Here',
          title: `Export to Fabric: the folder to keep the app's local copy (${plan.name}/) in`,
        });
        if (!picked || !picked.length) return null;
        // The app's own folder picked, rather than the one to put it in: used as it is.
        const dir = picked[0].fsPath;
        return basename(dir) === plan.name ? dir : join(dir, plan.name);
      };
      for (;;) {
        if (!outDir) {
          outDir = await pickFolder();
          if (!outDir) throw declined('Export cancelled.');
        }
        const pick = await vscode.window.showInformationMessage(
          `Export ${plan.name} to Fabric?`,
          { modal: true, detail: `Local copy: ${outDir}${existsSync(outDir) ? '' : ' (new)'}\nWorkspace: ${workspace}\nModel: ${plan.modelPath}` },
          'Export', 'Choose Another Folder…');
        if (pick === 'Export') break;
        if (!pick) throw declined('Export cancelled.');
        prev = outDir;
        outDir = null;
      }
      // A folder Export to Fabric did not write is refused here, before anything else is asked.
      const before = await readMarker(outDir);
      await context.globalState.update(key, outDir);
      // One client for the export. Its lines go to the log, and while publishing also to the
      // progress notification (`say`, below).
      let appLog = m => out && out.appendLine(m);
      const fabricApp = createFabricApp({ getToken: appToken, log: m => appLog(m) });

      // Edited since it was last published (by you, or an agent)? Asked, never overwritten.
      let asIs = false;
      const changed = await localChanges(outDir, before);
      if (changed.length) {
        const shown = changed.slice(0, 5).join('\n') + (changed.length > 5 ? `\n…and ${changed.length - 5} more` : '');
        const pick = await vscode.window.showWarningMessage(
          `The local copy of ${plan.name} has changed since it was last published.`,
          { modal: true, detail: `${outDir}\n\n${shown}\n\nOverwrite: rewrite it from this Explore, and publish that. Publish As Is: publish the folder with your changes, and leave it alone.` },
          'Overwrite Local Changes', 'Publish Folder As Is');
        if (!pick) throw declined('Not exported: the local copy has changes.');
        asIs = pick === 'Publish Folder As Is';
      }

      // Deployed again since this folder published it (another machine, rayfin up)?
      // Asked before it is replaced.
      if (before && before.itemId) {
        const live = await fabricApp.deployStatus(plan.workspace, before.itemId)
          .catch(e => { if (out) out.appendLine(`export: the app's last deploy could not be read — ${e.message}`); return null; });
        const ours = before.deployedAt ? Date.parse(before.deployedAt)
          // A marker from before deployedAt was kept: this machine's clock, with slack.
          : before.exportedAt ? Date.parse(before.exportedAt) + 5 * 60_000 : NaN;
        const theirs = live && Date.parse(live.lastSuccessfulDeploymentAt);
        if (theirs > ours) {
          const pick = await vscode.window.showWarningMessage(
            `${plan.name} was deployed again on ${new Date(theirs).toLocaleString()}, not from this folder. Overwrite it?`,
            { modal: true, detail: live.hostingUrl || '' }, 'Overwrite It');
          if (pick !== 'Overwrite It') throw declined(`Not exported: ${plan.name} was deployed from elsewhere since.`);
        }
      }

      // Approved: the model's .yaml into its lakehouse, where the app will read it. A different
      // file already there is replaced only when the user says so.
      if (target) {
        const there = await writer.stat(target.workspace, target.path).catch(() => null);
        const same = there && Buffer.from(await onelake.readBytes(target.workspace, target.path).catch(() => new Uint8Array()))
          .toString('utf8') === String(text);
        if (there && !same) {
          const pick = await vscode.window.showWarningMessage(
            `${target.workspace}/${target.path} already exists.`,
            { modal: true, detail: `Replace it with ${model.name} as opened here, and publish?` }, 'Replace It');
          if (pick !== 'Replace It') throw declined(`Not exported: ${target.path} is a different file.`);
        }
        if (!same) {
          await writer.writeFile(target.workspace, target.path, Buffer.from(String(text), 'utf8'));
          if (out) out.appendLine(`export: wrote ${model.workspace}/${model.name} -> ${target.workspace}/${target.path}`);
          const lh = { workspace: target.workspace, item: target.item };
          await onelake.files(lh, 'semantic_model', { fresh: true }).catch(() => {});
          tree.refresh({ kind: 'dir', ...lh, dir: 'semantic_model' });
        }
      }

      const ext = context.extensionUri.fsPath;
      const fabricAppDir = join(ext, 'fabric_app');
      const appDir = (await webviewRoot(context.extensionUri, { dev })).page.fsPath;
      // One publish, under a progress notification. `takeOver`: the user said an app of that
      // name, which no export created, may be replaced.
      const publish = takeOver => vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Export to Fabric: ${plan.name}` },
        async progress => {
          const say = line => { if (out) out.appendLine(line); progress.report({ message: line.replace(/^app \S+: /, '') }); };
          let marker = before;
          if (asIs) say(`app ${plan.name}: publishing ${outDir} as it is`);
          else {
            say(`app ${plan.name}: writing the local copy to ${outDir}`);
            marker = await writeExport({ plan, state, outDir, fabricAppDir, appDir,
                                         daxSqlDir: join(ext, 'vendor', 'npm', PINS.daxSql),
                                         webappDir: join(ext, 'vendor', 'webapp') });
          }
          // What the page's packages weigh, there in the folder (site/vendor/) and here in the log.
          const mb = n => `${(n / 1048576).toFixed(1)} MB`;
          const size = await vendorSize(outDir);
          say(`app ${plan.name}: site/vendor/ is ${mb(size.total)}`);
          if (out) for (const [name, bytes] of size.parts) out.appendLine(`  ${mb(bytes).padStart(9)}  ${name}`);
          const quiet = appLog;
          appLog = say;
          let done;
          try {
            done = await fabricApp.publish({
              workspaceId: plan.workspace, name: plan.name, tenantId: tenantOf(token),
              catalogUrl: plan.catalogUrl, modelUrl: plan.modelUrl,
              site: async config => zip(await buildDist(outDir, config)),
              fn: { sourceZip, deployMetaData }, redirects: marker.redirects || [],
              itemId: marker.itemId || null, takeOver,
            });
          } finally { appLog = quiet; }
          // The redirects in rayfin.yml: the template's, or (as is) the folder's own.
          const yml = join(outDir, 'rayfin', 'rayfin.yml');
          const tpl = asIs && existsSync(yml) ? await fsp.readFile(yml, 'utf8')
            : await fsp.readFile(join(fabricAppDir, 'rayfin', 'rayfin.yml'), 'utf8');
          await fsp.writeFile(yml, rayfinYml(tpl, plan.name, done.redirects));
          // What was published, to compare the next export with: the folder's files, and the
          // deploy's time by Fabric's clock.
          const live = await fabricApp.deployStatus(plan.workspace, done.itemId).catch(() => null);
          await writeMarker(outDir, { ...marker, itemId: done.itemId, hostingUrl: done.hostingUrl,
                                      redirects: done.redirects, exportedAt: new Date().toISOString(),
                                      deployedAt: (live && live.lastSuccessfulDeploymentAt) || new Date().toISOString(),
                                      files: await fingerprint(outDir) });
          return done;
        });
      let r;
      try { r = await publish(false); }
      catch (e) {
        if (e.code !== 'NAME_TAKEN') throw e;
        // Never replaced unasked: it may be someone's own app, as the first export's was.
        const pick = await vscode.window.showWarningMessage(
          `An app named "${e.item.displayName}" already exists in this workspace, and Export to Fabric did not create it. Replace it with this Explore?`,
          { modal: true }, 'Replace It');
        if (pick !== 'Replace It') throw declined(`Not exported: an app named ${e.item.displayName} already exists.`);
        r = await publish(true);
      }
      // The Apps of the workspace the app was published to (the lakehouse's, not always the
      // model's), re-read: the app is new, or deployed again.
      tree.refresh({ kind: 'apps', workspace: plan.workspace });
      if (out) {
        out.appendLine(`exported ${plan.name} -> ${r.hostingUrl || '(no hosting URL)'} (item ${r.itemId}, model ${plan.modelPath}, local copy ${outDir})`);
        for (const w of plan.warnings) out.appendLine(`  warning: ${w}`);
      }
      const warned = plan.warnings.length ? ` ${plan.warnings.length} warning(s) in the log.` : '';
      vscode.window.showInformationMessage(`${plan.name} is published to Fabric.${warned}`, 'Open App', 'Reveal Folder')
        .then(pick => {
          if (pick === 'Open App' && r.hostingUrl) vscode.env.openExternal(vscode.Uri.parse(r.hostingUrl));
          else if (pick === 'Reveal Folder') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outDir));
        });
      return `Published to Fabric${asIs ? ' (the local copy, as it is)' : ''}: ${r.hostingUrl || plan.name}`;
    } catch (e) {
      if (out && !(e && e.declined)) out.appendLine(`export to fabric of ${file} failed — ${(e && e.stack) || e}`);
      throw e;
    }
  };

  const explorer = vscode.window.createTreeView('onelakeStudio.explorer', {
    treeDataProvider: tree,
    showCollapseAll: true,
    // A table or a semantic model dragged into an editor is its SQL name, dropped as text.
    dragAndDropController: {
      dragMimeTypes: ['text/plain'],
      dropMimeTypes: [],
      handleDrag(nodes, data) {
        const names = nodes.map(n => (n.kind === 'table' && n.table ? sqlNameOf(n, n)
          : n.kind === 'semanticModel' && n.model ? modelSqlName(n.workspace, n.model) : null)).filter(Boolean);
        if (names.length) data.set('text/plain', new vscode.DataTransferItem(names.join(',\n')));
      },
    },
  });

  // The engine, started once this window shows it will want one, so the first statement does
  // not wait for its boot: not at activation, which every window goes through. An engine
  // already there is left alone: ensureEngine could close its panel over a moved account.
  let warming = false;
  const warmEngine = async () => {
    if (warming || engine || !signedIn) return;
    warming = true;
    try {
      await rebindStore();
      const { readme } = await webviewRoot(context.extensionUri, { dev });
      if (engine) return;
      const eng = ensureEngine(context, { readme: readme.fsPath });
      if (eng) await eng.warm();
    } catch (e) {
      if (out) out.appendLine(`the engine could not start ahead of a query — ${(e && e.message) || e}`);
    } finally {
      warming = false;
    }
  };
  const warmIfWanted = () => {
    if (explorer.visible || vscode.workspace.textDocuments.some(isQuery)) warmEngine();
  };
  warmIfWanted();

  context.subscriptions.push(
    tree,
    explorer,
    explorer.onDidChangeVisibility(warmIfWanted),
    vscode.workspace.onDidOpenTextDocument(doc => { if (isQuery(doc)) warmEngine(); }),

    // The panel keeps table metadata across lakehouse switches now, so the refresh button
    // is what tells it to forget: a refresh exists to ask OneLake again, there too.
    vscode.commands.registerCommand('onelakeStudio.refresh', n => {
      // An error node names nothing itself: its Refresh is the listing that failed. Without
      // this it refreshed every lakehouse's table metadata and redrew nothing.
      if (n && n.kind === 'error') n = n.parent;
      // A model or app list is the Fabric API's; it says nothing about any table's metadata.
      if (!n || !['models', 'apps'].includes(n.kind)) onelake.refreshTables({ workspace: n && n.workspace, item: n && n.item });
      tree.refresh(n);
      postLive({ type: 'reset' });
    }),

    vscode.commands.registerCommand('onelakeStudio.showLog', () => out.show(true)),

    vscode.commands.registerCommand('onelakeStudio.groupByType', async () => { await setGrouped(true); tree.redraw(); }),
    vscode.commands.registerCommand('onelakeStudio.ungroupByType', async () => { await setGrouped(false); tree.redraw(); }),

    vscode.commands.registerCommand('onelakeStudio.installClaudeSkill', async () => {
      try { await installSkill(context); }
      catch (e) { showError(`Could not install the agent skill: ${(e && e.message) || e}`); }
    }),

    vscode.commands.registerCommand('onelakeStudio.pinWorkspace', async n => {
      if (!n || !n.workspace) return;
      await favorites.set([...favorites.get(), n.workspace]);
      tree.redraw();
    }),
    vscode.commands.registerCommand('onelakeStudio.unpinWorkspace', async n => {
      if (!n || !n.workspace) return;
      await favorites.set(favorites.get().filter(w => w !== n.workspace));
      tree.redraw();
    }),

    // Reading the same table twice should be quick, and if it is not, this is how to
    // prove the cache is the reason rather than assume it. It also answers "what is this
    // costing me on disk".
    vscode.commands.registerCommand('onelakeStudio.clearCache', async () => {
      const fileCacheDir = fileCacheDirFor(storeAccount);
      const fileBytes = await dirBytes(fileCacheDir);
      const size = await onelake.size() + fileBytes;
      if (!size) {
        vscode.window.showInformationMessage('OneLake Studio: the cache is empty.');
        return;
      }
      // Everything deleted here is re-read from OneLake at OneLake's speed, which is the
      // whole reason the cache exists — so it is asked first.
      const pick = await vscode.window.showWarningMessage(
        `Delete ${fmtBytes(size)} of cached OneLake listings, table metadata, first rows, files and table data? They will be read from OneLake again.`,
        { modal: true }, 'Delete');
      if (pick !== 'Delete') return;
      await onelake.clear();
      // The engine has the disk cache's files open: it goes first, and is rebuilt on the
      // next open. The panel's tables live in that engine, so the panel goes with it.
      if (fileBytes) {
        closePanel();
        await resetEngine();
        await removeDir(fileCacheDir);
      }
      postLive({ type: 'reset' });
      tree.redraw();
      vscode.window.showInformationMessage(
        `OneLake Studio: cleared ${fmtBytes(size)} of cached OneLake data.`);
    }),

    vscode.commands.registerCommand('onelakeStudio.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)),

    vscode.commands.registerCommand('onelakeStudio.openTable', n => openInPanel({
      type: 'open-table',
      workspace: n.workspace, item: n.item, schema: n.schema, table: n.table,
    })),

    vscode.commands.registerCommand('onelakeStudio.openFile', n => openInPanel({
      type: 'open-file', workspace: n.workspace, item: n.item, path: n.path, bytes: n.bytes,
    })),

    // A table's first rows, as a query in an editor of its own, run at once.
    vscode.commands.registerCommand('onelakeStudio.selectTop', async n => {
      if (!n || !n.table) return;
      const top = vscode.workspace.getConfiguration('onelakeStudio').get('selectTopRows', 1000);
      await openNewQuery(`SELECT *\nFROM ${sqlNameOf(n, n)}\nLIMIT ${Number.isInteger(top) && top > 0 ? top : 1000};\n`);
      await vscode.commands.executeCommand('onelakeStudio.runQuery');
    }),
    // A table's columns, comma-separated and quoted where SQL needs it, from its metadata (read
    // from OneLake if the cache does not have it yet).
    vscode.commands.registerCommand('onelakeStudio.copyColumns', async n => {
      if (!n || !n.table) return;
      try {
        const meta = await onelake.table({ workspace: n.workspace, item: n.item }, { schema: n.schema, table: n.table });
        const cols = (meta.schemaFields || []).map(f => sqlPart(f.name));
        if (!cols.length) { vscode.window.setStatusBarMessage(`${n.table} has no columns`, 3000); return; }
        await vscode.env.clipboard.writeText(cols.join(', '));
        vscode.window.setStatusBarMessage(`Copied the ${cols.length} columns of ${n.table}`, 3000);
      } catch (e) {
        showError(`Could not read the columns of ${n.table}: ${(e && e.message) || e}`);
      }
    }),

    // A table's SQL name, for a query written by hand.
    vscode.commands.registerCommand('onelakeStudio.copySqlName', async n => {
      if (!n || !n.table) return;
      const name = sqlNameOf(n, n);
      await vscode.env.clipboard.writeText(name);
      vscode.window.setStatusBarMessage(`Copied ${name}`, 3000);
    }),

    // Saved queries (queriesFolder): open one in its editor, rename, delete, show the folder.
    vscode.commands.registerCommand('onelakeStudio.openQuery', async n => {
      if (!n || !n.path) return;
      if (!existsSync(n.path)) { tree.queriesChanged(); return showError(`${n.label} is no longer in ${queriesFolder()}`); }
      await openSavedQuery(n.path);
    }),
    vscode.commands.registerCommand('onelakeStudio.renameQuery', async n => {
      if (!n || !n.path) return;
      const picked = await askQueryName('Rename Query', n.label);
      if (!picked || queryStem(picked) === n.label) return;
      const path = queryPath(picked);
      if (!await mayReplace(path, n.label)) return;
      // Through the editor: one that has the query open follows it to its new name.
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(vscode.Uri.file(n.path), vscode.Uri.file(path), { overwrite: true });
      if (!await vscode.workspace.applyEdit(edit)) showError(`Could not rename ${n.label}`);
      tree.queriesChanged();
    }),
    vscode.commands.registerCommand('onelakeStudio.deleteQuery', async n => {
      if (!n || !n.path) return;
      const pick = await vscode.window.showWarningMessage(`Delete the query ${n.label}?`, { modal: true }, 'Delete');
      if (pick !== 'Delete') return;
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(vscode.Uri.file(n.path), { ignoreIfNotExists: true });
      if (!await vscode.workspace.applyEdit(edit)) showError(`Could not delete ${n.label}`);
      tree.queriesChanged();
    }),
    // A new query in an editor of its own, started with what can be queried: Save Query keeps
    // it under Queries as "Query N". Not run: one Ctrl+Enter does that.
    vscode.commands.registerCommand('onelakeStudio.newQuery', () => openNewQuery(NEW_QUERY_SQL)),
    // Every query variable forgotten: the next getvariable() asks again.
    vscode.commands.registerCommand('onelakeStudio.clearVariables', () => {
      const n = variables.size;
      variables.clear();
      vscode.window.setStatusBarMessage(`OneLake Studio: ${n} query variable(s) cleared`, 4000);
    }),
    vscode.commands.registerCommand('onelakeStudio.goTo', () => goTo()),
    // The grid's context menu (package.json webview/context): the page builds the text.
    ...[['gridCopy', 'tsv'], ['gridCopyHeaders', 'tsv-headers'], ['gridCopyCsv', 'csv'],
        ['gridCopyMarkdown', 'markdown'], ['gridCopyJson', 'json']].map(([id, as]) =>
      vscode.commands.registerCommand(`onelakeStudio.${id}`, () => postToPanel({ type: 'grid-copy', as }))),
    ...[['gridOpenCsv', 'csv'], ['gridOpenJson', 'json']].map(([id, as]) =>
      vscode.commands.registerCommand(`onelakeStudio.${id}`, () => postToPanel({ type: 'grid-open', as }))),
    vscode.commands.registerCommand('onelakeStudio.revealQueries', async () => {
      if (!queriesFolder()) return;
      await fsp.mkdir(queriesFolder(), { recursive: true });
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(queriesFolder()));
    }),

    // The tree's "Sign in to list semantic models" node. A command of its own, because the
    // Fabric API's consent is a separate prompt and must only ever follow a click.
    vscode.commands.registerCommand('onelakeStudio.signInFabric', async () => {
      try {
        if (await fabricToken({ createIfNone: true })) tree.redraw();
      } catch (e) {
        showError(`Could not sign in to the Fabric API: ${(e && e.message) || e}`);
      }
    }),

    vscode.commands.registerCommand('onelakeStudio.openSemanticModel', n => openModel(n)),
    // An app in the tree: its URL, copied. Nothing is opened or changed.
    vscode.commands.registerCommand('onelakeStudio.copyAppUrl', async n => {
      if (!n || !n.url) return;
      await vscode.env.clipboard.writeText(n.url);
      vscode.window.setStatusBarMessage(`Copied ${n.url}`, 3000);
    }),
    vscode.commands.registerCommand('onelakeStudio.redownloadSemanticModel', n => openModel(n, { fresh: true })),

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
        warmIfWanted();
      } catch (e) {
        showError(`Could not sign in: ${(e && e.message) || e}`);
      }
    }),

    // VS Code owns the account, so an extension cannot sign anyone out — that is the
    // Accounts menu in the bottom left. What it CAN do is stop reusing the remembered
    // choice, which is what someone with two tenants actually wants.
    vscode.commands.registerCommand('onelakeStudio.switchAccount', () => accountTurn(async () => {
      try {
        // Ask FIRST. Tearing down before the picker meant that cancelling it still cost
        // the panel and the engine — for a switch that never happened.
        const picked = await getToken({ createIfNone: true, clearSessionPreference: true });
        if (!picked) return;
        // Now the teardown is FOR something: the panel on screen and the engine's secrets
        // belong to the account being left. Its cache does not need deleting — it is that
        // account's own directory, and the new account gets its own.
        closePanel();
        forgetToken();
        await resetEngine();
        await rebindStore();
        tree.redraw();
        await showWithProgress({ createIfNone: true });
        await setSignedIn(!!await getToken({ createIfNone: false }));
        tree.redraw();
      } catch (e) {
        showError(`Could not switch account: ${(e && e.message) || e}`);
      }
    })),

    // Covers the other direction: signing out from the Accounts menu, or a token revoked
    // elsewhere. catalog.js asks for the token per request and recovers by itself; the
    // ENGINE does not — its azure secret and ATTACHes hold the token by value, so it is
    // closed here, or a signed-out window keeps reading OneLake for as long as the old
    // token lasts.
    //
    // The account's cache is NOT deleted: it is that account's own directory (a hashed id),
    // never served to anyone else, and signing back in finds it warm. It used to be wiped
    // here — and a token refresh that failed while offline looks exactly like a sign-out,
    // so a flaky network could cost the whole disk cache. Clear Cached OneLake Data deletes it.
    //
    // A DIFFERENT account — chosen from the Accounts menu rather than Switch Account — is
    // the same teardown as a switch. It used to change nothing: the session was still
    // "live", so the panel, the engine and the cache carried on as the previous user.
    vscode.authentication.onDidChangeSessions(e => e.provider.id === 'microsoft' && accountTurn(async () => {
      try {
        forgetToken();
        const was = signedIn;
        const session = await getSession({ createIfNone: false }).catch(() => null);
        await setSignedIn(!!session);
        const before = storeAccount;
        await rebindStore();
        // Another extension's sign-in, or a token refresh of the same account, changes nothing here.
        if (was !== !!session || storeAccount !== before) tree.redraw();
        if (!session) {
          if (!was) return;
          closePanel();
          await resetEngine();
          vscode.window.showInformationMessage(
            'OneLake Studio signed out — the Microsoft account is no longer available.');
        } else if (engine && storeAccount !== before) {
          closePanel();
          await resetEngine();
          vscode.window.showInformationMessage(
            `OneLake Studio is now using ${session.account.label}.`);
        }
      } catch (err) {
        if (out) out.appendLine(`account change failed — ${(err && err.message) || err}`);
      }
    })),

    // Settings are read where they are used, but some configure things that are already
    // built by then. Saying so beats silently applying at the next window reload.
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('onelakeStudio.tenantId')) {
        // The cached token, the engine's secrets and the cache all belong to the tenant
        // being left.
        await accountTurn(async () => {
          try {
            forgetToken();
            fabric.reset();
            itemNames.clear();
            await rebindStore();
            tree.redraw();
            if (engine) {
              closePanel();
              await resetEngine();
            }
          } catch (err) {
            if (out) out.appendLine(`tenant change failed — ${(err && err.message) || err}`);
          }
        });
      }
      // The engine reads these when it is built: a running one keeps the old values until it
      // is restarted (which closes the panel, whose tables live in it).
      if (engine && (e.affectsConfiguration('onelakeStudio.engineMemoryLimit') ||
                     e.affectsConfiguration('onelakeStudio.engineThreads') ||
                     e.affectsConfiguration('onelakeStudio.engineSpillMaxGB') ||
                     e.affectsConfiguration('onelakeStudio.maxResultRows') ||
                     e.affectsConfiguration('onelakeStudio.diskCacheMaxGB') ||
                     e.affectsConfiguration('http.proxy'))) {
        const pick = await vscode.window.showInformationMessage(
          'OneLake Studio: the engine uses the new setting once it restarts. Restarting closes the panel.',
          'Restart Engine');
        if (pick === 'Restart Engine' && engine) {
          closePanel();
          await resetEngine();
          vscode.commands.executeCommand('onelakeStudio.open');
        }
      }
      // A new folder starts empty, and the old one stays until it is deleted here. A running
      // engine has the old one's files open, and keeps it until it restarts.
      if (e.affectsConfiguration('onelakeStudio.cacheDirectory')) {
        const old = fileCacheRoot, next = fileCacheRootFor(context);
        if (next !== old) {
          const running = !!engine;
          if (!running) fileCacheRoot = next;
          const remove = running ? 'Restart Engine and Delete Old Cache' : 'Delete Old Cache';
          const actions = running ? [remove, 'Restart Engine'] : [remove];
          const pick = await vscode.window.showInformationMessage(
            `OneLake Studio: table data is now cached in ${next}, which starts empty. The old cache is still in ${old}.`,
            ...actions);
          if (pick && running && engine) {
            closePanel();
            await resetEngine();
            fileCacheRoot = next;
            vscode.commands.executeCommand('onelakeStudio.open');
          }
          if (pick === remove) await removeDir(old);
        }
      }
      if (e.affectsConfiguration('onelakeStudio.metadataCacheMaxMB')) onelake.useStore(storeFor(storeAccount));
      if (e.affectsConfiguration('onelakeStudio.tableOpensOn') ||
          e.affectsConfiguration('onelakeStudio.gridThousandsSeparator')) {
        postLive({ type: 'settings', ...panelSettings() });
      }
    }),
  );

}

function deactivate() {
  // The burst timers hold the process open if they are live at shutdown.
  clearTimeout(postTimer);
  clearTimeout(idleTimer);
  // The engine holds a native database handle and a temp directory; closing it is what
  // releases both.
  return engine ? engine.close() : undefined;
}

module.exports = { activate, deactivate };
