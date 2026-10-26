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
const { join } = require('node:path');
const { existsSync } = require('node:fs');
const { openPanel, closePanel, revealPanel, postToPanel, postLive } = require('./panel');
const { createCatalog } = require('./catalog');
const { createStore } = require('./store');
const { createOneLake } = require('./onelake');
const { createHostMethods } = require('./host');
const { createFabric, bimFileName } = require('./fabric');
const { LakehouseTree } = require('./tree');
const { webviewRoot } = require('./webview');
const { hasFilesArea } = require('./names');
const { createAgent } = require('./agent');
const { createSemViews } = require('./semviews');
const { serveBridge } = require('./bridge');
const { PINS } = require('./vendored');

// OneLake accepts tokens in the storage
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

// The same, for a table's metadata (the catalog's loadTable — the slow call): a day by
// default. A new snapshot shows after that, or at once after a Refresh of its lakehouse.
function tableTtlMs() {
  const h = vscode.workspace.getConfiguration('onelakeStudio').get('tableMetadataTtlHours', 24);
  return Number.isFinite(h) && h >= 0 ? Math.round(h * 3600 * 1000) : 24 * 3600 * 1000;
}

const fmtBytes = n => n >= GB ? `${(n / GB).toFixed(1)} GB`
                   : n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB`
                   : `${Math.round(n / 1024)} KB`;

// Real DuckDB, in this process. Built once and kept for the window's lifetime: an engine
// costs ~17ms to create but its extensions are loaded on first use, and doing that per
// panel open would be paying it again for nothing.
//
// Loaded lazily so a failure to load the native binding — an unsupported platform, a vsix
// built for another architecture — surfaces when the panel opens, with a message, rather
// than taking activation down with it.
let engine = null;

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
  const fsp = require('node:fs/promises');
  let n = 0;
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    const st = await fsp.stat(join(dir, name)).catch(() => null);
    if (st && st.isFile()) n += st.size;
  }
  return n;
}
const removeDir = dir => (dir ? require('node:fs/promises').rm(dir, { recursive: true, force: true }).catch(() => {}) : Promise.resolve());
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
      fileCacheDir: fileCacheDirFor(fileCacheAccount),
      fileCacheMaxBytes: Math.max(0, Number(vscode.workspace.getConfiguration('onelakeStudio')
        .get('diskCacheMaxGB', 10)) || 0) * 1024 ** 3,
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

// Points the store and the engine's disk cache at the account now signed in; a no-op when
// it has not moved. Set by activateInner, which owns the store.
let rebindStore = async () => {};
// The semantic views this machine keeps (semviews.js), per account; set by activateInner.
let semviews = null;

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
    onOpened: logOpened, onBoot: logBoot, engine: eng, build: buildInfo,
    host: createHostMethods({
      onelake, engine: eng, onStatus: message => postLive({ type: 'status', message }),
      saveFile, semviews,
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

// Where a CSV or a OneLake file the panel saves goes: the editor's own save dialog,
// starting in the workspace folder (or the home directory), then a plain write.
async function saveFile(name, bytes) {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  const base = folder ? folder.uri : vscode.Uri.file(require('node:os').homedir());
  const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(base, name) });
  if (!uri) return null;
  await vscode.workspace.fs.writeFile(uri, bytes);
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
// cli.mjs is this extension's modules from a shell; claude-skill/SKILL.md tells an agent
// when and how to run it. Installing writes the skill to ~/.claude/skills/onelake/ — read by
// Claude Code and by GitHub Copilot in VS Code, so one copy serves both — with the
// path of THIS install's cli.mjs filled in — a path that changes with every update, so a skill
// this extension wrote (it carries the marker) is rewritten at each activation. One the user
// wrote themselves, without the marker, is never touched unless they ask.
const SKILL_MARKER = 'Installed by the OneLake Studio extension';
const skillFile = () => join(require('node:os').homedir(), '.claude', 'skills', 'onelake', 'SKILL.md');

async function writeSkill(context) {
  const fsp = require('node:fs/promises');
  const template = await fsp.readFile(join(context.extensionUri.fsPath, 'claude-skill', 'SKILL.md'), 'utf8');
  const cli = join(context.extensionUri.fsPath, 'cli.mjs').replace(/\\/g, '/');
  const text = template.split('{{cli}}').join(cli);
  const file = skillFile();
  const before = await fsp.readFile(file, 'utf8').catch(() => null);
  if (before === text) return false;
  await fsp.mkdir(require('node:path').dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
  return true;
}

async function refreshSkill(context) {
  const before = await require('node:fs/promises').readFile(skillFile(), 'utf8').catch(() => null);
  if (before && before.includes(SKILL_MARKER) && await writeSkill(context)) {
    if (out) out.appendLine(`agent skill updated at ${skillFile()}`);
  }
}

async function installSkill(context) {
  const existing = await require('node:fs/promises').readFile(skillFile(), 'utf8').catch(() => null);
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
    ? `OneLake Studio ${version} at commit ${commit}, running from the checkout (F5) — the panel serves vscode/app/`
    : `OneLake Studio ${version}, packaged at commit ${commit}`;
  buildItem.command = 'onelakeStudio.showLog';
  buildItem.show();
  context.subscriptions.push(buildItem);

  // A failure past this point used to be INVISIBLE: activation dies half-way, the view
  // renders as an empty pane — no tree, no welcome content, no message anywhere. The
  // rest of activate is guarded so that shape can never be silent again.
  try {
    await activateInner(context);
    // After an update the skill still names the previous install's cli.mjs. Not awaited:
    // nothing on screen depends on it.
    refreshSkill(context).catch(e => out.appendLine(`agent skill not refreshed: ${e.message}`));
    out.appendLine(`activated ${version} ${commit}${dev ? ' (dev)' : ''} — signed in: ${signedIn}`);
  } catch (e) {
    out.appendLine(`ACTIVATION FAILED: ${(e && e.stack) || e}`);
    showError(`OneLake Studio failed to activate: ${(e && e.message) || e}`);
    throw e;
  }
}

async function activateInner(context) {
  // Every OneLake request the extension makes goes through here, on the VS Code token,
  // and each one is a line in the read log.
  const catalog = createCatalog({
    getToken: hostToken,
    onRequest: logRead,
  });
  // Semantic models and the .bim export: Fabric's token for the model, the storage one
  // (the same cache the catalog uses) for the one file the export writes.
  const fabric = createFabric({ getFabricToken: fabricToken });

  // What the extension knows about OneLake, kept on disk per account and served from there
  // first (onelake.js). One directory per identity — a hashed account id — so nobody is
  // ever shown another account's listings, and switching back finds its cache still warm.
  const storeRoot = join(context.globalStorageUri.fsPath, 'onelake-store-v1');
  const storeFor = key => createStore({ dir: join(storeRoot, key || 'signed-out'), ttlMs: catalogTtlMs() });
  let storeAccount = accountKey(await getSession({ createIfNone: false }).catch(() => null));
  fileCacheRoot = join(context.globalStorageUri.fsPath, 'file-cache-v1');
  fileCacheAccount = storeAccount;
  onelake = createOneLake({
    catalog,
    store: storeFor(storeAccount),
    onHit: logRead,
    prefetchEnabled: () => vscode.workspace.getConfiguration('onelakeStudio').get('prefetchMetadata', true),
    tableTtlMs: tableTtlMs(),
    // A workspace's semantic models are a listing too, kept in the same store.
    fabric,
  });
  // Semantic views: pointers to .bim files, kept per account in the extension's storage.
  semviews = createSemViews({ dir: join(context.globalStorageUri.fsPath, 'semantic-views'), onelake });
  semviews.useAccount(storeAccount);
  // An account's first time: the models already downloaded become its views, as SQL could
  // name them before views were kept.
  async function seedViews() {
    const found = [];
    const fsp = require('node:fs/promises');
    for (const ws of await fsp.readdir(modelsFolder()).catch(() => [])) {
      for (const f of await fsp.readdir(join(modelsFolder(), ws)).catch(() => [])) {
        if (!/\.bim$/i.test(f)) continue;
        const name = f.replace(/\..*$/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'model';
        if (!found.some(x => x.name.toLowerCase() === name.toLowerCase())) found.push({ name, path: join(modelsFolder(), ws, f) });
      }
    }
    await semviews.seed(found).catch(e => out && out.appendLine(`semantic views not seeded: ${e.message}`));
  }
  await seedViews();

  // Called wherever the identity may have moved; a no-op when it has not.
  rebindStore = async function rebindStore() {
    const key = accountKey(await getSession({ createIfNone: false }).catch(() => null));
    if (key === storeAccount) return;
    storeAccount = key;
    fileCacheAccount = key;   // the engine picks it up when it is next built
    onelake.useStore(storeFor(key));
    semviews.useAccount(key);
    await seedViews();
  };
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

  // A semantic model, opened: its definition (Fabric's getDefinition, TMSL) downloaded to
  // a .bim on this machine — <folder>/<workspace>/<model>.bim — and opened in the panel as
  // its model. Nothing is written to Fabric or OneLake: the extension is read only.
  function modelsFolder() {
    const set = vscode.workspace.getConfiguration('onelakeStudio').get('semanticModelsFolder', '').trim();
    return set || join(require('node:os').homedir(), 'OneLakeStudio', 'semantic-models');
  }

  const bimPath = n => join(modelsFolder(), bimFileName(n.workspace).replace(/\.bim$/, ''), bimFileName(n.model));
  // The tree's check mark: the .bim already on this machine, or null.
  const cachedModel = n => (existsSync(bimPath(n)) ? bimPath(n) : null);

  // The command line (cli.mjs) rings here: its questions are answered by THIS extension —
  // its sign-in, its cache, its engine — so an agent in a terminal reads what the tree and
  // the panel read, with no second sign-in and no second cache.
  const dev = context.extensionMode === vscode.ExtensionMode.Development;
  const agent = createAgent({
    onelake, fabric, semviews,
    bimPath: (ws, model) => bimPath({ workspace: ws, model }),
    engine: async () => {
      const { readme } = await webviewRoot(context.extensionUri, { dev });
      const eng = ensureEngine(context, { readme: readme.fsPath });
      if (!eng) throw new Error('DuckDB could not be loaded on this platform — see OneLake Studio: Show Read Log');
      return eng;
    },
    appDir: (await webviewRoot(context.extensionUri, { dev })).page.fsPath,
    vendorDir: join(context.extensionUri.fsPath, 'vendor'),
    daxSqlPin: PINS.daxSql,
  });
  context.subscriptions.push(serveBridge({
    handle: req => {
      if (out) out.appendLine(`command line: ${(req && req.args || []).join(' ').slice(0, 120)}`);
      if (!signedIn) return { out: '', err: 'OneLake Studio is not signed in — sign in from its view in VS Code.', code: 1 };
      return agent.run(req);
    },
    log: m => out && out.appendLine(m),
  }));

  // The downloaded .bim is the cache: getDefinition is a long-running export, so a model is
  // fetched from Fabric once and opened from its file after that. Download Again is `fresh`.
  async function download(n) {
    const file = vscode.Uri.file(bimPath(n));
    const bytes = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${n.model}` },
      async progress => {
        progress.report({ message: 'reading its definition from Fabric…' });
        return fabric.getBim(n.workspace, n.modelId);
      });
    await vscode.workspace.fs.writeFile(file, bytes);
    if (out) out.appendLine(`downloaded ${n.workspace}/${n.model} -> ${file.fsPath} (${fmtBytes(bytes.length)})`);
    tree.modelChanged(n);
    return bytes;
  }

  // Clicks on a model whose download is still running wait on that one, not a second export.
  const downloading = new Map();   // `${workspace}|${modelId}` -> Promise<bytes>
  async function openModel(n, { fresh = false } = {}) {
    if (!n || n.kind !== 'semanticModel') return;
    const path = bimPath(n);
    try {
      let bytes = null;
      if (!fresh) {
        bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path)).catch(() => null);
        if (bytes && out) out.appendLine(`opened ${n.workspace}/${n.model} from ${path} (cached)`);
      }
      if (!bytes) {
        const id = `${n.workspace}|${n.modelId}`;
        if (!downloading.has(id)) downloading.set(id, download(n).finally(() => downloading.delete(id)));
        bytes = await downloading.get(id);
      }
      await openInPanel({ type: 'open-model', name: bimFileName(n.model), path,
                          text: Buffer.from(bytes).toString('utf8') });
    } catch (e) {
      if (out) out.appendLine(`download of ${n.model} failed — ${(e && e.stack) || e}`);
      showError(`Could not download ${n.model}: ${(e && e.message) || e}`);
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
      // An error node names nothing itself: its Refresh is the listing that failed. Without
      // this it refreshed every lakehouse's table metadata and redrew nothing.
      if (n && n.kind === 'error') n = n.parent;
      // A model list is the Fabric API's; it says nothing about any table's metadata.
      if (!n || n.kind !== 'models') onelake.refreshTables({ workspace: n && n.workspace, item: n && n.item });
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

    vscode.commands.registerCommand('onelakeStudio.openSemanticModel', n => openModel(n)),
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
    // The account's cache is NOT deleted: it is that account's own directory (a hashed id),
    // never served to anyone else, and signing back in finds it warm. It used to be wiped
    // here — and a token refresh that failed while offline looks exactly like a sign-out,
    // so a flaky network could cost the whole disk cache. Clear Cached OneLake Data deletes it.
    //
    // A DIFFERENT account — chosen from the Accounts menu rather than Switch Account — is
    // the same teardown as a switch. It used to change nothing: the session was still
    // "live", so the panel, the engine and the cache carried on as the previous user.
    vscode.authentication.onDidChangeSessions(async e => {
      if (e.provider.id !== 'microsoft') return;
      forgetToken();
      const session = await getSession({ createIfNone: false }).catch(() => null);
      await setSignedIn(!!session);
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
      if (e.affectsConfiguration('onelakeStudio.catalogTtlMinutes') ||
          e.affectsConfiguration('onelakeStudio.tableMetadataTtlHours')) {
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
