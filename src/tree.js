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
// node whose listing actually changed. Nothing walks ahead of the user across workspaces
// unless the user picks a filter; the one read-ahead is a table's metadata once its Tables
// node is open, because the next click is about to want it.
//
// Clicking a table does NOT read any data — it hands the selection to the panel, which
// opens it the way it always has: metadata only, statistics first, rows when asked for.
// =============================================================================

const vscode = require('vscode');
const { fmtBytes, hasFilesArea, isMirrored, kindLabel, strip, sqlNameOf } = require('./names');
const { mapPool } = require('./http');

// What the explorer's filter offers: an item type as kindLabel says it, or a Fabric listing.
const TREE_FILTERS = [
  { label: 'Lakehouses', only: 'Lakehouse' },
  { label: 'Warehouses', only: 'Warehouse' },
  { label: 'SQL databases', only: 'SQL database' },
  { label: 'Mirrored databases', only: 'Mirrored database' },
  { label: 'Semantic models', only: 'models' },
  { label: 'Apps', only: 'apps' },
];
const isFabricFilter = only => only === 'models' || only === 'apps';

// A node is a plain object; getTreeItem turns it into what VS Code renders. Keeping the
// domain data on the node (rather than encoding it into a label) is what lets a click hand
// the panel a { workspace, item, schema, table } with nothing to parse back out.
const node = (kind, label, extra) => ({ kind, label, ...extra });
// The nodes a listing is behind.
const LISTS = new Set(['workspace', 'tables', 'dir', 'models', 'apps']);

