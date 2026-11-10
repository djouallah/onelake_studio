'use strict';
// =============================================================================
// vscode.js — what the extension asks of VS Code, answered with no VS Code
// =============================================================================
// The desktop app is the extension: extension/extension.js, unchanged, bundled with `vscode` pointing here
// (scripts/bundle-desktop.mjs). So every command, menu, tab and message is the same code in both, and
// a change to the extension is a change to the app. This is the part of VS Code's API it uses, and
// no more. What needs a person goes to the window through `host`, and what needs Windows goes to
// dialogs.js.
// =============================================================================

const fsp = require('node:fs/promises');
const { join, relative, isAbsolute } = require('node:path');

let host = null;
/** Set once, by main.js, before the extension is activated. */
function attach(h) { host = h; }

class EventEmitter {
  constructor() {
    this.fns = new Set();
    this.event = (fn, thisArg, disposables) => {
      const f = thisArg ? fn.bind(thisArg) : fn;
      this.fns.add(f);
      const d = { dispose: () => this.fns.delete(f) };
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    };
  }
  fire(value) {
    for (const f of [...this.fns]) {
      try { f(value); } catch (e) { if (host) host.log(`a listener failed: ${(e && e.stack) || e}`); }
    }
  }
  dispose() { this.fns.clear(); }
}

class Uri {
  constructor(fsPath, text = null) { this.fsPath = fsPath; this.path = fsPath; this.scheme = text ? 'https' : 'file'; this.text = text; }
  toString() { return this.text || this.fsPath; }
  static file(p) { return new Uri(p); }
  static parse(s) { return new Uri(String(s), String(s)); }
  static joinPath(base, ...parts) { return new Uri(join(base.fsPath, ...parts)); }
}

