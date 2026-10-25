// =============================================================================
// semantic.js — a Power BI semantic model (.bim) as something SQL can query
// =============================================================================
// Opening a .bim under Files/ opens its model view (analyze/view.js) and registers it here
// as a MODEL, named after the file: `nem.bim` is `nem`. A query that names it is compiled
// by dax-sql before it runs: `SELECT dim_region.Region, AGG("Registered MW") FROM nem
// GROUP BY ALL` becomes the SQL that computes the measure over the model's tables, with
// DAX's filter semantics. AGG(m), or MEASURE(m), is measure m. `DESCRIBE nem` lists the
// model's columns and measures.
//
// Its Direct Lake tables are read where the model itself reads them: each table's
// expression names a OneLake workspace and item by GUID, so the engine opens the table
// through the same Iceberg catalog as any other, from that item — whichever lakehouse is
// selected. Each lands in a schema of its own ("dbo_1a2b3c4d"), so two lakehouses' dbo.x
// can never take each other's view name, nor the one the sidebar opened.
//
// The compiler is loaded on the first .bim, not at boot. It is plain ES modules from its
// GitHub repository, pinned in cdn.js and vendored by build.mjs like everything else.
// =============================================================================
import { PINS, ghFile } from "./cdn.js";
import { quoteIdent, sqlStr, sqlNeedsTable, stripComments, basename } from "./paths.js";

const lc = s => String(s).toLowerCase();

let modulesP = null;
function compilerModules() {
  modulesP = modulesP || Promise.all([
    import(ghFile(PINS.daxSql, "src/index.js")),
    import(ghFile(PINS.daxSql, "formats/tmsl.js")),
  ]).then(([c, t]) => ({ createCompiler: c.createCompiler, tmslToModel: t.tmslToModel }))
    .catch(e => { modulesP = null; throw new Error(`Could not load the DAX compiler: ${e.message}`); });
  return modulesP;
}

// The model's name: the file's, up to its first dot, as an identifier SQL can write bare.
export function modelName(fileName) {
  const stem = basename(String(fileName)).replace(/\..*$/, "");
  let name = stem.replace(/[^A-Za-z0-9_]/g, "_") || "model";
  if (/^\d/.test(name)) name = "_" + name;
  return name;
}

// The bim's Direct Lake tables, by table name: where each one lives in OneLake. A Direct
// Lake model's shared expression holds its lakehouse's OneLake URL, by GUIDs; each table's
// partition names that expression, and the schema and table it reads.
export function directLakeTables(bim) {
  const text = e => (Array.isArray(e) ? e.join("\n") : String(e ?? ""));
  const url = /onelake\.dfs\.fabric\.microsoft\.com\/([0-9a-f-]{36})\/([0-9a-f-]{36})/i;
  const lakes = new Map();
  for (const e of bim?.model?.expressions ?? []) {
    const m = url.exec(text(e.expression));
    if (m) lakes.set(e.name, { workspace: lc(m[1]), item: lc(m[2]) });
  }
  const tables = new Map();
  for (const t of bim?.model?.tables ?? []) {
    const s = t.partitions?.[0]?.source;
    const lake = s?.expressionSource && lakes.get(s.expressionSource);
    if (!lake) continue;
    const schema = s.schemaName ?? "dbo";
    const entity = s.entityName ?? t.name;
    const viewSchema = `${schema}_${lake.item.replace(/-/g, "").slice(0, 8)}`;
    tables.set(lc(t.name), {
      lh: { workspace: lake.workspace, item: lake.item },
      t: { schema, table: entity },
      viewSchema,
      ident: `${quoteIdent(viewSchema)}.${quoteIdent(entity)}`,
    });
  }
  return tables;
}

const models = new Map();   // lower-cased name -> { name, file, compiler, lake }