// A table node's SQL name (lakehouse.ws.item.schema.table), or null for an item SQL cannot name.
const sqlNameOrNull = n => { try { return sqlNameOf(n, n); } catch (_) { return null; } };

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
   * @param {() => string|null} [deps.filter]  the one type to show (TREE_FILTERS' `only`), if any
   * @param {() => void} [deps.onAsked]  VS Code asked for its top level
   * @param {() => void} [deps.onDrawn]  its top level was just answered, with what it holds
   * @param {() => number} [deps.keepLimitBytes]  how much of the tables in use is kept with nobody asking
   */
  constructor({ onelake, fabric = null, hasFabric = async () => false, isSignedIn, log = () => {},
                favorites = { get: () => [] }, cachedModel = () => null, unsupportedModel = () => null,
                queries = { list: async () => [] }, filter = () => null, onAsked = () => {}, onDrawn = () => {},
                keepLimitBytes = () => 0 }) {
    this.keepLimitBytes = keepLimitBytes;
    this.onAsked = onAsked;
    this.onDrawn = onDrawn;
    this.queries = queries;
    this.onelake = onelake;
    this.filter = filter;
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
    // Whether a table is cached can change when its metadata is first read, when it moves to a new
    // snapshot, and when a statement reads its rows.
    this._unsubRead = onelake.onTableRead ? onelake.onTableRead(r => this._cachedChanged(this._tableNode(r))) : null;
    this._unsubRows = onelake.onRowsRead
      ? onelake.onRowsRead(where => {
        // Only what was read: every statement comes through here, and a lakehouse can have thousands of nodes.
        let text = where == null ? null : String(where);
        try { if (text) text = decodeURIComponent(text); } catch (_) {}
        const named = n => text == null || (n.kind === 'file' ? text.endsWith(`/${n.path}`) : text.includes(`/${n.table}/`));
        for (const n of this._nodes.values()) if ((n.kind === 'table' || n.kind === 'file') && !n.cached && named(n)) this._cachedChanged(n);
      }) : null;
  }

  dispose() {
    if (this._unsub) this._unsub();
    if (this._unsubRead) this._unsubRead();
    if (this._unsubRows) this._unsubRows();
    this._emitter.dispose();
  }

  _tableNode(t) {
    return this._nodes.get(`table|${t.workspace}|${t.item}|${t.schema || ''}|${t.table}`);
  }

  // What the pointer resting on a table says. Asked for then, as a lakehouse can draw thousands.
  async resolveTreeItem(item, n) {
    if (n.kind === 'table' && !n.notValid) item.tooltip = await this._tableTooltip(n);
    return item;
  }

  async _tableTooltip(n) {
    const lines = [sqlNameOrNull(n) || (n.schema ? `${n.schema}.${n.table}` : n.table), n.cached
      ? 'Read on this machine. What was read works offline; a column or a file never read needs OneLake.'
      : 'Not read on this machine yet, so its rows need OneLake.'];
    const t = { workspace: n.workspace, item: n.item, schema: n.schema, table: n.table };
    const reads = this.onelake.usage.readsInUse(t);
    if (!reads) return lines.join('\n');
    lines.push(`Read ${reads} times in the last 14 days, so it is kept up to date.`);
    const meta = (await this.onelake.cached.table(t, t).catch(() => null))?.value;
    const kept = meta && meta.metadataLocation ? this.onelake.usage.kept(t, meta.metadataLocation) : null;
    const size = Number(meta && meta.stats && meta.stats.totalFilesSize) || 0;
    const limit = this.keepLimitBytes();
    if (kept && !kept.error) lines.push('Read whole at its current snapshot, every column.');
    else if (limit > 0 && size > limit) lines.push(`${fmtBytes(size)} is over the ${fmtBytes(limit)} kept automatically, so only what was read is on this machine.`);
    return lines.join('\n');
  }

  _cachedChanged(n) {
    if (!n) return;
    if (n.kind === 'table') {
      this.onelake.cached.notValid({ workspace: n.workspace, item: n.item }, { schema: n.schema, table: n.table }).then(why => {
        if ((n.notValid || null) === why) return;
        n.notValid = why;
        this._emitter.fire(n);
      }, () => {});
    }
    (n.kind === 'file'
      ? this.onelake.cached.file(n.workspace, n)
      : this.onelake.cached.rows({ workspace: n.workspace, item: n.item }, { schema: n.schema, table: n.table })).then(cached => {
      if (!!n.cached === cached) return;
      n.cached = cached;
      this._emitter.fire(n);
    }, () => {});
  }

  _changed(c) {
    if (c.kind === 'table') return this._cachedChanged(this._tableNode(c));
    if (c.kind === 'workspaces') return this._emitter.fire(undefined);
    // Filtered, a listing decides which workspaces show at all.
    if (this.filter() && ['items', 'models', 'apps'].includes(c.kind)) return this._emitter.fire(undefined);
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
  // `n` may also be a description of a node rather than the node itself (the model's export
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
         : n.kind === 'apps' ? `apps|${n.workspace}`
         : n.kind === 'queries' ? 'queries'
         : n.kind === 'table' ? `table|${n.workspace}|${n.item}|${n.schema || ''}|${n.table}`
         : n.kind === 'file' ? `file|${n.workspace}|${n.path}`
         : null;
  }

  // A model was just downloaded: redraw that one node, so its icon says so. Not the
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
        + (n.appId ? `|${n.appId}` : '')
        // A filter opens its groups and workspaces without touching what was open before it.
        + (n.filter ? `|${n.filter}` : '');
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
      // one runs whatever the panel has open. A click opens it in the panel's SQL box.
      case 'queries':
        item.iconPath = new vscode.ThemeIcon('bookmark');
        break;
      // Two views of the engine, each a tab of its own.
      case 'logs':
        item.iconPath = new vscode.ThemeIcon('history');
        item.tooltip = 'What the engine has run, from every tab and window';
        item.command = { command: 'onelakeStudio.showLogs', title: 'Logs' };
        break;
      case 'performance':
        item.iconPath = new vscode.ThemeIcon('pulse');
        item.tooltip = 'How the engine is doing right now';
        item.command = { command: 'onelakeStudio.showPerformance', title: 'Performance' };
        break;
      case 'query':
        item.iconPath = new vscode.ThemeIcon('file-code');
        item.command = { command: 'onelakeStudio.openQuery', title: 'Open query', arguments: [n] };
        item.tooltip = n.path;
        break;
      case 'item':
        item.iconPath = new vscode.ThemeIcon(isMirrored(n.item) ? 'mirror' : 'database');
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
      // As a model: a cloud until it is on this machine, a check once it is.
      case 'table':
        item.command = { command: 'onelakeStudio.openTable', title: 'Open table', arguments: [n] };
        if (n.notValid) {
          item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
          item.description = 'not a valid table';
          item.tooltip = n.notValid;
          break;
        }
        item.iconPath = n.cached
          ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
          : new vscode.ThemeIcon('cloud');
        // Left to resolveTreeItem: what it says comes from the catalog.
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
        // A click already found its tables are not in OneLake: say what it is, and a click says
        // why again.
        const refused = this.unsupportedModel(n);
        if (refused) {
          item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
          item.description = `${refused.replace(/^an? /, '')} · not supported`;
          item.command = { command: 'onelakeStudio.openSemanticModel', title: 'Open semantic model', arguments: [n] };
          item.tooltip = (n.description ? `${n.description}\n\n` : '') +
            `${n.model} is ${refused}. OneLake Studio opens Direct Lake models whose tables it can find in OneLake.`;
          break;
        }
        const there = this.cachedModel(n);
        item.iconPath = there
          ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
          : new vscode.ThemeIcon('cloud');
        item.description = '';
        item.command = { command: 'onelakeStudio.openSemanticModel', title: 'Open semantic model', arguments: [n] };
        item.tooltip = (n.description ? `${n.description}\n\n` : '') + (there
          ? `Downloaded to ${there}. Click to open it; Download Again reads it from Fabric again.`
          : 'Click to download its definition (kept on this machine only) and open it as a model.');
        break;
      }
      // A workspace's Fabric apps (AppBackend items), however they were made — from the
      // Fabric API. Its URL and last deploy, a button to copy the URL, and a double click to open it.
      case 'apps':
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
        item.description = [n.access === 'public' ? 'public' : '', host]
          .filter(Boolean).join(' · ');
        item.tooltip = [n.url || 'No site deployed',
          n.access === 'public' ? 'Public: anyone with the URL can load the site, without signing in.'
            : n.access === 'protected' ? 'Protected: Fabric asks for a sign-in and permission on the app first.' : '',
          n.deployedAt ? `Last deployed ${new Date(n.deployedAt).toLocaleString()}` : '',
          n.url ? 'Click to open it in the browser.' : '',
          n.description].filter(Boolean).join('\n');
        if (n.url) item.command = { command: 'onelakeStudio.openApp', title: 'Open App', arguments: [n] };
        break;
      }
      case 'fabricSignIn':
        item.iconPath = new vscode.ThemeIcon('sign-in');
        item.command = { command: 'onelakeStudio.signInFabric', title: 'Sign in to the Fabric API' };
        item.tooltip = 'Semantic models come from the Fabric REST API, which needs its own sign-in.';
        break;
      // As a table: a cloud until it has been read here, a check after.
      case 'file':
        item.iconPath = n.cached
          ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
          : new vscode.ThemeIcon('cloud');
        item.description = n.size;
        item.command = { command: 'onelakeStudio.openFile', title: 'Open file', arguments: [n] };
        item.tooltip = [n.label, n.cached
          ? 'Read on this machine. What was read works offline; a part never read needs OneLake.'
          : 'Not read on this machine yet, so it needs OneLake.'].join('\n');
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
    // What is listed is still on show, and this says why it may be old.
    if (LISTS.has(n.kind) && this.onelake.listingFailure) {
      const failed = this.onelake.listingFailure(n);
      if (failed) {
        item.description = [item.description, 'refresh failed'].filter(Boolean).join(' · ');
        item.tooltip = `Last refresh failed: ${failed.error}\nWhat is shown is the last good answer.`;
      }
    }
    return item;
  }

  // What this window has opened, for the sync worker to keep current: a node whose children were asked
  // for, as a listing.
  opened() {
    const out = [];
    for (const n of this._nodes.values()) {
      if (!n.opened) continue;
      if (n.kind === 'workspace') out.push({ kind: 'items', workspace: n.workspace });
      else if (n.kind === 'tables') out.push({ kind: 'tables', workspace: n.workspace, item: n.item });
      else if (n.kind === 'dir') out.push({ kind: 'files', workspace: n.workspace, item: n.item, dir: n.dir || '' });
      else if (n.kind === 'models' || n.kind === 'apps') out.push({ kind: n.kind, workspace: n.workspace });
    }
    return out;
  }

  async getChildren(n) {
    if (!this.isSignedIn()) return [];   // the welcome view covers this state
    if (n) n.opened = true;
    else this.onAsked();
    try {
      return await this._children(n);
    } catch (e) {
      // The node carries the sentence; the log carries the stack.
      this.log(`tree: listing ${n ? `${n.kind} ${n.label}` : 'workspaces'} failed — ${(e && e.stack) || e}`);
      const detail = (e && e.message) || String(e);
      // `parent` is what its Refresh button refreshes: the error node itself names nothing.
      const error = node('error', detail.length > 90 ? detail.slice(0, 87) + '…' : detail,
        { leaf: true, detail, parent: n });
      // At the top, what doesn't need OneLake stays reachable: saved queries above all.
      return n ? [error] : [error, ...this._local()];
    } finally {
      if (!n) this.onDrawn();
    }
  }

  // What the tree shows with or without OneLake.
  _local() {
    return [
      this._track(node('queries', 'Queries', {})),
      node('logs', 'Logs', { leaf: true }),
      node('performance', 'Performance', { leaf: true }),
    ];
  }

  async _children(n) {

    // A tenant can have hundreds of workspaces, so the top level is two groups: the ones
    // pinned as favorites (open), and all the others (closed once anything is pinned).
    // Pins are names; one whose workspace is gone (or belongs to another tenant) is simply
    // not shown.
    if (!n) {
      const names = await this.onelake.workspaces({ fresh: this._isFresh('root', undefined, undefined) });
      if (!names.length) return [node('empty', 'No workspaces — is this the right tenant?', { leaf: true }), ...this._local()];
      const only = this.filter();
      if (isFabricFilter(only) && !await this.hasFabric()) {
        const what = only === 'models' ? 'semantic models' : 'apps';
        return [node('fabricSignIn', `Sign in to list ${what}`, { leaf: true, group: only }), ...this._local()];
      }
      const shown = only ? await this._holding(names, only) : names;
      if (!shown.length) return [node('empty', 'No workspace holds this type', { leaf: true }), ...this._local()];
      const pinned = new Set(this.favorites.get());
      const favs = shown.filter(w => pinned.has(w));
      return [
        node('group', 'Favorites', { group: 'favorites', expanded: true, count: favs.length, filter: only, names: shown }),
        node('group', favs.length ? 'Other workspaces' : 'Workspaces',
             { group: 'others', expanded: !favs.length || !!only, count: shown.length - favs.length, filter: only, names: shown }),
        ...this._local(),
      ];
    }

    if (n.kind === 'queries') {
      const list = await this.queries.list();
      if (!list.length) return [node('empty', 'Start one with +', { leaf: true })];
      return list.map(q => node('query', q.name, { leaf: true, path: q.path }));
    }

    if (n.kind === 'group') {
      const pinned = new Set(this.favorites.get());
      const mine = n.names.filter(w => (n.group === 'favorites') === pinned.has(w));
      if (!mine.length) {
        return [node('empty', n.filter ? 'None here holds this type'
          : n.group === 'favorites' ? 'Pin a workspace with its ☆ button to keep it here'
          : 'Every workspace is pinned', { leaf: true })];
      }
      return mine.map(name => this._track(node('workspace', name,
        { workspace: name, pinned: pinned.has(name), filter: n.filter, expanded: !!n.filter })));
    }

    if (n.kind === 'workspace') {
      const only = this.filter();
      // Filtered to a Fabric listing, the workspace holds just that, with no heading to open.
      if (isFabricFilter(only)) return this._children({ kind: only, workspace: n.workspace });
      const items = await this._items(n.workspace, only);
      const kids = items.length
        ? items.map(it => this._item(n.workspace, it))
        : [node('empty', only ? 'Nothing here of this type' : 'Nothing here holds tables', { leaf: true })];
      // Last, and closed: listing it is a Fabric API call, on a token sign-in never asked for.
      if (this.fabric && !only) {
        kids.push(this._track(node('models', 'Semantic models', { workspace: n.workspace })));
        kids.push(this._track(node('apps', 'Apps', { workspace: n.workspace })));
      }
      return kids;
    }

    if (n.kind === 'apps') {
      if (!await this.hasFabric()) {
        return [node('fabricSignIn', 'Sign in to list apps', { leaf: true, group: 'apps', workspace: n.workspace })];
      }
      const apps = await this.onelake.apps(n.workspace,
        { fresh: this._isFresh(`apps|${n.workspace}`, n.workspace) });
      return apps.length
        ? apps.map(a => this._app(n.workspace, a))
        : [node('empty', 'No apps', { leaf: true })];
    }

    if (n.kind === 'models') {
      if (!await this.hasFabric()) {
        return [node('fabricSignIn', 'Sign in to list semantic models', { leaf: true, group: 'models', workspace: n.workspace })];
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
      // Each with whether it is cached, as a table is: read from the store, never from OneLake.
      const cached = await Promise.all(entries.map(e => (e.isDir ? false : this.onelake.cached.file(n.workspace, e).catch(() => false))));
      return entries.map((e, i) => this._track(e.isDir
        // `path` is workspace-relative (…/Files/a/b); the child directory is what follows
        // Files/, which is what listFiles takes.
        ? node('dir', e.name, { ...lh, dir: strip(e.path.replace(/^.*?\/Files\/?/, '')) })
        // bytes travels with it so the panel can open the file without re-listing the
        // directory it already knows everything about.
        : node('file', e.name, { ...lh, leaf: true, path: e.path, bytes: e.bytes, size: fmtBytes(e.bytes), version: e.version, cached: cached[i] })));
    }

    return [];
  }

  _app(workspace, a) {
    return node('fabricApp', a.name, {
      workspace, appId: a.id, url: a.url, deployedAt: a.deployedAt, access: a.access, description: a.description,
      leaf: true,
    });
  }

  // Each with whether it is cached — read from the store, never from OneLake.
  async _tables(lh, list) {
    const cached = await Promise.all(list.map(t => this.onelake.cached.rows(lh, t).catch(() => false)));
    const notValid = await Promise.all(list.map(t => this.onelake.cached.notValid(lh, t).catch(() => null)));
    return list.map((t, i) => this._track(node('table', t.table,
      { ...lh, leaf: true, schema: t.schema || '', table: t.table, cached: cached[i], notValid: notValid[i] })));
  }

  // An item, named without its suffix, with its type beside it.
  _item(workspace, it) {
    return node('item', it.name.replace(/\.[^.]+$/, ''), {
      workspace, item: it.name, kindLabel: kindLabel(it.kind),
    });
  }

  // A workspace's items, or only those of the type a filter picked.
  async _items(ws, only) {
    const items = await this.onelake.items(ws, { fresh: this._isFresh(`items|${ws}`, ws) });
    return only ? items.filter(it => kindLabel(it.kind) === only) : items;
  }

  // Filtered: the workspaces that hold that type. The one place the tree reads across workspaces,
  // and only because the user asked: each listing cache-first, four at a time. A workspace that
  // can't be listed stays, so opening it says why rather than the tree silently showing less.
  async _holding(names, only) {
    const holds = await mapPool(names, async ws => {
      try {
        const list = only === 'models' ? await this.onelake.models(ws, { fresh: this._isFresh(`models|${ws}`, ws) })
          : only === 'apps' ? await this.onelake.apps(ws, { fresh: this._isFresh(`apps|${ws}`, ws) })
          : await this._items(ws, only);
        return list.length > 0;
      } catch (_) { return true; }
    }, 4);
    return names.filter((_, i) => holds[i]);
  }
}

module.exports = { LakehouseTree, TREE_FILTERS };
