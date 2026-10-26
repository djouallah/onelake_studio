'use strict';
// =============================================================================
// tree.js — the lakehouse tree in the activity bar
// =============================================================================
// Browsing belongs in the sidebar. That is where a VS Code user looks for the shape of
// what they are working on, and it is the one thing the panel was doing that the editor
// does better: a real tree keeps its expansion state, filters when you type, and is on
// screen while the editor tab shows a result.
//
// Every level is lazy, and every level is cache first: a listing ever read is drawn from
// disk at once (onelake.js) and re-read behind the user once it is old, redrawing only the
// node whose listing actually changed. Nothing walks ahead of the user across workspaces;
// the one read-ahead is a table's metadata once its Tables node is open, because the next
// click is about to want it.
//
// Clicking a table does NOT read any data — it hands the selection to the panel, which
// opens it the way it always has: metadata only, statistics first, rows when asked for.
// =============================================================================

const vscode = require('vscode');

// A node is a plain object; getTreeItem turns it into what VS Code renders. Keeping the
// domain data on the node (rather than encoding it into a label) is what lets a click hand
// the panel a { workspace, item, schema, table } with nothing to parse back out.
const node = (kind, label, extra) => ({ kind, label, ...extra });

class LakehouseTree {
  /**
   * @param {object} deps
   * @param {ReturnType<import('./onelake').createOneLake>} deps.onelake  cache-first OneLake
   * @param {import('./fabric').createFabric} [deps.fabric]  semantic models (Fabric REST)
   * @param {() => Promise<boolean>} [deps.hasFabric]        a Fabric token, without a prompt?
   * @param {() => boolean} deps.isSignedIn
   */
  constructor({ onelake, fabric = null, hasFabric = async () => false, isSignedIn, log = () => {} }) {
    this.onelake = onelake;
    this.fabric = fabric;
    this.hasFabric = hasFabric;
    this.isSignedIn = isSignedIn;
    this.log = log;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    // The nodes on screen that a listing hangs off, so OneLake's answer changing behind the
    // user redraws exactly that node — the store says WHICH listing moved.
    this._nodes = new Map();
    // What a Refresh asked to re-read: everything under `scope`, each listing once.
    this._fresh = null;
    this._unsub = onelake.onChanged(c => this._changed(c));
  }

  dispose() { if (this._unsub) this._unsub(); }

  _changed(c) {
    if (c.kind === 'workspaces') return this._emitter.fire(undefined);
    const id = c.kind === 'items' ? `workspace|${c.workspace}`
             : c.kind === 'tables' ? `tables|${c.workspace}|${c.item}`
             : c.kind === 'files' ? `dir|${c.workspace}|${c.item}|${c.dir || ''}`
             : null;
    const n = id && this._nodes.get(id);
    if (n) this._emitter.fire(n);
  }

  _track(n) {
    const id = this._idOf(n);
    if (id) this._nodes.set(id, n);
    return n;
  }

  // `n` undefined refreshes the whole tree; a node refreshes that subtree only, which is
  // what the per-item refresh in the context menu wants. Every listing is otherwise served
  // from disk first, so a Refresh is the one thing that goes to OneLake in the foreground:
  // each listing under the node is re-read once, and the rest of the tree keeps its cache.
  //
  // `n` may also be a description of a node rather than the node itself (the .bim export
  // refreshes a lakehouse's Files/ by name); it is redrawn only if it is on screen.
  refresh(n) {
    this._fresh = { workspace: n && n.workspace, item: n && n.item, done: new Set() };
    if (this.fabric) this.fabric.reset();
    if (!n) return this._emitter.fire(undefined);
    const on = this._nodes.get(this._idOf(n));
    if (on || !['workspace', 'tables', 'dir'].includes(n.kind)) this._emitter.fire(on || n);
  }

  _idOf(n) {
    return n.kind === 'workspace' ? `workspace|${n.workspace}`
         : n.kind === 'tables' ? `tables|${n.workspace}|${n.item}`
         : n.kind === 'dir' ? `dir|${n.workspace}|${n.item}|${n.dir || ''}`
         : null;
  }

  // Draw again from what is cached — after a sign-in, an export, an account switch. Not a
  // Refresh: nothing is re-read in the foreground, the store revalidates what is old.
  redraw() {
    this._fresh = null;
    this._nodes.clear();
    this._emitter.fire(undefined);
  }

