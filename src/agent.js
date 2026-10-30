'use strict';
// =============================================================================
// agent.js — the questions an agent asks, answered by the extension itself
// =============================================================================
// cli.mjs is only a doorbell: it hands its arguments to the running extension (bridge.js)
// and prints what comes back. The answer is made here, with what the extension already
// has — its sign-in, its cache-first OneLake (onelake.js), the Fabric API, the downloaded
// model files, the DAX compiler — so there is one sign-in and one cache, not a second copy
// for the command line. Read only: every statement goes through the engine's guard. The one
// exception is export, which is Explore's own Export to Fabric, confirmed in VS Code.
//
//   ls [<ws> [<item>]]               workspaces / items + semantic models / tables
//   models [<ws>]                    semantic models in every workspace (or one), counted
//   items [<ws>]                     lakehouses and warehouses in every workspace (or one), counted
//   files <ws> <item> [<dir>]        a lakehouse's Files/ listing
//   find <text>                      every cached name that contains it: items, tables, columns,
//                                    semantic models, and a downloaded model's tables and measures
//   table <ws> <item> <schema.table> metadata only
//   model <ws> <model>               relationships, columns, measures with DAX
//   sql "<sql>" [--in <ws>/<item>]   a table is Kind.workspace.item.schema.table; a semantic model
//                                    is semanticmodel.ws.model, AGG("m") its measure m; and SHOW
//                                    SEMANTIC VIEWS / METRICS / DIMENSIONS; --in reads its
//                                    'Files/…' paths; --show-sql the compiled SQL
//   export <ws> <model>              Export to Fabric, as Explore's button: a semantic model
//   export <ws> <item> <Files/path>  (its local copy, written into its lakehouse) or a model file in Files/
//
// No `vscode` import: the extension passes in what it owns.
// =============================================================================

const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const fsp = require('node:fs/promises');
const { fmtBytes, hasFilesArea, kindLabel, sqlNameOf, abfssUrl } = require('./names');
const { mapPool } = require('./http');
const { walkCached } = require('./onelake');
const { EXIT, checkRequest, failureJson } = require('./bridge');

const SIGN_IN_TO_FABRIC = 'expand "Semantic models" in the OneLake tree once to sign in to Fabric';

