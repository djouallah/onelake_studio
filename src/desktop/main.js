'use strict';
// =============================================================================
// main.js — the desktop app's Node process
// =============================================================================
// Starts src/extension.js with `vscode` pointing at vscode.js, serves the window (server.js), and says
// on stdout where: one line of JSON, for the Tauri shell to navigate to. Each line after that is something
// only the shell can do: exit, zoom. It ends when its stdin does, which is when the shell does.
// =============================================================================

const { join, dirname } = require('node:path');
const { existsSync, mkdirSync, readFileSync, appendFileSync } = require('node:fs');
const vscode = require('vscode');
const { createServer } = require('./server');
const dialogs = require('./dialogs');
const { pathsOf, readSettings, keptIn } = require('../standalone');
const { createMsalSession } = require('../msalsession');
const { createTokenStore } = require('../tokenstore');
const extension = require('../extension');
const { checkUpdate } = require('./update');

const { desktop } = vscode;

const WELCOME = 'Browse OneLake with your Microsoft account. There is nothing to register.';

// To the Tauri shell, after the first line: { do: 'exit' } or { do: 'zoom', factor }.
const shell = request => process.stdout.write(`${JSON.stringify(request)}\n`);

// The commit this build was packaged at, as the status bar's stamp reads it.
function commitOf(extensionDir) {
  try { return String(JSON.parse(readFileSync(join(extensionDir, 'webview', 'build.json'), 'utf8')).commit || 'unknown'); } catch (_) { return 'unknown'; }
}

