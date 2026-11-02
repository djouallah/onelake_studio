'use strict';
// =============================================================================
// standalone.js — the command line with VS Code closed
// =============================================================================
// core.js with no editor around it. bin/cli.mjs comes here when nothing answers on the bridge, and for
// the commands only this does: signin, signout and serve. What a window remembers is the same files, so
// the same person has the same cache with VS Code open or not. The engine is a server of its own, since
// VS Code's has its session token in VS Code's secret storage: the two share the catalog and the disk
// cache, as the background engine does.
//
// Nothing is kept running: no sync and no idle job, and the process ends with the answer. `serve` stays,
// for as long as Excel needs it.
// =============================================================================

const { join, resolve, basename, extname } = require('node:path');
const { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } = require('node:fs');
const fsp = require('node:fs/promises');
const { EXIT, failureJson } = require('./bridge');
const { createConnectivity, probeOf } = require('./connectivity');
const { useConnectivity, inTime } = require('./http');
const { createSignIn } = require('./signin');
const { createSettings } = require('./settings');
const { createReadLog } = require('./readlog');
const { createDiagLog } = require('./diaglog');
const { createCore } = require('./core');
const { createTokenStore } = require('./tokenstore');
const { createMsalSession } = require('./msalsession');
const { connectionString, openInExcel } = require('./xmla/excel');
const { DFS_ORIGIN, modelSqlName } = require('./names');

const EXTENSION_ID = 'djouallah.onelake-studio';
const SETTLE_MS = 2_000;

// Where VS Code keeps this extension's files, for whichever VS Code this install is under, so the extension,
// the command line and the desktop app read one cache. With no VS Code, the app's own folder.
// ONELAKE_STUDIO_HOME keeps it all somewhere else.
function pathsOf(extensionDir, env = process.env, exists = existsSync) {
  if (env.ONELAKE_STUDIO_HOME) return { home: env.ONELAKE_STUDIO_HOME, settingsFile: join(env.ONELAKE_STUDIO_HOME, 'settings.json') };
  const product = /[\\/]\.vscode-insiders[\\/]/i.test(extensionDir) ? 'Code - Insiders' : 'Code';
  const user = join(env.APPDATA || '', product, 'User');
  const vscodeHome = join(user, 'globalStorage', EXTENSION_ID);
  if (exists(vscodeHome) || /[\\/]\.vscode(-insiders)?[\\/]/i.test(extensionDir)) return { home: vscodeHome, settingsFile: join(user, 'settings.json') };
  const own = join(env.LOCALAPPDATA || env.APPDATA || '', 'OneLake Studio', 'data');
  return { home: own, settingsFile: join(own, 'settings.json') };
}

// VS Code's settings.json allows comments and trailing commas. Text in a string is left alone.
function parseSettings(text) {
  const plain = String(text).replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, m => (m[0] === '"' ? m : ''))
    .replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (m, tail) => (m[0] === '"' ? m : tail));
  try {
    const v = JSON.parse(plain);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) { return {}; }
}

function readSettings(file) {
  try { return parseSettings(readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

// A small JSON file with what VS Code's globalState and secrets hold there. Only this user can read it
// (their own profile's folder, and 0600 elsewhere). What's secret in it opens a local port, no more.
function keptIn(file) {
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (_) { return {}; } };
  const put = (key, value) => {
    const all = load();
    if (value === undefined) delete all[key]; else all[key] = value;
    const partial = `${file}.${process.pid}.tmp`;
    writeFileSync(partial, JSON.stringify(all), { mode: 0o600 });
    renameSync(partial, file);
  };
  return {
    get: (key, fallback) => { const v = load()[key]; return v === undefined ? fallback : v; },
    update: async (key, value) => put(key, value),
    store: async (key, value) => put(key, value),
  };
}

// The page's files: packaged, or a checkout's.
function pageOf(extensionDir) {
  const packaged = join(extensionDir, 'webview');
  return existsSync(join(packaged, 'index.html'))
    ? { page: packaged, readme: join(packaged, 'README.md') }
    : { page: join(extensionDir, 'app'), readme: join(extensionDir, 'README.md') };
}

function buildOf(extensionDir) {
  let version = '?', commit = 'unknown';
  try { version = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8')).version; } catch (_) {}
  try { commit = String(JSON.parse(readFileSync(join(extensionDir, 'webview', 'build.json'), 'utf8')).commit); } catch (_) {}
  return { version, commit, dev: false };
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
      if (request.args[0] === 'export') {
        const message = 'export asks for your OK in VS Code: open VS Code with OneLake Studio, and run it again';
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
      const text = await fsp.readFile(path, 'utf8').catch(e => { throw new Error(`${file} could not be read: ${e.message}`); });
      const { semantic, compiler } = await core.agent.modules();
      const lakes = semantic.lakehousesOf(semantic.bimOf(path, text, compiler));
      const model = name || basename(path, extname(path));
      const where = workspace || await workspaceOf(lakes, core.onelake, file);
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

// The workspace a model file's tables are in, when it names just one: a model's name is its workspace's
// and its own, wherever the file is. From what's kept if it can be, so it works with no connection.
async function workspaceOf(lakes, onelake, file) {
  const named = [...new Set(lakes.map(l => l.workspace))];
  const ask = `give it with --workspace`;
  if (named.length !== 1) throw new Error(`${file} reads ${named.length ? `${named.length} workspaces` : 'no lakehouse'}: ${ask}`);
  const item = await onelake.itemNamed(named[0], lakes[0].item)
    .catch(e => { throw new Error(`the name of ${file}'s workspace could not be read (${e.message}): ${ask}`); });
  return item.workspace;
}

module.exports = { createStandalone, pathsOf, parseSettings, readSettings, keptIn };