class ThemeColor { constructor(id) { this.id = id; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class TreeItem { constructor(label, collapsibleState = 0) { this.label = label; this.collapsibleState = collapsibleState; } }
class DataTransferItem { constructor(value) { this.value = value; } }

const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
const StatusBarAlignment = { Left: 1, Right: 2 };
const ViewColumn = { Active: -1, Beside: -2, One: 1 };

let nextId = 0;
const newId = () => ++nextId;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const handlers = new Map();
const contexts = {};

const commands = {
  registerCommand(id, fn) {
    handlers.set(id, fn);
    return { dispose: () => handlers.delete(id) };
  },
  async executeCommand(id, ...args) {
    if (id === 'setContext') {
      contexts[args[0]] = args[1];
      host.push({ t: 'context', key: args[0], value: args[1] });
      return undefined;
    }
    if (id === 'revealFileInOS') return host.reveal(args[0].fsPath);
    if (id === 'workbench.action.openSettings') { host.push({ t: 'open-settings' }); return undefined; }
    const fn = handlers.get(id);
    if (!fn) throw new Error(`no command ${id}`);
    return fn(...args);
  },
};

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------
const views = new Map();

const textOf = v => (v == null ? '' : typeof v === 'string' ? v : v.value != null ? String(v.value) : v.label != null ? String(v.label) : String(v));
const iconOf = i => (i instanceof ThemeIcon ? { id: i.id, color: i.color ? i.color.id : null } : null);

async function dragTextOf(view, element) {
  const drag = view.options.dragAndDropController;
  if (!drag) return null;
  let text = null;
  try { await drag.handleDrag([element], { set: (_, item) => { text = item.value; } }); } catch (_) {}
  return text;
}

/** What the window draws for a node's children. */
async function treeChildren(viewId, parentId) {
  const view = views.get(viewId);
  const parent = parentId ? (view.nodes.get(parentId) || {}).element : undefined;
  if (parentId && !parent) return [];
  const kids = (await view.options.treeDataProvider.getChildren(parent)) || [];
  const out = [];
  for (const element of kids) {
    const item = await view.options.treeDataProvider.getTreeItem(element);
    const id = item.id || `node-${newId()}`;
    view.nodes.set(id, { element, item });
    out.push({
      id, label: textOf(item.label), description: textOf(item.description), tooltip: textOf(item.tooltip),
      icon: iconOf(item.iconPath), contextValue: item.contextValue || '', collapsible: item.collapsibleState || 0,
      clickable: !!item.command, dragText: await dragTextOf(view, element),
    });
  }
  return out;
}

// What the pointer resting on a node says. A node drawn with no tooltip gets its own then, from the
// tree's resolveTreeItem, as VS Code asks for it: a lakehouse can draw thousands.
async function treeTooltip(viewId, id) {
  const view = views.get(viewId);
  const node = view && view.nodes.get(id);
  if (!node) return '';
  const provider = view.options.treeDataProvider;
  if (node.item.tooltip == null && provider.resolveTreeItem) {
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    node.item = (await provider.resolveTreeItem(node.item, node.element, token)) || node.item;
  }
  return textOf(node.item.tooltip);
}

function treeClick(viewId, id) {
  const node = views.get(viewId).nodes.get(id);
  if (!node || !node.item.command) return undefined;
  const { command, arguments: args = [] } = node.item.command;
  return commands.executeCommand(command, ...args);
}

function treeRun(viewId, id, command) {
  const node = views.get(viewId).nodes.get(id);
  return commands.executeCommand(command, node ? node.element : undefined);
}

function createTreeView(id, options) {
  const view = { id, options, nodes: new Map() };
  views.set(id, view);
  let title = '', description;
  const visibility = new EventEmitter();
  if (options.treeDataProvider.onDidChangeTreeData) {
    options.treeDataProvider.onDidChangeTreeData(() => host.push({ t: 'tree-changed', view: id }));
  }
  host.push({ t: 'tree-created', view: id });
  return {
    visible: true,
    onDidChangeVisibility: visibility.event,
    get title() { return title; },
    set title(v) { title = v; host.push({ t: 'view-title', view: id, title: v }); },
    get description() { return description; },
    set description(v) { description = v; host.push({ t: 'view-description', view: id, description: v || '' }); },
    dispose() { views.delete(id); },
  };
}

// ---------------------------------------------------------------------------
// Tabs: a webview panel is an iframe in the window (server.js serves its page)
// ---------------------------------------------------------------------------
const panels = new Map();

function createWebviewPanel(viewType, titleText) {
  const id = String(newId());
  const received = new EventEmitter(), disposed = new EventEmitter(), stateChanged = new EventEmitter();
  let title = titleText, html = '', gone = false, rev = 0;
  const panel = {
    id, viewType, visible: true, active: true, viewColumn: 1,
    get title() { return title; },
    set title(v) { title = v; if (!gone) host.push({ t: 'tab-title', id, title: v }); },
    iconPath: null,
    webview: {
      get html() { return html; },
      set html(v) { html = v; rev++; host.push({ t: 'tab-html', id, rev }); },
      get cspSource() { return host.pagesOrigin(); },
      asWebviewUri: uri => Uri.parse(host.resourceUrl(uri.fsPath)),
      onDidReceiveMessage: received.event,
      postMessage(msg) {
        if (gone) throw new Error('this tab is closed');
        host.push({ t: 'tab-post', id, msg });
        return Promise.resolve(true);
      },
    },
    onDidDispose: disposed.event,
    onDidChangeViewState: stateChanged.event,
    reveal() { if (!gone) host.push({ t: 'tab-reveal', id }); },
    dispose() {
      if (gone) return;
      gone = true;
      panels.delete(id);
      host.push({ t: 'tab-close', id });
      disposed.fire();
    },
    received, stateChanged,
  };
  for (const other of panels.values()) { other.active = false; other.visible = false; }
  panels.set(id, panel);
  host.push({ t: 'tab-open', id, viewType, title });
  return panel;
}

/** The window says which tab is on top. */
function tabShown(id) {
  for (const p of panels.values()) {
    const on = p.id === id;
    if (p.active === on && p.visible === on) continue;
    p.active = on;
    p.visible = on;
    p.stateChanged.fire({ webviewPanel: p });
  }
}

// ---------------------------------------------------------------------------
// Messages, questions and progress
// ---------------------------------------------------------------------------
function message(level, text, rest) {
  const opts = rest[0] && typeof rest[0] === 'object' ? rest[0] : {};
  const items = rest.filter(r => typeof r === 'string');
  return host.ask('message', { level, message: String(text), modal: !!opts.modal, detail: opts.detail || '', items })
    .then(v => (v == null ? undefined : v));
}

const plainItem = (it, i) => ({
  i, label: textOf(it.label), description: textOf(it.description), detail: textOf(it.detail),
  buttons: (it.buttons || []).map(b => ({ icon: iconOf(b.iconPath), tooltip: b.tooltip || '' })),
});

function createQuickPick() {
  const id = String(newId());
  const accepted = new EventEmitter(), hidden = new EventEmitter(), button = new EventEmitter();
  let items = [], busy = false, open = false;
  const qp = {
    title: '', placeholder: '', matchOnDescription: false, selectedItems: [],
    get busy() { return busy; },
    set busy(v) { busy = v; if (open) host.push({ t: 'pick-busy', id, busy: v }); },
    get items() { return items; },
    set items(v) { items = v; if (open) host.push({ t: 'pick-items', id, items: v.map(plainItem) }); },
    onDidAccept: accepted.event, onDidHide: hidden.event, onDidTriggerItemButton: button.event,
    show() {
      open = true;
      quickPicks.set(id, { qp, accepted, hidden, button });
      host.push({ t: 'pick-open', id, title: qp.title, placeholder: qp.placeholder, busy, items: items.map(plainItem) });
    },
    hide() { if (open) { host.push({ t: 'pick-close', id }); pickHidden(id); } },
    dispose() { if (open) qp.hide(); },
  };
  return qp;
}
const quickPicks = new Map();
function pickHidden(id) {
  const q = quickPicks.get(id);
  if (!q) return;
  quickPicks.delete(id);
  q.hidden.fire();
}
function pickAccept(id, i) {
  const q = quickPicks.get(id);
  if (!q) return;
  q.qp.selectedItems = q.qp.items[i] ? [q.qp.items[i]] : [];
  q.accepted.fire();
}
function pickButton(id, i) {
  const q = quickPicks.get(id);
  if (q && q.qp.items[i]) q.button.fire({ item: q.qp.items[i], button: q.qp.items[i].buttons[0] });
}

const statusItems = new Map();
const window_ = {
  showInformationMessage: (text, ...rest) => message('info', text, rest),
  showWarningMessage: (text, ...rest) => message('warning', text, rest),
  showErrorMessage: (text, ...rest) => message('error', text, rest),
  setStatusBarMessage(text, ms) {
    host.push({ t: 'status-message', text: String(text), ms: ms || 3000 });
    return { dispose() {} };
  },
  async withProgress({ title, location }, task) {
    const id = newId();
    host.push({ t: 'progress', id, title: title || '', message: '', notify: location === ProgressLocation.Notification });
    try {
      return await task(
        { report: ({ message: m } = {}) => host.push({ t: 'progress', id, title: title || '', message: m || '', notify: location === ProgressLocation.Notification }) },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    } finally {
      host.push({ t: 'progress-end', id });
    }
  },
  createStatusBarItem(alignment, priority) {
    const id = String(newId());
    const item = {
      id, alignment, priority, name: '', text: '', tooltip: '', command: undefined, shown: false,
      show() { item.shown = true; send(); },
      hide() { item.shown = false; send(); },
      dispose() { statusItems.delete(id); host.push({ t: 'status-item-gone', id }); },
    };
    const send = () => host.push({ t: 'status-item', item: { id, alignment, priority, text: item.text, tooltip: item.tooltip, command: item.command, shown: item.shown } });
    statusItems.set(id, item);
    return item;
  },
  createOutputChannel: name => host.outputChannel(name),
  createTreeView,
  createWebviewPanel,
  createQuickPick,
  async showQuickPick(items, opts = {}) {
    const list = await items;
    const i = await host.ask('pick', { title: opts.title || '', placeholder: opts.placeHolder || '', items: list.map(plainItem) });
    return i == null ? undefined : list[i];
  },
  showInputBox(opts = {}) {
    return host.ask('input', { title: opts.title || '', value: opts.value || '', prompt: opts.prompt || '', placeholder: opts.placeHolder || '' },
      { validate: opts.validateInput }).then(v => (v == null ? undefined : v));
  },
  async showSaveDialog({ defaultUri, title, filters } = {}) {
    const path = await host.saveDialog({ defaultPath: defaultUri ? defaultUri.fsPath : '', title: title || '', filters: filters || {} });
    return path ? Uri.file(path) : undefined;
  },
  async showOpenDialog({ defaultUri, title, canSelectFiles, canSelectMany, filters } = {}) {
    const defaultPath = defaultUri ? defaultUri.fsPath : '';
    if (canSelectFiles) {
      const paths = await host.openDialog({ defaultPath, title: title || '', filters: filters || {}, many: !!canSelectMany });
      return paths.length ? paths.map(p => Uri.file(p)) : undefined;
    }
    const path = await host.folderDialog({ defaultPath, title: title || '' });
    return path ? [Uri.file(path)] : undefined;
  },
  async showTextDocument(doc) {
    const d = doc instanceof Uri ? { fileName: doc.fsPath, content: await fsp.readFile(doc.fsPath, 'utf8') } : doc;
    host.push({ t: 'text-tab', title: d.fileName ? d.fileName.split(/[\\/]/).pop() : `Untitled.${d.languageId || 'txt'}`, content: d.content });
    return d;
  },
};

// ---------------------------------------------------------------------------
// Settings, files, the system
// ---------------------------------------------------------------------------
const configChanged = new EventEmitter();
function settingChanged(fullKey) {
  configChanged.fire({ affectsConfiguration: section => fullKey === section || fullKey.startsWith(`${section}.`) });
}

const workspace = {
  workspaceFolders: undefined,
  onDidChangeConfiguration: configChanged.event,
  getConfiguration: section => ({
    get: (key, fallback) => host.setting(`${section}.${key}`, fallback),
  }),
  fs: {
    readFile: uri => fsp.readFile(uri.fsPath),
    writeFile: (uri, bytes) => fsp.writeFile(uri.fsPath, bytes),
    stat: uri => fsp.stat(uri.fsPath),
  },
  async openTextDocument(arg) {
    if (arg instanceof Uri) return { fileName: arg.fsPath, content: await fsp.readFile(arg.fsPath, 'utf8') };
    return { languageId: arg.language, content: arg.content };
  },
};

const env = {
  appName: 'OneLake Studio',
  clipboard: { writeText: text => host.copy(String(text)) },
  openExternal: uri => host.openExternal(uri.toString()),
};

const authentication = {
  // A tenant is in the settings here: VS Code's way of asking for one, in a scope, means nothing to MSAL.
  getSession: (provider, scopes, options) => host.session(scopes.filter(s => !s.startsWith('VSCODE_TENANT:')), options),
  onDidChangeSessions: new EventEmitter().event,
};

const languages = { getLanguages: async () => ['plaintext', 'csv', 'json'] };

/** The path under `root`, or null if it isn't: what the server may hand out. */
function under(root, p) {
  const r = relative(root, p);
  return r && !r.startsWith('..') && !isAbsolute(r) ? r : null;
}

module.exports = {
  attach, EventEmitter, Uri, ThemeColor, ThemeIcon, TreeItem, DataTransferItem, TreeItemCollapsibleState,
  ExtensionMode, ProgressLocation, StatusBarAlignment, ViewColumn,
  commands, window: window_, workspace, env, authentication, languages, version: 'none',
  // For main.js and server.js, not the extension.
  desktop: { contexts, panels, tabShown, treeChildren, treeTooltip, treeClick, treeRun, pickAccept, pickButton, pickHidden, settingChanged, statusItems, views, under },
};
