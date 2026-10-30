'use strict';
// =============================================================================
// agent.js — the questions an agent asks, answered by the extension itself
// =============================================================================
// cli.mjs is only a doorbell: it hands its arguments to the running extension (bridge.js)
// and prints what comes back. The answer is made here, with what the extension already
// has — its sign-in, its cache-first OneLake (onelake.js), the Fabric API, the downloaded
// .bim files, the DAX compiler — so there is one sign-in and one cache, not a second copy
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

const { join, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const fsp = require('node:fs/promises');
const { fmtBytes, hasFilesArea, kindLabel, sqlNameOf, abfssUrl, stripBom } = require('./names');
const { mapPool } = require('./http');

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
 * @param {{ getBim(ws: string, id: string): Promise<Uint8Array> }} o.fabric
 * @param {() => Promise<object>} o.engine   the extension's engine (engine-host.js)
 * @param {(ws: string, model: string) => string} o.bimPath  where a model's .bim is downloaded
 * @param {string} o.appDir                  the panel's modules (semantic.js, paths.js)
 * @param {string} o.vendorDir               the vendored DAX compiler and YAML reader
 * @param {ReturnType<import('./semviews').createSemViews>} o.semviews  the views this machine keeps
 * @param {(x: object) => Promise<string>} [o.exportApp]  Explore's Export to Fabric (extension.js)
 * @param {(n: {workspace: string, model: string, modelId: string}) => Promise<{path: string, text: string}>} [o.fetchModel]
 *   a semantic model's definition read from Fabric again, into its local copy (bimPath)
 * @param {(x: {workspace: string, model: string}) => Promise<object>} [o.openModel]
 *   a semantic model a query names, opened from its local copy and kept as a view
 */
function createAgent({ onelake, fabric, engine, bimPath, appDir, vendorDir, daxSqlPin, yamlPin, semviews,
                       exportApp = null, fetchModel = null, openModel = null, nameTables = null }) {
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
                         ossieToTmsl: o.ossieToTmsl, parseYaml: y.parse } };
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

  // A downloaded model, read from its .bim on disk: how many tables and measures, and their
  // names with their columns — for `models` and `find`. Null when it does not parse.
  async function bimSummary(path) {
    try {
      const bim = JSON.parse(stripBom(await fsp.readFile(path, 'utf8')));
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
  // with --fresh it is one OneLake or Fabric call per workspace, so a few run at a time. A
  // workspace whose listing is not cached, or cannot be read, is counted and named in a
  // note rather than ending the answer: { missing, failed }.
  async function eachWorkspace(ws, opts, fn, note) {
    const list = ws ? [ws] : await look('workspaces', [], opts);
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
    if (unauthorised) note('expand "Semantic models" in the OneLake tree once to sign in to Fabric');
    return { missing: missing.length, failed };
  }
  const shortfall = ({ missing, failed }) =>
    (missing ? `; ${missing} workspace(s) not cached` : '') + (failed ? `; ${failed} could not be read` : '');
  // Workspaces answer in any order: rows are sorted by workspace, then name.
  const byFirst = (a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]));
  // --csv is everything; a table is the first --limit rows, and says so.
  const grid = (cols, rows, { csv, limit = 100 }) => {
    const sorted = [...rows].sort(byFirst);
    if (csv) return csvOf(cols, sorted);
    return mdTable(cols, sorted.slice(0, limit)) +
      (sorted.length > limit ? `\n\n(first ${limit} of ${sorted.length} shown — --limit N for more, --csv for all)` : '');
  };

  // ---------------------------------------------------------------------------
  const commands = {
    async ls([ws, item], opts, out, note) {
      if (!ws) {
        out(mdTable(['workspace'], (await look('workspaces', [], opts)).map(w => [w])));
        return;
      }
      if (!item) {
        // Either half may be cached without the other: each says so on its own.
        let shown = 0;
        try {
          out(mdTable(['item', 'kind'], (await look('items', [ws], opts)).map(i => [i.name, i.kind])));
          shown++;
        } catch (e) { if (!e.notCached) throw e; note(e.message); }
        try {
          const rows = [];
          for (const m of await look('models', [ws], opts)) {
            rows.push([m.name, await exists(bimPath(ws, m.name)) ? 'downloaded' : '', m.description]);
          }
          out((shown ? '\n' : '') + (rows.length ? mdTable(['semantic model', '', 'description'], rows) : 'No semantic models.'));
          shown++;
        } catch (e) {
          if (e.notCached) note(e.message);
          else note(`semantic models not listed: ${e.message}` +
            (e.status === 401 ? ' — expand "Semantic models" in the OneLake tree once to sign in to Fabric' : ''));
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
          m && m.totalRecords != null ? Number(m.totalRecords).toLocaleString('en') : '—',
          size(s.totalFilesSize), s.totalDataFiles != null ? s.totalDataFiles : '—', when(s.snapshotTs)]);
      }
      out(grid(['table', 'in sql', 'rows', 'size', 'files', 'last write (UTC)'], rows, opts));
      if (!opts.csv) out(`\n${tables.length} table(s), ${known} with metadata cached` +
        (known < tables.length ? ' — open the rest in the tree for their sizes' : ''));
    },

    // A lakehouse's Files/ — the listing the tree read when that folder was expanded.
    async files([ws, item, dir = ''], opts, out) {
      if (!item) throw new Error('usage: files <ws> <item> [<dir>]');
      const lh = await itemOf(ws, item, await look('items', [ws], opts));
      if (!hasFilesArea(lh.item)) throw new Error(`${lh.item} has no Files area — only a lakehouse does`);
      const d = String(dir).replace(/^\/?Files\/?/i, '').replace(/\/+$/, '');
      const entries = await look('files', [lh, d], opts);
      out(entries.length
        ? grid(['name', '', 'size'], entries.map(e => [e.name, e.isDir ? 'folder' : 'file', e.isDir ? '' : size(e.bytes)]), opts)
        : `Files/${d} is empty.`);
      if (opts.csv) return;
      const n = entries.filter(e => !e.isDir);
      out(`\n${n.length} file(s), ${entries.length - n.length} folder(s), ${size(n.reduce((a, e) => a + (e.bytes || 0), 0))}` +
          ` in Files/${d}`);
    },

    // Every name the cache knows that contains `text` — never fetched, so what has not been
    // opened in the tree is not searched, and the answer says how much that is.
    async find([text], opts, out, note) {
      if (!text) throw new Error('usage: find <text>');
      const q = String(text).toLowerCase();
      const has = s => String(s || '').toLowerCase().includes(q);
      const rows = [];
      const unseen = { workspaces: 0, items: 0 };
      const ws = await onelake.cached.workspaces();
      if (!ws) throw notCached(...IN_TREE.workspaces);
      opts.seen.push(ws.at);
      for (const w of ws.value) {
        if (has(w)) rows.push(['workspace', '', w]);
        const items = await onelake.cached.items(w);
        if (!items) unseen.workspaces++;
        for (const it of (items && items.value) || []) {
          if (has(it.name)) rows.push([it.kind.toLowerCase(), w, it.name]);
          const lh = { workspace: w, item: it.name };
          const tables = await onelake.cached.tables(lh);
          if (!tables) { unseen.items++; continue; }
          for (const t of tables.value) {
            const tn = t.schema ? `${t.schema}.${t.table}` : t.table;
            if (has(t.table)) rows.push(['table', `${w}/${it.name}`, tn]);
            const meta = await onelake.cached.table(lh, t);
            for (const f of (meta && meta.value.schemaFields) || []) {
              if (has(f.name)) rows.push(['column', `${w}/${it.name} ${tn}`, `${f.name} (${f.type})`]);
            }
          }
        }
        const models = await onelake.cached.models(w);
        for (const m of (models && models.value) || []) {
          if (has(m.name) || has(m.description)) rows.push(['semantic model', w, m.name]);
          const path = bimPath(w, m.name);
          const b = await exists(path) ? await bimSummary(path) : null;
          for (const t of (b && b.tables) || []) {
            const where = `${w}/${m.name}`;
            if (has(t.name)) rows.push(['model table', where, t.name]);
            for (const c of t.columns) if (has(c)) rows.push(['model column', where, `${t.name}[${c}]`]);
            for (const x of t.measures) if (has(x)) rows.push(['measure', where, `[${x}] in ${t.name}`]);
          }
        }
      }
      const shown = rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
      if (opts.csv) { out(csvOf(['kind', 'where', 'name'], shown)); return; }
      out(shown.length ? mdTable(['kind', 'where', 'name'], shown.slice(0, opts.limit)) : `Nothing cached contains "${text}".`);
      out(`\n${shown.length} match(es)` + (shown.length > opts.limit ? `, first ${opts.limit} shown` : ''));
      const gaps = [unseen.workspaces && `the items of ${unseen.workspaces} workspace(s)`,
                    unseen.items && `the tables of ${unseen.items} item(s)`].filter(Boolean);
      if (gaps.length) note(`not searched, not cached yet: ${gaps.join(' and ')} — expand them in the OneLake Studio tree`);
    },

    // Every workspace's semantic models, or one workspace's, counted.
    async models([ws], opts, out, note) {
      const rows = [];
      const gaps = await eachWorkspace(ws, opts, async w => {
        for (const m of await look('models', [w], opts)) {
          // A downloaded model says what is in it, from its .bim on disk.
          const path = bimPath(w, m.name);
          const b = await exists(path) ? await bimSummary(path) : null;
          rows.push([w, m.name, b ? 'downloaded' : '', b ? b.tables.length : '', b ? b.measures : '', m.description]);
        }
      }, note);
      const n = new Set(rows.map(r => r[0])).size;
      out(rows.length ? grid(['workspace', 'semantic model', '', 'tables', 'measures', 'description'], rows, opts)
                      : 'No semantic models.');
      if (!opts.csv) out(`\n${rows.length} semantic model(s) in ${n} workspace(s)${shortfall(gaps)}`);
    },

    // Every workspace's lakehouses and warehouses, or one workspace's, counted by kind.
    async items([ws], opts, out, note) {
      const rows = [];
      const gaps = await eachWorkspace(ws, opts, async w => {
        for (const i of await look('items', [w], opts)) rows.push([w, i.name, kindLabel(i.kind)]);
      }, note);
      out(rows.length ? grid(['workspace', 'item', 'kind'], rows, opts) : 'No lakehouses or warehouses.');
      if (opts.csv) return;
      const kinds = new Map();
      for (const r of rows) kinds.set(r[2], (kinds.get(r[2]) || 0) + 1);
      out(`\n${rows.length} item(s): ${[...kinds].map(([k, c]) => `${c} ${k}`).join(', ') || 'none'}${shortfall(gaps)}`);
    },

    async table([ws, item, name], opts, out, note) {
      if (!name) throw new Error('usage: table <ws> <item> <schema.table>');
      const lh = await itemOf(ws, item, await look('items', [ws], opts));
      const t = await tableOf(lh, name);
      let m;
      if (opts.fresh) m = await onelake.table(lh, t, { fresh: true, onWait: note });
      else {
        const e = await onelake.cached.table(lh, t);
        if (!e) throw notCached(...IN_TREE.table(lh, t));
        opts.seen.push(e.at);
        m = { ...e.value, at: e.at, cached: true };
      }
      const s = m.stats || {};
      const n = v => (v == null ? '—' : Number(v).toLocaleString('en'));
      out(mdTable(['', ''], [
        ['rows', n(m.totalRecords)], ['data files', n(s.totalDataFiles)], ['delete files', n(s.totalDeleteFiles)],
        ['size (bytes)', n(s.totalFilesSize)], ['last write', s.snapshotTs ? new Date(s.snapshotTs).toISOString() : '—'],
        ['partitioned by', (s.partitionColumns || []).join(', ') || 'none'],
        ['last operation', s.operation || '—'], ['snapshots', n(s.snapshotCount)],
        ['compression', s.codec || '—'], ['Iceberg format', s.formatVersion != null ? `v${s.formatVersion}` : '—'],
        ['metadata as of', new Date(m.at).toISOString() + (m.cached ? ' (cached)' : '')],
      ]));
      out('\n' + mdTable(['column', 'type'], (m.schemaFields || []).map(f => [f.name, f.type])));
    },

    async model([ws, name], opts, out, note) {
      const { fresh } = opts;
      if (!name) throw new Error('usage: model <ws> <model>');
      let path = bimPath(ws, name);
      // A model not downloaded yet is an export from Fabric: only when asked for.
      if (!fresh && !await exists(path)) {
        throw Object.assign(new Error(`${ws}/${name} is not downloaded yet — open it in the OneLake Studio tree, ` +
          'or add --fresh to export it from Fabric now'), { notCached: true });
      }
      if (fresh) {
        const m = await modelOf(ws, name, opts);
        note(`downloading ${ws}/${m.name} from Fabric…`);
        if (fetchModel) ({ path } = await fetchModel({ workspace: ws, model: m.name, modelId: m.id }));
        else {
          path = bimPath(ws, m.name);
          await fsp.mkdir(dirname(path), { recursive: true });
          await fsp.writeFile(path, await fabric.getBim(ws, m.id));
        }
        name = m.name;
      }
      const { semantic, compiler } = await modules();
      await syncViews(note);
      const text = await fsp.readFile(path, 'utf8');
      const bim = JSON.parse(stripBom(text));
      // Named by its workspace and its own name: semanticmodel.ws.model.
      const m = await semantic.registerModel(path.split(/[\\/]/).pop(), text, compiler, ws, name);
      // Kept as a semantic view, as the panel keeps a model it opens.
      await semviews.put(m.view, path, ws);
      defined.add(m.name.toLowerCase());
      out(`# ${m.name} — semantic view of ${ws}/${name}, from ${path}\n`);
      out(`Query it as \`FROM ${m.name}\`; a measure is \`AGG("name")\`. Direct Lake tables: ${m.directLake}.\n`);
      const rels = ((bim.model && bim.model.relationships) || []).map(r =>
        [`${r.fromTable}[${r.fromColumn}]`, `${r.toTable}[${r.toColumn}]`, r.isActive === false ? 'inactive' : '']);
      if (rels.length) out(mdTable(['from (many)', 'to (one)', ''], rels) + '\n');
      // dax-sql's own listings, trimmed to what reads well.
      const eng = await engine();
      const show = async (q, cols) => {
        const res = await eng.agentQuery((await semantic.statement(q, compiler)).sql);
        result({ ...res, fields: res.fields.filter(f => cols.includes(f.name)) }, { limit: 1e6 }, out);
      };
      out('## Dimensions\n');
      await show(`SHOW SEMANTIC DIMENSIONS IN ${m.name}`, ['table_name', 'name', 'data_type', 'hidden']);
      out('\n## Metrics\n');
      await show(`SHOW SEMANTIC METRICS IN ${m.name}`, ['table_name', 'name', 'data_type', 'expression', 'format_string']);
      // The raw tables, as the engine names them: SQL that names one reads it as stored —
      // to check a measure against its fact table, with no lookup of which lakehouse it is.
      const raw = semantic.lakeTablesOf(m.name);
      if (raw.length) {
        out('\n## Raw tables\n');
        out(mdTable(['model table', 'in sql (raw, as stored)', 'OneLake (workspace/item GUIDs)'],
          raw.map(r => [r.table, r.ident, `${r.lh.workspace}/${r.lh.item} ${r.schema}.${r.entity}`])));
      }
      out(`\nExample:\n\n${m.sample}`);
    },

    async sql([text], opts, out, note) {
      if (!text) throw new Error('usage: sql "<query>"');
      const { semantic, compiler } = await modules();
      await syncViews(note);
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
      if (st && opts.showSql) out(`${fence('sql', st.sql)}\n`);
      // Tables are named Kind.workspace.item.schema.table (`ls <ws> <item>` prints them), and
      // the engine opens each one a statement names as it runs it — a model's compiled SQL
      // names its Direct Lake tables the same way.
      result(await (await engine()).agentQuery(run), opts, out);
      note(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
    },

    // Export to Fabric from a shell: Explore's own export (extension.js), which asks in
    // VS Code where the local copy goes and waits for the OK there before it publishes. The
    // model is what Explore's button would export: a semantic model's .bim, where the tree
    // wrote it in its lakehouse, or a model file in a lakehouse's Files/. With no Explore on
    // screen, the app opens on Explore's default view.
    async export([ws, a, b], opts, out) {
      if (!exportApp) throw new Error('Export to Fabric is not available here');
      if (!a) throw new Error('usage: export <ws> <model>, or export <ws> <item> <Files/path>');
      const { semantic } = await modules();
      if (!b) {
        // A semantic model: its local copy, which the export writes into its lakehouse.
        const m = await modelOf(ws, a, opts);
        const path = bimPath(ws, m.name);
        if (!await exists(path)) {
          throw new Error(`${ws}/${m.name} is not downloaded yet — open it in the OneLake Studio tree, ` +
            `or \`model "${ws}" "${m.name}" --fresh\``);
        }
        const text = await fsp.readFile(path, 'utf8');
        out(await exportApp({ file: path.split(/[\\/]/).pop(), name: semantic.modelName(m.name), text, state: null,
                              model: { workspace: ws, name: m.name } }));
        return;
      }
      const lh = await itemOf(ws, a, await look('items', [ws], opts));
      if (!hasFilesArea(lh.item)) throw new Error(`${lh.item} has no Files area — only a lakehouse does`);
      const where = { workspace: lh.workspace, path: `${lh.item}/Files/${String(b).replace(/^\/?Files\//i, '')}` };
      const file = where.path.split('/').pop();
      const text = Buffer.from(await onelake.readBytes(where.workspace, where.path)).toString('utf8');
      out(await exportApp({ file, name: semantic.modelName(file), text, state: null,
                            workspace: where.workspace, path: where.path }));
    },
  };

  function result(res, { limit = 100, csv = false } = {}, out) {
    const cols = res.fields.map(f => f.name);
    const rows = res.rows.map(r => cols.map(c => r[c]));
    if (csv) { out(csvOf(cols, rows)); return; }
    out(mdTable(cols, rows.slice(0, limit)));
    const n = res.numRows != null ? res.numRows : rows.length;
    const shown = Math.min(limit, rows.length);
    out(`\n${n.toLocaleString('en')} row(s)` + (n > shown ? `, first ${shown} shown` : ''));
  }

  /** One request: { args: [command, ...], opts } -> { out, err, code }. */
  async function run({ args = [], opts = {} } = {}) {
    const outLines = [], errLines = [];
    const out = s => outLines.push(String(s));
    const note = s => errLines.push(String(s));
    const [name, ...rest] = Array.isArray(args) ? args.map(String) : [];
    const cmd = Object.hasOwn(commands, name) ? commands[name] : null;
    if (!cmd) return { out: '', err: `unknown command: ${name || '(none)'} — ls, models, items, files, find, table, model, sql or export`, code: 1 };
    const seen = [];   // when each cached answer was stored (look())
    try {
      await cmd(rest, {
        fresh: !!opts.fresh, csv: !!opts.csv, in: opts.in ? String(opts.in) : '',
        limit: Number(opts.limit) > 0 ? Number(opts.limit) : 100,
        showSql: !!opts.showSql, seen,
      }, out, note);
      // An answer off disk says how old it is: the oldest listing it was made of.
      if (seen.length) note(`from the cache, as of ${ago(Math.min(...seen))} — --fresh reads OneLake/Fabric again`);
      return { out: outLines.join('\n'), err: errLines.join('\n'), code: 0 };
    } catch (e) {
      errLines.push(`error: ${(e && e.message) || e}`);
      return { out: outLines.join('\n'), err: errLines.join('\n'), code: 1 };
    }
  }

  // modules(): the compiler, for the extension's own uses of it too (Export to Fabric).
  return { run, modules };
}

module.exports = { createAgent, filesToAbfss };
