'use strict';
// =============================================================================
// core.js — everything a window builds that isn't about how it looks
// =============================================================================
// The store, the catalog, the engine, the command line, Excel and what happens when the account
// moves. It has no editor in it: the sign-in, what is kept, the folders, the questions and what's on
// screen are handed in, and extension/extension.js is what hands them in today.
// =============================================================================

const { join } = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { createCatalog } = require('./onelake/catalog');
const { createStore } = require('./onelake/store');
const { stateFileOf } = require('./onelake/catalogfile');
const { createSyncWorker } = require('./onelake/syncworker');
const { createTableRead, TABLE_READ_FOLDER } = require('./lake/tableread');
const { settleFileCache } = require('./lake/filecache');
const { logFileOf } = require('./logfile');
const { createOneLake } = require('./onelake/onelake');
const { createSqlTables } = require('./sqltables');
const { inTime } = require('./onelake/http');
const { createFabric, modelAccountDir } = require('./models/fabric');
const { modelSqlName } = require('./names');
const { createAgent } = require('../cli/agent');
const { serveXmla } = require('../xmla/server');
const { openInExcel } = require('../xmla/excel');
const { createModelData } = require('./models/modeldata');
const { createSemViews } = require('./models/semviews');
const { serveBridge } = require('../cli/bridge');
const { PINS } = require('./vendored');
const { createQueries } = require('./queries');
const { createModels } = require('./models/models');
const { createOneLakeWriter } = require('../fabric_app/export/onelakewrite');
const { createExport } = require('../fabric_app/export/exportflow');
const { createEngines } = require('./engine/engines');

const SESSION_WAIT_MS = 5_000;
const SESSION_SETTLE_MS = 3_000;
// How long a click, or the engine's start, gives the account provider when this window already knows its
// account. The provider shares the extension host's one thread with every other extension, and at startup it has
// been seen to take half a minute to answer.
const SESSION_MOMENT_MS = 500;

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

/**
 * @param {object} o
 * @param {object} o.signIn  signin.js
 * @param {object} o.connectivity  connectivity.js
 * @param {object} o.settings  settings.js
 * @param {object} o.readLog  readlog.js
 * @param {string} o.extensionDir  where this install's files are
 * @param {string} o.storageDir  what this install keeps
 * @param {boolean} o.production  an installed build
 * @param {string} [o.serverTag]  engines.js
 * @param {boolean} [o.servesCommandLine]  answers on the bridge
 * @param {boolean} [o.servesExcel]  opens Excel's port as it starts, once it has been used
 * @param {boolean} o.dev  run from a checkout, whose Excel endpoint is its own
 * @param {{ get: Function, update: Function }} o.memento  what outlives a window
 * @param {{ get: Function, store: Function }} o.secrets
 * @param {() => string} o.httpProxy  a proxy the person set, or ''
 * @param {() => Promise<string>} o.readmePath, o.pageDir  where the page's files are
 * @param {() => object} o.build  which build this is
 * @param {string} o.editorVersion
 * @param {() => string} o.outputLog  where the window's log is written
 * @param {object} o.windowLog  diaglog.js, for the command line's `log` and `status`
 * @param {object} o.exportUi  how Export to Fabric asks (exportflow.js)
 * @param {object} o.view  redraw, queriesChanged, modelChanged, refresh, opened, showOffline, warmIfWanted
 * @param {Function} o.closePanel, o.closeAllTabs  what is on screen over an engine
 * @param {(message: object) => void} o.post  to every tab
 * @param {(message: string, ...rest: any[]) => any} o.notify, o.warn, o.showError  said to the person
 * @param {(name: string, value: any) => any} o.setContext  what the view's menus depend on
 * @param {() => void} o.onAccountChange
 * @param {(disposable: { dispose: Function }) => void} o.subscribe  goes when the window does
 * @param {(line: string) => void} o.log
 * @param {(step: string) => void} o.mark  a step of starting up
 */
