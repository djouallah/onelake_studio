// =============================================================================
// semantic.js — semantic views: Power BI models (.bim, or Ossie .yaml) that SQL can name
// =============================================================================
// The statements and the compiling are dax-sql's, vendored at the pin in src/vendored.js —
// its createViews() is the one implementation of
//
//   CREATE [OR REPLACE] SEMANTIC VIEW [IF NOT EXISTS] sales FROM '<path to .bim or .yaml>'
//   DROP SEMANTIC VIEW [IF EXISTS] sales
//   SHOW SEMANTIC VIEWS | SHOW SEMANTIC DIMENSIONS IN sales [FOR METRIC m] | SHOW SEMANTIC METRICS IN sales
//   DESCRIBE sales
//   SELECT dim.Region, AGG("Sales") FROM sales GROUP BY ALL    (AGG(m) is measure m)
//
// and nothing here re-implements any of it. A model is TMSL (a .bim) or an Apache Ossie model
// whose metrics are DAX (a .yaml or .yml): dax-sql's formats/ossie.js turns the latter into the
// .bim it stands for, and from there the two are one. What is this extension's: reading a Direct Lake
// model's tables from OneLake — each table's expression names a workspace and an item by GUID,
// and the engine opens it through the same Iceberg catalog as any other, in a schema of its
// own ("dbo_1a2b3c4d") so two lakehouses' dbo.x never collide — and where views are kept
// (the extension host, per account: src/semviews.js). This module is shared by the panel and
// the host's command line (src/agent.js); `modules` lets the host hand in the compiler.
// =============================================================================
import { PINS, ghFile, npmEsm } from "./cdn.js";
import { quoteIdent, basename } from "./paths.js";
import { EXPLORE_CASTS } from "./explore/query.js";

const lc = s => String(s).toLowerCase();

let modulesP = null;
function compilerModules() {
  modulesP = modulesP || Promise.all([
    import(ghFile(PINS.daxSql, "src/index.js")),
    import(ghFile(PINS.daxSql, "formats/tmsl.js")),
    import(ghFile(PINS.daxSql, "formats/ossie.js")),
    import(npmEsm(PINS.yaml)),
  ]).then(([c, t, o, y]) => ({
    createCompiler: c.createCompiler, createViews: c.createViews, tmslToModel: t.tmslToModel,
    ossieToTmsl: o.ossieToTmsl, parseYaml: y.parse,
  }))
    .catch(e => { modulesP = null; throw new Error(`Could not load the DAX compiler: ${e.message}`); });
  return modulesP;
}

// The views (dax-sql's registry) and, per view, its Direct Lake tables.
let mods = null, views = null;
const lakes = new Map();   // lower-cased view name -> directLakeTables()
async function ready(modules) {
  if (!views) {
    mods = modules || await compilerModules();
    views = mods.createViews();
  }
  return mods;
}

// A view's default name: its file's, up to its first dot, as an identifier SQL writes bare.
export function modelName(fileName) {
  const stem = basename(String(fileName)).replace(/\..*$/, "");
  let name = stem.replace(/[^A-Za-z0-9_]/g, "_") || "model";
  if (/^\d/.test(name)) name = "_" + name;
  return name;
}

// The bim's Direct Lake tables, by table name: where each one lives in OneLake. A Direct
// Lake model's shared expression holds its lakehouse's OneLake URL, by GUIDs; each table's
// partition names that expression, and the schema and table it reads.
// The bim's shared expressions that name a lakehouse: expression name -> { workspace, item }.
function lakeExpressions(bim) {
  const text = e => (Array.isArray(e) ? e.join("\n") : String(e ?? ""));
  const url = /onelake\.dfs\.fabric\.microsoft\.com\/([0-9a-f-]{36})\/([0-9a-f-]{36})/i;
  const found = new Map();
  for (const e of bim?.model?.expressions ?? []) {
    const m = url.exec(text(e.expression));
    if (m) found.set(e.name, { workspace: lc(m[1]), item: lc(m[2]) });
  }
  return found;
}

