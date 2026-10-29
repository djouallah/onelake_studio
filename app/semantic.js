// =============================================================================
// semantic.js — semantic views: Power BI models (.bim, or Ossie .yaml) that SQL can name
// =============================================================================
// The statements and the compiling are dax-sql's, vendored at the pin in src/vendored.js —
// its createViews() is the one implementation of
//
//   CREATE [OR REPLACE] SEMANTIC VIEW [IF NOT EXISTS] ws.sales FROM '<path to .bim or .yaml>'   (semanticmodel.ws.sales)
//   DROP SEMANTIC VIEW [IF EXISTS] semanticmodel.ws.sales
//   SHOW SEMANTIC VIEWS | SHOW SEMANTIC DIMENSIONS IN … [FOR METRIC m] | SHOW SEMANTIC METRICS IN …
//   DESCRIBE semanticmodel.ws.sales
//   SELECT dim.Region, AGG("Sales") FROM semanticmodel.ws.sales GROUP BY ALL    (AGG(m) is measure m)
//
// and nothing here re-implements any of it. A model is TMSL (a .bim) or an Apache Ossie model
// whose metrics are DAX (a .yaml or .yml): dax-sql's formats/ossie.js turns the latter into the
// .bim it stands for, and from there the two are one. What is this extension's: reading a Direct Lake
// model's tables from OneLake — each table's expression names a workspace and an item by GUID,
// the host names them (setTableNamer) and the compiled SQL reads each by its SQL name,
// lakehouse.ws.item.schema.table, the one any query writes — and where views are kept
// (the extension host, per account: src/semviews.js). This module is shared by the panel and
// the host's command line (src/agent.js); `modules` lets the host hand in the compiler.
// =============================================================================
import { PINS, npmFile, npmEsm } from "./cdn.js";
import { quoteIdent, basename } from "./paths.js";
import { EXPLORE_CASTS } from "./explore/query.js";

const lc = s => String(s).toLowerCase();

// The catalog every semantic model is named in, as lakehouse tables are in `lakehouse`: a
// model's SQL name is semanticmodel.<workspace>.<model>, and nothing shorter.
export const MODEL_CATALOG = "semanticmodel";
const namePart = s => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(s)) ? String(s) : quoteIdent(s));
export const modelSqlName = (workspace, name) => [MODEL_CATALOG, workspace, name].map(namePart).join(".");
const fullName = v => modelSqlName(v.schema, v.name);