function createCore({
  signIn, connectivity, settings, readLog, extensionDir, storageDir, production, serverTag = '', servesCommandLine = true, servesExcel = true, dev, memento, secrets, httpProxy,
  readmePath, pageDir, build, editorVersion, outputLog, windowLog, exportUi, view, closePanel, closeAllTabs, post,
  notify, warn, showError, setContext, onAccountChange, subscribe, log, mark,
}) {
  const { getSession, hostToken, fabricToken, appToken, sqlToken, forgetToken, signedOutByChoice, accountKey, queryAccountOf,
          knownAccount, rememberAccount } = signIn;
  const { logRead, logBoot, logCatalog } = readLog;
  const { catalogTtlMs, tableTtlMs, keepLimitBytes } = settings;

  // Set below: what an engine, a tab and the command line ask for by the time anything can ask.
  let onelake = null, semviews = null, rebindStore = null, onStoreCleared = () => {};
  let resolveSqlTable = null, resolveSqlFile = null, resolveSqlLakehouse = null, nameModelTables = null, cachedSqlTables = null;
  let openSqlModel = null, saveQuery = null, exportExplore = null, openApp = null, modelReport = null, openExcel = null, keepOffline = null;
  let createSemanticModel = null;

  // What an engine asks of this window, whichever engine it is.
  function engineCallbacks() {
    return {
      // A failed optional extension is worth a line where someone will find it.
      onWarn: w => log(w),
      // DuckDB talks to OneLake itself, on the same cached, silent token — reads must
      // never prompt.
      // Options pass through so the engine's auth retry can say { fresh: true } and
      // actually get PAST this cache — asking it again inside the 60s window returns
      // the very token that just expired, and the retry becomes a no-op.
      getToken: opts => hostToken(opts),
      resolveTable: (ref, o) => (resolveSqlTable ? resolveSqlTable(ref, o) : Promise.reject(new Error('OneLake Studio is still starting'))),
      resolveFile: (ref, o) => (resolveSqlFile ? resolveSqlFile(ref, o) : Promise.reject(new Error('OneLake Studio is still starting'))),
      resolveLakehouse: (ref, o) => (resolveSqlLakehouse ? resolveSqlLakehouse(ref, o) : Promise.reject(new Error('OneLake Studio is still starting'))),
      // A write changed a lakehouse: its listing is read again, so the tree shows what is there now.
      onWritten: w => {
        if (!onelake) return;
        const lh = { workspace: w.workspace, item: w.item };
        const again = w.kind === 'files' ? onelake.files(lh, w.dir || '', { fresh: true }) : onelake.tables(lh, { fresh: true });
        again.catch(e => log(`${w.workspace}/${w.item} was written, and its listing could not be read again — ${(e && e.message) || e}`));
      },
      offlineReason: () => connectivity.reason(),
      // SQL's writes to OneLake: off unless the settings are on, each read at the write (package.json's Writes).
      tableWritesAllowed: () => settings.read('allowTableWrites', false) === true,
      dropAllowed: () => settings.read('allowDropTable', false) === true,
      copyAllowed: () => settings.read('allowCopyToFiles', true) !== false,
      checkConnectivity: () => connectivity.check(),
      onRowsRead: location => { if (onelake) onelake.rowsRead(location).catch(() => {}); },
      onFileRead: url => { if (onelake) onelake.fileRead(url).catch(() => {}); },
      onTablesUsed: list => { if (onelake) onelake.usage.note(list); },
      catalogTables: () => (cachedSqlTables ? cachedSqlTables() : Promise.resolve([])),
    };
  }

  // The tree and the welcome view are two states of one view: the welcome buttons show
  // while this is false. Kept in a context key rather than asked for on every render, so a
  // collapsed tree costs no token lookups. An account whose cache is known keeps the tree, with
  // no session: hasSession is what says OneLake can be asked.
  let signedIn = false;
  let hasSession = false;
  async function setSignedIn(value) {
    hasSession = !!value;
    signedIn = hasSession || !!knownAccount();
    connectivity.setSession(hasSession);
    await setContext('onelakeStudio.signedIn', signedIn);
    await setContext('onelakeStudio.hasSession', hasSession);
    onAccountChange();
  }

  const engines = createEngines({
    extensionDir, storageDir, production, serverTag, secrets, settings, httpProxy,
    engineCallbacks, logBoot, logCatalog, closePanel, closeAllTabs, warn, showError,
    onStoreCleared: () => onStoreCleared(),
    log,
  });
  const queriesRoot = join(os.homedir(), 'OneLakeStudio', 'queries');

  // Every OneLake request the extension makes goes through here, on the session's token,
  // and each one is a line in the read log.
  const catalog = createCatalog({
    getToken: hostToken,
    onRequest: logRead,
  });
  // Semantic models and their export: Fabric's token for the model, the storage one
  // (the same cache the catalog uses) for the one file the export writes.
  const fabric = createFabric({ getFabricToken: fabricToken });

  // What the extension knows about OneLake, kept on disk per account and served from there
  // first (onelake.js). One directory per identity — a hashed account id — so nobody is
  // ever shown another account's listings, and switching back finds its cache still warm.
  const storeRoot = join(storageDir, 'onelake-store-v1');
  const jsonStoreOf = key => join(storeRoot, key || 'signed-out');
  // The bytes of a Files/ object the host reads, in the one cache folder beside what DuckDB reads.
  const hostCacheOf = key => join(engines.cacheRoot(), key || 'signed-out', 'host');
  const storeFor = key => {
    const backend = engines.catalogFileFor(key);
    return createStore({ dir: hostCacheOf(key), backend, ttlMs: catalogTtlMs });
  };
  // Nothing here waits for the account provider, whose answer can take seconds. The tree opens on the
  // last account's rows, with no session asked for, and sessionChanged at the end of this function
  // moves it if a session says otherwise.
  signedIn = !!knownAccount();
  setContext('onelakeStudio.signedIn', signedIn);
  let storeAccount = (knownAccount() || {}).key || null;
  // Whether the account provider has said who is signed in. Until it has, nothing is refreshed behind
  // the tree: with no session, that would only note failures against listings that are fine.
  let sessionAsked = false;
  // The saved queries' account (queriesFolder): its own folder, by its sign-in name.
  let queryAccount = (knownAccount() || {}).queries || null;
  const queries = createQueries({
    root: () => queriesRoot, account: () => queryAccount,
    log,
    onChange: () => view.queriesChanged(),
  });
  const { adoptLooseQueries } = queries;
  saveQuery = queries.saveQuery;
  adoptLooseQueries().then(() => view.queriesChanged(), () => {});
  engines.setCacheRoot(engines.fileCacheRootFor());
  engines.setCacheAccount(storeAccount);
  // An account's cache folder tidied before the engine reads it (filecache.js): an older build's blocks go.
  const settleCache = account => {
    const dir = settings.keepsDiskCache() ? engines.fileCacheDirFor(account) : null;
    if (!dir) return;
    settleFileCache(dir).then(gone => { if (gone) engines.catalogFileFor(account).dropKept(); })
      .catch(e => log(`could not settle the disk cache in ${dir}: ${(e && e.message) || e}`));
  };
  settleCache(storeAccount);
  onelake = createOneLake({
    catalog,
    store: storeFor(storeAccount),
    onHit: logRead,
    prefetchEnabled: () => settings.read('prefetchMetadata', true),
    tableTtlMs,
    listingTtlMs: catalogTtlMs,
    refreshing: () => sessionAsked,
    // A workspace's semantic models are a listing too, kept in the same store.
    fabric,
    isOffline: () => connectivity.offline(),
  });
  mark('catalog ready');
  // A table with OneLake security, read through OneLake's table read API, in the cache folder too (tableread.js).
  const tableRead = createTableRead({
    getToken: hostToken, onRequest: logRead, ttlMs: tableTtlMs, offlineReason: () => connectivity.reason(),
    enabled: () => settings.read('securedTableRead', true) !== false,
    base: () => {
      const dir = engines.fileCacheDirFor(engines.cacheAccount());
      return dir && settings.keepsDiskCache() ? join(dir, TABLE_READ_FOLDER) : null;
    },
  });
  const sqlTables = createSqlTables({ onelake, paths: async () => (await agent.modules()).paths, tableRead,
                                      offlineReason: () => connectivity.reason() });
  resolveSqlTable = sqlTables.resolve;
  resolveSqlFile = sqlTables.resolveFile;
  resolveSqlLakehouse = sqlTables.lakehouseOf;
  nameModelTables = sqlTables.nameTables;
  // Semantic views: pointers to model files, kept per account in the extension's storage.
  // A view made or dropped is in the engine's catalog (SHOW ALL TABLES) by the next statement.
  semviews = createSemViews({ catalogFor: key => engines.catalogFileFor(key),
                              dir: join(storageDir, 'semantic-views'), onelake,
                              log,
                              onChange: () => { if (engines.current()) engines.current().catalogChanged(); } });
  semviews.useAccount(storeAccount);
  // A model's local copy is data, so it is in the cache folder. Where an older version kept them, the
  // whole of this account's folder moves, and each view is pointed at its new place.
  const oldModels = join(os.homedir(), 'OneLakeStudio', 'semantic-models');
  const models = createModels({
    onelake, fabric, semviews, modules: () => agent.modules(), modelsFolder: () => engines.modelsFolder(), account: () => queryAccount, oldModels,
    nameTables: list => sqlTables.nameTables(list),
    notify,
    onModelChanged: n => view.modelChanged(n),
    log,
  });
  const { adoptModels, modelPath, fetchModel, walkTables, forgetNames } = models;
  openSqlModel = models.openSqlModel;
  adoptModels();
  // Called wherever the identity may have moved; a no-op when it has not.
  // One at a time: two callers at once could both see the old account, or one return while
  // the other was still moving the store.
  rebindStore = serialized(async function rebind() {
    // No internet: a provider refreshing a token could only hang, every click behind it, and nobody
    // can sign in as anyone else meanwhile.
    if (connectivity.noInternet()) return;
    // With an account known, the provider gets a moment and no more: a tab opens and the engine starts on that
    // account's cache, and whoever the provider names later is a session change like any other.
    const asked = getSession({ createIfNone: false }).catch(() => null);
    const session = knownAccount()
      ? await inTime(asked, SESSION_MOMENT_MS, late => { if (late && accountKey(late) !== storeAccount) rebindStore(); })
      : await asked;
    rememberAccount(session);
    // No session is not another account: the last one's cache is what there is to show.
    const key = accountKey(session) || (knownAccount() || {}).key || null;
    if (key === storeAccount) return;
    // Its file's handle and its look every few seconds, for an account this window has left. It opens
    // again if that account comes back.
    if (engines.catalogFiles.has(storeAccount)) engines.catalogFiles.get(storeAccount).close();
    storeAccount = key;
    // In one step with the account, before anything below waits: a read in between would write the
    // new account's answers into the old account's store.
    engines.setCacheAccount(key);   // the engine picks it up when it is next built
    settleCache(key);
    onelake.useStore(storeFor(key));
    semviews.useAccount(key);
    engines.importKept(key, jsonStoreOf(key), hostCacheOf(key));
    syncWorker.reset();
    if (modelData) modelData.reset();
    forgetNames();
    // Workspace and item GUIDs belong to the account's tenant: listed again for the new one.
    fabric.reset();
    sqlTables.forget();
    // Another account's saved queries, too.
    queryAccount = queryAccountOf(session) || (knownAccount() || {}).queries || null;
    await adoptLooseQueries().catch(() => {});
    view.queriesChanged();
    if (engines.current()) engines.current().catalogChanged();
    await adoptModels();
  });
  // What the store holds moved: the engine's catalog is listed again before the next
  // statement that reads it.
  const catalogMoved = () => { if (engines.current()) engines.current().catalogChanged(); };
  subscribe({ dispose: onelake.onChanged(catalogMoved) },
                             { dispose: onelake.onTableRead(catalogMoved) });
  subscribe({ dispose: onelake.onRefreshFailed((what, e) => {
    // The cached answer stays on screen; why it could not be refreshed goes here.
    log(`refresh of ${what.kind} ${[what.workspace, what.item, what.schema, what.table]
      .filter(Boolean).join('/')} failed — ${(e && e.message) || e}`);
  }) });

  // Pinned workspaces, per Microsoft account, in what outlives a window: they survive
  // restarts and updates, and one account's pins never show up under another.
  const favKey = () => `onelakeStudio.favorites.${storeAccount || 'signed-out'}`;
  const favorites = {
    get: () => memento.get(favKey(), []),
    set: list => memento.update(favKey(), [...new Set(list)].sort((a, b) => a.localeCompare(b))),
  };

  // Keep offline (modeldata.js): set below, once what it needs exists. The idle job holds off for it.
  let modelData = null;
  // Keeps the catalog current behind everything (syncworker.js). Started once the session is known.
  const syncOwner = randomBytes(8).toString('hex');
  const syncWorker = createSyncWorker({
    onelake,
    opened: () => view.opened(),
    pinned: () => favorites.get(),
    ttlMs: catalogTtlMs,
    canFabric: () => fabricToken().then(t => !!t, () => false),
    isOffline: () => connectivity.offline(),
    lease: () => {
      try { return engines.catalogFileFor(storeAccount).lease(syncOwner, 90_000); } catch (_) { return false; }
    },
    keep: {
      limitBytes: keepLimitBytes,
      ready: () => !!engines.current() && !engines.resetting(),
      othersRunning: () => (engines.current() ? engines.current().othersRunning() : Promise.resolve(false)),
      read: (name, o) => (engines.current() ? engines.current().keepTable(name, o) : Promise.reject(Object.assign(new Error('no engine'), { cancelled: true }))),
      held: () => !!modelData && modelData.busy(),
    },
    // What the lake holds, synced to each new snapshot the catalog finds (engine-host.js lakeSync).
    lake: {
      ready: () => !!engines.current() && !engines.resetting(),
      tables: () => (engines.current() ? engines.current().lakeTables() : Promise.resolve([])),
      sync: which => (engines.current() ? engines.current().lakeSync(which) : Promise.reject(Object.assign(new Error('no engine'), { cancelled: true }))),
      othersRunning: () => (engines.current() ? engines.current().othersRunning() : Promise.resolve(true)),
      ttlMs: tableTtlMs,
    },
    log,
  });
  subscribe({ dispose: () => syncWorker.stop() });

  models.adopted().then(moved => { if (moved) view.redraw(); });

  let lastProviderAnswer = null;
  function sessionChanged() {
    return accountTurn(async () => {
      try {
        forgetToken();
        const was = hasSession;
        // The provider failing to answer says nothing about who is signed in.
        let failed = null;
        const session = await getSession({ createIfNone: false }).catch(e => { failed = e; return null; });
        const answer = failed ? 'did not answer' : session ? 'has a session' : 'has no session';
        if (answer !== lastProviderAnswer) log(`session: the account provider ${answer}${signedOutByChoice() ? ' (signed out by choice)' : ''}`);
        lastProviderAnswer = answer;
        if (failed) {
          log(`the account provider did not answer, so nothing changes — ${(failed && failed.message) || failed}`);
          return;
        }
        // Nor is a token refresh that failed for want of internet a sign-out, and nothing may have
        // noticed the internet went: asked now, before a session is taken to be gone.
        if (!session && was && !signedOutByChoice()) await connectivity.check();
        if (!session && connectivity.noInternet()) return;
        await setSignedIn(!!session);
        const before = storeAccount;
        await rebindStore();
        // Another extension's sign-in, or a token refresh of the same account, changes nothing here.
        if (was !== !!session || storeAccount !== before) view.redraw();
        if (!session) {
          if (!was) return;
          closeAllTabs();
          await engines.resetEngine();
          notify(
            'OneLake Studio signed out: the Microsoft account is no longer available. What this machine has cached is still here.');
        } else if (engines.current() && storeAccount !== before) {
          closeAllTabs();
          await engines.resetEngine();
          notify(
            `OneLake Studio is now using ${session.account.label}.`);
        }
      } catch (err) {
        log(`account change failed — ${(err && err.message) || err}`);
      }
    });
  }

  // The command line (cli.mjs) rings here: its questions are answered by THIS extension —
  // its sign-in, its cache, its engine — so an agent in a terminal reads what the tree and
  // the panel read, with no second sign-in and no second cache.
  const agent = createAgent({
    onelake, semviews,
    readNow: (job, o) => syncWorker.first(job, o),
    modelPath: (ws, model) => modelPath({ workspace: ws, model }),
    engine: async () => {
      const eng = engines.ensureEngine({ readme: await readmePath() });
      if (!eng) throw new Error(engines.resetting() ? 'the engine is restarting: try again in a moment' : 'DuckDB could not be loaded on this platform — see OneLake Studio: Show Read Log');
      return eng;
    },
    // When a module is first needed, as finding it asks the editor something, and the tree waits for nothing.
    appDir: pageDir,
    vendorDir: join(extensionDir, 'vendor'),
    daxSqlPin: PINS.daxSql,
    yamlPin: PINS.yaml,
    // `export`: Explore's own Export to Fabric (below), and the .yaml the tree wrote for a model.
    exportApp: x => (exportExplore ? exportExplore(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
    // `semanticmodel`: the tree's Create Semantic Model, for a model file in a lakehouse's Files/.
    createModel: x => (createSemanticModel ? createSemanticModel(x) : Promise.reject(new Error('OneLake Studio is still starting'))),
    fetchModel: n => fetchModel(n, { fresh: true }),
    openModel: x => openSqlModel(x),
    nameTables: list => nameModelTables(list),
    signedIn: () => signedIn,
    offlineReason: () => connectivity.reason(),
    diagnostics: {
      log: o => windowLog.lines(o),
      async status() {
        const server = engines.sharedEngineServer(storeAccount);
        const stateFile = stateFileOf(server.stateDir, server.stateKey);
        let catalog;
        try { catalog = engines.catalogFileFor(storeAccount).describe(); }
        catch (e) { catalog = { error: e.message }; }
        return {
          build: build(),
          window: { pid: process.pid, node: process.versions.node, vscode: editorVersion, upMs: Math.round(process.uptime() * 1000) },
          session: { signedIn, hasSession, signedOutByChoice: signedOutByChoice(), offline: connectivity.reason(),
                     lastProviderAnswer, account: storeAccount, queries: queryAccount },
          start: windowLog.timeline(),
          engine: { running: !!engines.current() },
          catalog,
          sync: await syncWorker.progress(),
          files: {
            logs: logFileOf(server.stateDir, server.stateKey),
            cache: engines.cacheRoot(),
            models: modelAccountDir(engines.modelsFolder(), queryAccount),
            output: outputLog(),
          },
          stillHere: {
            stateFile: existsSync(stateFile),
            jsonStore: existsSync(jsonStoreOf(storeAccount)),
            oldModels: existsSync(oldModels),
          },
        };
      },
    },
  });
  if (servesCommandLine) subscribe(serveBridge({
    handle: (req, ctx) => {
      log(`command line: ${(req && req.args || []).join(' ').slice(0, 120)}`);
      return agent.run(req, ctx);
    },
    log,
  }));

  // Keep offline, on a model's tabs: a background job that keeps every table it reads on this
  // machine (modeldata.js), in an engine of its own. Remembered per model in the catalog, it goes on
  // with the tab closed, and comes back with the next window.
  modelData = createModelData({
    tablesOf: c => agent.modelTables(c),
    resolve: (ref, o) => resolveSqlTable(ref, o),
    cachedTable: t => onelake.cached.table({ workspace: t.workspace, item: t.item }, t),
    read: (name, o) => {
      const reader = engines.backgroundEngine();
      // Whole: synced, and every file of it downloaded, so it answers with no connection.
      return reader ? reader.keepWhole(name, o) : Promise.reject(Object.assign(new Error('the engines are being stopped'), { cancelled: true }));
    },
    onIdle: () => { engines.closeBackgroundEngine(); },
    usage: onelake.usage,
    offlineReason: () => connectivity.reason(),
    ready: () => !engines.resetting(),
    lease: () => {
      try { return engines.catalogFileFor(storeAccount).lease(syncOwner, 90_000); } catch (_) { return false; }
    },
    maxBytes: settings.diskCacheBytes,
    log,
  });
  subscribe({ dispose: () => { modelData.stop(); engines.closeBackgroundEngine(); } });
  keepOffline = {
    state: ({ workspace, model }) => modelData.state(modelSqlName(workspace, model)),
    set: ({ workspace, model, on }) => modelData.set(modelSqlName(workspace, model), model, on),
  };

  // Open in Excel (xmla): the endpoint a PivotTable connects to. Its port and token outlive a
  // reload, since a saved workbook holds them, and F5 has its own so it doesn't lose the port to
  // the installed build. Not opened until the command has been used once; after that, whenever a
  // window starts, so a saved workbook refreshes with VS Code open.
  const xmlaPortKey = `xmlaPort${dev ? '.dev' : ''}`, xmlaTokenKey = `xmlaToken${dev ? '.dev' : ''}`;
  const randomPort = () => 49152 + (randomBytes(2).readUInt16LE(0) % 16384);
  let xmlaServer = null, xmlaAddress = null;
  // How long an address is waited for before it is given out anyway: a workbook that connects too early says so.
  const XMLA_UP_MS = 5000;
  // One start at a time: two callers in the same moment would otherwise each open a server.
  let xmlaStarting = null;
  async function startXmla(o = {}) {
    if (xmlaAddress) return xmlaAddress;
    if (xmlaStarting) {
      const address = await xmlaStarting;
      if (address || !o.create) return address;
    }
    xmlaStarting = startXmlaOnce(o).finally(() => { xmlaStarting = null; });
    return xmlaStarting;
  }
  async function startXmlaOnce({ create = false } = {}) {
    if (process.platform !== 'win32') return null;
    if (xmlaAddress) return xmlaAddress;
    let port = memento.get(xmlaPortKey);
    let token = await secrets.get(xmlaTokenKey);
    if (!port || !token) {
      if (!create) return null;
      port = port || randomPort();
      token = token || randomBytes(24).toString('hex');
      await secrets.store(xmlaTokenKey, token);
      await memento.update(xmlaPortKey, port);
    }
    // The address once something answers on it: given out before that, Excel (and `serve`'s caller) was
    // sometimes refused the connection, and after a port was lost it was given the port that was lost.
    const serve = p => new Promise(resolve => {
      const address = { port: p, token };
      const server = serveXmla({
        port: p, token, log,
        backend: { cube: c => agent.excelCube(c), query: (sql, o) => agent.excelQuery(sql, o) },
        // Something else took it: a new port. A workbook saved on the old one stops refreshing.
        onPortLost: () => {
          const next = randomPort();
          memento.update(xmlaPortKey, next);
          resolve(serve(next));
        },
      });
      xmlaServer = server;
      // Whichever port answers last is the address: one lost later, after this was first given out, moves it.
      server.listening.then(() => { xmlaAddress = address; resolve(address); });
    });
    const up = serve(port);
    const late = new Promise(resolve => { const t = setTimeout(() => resolve(null), XMLA_UP_MS); if (t.unref) t.unref(); });
    return (await Promise.race([up, late])) || xmlaAddress || { port, token };
  }
  subscribe({ dispose: () => { if (xmlaServer) xmlaServer.dispose(); } });
  if (servesExcel) startXmla().catch(e => log(`xmla: ${e.message}`));

  // The button on a model's Pivot: a new workbook with a PivotTable on it. A failure is thrown
  // back to the Pivot's status line, and logged. Answers what that line says when it's open.
  openExcel = async ({ workspace, model }) => {
    try {
      const { port, token } = await startXmla({ create: true });
      const catalog = modelSqlName(workspace, model);
      const { measures } = await agent.excelCube(catalog);
      await openInExcel({ port, token, catalog, name: model });
      return measures.length ? `${model} is open in Excel`
        : `${model} is open in Excel. It has no measures, so its PivotTable lists its fields' values and has no numbers: Excel only adds up a model's measures.`;
    } catch (e) {
      log(`opening ${model} in Excel failed — ${(e && e.stack) || e}`);
      throw e;
    }
  };

  cachedSqlTables = walkTables;
  onStoreCleared = () => {
    onelake.forgetKept();
    forgetNames();
    if (engines.current()) engines.current().catalogChanged();
    post({ type: 'reset' });
    view.redraw();
  };

  // The one OneLake writer (onelakewrite.js): Upload's files.
  const writer = createOneLakeWriter({ getToken: hostToken });
  const exporter = createExport({
    connectivity, modules: () => agent.modules(), appToken, powerBiToken: fabricToken, sqlToken, fabric,
    memento, extensionDir, pageDir, reportDir: join(storageDir, 'reports'),
    maxRows: () => settings.maxResultRows(),
    ui: exportUi,
    onRefresh: node => view.refresh(node),
    log,
  });
  exportExplore = exporter.exportExplore;
  openApp = exporter.openApp;
  createSemanticModel = exporter.createSemanticModel;
  // The Report tab's tiles: a model's exported zip's report.json, else the file kept for it
  // before an export, else none; Add to report and a tile's ✕ write them.
  modelReport = { load: exporter.reportOf, stamp: exporter.reportStamp, save: exporter.reportSave };

  // Behind what's on screen, once it has been built.
  function start() {
    // Behind the tree. An older version's cache comes across, and the account provider is asked who is
    // signed in. A provider that has stalled gets a few seconds, and what it says after that is taken as
    // a session change.
    mark('activation code ran');
    engines.importKept(storeAccount, jsonStoreOf(storeAccount), hostCacheOf(storeAccount));
    // Now, not after the provider has answered: a click in those seconds with no internet shouldn't wait
    // on a request's timeout to find out.
    if (!signedOutByChoice()) connectivity.check();
    (async () => {
      const answered = await inTime(getSession({ createIfNone: false }).then(s => ({ s }), () => ({ s: null })), SESSION_WAIT_MS, () => sessionChanged());
      // At startup the account provider can still be starting, and says there is no session when there
      // is: seen as a window that called itself signed out for seconds. Taken as true only a moment on.
      mark(answered ? `the account provider answered: ${answered.s ? 'a session' : 'no session'}` : `the account provider gave no answer in ${SESSION_WAIT_MS}ms`);
      if (answered && !answered.s && knownAccount() && !signedOutByChoice()) {
        log(`session: waiting ${SESSION_SETTLE_MS}ms before believing there is none`);
        await new Promise(r => setTimeout(r, SESSION_SETTLE_MS));
      }
      if (answered) await sessionChanged();
      sessionAsked = true;
      view.showOffline(connectivity.reason());
      // After a Sign Out nothing is sent, not even this; a window that lost a session to no internet
      // needs it, to find that session when the internet returns.
      if (!signedOutByChoice()) connectivity.check();
      view.warmIfWanted();
      syncWorker.start();
      modelData.start();
      mark('sync started');
      const { rows } = engines.catalogFileFor(storeAccount).describe();
      log(`catalog: ${Object.entries(rows).filter(([, n]) => n).map(([t, n]) => `${n} ${t}`).join(', ') || 'empty'}`);
    })().catch(e => { log(`the account provider could not be asked — ${(e && e.message) || e}`); });
  }

  return {
    engines, onelake, semviews, rebindStore, exportExplore, openApp, createSemanticModel, modelReport, openExcel, keepOffline, openSqlModel, nameModelTables, saveQuery,
    onStoreCleared: () => onStoreCleared(),
    // The cache folder moved from `old` (setCacheRoot): the store's Files/ bytes go to the new one too, and
    // this account's model copies move there, their views with them. Waited for before `old` is deleted.
    cacheRootMoved: old => {
      onelake.useStore(storeFor(storeAccount));
      return adoptModels(join(old, 'models')).then(moved => { if (moved) view.redraw(); });
    },
    fabric, sqlTables, syncWorker, favorites, queries, models, agent, startExcel: startXmla, writer,
    accountTurn, sessionChanged, setSignedIn, start,
    signedIn: () => signedIn, hasSession: () => hasSession, sessionAsked: () => sessionAsked,
    storeAccount: () => storeAccount, queryAccount: () => queryAccount,
  };
}

module.exports = { createCore };