const cell = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
function mdTable(cols, rows) {
  const md = v => cell(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [`| ${cols.map(md).join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`,
          ...rows.map(r => `| ${r.map(md).join(' | ')} |`)].join('\n');
}
const csvOf = (cols, rows) => [cols, ...rows].map(r => r.map(v => {
  const s = cell(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\n');

const fence = (lang, text) => '```' + lang + '\n' + String(text).trim() + '\n```';

// 'Files/x.parquet' in SQL run --in a lakehouse is that lakehouse's file, by its abfss:// name:
// the engine reads OneLake, never the local disk (its lockdown refuses a relative path).
function filesToAbfss(sql, lh) {
  const ws = String(lh.workspace).replace(/'/g, "''");
  const item = String(lh.item).replace(/'/g, "''");
  return String(sql).replace(/'\/?(Files\/(?:[^']|'')*)'/g, (_, p) => `'${abfssUrl(ws, `${item}/${p}`)}'`);
}

/**
 * @param {object} o
 * @param {ReturnType<import('./onelake').createOneLake>} o.onelake
 * @param {() => Promise<object>} o.engine   the extension's engine (engine-host.js)
 * @param {(ws: string, model: string) => string} o.modelPath  where a model's .yaml is downloaded
 * @param {string} o.appDir                  the panel's modules (semantic.js, paths.js)
 * @param {string} o.vendorDir               the vendored DAX compiler and YAML reader
 * @param {ReturnType<import('./semviews').createSemViews>} o.semviews  the views this machine keeps
 * @param {(x: object) => Promise<string>} [o.exportApp]  Explore's Export to Fabric (extension.js)
 * @param {(n: {workspace: string, model: string, modelId: string}) => Promise<{path: string, text: string}>} [o.fetchModel]
 *   a semantic model's definition read from Fabric again, into its local copy (modelPath)
 * @param {(x: {workspace: string, model: string}) => Promise<object>} [o.openModel]
 *   a semantic model a query names, opened from its local copy and kept as a view
 * @param {() => boolean} [o.signedIn]       false: every question is answered UNAVAILABLE
 */
function createAgent({ onelake, engine, modelPath, appDir, vendorDir, daxSqlPin, yamlPin, semviews,
                       exportApp = null, fetchModel = null, openModel = null, nameTables = null,
                       signedIn = () => true }) {
  let mods = null;
  async function modules() {
    if (mods) return mods;
    const load = p => import(pathToFileURL(p).href);
    const [paths, semantic, c, t, o, y] = await Promise.all([
      load(join(appDir, 'paths.js')), load(join(appDir, 'semantic.js')),
      load(join(vendorDir, 'npm', daxSqlPin, 'src', 'index.js')),
      load(join(vendorDir, 'npm', daxSqlPin, 'formats', 'tmsl.js')),
      load(join(vendorDir, 'npm', daxSqlPin, 'formats', 'ossie.js')),
      load(join(vendorDir, 'npm', yamlPin, '+esm.js')),
    ]);
    // A model's Direct Lake tables are named by the extension, which asks Fabric for the
    // names behind their GUIDs: the same SQL names the panel's models use.
    semantic.setTableNamer(list => (nameTables ? nameTables(list)
      : Promise.reject(new Error('Direct Lake tables cannot be named here'))));
    mods = { paths, semantic,
             compiler: { createCompiler: c.createCompiler, createViews: c.createViews, tmslToModel: t.tmslToModel,
                         ossieToTmsl: o.ossieToTmsl, tmslToOssie: o.tmslToOssie,
                         parseYaml: y.parse, stringifyYaml: y.stringify } };
    return mods;
  }

  const exists = p => fsp.stat(p).then(() => true, () => false);

  // ---------------------------------------------------------------------------
  // Listings and metadata are answered from what the extension already has on disk, and
  // never fetched: the command line does not sign anyone in, start an export, or list a
  // workspace behind the user's back. `--fresh` is the one way to have it ask OneLake or
  // Fabric. A query (sql) reads OneLake — that is what a query is for.
  // ---------------------------------------------------------------------------
  const notCached = (what, how) => Object.assign(
    new Error(`${what} is not cached yet — ${how} in the OneLake Studio tree, or add --fresh to read it now`),
    { notCached: true });
  const IN_TREE = {
    workspaces: ['the workspace list', 'sign in and open the explorer'],
    items: ws => [`${ws}'s lakehouses and warehouses`, `expand ${ws}`],
    models: ws => [`${ws}'s semantic models`, `expand "Semantic models" under ${ws}`],
    tables: lh => [`${lh.workspace}/${lh.item}'s tables`, `expand ${lh.item}`],
    table: (lh, t) => [`${lh.workspace}/${lh.item} ${t.schema}.${t.table}'s metadata`, 'open the table'],
    files: (lh, dir) => [`${lh.workspace}/${lh.item} Files/${dir}`, `expand Files/${dir} under ${lh.item}`],
  };
  const size = v => (v > 0 ? fmtBytes(v) : '—');
  const when = ms => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—');

  // A table named as `schema.table`, or bare: a bare name is looked up in the item's cached
  // listing, so a schema-less item's table (schema '') is found rather than guessed as dbo.
  async function tableOf(lh, name) {
    const dot = name.indexOf('.');
    if (dot > 0) return { schema: name.slice(0, dot), table: name.slice(dot + 1) };
    const listed = await onelake.cached.tables(lh);
    const hits = ((listed && listed.value) || []).filter(t => t.table.toLowerCase() === name.toLowerCase());
    if (hits.length === 1) return { schema: hits[0].schema || '', table: hits[0].table };
    if (hits.length > 1) throw new Error(`"${name}" is in ${hits.length} schemas — name it as <schema>.${name}`);
    return { schema: 'dbo', table: name };
  }

  // A downloaded model, read from its file on disk: how many tables and measures, and their
  // names with their columns — for `models` and `find`. Null when it does not parse.
  async function modelSummary(path) {
    try {
      const { semantic, compiler } = await modules();
      const bim = semantic.bimOf(path, await fsp.readFile(path, 'utf8'), compiler);
      const tables = ((bim.model && bim.model.tables) || []).filter(t => !t.isHidden || (t.measures || []).length);
      return {
        tables: tables.map(t => ({ name: t.name, columns: (t.columns || []).map(c => c.name),
                                   measures: (t.measures || []).map(m => m.name) })),
        measures: tables.reduce((n, t) => n + (t.measures || []).length, 0),
      };
    } catch (_) { return null; }
  }
  // One listing: from disk, or — with --fresh only — from OneLake/Fabric. `seen` collects
  // when each answer was stored, for the "as of" note.
  async function look(kind, args, { fresh, seen }) {
    if (fresh) return onelake[kind](...args, { fresh: true });
    const e = await onelake.cached[kind](...args);
    if (!e) {
      const [what, how] = typeof IN_TREE[kind] === 'function' ? IN_TREE[kind](...args) : IN_TREE[kind];
      throw notCached(what, how);
    }
    if (seen) seen.push(e.at);
    return e.value;
  }

  const ago = at => {
    const min = Math.round((Date.now() - at) / 60000);
    return min < 1 ? 'just now' : min < 120 ? `${min} min ago`
      : min < 2 * 1440 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
  };

  // `items`: the workspace's listing — the cache's, for a listing command; a query passes the
  // one it may fetch.
  async function itemOf(ws, name, items) {
    const lc = String(name).toLowerCase();
    const hit = items.find(i => i.name.toLowerCase() === lc) ||
                items.find(i => i.name.toLowerCase().replace(/\.[^.]+$/, '') === lc);
    if (!hit) throw new Error(`no item "${name}" in ${ws} — \`ls ${ws}\` lists them`);
    return { workspace: ws, item: hit.name };
  }

  async function modelOf(ws, name, opts) {
    const hit = (await look('models', [ws], opts)).find(m => m.name.toLowerCase() === String(name).toLowerCase());
    if (!hit) throw new Error(`no semantic model "${name}" in ${ws} — \`ls ${ws}\` lists them`);
    return hit;
  }

  // The views the extension keeps (semviews.js), defined in dax-sql's registry — the same
  // list the panel has, so a view made in either is named in both.
  const defined = new Set();
  async function syncViews(note) {
    const { semantic, compiler } = await modules();
    const kept = await semviews.texts();
    const names = new Set();   // each view's SQL name (semanticmodel.ws.model), lower-cased
    for (const v of kept) {
      if (!v.schema) continue;   // named before models were semanticmodel.ws.model
      try {
        if (v.error) throw new Error(v.error);
        const m = await semantic.defineView(v.name, v.path, v.text, 'replace', compiler, v.schema);
        defined.add(m.name.toLowerCase());
        names.add(m.name.toLowerCase());
      } catch (e) { note(`semantic view ${v.schema ? `${v.schema}.` : ''}${v.name} skipped: ${e.message}`); }
    }
    for (const n of [...defined]) if (!names.has(n)) { semantic.dropView(n); defined.delete(n); }
  }

  // `fn` for one workspace, or for every workspace the cache knows. From disk that is quick;
  // with --fresh it is one OneLake or Fabric call per workspace, so a few run at a time. In a
  // sweep, a workspace whose listing is not cached, or cannot be read, is counted and named in a
  // note rather than ending the answer: { missing, failed }. A workspace asked for by name is
  // the whole question, so its failure is the answer's.
  async function eachWorkspace(ws, opts, fn, { note, incomplete }) {
    if (ws) { await fn(ws); return { missing: 0, failed: 0 }; }
    const list = await look('workspaces', [], opts);
    const missing = [];
    let failed = 0, unauthorised = false;
    await mapPool(list, async w => {
      try { await fn(w); }
      catch (e) {
        if (e.notCached) { missing.push(w); return; }
        failed++;
        if (e.status === 401) unauthorised = true;
        note(`${w}: not listed — ${e.message}`);
      }
    }, 4);
    if (missing.length) {
      note(`not cached yet, so not counted: ${missing.sort().join(', ')} — expand them in the OneLake Studio tree, ` +
           'or add --fresh to read them now');
    }
    if (unauthorised) note(SIGN_IN_TO_FABRIC);
    if (missing.length || failed) incomplete();
    return { missing: missing.length, failed };
  }
  const shortfall = ({ missing, failed }) =>
    (missing ? `; ${missing} workspace(s) not cached` : '') + (failed ? `; ${failed} could not be read` : '');
  // Sorted by code unit, never by locale: the same answer on every machine.
  const order = (a, b) => { const x = String(a ?? ''), y = String(b ?? ''); return x < y ? -1 : x > y ? 1 : 0; };
  const byColumns = n => (a, b) => {
    for (let i = 0; i < n; i++) { const c = order(a[i], b[i]); if (c) return c; }
    return 0;
  };
  // A column: its name and type in --csv and --json, and how a person reads it in Markdown
  // (`label`, `show`). The rows are always the raw values.
  const col = (name, type = 'text', label = name, show = null) => ({ name, type, label, show });
  const count = v => (v == null ? '—' : Number(v).toLocaleString('en'));
  const COLS = {
    downloaded: col('downloaded', 'boolean', '', v => (v ? 'downloaded' : '')),
    bytes: col('bytes', 'integer', 'size', size),
    lastWrite: col('last_write', 'timestamp', 'last write (UTC)', when),
  };
  const iso = ms => (ms ? new Date(ms).toISOString() : null);

  // ---------------------------------------------------------------------------
  // Every command writes to `io`: table() its answer, out() the prose around it for a person
  // to read (Markdown only), data() what --json carries beside its tables, note() to stderr
  // (--json's `notes`), and incomplete() when something it should have read, it did not.
  // ---------------------------------------------------------------------------
  const commands = {
    async ls([ws, item], opts, io) {
      if (!ws) {
        io.table([col('workspace')], (await look('workspaces', [], opts)).map(w => [w]), { sort: 1 });
        return;
      }
      if (!item) {
        if (opts.csv) throw usage(`ls <ws> is two tables: items ${ws} --csv, models ${ws} --csv`);
        // Either half may be cached without the other: each says so on its own.
        let shown = 0;
        try {
          io.table([col('item'), col('kind')], (await look('items', [ws], opts)).map(i => [i.name, i.kind]), { name: 'items', sort: 2 });
          shown++;
        } catch (e) { if (!e.notCached) throw e; io.note(e.message); io.incomplete(); }
        try {
          const rows = [];
          for (const m of await look('models', [ws], opts)) {
            rows.push([m.name, await exists(modelPath(ws, m.name)), m.description]);
          }
          if (shown) io.out('');
          io.table([col('semantic model'), COLS.downloaded, col('description')], rows,
                   { name: 'models', sort: 1, empty: 'No semantic models.' });
          shown++;
        } catch (e) {
          io.incomplete();
          if (e.notCached) io.note(e.message);
          else io.note(`semantic models not listed: ${e.message}` + (e.status === 401 ? ` — ${SIGN_IN_TO_FABRIC}` : ''));
        }
        if (!shown) throw notCached(`${ws}`, `expand ${ws}`);
        return;
      }
      const lh = await itemOf(ws, item, await look('items', [ws], opts));
      const tables = await look('tables', [lh], opts);
      // Each table's size and last write, from its metadata where the cache has it — the
      // tree reads every table's metadata once its Tables node is open.
      let known = 0;
      const rows = [];
      for (const t of tables) {
        const e = await onelake.cached.table(lh, t);
        const m = e ? e.value : null, s = (m && m.stats) || {};
        if (m) known++;
        rows.push([t.schema ? `${t.schema}.${t.table}` : t.table, sqlNameOf(lh, t),
          m && m.totalRecords != null ? Number(m.totalRecords) : null,
          s.totalFilesSize != null ? Number(s.totalFilesSize) : null,
          s.totalDataFiles != null ? Number(s.totalDataFiles) : null, iso(s.snapshotTs)]);
      }
      io.table([col('table'), col('sql_name', 'text', 'in sql'), col('rows', 'integer', 'rows', count), COLS.bytes,
                col('files', 'integer', 'files', v => (v == null ? '—' : v)), COLS.lastWrite], rows, { sort: 2 });
      io.out(`\n${tables.length} table(s), ${known} with metadata cached` +
        (known < tables.length ? ' — open the rest in the tree for their sizes' : ''));
    },

    // A lakehouse's Files/ — the listing the tree read when that folder was expanded.
    async files([ws, item, dir = ''], opts, io) {
      const lh = await itemOf(ws, item, await look('items', [ws], opts));
      if (!hasFilesArea(lh.item)) throw new Error(`${lh.item} has no Files area — only a lakehouse does`);
      const d = String(dir).replace(/^\/?Files\/?/i, '').replace(/\/+$/, '');
      const entries = await look('files', [lh, d], opts);
      io.table([col('name'), col('type', 'text', ''), col('bytes', 'integer', 'size', v => (v == null ? '' : size(v)))],
               entries.map(e => [e.name, e.isDir ? 'folder' : 'file', e.isDir || e.bytes == null ? null : Number(e.bytes)]),
               { sort: 2, empty: `Files/${d} is empty.` });
      const n = entries.filter(e => !e.isDir);
      io.out(`\n${n.length} file(s), ${entries.length - n.length} folder(s), ${size(n.reduce((a, e) => a + (e.bytes || 0), 0))}` +
             ` in Files/${d}`);
    },

    // Every name the cache knows that contains `text` — never fetched, so what has not been
    // opened in the tree is not searched, and the answer says how much that is.
    async find([text], opts, io) {
      const q = String(text).toLowerCase();
      const has = s => String(s || '').toLowerCase().includes(q);
      const rows = [];
      // The cache's one walk (onelake.js cached.all), as the editor's catalog reads it.
      const all = await walkCached(onelake.cached);
      if (!all) throw Object.assign(new Error(`${IN_TREE.workspaces[0]} is not cached yet — ${IN_TREE.workspaces[1]}`), { notCached: true, retry: 'ls --fresh' });
      opts.seen.push(all.at);
      const unseen = all.unseen;
      for (const { name: w, items, models } of all.workspaces) {
        if (has(w)) rows.push(['workspace', '', w]);
        for (const it of items) {
          if (has(it.name)) rows.push([it.kind.toLowerCase(), w, it.name]);
          for (const t of it.tables || []) {
            const tn = t.schema ? `${t.schema}.${t.table}` : t.table;
            if (has(t.table)) rows.push(['table', `${w}/${it.name}`, tn]);
            for (const f of (t.meta && t.meta.schemaFields) || []) {
              if (has(f.name)) rows.push(['column', `${w}/${it.name} ${tn}`, `${f.name} (${f.type})`]);
            }
          }
        }
        for (const m of models) {
          if (has(m.name) || has(m.description)) rows.push(['semantic model', w, m.name]);
          const path = modelPath(w, m.name);
          const b = await exists(path) ? await modelSummary(path) : null;
          for (const t of (b && b.tables) || []) {
            const where = `${w}/${m.name}`;
            if (has(t.name)) rows.push(['model table', where, t.name]);
            for (const c of t.columns) if (has(c)) rows.push(['model column', where, `${t.name}[${c}]`]);
            for (const x of t.measures) if (has(x)) rows.push(['measure', where, `[${x}] in ${t.name}`]);
          }
        }
      }
      io.table([col('kind'), col('where'), col('name')], rows, { sort: 3, empty: `Nothing cached contains "${text}".`,
        foot: (total, shown) => `\n${total} match(es)` + (total > shown ? `, first ${shown} shown` : '') });
      const gaps = [unseen.workspaces && `the items of ${unseen.workspaces} workspace(s)`,
                    unseen.items && `the tables of ${unseen.items} item(s)`].filter(Boolean);
      if (gaps.length) {
        io.incomplete();
        io.note(`not searched, not cached yet: ${gaps.join(' and ')} — expand them in the OneLake Studio tree`);
      }
    },

    // Every workspace's semantic models, or one workspace's, counted.
    async models([ws], opts, io) {
      const rows = [];
      const gaps = await eachWorkspace(ws, opts, async w => {
        for (const m of await look('models', [w], opts)) {
          // A downloaded model says what is in it, from its file on disk.
          const path = modelPath(w, m.name);
          const b = await exists(path) ? await modelSummary(path) : null;
          rows.push([w, m.name, !!b, b ? b.tables.length : null, b ? b.measures : null, m.description]);
        }
      }, io);
      const n = new Set(rows.map(r => r[0])).size;
      io.table([col('workspace'), col('semantic_model', 'text', 'semantic model'), COLS.downloaded, col('tables', 'integer'),
                col('measures', 'integer'), col('description')], rows, { sort: 2, empty: 'No semantic models.' });
      io.out(`\n${rows.length} semantic model(s) in ${n} workspace(s)${shortfall(gaps)}`);
    },

    // Every workspace's lakehouses and warehouses, or one workspace's, counted by kind.
    async items([ws], opts, io) {
      const rows = [];
      const gaps = await eachWorkspace(ws, opts, async w => {
        for (const i of await look('items', [w], opts)) rows.push([w, i.name, kindLabel(i.kind)]);
      }, io);
      io.table([col('workspace'), col('item'), col('kind')], rows, { sort: 2, empty: 'No lakehouses or warehouses.' });
      const kinds = new Map();
      for (const r of [...rows].sort(byColumns(3))) kinds.set(r[2], (kinds.get(r[2]) || 0) + 1);
      io.out(`\n${rows.length} item(s): ${[...kinds].map(([k, c]) => `${c} ${k}`).join(', ') || 'none'}${shortfall(gaps)}`);
    },

    async table([ws, item, name], opts, io) {
      const lh = await itemOf(ws, item, await look('items', [ws], opts));
      const t = await tableOf(lh, name);
      let m;
      if (opts.fresh) m = await onelake.table(lh, t, { fresh: true, onWait: io.note });
      else {
        const e = await onelake.cached.table(lh, t);
        if (!e) throw notCached(...IN_TREE.table(lh, t));
        opts.seen.push(e.at);
        m = { ...e.value, at: e.at, cached: true };
      }
      const s = m.stats || {};
      const num = v => (v == null ? null : Number(v));
      io.data({ rows: num(m.totalRecords), dataFiles: num(s.totalDataFiles), deleteFiles: num(s.totalDeleteFiles),
                bytes: num(s.totalFilesSize), lastWrite: iso(s.snapshotTs), partitionedBy: s.partitionColumns || [],
                lastOperation: s.operation || null, snapshots: num(s.snapshotCount), compression: s.codec || null,
                icebergFormat: num(s.formatVersion), metadataAsOf: iso(m.at), cached: !!m.cached });
      io.out(mdTable(['', ''], [
        ['rows', count(m.totalRecords)], ['data files', count(s.totalDataFiles)], ['delete files', count(s.totalDeleteFiles)],
        ['size (bytes)', count(s.totalFilesSize)], ['last write', s.snapshotTs ? new Date(s.snapshotTs).toISOString() : '—'],
        ['partitioned by', (s.partitionColumns || []).join(', ') || 'none'],
        ['last operation', s.operation || '—'], ['snapshots', count(s.snapshotCount)],
        ['compression', s.codec || '—'], ['Iceberg format', s.formatVersion != null ? `v${s.formatVersion}` : '—'],
        ['metadata as of', new Date(m.at).toISOString() + (m.cached ? ' (cached)' : '')],
      ]));
      io.out('');
      io.table([col('column'), col('type')], (m.schemaFields || []).map(f => [f.name, f.type]), { limit: Infinity });
    },

    async model([ws, name], opts, io) {
      const { fresh } = opts;
      let path = modelPath(ws, name);
      // A model not downloaded yet is an export from Fabric: only when asked for.
      if (!fresh && !await exists(path)) {
        throw Object.assign(new Error(`${ws}/${name} is not downloaded yet — open it in the OneLake Studio tree, ` +
          'or add --fresh to export it from Fabric now'), { notCached: true });
      }
      if (fresh) {
        if (!fetchModel) throw new Error('semantic models cannot be downloaded here');
        const m = await modelOf(ws, name, opts);
        io.note(`downloading ${ws}/${m.name} from Fabric…`);
        ({ path } = await fetchModel({ workspace: ws, model: m.name, modelId: m.id }));
        name = m.name;
      }
      const { semantic, compiler } = await modules();
      await syncViews(io.note);
      const text = await fsp.readFile(path, 'utf8');
      // Named by its workspace and its own name: semanticmodel.ws.model.
      const m = await semantic.registerModel(path.split(/[\\/]/).pop(), text, compiler, ws, name);
      // Kept as a semantic view, as the panel keeps a model it opens.
      await semviews.put(m.view, path, ws);
      defined.add(m.name.toLowerCase());
      io.data({ name: m.name, workspace: ws, model: name, path, directLake: m.directLake, example: m.sample });
      io.out(`# ${m.name} — semantic view of ${ws}/${name}, from ${path}\n`);
      io.out(`Query it as \`FROM ${m.name}\`; a measure is \`AGG("name")\`. Direct Lake tables: ${m.directLake}.\n`);
      const rels = ((m.bim.model && m.bim.model.relationships) || []).map(r =>
        [`${r.fromTable}[${r.fromColumn}]`, `${r.toTable}[${r.toColumn}]`, r.isActive !== false]);
      if (rels.length) {
        io.table([col('from', 'text', 'from (many)'), col('to', 'text', 'to (one)'), col('active', 'boolean', '', v => (v ? '' : 'inactive'))],
                 rels, { name: 'relationships', limit: Infinity });
        io.out('');
      }
      // dax-sql's own listings, trimmed to what reads well.
      const eng = await engine();
      const show = async (section, q, cols) => {
        const res = await eng.agentQuery((await semantic.statement(q, compiler)).sql, { signal: opts.signal });
        result({ ...res, fields: res.fields.filter(f => cols.includes(f.name)) }, io, { name: section, limit: Infinity });
      };
      io.out('## Dimensions\n');
      await show('dimensions', `SHOW SEMANTIC DIMENSIONS IN ${m.name}`, ['table_name', 'name', 'data_type', 'hidden']);
      io.out('\n## Metrics\n');
      await show('metrics', `SHOW SEMANTIC METRICS IN ${m.name}`, ['table_name', 'name', 'data_type', 'expression', 'format_string']);
      // The raw tables, as the engine names them: SQL that names one reads it as stored —
      // to check a measure against its fact table, with no lookup of which lakehouse it is.
      const raw = semantic.lakeTablesOf(m.name);
      if (raw.length) {
        io.out('\n## Raw tables\n');
        io.table([col('model_table', 'text', 'model table'), col('sql_name', 'text', 'in sql (raw, as stored)'),
                  col('onelake', 'text', 'OneLake (workspace/item GUIDs)')],
                 raw.map(r => [r.table, r.ident, `${r.lh.workspace}/${r.lh.item} ${r.schema}.${r.entity}`]),
                 { name: 'rawTables', limit: Infinity });
      }
      io.out(`\nExample:\n\n${m.sample}`);
    },

    async sql([text], opts, io) {
      const { semantic, compiler } = await modules();
      await syncViews(io.note);
      const t0 = Date.now();
      // A query: its lakehouse may be listed from OneLake when the cache does not have it.
      const [inWs, inItem] = opts.in ? String(opts.in).split('/') : [];
      const lhIn = opts.in ? await itemOf(inWs, inItem, await onelake.items(inWs)) : null;
      if (lhIn) text = filesToAbfss(text, lhIn);
      // A semantic model it names that is not a view yet: opened (its local copy, read from
      // Fabric the first time) and kept, as the panel does.
      for (const ref of semantic.unopenedModels(text)) {
        if (!openModel) throw new Error('semantic models cannot be opened here');
        const v = await openModel(ref);
        const m = await semantic.defineView(v.name, v.path, v.text, 'replace', compiler, v.schema);
        defined.add(m.name.toLowerCase());
      }
      const st = await semantic.statement(text, compiler);
      const run = st ? st.sql : text;
      if (st && opts.showSql) {
        io.data({ sql: st.sql });
        // Never into a --csv that will be parsed.
        if (opts.csv) io.note(st.sql); else io.out(`${fence('sql', st.sql)}\n`);
      }
      // Tables are named Kind.workspace.item.schema.table (`ls <ws> <item>` prints them), and
      // the engine opens each one a statement names as it runs it — a model's compiled SQL
      // names its Direct Lake tables the same way.
      const res = await (await engine()).agentQuery(run, { signal: opts.signal });
      // A --csv is everything it says it is: rows it would have to leave out fail it, since
      // nothing in a CSV can say so. --limit, or an aggregate, is what asks for less.
      const total = res.numRows != null ? res.numRows : res.rows.length;
      if (opts.csv && total > res.rows.length && !(opts.explicitLimit <= res.rows.length)) {
        throw new Error(`${total.toLocaleString('en')} rows, and a query keeps ${res.rows.length.toLocaleString('en')}: ` +
          'aggregate it, or ask for fewer with --limit');
      }
      result(res, io);
      io.note(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
    },

    // Export to Fabric from a shell: Explore's own export (extension.js), which asks in
    // VS Code where the local copy goes and waits for the OK there before it publishes. The
    // model is what Explore's button would export: a semantic model's .yaml, where the tree
    // wrote it in its lakehouse, or a model file in a lakehouse's Files/. With no Explore on
    // screen, the app opens on Explore's default view.
    async export([ws, a, b], opts, io) {
      if (!exportApp) throw new Error('Export to Fabric is not available here');
      const say = message => { io.data({ message }); io.out(message); };
      const { semantic } = await modules();
      if (!b) {
        // A semantic model: its local copy, which the export writes into its lakehouse.
        const m = await modelOf(ws, a, opts);
        const path = modelPath(ws, m.name);
        if (!await exists(path)) {
          throw Object.assign(new Error(`${ws}/${m.name} is not downloaded yet — open it in the OneLake Studio tree, ` +
            `or \`model "${ws}" "${m.name}" --fresh\``), { notCached: true, retry: `model "${ws}" "${m.name}" --fresh` });
        }
        const text = await fsp.readFile(path, 'utf8');
        say(await exportApp({ file: path.split(/[\\/]/).pop(), name: semantic.modelName(m.name), text, state: null,
                              model: { workspace: ws, name: m.name } }));
        return;
      }
      const lh = await itemOf(ws, a, await look('items', [ws], opts));
      if (!hasFilesArea(lh.item)) throw new Error(`${lh.item} has no Files area — only a lakehouse does`);
      const where = { workspace: lh.workspace, path: `${lh.item}/Files/${String(b).replace(/^\/?Files\//i, '')}` };
      const file = where.path.split('/').pop();
      const text = Buffer.from(await onelake.readBytes(where.workspace, where.path)).toString('utf8');
      say(await exportApp({ file, name: semantic.modelName(file), text, state: null,
                            workspace: where.workspace, path: where.path }));
    },
  };

  // An engine result, as one table: `numRows` is how many there were, whatever came back.
  function result(res, io, { name, limit } = {}) {
    io.table(res.fields.map(f => col(f.name, f.type)), res.rows.map(r => res.fields.map(f => r[f.name])), {
      name, limit, total: res.numRows != null ? res.numRows : res.rows.length,
      foot: (total, shown) => `\n${total.toLocaleString('en')} row(s)` + (total > shown ? `, first ${shown} shown` : ''),
    });
  }

  const usage = message => Object.assign(new Error(message), { usage: true });
  const unavailable = message => Object.assign(new Error(message), { unavailable: true });
  const exitOf = e => (e.usage ? EXIT.USAGE : e.unavailable || e.status === 401 ? EXIT.UNAVAILABLE
    : e.notCached ? EXIT.NOT_CACHED : e.declined ? EXIT.DECLINED : EXIT.FAILED);

  // One answer, written out once as Markdown, CSV or JSON, from the same raw tables. Nothing
  // reaches stdout until the command is done: a failure leaves none of it there.
  function createAnswer(command, { format, limit, explicitLimit }) {
    const parts = [];           // a line of prose, or a { table }
    const notes = [];
    const data = {};
    let complete = true, cachedAt = null;

    function written(t) {
      const max = format === 'csv' ? (explicitLimit ?? Infinity) : Math.min(t.limit ?? limit, explicitLimit ?? Infinity);
      const rows = t.sort ? [...t.rows].sort(byColumns(t.sort)) : t.rows;
      const shown = rows.slice(0, max);
      const total = t.total ?? rows.length;
      return { ...t, shown, total, truncated: total > shown.length };
    }
    function markdown(t) {
      const lines = [];
      if (t.rows.length || !t.empty) {
        const show = c => v => (c.show ? c.show(v) : v);
        lines.push(mdTable(t.cols.map(c => c.label), t.shown.map(r => r.map((v, i) => show(t.cols[i])(v)))));
      } else lines.push(t.empty);
      if (t.foot) lines.push(t.foot(t.total, t.shown.length));
      else if (t.truncated) lines.push(`\n(first ${t.shown.length} of ${t.total} shown — --limit N for more, --csv for all)`);
      return lines.join('\n');
    }
    const asJson = t => ({ columns: t.cols.map(c => ({ name: c.name, type: c.type })), rows: t.shown, total: t.total, truncated: t.truncated });

    return {
      out: s => parts.push(String(s)),
      note: s => notes.push(String(s)),
      table: (cols, rows, o = {}) => parts.push({ table: { cols, rows, ...o } }),
      data: o => Object.assign(data, o),
      incomplete: () => { complete = false; },
      seen: at => { cachedAt = iso(at); },
      done() {
        const tables = parts.filter(p => p.table).map(p => written(p.table));
        if (format === 'json') {
          const one = tables.length === 1 && !tables[0].name ? asJson(tables[0]) : {};
          const named = tables.filter(t => t.name);
          const body = { ok: true, command, ...one,
            ...(named.length ? { tables: Object.fromEntries(named.map(t => [t.name, asJson(t)])) } : {}),
            ...(Object.keys(data).length ? { data } : {}),
            truncated: tables.some(t => t.truncated), complete, cachedAt, notes };
          return { out: JSON.stringify(body), err: '', code: EXIT.OK };
        }
        if (format === 'csv') {
          const t = tables[0];
          if (t.truncated) notes.push(`first ${t.shown.length} of ${t.total} row(s) — --limit`);
          return { out: csvOf(t.cols.map(c => c.name), t.shown), err: notes.join('\n'), code: EXIT.OK };
        }
        let i = 0;
        const lines = parts.map(p => (p.table ? markdown(tables[i++]) : p));
        return { out: lines.join('\n'), err: notes.join('\n'), code: EXIT.OK };
      },
      failed(e) {
        const message = (e && e.message) || String(e);
        const code = exitOf(e || {});
        const retry = code === EXIT.NOT_CACHED ? (e.retry || '--fresh') : undefined;
        const hint = e && e.status === 401 ? ` — ${SIGN_IN_TO_FABRIC}` : '';
        if (format === 'json') return { out: failureJson(code, message + hint, { retry, notes }), err: '', code };
        return { out: '', err: [...notes, `error: ${message}${hint}`].join('\n'), code };
      },
    };
  }

  /** One request: { args: [command, ...], opts } -> { out, err, code }. `signal`: stop asking. */
  async function run({ args = [], opts = {} } = {}, { signal } = {}) {
    const [name, ...rest] = Array.isArray(args) ? args.map(String) : [];
    const format = opts.json ? 'json' : opts.csv ? 'csv' : 'md';
    const explicitLimit = opts.limit != null && Number(opts.limit) > 0 ? Number(opts.limit) : undefined;
    const answer = createAnswer(name, { format, limit: explicitLimit ?? 100, explicitLimit });
    const seen = [];   // when each cached answer was stored (look())
    try {
      const wrong = checkRequest({ args, opts });
      if (wrong) throw usage(wrong);
      if (!signedIn()) throw unavailable('OneLake Studio is not signed in — sign in from its view in VS Code.');
      await commands[name](rest, {
        fresh: !!opts.fresh, csv: !!opts.csv, json: !!opts.json, in: opts.in ? String(opts.in) : '',
        explicitLimit, showSql: !!opts.showSql, seen, signal,
      }, answer);
      // An answer off disk says how old it is: the oldest listing it was made of.
      if (seen.length) {
        const oldest = Math.min(...seen);
        answer.seen(oldest);
        answer.note(`from the cache, as of ${ago(oldest)} — --fresh reads OneLake/Fabric again`);
      }
      return answer.done();
    } catch (e) {
      return answer.failed(e);
    }
  }

  // modules(): the compiler, for the extension's own uses of it too (Export to Fabric).
  return { run, modules };
}

module.exports = { createAgent, filesToAbfss };