let modulesP = null;
function compilerModules() {
  modulesP = modulesP || Promise.all([
    import(npmFile(PINS.daxSql, "src/index.js")),
    import(npmFile(PINS.daxSql, "formats/tmsl.js")),
    import(npmFile(PINS.daxSql, "formats/ossie.js")),
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

// What kind of model it is, as a phrase for saying why it cannot be opened: "an Import
// model", "a DirectQuery model", "a composite model", or Direct Lake over the SQL endpoint
// (a directLake partition but no OneLake URL to read it from). A partition without a mode
// (or "default") takes the model's defaultMode, which is Import when absent.
export function storageMode(bim) {
  const fallback = lc(bim?.model?.defaultMode || "import");
  const modes = new Set();
  for (const t of bim?.model?.tables ?? []) {
    for (const p of t.partitions ?? []) {
      // Calculated tables and the like have no storage of their own to judge by.
      if (p.source?.type === "calculated" || p.source?.type === "calculationGroup") continue;
      const m = lc(p.mode || "default");
      modes.add(m === "default" ? fallback : m);
    }
  }
  if (!modes.size) modes.add(fallback);
  const lakes = lakehousesOf(bim).length;
  if (modes.size === 1 && modes.has("directlake")) {
    return lakes ? `Direct Lake on ${lakes} lakehouses` : "Direct Lake over a SQL endpoint";
  }
  if (modes.size > 1) return "a composite model";
  if (modes.has("directquery")) return "a DirectQuery model";
  if (modes.has("dual")) return "a Dual-mode model";
  return "an Import model";
}

export function directLakeTables(bim) {
  const found = lakeExpressions(bim);
  const tables = new Map();
  for (const t of bim?.model?.tables ?? []) {
    const s = t.partitions?.[0]?.source;
    const lake = s?.expressionSource && found.get(s.expressionSource);
    if (!lake) continue;
    tables.set(lc(t.name), {
      lh: { workspace: lake.workspace, item: lake.item },
      t: { schema: s.schemaName ?? "dbo", table: s.entityName ?? t.name },
    });
  }
  return tables;
}

// Who turns a Direct Lake table (its item by GUID) into its SQL name: the host, which asks
// the Fabric API what the GUIDs are called. Set once by the panel and by the command line.
let tableNamer = null;
export const setTableNamer = fn => { tableNamer = fn; };

// directLakeTables(), each with its SQL name as `ident`.
async function namedLakeTables(bim) {
  const lake = directLakeTables(bim);
  if (!lake.size) return lake;
  if (!tableNamer) throw new Error("Direct Lake tables cannot be named here");
  const list = [...lake.values()];
  const names = await tableNamer(list.map(l => ({ ...l.lh, ...l.t })));
  list.forEach((l, i) => { l.ident = names[i]; });
  return lake;
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

// Where a table's SQL name says it lives: its first three parts (lakehouse.ws.item), as written.
function itemOfIdent(ident) {
  let dots = 0, q = false;
  for (let i = 0; i < ident.length; i++) {
    if (ident[i] === '"') q = !q;
    else if (ident[i] === "." && !q && ++dots === 3) return ident.slice(0, i);
  }
  return ident;
}

/**
 * A semantic view of a model file's text (a .bim, or an Ossie .yaml), under `name` in
 * `schema`, the model's workspace: SQL names it semanticmodel.ws.model. `mode`: 'create',
 * 'replace' or 'if_not_exists' (dax-sql's). Returns what the model view draws:
 * { name (its SQL name), view, schema, file, sample, directLake, bim, exploreCompiler }.
 */
export async function defineView(name, path, text, mode = "replace", modules = null, schema = null) {
  if (!schema) throw new Error(`a semantic model is named ${MODEL_CATALOG}.<workspace>.<model>: ${name} has no workspace`);
  const mods = await ready(modules);
  const { createCompiler, tmslToModel } = mods;
  const bim = bimOf(path, text, mods);
  const lake = await namedLakeTables(bim);
  // A Direct Lake table is read by its SQL name, the engine making its view as a query
  // names it; any other is the model's own source name, as dax-sql reads it by default.
  const tableSource = t => {
    const l = lake.get(lc(t.name));
    if (l) return l.ident;
    const s = t.source;
    return s.schema ? `${quoteIdent(s.schema)}.${quoteIdent(s.entity)}` : quoteIdent(s.entity);
  };
  // The items its tables are read from, by their SQL names — a model may read several.
  const where = [...new Set([...lake.values()].map(l => itemOfIdent(l.ident)))];
  const done = views.define(name, tmslToModel(bim), {
    path, mode, db: MODEL_CATALOG, schema, tableSource, tablesFrom: where.length ? where.join(", ") : "search path",
  });
  const v = views.get([MODEL_CATALOG, schema, name]);
  if (done === "created") lakes.set(lc(v.sqlName), lake);
  // Explore's (explore/query.js): its rows go straight to the page, cast as EXPLORE_CASTS says.
  const exploreCompiler = createCompiler(tmslToModel(bim), { tableSource, castOutput: EXPLORE_CASTS });
  return { name: fullName(v), view: v.name, schema, file: basename(path), sample: sampleQuery(v),
           directLake: lake.size, bim, exploreCompiler, done };
}

// A model opened from a file, in its workspace: under the semantic model's own name when it is
// one (the tree's click), else the file's — semanticmodel.ws.nem for nem.bim or nem.yaml.
export const registerModel = (fileName, text, modules = null, schema = null, name = null) =>
  defineView(name || modelName(fileName), fileName, text, "replace", modules, schema);

// A column's type in TMSL's words, from the Iceberg schema (long, decimal(18,2), timestamp)
// or DuckDB's DESCRIBE (BIGINT, DECIMAL(18,2), TIMESTAMP WITH TIME ZONE), whichever the
// table's info holds. null: a type the pivot has no use for (nested, binary), left out.
function tmslType(type) {
  if (typeof type !== "string") return null;   // an Iceberg struct, list or map
  const s = type.trim().toLowerCase();
  if (/^(struct|list|map|array|union)\b|\[\]$/.test(s) || /^(binary|blob|bytea|fixed)\b/.test(s)) return null;
  if (/^bool/.test(s)) return "boolean";
  if (/^(u?(tiny|small|big|huge)?int(eger)?\d*|long)$/.test(s)) return "int64";
  if (/^(float|double|real)/.test(s)) return "double";
  if (/^(decimal|numeric)/.test(s)) return "decimal";
  if (/^(date|timestamp)/.test(s)) return "dateTime";
  return "string";
}

// A table's dates and times as text: the date alone at midnight, else the time too. A model's
// date column shows as a date (EXPLORE_CASTS), but a table's event timestamps are kept apart,
// not shown as the same date row after row.
const asTs = s => `CAST(${s} AS TIMESTAMP)`;

// A date or timestamp column's grains in a table's Pivot: [suffix, TMSL type, expression].
const DATE_GRAINS = [
  ["year", "int64", c => `year(${c})`],
  ["month", "dateTime", c => `CAST(date_trunc('month', ${c}) AS DATE)`],
  ["day", "dateTime", c => `CAST(${c} AS DATE)`],   // a timestamp's only
];
const TABLE_CASTS = {
  ...EXPLORE_CASTS,
  datetime: s => `CASE WHEN CAST(${asTs(s)} AS TIME) = TIME '00:00:00' THEN CAST(CAST(${asTs(s)} AS DATE) AS VARCHAR) ` +
                 `ELSE CAST(${asTs(s)} AS VARCHAR) END`,
};

/**
 * A lakehouse table as a model of its own, for the Pivot: one table, no relationships, and one
 * measure, its row count, so the pivot answers before a column is dragged. Made from the
 * columns the table's metadata lists, so nothing is read to build it; its queries read the
 * table by its SQL name, which the engine opens as a query names it. Not a view: SQL cannot
 * name it. Returns { name (what its SQL says FROM), tmsl, compiler, plainSql }.
 */
export async function tableModel(table, sqlName, columns, modules = null) {
  const { createCompiler, tmslToModel } = await ready(modules);
  const listed = (columns || []).filter(c => tmslType(c.type));
  const names = new Set(listed.map(c => lc(c.name)));
  // A date's grains as columns of their own, next to it: <column>_year, _month, and _day for a
  // timestamp. The pivot groups by them as by any column; the model reads them from the table
  // with them added (tableSource), and the SQL a person gets writes each as its expression.
  const grains = new Map();   // grain column -> (column as SQL writes it) => its expression
  const cols = [];
  for (const c of listed) {
    const dataType = tmslType(c.type);
    cols.push({ name: c.name, dataType, sourceColumn: c.name });
    if (dataType !== "dateTime") continue;
    const ts = /^timestamp/i.test(String(c.type).trim());
    for (const [g, type, fn] of DATE_GRAINS) {
      const name = `${c.name}_${g}`;
      if ((g === "day" && !ts) || names.has(lc(name))) continue;
      names.add(lc(name));
      grains.set(name, q => fn(q(c.name)));
      // Marked as worked out (explore.js draws it apart): the table has no such column.
      cols.push({ name, dataType: type, sourceColumn: name, derivedFrom: c.name, derivedAs: g,
        description: `${c.name} by ${g}, worked out as ${fn(c.name)}: not a column of the table` });
    }
  }
  const rows = ["Rows", "Row count", "Rows (count)"].find(n => !names.has(lc(n)));
  const bim = { model: { tables: [{
    name: table, columns: cols,
    measures: [{ name: rows, expression: `COUNTROWS('${table.replace(/'/g, "''")}')`, formatString: "#,0" }],
    partitions: [{ source: { type: "entity", entityName: table } }],
  }], relationships: [] } };
  const from = grains.size
    ? `(SELECT *, ${[...grains].map(([n, fn]) => `${fn(quoteIdent)} AS ${quoteIdent(n)}`).join(", ")} FROM ${sqlName})`
    : sqlName;
  const compiler = createCompiler(tmslToModel(bim), { tableSource: () => from, castOutput: TABLE_CASTS });
  // The shelves' query as SQL over the table itself, as a person writes it (explore.js
  // modelSql): with one table and no relationships the two mean the same, the measure being
  // COUNT(*) and a grain its expression.
  const plainSql = {
    from: sqlName,
    measure: n => (n === rows ? "COUNT(*)" : null),
    column: (n, q) => grains.get(n)?.(q) ?? null,
  };
  return { name: modelName(table), tmsl: bim.model, compiler, plainSql };
}

// A view by its SQL name: { name, schema } as the host keeps it, and its SQL name; or null.
export function viewOf(name) {
  const v = views && views.get(name);
  return v ? { name: v.name, schema: v.schema, sqlName: fullName(v) } : null;
}

// The semantic models a statement names (semanticmodel.ws.model) that are not views here yet,
// as [{ workspace, model }] as written: the host opens each before the statement runs.
// Comments and string literals are skipped.
const PART_RE = '(?:"(?:[^"]|"")*"|[A-Za-z_\\u00C0-\\uFFFF][A-Za-z0-9_$\\u00C0-\\uFFFF]*)';
const DOT_RE = "\\s*\\.\\s*";
const MODEL_REF = new RegExp(`--[^\\n]*|/\\*[\\s\\S]*?\\*/|'(?:[^']|'')*'|` +
  `(${PART_RE})${DOT_RE}(${PART_RE})${DOT_RE}(${PART_RE})`, "g");
export function unopenedModels(sql) {
  const s = String(sql);
  if (!lc(s).includes(MODEL_CATALOG)) return [];
  const unq = x => (x[0] === '"' ? x.slice(1, -1).replace(/""/g, '"') : x);
  const out = [];
  for (const m of s.matchAll(MODEL_REF)) {
    if (!m[1] || lc(unq(m[1])) !== MODEL_CATALOG) continue;
    const ref = { workspace: unq(m[2]), model: unq(m[3]) };
    if (hasView([MODEL_CATALOG, ref.workspace, ref.model])) continue;
    if (!out.some(r => lc(r.workspace) === lc(ref.workspace) && lc(r.model) === lc(ref.model))) out.push(ref);
  }
  return out;
}

export function dropView(name) {
  const v = views && views.get(name);
  if (!v) return;
  views.drop([MODEL_CATALOG, v.schema, v.name], { ifExists: true });
  lakes.delete(lc(v.sqlName));
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
  const v = views && views.get(name);
  const lake = v && lakes.get(lc(v.sqlName));
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
  const full = fullName(v);
  const head = `-- ${full} is a semantic model: AGG(measure) is a measure, ` +
               `SHOW SEMANTIC METRICS IN ${full} lists them all.\n`;
  const chart = starterChart(v.compiler.model);
  if (!chart) return `${head}SHOW SEMANTIC DIMENSIONS IN ${full}`;
  const agg = `AGG(${name(chart.measure)}) AS ${quoteIdent(chart.measure)}`;
  return chart.column
    ? `${head}SELECT ${name(chart.column.table)}.${name(chart.column.name)}, ${agg}\nFROM ${full}\nGROUP BY ALL\nORDER BY 1`
    : `${head}SELECT ${agg}\nFROM ${full}`;
}
