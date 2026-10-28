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
const fsp = require('node:fs/promises');
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
const { planReport, generateReport } = require('./report');
const { planExport, writeExport, buildDist, writeMarker, readMarker, fingerprint, localChanges, zip, rayfinYml } = require('./exportapp');
const { createFabricApp, tenantOf } = require('./fabricapp');
const { createOneLakeWriter } = require('./onelakewrite');

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

// Export to Fabric's token (fabricapp.js): the Fabric API's own audience, never Power BI's —
// the app item's workload routes are the Fabric API's. The same account as the storage
// session, as fabricToken asks. `createIfNone` on the button's click, which may prompt.
let cachedApp = null;   // { token, at }
async function appToken({ fresh = false, createIfNone = false } = {}) {
  if (!fresh && !createIfNone && cachedApp && Date.now() - cachedApp.at < TOKEN_TTL_MS) return cachedApp.token;
  const storage = await getSession({ createIfNone: false }).catch(() => null);
  if (!storage) return null;
  const s = await vscode.authentication.getSession('microsoft',
    withTenant([FABRIC_AUDIENCES[0], 'offline_access']), { createIfNone, account: storage.account });
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

// Who is waiting for the page to say a file is on screen (a semantic model's progress
// notification, which stays up until then): { label, resolve }.
const openedWaiters = new Set();
function whenOpened(label, ms = 60_000) {
  return new Promise(resolve => {
    const w = { label, resolve };
    openedWaiters.add(w);
    setTimeout(() => { openedWaiters.delete(w); resolve(false); }, ms);
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
// Export to Fabric (exportapp.js), the page's fabric.exportExplore; set by activateInner,
// which owns the agent's modules.
let exportExplore = null;

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
      exportExplore: x => (exportExplore ? exportExplore(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
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
// bin/cli.mjs is this extension's modules from a shell; claude-skill/SKILL.md tells an agent
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
  const cli = join(context.extensionUri.fsPath, 'bin', 'cli.mjs').replace(/\\/g, '/');
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
    ? `OneLake Studio ${version} at commit ${commit}, running from the checkout (F5) — the panel serves app/`
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

  // Where the command line (agent.js) keeps the .bim files it downloads: <folder>/<workspace>/
  // <model>.bim. The tree's clicks write a model into its lakehouse instead (openModel).
  function modelsFolder() {
    return join(require('node:os').homedir(), 'OneLakeStudio', 'semantic-models');
  }

  const bimPath = n => join(modelsFolder(), bimFileName(n.workspace).replace(/\.bim$/, ''), bimFileName(n.model));

  // Where each semantic model was written in OneLake, per account: { workspace, item, path }.
  // The tree's check mark, and what a click opens without asking Fabric again.
  const modelFilesKey = () => `onelakeStudio.modelFiles.${storeAccount || 'signed-out'}`;
  const modelKey = n => `${n.workspace}|${n.modelId}`;
  const modelFile = n => context.globalState.get(modelFilesKey(), {})[modelKey(n)] || null;
  const rememberModelFile = (n, where) => context.globalState.update(modelFilesKey(),
    { ...context.globalState.get(modelFilesKey(), {}), [modelKey(n)]: where });
  const cachedModel = n => modelFile(n);

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
    yamlPin: PINS.yaml,
  });
  context.subscriptions.push(serveBridge({
    handle: req => {
      if (out) out.appendLine(`command line: ${(req && req.args || []).join(' ').slice(0, 120)}`);
      if (!signedIn) return { out: '', err: 'OneLake Studio is not signed in — sign in from its view in VS Code.', code: 1 };
      return agent.run(req);
    },
    log: m => out && out.appendLine(m),
  }));

  // A semantic model, opened from the tree: its definition (Fabric's getDefinition, TMSL)
  // written as a .bim into the Files/ of the lakehouse its Direct Lake expression names —
  // <lakehouse>/Files/semantic_model/<model>.bim — and opened from there like any Files/
  // model, so Explore can export it to Fabric. A model that is not Direct Lake on one
  // lakehouse is refused, and nothing is written. The file, once there, is what later clicks
  // open; Download Again (`fresh`) reads Fabric again and overwrites it, after asking.
  const writer = createOneLakeWriter({ getToken: hostToken });
  const openFileInPanel = (where, bytes) => openInPanel({ type: 'open-file',
    workspace: where.workspace, item: where.item, path: where.path, bytes });

  // One step after another under the caller's progress notification (`say`), so nothing
  // happens off screen: the definition, its lakehouse, the write.
  async function exportModel(n, known, say) {
    say('reading its definition from Fabric…');
    const bim = await fabric.getBim(n.workspace, n.modelId);
    let doc;
    try { doc = JSON.parse(Buffer.from(bim).toString('utf8').replace(/^\uFEFF/, '')); }
    catch (e) { throw new Error(`its definition is not TMSL: ${e.message}`); }
    const lakes = (await agent.modules()).semantic.lakehousesOf(doc);
    if (lakes.length !== 1) {
      throw new Error(`${n.model} is not Direct Lake on one lakehouse (it names ${lakes.length}): OneLake Studio opens those only`);
    }
    say('finding its lakehouse…');
    const lh = await fabric.itemOf(lakes[0].workspace, lakes[0].item);
    const where = { ...lh, path: `${lh.item}/Files/semantic_model/${bimFileName(n.model)}` };
    const there = await writer.stat(where.workspace, where.path);
    const ours = known && known.workspace === where.workspace && known.path === where.path;
    if (there && !ours) {
      const pick = await vscode.window.showWarningMessage(
        `${where.workspace}/${where.path} already exists.`,
        { modal: true, detail: `Replace it with ${n.model}'s current definition from Fabric, or open the file that is there?` },
        'Replace It', 'Open Existing');
      if (!pick) return null;
      if (pick === 'Open Existing') {
        await rememberModelFile(n, where);
        tree.modelChanged(n);
        return { where, bytes: there.bytes };
      }
    }
    say(`writing it to ${where.item.replace(/\.[^.]+$/, '')}/Files/semantic_model…`);
    await writer.writeFile(where.workspace, where.path, bim);
    if (out) out.appendLine(`wrote ${n.workspace}/${n.model} -> ${where.workspace}/${where.path} (${fmtBytes(bim.length)})`);
    await rememberModelFile(n, where);
    // The listing again, so the file's bytes are read by its new version, not served old.
    const lhOf = { workspace: where.workspace, item: where.item };
    await onelake.files(lhOf, 'semantic_model', { fresh: true }).catch(() => {});
    tree.refresh({ kind: 'dir', ...lhOf, dir: 'semantic_model' });
    tree.modelChanged(n);
    return { where, bytes: bim.length };
  }

  // Clicks on a model whose export is still running wait on that one, not a second. One
  // progress notification from the click until the page says the model is on screen.
  const exporting = new Map();   // `${workspace}|${modelId}` -> Promise
  async function openModel(n, { fresh = false } = {}) {
    if (!n || n.kind !== 'semanticModel') return;
    try {
      const known = modelFile(n);
      if (known && fresh) {
        const pick = await vscode.window.showWarningMessage(
          `Overwrite ${known.workspace}/${known.path} with ${n.model}'s current definition from Fabric?`,
          { modal: true }, 'Overwrite');
        if (pick !== 'Overwrite') return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Opening ${n.model}` },
        async progress => {
          const say = message => progress.report({ message });
          let target = null;
          if (known && !fresh) {
            say(`from ${known.item.replace(/\.[^.]+$/, '')}/Files/semantic_model…`);
            const there = await writer.stat(known.workspace, known.path).catch(() => null);
            if (there) {
              if (out) out.appendLine(`opened ${n.workspace}/${n.model} from ${known.workspace}/${known.path}`);
              target = { where: known, bytes: there.bytes };
            }
          }
          if (!target) {
            const id = modelKey(n);
            if (!exporting.has(id)) exporting.set(id, exportModel(n, known, say).finally(() => exporting.delete(id)));
            target = await exporting.get(id);
          }
          if (!target) return;
          say('opening it in OneLake Studio…');
          const opened = whenOpened(require('node:path').posix.basename(target.where.path));
          await openFileInPanel(target.where, target.bytes);
          await opened;
        });
    } catch (e) {
      if (out) out.appendLine(`opening ${n.model} failed — ${(e && e.stack) || e}`);
      showError(`Could not open ${n.model}: ${(e && e.message) || e}`);
    }
  }

  // Generate Report, on an Ossie model in Files/: a Fabric app (Rayfin, DuckDB-WASM over the
  // lakehouse's Iceberg catalog, which the model names) written to a folder of this machine,
  // from the template vendored at PINS.reportTemplate (report.js). Nothing is deployed.
  async function generateReportFrom(n) {
    if (!n || n.kind !== 'file') return;
    const fileName = n.label || require('node:path').basename(n.path);
    try {
      const text = Buffer.from(await onelake.readBytes(n.workspace, n.path)).toString('utf8');
      const plan = planReport(text, fileName, await agent.modules());
      const folder = (vscode.workspace.workspaceFolders || [])[0];
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        defaultUri: folder ? folder.uri : vscode.Uri.file(require('node:os').homedir()),
        openLabel: 'Generate Here',
        title: `Generate Report: the folder to create ${plan.name}/ in`,
      });
      if (!picked || !picked.length) return;
      const vendor = join(context.extensionUri.fsPath, 'vendor', 'gh');
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Generating ${plan.name}` },
        () => generateReport({ plan, text, outDir: join(picked[0].fsPath, plan.name),
                               templateDir: join(vendor, PINS.reportTemplate), daxSqlDir: join(vendor, PINS.daxSql) }));
      if (out) {
        out.appendLine(`generated report ${r.name} -> ${r.dir} (catalog ${r.catalogUrl}, chart ${r.chart})`);
        for (const w of r.warnings) out.appendLine(`  warning: ${w}`);
      }
      const warned = r.warnings.length ? ` ${r.warnings.length} warning(s) in the log.` : '';
      const pick = await vscode.window.showInformationMessage(
        `Report ${r.name} generated: ${r.chart}.${warned}`, 'Open Folder', 'Reveal');
      if (pick === 'Open Folder') vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(r.dir), { forceNewWindow: true });
      else if (pick === 'Reveal') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(r.dir));
    } catch (e) {
      if (out) out.appendLine(`generate report from ${n.path} failed — ${(e && e.stack) || e}`);
      showError(`Generate Report: ${(e && e.message) || e}`);
    }
  }

  // Export to Fabric, from Explore: the model's Explore as a Fabric app (exportapp.js), its
  // local copy written to <the open folder>/<app>/ (asked for when no folder is open) —
  // and published from there over the Fabric REST API (fabricapp.js). The function's deploy
  // package ships in the vsix (fabric-function/, scripts/function-bundle.mjs). Answers what
  // Explore's info line says; a failure is thrown back to it, and logged.
  exportExplore = async ({ file, name, text, state, workspace, path }) => {
    try {
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
          defaultUri: vscode.Uri.file(prev ? require('node:path').dirname(prev) : require('node:os').homedir()),
          openLabel: 'Export Here',
          title: `Export to Fabric: the folder to keep the app's local copy (${plan.name}/) in`,
        });
        if (!picked || !picked.length) return null;
        // The app's own folder picked, rather than the one to put it in: used as it is.
        const dir = picked[0].fsPath;
        return require('node:path').basename(dir) === plan.name ? dir : join(dir, plan.name);
      };
      for (;;) {
        if (!outDir) {
          outDir = await pickFolder();
          if (!outDir) return 'Export cancelled.';
        }
        const pick = await vscode.window.showInformationMessage(
          `Export ${plan.name} to Fabric?`,
          { modal: true, detail: `Local copy: ${outDir}${existsSync(outDir) ? '' : ' (new)'}\nWorkspace: ${workspace}\nModel: ${plan.modelPath}` },
          'Export', 'Choose Another Folder…');
        if (pick === 'Export') break;
        if (!pick) return 'Export cancelled.';
        prev = outDir;
        outDir = null;
      }
      // A folder Export to Fabric did not write is refused here, before anything else is asked.
      const before = await readMarker(outDir);
      await context.globalState.update(key, outDir);
      const fabricApp = createFabricApp({ getToken: appToken, log: m => out && out.appendLine(m) });

      // Edited since it was last published (by you, or an agent)? Asked, never overwritten.
      let asIs = false;
      const changed = await localChanges(outDir, before);
      if (changed.length) {
        const shown = changed.slice(0, 5).join('\n') + (changed.length > 5 ? `\n…and ${changed.length - 5} more` : '');
        const pick = await vscode.window.showWarningMessage(
          `The local copy of ${plan.name} has changed since it was last published.`,
          { modal: true, detail: `${outDir}\n\n${shown}\n\nOverwrite: rewrite it from this Explore, and publish that. Publish As Is: publish the folder with your changes, and leave it alone.` },
          'Overwrite Local Changes', 'Publish Folder As Is');
        if (!pick) return 'Not exported: the local copy has changes.';
        asIs = pick === 'Publish Folder As Is';
      }

      // Deployed again since this folder published it (another machine, analytics-as-code,
      // rayfin up)? Asked before it is replaced.
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
          if (pick !== 'Overwrite It') return `Not exported: ${plan.name} was deployed from elsewhere since.`;
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
                                         daxSqlDir: join(ext, 'vendor', 'gh', PINS.daxSql) });
          }
          const done = await createFabricApp({ getToken: appToken, log: say }).publish({
            workspaceId: plan.workspace, name: plan.name, tenantId: tenantOf(token),
            catalogUrl: plan.catalogUrl, modelUrl: plan.modelUrl,
            site: async config => zip(await buildDist(outDir, config)),
            fn: { sourceZip, deployMetaData }, redirects: marker.redirects || [],
            itemId: marker.itemId || null, takeOver,
          });
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
        if (pick !== 'Replace It') return `Not exported: an app named ${e.item.displayName} already exists.`;
        r = await publish(true);
      }
      // The workspace's Apps, re-read: the app is new, or deployed again.
      tree.refresh({ kind: 'apps', workspace });
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
      if (out) out.appendLine(`export to fabric of ${file} failed — ${(e && e.stack) || e}`);
      throw e;
    }
  };

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

    vscode.commands.registerCommand('onelakeStudio.openTable', n => openInPanel({
      type: 'open-table',
      workspace: n.workspace, item: n.item, schema: n.schema, table: n.table,
    })),

    vscode.commands.registerCommand('onelakeStudio.openFile', n => openInPanel({
      type: 'open-file', workspace: n.workspace, item: n.item, path: n.path, bytes: n.bytes,
    })),

    vscode.commands.registerCommand('onelakeStudio.generateReport', n => generateReportFrom(n)),

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
