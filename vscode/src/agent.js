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
//   ls [<ws> [<item>]]               workspaces / items + semantic models / tables
//   table <ws> <item> <schema.table> metadata only
//   model <ws> <model>               relationships, columns, measures with DAX
//   sql "<sql>" [--in <ws>/<item>]   a downloaded model is a table; AGG("m") is measure m
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

/**
 * @param {object} o
 * @param {ReturnType<import('./onelake').createOneLake>} o.onelake
 * @param {{ getBim(ws: string, id: string): Promise<Uint8Array> }} o.fabric
 * @param {() => Promise<object>} o.engine   the extension's engine (engine-host.js)
 * @param {() => string} o.modelsFolder      where .bim files are downloaded
 * @param {(ws: string, model: string) => string} o.bimPath
 * @param {string} o.appDir                  the panel's modules (semantic.js, paths.js)
 * @param {string} o.vendorDir               the vendored DAX compiler
 */
function createAgent({ onelake, fabric, engine, modelsFolder, bimPath, appDir, vendorDir, daxSqlPin }) {
  let mods = null;
  async function modules() {
    if (mods) return mods;
    const load = p => import(pathToFileURL(p).href);
    const [paths, semantic, c, t] = await Promise.all([
      load(join(appDir, 'paths.js')), load(join(appDir, 'semantic.js')),
      load(join(vendorDir, 'gh', daxSqlPin, 'src', 'index.js')),
      load(join(vendorDir, 'gh', daxSqlPin, 'formats', 'tmsl.js')),
    ]);
    mods = { paths, semantic, compiler: { createCompiler: c.createCompiler, tmslToModel: t.tmslToModel } };
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

  // Every downloaded .bim, registered so SQL can name its model.
  async function registerAll(note) {
    const { semantic, compiler } = await modules();
    const root = modelsFolder();
    const seen = new Map();
    for (const ws of await fsp.readdir(root).catch(() => [])) {
      for (const f of await fsp.readdir(join(root, ws)).catch(() => [])) {
        if (!f.toLowerCase().endsWith('.bim')) continue;
        try {
          const m = await semantic.registerModel(f, await fsp.readFile(join(root, ws, f), 'utf8'), compiler);
          if (seen.has(m.name)) note(`model ${m.name} is in both ${seen.get(m.name)} and ${ws}; ${ws}'s is used`);
          seen.set(m.name, ws);
        } catch (e) { note(`skipped ${ws}/${f}: ${e.message}`); }
      }
    }
  }

  // A lakehouse table's schema in agent SQL: data.Lakehouse's mart.x is data_mart.x.
  const sqlSchema = (lh, t) =>
    `${lh.item.replace(/\.[^.]+$/, '')}_${t.schema || 'main'}`.replace(/[^A-Za-z0-9_]/g, '_');

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

  // ---------------------------------------------------------------------------
  const commands = {
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
      await registerAll(note);
      const text = await fsp.readFile(path, 'utf8');
      const bim = JSON.parse(text.replace(/^﻿/, ''));
      const m = await semantic.registerModel(path.split(/[\\/]/).pop(), text, compiler);
      out(`# ${m.name} — semantic model (${ws}), from ${path}\n`);
      out(`Query it as \`FROM ${m.name}\`; a measure is \`AGG("name")\`. Direct Lake tables: ${m.directLake}.\n`);
      const rels = ((bim.model && bim.model.relationships) || []).map(r =>
        [`${r.fromTable}[${r.fromColumn}]`, `${r.toTable}[${r.toColumn}]`, r.isActive === false ? 'inactive' : '']);
      if (rels.length) out(mdTable(['from (many)', 'to (one)', ''], rels) + '\n');
      result(await (await engine()).agentQuery(semantic.rewrite(`DESCRIBE ${m.name}`).sql), { limit: 1e6 }, out);
      out(`\nExample:\n\n${m.sample}`);
    },

    async sql([text], opts, out, note) {
      if (!text) throw new Error('usage: sql "<query>"');
      const { semantic, paths } = await modules();
      await registerAll(note);
      const t0 = Date.now();
      const rewritten = semantic.rewrite(text);
      const run = rewritten ? rewritten.sql : text;
      for (const x of rewritten ? rewritten.tables : []) await openView(x.lh, x.t, x.ident, note);
      // --in: the lakehouse's tables, as <item>_<schema>.<table> (`ls <ws> <item>` prints
      // them) — a schema of their own, so they never repoint a view the panel made.
      if (opts.in) {
        const [ws, item] = String(opts.in).split('/');
        const lh = await itemOf(ws, item);
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
    if (!cmd) return { out: '', err: `unknown command: ${name || '(none)'} — ls, table, model or sql`, code: 1 };
    try {
      await cmd(rest, {
        fresh: !!opts.fresh, csv: !!opts.csv, in: opts.in ? String(opts.in) : '',
        limit: Number(opts.limit) > 0 ? Number(opts.limit) : 100,
      }, out, note);
      return { out: outLines.join('\n'), err: errLines.join('\n'), code: 0 };
    } catch (e) {
      errLines.push(`error: ${(e && e.message) || e}`);
      return { out: outLines.join('\n'), err: errLines.join('\n'), code: 1 };
    }
  }

  return { run };
}

module.exports = { createAgent };
