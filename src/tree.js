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
const { fmtBytes, hasFilesArea, isMirrored, kindLabel, kindLabelPlural, strip, sqlNameOf } = require('./names');

// What a table's icon says about how it was written. Either way the panel reads it
// through its Iceberg metadata; for a Delta table that metadata is Fabric's conversion.
const FORMAT_TOOLTIP = {
  delta: 'Delta table. Read through the Iceberg metadata Fabric converts it to; its Stats and History come from the Delta log.',
  iceberg: 'Iceberg table.',
};

// A node is a plain object; getTreeItem turns it into what VS Code renders. Keeping the
// domain data on the node (rather than encoding it into a label) is what lets a click hand
// the panel a { workspace, item, schema, table } with nothing to parse back out.
const node = (kind, label, extra) => ({ kind, label, ...extra });

// A table node's SQL name (lakehouse.ws.item.schema.table), or null for an item SQL cannot name.
const sqlNameOrNull = n => { try { return sqlNameOf(n, n); } catch (_) { return null; } };

// `fn` over every workspace, four at a time; the ones that failed come back by name.
async function eachOf(names, fn) {
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const ws = names[next++];
      try { await fn(ws); } catch (e) { failed.push({ ws, e }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, worker));
  return failed;
}
// ...and those, as one node rather than a tree that silently shows less.
const unlisted = failed => node('error', `${failed.length} workspace(s) could not be listed`, {
  leaf: true, detail: failed.map(f => `${f.ws}: ${(f.e && f.e.message) || f.e}`).join('\n'),
});

class LakehouseTree {
  /**
   * @param {object} deps
   * @param {ReturnType<import('./onelake').createOneLake>} deps.onelake  cache-first OneLake
   * @param {import('./fabric').createFabric} [deps.fabric]  semantic models and apps (Fabric REST)
   * @param {() => Promise<boolean>} [deps.hasFabric]        a Fabric token, without a prompt?
   * @param {() => boolean} deps.isSignedIn
   * @param {{ get: () => string[] }} [deps.favorites]   pinned workspace names, persisted
   * @param {(n: object) => string|null} [deps.cachedModel]  where a model's local copy is, if it has one
   * @param {(n: object) => string|null} [deps.unsupportedModel]  what kind of model a click found it cannot open, if it did
   * @param {{ list: () => Promise<{name: string, path: string}[]> }} [deps.queries]  the saved queries
   * @param {() => boolean} [deps.groupByType]  a workspace's items under one heading per type
   * @param {(name: string) => any} [deps.iconPath]  a bundled icon (media/<name>.svg), or null
   */
  constructor({ onelake, fabric = null, hasFabric = async () => false, isSignedIn, log = () => {},
                favorites = { get: () => [] }, cachedModel = () => null, unsupportedModel = () => null,
                queries = { list: async () => [] }, groupByType = () => false, iconPath = () => null }) {
    this.queries = queries;
    this.iconPath = iconPath;
    this.onelake = onelake;
    this.groupByType = groupByType;
    this.cachedModel = cachedModel;
    this.unsupportedModel = unsupportedModel;
    this.favorites = favorites;
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
    // A table's format is known once its metadata is: redraw its icon then.
    this._unsubRead = onelake.onTableRead
      ? onelake.onTableRead(r => this._formatKnown(r, r.value && r.value.format)) : null;
  }

  dispose() { if (this._unsub) this._unsub(); if (this._unsubRead) this._unsubRead(); }

  _formatKnown(t, format) {
    const n = this._nodes.get(`table|${t.workspace}|${t.item}|${t.schema || ''}|${t.table}`);
    if (!n || !format || n.format === format) return;
    n.format = format;
    this._emitter.fire(n);
  }

