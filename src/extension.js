'use strict';
// =============================================================================
// extension.js — activation, and the reason this extension exists
// =============================================================================
// Sign-in is VS Code's: getSession('microsoft', …) goes through VS Code's own
// first-party application, which can impersonate for Azure resources — so the user signs
// in with the prompt they already use for GitHub, and registers nothing. `offline_access` is what makes the session survive a reload; without it
// the refresh token is not issued and every restart is a fresh sign-in.
// =============================================================================

// How long the extension host had been up when this file began loading: the start of the first line of
// the startup timeline, which `activate` writes down once there is a log.
const upMs = () => Math.round(process.uptime() * 1000);
const bundleBegan = upMs();

const vscode = require('vscode');
const { join, basename, dirname } = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const fsp = require('node:fs/promises');
const { quoteIdent, sqlStr } = require('./sql');
const { openPanel, setPanelTitle, nameActiveTab, closePanel, revealPanel, panelOpen, postToPanel, postLive, panelSettings } = require('./panel');
const { openPerformance, closePerformance } = require('./performance');
const { openLogs, closeLogs } = require('./logs');
const { createDiagLog, outputLogOf } = require('./diaglog');
const { createConnectivity, probeOf } = require('./connectivity');
const { useConnectivity } = require('./http');
const { createSignIn } = require('./signin');
const { createReadLog } = require('./readlog');
const { createSettings } = require('./settings');
const { queryStem } = require('./queries');
const { createCore } = require('./core');
const { dirBytes, treeBytes, removeDir } = require('./diskuse');
const { SKILL_MARKER, skillFile, writeSkill, refreshSkill } = require('../cli/skill');
const { createHostMethods } = require('./host');
const { modelFileName, modelAccountDir } = require('./fabric');
const { LakehouseTree, TREE_FILTERS } = require('./tree');
const { firstClicks } = require('./doubleclick');
const { webviewRoot } = require('./webview');
const { fmtBytes, sqlName, sqlNameOf, fileSqlName, sqlPart, modelSqlName, DFS_ORIGIN } = require('./names');
const { NAME, placeOf, tabTitle } = require('./title');
const bundleLoaded = upMs();

// The onelakeStudio.tenantId setting: the tenant to sign in to, or '' for the home one.
const tenantSetting = () => vscode.workspace.getConfiguration('onelakeStudio').get('tenantId', '').trim();

function withTenant(scopes) {
  const tenant = tenantSetting();
  // A guest in someone else's tenant has to say so; the home tenant is the default.
  return tenant ? [...scopes, `VSCODE_TENANT:${tenant}`] : scopes;
}

const QUERY_DRAFT_KEY = 'onelakeStudio.queryDraft';
// A query variable's value, for the SQL box: what was typed, or null when dismissed.
const askQueryVariable = name => vscode.window.showInputBox({
  title: `getvariable('${name}')`, prompt: `A value for ${name}, kept for this session (SET VARIABLE ${name} = … changes it)`,
  placeHolder: 'a number, or text (quoted for you)', ignoreFocusOut: true,
}).then(typed => (typed === undefined ? null : typed));
let memento = null;   // context.globalState, set first thing at activation

// Whether this window can ask OneLake anything: offline is noticed, not switched (connectivity.js).
// Any answer from OneLake's front door at all means there is internet.
let onOfflineChange = () => {};
const connectivity = createConnectivity({
  probe: probeOf(ms => fetch(`${DFS_ORIGIN}/`, { method: 'HEAD', signal: AbortSignal.timeout(ms) })),
  onChange: reason => onOfflineChange(reason),
});
useConnectivity(connectivity);

const signIn = createSignIn({
  session: (scopes, options) => vscode.authentication.getSession('microsoft', withTenant(scopes), options),
  memento: () => memento,
  tenant: tenantSetting,
  connectivity,
  log: line => out && out.appendLine(line),
});
const { getSession, getToken, hostToken, fabricToken, forgetToken, signedOutByChoice, knownAccount, lastAuthError, markSignedOut } = signIn;

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

const readLog = createReadLog({
  log: line => out && out.appendLine(line),
  post: message => postLive(message),
  // The same burst, in the editor's own status bar — the panel's indicator is invisible
  // the moment its tab is hidden, which is exactly when a long wait is being sat through
  // from somewhere else.
  onBurst: burst => {
    if (!statusItem) return;
    statusItem.text = `$(database) OneLake ${burst.hits} from disk · ${burst.misses} from OneLake`;
    statusItem.tooltip = `OneLake Studio — last burst: ${burst.reads} answer(s), ` +
      `${burst.hits} from disk, ${burst.misses} from OneLake ` +
      `(${(burst.netMs / 1000).toFixed(1)}s). Click for the read log.`;
    statusItem.show();
  },
});
const { logBoot, logOpened, whenOpened, nothingWillOpen, stop: stopReadLog } = readLog;

const settings = createSettings((key, fallback) => vscode.workspace.getConfiguration('onelakeStudio').get(key, fallback));
const { keepLimitBytes } = settings;

// The engine and what goes with it (engines.js); set first thing at activation.
let engines = null;

// Every tab of this window, for an account that is going: Logs and Performance show what it ran too.
function closeAllTabs() {
  closePanel();
  closeLogs();
  closePerformance();
}

// Points the store and the engine's disk cache at the account now signed in; a no-op when
// it has not moved. This and those below are core.js's, set by activateInner.
let rebindStore = async () => {};
// The semantic views this machine keeps (semviews.js), per account; set by activateInner.
let semviews = null;
// Export to Fabric (exportapp.js), the page's fabric.exportExplore; set by activateInner,
// which owns the agent's modules.
let exportExplore = null;
// Create Semantic Model (exportflow.js), the tree's; set by activateInner, as above.
let createSemanticModel = null;
// The Report tab's tiles (exportflow.js reportOf), the page's model.report; set by activateInner, as above.
let modelReport = null;
// Open in Excel (xmla), the page's excel.open; set by activateInner, as above.
let openExcel = null;
// Keep offline (modeldata.js), the page's model.offlineState and model.setOffline; set by activateInner, as above.
let keepOffline = null;
// A semantic model a query names (semanticmodel.ws.model), opened: its local copy kept, and
// kept as a semantic view; and a Direct Lake model's tables (by GUID) -> their SQL names. Set by activateInner.
let openSqlModel = null;
let nameModelTables = null;
// Save Query, from the panel's SQL box. Set by activateInner.
let saveQuery = null;

