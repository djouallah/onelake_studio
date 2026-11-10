'use strict';
// =============================================================================
// standalone.js — the command line with VS Code closed
// =============================================================================
// core.js with no editor around it. cli/cli.mjs comes here when nothing answers on the bridge, and for
// the commands only this does: signin, signout and serve. What a window remembers is the same files, so
// the same person has the same cache with VS Code open or not. The engine is a server of its own, since
// VS Code's has its session token in VS Code's secret storage: the two share the catalog and the disk
// cache, as the background engine does.
//
// Nothing is kept running: no sync and no idle job, and the process ends with the answer. `serve` stays,
// for as long as Excel needs it.
// =============================================================================

const { join, resolve } = require('node:path');
const { mkdirSync, readFileSync, existsSync } = require('node:fs');
const { EXIT, failureJson } = require('./bridge');
const { createConnectivity, probeOf } = require('../core/onelake/connectivity');
const { useConnectivity, inTime } = require('../core/onelake/http');
const { createSignIn } = require('../core/signin');
const { createSettings } = require('../core/settings');
const { createReadLog } = require('../core/readlog');
const { createDiagLog } = require('../core/diaglog');
const { createCore } = require('../core/core');
const { createTokenStore } = require('../core/tokenstore');
const { createMsalSession } = require('../core/msalsession');
const { pathsOf, readSettings, keptIn, commitOf } = require('../core/home');
const { connectionString, openInExcel } = require('../xmla/excel');
const { DFS_ORIGIN, modelSqlName } = require('../core/names');

const SETTLE_MS = 2_000;

// The page's files: packaged, or a checkout's.
function pageOf(extensionDir) {
  const packaged = join(extensionDir, 'webview');
  return existsSync(join(packaged, 'index.html'))
    ? { page: packaged, readme: join(packaged, 'README.md') }
    : { page: join(extensionDir, 'page'), readme: join(extensionDir, 'README.md') };
}

