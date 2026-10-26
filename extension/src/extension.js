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
const { openPanel, closePanel, revealPanel, postToPanel, postLive } = require('./panel');
const { createCatalog } = require('./catalog');
const { createStore } = require('./store');
const { createOneLake } = require('./onelake');
const { createHostMethods } = require('./host');
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
  const tenant = vscode.workspace.getConfiguration('onelakeStudio').get('tenantId', '').trim();
  return require('node:crypto').createHash('sha256')
    .update(`${session.account.id}|${tenant}`).digest('hex').slice(0, 16);
}

// getSession is an RPC into the account provider; asked once per request, that lookup —
// not OneLake, not DuckDB — was most of a burst's wait. So the token is held briefly in
// memory: long enough to collapse a burst, short enough that a stale one costs a single
// retry (catalog.js and the engine ask again with `fresh` after a 401). Anything that can
// change the answer clears it outright.
const TOKEN_TTL_MS = 60_000;
let cachedToken = null;   // { token, at }

function forgetToken() { cachedToken = null; cachedFabric = null; fabricAudience = null; }

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

const GB = 1024 * 1024 * 1024;

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
      // DuckDB talks to OneLake itself, on the same cached, silent token — reads must
      // never prompt.
      // Options pass through so the engine's auth retry can say { fresh: true } and
      // actually get PAST this cache — asking it again inside the 60s window returns
      // the very token that just expired, and the retry becomes a no-op.
      getToken: opts => hostToken(opts),
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
  await openPanel(context, {
    onOpened: logOpened, onBoot: logBoot, engine: eng,
    host: createHostMethods({
      onelake, engine: eng, onStatus: message => postLive({ type: 'status', message }),
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
  // Every OneLake request the extension makes goes through here, on the VS Code token,
  // and each one is a line in the read log.
  const catalog = createCatalog({
    getToken: hostToken,
    siteFsPath: site.fsPath,
    onRequest: logRead,
  });
  // Semantic models and the .bim export: Fabric's token for the model, the storage one
  // (the same cache the catalog uses) for the one file the export writes.
  const fabric = createFabric({ getFabricToken: fabricToken, getStorageToken: hostToken });

  // What the extension knows about OneLake, kept on disk per account and served from there
  // first (onelake.js). One directory per identity — a hashed account id — so nobody is
  // ever shown another account's listings, and switching back finds its cache still warm.
  const storeRoot = join(context.globalStorageUri.fsPath, 'onelake-store-v1');
  const storeFor = key => createStore({ dir: join(storeRoot, key || 'signed-out'), ttlMs: catalogTtlMs() });
  let storeAccount = accountKey(await getSession({ createIfNone: false }).catch(() => null));
  onelake = createOneLake({
    catalog,
    store: storeFor(storeAccount),
    onHit: logRead,
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
    // costing me on disk".
    vscode.commands.registerCommand('onelakeStudio.clearCache', async () => {
      const size = await onelake.size();
      if (!size) {
        vscode.window.showInformationMessage('OneLake Studio: the cache is empty.');
        return;
      }
      // Everything deleted here is re-read from OneLake at OneLake's speed, which is the
      // whole reason the cache exists — so it is asked first.
      const pick = await vscode.window.showWarningMessage(
        `Delete ${fmtBytes(size)} of cached OneLake listings, table metadata and first rows? They will be read from OneLake again.`,
        { modal: true }, 'Delete');
      if (pick !== 'Delete') return;
      await onelake.clear();
      postLive({ type: 'reset' });
      tree.redraw();
      vscode.window.showInformationMessage(
        `OneLake Studio: cleared ${fmtBytes(size)} of cached OneLake data.`);
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
    }),

    // Covers the other direction: signing out from the Accounts menu, or a token revoked
    // elsewhere. catalog.js asks for the token per request and recovers by itself; the
    // ENGINE does not — its azure secret and ATTACHes hold the token by value, so it is
    // closed here, or a signed-out window keeps reading OneLake for as long as the old
    // token lasts.
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
      const before = storeAccount;
      await rebindStore();
      tree.redraw();
      if (!session) {
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
    }),

    // Settings are read where they are used, but two of them configure things that are
    // already built by then. Saying so beats silently applying at the next window reload.
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('onelakeStudio.tenantId')) {
        // The cached token, the engine's secrets and the cache all belong to the tenant
        // being left.
        forgetToken();
        await rebindStore();
        tree.redraw();
        if (engine) {
          closePanel();
          await resetEngine();
        }
      }
      if (e.affectsConfiguration('onelakeStudio.catalogTtlMinutes')) {
        vscode.window.showInformationMessage(
          'OneLake Studio: the cache setting applies after the window is reloaded.');
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