async function main() {
  const extensionDir = join(__dirname, '..');
  const packageJSON = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8'));
  const { home, settingsFile } = pathsOf(extensionDir);
  mkdirSync(home, { recursive: true });
  const logFile = join(home, 'desktop.log');
  const log = line => {
    const text = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(text);
    try { appendFileSync(logFile, text); } catch (_) {}
  };
  process.on('uncaughtException', e => log(`uncaught: ${(e && e.stack) || e}`));
  process.on('unhandledRejection', e => log(`unhandled: ${(e && e.stack) || e}`));

  // VS Code's settings where there are any, so the app reads the same tenant and the same cache, and
  // whatever is changed in the app's Settings tab over them.
  const appSettings = keptIn(join(home, 'app-settings.json'));
  // How the window was left: the tree's width, whether it shows, the zoom. Not the page's localStorage:
  // its origin's port is new each start.
  const windowState = keptIn(join(home, 'window-state.json'));
  const base = readSettings(settingsFile);
  const setting = (key, fallback) => {
    const mine = appSettings.get(key);
    if (mine !== undefined) return mine;
    return base[key] === undefined ? fallback : base[key];
  };
  const tenant = () => String(setting('onelakeStudio.tenantId', '')).trim();
  const msal = createMsalSession({ tenant, store: createTokenStore(join(home, 'standalone-token-cache.bin')) });

  // A person's answer to a question, by id.
  const asks = new Map();
  let nextAsk = 0;

  const server = createServer({
    uiDir: [join(extensionDir, 'desktop-ui'), join(extensionDir, 'desktop', 'ui')].find(d => existsSync(d)),
    extensionDir,
    log,
    pageOf: id => { const p = desktop.panels.get(id); return p ? p.webview.html : null; },
    rpc,
  });
  await server.listen();

  const lines = [];
  vscode.attach({
    log,
    push: server.push,
    origin: server.origin,
    resourceUrl: server.resourceUrl,
    setting,
    session: msal.session,
    ask(kind, payload, { validate } = {}) {
      const id = ++nextAsk;
      return new Promise(resolve => {
        asks.set(id, { resolve, validate });
        server.push({ t: 'ask', id, kind, ...payload });
      });
    },
    outputChannel: () => ({
      appendLine(line) {
        lines.push(line);
        if (lines.length > 5000) lines.splice(0, 1000);
        try { appendFileSync(logFile, `${line}\n`); } catch (_) {}
      },
      show() { server.push({ t: 'text-tab', title: 'Read Log', content: lines.join('\n') }); },
      dispose() {},
    }),
    copy: text => dialogs.copy(text),
    reveal: path => dialogs.reveal(path),
    openExternal: url => dialogs.openExternal(url),
    saveDialog: o => dialogs.saveDialog(o),
    folderDialog: o => dialogs.folderDialog(o),
  });

  async function rpc({ method, args = [] }) {
    switch (method) {
      case 'boot':
        return {
          contributes: packageJSON.contributes, welcome: WELCOME, version: packageJSON.version,
          commit: commitOf(extensionDir), home, homepage: packageJSON.homepage, license: packageJSON.license,
          window: windowState.get('window', {}),
          contexts: desktop.contexts, views: [...desktop.views.keys()],
          statusItems: [...desktop.statusItems.values()].filter(i => i.shown).map(i => ({ id: i.id, alignment: i.alignment, priority: i.priority, text: i.text, tooltip: i.tooltip, command: i.command, shown: true })),
        };
      case 'tree.children': return desktop.treeChildren(args[0], args[1]);
      case 'tree.click': return run(() => desktop.treeClick(args[0], args[1]));
      case 'tree.run': return run(() => desktop.treeRun(args[0], args[1], args[2]));
      case 'command': return run(() => vscode.commands.executeCommand(args[0]));
      case 'tab.message': {
        const p = desktop.panels.get(args[0]);
        if (p) p.received.fire(args[1]);
        return null;
      }
      case 'tab.shown': desktop.tabShown(args[0]); return null;
      case 'tab.closed': {
        const p = desktop.panels.get(args[0]);
        if (p) p.dispose();
        return null;
      }
      case 'answer': {
        const a = asks.get(args[0]);
        asks.delete(args[0]);
        if (a) a.resolve(args[1]);
        return null;
      }
      case 'validate': {
        const a = asks.get(args[0]);
        return a && a.validate ? (await a.validate(args[1])) || null : null;
      }
      case 'pick.accept': desktop.pickAccept(args[0], args[1]); return null;
      case 'pick.button': desktop.pickButton(args[0], args[1]); return null;
      case 'pick.hide': desktop.pickHidden(args[0]); return null;
      case 'settings.get': {
        // One section or a list of them, as VS Code takes either.
        const props = Object.assign({}, ...[].concat(packageJSON.contributes.configuration || []).map(s => s.properties || {}));
        return Object.fromEntries(Object.entries(props).map(([k, p]) => [k, setting(k, p.default)]));
      }
      case 'settings.set':
        await appSettings.update(args[0], args[1]);
        desktop.settingChanged(args[0]);
        return null;
      case 'window.set': await windowState.update('window', args[0]); return null;
      case 'app.exit': shell({ do: 'exit' }); return null;
      case 'app.zoom': shell({ do: 'zoom', factor: Number(args[0]) || 1 }); return null;
      case 'app.open': return dialogs.openExternal(String(args[0]));
      case 'app.update': return checkUpdate(packageJSON.version);
      default: throw new Error(`no method ${method}`);
    }
  }

  // A command may wait on a person for minutes, and the window has no need to wait with it.
  function run(fn) {
    Promise.resolve().then(fn).catch(e => {
      log(`a command failed: ${(e && e.stack) || e}`);
      server.push({ t: 'ask', id: 0, kind: 'message', level: 'error', message: `OneLake Studio: ${(e && e.message) || e}`, items: [] });
    });
    return null;
  }

  const context = {
    extensionUri: vscode.Uri.file(extensionDir),
    globalStorageUri: vscode.Uri.file(home),
    logUri: vscode.Uri.file(join(home, 'desktop-logs', 'window', 'exthost')),
    extensionMode: vscode.ExtensionMode.Production,
    subscriptions: [],
    globalState: keptIn(join(home, 'standalone-state.json')),
    secrets: (kept => ({ get: async k => kept.get(k), store: (k, v) => kept.store(k, v), delete: k => kept.update(k, undefined) }))(keptIn(join(home, 'standalone-secrets.json'))),
    extension: { id: `${packageJSON.publisher}.${packageJSON.name}`.toLowerCase(), packageJSON },
  };
  mkdirSync(dirname(context.logUri.fsPath), { recursive: true });

  await extension.activate(context);
  process.stdout.write(`${JSON.stringify({ url: server.url(), home, log: logFile })}\n`);

  // A newer release, said in the status bar. Offline, or anything else wrong: nothing is said.
  checkUpdate(packageJSON.version).then(u => { if (u.newer) server.push({ t: 'update', ...u }); }).catch(() => {});

  let leaving = false;
  async function leave() {
    if (leaving) return;
    leaving = true;
    const timer = setTimeout(() => process.exit(0), 5000);
    if (timer.unref) timer.unref();
    try { await extension.deactivate(); } catch (_) {}
    for (const d of context.subscriptions) { try { d.dispose(); } catch (_) {} }
    server.close();
    process.exit(0);
  }
  process.stdin.on('end', leave);
  process.stdin.on('close', leave);
  process.stdin.resume();
}

main().catch(e => {
  process.stderr.write(`the app could not start: ${(e && e.stack) || e}\n`);
  process.stdout.write(`${JSON.stringify({ error: (e && e.message) || String(e) })}\n`);
  process.exit(1);
});