  // Is this listing one the last Refresh asked to re-read, and not yet re-read?
  _isFresh(id, ws, item) {
    const f = this._fresh;
    if (!f || f.done.has(id)) return false;
    if (f.workspace && f.workspace !== ws) return false;
    if (f.item && item && f.item !== item) return false;
    f.done.add(id);
    return true;
  }

  getTreeItem(n) {
    const C = vscode.TreeItemCollapsibleState;
    const item = new vscode.TreeItem(n.label,
      n.leaf ? C.None : n.expanded ? C.Expanded : C.Collapsed);
    item.contextValue = n.kind;
    // A stable identity, so expansion state survives a refresh keyed on WHAT the node is
    // rather than on its label — labels repeat freely across workspaces. Only the domain
    // nodes get one: two error nodes under different parents can carry the same message,
    // and duplicate ids are worse than generated ones.
    if (n.kind !== 'error' && n.kind !== 'empty') {
      item.id = [n.kind, n.workspace, n.item, n.schema, n.table, n.dir, n.path]
        .map(v => (v == null ? '' : String(v))).join('|') + (n.modelId ? `|${n.modelId}` : '');
    }
    switch (n.kind) {
      case 'workspace':
        item.iconPath = new vscode.ThemeIcon('folder');
        break;
      case 'item':
        item.iconPath = new vscode.ThemeIcon('database');
        // The suffix OneLake names the directory with is Fabric's internal type; kindLabel
        // turns the few that read badly ("SQLDbNative") into what the portal calls them.
        item.description = n.kindLabel;
        break;
      case 'tables':
        item.iconPath = new vscode.ThemeIcon('list-tree');
        break;
      case 'schema':
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        break;
      case 'table':
        item.iconPath = new vscode.ThemeIcon('table');
        item.command = { command: 'onelakeStudio.openTable', title: 'Open table', arguments: [n] };
        item.tooltip = n.schema ? `${n.schema}.${n.table}` : n.table;
        break;
      case 'dir':
        item.iconPath = new vscode.ThemeIcon('folder');
        break;
      // A workspace's Power BI semantic models — from the Fabric API, not OneLake.
      case 'models':
        item.iconPath = new vscode.ThemeIcon('graph');
        break;
      case 'semanticModel':
        item.iconPath = new vscode.ThemeIcon('symbol-structure');
        item.tooltip = (n.description ? `${n.description}\n\n` : '') +
          "Export its .bim to a lakehouse's Files/semantic_models/ to open it as a model.";
        break;
      case 'fabricSignIn':
        item.iconPath = new vscode.ThemeIcon('sign-in');
        item.command = { command: 'onelakeStudio.signInFabric', title: 'Sign in to the Fabric API' };
        item.tooltip = 'Semantic models come from the Fabric REST API, which needs its own sign-in.';
        break;
      case 'file':
        item.iconPath = new vscode.ThemeIcon('file');
        item.description = n.size;
        item.command = { command: 'onelakeStudio.openFile', title: 'Open file', arguments: [n] };
        break;
      // A listing that failed. Rendered as a node rather than only a toast, because a
      // toast is gone in five seconds and a workspace that silently shows nothing is
      // indistinguishable from an empty one.
      case 'error':
        item.iconPath = new vscode.ThemeIcon('error');
        item.tooltip = n.detail;
        break;
      case 'empty':
        item.iconPath = new vscode.ThemeIcon('info');
        break;
    }
    return item;
  }

  async getChildren(n) {
    if (!this.isSignedIn()) return [];   // the welcome view covers this state
    try {
      return await this._children(n);
    } catch (e) {
      // The node carries the sentence; the log carries the stack.
      this.log(`tree: listing ${n ? `${n.kind} ${n.label}` : 'workspaces'} failed — ${(e && e.stack) || e}`);
      const detail = (e && e.message) || String(e);
      return [node('error', detail.length > 90 ? detail.slice(0, 87) + '…' : detail,
        { leaf: true, detail })];
    }
  }