// The lakehouses a model's expressions name (by GUID), each once: the one an Ossie model's
// Direct Lake expression holds is its Iceberg catalog (Export to Fabric, src/exportapp.js).
export function lakehousesOf(bim) {
  const out = new Map();
  for (const l of lakeExpressions(bim).values()) out.set(`${l.workspace}/${l.item}`, l);
  return [...out.values()];
}

export function directLakeTables(bim) {
  const found = lakeExpressions(bim);
  const tables = new Map();
  for (const t of bim?.model?.tables ?? []) {
    const s = t.partitions?.[0]?.source;
    const lake = s?.expressionSource && found.get(s.expressionSource);
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

// Whether a file of this name is an Ossie model rather than a .bim.
export const isOssiePath = path => /\.ya?ml$/i.test(String(path));

// Whether a YAML file's text is an Ossie model: its top level has the datasets and the spec's
// version. A dbt schema.yml, a pipeline's config, has neither, and stays a document.
export const isOssie = text =>
  /^datasets:/m.test(String(text)) && /^version:/m.test(String(text));

// The TMSL a model file's text is: a .bim as it is, an Ossie model as the .bim it stands for.
function bimOf(path, text, mods) {
  const body = String(text).replace(/^﻿/, "");
  if (isOssiePath(path)) {
    let doc;
    try { doc = mods.parseYaml(body); }
    catch (e) { throw new Error(`${basename(path)} is not YAML: ${e.message}`); }
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.datasets))
      throw new Error(`${basename(path)} is not an Ossie model: it has no datasets`);
    return mods.ossieToTmsl(doc);
  }
  try { return JSON.parse(body); }
  catch (e) { throw new Error(`${basename(path)} is not a TMSL model: ${e.message}`); }
}

/**
 * A semantic view of a model file's text (a .bim, or an Ossie .yaml), under `name`. `mode`:
 * 'create', 'replace' or 'if_not_exists' (dax-sql's). Returns what the model view draws:
 * { name, file, sample, directLake, bim, exploreCompiler }.
 */
export async function defineView(name, path, text, mode = "replace", modules = null) {
  const mods = await ready(modules);
  const { createCompiler, tmslToModel } = mods;
  const bim = bimOf(path, text, mods);
  const lake = directLakeTables(bim);
  // A Direct Lake table is the view the engine opens for it; any other is the model's own
  // source name, as dax-sql reads it by default.
  const tableSource = t => {
    const l = lake.get(lc(t.name));
    if (l) return l.ident;
    const s = t.source;
    return s.schema ? `${quoteIdent(s.schema)}.${quoteIdent(s.entity)}` : quoteIdent(s.entity);
  };
  const where = [...new Set([...lake.values()].map(l => `${l.lh.workspace}/${l.lh.item}`))];
  const done = views.define(name, tmslToModel(bim), {
    path, mode, tableSource, tablesFrom: where.length ? `OneLake ${where.join(", ")}` : "search path",
  });
  if (done === "created") lakes.set(lc(name), lake);
  // Explore's (explore/query.js): its rows go straight to the page, cast as EXPLORE_CASTS says.
  const exploreCompiler = createCompiler(tmslToModel(bim), { tableSource, castOutput: EXPLORE_CASTS });
  const v = views.get(name);
  return { name: v.name, file: basename(path), sample: sampleQuery(v), directLake: lake.size, bim, exploreCompiler, done };
}

// A model opened from a file, under the file's name: the view `nem` for nem.bim or nem.yaml.
export const registerModel = (fileName, text, modules = null) =>
  defineView(modelName(fileName), fileName, text, "replace", modules);

export function dropView(name) {
  if (views) views.drop(name, { ifExists: true });
  lakes.delete(lc(name));
}

export const hasView = name => !!(views && views.get(name));

