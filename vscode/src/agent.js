'use strict';
// =============================================================================
// agent.js — the questions an agent asks, answered by the extension itself
// =============================================================================
// cli.mjs is only a doorbell: it hands its arguments to the running extension (bridge.js)
// and prints what comes back. The answer is made here, with what the extension already
// has — its sign-in, its cache-first OneLake (onelake.js), the Fabric API, the downloaded
// .bim files, the DAX compiler — so there is one sign-in and one cache, not a second copy
// for the command line. Read only: every statement goes through the engine's guard.
//
//   screen [--rerun]                 what the panel shows (onscreen.js's files); --rerun runs it again
//   ls [<ws> [<item>]]               workspaces / items + semantic models / tables
//   table <ws> <item> <schema.table> metadata only
//   model <ws> <model>               relationships, columns, measures with DAX
//   sql "<sql>" [--in <ws>/<item>]   a semantic view is a table, AGG("m") its measure m; and
//                                    CREATE / DROP / SHOW SEMANTIC VIEW (dax-sql's statements);
//                                    --in also reads its 'Files/…' paths; --show-sql the compiled SQL
//   dax "EVALUATE …" [--model m]     a DAX query, compiled as Explore compiles one
//
// No `vscode` import: the extension passes in what it owns.
// =============================================================================