  _changed(c) {
    if (c.kind === 'table') {
      const lh = { workspace: c.workspace, item: c.item };
      this.onelake.cached.table(lh, { schema: c.schema, table: c.table })
        .then(k => this._formatKnown(c, k && k.value && k.value.format), () => {});
      return;
    }
    if (c.kind === 'workspaces') return this._emitter.fire(undefined);
    // Grouped by type, a workspace's items are spread over the top-level headings, and its
    // models sit under the one Semantic models heading.
    if (this.groupByType() && c.kind === 'items') return this._emitter.fire(undefined);
    if (this.groupByType() && (c.kind === 'models' || c.kind === 'apps')) {
      const all = this._nodes.get(c.kind === 'models' ? 'allModels' : 'allApps');
      return all ? this._emitter.fire(all) : undefined;
    }
    const id = c.kind === 'items' ? `workspace|${c.workspace}`
             : c.kind === 'tables' ? `tables|${c.workspace}|${c.item}`
             : c.kind === 'files' ? `dir|${c.workspace}|${c.item}|${c.dir || ''}`
             : c.kind === 'models' ? `models|${c.workspace}`
             : c.kind === 'apps' ? `apps|${c.workspace}`
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
    if (on || !['workspace', 'tables', 'dir', 'models', 'apps'].includes(n.kind)) this._emitter.fire(on || n);
  }

  _idOf(n) {
    return n.kind === 'workspace' ? `workspace|${n.workspace}`
         : n.kind === 'tables' ? `tables|${n.workspace}|${n.item}`
         : n.kind === 'dir' ? `dir|${n.workspace}|${n.item}|${n.dir || ''}`
         : n.kind === 'models' ? `models|${n.workspace}`
         : n.kind === 'semanticModel' ? `model|${n.workspace}|${n.modelId}`
         : n.kind === 'allModels' ? 'allModels'
         : n.kind === 'apps' ? `apps|${n.workspace}`
         : n.kind === 'allApps' ? 'allApps'
         : n.kind === 'queries' ? 'queries'
         : n.kind === 'table' ? `table|${n.workspace}|${n.item}|${n.schema || ''}|${n.table}`
         : null;
  }

  // A model's .bim was just downloaded: redraw that one node, so its icon says so. Not the
  // whole tree — that would list every open workspace's models from Fabric again.
  modelChanged(n) {
    const on = this._nodes.get(`model|${n.workspace}|${n.modelId}`);
    if (on) this._emitter.fire(on);
  }