function buildOf(extensionDir) {
  let version = '?';
  try { version = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8')).version; } catch (_) {}
  return { version, commit: commitOf(extensionDir), dev: false };
}

/** A window with no window: what `core.js` is handed when there is no editor. */
function createStandalone({ extensionDir = join(__dirname, '..'), env = process.env, say = () => {} } = {}) {
  const { home, settingsFile } = pathsOf(extensionDir, env);
  mkdirSync(home, { recursive: true });
  const config = readSettings(settingsFile);
  const read = (key, fallback) => { const v = config[`onelakeStudio.${key}`]; return v === undefined ? fallback : v; };
  const tenant = () => String(read('tenantId', '')).trim();
  const settings = createSettings(read);
  const windowLog = createDiagLog({ appendLine() {} });
  const log = line => windowLog.appendLine(line);

  const connectivity = createConnectivity({
    probe: probeOf(ms => fetch(`${DFS_ORIGIN}/`, { method: 'HEAD', signal: AbortSignal.timeout(ms) })),
  });
  useConnectivity(connectivity);

  const state = keptIn(join(home, 'standalone-state.json'));
  const secrets = keptIn(join(home, 'standalone-secrets.json'));
  const msal = createMsalSession({ tenant, store: createTokenStore(join(home, 'standalone-token-cache.bin')) });
  const signIn = createSignIn({ session: msal.session, memento: () => state, tenant, connectivity, log });
  const readLog = createReadLog({ log, post() {}, onBurst() {} });
  const disposables = [];
  const { page, readme } = pageOf(extensionDir);

  const core = createCore({
    signIn, connectivity, settings, readLog, extensionDir, storageDir: home,
    production: true, dev: false, memento: state, secrets, serverTag: 'standalone',
    servesCommandLine: false, servesExcel: false,
    httpProxy: () => String(config['http.proxy'] || ''),
    readmePath: async () => readme,
    pageDir: async () => page,
    build: () => buildOf(extensionDir),
    editorVersion: 'none',
    outputLog: () => '(none: VS Code is not running)',
    windowLog,
    exportUi: {},
    view: { redraw() {}, queriesChanged() {}, modelChanged() {}, refresh() {}, opened: () => [], showOffline() {}, warmIfWanted() {} },
    closePanel() {}, closeAllTabs() {}, post() {},
    notify: message => say(message),
    warn: message => say(message),
    showError: message => say(message),
    setContext() {},
    onAccountChange() {},
    subscribe: d => disposables.push(d),
    log,
    mark: step => windowLog.mark(step),
  });

  // Who is signed in, and whose cache that means, as a window's first moments find out.
  let settled = null;
  const settle = () => (settled ||= (async () => {
    if (!signIn.signedOutByChoice()) await inTime(connectivity.check(), SETTLE_MS);
    const session = await signIn.getSession({ createIfNone: false }).catch(() => null);
    await core.setSignedIn(!!session);
    await core.rebindStore();
  })());

  async function close() {
    const engine = core.engines.current();
    if (engine) await engine.close({ stop: false }).catch(() => {});
    for (const d of disposables) { try { d.dispose(); } catch (_) {} }
    for (const f of core.engines.catalogFiles.values()) f.close();
    connectivity.dispose();
    readLog.stop();
  }

  return {
    settle, close, core,

    /** One request, as the bridge would have it answered. */
    async answer(request, { signal } = {}) {
      if (request.args[0] === 'export' || request.args[0] === 'semanticmodel') {
        const message = `${request.args[0]} asks for your OK in VS Code: open VS Code with OneLake Studio, and run it again`;
        return { out: request.opts.json ? failureJson(EXIT.UNAVAILABLE, message) : '', err: request.opts.json ? '' : message, code: EXIT.UNAVAILABLE };
      }
      await settle();
      return core.agent.run(request, { signal });
    },

    /** Opens the browser and waits for it. Answers who signed in. */
    async signin() {
      const session = await signIn.getSession({ createIfNone: true });
      await msal.keepOnly(session.account.id);
      signIn.rememberAccount(session);
      return session.account.label;
    },

    /** Forgets the sign-in, and stops this command line's engine, since its secret holds the token. */
    async signout() {
      await settle();
      await core.engines.resetEngine();
      await msal.clear();
      await signIn.markSignedOut();
    },

    /**
     * Excel's endpoint on a model file: `workspace` and `name` make its one SQL name, and a model in
     * the same place under that name is replaced, as NAMING.md says. The file is read again whenever
     * it changes, so a refresh in Excel sees an edit. Answers how to connect.
     */
    async serve({ file, workspace, name, open = false }) {
      await settle();
      if (!core.signedIn()) throw Object.assign(new Error('not signed in, and nothing is cached on this machine'), { code: EXIT.UNAVAILABLE });
      const path = resolve(file);
      const found = await core.models.modelFile(path, { workspace })
        .catch(e => { throw e.unknownWorkspace ? new Error(`${e.message.trim()}: give it with --workspace`) : e; });
      const model = name || found.model;
      const where = found.workspace;
      if (!where) {
        throw new Error(`${file} names its tables <lakehouse>.<schema>.<table>, in its own workspace: give it with --workspace` +
          (found.choices.length ? ` (${found.choices.join(', ')} ${found.choices.length === 1 ? 'holds' : 'hold'} ${found.lakehouses.join(', ')})` : ''));
      }
      const catalog = modelSqlName(where, model);
      await core.semviews.put(model, path, where);
      const { measures } = await core.agent.excelCube(catalog);
      const engine = core.engines.ensureEngine({ readme });
      if (!engine) throw new Error(core.engines.resetting() ? 'the engine is restarting: try again in a moment' : 'DuckDB could not be loaded on this platform');
      await engine.warm();
      const { port, token } = await core.startExcel({ create: true });
      if (open) await openInExcel({ port, token, catalog, name: model });
      return { catalog, port, url: `http://127.0.0.1:${port}/${token}/`, connection: connectionString({ port, token, catalog }), measures: measures.length, opened: !!open };
    },
  };
}

module.exports = { createStandalone };
