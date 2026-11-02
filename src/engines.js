'use strict';
// =============================================================================
// engines.js — the engine this window reads with, and the files that go with it
// =============================================================================

const { join, dirname, isAbsolute } = require('node:path');
const { existsSync, statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const fsp = require('node:fs/promises');
const { createCatalogFile, catalogFileOf, stateFileOf } = require('./catalogfile');
const { createLogFile, logFileOf } = require('./logfile');

/**
 * @param {object} o
 * @param {string} o.extensionDir  where this install's files are
 * @param {string} o.storageDir  what this install keeps
 * @param {boolean} o.production  an installed build, not a checkout's: a checkout keeps its own state
 * @param {{ get: Function, store: Function }} o.secrets  where a server's session token is kept
 * @param {object} o.settings  settings.js
 * @param {() => string} o.httpProxy  a proxy the person set, or ''
 * @param {() => object} o.engineCallbacks  what an engine asks of this window
 * @param {Function} o.logBoot, o.logCatalog  readlog.js
 * @param {() => void} o.closePanel, o.closeAllTabs  what is on screen over an engine
 * @param {(message: string) => void} o.warn, o.showError  said to the person
 * @param {() => void} o.onStoreCleared  what is kept was replaced under this window: another window's Clear, or an import
 * @param {(line: string) => void} o.log
 */
function createEngines({ extensionDir, storageDir, production, secrets, settings, httpProxy, engineCallbacks, logBoot, logCatalog,
                         closePanel, closeAllTabs, warn, showError, onStoreCleared, log }) {
  // The disk cache's folder for all accounts: `file-cache-v1` under the folder the setting names,
  // or under the extension's storage. Always our own subfolder, so deleting an old cache can
  // never reach the user's files.
  function fileCacheRootFor() {
    const chosen = settings.read('cacheDirectory', '').trim();
    if (chosen && !isAbsolute(chosen)) {
      log(`cacheDirectory "${chosen}" is not a full path — using the default`);
      return join(storageDir, 'file-cache-v1');
    }
    return join(chosen || storageDir, 'file-cache-v1');
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

  // The engine's disk cache of what it reads from OneLake (engine-host.js, cache_httpfs): one
  // directory per account, like the store. Cached bytes are served without OneLake being
  // asked, so they must never be served to a different account. Set at activation and
  // whenever the account moves; null with no account known, which runs the engine without it.
  let fileCacheRoot = null;
  let fileCacheAccount = null;
  const fileCacheDirFor = key => (fileCacheRoot && key ? join(fileCacheRoot, key) : null);

  // The editor's proxy, for DuckDB's own downloads and reads: VS Code's `http.proxy` setting
  // first, then the environment variables the editor itself would honour.
  function editorProxy() {
    const configured = httpProxy();
    return configured || process.env.HTTPS_PROXY || process.env.https_proxy ||
           process.env.HTTP_PROXY || process.env.http_proxy || '';
  }

  // The shared engine (engine-client.js): DuckDB in a process of its own, one per account, with
  // every tab of every window as a client over Quack. Its session token lives in the editor's secret
  // storage, where the next window finds it.
  // One server per account and install. A rebuild of the same install replaces it (`build`).
  function sharedEngineServer(account, { background = false } = {}) {
    const script = join(extensionDir, 'dist', 'engine-server.js');
    const build = (() => { try { return statSync(script).mtimeMs; } catch (_) { return 0; } })();
    const key = [account || 'none', extensionDir, ...(background ? ['background'] : [])].join('|');
    const secret = `onelakeStudio.engineSession.${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
    // What is remembered belongs to the account, so an update keeps it. F5 has its own: the installed
    // build's server holds this file open.
    // The background engine has the same one, so what it runs is in Logs with everything else.
    const stateKey = [account || 'none', production ? '' : 'dev'].join('|');
    return {
      key, stateKey, script, build,
      stateDir: join(storageDir, 'engine-server'),
      getToken: () => secrets.get(secret),
      setToken: token => secrets.store(secret, token),
    };
  }
  // What the store keeps, in SQLite (catalogfile.js), per account: the same file for each store made
  // for it. Opening one needs no server and no DuckDB, which is why the tree can draw first.
  const catalogFiles = new Map();
  function catalogFileFor(account) {
    if (!catalogFiles.has(account)) {
      const { stateDir, stateKey } = sharedEngineServer(account);
      catalogFiles.set(account, createCatalogFile({
        file: catalogFileOf(stateDir, stateKey),
        onCleared: () => onStoreCleared(),
        log,
      }));
    }
    return catalogFiles.get(account);
  }
  // What an older version kept for this account comes across, behind a tree already drawn, and its files
  // go: the DuckDB state file, and the JSON store. That store's blobs move to the cache folder. A failure
  // leaves them where they are, and the next window tries again.
  async function importKept(account, jsonDir, cacheDir) {
    const kept = catalogFiles.get(account);
    const say = line => log(`move: ${line}`);
    let old = null, doing = 'the state file';
    try {
      if (!kept) return;
      const server = sharedEngineServer(account);
      const stateFile = stateFileOf(server.stateDir, server.stateKey);
      const hadState = existsSync(stateFile), hadJson = existsSync(jsonDir);
      if (hadState) {
        const { openOldState } = require('./oldstate');
        old = await openOldState(stateFile);
      }
      const came = await kept.importKept({ run: old && old.run, jsonDir });
      if (came) say(`${came} entries came across`);
      if (old) {
        const logs = createLogFile({ file: logFileOf(server.stateDir, server.stateKey) });
        const rows = await old.logs();
        try { logs.add(rows); } finally { logs.close(); }
        old.close();
        old = null;
        for (const f of [stateFile, `${stateFile}.wal`, `${stateFile}.holder`, `${stateFile}.bad`, `${stateFile}.wal.bad`, stateFile.replace(/\.duckdb$/, '.log')]) {
          await fsp.rm(f, { force: true }).catch(() => {});
        }
        say(`state file: ${rows.length} log rows came across, and it is gone`);
      } else say('state file: nothing to move');
      doing = 'the JSON store';
      if (hadJson) {
        const blobs = join(jsonDir, 'blobs');
        const hadBlobs = existsSync(blobs);
        if (hadBlobs) await fsp.cp(blobs, join(cacheDir, 'blobs'), { recursive: true, force: false });
        await fsp.rm(jsonDir, { recursive: true, force: true });
        await fsp.rmdir(dirname(jsonDir)).catch(() => {});
        say(`JSON store: ${hadBlobs ? 'its blobs moved to the cache folder, and ' : ''}it is gone`);
      } else say('JSON store: nothing to move');
      if (came) onStoreCleared();
    } catch (e) {
      say(`${doing} could not be read, and is tried again next time — ${e.message}`);
    } finally {
      if (old) old.close();
    }
  }
  // Sign Out and the like stop the server of every account this window has used, joined to it or not.
  const stopServers = async () => {
    const { stopServer } = require('./engine-client');
    for (const account of catalogFiles.keys()) {
      await stopServer(sharedEngineServer(account)).catch(() => {});
      await stopServer(sharedEngineServer(account, { background: true })).catch(() => {});
    }
  };
  function sharedEngineRemote(options) {
    const { createRemote } = require('./engine-client');
    return createRemote({
      ...sharedEngineServer(fileCacheAccount), options,
      onGone: () => {
        // Its views and the models the tabs defined went with it, so the tabs do too.
        closePanel();
        resetEngine({ stop: false }).catch(() => {});
        warn('OneLake Studio: the engine stopped, so its tabs closed. Opening a table starts it again.');
      },
    });
  }

  // What the engine reads when it boots: here, or in the shared engine's process.
  function engineBootOptions(account, readme) {
    const diskCacheGB = Math.max(0, Number(settings.read('diskCacheMaxGB', 64)) || 0);
    return {
      allowedPaths: readme ? [readme] : [],
      httpProxy: editorProxy(),
      // Fetched for this vsix's platform at package time (fetch-extensions.mjs); a first
      // run offline, or behind a proxy DuckDB cannot use, still has its extensions.
      bundledExtensions: join(extensionDir, 'duckdb-extensions'),
      // Beside the data cache, so the four extensions are downloaded once per install
      // rather than once per session — and never into the user's own ~/.duckdb, where
      // they would outlive the extension that fetched them.
      extensionDir: join(storageDir, 'duckdb-extensions'),
      memoryLimit: settings.read('engineMemoryLimit', '').trim(),
      threads: Math.max(0, Math.floor(Number(settings.read('engineThreads', 0)) || 0)),
      spillMaxGB: Math.max(0, Number(settings.read('engineSpillMaxGB', 0)) || 0),
      logMaxGB: Math.max(0, Number(settings.read('logMaxGB', 1)) || 0),
      maxRows: Math.min(1_000_000, Math.max(1000, Math.floor(Number(settings.read('maxResultRows', 200_000)) || 200_000))),
      // 0 is no disk cache at all.
      fileCacheDir: diskCacheGB > 0 ? fileCacheDirFor(account) : null,
      fileCacheMaxBytes: diskCacheGB * 1024 ** 3,
    };
  }

  // The engine a background job reads with (modeldata.js): a process of its own, so nothing it does is
  // in the way of a query, on one thread with few requests per read, so it holds little of the
  // connection however large the table. It shares only the disk cache, and exits when it's done.
  const BACKGROUND_ENGINE = { threads: 1, memoryLimit: '1GB', fileCacheFanout: 2 };
  let background = null, backgroundAccount = null;
  function closeBackgroundEngine({ stop = false } = {}) {
    const b = background;
    background = null;
    return b ? b.close({ stop }).catch(() => {}) : Promise.resolve();
  }
  function backgroundEngine() {
    if (resetting) return null;
    if (background && backgroundAccount !== fileCacheAccount) closeBackgroundEngine({ stop: true });
    if (background) return background;
    backgroundAccount = fileCacheAccount;
    fileCacheRoot = fileCacheRootFor();
    const { createEngineHost } = require('./engine-host');
    const { createRemote } = require('./engine-client');
    const options = { ...engineBootOptions(fileCacheAccount, null), ...BACKGROUND_ENGINE };
    const made = createEngineHost({
      ...options,
      ...engineCallbacks(),
      remote: createRemote({
        ...sharedEngineServer(fileCacheAccount, { background: true }), options,
        // Nothing is on screen over it. The next tick starts another, and carries on.
        onGone: () => { if (background === made) background = null; },
      }),
    });
    background = made;
    return made;
  }

  // `readme` is the one file outside DuckDB's own directories the engine may read (the
  // landing query) — see the lockdown in engine-host.js.
  function ensureEngine({ readme } = {}) {
    // Being stopped: one started now would be stopped too, or left over what is about to be deleted.
    if (resetting) return null;
    // An engine holds its account's token and disk cache: one built before the account moved
    // is closed, with the panel over it, never handed to the new account.
    if (engine && engineAccount !== fileCacheAccount) {
      const old = engine;
      engine = null;
      closeAllTabs();
      old.close({ stop: true }).catch(() => {});
    }
    if (engine) return engine;
    try {
      engineAccount = fileCacheAccount;
      fileCacheRoot = fileCacheRootFor();
      const { createEngineHost } = require('./engine-host');
      const booting = engineBootOptions(fileCacheAccount, readme);
      engine = createEngineHost({
        ...booting,
        ...engineCallbacks(),
        remote: sharedEngineRemote(booting),
        onLog: logBoot,
        onCatalog: logCatalog,
      });
    } catch (e) {
      log(`native DuckDB unavailable: ${e.message}`);
      showError(
        `OneLake Studio could not load DuckDB for this platform (${process.platform}-${process.arch}): ${e.message}`);
      engine = null;
    }
    return engine;
  }

  // Closing the engine is what revokes its credentials: the azure secret and every ATTACH
  // hold the access token BY VALUE, so an engine that outlives the sign-out keeps reading
  // OneLake for as long as the token lasts. ensureEngine builds it again on the next open, in
  // a few seconds. On the shared engine that means stopping the server, unless it has gone already.
  let resetting = 0;
  async function resetEngine({ stop = true } = {}) {
    resetting++;
    try {
      const e = engine;
      engine = null;
      if (e) await e.close({ stop }).catch(() => {});
      // Sign Out and Clear Cached stop what's reading too: it holds the token, and those files.
      if (stop) await closeBackgroundEngine({ stop: true });
      // A window with only the tree open isn't joined to the server, and another window may have one.
      if (stop) await stopServers().catch(() => {});
    } finally { resetting--; }
  }

  function modelsFolder() {
    return join(fileCacheRoot, 'models');
  }

  return {
    current: () => engine,
    resetting: () => resetting,
    ensureEngine, resetEngine, backgroundEngine, closeBackgroundEngine,
    sharedEngineServer, catalogFileFor, catalogFiles, importKept,
    fileCacheRootFor, fileCacheDirFor, modelsFolder,
    cacheRoot: () => fileCacheRoot,
    setCacheRoot: dir => { fileCacheRoot = dir; },
    setCacheAccount: key => { fileCacheAccount = key; },
    cacheAccount: () => fileCacheAccount,
  };
}

module.exports = { createEngines };