  // The saved queries changed (saved, renamed, deleted, or edited on disk): redraw their node.
  queriesChanged() {
    const on = this._nodes.get('queries');
    if (on) this._emitter.fire(on);
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
    // A pinned workspace offers Unpin, an unpinned one Pin (package.json menus).
    item.contextValue = n.kind === 'workspace' && n.pinned ? 'workspacePinned'
      : n.kind === 'fabricApp' && n.url ? 'fabricAppUrl'
      : n.kind;
    // A stable identity, so expansion state survives a refresh keyed on WHAT the node is
    // rather than on its label — labels repeat freely across workspaces. Only the domain
    // nodes get one: two error nodes under different parents can carry the same message,
    // and duplicate ids are worse than generated ones.
    if (n.kind !== 'error' && n.kind !== 'empty') {
      item.id = [n.kind, n.group, n.workspace, n.item, n.schema, n.table, n.dir, n.path]
        .map(v => (v == null ? '' : String(v))).join('|') + (n.modelId ? `|${n.modelId}` : '')
        + (n.appId ? `|${n.appId}` : '');
    }
    switch (n.kind) {
      // The two top-level groups: the workspaces someone pinned, and everything else.
      case 'group':
        item.iconPath = new vscode.ThemeIcon(n.group === 'favorites' ? 'star-full' : 'folder-library');
        item.description = n.count != null ? String(n.count) : '';
        break;
      case 'workspace':
        item.iconPath = new vscode.ThemeIcon(n.pinned ? 'star-full' : 'folder');
        break;
      // Saved queries: .sql files, each naming its tables Kind.workspace.item.schema.table, so
      // one runs whatever the panel has open. A click puts it in the SQL box.
      case 'queries':
        item.iconPath = new vscode.ThemeIcon('bookmark');
        break;
      case 'query':
        item.iconPath = new vscode.ThemeIcon('file-code');
        item.command = { command: 'onelakeStudio.openQuery', title: 'Open query', arguments: [n] };
        item.tooltip = n.path;
        break;
      // Grouped by type: every item of one type across workspaces, and every semantic model.
      case 'allModels':
        item.iconPath = new vscode.ThemeIcon('graph');
        break;
      case 'kindGroup':
        item.iconPath = new vscode.ThemeIcon('folder-library');
        item.description = String(n.count);
        break;
      case 'item':
        item.iconPath = new vscode.ThemeIcon(isMirrored(n.item) ? 'mirror' : 'database');
        // The suffix OneLake names the directory with is Fabric's internal type; kindLabel
        // turns the few that read badly ("SQLDbNative") into what the portal calls them.
        item.description = n.showWorkspace ? n.workspace : n.kindLabel;
        break;
      case 'tables':
        item.iconPath = new vscode.ThemeIcon('list-tree');
        break;
      case 'schema':
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        break;
      case 'table':
        // Unknown until its metadata has been read once (the prefetch does that as soon
        // as the Tables node opens): a plain table until then.
        item.iconPath = (FORMAT_TOOLTIP[n.format] && this.iconPath(n.format)) || new vscode.ThemeIcon('table');
        item.command = { command: 'onelakeStudio.openTable', title: 'Open table', arguments: [n] };
        item.tooltip = [sqlNameOrNull(n) || (n.schema ? `${n.schema}.${n.table}` : n.table), FORMAT_TOOLTIP[n.format]]
          .filter(Boolean).join('\n');
        break;
      case 'dir':
        item.iconPath = new vscode.ThemeIcon('folder');
        break;
      // A workspace's Power BI semantic models — from the Fabric API, not OneLake.
      case 'models':
        item.iconPath = new vscode.ThemeIcon('graph');
        break;
      // One click opens it. The first keeps a local copy of its definition, writing nothing to
      // OneLake; after that it opens from that copy, and the icon says which: a cloud until
      // then, a check once it is there.
      case 'semanticModel': {
        // A click already found it is not Direct Lake on one lakehouse: say what it is, and a
        // click says why again.
        const refused = this.unsupportedModel(n);
        if (refused) {
          item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
          item.description = [n.showWorkspace ? n.workspace : '', `${refused.replace(/^an? /, '')} · not supported`]
            .filter(Boolean).join(' · ');
          item.command = { command: 'onelakeStudio.openSemanticModel', title: 'Open semantic model', arguments: [n] };
          item.tooltip = (n.description ? `${n.description}\n\n` : '') +
            `${n.model} is ${refused}. OneLake Studio opens Direct Lake models over OneLake only.`;
          break;
        }
        const there = this.cachedModel(n);
        item.iconPath = there
          ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
          : new vscode.ThemeIcon('cloud');
        item.description = n.showWorkspace ? n.workspace : '';
        item.command = { command: 'onelakeStudio.openSemanticModel', title: 'Open semantic model', arguments: [n] };
        item.tooltip = (n.description ? `${n.description}\n\n` : '') + (there
          ? `Downloaded to ${there}. Click to open it; Download Again reads it from Fabric again.`
          : 'Click to download its definition (kept on this machine only) and open it as a model.');
        break;
      }
      // A workspace's Fabric apps (AppBackend items), however they were made — from the
      // Fabric API. Shown only: its URL and last deploy, and a button to copy the URL.
      case 'apps':
      case 'allApps':
        item.iconPath = new vscode.ThemeIcon('rocket');
        break;
      // Its icon says who can load its site: an orange open lock when anyone with the URL
      // can (public), a lock when Fabric asks for a sign-in first (protected), a globe when
      // its settings could not be read.
      case 'fabricApp': {
        item.iconPath = n.access === 'public'
          ? new vscode.ThemeIcon('unlock', new vscode.ThemeColor('list.warningForeground'))
          : n.access === 'protected' ? new vscode.ThemeIcon('lock') : new vscode.ThemeIcon('globe');
        const host = n.url ? n.url.replace(/^https?:\/\//, '') : 'not deployed';
        item.description = [n.access === 'public' ? 'public' : '', n.showWorkspace ? n.workspace : '', host]
          .filter(Boolean).join(' · ');
        item.tooltip = [n.url || 'No site deployed',
          n.access === 'public' ? 'Public: anyone with the URL can load the site, without signing in.'
            : n.access === 'protected' ? 'Protected: Fabric asks for a sign-in and permission on the app first.' : '',
          n.deployedAt ? `Last deployed ${new Date(n.deployedAt).toLocaleString()}` : '',
          n.description].filter(Boolean).join('\n');
        break;
      }
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
      // `parent` is what its Refresh button refreshes: the error node itself names nothing.
      return [node('error', detail.length > 90 ? detail.slice(0, 87) + '…' : detail,
        { leaf: true, detail, parent: n })];
    }
  }

  async _children(n) {

    // A tenant can have hundreds of workspaces, so the top level is two groups: the ones
    // pinned as favorites (open), and all the others (closed once anything is pinned).
    // Pins are names; one whose workspace is gone (or belongs to another tenant) is simply
    // not shown.
    if (!n) {
      const names = await this.onelake.workspaces({ fresh: this._isFresh('root', undefined, undefined) });
      if (!names.length) return [node('empty', 'No workspaces — is this the right tenant?', { leaf: true })];
      const queries = this._track(node('queries', 'Queries', {}));
      if (this.groupByType()) return [...await this._byType(names), queries];
      const pinned = new Set(this.favorites.get());
      const favs = names.filter(w => pinned.has(w));
      return [
        node('group', 'Favorites', { group: 'favorites', expanded: true, count: favs.length }),
        node('group', favs.length ? 'Other workspaces' : 'Workspaces',
             { group: 'others', expanded: !favs.length, count: names.length - favs.length }),
        queries,
      ];
    }

    if (n.kind === 'queries') {
      const list = await this.queries.list();
      if (!list.length) return [node('empty', 'Save a query from the SQL box to keep it here', { leaf: true })];
      return list.map(q => node('query', q.name, { leaf: true, path: q.path }));
    }

    if (n.kind === 'group') {
      const names = await this.onelake.workspaces();
      const pinned = new Set(this.favorites.get());
      const mine = names.filter(w => (n.group === 'favorites') === pinned.has(w));
      if (!mine.length) {
        return [node('empty', n.group === 'favorites'
          ? 'Pin a workspace with its ☆ button to keep it here'
          : 'Every workspace is pinned', { leaf: true })];
      }
      return mine.map(name => this._track(node('workspace', name, { workspace: name, pinned: pinned.has(name) })));
    }

    if (n.kind === 'workspace') {
      const items = await this.onelake.items(n.workspace,
        { fresh: this._isFresh(`items|${n.workspace}`, n.workspace) });
      const kids = items.length
        ? items.map(it => this._item(n.workspace, it))
        : [node('empty', 'Nothing here holds tables', { leaf: true })];
      // Last, and closed: listing it is a Fabric API call, on a token sign-in never asked for.
      if (this.fabric) {
        kids.push(this._track(node('models', 'Semantic models', { workspace: n.workspace })));
        kids.push(this._track(node('apps', 'Apps', { workspace: n.workspace })));
      }
      return kids;
    }

    // Grouped by type: the heading already holds its items, gathered by _byType.
    if (n.kind === 'kindGroup') {
      return n.entries.map(({ workspace, it }) => this._item(workspace, it, { showWorkspace: true }));
    }

    // Grouped by type: every workspace's semantic models, a few workspaces at a time.
    if (n.kind === 'allModels') {
      if (!await this.hasFabric()) return [node('fabricSignIn', 'Sign in to list semantic models', { leaf: true })];
      const names = await this.onelake.workspaces();
      const rows = [];
      const failed = await eachOf(names, async ws => {
        const models = await this.onelake.models(ws, { fresh: this._isFresh(`models|${ws}`, ws) });
        for (const m of models) rows.push({ ws, m });
      });
      rows.sort((a, b) => a.m.name.localeCompare(b.m.name) || a.ws.localeCompare(b.ws));
      const kids = rows.map(({ ws, m }) => this._track(node('semanticModel', m.name, {
        workspace: ws, model: m.name, modelId: m.id, description: m.description, leaf: true, showWorkspace: true,
      })));
      if (failed.length) kids.push(unlisted(failed));
      return kids.length ? kids : [node('empty', 'No semantic models', { leaf: true })];
    }

    // Grouped by type: every workspace's apps, a few workspaces at a time.
    if (n.kind === 'allApps') {
      if (!await this.hasFabric()) return [node('fabricSignIn', 'Sign in to list apps', { leaf: true })];
      const names = await this.onelake.workspaces();
      const rows = [];
      const failed = await eachOf(names, async ws => {
        const apps = await this.onelake.apps(ws, { fresh: this._isFresh(`apps|${ws}`, ws) });
        for (const a of apps) rows.push({ ws, a });
      });
      rows.sort((x, y) => x.a.name.localeCompare(y.a.name) || x.ws.localeCompare(y.ws));
      const kids = rows.map(({ ws, a }) => this._app(ws, a, { showWorkspace: true }));
      if (failed.length) kids.push(unlisted(failed));
      return kids.length ? kids : [node('empty', 'No apps', { leaf: true })];
    }

    if (n.kind === 'apps') {
      if (!await this.hasFabric()) {
        return [node('fabricSignIn', 'Sign in to list apps', { leaf: true, workspace: n.workspace })];
      }
      const apps = await this.onelake.apps(n.workspace,
        { fresh: this._isFresh(`apps|${n.workspace}`, n.workspace) });
      return apps.length
        ? apps.map(a => this._app(n.workspace, a))
        : [node('empty', 'No apps', { leaf: true })];
    }

    if (n.kind === 'models') {
      if (!await this.hasFabric()) {
        return [node('fabricSignIn', 'Sign in to list semantic models', { leaf: true, workspace: n.workspace })];
      }
      // Cached like every other listing (onelake.js): drawn from disk, refreshed behind.
      const models = await this.onelake.models(n.workspace,
        { fresh: this._isFresh(`models|${n.workspace}`, n.workspace) });
      return models.length
        ? models.map(m => this._track(node('semanticModel', m.name, {
            workspace: n.workspace, model: m.name, modelId: m.id, description: m.description, leaf: true,
          })))
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
        ? this._tables(lh, tables)
        : schemas.sort().map(s => node('schema', s || '(no schema)', { ...lh, schema: s }));
    }

    if (n.kind === 'schema') {
      const lh = { workspace: n.workspace, item: n.item };
      const tables = await this.onelake.tables(lh);   // the parent's listing, from the store
      return this._tables(lh, tables.filter(t => (t.schema || '') === n.schema));
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

  _app(workspace, a, { showWorkspace = false } = {}) {
    return node('fabricApp', a.name, {
      workspace, appId: a.id, url: a.url, deployedAt: a.deployedAt, access: a.access, description: a.description,
      leaf: true, showWorkspace,
    });
  }

  // Each with the format its kept metadata gives — read from the store, never from OneLake.
  async _tables(lh, list) {
    const kept = await Promise.all(list.map(t =>
      this.onelake.cached.table(lh, t).then(k => (k && k.value && k.value.format) || null, () => null)));
    return list.map((t, i) => this._track(node('table', t.table,
      { ...lh, leaf: true, schema: t.schema || '', table: t.table, format: kept[i] })));
  }

  // An item, named without its suffix: its type beside it under a workspace, its workspace
  // beside it under a type heading. The node is the same either way, so its expansion
  // survives the toggle.
  _item(workspace, it, { showWorkspace = false } = {}) {
    return node('item', it.name.replace(/\.[^.]+$/, ''), {
      workspace, item: it.name, kindLabel: kindLabel(it.kind), showWorkspace,
    });
  }

  // Grouped by type: the top level is one heading per type — "Lakehouses 7", "Warehouses 2" —
  // over every workspace's items, then the semantic models. The one place the tree reads
  // across workspaces: the first time, each workspace's item listing once (cache-first, a
  // few at a time); after that it is drawn from disk like everything else.
  async _byType(names) {
    const byKind = new Map();   // kind -> [{ workspace, it }]
    const failed = await eachOf(names, async ws => {
      const items = await this.onelake.items(ws, { fresh: this._isFresh(`items|${ws}`, ws) });
      for (const it of items) {
        if (!byKind.has(it.kind)) byKind.set(it.kind, []);
        byKind.get(it.kind).push({ workspace: ws, it });
      }
    });
    const heads = [...byKind].map(([kind, entries]) => node('kindGroup', kindLabelPlural(kind), {
      group: kind, count: entries.length, expanded: true,
      entries: entries.sort((x, y) => x.it.name.localeCompare(y.it.name) || x.workspace.localeCompare(y.workspace)),
    })).sort((x, y) => x.label.localeCompare(y.label));
    if (this.fabric) {
      heads.push(this._track(node('allModels', 'Semantic models', {})));
      heads.push(this._track(node('allApps', 'Apps', {})));
    }
    if (failed.length) heads.push(unlisted(failed));
    return heads.length ? heads : [node('empty', 'Nothing here holds tables', { leaf: true })];
  }
}

module.exports = { LakehouseTree };