// The Direct Lake tables a compiled SQL reads, of every view, and only those: a query about
// one fact does not open the other five.
export function tablesFor(sql) {
  const out = [];
  for (const lake of lakes.values())
    for (const l of lake.values())
      if (sql.includes(l.ident) && !out.some(x => x.ident === l.ident)) out.push(l);
  return out;
}

/**
 * What a statement asks, in dax-sql's words (createViews().rewrite): null when it names no
 * view, else { create: { name, path, mode } } or { drop: { name, ifExists } } for the host to
 * carry out, or { sql, tables } to run once `tables` (Direct Lake) are open. One statement.
 */
export async function statement(sql, modules = null) {
  if (!views) {
    // Nothing defined yet: only a statement about views needs the compiler loaded.
    if (!/\bsemantic\b/i.test(String(sql))) return null;
    await ready(modules);
  }
  const out = views.rewrite(sql);
  if (!out) return null;
  if (out.length !== 1) throw new Error("Run one statement at a time (no ';').");
  const [s] = out;
  return s.sql != null ? { sql: s.sql, tables: tablesFor(s.sql) } : s;
}

// A DAX query (EVALUATE …) against view `name`, as the SQL to run and the tables to open first —
// for the command line's `dax`, which runs Explore's DAX as it is.
export function compileDax(name, dax) {
  const v = views && views.get(name);
  if (!v) throw new Error(`No semantic view ${name}.`);
  const sql = v.compiler.compile(String(dax)).sql;
  return { sql, tables: tablesFor(sql) };
}

// A view's Direct Lake tables: the model's table name, the engine's view of it — which SQL
// can name directly to read the raw table — and where it lives in OneLake (by GUID).
export function lakeTablesOf(name) {
  const lake = lakes.get(lc(name));
  if (!lake) return [];
  return [...lake].map(([table, l]) => ({ table, ident: l.ident, schema: l.t.schema, entity: l.t.table, lh: l.lh }));
}

// The SQL to run for a query, and the tables to open first; null when it names no view.
// For the model view's SQL tab, which runs queries only.
export function rewrite(sql) {
  if (!views) return null;
  const out = views.rewrite(sql);
  if (!out) return null;
  if (out.length !== 1 || out[0].sql == null)
    throw new Error("CREATE and DROP SEMANTIC VIEW run in the main SQL editor.");
  return { sql: out[0].sql, tables: tablesFor(out[0].sql) };
}

// A model's (dax-sql's Model) first measure, and the first text column of another table it
// can be sliced by: { measure, column: { table, name } | null }, or null with no measure.
// The editor's sample query.
export function starterChart(model) {
  const [measure] = model.measures.values();
  if (!measure) return null;
  let column = null;
  try {
    const state = model.state();
    for (const t of model.tables.values()) {
      if (t.hidden || t === measure.table || !model.reaches(t, measure.table, state)) continue;
      const c = t.columns.find(c => c.type === "string");
      if (c) { column = { table: t.name, name: c.name }; break; }
    }
  } catch (_) { /* no slicer, then — the measure alone is still a query */ }
  return { measure: measure.name, column };
}

// What the editor offers once a model is open: one measure by one column it can slice by,
// or the model's field list when it has no measure.
function sampleQuery(v) {
  const name = id => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(id) ? id : quoteIdent(id));
  const head = `-- ${v.name} is a semantic view: AGG(measure) is a measure, ` +
               `SHOW SEMANTIC METRICS IN ${v.name} lists them all.\n`;
  const chart = starterChart(v.compiler.model);
  if (!chart) return `${head}SHOW SEMANTIC DIMENSIONS IN ${v.name}`;
  const agg = `AGG(${name(chart.measure)}) AS ${quoteIdent(chart.measure)}`;
  return chart.column
    ? `${head}SELECT ${name(chart.column.table)}.${name(chart.column.name)}, ${agg}\nFROM ${v.name}\nGROUP BY ALL\nORDER BY 1`
    : `${head}SELECT ${agg}\nFROM ${v.name}`;
}