const { join, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const fsp = require('node:fs/promises');

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

// A lakehouse table's schema in agent SQL: data.Lakehouse's mart.x is data_mart.x.
const sqlSchema = (lh, t) =>
  `${lh.item.replace(/\.[^.]+$/, '')}_${t.schema || 'main'}`.replace(/[^A-Za-z0-9_]/g, '_');

const DFS_HOST = 'onelake.dfs.fabric.microsoft.com';
const sqlLit = s => `'${String(s).replace(/'/g, "''")}'`;
const quoteId = s => `"${String(s).replace(/"/g, '""')}"`;
const fence = (lang, text) => '```' + lang + '\n' + String(text).trim() + '\n```';

// 'Files/x.parquet' in SQL run --in a lakehouse is that lakehouse's file, by its abfss:// name:
// the engine reads OneLake, never the local disk (its lockdown refuses a relative path).
function filesToAbfss(sql, lh) {
  const ws = String(lh.workspace).replace(/'/g, "''");
  const item = String(lh.item).replace(/'/g, "''");
  return String(sql).replace(/'\/?(Files\/(?:[^']|'')*)'/g, (_, p) => `'abfss://${ws}@${DFS_HOST}/${item}/${p}'`);
}

// `sql` with `ident` bound to `body` for this one statement — a CTE, merged into the
// statement's own WITH when it has one — so a panel view can be re-read with no view made.
function withView(sql, ident, body) {
  const text = String(sql).trim().replace(/;\s*$/, '');
  const cte = `${ident} AS (${body})`;
  const m = /^WITH(\s+RECURSIVE)?\s+/i.exec(text);
  return m ? `${m[0]}${cte}, ${text.slice(m[0].length)}` : `WITH ${cte}\n${text}`;
}

// The panel's SQL names a table "schema"."table"; the command line's --in names it
// item_schema.table. Both spellings, quoted or bare, are rewritten.
function panelToAgentSql(sql, lh, t) {
  const to = `${sqlSchema(lh, t)}.${quoteId(t.table)}`;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const s = esc(t.schema || 'dbo'), n = esc(t.table);
  return String(sql).replace(new RegExp(`(^|[^\\w"])"?${s}"?\\s*\\.\\s*"?${n}"?(?![\\w"])`, 'gi'), (_, pre) => pre + to);
}

/**
 * @param {object} o
 * @param {ReturnType<import('./onelake').createOneLake>} o.onelake
 * @param {{ getBim(ws: string, id: string): Promise<Uint8Array> }} o.fabric
 * @param {() => Promise<object>} o.engine   the extension's engine (engine-host.js)
 * @param {(ws: string, model: string) => string} o.bimPath  where a model's .bim is downloaded
 * @param {string} o.appDir                  the panel's modules (semantic.js, paths.js)
 * @param {string} o.vendorDir               the vendored DAX compiler
 * @param {ReturnType<import('./semviews').createSemViews>} o.semviews  the views this machine keeps
 */
function createAgent({ onelake, fabric, engine, bimPath, appDir, vendorDir, daxSqlPin, semviews, screenDir = null }) {
  let mods = null;
  async function modules() {
    if (mods) return mods;
    const load = p => import(pathToFileURL(p).href);
    const [paths, semantic, c, t] = await Promise.all([
      load(join(appDir, 'paths.js')), load(join(appDir, 'semantic.js')),
      load(join(vendorDir, 'gh', daxSqlPin, 'src', 'index.js')),
      load(join(vendorDir, 'gh', daxSqlPin, 'formats', 'tmsl.js')),
    ]);
    mods = { paths, semantic,
             compiler: { createCompiler: c.createCompiler, createViews: c.createViews, tmslToModel: t.tmslToModel } };
    return mods;
  }

  const exists = p => fsp.stat(p).then(() => true, () => false);

  async function itemOf(ws, name) {
    const items = await onelake.items(ws);
    const lc = String(name).toLowerCase();
    const hit = items.find(i => i.name.toLowerCase() === lc) ||
                items.find(i => i.name.toLowerCase().replace(/\.[^.]+$/, '') === lc);
    if (!hit) throw new Error(`no item "${name}" in ${ws} — \`ls ${ws}\` lists them`);
    return { workspace: ws, item: hit.name };
  }

  async function modelOf(ws, name) {
    const hit = (await onelake.models(ws)).find(m => m.name.toLowerCase() === String(name).toLowerCase());
    if (!hit) throw new Error(`no semantic model "${name}" in ${ws} — \`ls ${ws}\` lists them`);
    return hit;
  }

  // The views the extension keeps (semviews.js), defined in dax-sql's registry — the same
  // list the panel has, so a view made in either is named in both.
  const defined = new Set();
  async function syncViews(note) {
    const { semantic, compiler } = await modules();
    const kept = await semviews.texts();
    for (const v of kept) {
      try {
        if (v.error) throw new Error(v.error);
        await semantic.defineView(v.name, v.path, v.text, 'replace', compiler);
        defined.add(v.name.toLowerCase());
      } catch (e) { note(`semantic view ${v.name} skipped: ${e.message}`); }
    }
    const names = new Set(kept.map(v => v.name.toLowerCase()));
    for (const n of [...defined]) if (!names.has(n)) { semantic.dropView(n); defined.delete(n); }
  }

  // A table as a view, exactly as the panel opens one (data.js openTableView): iceberg_scan
  // over the metadata file the cache holds.
  async function openView(lh, t, ident, note) {
    const { paths } = await modules();
    const eng = await engine();
    const meta = await onelake.table(lh, t, { onWait: note });
    const schema = ident.includes('"."') ? ident.slice(0, ident.indexOf('"."') + 1) : null;
    if (schema) await eng.agentQuery(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    const body = meta.empty ? paths.emptyTableSql(meta.schemaFields)
      : `SELECT * FROM ${(await eng.openTable({ metadataLocation: meta.metadataLocation })).ident}`;
    await eng.agentQuery(`CREATE OR REPLACE VIEW ${ident} AS ${body}`);
  }

  // What the panel shows (onscreen.js), from every window's file: the newest one.
  async function screenState() {
    if (!screenDir) return null;
    let best = null;
    for (const name of await fsp.readdir(screenDir).catch(() => [])) {
      if (!/^panel-\d+\.json$/.test(name)) continue;
      try {
        const s = JSON.parse(await fsp.readFile(join(screenDir, name), 'utf8'));
        if (!best || String(s.updated) > String(best.updated)) best = s;
      } catch (_) { /* half-written or gone: the next one */ }
    }
    return best;
  }

  // Which view a DAX query is about: --model, else the model on screen, else the only one.
  async function viewFor(opts) {
    if (opts.model) return opts.model;
    const s = await screenState();
    if (s && s.open && s.open.kind === 'model' && s.open.name) return s.open.name;
    if (defined.size === 1) return [...defined][0];
    throw new Error('which model? — add --model <name> (`sql "SHOW SEMANTIC VIEWS"` lists them)');
  }

  // A sample as a table, and how much of the result it is.
  function sampleOut(x, out) {
    if (!x || !Array.isArray(x.fields) || !Array.isArray(x.sample)) return;
    out(mdTable(x.fields, x.sample.map(r => x.fields.map(f => r[f]))));
    const n = x.rows != null ? x.rows : x.sample.length;
    out(`\n${Number(n).toLocaleString('en')} row(s)` +
        (n > x.sample.length ? `, first ${x.sample.length} saved — \`screen --rerun\` reads them all` : ''));
  }

  // ---------------------------------------------------------------------------
  const commands = {
    // What the panel shows, read from its file, and with --rerun the whole result of it.
    async screen(_, opts, out, note) {
      const s = await screenState();
      if (!s || !s.open) { out('Nothing is open in the OneLake Studio panel.'); return; }
      const o = s.open;
      const where = o.kind === 'table' ? `table ${o.workspace}/${o.item} ${o.schema ? `${o.schema}.` : ''}${o.table}`
        : o.kind === 'file' ? `file ${o.workspace}/${o.path}`
        : `semantic model ${o.name}` + (o.workspace ? ` (${o.workspace}/${o.model})` : '');
      const m = s.model || {};
      const front = o.kind !== 'model' ? 'query' : m.page === 'explore' ? 'explore' : m.page === 'sql' ? 'sql' : null;
      if (opts.rerun) {
        if (front === 'explore' && m.explore && m.explore.dax) {
          note(`re-running Explore's DAX on ${o.name}`);
          return commands.dax([m.explore.dax], { ...opts, model: o.name }, out, note);
        }
        if (front === 'sql' && m.sql && m.sql.sql) return commands.sql([m.sql.sql], opts, out, note);
        const q = s.query;
        if (front !== 'query' || !q || !q.sql) throw new Error(`nothing to re-run: the ${front || 'model'} page has run nothing`);
        const { semantic, compiler, paths } = await modules();
        await syncViews(note);
        if (await semantic.statement(q.sql, compiler)) return commands.sql([q.sql], opts, out, note);
        if (o.kind === 'table') {
          const lh = { workspace: o.workspace, item: o.item };
          const t = { schema: o.schema, table: o.table };
          return commands.sql([panelToAgentSql(q.sql, lh, t)], { ...opts, in: `${o.workspace}/${o.item}` }, out, note);
        }
        const reader = paths.readerFor(paths.fileExt(o.path));
        if (!q.ident || !reader) throw new Error(`${o.path}: only a tabular file's query can be re-run here`);
        const url = paths.abfssUrl(o.workspace, o.path);
        return commands.sql([withView(paths.stripComments(q.sql), q.ident, `SELECT * FROM ${reader(sqlLit(url))}`)], opts, out, note);
      }
      out(`# On screen: ${where}\n`);
      if (o.cli) out(`Reach it with: ${Object.values(o.cli).map(c => `\`${c}\``).join(', ')}\n`);
      if (o.kind === 'model') {
        out(`Page in front: ${m.page || 'model'}\n`);
        if (m.explore && m.explore.dax) {
          out(`## Explore${front === 'explore' ? ' (in front)' : ''}\n\n${fence('dax', m.explore.dax)}\n`);
          if (m.explore.error) out(`error: ${m.explore.error}\n`);
          sampleOut(m.explore, out);
          out('');
        }
        if (m.sql && m.sql.sql) {
          out(`## SQL page${front === 'sql' ? ' (in front)' : ''}\n\n${fence('sql', m.sql.sql)}\n`);
          if (m.sql.error) out(`error: ${m.sql.error}\n`);
          sampleOut(m.sql, out);
        }
        return;
      }
      if (!s.query) { out('No query has run on it yet.'); return; }
      out(`## Last query${s.query.ms != null ? ` (${s.query.ms} ms)` : ''}\n\n${fence('sql', s.query.sql || '')}\n`);
      if (s.query.error) { out(`error: ${s.query.error}`); return; }
      sampleOut(s.query, out);
    },

    // A DAX query, as Explore runs one: compiled by dax-sql against a semantic view.
    async dax([text], opts, out, note) {
      if (!text) throw new Error('usage: dax "EVALUATE …" [--model <name>]');
      const { semantic } = await modules();
      await syncViews(note);
      const name = await viewFor(opts);
      const t0 = Date.now();
      const c = semantic.compileDax(name, text);
      if (opts.showSql) out(`${fence('sql', c.sql)}\n`);
      for (const x of c.tables) await openView(x.lh, x.t, x.ident, note);
      result(await (await engine()).agentQuery(c.sql), opts, out);
      note(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
    },

    async ls([ws, item], { fresh }, out, note) {
      if (!ws) {
        out(mdTable(['workspace'], (await onelake.workspaces({ fresh })).map(w => [w])));
        return;
      }
      if (!item) {
        out(mdTable(['item', 'kind'], (await onelake.items(ws, { fresh })).map(i => [i.name, i.kind])));
        try {
          const rows = [];
          for (const m of await onelake.models(ws, { fresh })) {
            rows.push([m.name, await exists(bimPath(ws, m.name)) ? 'downloaded' : '', m.description]);
          }
          out('\n' + (rows.length ? mdTable(['semantic model', '', 'description'], rows) : 'No semantic models.'));
        } catch (e) {
          note(`semantic models not listed: ${e.message}` +
            (e.status === 401 ? ' — expand "Semantic models" in the OneLake tree once to sign in to Fabric' : ''));
        }
        return;
      }
      const lh = await itemOf(ws, item);
      const tables = await onelake.tables(lh, { fresh });
      out(mdTable(['table', `in sql --in ${ws}/${item}`],
        tables.map(t => [t.schema ? `${t.schema}.${t.table}` : t.table, `${sqlSchema(lh, t)}.${t.table}`])));
    },

    async table([ws, item, name], { fresh }, out, note) {
      if (!name) throw new Error('usage: table <ws> <item> <schema.table>');
      const lh = await itemOf(ws, item);
      const dot = name.indexOf('.');
      const t = dot > 0 ? { schema: name.slice(0, dot), table: name.slice(dot + 1) } : { schema: 'dbo', table: name };
      const m = await onelake.table(lh, t, { fresh, onWait: note });
      const s = m.stats || {};
      const n = v => (v == null ? '—' : Number(v).toLocaleString('en'));
      out(mdTable(['', ''], [
        ['rows', n(m.totalRecords)], ['data files', n(s.totalDataFiles)], ['delete files', n(s.totalDeleteFiles)],
        ['size (bytes)', n(s.totalFilesSize)], ['last write', s.snapshotTs ? new Date(s.snapshotTs).toISOString() : '—'],
        ['partitioned by', (s.partitionColumns || []).join(', ') || 'none'],
        ['metadata as of', new Date(m.at).toISOString() + (m.cached ? ' (cached)' : '')],
      ]));
      out('\n' + mdTable(['column', 'type'], (m.schemaFields || []).map(f => [f.name, f.type])));
    },

    async model([ws, name], { fresh }, out, note) {
      if (!name) throw new Error('usage: model <ws> <model>');
      let path = bimPath(ws, name);
      if (fresh || !await exists(path)) {
        const m = await modelOf(ws, name);
        path = bimPath(ws, m.name);
        note(`downloading ${ws}/${m.name} from Fabric…`);
        const bytes = await fabric.getBim(ws, m.id);
        await fsp.mkdir(dirname(path), { recursive: true });
        await fsp.writeFile(path, bytes);
      }
      const { semantic, compiler } = await modules();
      await syncViews(note);
      const text = await fsp.readFile(path, 'utf8');
      const bim = JSON.parse(text.replace(/^﻿/, ''));
      const m = await semantic.registerModel(path.split(/[\\/]/).pop(), text, compiler);
      // Kept as a semantic view, as the panel keeps a model it opens.
      await semviews.put(m.name, path);
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
      const { semantic, paths, compiler } = await modules();
      await syncViews(note);
      const t0 = Date.now();
      const lhIn = opts.in ? await itemOf(...String(opts.in).split('/')) : null;
      if (lhIn) text = filesToAbfss(text, lhIn);
      const st = await semantic.statement(text, compiler);
      // CREATE / DROP SEMANTIC VIEW: dax-sql has checked it; the extension keeps the view.
      if (st && st.drop) {
        const had = semantic.hasView(st.drop.name);
        await semviews.remove(st.drop.name);
        semantic.dropView(st.drop.name);
        defined.delete(st.drop.name.toLowerCase());
        out(had ? `Semantic view ${st.drop.name} dropped.` : `No semantic view ${st.drop.name}.`);
        return;
      }
      if (st && st.create) {
        if (st.create.mode === 'if_not_exists' && semantic.hasView(st.create.name)) {
          out(`Semantic view ${st.create.name} already exists.`);
          return;
        }
        const v = await semviews.put(st.create.name, semviews.resolve(st.create.path, lhIn));
        const m = await semantic.defineView(v.name, v.path, v.text, 'replace', compiler);
        defined.add(v.name.toLowerCase());
        out(`Semantic view ${m.name} created from ${v.path}. \`SHOW SEMANTIC METRICS IN ${m.name}\` lists its measures.`);
        return;
      }
      const run = st ? st.sql : text;
      if (st && opts.showSql) out(`${fence('sql', st.sql)}\n`);
      // A model's query opens the tables it compiles to; any other SQL opens the raw
      // Direct Lake tables it names ("mart_1a2b3c4d"."fct" — `model` lists them).
      for (const x of st ? st.tables : semantic.tablesFor(text)) await openView(x.lh, x.t, x.ident, note);
      // --in: the lakehouse's tables, as <item>_<schema>.<table> (`ls <ws> <item>` prints
      // them) — a schema of their own, so they never repoint a view the panel made.
      if (lhIn) {
        const lh = lhIn;
        const lc = text.toLowerCase();
        for (const t of await onelake.tables(lh)) {
          const schema = sqlSchema(lh, t);
          if (!paths.sqlNeedsTable(text, t.table) || !lc.includes(schema.toLowerCase())) continue;
          await openView(lh, t, `${paths.quoteIdent(schema)}.${paths.quoteIdent(t.table)}`, note);
        }
      }
      result(await (await engine()).agentQuery(run), opts, out);
      note(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
    if (!cmd) return { out: '', err: `unknown command: ${name || '(none)'} — screen, ls, table, model, sql or dax`, code: 1 };
    try {
      await cmd(rest, {
        fresh: !!opts.fresh, csv: !!opts.csv, in: opts.in ? String(opts.in) : '',
        limit: Number(opts.limit) > 0 ? Number(opts.limit) : 100,
        showSql: !!opts.showSql, rerun: !!opts.rerun, model: opts.model ? String(opts.model) : '',
      }, out, note);
      return { out: outLines.join('\n'), err: errLines.join('\n'), code: 0 };
    } catch (e) {
      errLines.push(`error: ${(e && e.message) || e}`);
      return { out: outLines.join('\n'), err: errLines.join('\n'), code: 1 };
    }
  }

  return { run };
}

module.exports = { createAgent, sqlSchema, filesToAbfss, withView, panelToAgentSql };