async function show(context, { newTab = false, ...options } = {}) {
  if (!newTab && revealPanel()) return true;
  // With an account's cache to show, or after a Sign Out, no click prompts for a sign-in: it opens
  // on what is held.
  const noPrompt = !!knownAccount() || signedOutByChoice();
  const token = noPrompt ? await hostToken() : await getToken(options);
  if (!token && !noPrompt) {
    const why = lastAuthError() ? `Sign-in failed: ${lastAuthError().message || lastAuthError()}`
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
  const eng = engines.ensureEngine({ readme: readme.fsPath });
  if (!eng) return false;
  const opened = await openPanel(context, {
    newTab,
    onOpened: logOpened, onBoot: logBoot, engine: eng, build: buildInfo,
    // The text the last tab closed with, for a tab opened to write in. One opened for what was
    // clicked starts from that (app.js offerInBox), and the draft stays for the next.
    draft: newTab || panelOpen() ? null : memento.get(QUERY_DRAFT_KEY, null),
    viewTag: randomBytes(2).toString('hex'),
    host: (tabEngine, post) => createHostMethods({
      onelake, engine: tabEngine, onStatus: message => post({ type: 'status', message }),
      saveFile, semviews, modelsDir: engines.modelsFolder(),
      // A refusal is what Explore's info line says, not a failure of the export.
      exportExplore: x => (exportExplore ? exportExplore(x).catch(e => { if (e.declined) return e.message; throw e; })
        : Promise.reject(new Error('OneLake Studio is still starting'))),
      createSemanticModel: x => (createSemanticModel ? createSemanticModel(x).catch(e => { if (e.declined) return e.message; throw e; })
        : Promise.reject(new Error('OneLake Studio is still starting'))),
      report: {
        load: x => (modelReport ? modelReport.load(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
        stamp: x => (modelReport ? modelReport.stamp(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
        save: x => (modelReport ? modelReport.save(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
      },
      openInExcel: x => (openExcel ? openExcel(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
      offlineState: x => (keepOffline ? keepOffline.state(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
      setOffline: x => (keepOffline ? keepOffline.set(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
      nameTables: list => (nameModelTables ? nameModelTables(list) : Promise.reject(new Error('OneLake Studio is still starting'))),
      copyText: text => vscode.env.clipboard.writeText(text),
      exportResult: x => exportResult(tabEngine, x),
      openDocument: async ({ as, content }) => {
        // CSV as plain text unless an extension knows the language.
        const language = as === 'json' ? 'json' : (await vscode.languages.getLanguages()).includes('csv') ? 'csv' : 'plaintext';
        const doc = await vscode.workspace.openTextDocument({ language, content });
        await vscode.window.showTextDocument(doc, { preview: false });
      },
      saveQuery: x => (saveQuery ? saveQuery(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
      saveDraft: x => memento.update(QUERY_DRAFT_KEY, x),
      askVariable: askQueryVariable,
      openModel: x => (openSqlModel ? openSqlModel(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
    }),
    // The page could not bring the engine up. Everything it buffered is already gone;
    // this is the toast that stops the failure being a spinner that never moves.
    // A panel whose engine never came up answers no click again, so the toast offers the
    // one thing that helps: a fresh panel and a fresh boot.
    onBootFailed: m => {
      nothingWillOpen();
      vscode.window.showErrorMessage(`OneLake Studio's engine failed to start: ${m}`, 'Reload', 'Show Log')
        .then(async pick => {
          if (pick === 'Show Log' && out) out.show(true);
          if (pick === 'Reload') {
            closePanel();
            await engines.resetEngine();
            vscode.commands.executeCommand('onelakeStudio.open');
          }
        });
    },
  });
  return !!opened;
}

// Where a semantic model's local copy is kept (fetchModel), for the tree, the command line
// and the panel alike: <folder>/<workspace>/<model>.yaml.

// One click acts on a tree node, and a double click is one click (doubleclick.js).
const treeClick = firstClicks();
const onClick = fn => n => (treeClick(n) ? fn(n) : undefined);

// What a new query (the Queries node's +) starts with. SHOW ALL TABLES is answered from the
// cache (cachedSqlTables), so it lists only the tables seen in the tree.
const NEW_QUERY_SQL = [
  '-- New query. A table is named lakehouse.workspace.item.schema.table.',
  '-- This lists only the tables cached on this machine: expand a lakehouse in the OneLake tree to add its tables.',
  'SHOW ALL TABLES;',
  '',
].join('\n');

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

let onAccountChange = () => {};
// Which build this window runs, for the panel's status bar: set at activation.
let buildInfo = {};

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
async function installSkill(context) {
  const existing = await fsp.readFile(skillFile(), 'utf8').catch(() => null);
  if (existing && !existing.includes(SKILL_MARKER)) {
    const pick = await vscode.window.showWarningMessage(
      `${skillFile()} exists and was not written by OneLake Studio. Replace it?`, { modal: true }, 'Replace');
    if (pick !== 'Replace') return;
  }
  await writeSkill(context.extensionUri.fsPath);
  vscode.window.showInformationMessage(
    'OneLake Studio: Claude Code and GitHub Copilot can now answer questions about your OneLake data and semantic models, ' +
    'through this extension while VS Code is open, and on Windows with it closed too. It needs Node.js on PATH.',
    'Open Skill').then(pick => {
    if (pick === 'Open Skill') vscode.window.showTextDocument(vscode.Uri.file(skillFile()));
  });
}

async function activate(context) {
  memento = context.globalState;
  out = createDiagLog(vscode.window.createOutputChannel('OneLake Studio'));
  out.mark('bundle began loading', bundleBegan);
  out.mark('bundle loaded', bundleLoaded);
  out.mark('activation begins');
  context.subscriptions.push(out, { dispose: () => connectivity.dispose() }, { dispose: out.watchFreezes() });

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
    refreshSkill(context.extensionUri.fsPath, line => out.appendLine(line)).catch(e => out.appendLine(`agent skill not refreshed: ${e.message}`));
    out.appendLine(`activated ${version} ${commit}${dev ? ' (dev)' : ''} — signed in: ${theCore.signedIn()}`);
    out.mark('activation done');
  } catch (e) {
    out.appendLine(`ACTIVATION FAILED: ${(e && e.stack) || e}`);
    showError(`OneLake Studio failed to activate: ${(e && e.message) || e}`);
    throw e;
  }
}

// What activateInner built, for what's said once it has.
let theCore = null;

async function activateInner(context) {
  const dev = context.extensionMode === vscode.ExtensionMode.Development;
  // The tree and its view are built after the core, and it asks them for nothing until then.
  let explorerView = null;
  const core = createCore({
    signIn, connectivity, settings, readLog,
    extensionDir: context.extensionUri.fsPath, storageDir: context.globalStorageUri.fsPath,
    production: context.extensionMode === vscode.ExtensionMode.Production, dev,
    // The desktop app's (src/desktop/main.js); VS Code gives none.
    serverTag: context.serverTag || '',
    memento: context.globalState, secrets: context.secrets,
    httpProxy: () => vscode.workspace.getConfiguration('http').get('proxy', ''),
    readmePath: async () => (await webviewRoot(context.extensionUri, { dev })).readme.fsPath,
    pageDir: async () => (await webviewRoot(context.extensionUri, { dev })).page.fsPath,
    build: () => buildInfo,
    editorVersion: vscode.version,
    outputLog: () => outputLogOf(dirname(context.logUri.fsPath), 'OneLake Studio'),
    windowLog: out,
    exportUi: {
      info: (...a) => vscode.window.showInformationMessage(...a),
      warn: (...a) => vscode.window.showWarningMessage(...a),
      openFolder: () => { const open = (vscode.workspace.workspaceFolders || [])[0]; return open ? open.uri.fsPath : null; },
      saveFile: async ({ defaultPath, title, saveLabel, filters }) => {
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultPath), title, saveLabel, filters });
        return uri ? uri.fsPath : null;
      },
      withProgress: (title, work) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, work),
      openExternal: url => vscode.env.openExternal(vscode.Uri.parse(url)),
      reveal: dir => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir)),
    },
    view: {
      redraw: () => tree.redraw(),
      queriesChanged: () => tree.queriesChanged(),
      modelChanged: n => tree.modelChanged(n),
      refresh: n => tree.refresh(n),
      opened: () => (explorerView && explorerView.visible ? tree.opened() : []),
      showOffline: reason => showOffline(reason),
      warmIfWanted: () => warmIfWanted(),
    },
    closePanel, closeAllTabs,
    post: message => postLive(message),
    notify: (...a) => vscode.window.showInformationMessage(...a),
    warn: (...a) => vscode.window.showWarningMessage(...a),
    showError,
    setContext: (name, value) => vscode.commands.executeCommand('setContext', name, value),
    onAccountChange: () => onAccountChange(),
    subscribe: disposable => context.subscriptions.push(disposable),
    log: line => out && out.appendLine(line),
    mark: step => out && out.mark(step),
  });
  theCore = core;
  ({ engines, onelake, semviews, rebindStore, exportExplore, createSemanticModel, modelReport, openExcel, keepOffline, openSqlModel, nameModelTables, saveQuery } = core);
  const { fabric, sqlTables, syncWorker, favorites, accountTurn, sessionChanged, setSignedIn } = core;
  const { queriesFolder, listQueries, queryPath } = core.queries;
  const { modelKey, cachedModel, unsupportedModels, unsupportedNote, fetchModel, completionNames } = core.models;

  // The explorer's filter: one type only, until the picker says otherwise. Not remembered: left
  // on from last time it would look like missing workspaces, and read them all at startup.
  let treeFilter = null;

  // The tree's first answer: how long it took, and that it needed no DuckDB. The engine, and anything
  // else that can wait, comes after this.
  const began = performance.now();
  let drawn = false;
  let asked = false;
  const treeAsked = () => {
    if (asked) return;
    asked = true;
    if (out) out.mark('VS Code asked for the tree');
  };
  const treeDrawn = () => {
    if (drawn) return;
    drawn = true;
    if (out) out.mark('tree answered');
    // A Node-API addon loads once, and only when something needs it.
    const native = Object.keys(require.cache).some(f => /node-bindings/.test(f));
    if (out) out.appendLine(`tree drawn ${Math.round(performance.now() - began)}ms into activation: DuckDB ${native ? 'loaded' : 'not loaded'}, ${engines.current() ? 'an engine' : 'no engine'} here`);
    warmIfWanted();
  };

  const tree = new LakehouseTree({
    onelake,
    favorites,
    onAsked: treeAsked,
    onDrawn: treeDrawn,
    filter: () => treeFilter,
    fabric,
    // Offline, a workspace's models are whatever listing is kept: there is no sign-in to offer.
    hasFabric: async () => connectivity.offline() || !!await fabricToken().catch(() => null),
    isSignedIn: () => core.signedIn(),
    cachedModel: n => cachedModel(n),
    queries: { list: () => listQueries() },
    unsupportedModel: n => unsupportedModels.get(modelKey(n)) || null,
    keepLimitBytes,
    internalTables: async () => {
      const { readme } = await webviewRoot(context.extensionUri, { dev: context.extensionMode === vscode.ExtensionMode.Development });
      const eng = engines.ensureEngine({ readme: readme.fsPath });
      if (!eng) throw new Error('DuckDB could not be loaded on this platform');
      const { rows } = await eng.call('query', [`SELECT table_name FROM duckdb_tables() WHERE database_name = 'system_internal' ORDER BY 1`]);
      return rows.map(r => String(r.table_name));
    },
    // A listing failure becomes an error NODE, but the stack behind it goes here.
    log: m => out && out.appendLine(m),
  });

  // Said only while offline, and why. A click signs in.
  const offlineItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  offlineItem.name = 'OneLake Studio offline';
  offlineItem.command = 'onelakeStudio.signIn';
  offlineItem.tooltip = 'OneLake Studio is working from what this machine has read. Export to Fabric, and anything never read, need OneLake. Click to sign in.';
  context.subscriptions.push(offlineItem);
  const showOffline = reason => {
    if (!reason) { offlineItem.hide(); return; }
    offlineItem.text = `$(cloud-offline) OneLake: offline (${reason})`;
    offlineItem.show();
  };
  // The sidebar's header and the panel's tab: OneLake Studio, and offline or the tenant in use.
  let titleTurn = 0;
  const refreshTitle = async () => {
    const turn = ++titleTurn;
    const offline = connectivity.offline();
    const session = offline ? null : await getSession({ createIfNone: false }).catch(() => null);
    if (turn !== titleTurn) return;
    const place = placeOf({ offline, account: session && session.account.label, tenant: tenantSetting() });
    if (explorerView) explorerView.title = place || NAME;
    setPanelTitle(tabTitle(place));
  };
  onAccountChange = refreshTitle;
  onOfflineChange = reason => {
    if (out) out.appendLine(reason ? `offline: ${reason}` : 'back online');
    showOffline(reason);
    refreshTitle();
    postLive({ type: 'connectivity' });
    if (engines.current()) engines.current().catalogChanged();
    tree.redraw();
    if (!reason) syncWorker.tick();
    // A window that started with no internet may have been told there was no session. Nothing says
    // so when the internet comes back, so ask.
    if (!connectivity.noInternet() && !core.hasSession()) sessionChanged();
  };

  // Opening a table means: make sure a panel exists, then tell it what to show. The panel
  // buffers the message if DuckDB is still booting. Boot is multi-second work with no
  // editor-side sign of life until now — withProgress is that sign.
  const showWithProgress = options => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Opening OneLake Studio…' },
    () => show(context, options));

  // Whether the panel is there to take it. Each one gets a tab of its own, so a click adds to what is
  // open and stops nothing. `tabName` is what the tab says: the table, file, model or saved query.
  async function openInPanel(msg, tabName = msg.table || msg.modelName || msg.name || (msg.path && msg.path.split('/').pop())) {
    if (!await showWithProgress({ createIfNone: true, newTab: true })) return false;
    postToPanel(msg);
    nameActiveTab(tabName);
    return true;
  }

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
  // Go to: every table, column, semantic model and measure the cache holds, in one search. A
  // pick opens it (a column or a measure: its table or model), or, with the panel open, its
  // button puts its SQL name at the SQL box's cursor.
  async function goTo() {
    const intoBox = panelOpen();
    const button = intoBox ? { iconPath: new vscode.ThemeIcon('insert'), tooltip: 'Put its SQL name in the query' }
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
      if (intoBox) postToPanel({ type: 'insert-sql', text: it.sql });
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

  // A click on a model in the tree: its local copy (read from Fabric the first time), opened in
  // the panel. One progress notification from the click until the page says it is on screen.
  async function openModel(n, { openOn = null } = {}) {
    if (!n || n.kind !== 'semanticModel') return;
    const refused = unsupportedModels.get(modelKey(n));
    if (refused) {
      vscode.window.showInformationMessage(unsupportedNote(n, refused));
      return;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Opening ${n.model}` },
        async progress => {
          const say = message => progress.report({ message });
          const { path, text } = await fetchModel(n, { say });
          say('opening it in OneLake Studio…');
          const name = modelFileName(n.model);
          const opened = whenOpened(name);
          if (!await openInPanel({ type: 'open-model', name, path, text, modelWorkspace: n.workspace, modelName: n.model, openOn })) return;
          await opened;
        });
    } catch (e) {
      // A model with no tables in OneLake is not a failure: say what the model is, quietly.
      if (e && e.unsupported) {
        if (out) out.appendLine(`not opening ${n.workspace}/${n.model}: ${e.message}`);
        vscode.window.showInformationMessage(e.message);
        return;
      }
      if (out) out.appendLine(`opening ${n.model} failed — ${(e && e.stack) || e}`);
      showError(`Could not open ${n.model}: ${(e && e.message) || e}`);
    }
  }

  // A file from disk: VS Code's Explorer or an editor's title bar, a .fabricapp's editor, the desktop
  // app's File > Open… or a double-click. A .fabricapp opens its model on the Report page, drawing this
  // file; an Ossie .yaml or a .bim opens as a model, its tables OneLake's by the names in it. `arg`: a
  // Uri, a path, or nothing (the active editor's file).
  async function openPath(arg) {
    const editor = vscode.window.activeTextEditor;
    const fsPath = typeof arg === 'string' ? arg : arg && arg.fsPath ? arg.fsPath : editor ? editor.document.uri.fsPath : null;
    if (!fsPath) return;
    const name = basename(fsPath);
    try {
      if (/\.fabricapp$/i.test(fsPath)) return await openAppFile(fsPath);
      const found = await core.models.modelFile(fsPath);
      const workspace = found.workspace || (found.choices && found.choices.length === 1 ? found.choices[0] : null);
      if (!workspace) {
        throw new Error(`${name} names its tables <lakehouse>.<schema>.<table>, and ${found.choices && found.choices.length
          ? `${found.choices.join(', ')} each hold ${found.lakehouses.join(', ')}` : `no workspace seen here holds ${found.lakehouses.join(', ')}`}: ` +
          'open it from its lakehouse\'s Files/ in the tree');
      }
      await openText({ name, path: fsPath, text: found.text, workspace, modelName: found.model });
    } catch (e) {
      if (e && e.notModel) { vscode.window.showInformationMessage(e.message); return; }
      if (out) out.appendLine(`opening ${fsPath} failed — ${(e && e.stack) || e}`);
      showError(`Could not open ${name}: ${(e && e.message) || e}`);
    }
  }

  // A model handed to a tab as text, under a progress notification until the page says it is on screen.
  async function openText(msg) {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening ${msg.name}` }, async () => {
      const opened = whenOpened(msg.name);
      if (!await openInPanel({ type: 'open-model', ...msg })) return;
      await opened;
    });
  }

  // A .fabricapp: a semantic model's app opens that model, as the tree's click does; a client-side app
  // opens on its own model.yaml, the app as it is, and Export to Fabric there publishes this file. Either
  // way on the Report page, which draws this file (exportflow.js openApp).
  async function openAppFile(fsPath) {
    if (!core.openApp) throw new Error('OneLake Studio is still starting');
    const app = await core.openApp(fsPath);
    const { workspace, model } = app.report;
    if (app.semanticModel || app.engine === 'semanticModel') {
      const name = app.semanticModel ? app.semanticModel.name : model;
      const m = (await onelake.models(workspace)).find(x => (app.semanticModel ? x.id === app.semanticModel.id : x.name === name));
      if (!m) throw new Error(`${workspace} has no semantic model ${name}: it was deleted or renamed`);
      return openModel({ kind: 'semanticModel', workspace, model: m.name, modelId: m.id }, { openOn: 'report' });
    }
    if (app.copy) {
      // Named for its model's format (model.ossie.yaml, model.bim): the tab reads the text by its name.
      return openText({ name: `${model}${app.copy.name.replace(/^model/, '')}`, path: fsPath, text: app.copy.text, workspace, modelName: model,
                        appFile: fsPath, appModel: app.modelPath, appModelFile: app.copy.name, openOn: 'report' });
    }
    // A file from before the app held its model: the model file in OneLake, as the tree opens it.
    const [ws, ...rest] = app.modelPath.split('/');
    return openInPanel({ type: 'open-file', workspace: ws, item: rest[0], path: rest.join('/'), bytes: 0, openOn: 'report' });
  }

  // The local copies of a workspace's models, read from Fabric again, behind: Refresh of the workspace
  // or its Semantic models is the one way a change made in Fabric reaches them. A model that fails
  // keeps its copy, and says why in the log.
  async function refreshModelCopies(workspace) {
    if (connectivity.offline()) return;
    const models = await onelake.models(workspace).catch(() => []);
    for (const m of models) {
      const n = { kind: 'semanticModel', workspace, model: m.name, modelId: m.id };
      if (!cachedModel(n)) continue;
      try {
        await fetchModel(n, { fresh: true });
        if (out) out.appendLine(`${workspace}/${m.name}: its local copy was read from Fabric again`);
      } catch (e) {
        if (out) out.appendLine(`${workspace}/${m.name}: its local copy was kept, as Fabric's could not be read — ${(e && e.message) || e}`);
      }
      tree.modelChanged(n);
    }
  }

  // A file or folder of the tree as SQL writes it, in the string DuckDB reads a file from. A file's
  // `path` runs from its item, and a folder's `dir` from Files/.
  const fileNameOf = n => sqlStr(fileSqlName(n, n.kind === 'dir' ? n.dir : String(n.path).replace(/^.*?\/Files\/?/, '')));
  const isFileNode = n => n.kind === 'file' || n.kind === 'dir';

  // A .fabricapp, or a model named as Ossie's tools name one (*.ossie.yaml), opened in VS Code opens in
  // OneLake Studio: its editor hands the file to openPath and closes its own empty tab ("Reopen Editor
  // With… Text Editor" still shows the text). The desktop app opens files itself (src/desktop/main.js).
  if (vscode.window.registerCustomEditorProvider) {
    for (const viewType of ['onelakeStudio.fabricApp', 'onelakeStudio.ossieModel']) {
      context.subscriptions.push(vscode.window.registerCustomEditorProvider(viewType, {
        openCustomDocument: uri => ({ uri, dispose() {} }),
        resolveCustomEditor: (doc, webviewPanel) => {
          webviewPanel.webview.html = '<p>Opened in OneLake Studio.</p>';
          setTimeout(() => webviewPanel.dispose(), 0);
          return openPath(doc.uri);
        },
      }, { supportsMultipleEditorsPerDocument: false }));
    }
  }
  // The title bar's Open in OneLake Studio, on a .bim or an Ossie .yaml open as text: by the text of
  // every open document (app/semantic.js's isOssie: a top-level version and datasets), so a dbt
  // schema.yml has none, and a file restored with the window has it as soon as this starts.
  const isModelText = d => d.uri.scheme === 'file' && (/\.bim$/i.test(d.fileName)
    || (/\.ya?ml$/i.test(d.fileName) && /^datasets:/m.test(d.getText()) && /^version:/m.test(d.getText())));
  // resourcePath is the Uri's fsPath (c:\… on Windows): both forms, so the menu's `in` finds it either way.
  const markModels = () => vscode.commands.executeCommand('setContext', 'onelakeStudio.modelPaths',
    vscode.workspace.textDocuments.filter(isModelText).flatMap(d => [d.uri.fsPath, d.uri.path]));
  if (vscode.workspace.onDidOpenTextDocument) {
    markModels();
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(markModels),
      vscode.workspace.onDidCloseTextDocument(markModels), vscode.workspace.onDidSaveTextDocument(markModels));
  }

  const explorer = vscode.window.createTreeView('onelakeStudio.explorer', {
    treeDataProvider: tree,
    showCollapseAll: true,
    // A table, a file or a semantic model dragged into an editor is its SQL name, dropped as text.
    dragAndDropController: {
      dragMimeTypes: ['text/plain'],
      dropMimeTypes: [],
      handleDrag(nodes, data) {
        const names = nodes.map(n => (n.kind === 'table' && n.table ? sqlNameOf(n, n)
          : isFileNode(n) ? fileNameOf(n)
          : n.kind === 'semanticModel' && n.model ? modelSqlName(n.workspace, n.model) : null)).filter(Boolean);
        if (names.length) data.set('text/plain', new vscode.DataTransferItem(names.join(',\n')));
      },
    },
  });
  explorerView = explorer;
  out.mark('tree registered');
  refreshTitle();

  // The engine, started once this window shows it will want one, so the first statement does
  // not wait for its boot: not at activation, which every window goes through, and not before the
  // tree has drawn and the session is known. An engine already there is left alone: ensureEngine
  // could close its panel over a moved account.
  let warming = false;
  const warmEngine = async () => {
    if (warming || engines.current() || !core.signedIn()) return;
    warming = true;
    try {
      await rebindStore();
      const { readme } = await webviewRoot(context.extensionUri, { dev });
      if (engines.current()) return;
      const eng = engines.ensureEngine({ readme: readme.fsPath });
      if (eng) await eng.warm();
    } catch (e) {
      if (out) out.appendLine(`the engine could not start ahead of a query — ${(e && e.message) || e}`);
    } finally {
      warming = false;
    }
  };
  const warmIfWanted = () => {
    if (drawn && core.sessionAsked() && explorer.visible) warmEngine();
  };

  context.subscriptions.push(
    tree,
    explorer,
    explorer.onDidChangeVisibility(warmIfWanted),

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
      if (n && (n.kind === 'models' || n.kind === 'workspace')) refreshModelCopies(n.workspace);
    }),

    vscode.commands.registerCommand('onelakeStudio.showLog', () => out.show(true)),


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
      const fileCacheDir = engines.fileCacheDirFor(core.storeAccount());
      const fileBytes = await dirBytes(fileCacheDir)
        + (fileCacheDir ? await treeBytes(join(fileCacheDir, 'lake')) + await treeBytes(join(fileCacheDir, 'secured')) : 0);
      const modelsDir = modelAccountDir(engines.modelsFolder(), core.queryAccount());
      const size = await onelake.size() + fileBytes + await treeBytes(modelsDir);
      if (!size) {
        vscode.window.showInformationMessage('OneLake Studio: the cache is empty.');
        return;
      }
      // Everything deleted here is re-read from OneLake at OneLake's speed, which is the
      // whole reason the cache exists — so it is asked first.
      const pick = await vscode.window.showWarningMessage(
        `Delete ${fmtBytes(size)} of cached OneLake listings, table metadata, files, table data and semantic model copies? They will be read from OneLake and Fabric again.`,
        { modal: true }, 'Delete');
      if (pick !== 'Delete') return;
      await onelake.clear();
      await removeDir(modelsDir);
      // This window hears nothing of its own Clear from the file.
      core.onStoreCleared();
      // The engine has the disk cache's files open and lists what was cleared: it goes first, and is
      // rebuilt on the next open. The panel's tables live in that engine, so the panel goes with it.
      closePanel();
      await engines.resetEngine();
      await removeDir(fileCacheDir);
      tree.redraw();
      vscode.window.showInformationMessage(
        `OneLake Studio: cleared ${fmtBytes(size)} of cached OneLake data.`);
    }),

    vscode.commands.registerCommand('onelakeStudio.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)),

    vscode.commands.registerCommand('onelakeStudio.showPerformance', async () => {
      const { readme } = await webviewRoot(context.extensionUri, { dev: context.extensionMode === vscode.ExtensionMode.Development });
      openPerformance({
        engine: () => engines.ensureEngine({ readme: readme.fsPath }),
        disk: async () => ({
          bytes: await treeBytes(engines.fileCacheDirFor(core.storeAccount())),
          limit: settings.diskCacheBytes(),
        }),
      });
    }),

    vscode.commands.registerCommand('onelakeStudio.showLogs', async () => {
      const { readme } = await webviewRoot(context.extensionUri, { dev: context.extensionMode === vscode.ExtensionMode.Development });
      openLogs({
        engine: () => engines.ensureEngine({ readme: readme.fsPath }),
        open: sql => openInPanel({ type: 'query', sql }),
        copy: sql => vscode.env.clipboard.writeText(sql),
        clear: async () => {
          const pick = await vscode.window.showWarningMessage(
            'Clear what the engine has run, for every window?', { modal: true }, 'Clear');
          if (pick === 'Clear') await engines.current()?.clearLogs();
        },
      });
    }),

    vscode.commands.registerCommand('onelakeStudio.openTable', onClick(n => openInPanel({
      type: 'open-table',
      workspace: n.workspace, item: n.item, schema: n.schema, table: n.table,
    }))),

    vscode.commands.registerCommand('onelakeStudio.openInternalTable', onClick(n => openInPanel({
      type: 'query', sql: `SELECT * FROM system_internal.${quoteIdent(n.table)} LIMIT 100`,
    }))),

    vscode.commands.registerCommand('onelakeStudio.openFile', onClick(n => openInPanel({
      type: 'open-file', workspace: n.workspace, item: n.item, path: n.path, bytes: n.bytes,
    }))),

    // A table's first rows, as a query in the SQL box, run at once.
    vscode.commands.registerCommand('onelakeStudio.selectTop', async n => {
      if (!n || !n.table) return;
      const top = vscode.workspace.getConfiguration('onelakeStudio').get('selectTopRows', 1000);
      const rows = Number.isInteger(top) && top > 0 ? top : 1000;
      const sql = `SELECT *\nFROM ${sqlNameOf(n, n)}\nLIMIT ${rows};\n`;
      await openInPanel({ type: 'run-sql', sql }, n.table);
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

    // A table's or a file's SQL name, for a query written by hand.
    vscode.commands.registerCommand('onelakeStudio.copySqlName', async n => {
      const isModel = n && n.kind === 'semanticModel' && n.model;
      if (!n || !(n.table || isFileNode(n) || isModel)) return;
      const name = n.table ? sqlNameOf(n, n) : isModel ? modelSqlName(n.workspace, n.model) : fileNameOf(n);
      await vscode.env.clipboard.writeText(name);
      vscode.window.setStatusBarMessage(`Copied ${name}`, 3000);
    }),
    // A file of the tree, or a semantic model's YAML (its local copy, read from Fabric first if there is
    // none yet), saved where the save dialog says. A file is read from OneLake after the dialog.
    vscode.commands.registerCommand('onelakeStudio.downloadFile', async n => {
      if (!n || !(n.kind === 'file' || (n.kind === 'semanticModel' && n.model))) return;
      const name = n.kind === 'file' ? basename(String(n.path)) : modelFileName(n.model);
      try {
        const bytes = n.kind === 'file'
          ? () => onelake.readBytes(n.workspace, n.path)
          : Buffer.from((await fetchModel(n)).text, 'utf8');
        const saved = await saveFile(name, bytes);
        if (saved) vscode.window.setStatusBarMessage(`Saved ${saved}`, 5000);
      } catch (e) {
        if (e && e.unsupported) { vscode.window.showInformationMessage(e.message); return; }
        showError(`Could not download ${name}: ${(e && e.message) || e}`);
      }
    }),
    // Files from this computer into a folder of a lakehouse's Files/ (onelakewrite.js): a name already
    // there is asked about, each file is written beside and renamed into place, and the folder is
    // listed again. Needs a connection, as Export does.
    // A .bim or .yaml in a lakehouse's Files/ made into the Power BI semantic model of its name, in
    // its workspace, and no app (exportflow.js createSemanticModel): Direct Lake or DirectQuery,
    // picked first. Needs a connection, as Export does.
    vscode.commands.registerCommand('onelakeStudio.createSemanticModel', async n => {
      if (!n || n.kind !== 'file' || !/\.(bim|ya?ml)$/i.test(String(n.path))) return;
      if (connectivity.offline()) { vscode.window.showInformationMessage('Create Semantic Model needs a connection.'); return; }
      const file = basename(String(n.path));
      const name = file.replace(/\.[^.]+$/, '');
      // What it runs on is asked in createSemanticModel's one dialog, with whether it replaces one.
      try {
        const text = Buffer.from(await onelake.readBytes(n.workspace, n.path)).toString('utf8');
        if (!createSemanticModel) throw new Error('OneLake Studio is still starting');
        vscode.window.showInformationMessage(await createSemanticModel({ file, name, text, workspace: n.workspace, path: n.path }));
      } catch (e) {
        if (e && e.declined) return;
        showError(`Create Semantic Model: ${(e && e.message) || e}`);
      }
    }),
    vscode.commands.registerCommand('onelakeStudio.uploadFiles', async n => {
      if (!n || n.kind !== 'dir') return;
      const where = `${basename(String(n.item)).replace(/\.[^.]+$/, '')}/Files${n.dir ? `/${n.dir}` : ''}`;
      if (connectivity.offline()) { vscode.window.showInformationMessage('Upload needs a connection.'); return; }
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: true, openLabel: 'Upload', title: `Upload to ${where}`,
      });
      if (!picked || !picked.length) return;
      let uploaded = 0;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Uploading to ${where}`, cancellable: true },
          async (progress, token) => {
            for (const uri of picked) {
              if (token.isCancellationRequested) break;
              const name = basename(uri.fsPath);
              const path = `${n.item}/Files/${n.dir ? `${n.dir}/` : ''}${name}`;
              const over = await core.writer.stat(n.workspace, path);
              if (over) {
                const pick = await vscode.window.showWarningMessage(`${name} is already in ${where}.`, { modal: true }, 'Replace', 'Skip');
                if (pick !== 'Replace') continue;
              }
              let last = 0;
              await core.writer.writeLocalFile(n.workspace, path, uri.fsPath, {
                over,
                cancelled: () => token.isCancellationRequested,
                onProgress: (done, size) => {
                  progress.report({ message: `${name} — ${fmtBytes(done)} of ${fmtBytes(size)}`, increment: size ? ((done - last) / size) * (100 / picked.length) : 0 });
                  last = done;
                },
              });
              uploaded++;
            }
          });
      } catch (e) {
        if (!(e && e.cancelled)) showError(`Upload to ${where} failed: ${(e && e.message) || e}`);
      } finally {
        if (uploaded) {
          tree.refresh(n);
          vscode.window.setStatusBarMessage(`Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'} to ${where}`, 5000);
        }
      }
    }),

    // Saved queries (queriesFolder): open one in the SQL box, rename, delete, show the folder.
    vscode.commands.registerCommand('onelakeStudio.openQuery', onClick(async n => {
      if (!n || !n.path) return;
      if (!existsSync(n.path)) { tree.queriesChanged(); return showError(`${n.label} is no longer in ${queriesFolder()}`); }
      await openInPanel({ type: 'query', name: n.label, sql: await fsp.readFile(n.path, 'utf8') });
    })),
    vscode.commands.registerCommand('onelakeStudio.renameQuery', async n => {
      if (!n || !n.path) return;
      const picked = await askQueryName('Rename Query', n.label);
      if (!picked || queryStem(picked) === n.label) return;
      const path = queryPath(picked);
      if (!await mayReplace(path, n.label)) return;
      try {
        // Replaces what's there, if that was agreed. An rm first would take the only copy when the name
        // differs by case alone, on a disk that ignores it.
        await fsp.rename(n.path, path);
        postLive({ type: 'query-renamed', from: n.label, to: queryStem(picked) });
      } catch (e) {
        showError(`Could not rename ${n.label}: ${(e && e.message) || e}`);
      }
      tree.queriesChanged();
    }),
    vscode.commands.registerCommand('onelakeStudio.deleteQuery', async n => {
      if (!n || !n.path) return;
      const pick = await vscode.window.showWarningMessage(`Delete the query ${n.label}?`, { modal: true }, 'Delete');
      if (pick !== 'Delete') return;
      try {
        await fsp.rm(n.path, { force: true });
        postLive({ type: 'query-deleted', name: n.label });
      } catch (e) {
        showError(`Could not delete ${n.label}: ${(e && e.message) || e}`);
      }
      tree.queriesChanged();
    }),
    // A new query in the SQL box, started with what can be queried: Save Query keeps it under
    // Queries as "Query N". Not run: one Ctrl+Enter does that.
    vscode.commands.registerCommand('onelakeStudio.newQuery', () => openInPanel({ type: 'query', sql: NEW_QUERY_SQL })),
    // Every query variable forgotten (the page keeps them): the next getvariable() asks again.
    vscode.commands.registerCommand('onelakeStudio.clearVariables', () => postLive({ type: 'clear-variables' })),
    vscode.commands.registerCommand('onelakeStudio.goTo', () => goTo()),
    vscode.commands.registerCommand('onelakeStudio.filterTree', async () => {
      const pick = await vscode.window.showQuickPick(
        [{ label: 'Everything', only: null }, ...TREE_FILTERS]
          .map(f => ({ ...f, description: f.only === treeFilter ? 'showing' : '' })),
        { placeHolder: 'Show only…' });
      if (!pick) return;
      treeFilter = pick.only;
      explorer.description = pick.only ? pick.label : undefined;
      tree.redraw();
    }),
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
    vscode.commands.registerCommand('onelakeStudio.signInFabric', onClick(async () => {
      try {
        if (await fabricToken({ createIfNone: true })) tree.redraw();
      } catch (e) {
        showError(`Could not sign in to the Fabric API: ${(e && e.message) || e}`);
      }
    })),

    vscode.commands.registerCommand('onelakeStudio.openSemanticModel', onClick(n => openModel(n))),
    vscode.commands.registerCommand('onelakeStudio.openPath', arg => openPath(arg)),
    // An app in the tree: its URL, copied by its button and opened by a click. Nothing is changed.
    vscode.commands.registerCommand('onelakeStudio.copyAppUrl', async n => {
      if (!n || !n.url) return;
      await vscode.env.clipboard.writeText(n.url);
      vscode.window.setStatusBarMessage(`Copied ${n.url}`, 3000);
    }),
    vscode.commands.registerCommand('onelakeStudio.openApp', onClick(n => {
      if (!n || !/^https:\/\//i.test(n.url || '')) return;
      vscode.env.openExternal(vscode.Uri.parse(n.url));
    })),
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
        await accountTurn(async () => {
          await setSignedIn(!!await getToken({ createIfNone: false }));
          const before = core.storeAccount();
          await rebindStore();
          // What was open read the last account's cache, and must not go on with this one's token.
          if (engines.current() && core.storeAccount() !== before) {
            closeAllTabs();
            await engines.resetEngine();
          }
          tree.redraw();
          warmIfWanted();
        });
      } catch (e) {
        showError(`Could not sign in: ${(e && e.message) || e}`);
      }
    }),

    // Out of OneLake Studio, not of VS Code, which owns the account (getSession). The engine goes,
    // since its secret holds the token by value; what is cached stays on show.
    vscode.commands.registerCommand('onelakeStudio.signOut', () => accountTurn(async () => {
      try {
        await markSignedOut();
        forgetToken();
        await setSignedIn(false);
        closeAllTabs();
        await engines.resetEngine();
        tree.redraw();
        warmIfWanted();
        vscode.window.showInformationMessage(
          `Signed out of OneLake Studio. What this machine has cached is still here.${vscode.env.appName === 'OneLake Studio' ? '' : ' VS Code keeps the account: its Accounts menu removes it.'}`);
      } catch (e) {
        showError(`Could not sign out: ${(e && e.message) || e}`);
      }
    })),

    // VS Code owns the account, and what an extension can do beyond Sign Out above is stop reusing
    // the remembered choice, which is what someone with two tenants actually wants.
    vscode.commands.registerCommand('onelakeStudio.switchAccount', () => accountTurn(async () => {
      try {
        // Ask FIRST. Tearing down before the picker meant that cancelling it still cost
        // the panel and the engine — for a switch that never happened.
        const picked = await getToken({ createIfNone: true, clearSessionPreference: true });
        if (!picked) return;
        // Now the teardown is FOR something: the panel on screen and the engine's secrets
        // belong to the account being left. Its cache does not need deleting — it is that
        // account's own directory, and the new account gets its own.
        closeAllTabs();
        forgetToken();
        // The store before anything waits: from here a token is the new account's, and what a background
        // read brings back with it must not land in the old account's catalog.
        await rebindStore();
        await engines.resetEngine();
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
    vscode.authentication.onDidChangeSessions(e => e.provider.id === 'microsoft' && sessionChanged()),

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
            sqlTables.forget();
            // Whether there is a session in this tenant, which nothing else asks: no internet can't say.
            if (!connectivity.noInternet()) await setSignedIn(!!await getToken({ createIfNone: false }));
            await rebindStore();
            refreshTitle();
            tree.redraw();
            if (engines.current()) {
              closeAllTabs();
              await engines.resetEngine();
            }
          } catch (err) {
            if (out) out.appendLine(`tenant change failed — ${(err && err.message) || err}`);
          }
        });
      }
      // The engine reads these when it is built: a running one keeps the old values until it
      // is restarted (which closes the tabs, whose views live in it).
      if (engines.current() && (e.affectsConfiguration('onelakeStudio.engineMemoryLimit') ||
                     e.affectsConfiguration('onelakeStudio.engineThreads') ||
                     e.affectsConfiguration('onelakeStudio.engineSpillMaxGB') ||
                     e.affectsConfiguration('onelakeStudio.logMaxGB') ||
                     e.affectsConfiguration('onelakeStudio.maxResultRows') ||
                     e.affectsConfiguration('onelakeStudio.diskCacheMaxGB') ||
                     e.affectsConfiguration('http.proxy'))) {
        const pick = await vscode.window.showInformationMessage(
          'OneLake Studio: the engine uses the new setting once it restarts. Restarting closes every tab, in every window.',
          'Restart Engine');
        if (pick === 'Restart Engine' && engines.current()) {
          closePanel();
          await engines.resetEngine();
          vscode.commands.executeCommand('onelakeStudio.open');
        }
      }
      // A new folder starts empty, and the old one stays until it is deleted here. A running
      // engine has the old one's files open, and keeps it until it restarts.
      if (e.affectsConfiguration('onelakeStudio.cacheDirectory')) {
        const old = engines.cacheRoot(), next = engines.fileCacheRootFor();
        if (next !== old) {
          const running = !!engines.current();
          let moved = Promise.resolve();
          if (!running) { engines.setCacheRoot(next); moved = core.cacheRootMoved(old); }
          const remove = running ? 'Restart Engine and Delete Old Cache' : 'Delete Old Cache';
          const actions = running ? [remove, 'Restart Engine'] : [remove];
          const pick = await vscode.window.showInformationMessage(
            `OneLake Studio: table data is now cached in ${next}, which starts empty. The old cache is still in ${old}.`,
            ...actions);
          if (pick && running && engines.current()) {
            closePanel();
            await engines.resetEngine();
            engines.setCacheRoot(next);
            moved = core.cacheRootMoved(old);
            vscode.commands.executeCommand('onelakeStudio.open');
          }
          if (pick === remove) { await moved; await removeDir(old); }
        }
      }
      if (e.affectsConfiguration('onelakeStudio.tableOpensOn') ||
          e.affectsConfiguration('onelakeStudio.gridThousandsSeparator')) {
        postLive({ type: 'settings', ...panelSettings() });
      }
    }),
  );

  core.start();
}

function deactivate() {
  stopReadLog();
  if (engines) for (const f of engines.catalogFiles.values()) f.close();
  // The engine holds a native database handle and a temp directory; closing it is what
  // releases both.
  return engines && engines.current() ? engines.current().close() : undefined;
}

module.exports = { activate, deactivate };