// Compiles a model from a .bim's text and registers it under the file's name, replacing
// one of that name. `modules` is for tests; the page loads the real compiler.
export async function registerModel(fileName, text, modules = null) {
  const { createCompiler, tmslToModel } = modules || await compilerModules();
  let bim;
  try { bim = JSON.parse(String(text).replace(/^﻿/, "")); }
  catch (e) { throw new Error(`${basename(fileName)} is not a TMSL model: ${e.message}`); }
  const lake = directLakeTables(bim);
  // A Direct Lake table is the view the engine opens for it; any other is the model's own
  // source name, as dax-sql reads it by default.
  const tableSource = t => {
    const l = lake.get(lc(t.name));
    if (l) return l.ident;
    const s = t.source;
    return s.schema ? `${quoteIdent(s.schema)}.${quoteIdent(s.entity)}` : quoteIdent(s.entity);
  };
  const compiler = createCompiler(tmslToModel(bim), { tableSource });
  // Explore's (analyze/query.js): its rows go straight to the page, so a date comes back as
  // text, a whole number as INTEGER and any other number as DOUBLE — what JS can hold.
  const exploreCompiler = createCompiler(tmslToModel(bim), {
    tableSource,
    castOutput: {
      int: s => `CAST(${s} AS INTEGER)`,
      double: s => `CAST(${s} AS DOUBLE)`,
      decimal: s => `CAST(${s} AS DOUBLE)`,
      datetime: s => `CAST(CAST(${s} AS DATE) AS VARCHAR)`,
    },
  });
  const m = { name: modelName(fileName), file: basename(fileName), compiler, lake };
  models.set(lc(m.name), m);
  return { name: m.name, file: m.file, sample: sampleQuery(m), directLake: lake.size, bim, exploreCompiler };
}

// The Direct Lake tables a compiled SQL reads, of every model registered, and only those:
// a query about one fact does not open the other five.
export function tablesFor(sql) {
  const out = [];
  for (const m of models.values())
    for (const l of m.lake.values())
      if (sql.includes(l.ident) && !out.some(x => x.ident === l.ident)) out.push(l);
  return out;
}

// What the editor offers once a model is open: one measure by one column it can slice by,
// or the model's field list when it has no measure.
function sampleQuery(m) {
  const model = m.compiler.model;
  const name = id => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(id) ? id : quoteIdent(id));
  const head = `-- ${m.file} is the semantic model ${m.name}: AGG(measure) is a measure, ` +
               `DESCRIBE ${m.name} lists them all.\n`;
  const [measure] = model.measures.values();
  if (!measure) return `${head}DESCRIBE ${m.name}`;
  let column = null;
  try {
    const state = model.state();
    for (const t of model.tables.values()) {
      if (t.hidden || t === measure.table || !model.reaches(t, measure.table, state)) continue;
      column = t.columns.find(c => c.type === "string");
      if (column) { column = `${name(t.name)}.${name(column.name)}`; break; }
    }
  } catch (_) { /* no slicer, then — the measure alone is still a query */ }
  const agg = `AGG(${name(measure.name)}) AS ${quoteIdent(measure.name)}`;
  return column
    ? `${head}SELECT ${column}, ${agg}\nFROM ${m.name}\nGROUP BY ALL\nORDER BY 1`
    : `${head}SELECT ${agg}\nFROM ${m.name}`;
}

const DUCK_TYPES = { int: "BIGINT", double: "DOUBLE", decimal: "DOUBLE", string: "VARCHAR",
                     datetime: "TIMESTAMP", bool: "BOOLEAN", variant: "VARCHAR" };

// DESCRIBE <model>: its columns as table.column, then its measures, as rows of VALUES.
function describe(m) {
  const list = [];
  for (const t of m.compiler.model.tables.values())
    for (const c of t.columns) list.push([`${t.name}.${c.name}`, DUCK_TYPES[c.type] || "VARCHAR", "column", c.expr ?? null]);
  for (const x of m.compiler.model.measures.values()) list.push([x.name, null, "measure", x.text ?? null]);
  const cell = v => (v == null ? "NULL::VARCHAR" : sqlStr(v));
  const values = list.map(r => `(${r.map(cell).join(", ")})`).join(",\n  ");
  const cols = `t(column_name, column_type, kind, expression)`;
  return list.length ? `SELECT * FROM (VALUES\n  ${values}) ${cols}`
                     : `SELECT * FROM (VALUES (NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR)) ${cols} WHERE false`;
}

// The SQL to run for what the user wrote, and the tables to open first; null when it names
// no model, which is every query that is not about one.
export function rewrite(sql) {
  const named = [...models.values()].filter(m => sqlNeedsTable(sql, m.name));
  if (!named.length) return null;
  const only = /^\s*(DESCRIBE|DESC)\s+("?)([^"\s;]+)\2\s*;?\s*$/i.exec(stripComments(String(sql)));
  if (only) {
    const m = models.get(lc(only[3]));
    if (m) return { sql: describe(m), tables: [] };
  }
  let out = String(sql);
  for (const m of named) out = m.compiler.compileStatement(out, m.name).sql;
  return { sql: out, tables: tablesFor(out) };
}