  async _children(n) {
    const { fmtBytes, hasFilesArea, kindLabel, strip } = await this.onelake.paths();

    if (!n) {
      const names = await this.onelake.workspaces({ fresh: this._isFresh('root', undefined, undefined) });
      return names.length
        ? names.map(name => this._track(node('workspace', name, { workspace: name })))
        : [node('empty', 'No workspaces — is this the right tenant?', { leaf: true })];
    }

    if (n.kind === 'workspace') {
      const items = await this.onelake.items(n.workspace,
        { fresh: this._isFresh(`items|${n.workspace}`, n.workspace) });
      const kids = items.length
        ? items.map(it => node('item', it.name.replace(/\.[^.]+$/, ''), {
            workspace: n.workspace, item: it.name, kindLabel: kindLabel(it.kind),
          }))
        : [node('empty', 'Nothing here holds tables', { leaf: true })];
      // Last, and closed: listing it is a Fabric API call, on a token sign-in never asked for.
      if (this.fabric) kids.push(node('models', 'Semantic models', { workspace: n.workspace }));
      return kids;
    }

    if (n.kind === 'models') {
      if (!await this.hasFabric()) {
        return [node('fabricSignIn', 'Sign in to list semantic models', { leaf: true, workspace: n.workspace })];
      }
      const models = await this.fabric.listSemanticModels(n.workspace);
      return models.length
        ? models.map(m => node('semanticModel', m.name, {
            workspace: n.workspace, model: m.name, modelId: m.id, description: m.description, leaf: true,
          }))
        : [node('empty', 'No semantic models', { leaf: true })];
    }

    // An item's two halves, named the way OneLake names them. Tables comes first and opens
    // expanded, so the grouping costs no extra click on the way to the thing people
    // actually came for; Files stays shut, because listing it is a request.
    if (n.kind === 'item') {
      const lh = { workspace: n.workspace, item: n.item };
      const kids = [this._track(node('tables', 'Tables', { ...lh, expanded: true }))];
      // Only a lakehouse has a Files/ area, and the item's suffix already says which — no
      // request is needed to find that out.
      if (hasFilesArea(n.item)) kids.push(this._track(node('dir', 'Files', { ...lh, dir: '' })));
      return kids;
    }

    if (n.kind === 'tables') {
      const lh = { workspace: n.workspace, item: n.item };
      const tables = await this.onelake.tables(lh,
        { fresh: this._isFresh(`tables|${n.workspace}|${n.item}`, n.workspace, n.item) });
      if (!tables.length) return [node('empty', 'No tables', { leaf: true })];
      // The tables are on screen, so their metadata is what the next click will want: read
      // it behind the user, so that click is a disk read rather than the catalog's seconds.
      this.onelake.prefetch(lh, tables);
      const schemas = [...new Set(tables.map(t => t.schema || ''))];
      // OneLake gives schema-less items a synthetic single namespace. Rendering "dbo" as a
      // level of its own would be one click between here and every table in it, for a
      // grouping that isn't real.
      return schemas.length <= 1
        ? tables.map(t => this._table(lh, t))
        : schemas.sort().map(s => node('schema', s || '(no schema)', { ...lh, schema: s }));
    }

    if (n.kind === 'schema') {
      const lh = { workspace: n.workspace, item: n.item };
      const tables = await this.onelake.tables(lh);   // the parent's listing, from the store
      return tables.filter(t => (t.schema || '') === n.schema).map(t => this._table(lh, t));
    }

    if (n.kind === 'dir') {
      const lh = { workspace: n.workspace, item: n.item };
      const entries = await this.onelake.files(lh, n.dir,
        { fresh: this._isFresh(`files|${n.workspace}|${n.item}|${n.dir || ''}`, n.workspace, n.item) });
      if (!entries.length) return [node('empty', 'Empty', { leaf: true })];
      return entries.map(e => e.isDir
        // `path` is workspace-relative (…/Files/a/b); the child directory is what follows
        // Files/, which is what listFiles takes.
        ? this._track(node('dir', e.name, { ...lh, dir: strip(e.path.replace(/^.*?\/Files\/?/, '')) }))
        // bytes travels with it so the panel can open the file without re-listing the
        // directory it already knows everything about.
        : node('file', e.name, { ...lh, leaf: true, path: e.path, bytes: e.bytes, size: fmtBytes(e.bytes) }));
    }

    return [];
  }

  _table(lh, t) {
    return node('table', t.table, { ...lh, leaf: true, schema: t.schema || '', table: t.table });
  }
}

module.exports = { LakehouseTree };
