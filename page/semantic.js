// =============================================================================
// semantic.js — semantic views: Power BI models (.bim, or Ossie .yaml) that SQL can name
// =============================================================================
// The statements and the compiling are dax-sql's, vendored at the pin in core/vendored.js —
// its createViews() is the one implementation of
//
//   SHOW SEMANTIC VIEWS | SHOW SEMANTIC DIMENSIONS IN … [FOR METRIC m] | SHOW SEMANTIC METRICS IN …
//   DESCRIBE ws.sales_semanticmodel
//   SELECT dim.Region, AGG("Sales") FROM ws.sales_semanticmodel GROUP BY ALL    (AGG(m) is measure m)
//
// and nothing here re-implements any of it. A model is TMSL (a .bim) or an Apache Ossie model
// whose metrics are DAX (a .yaml or .yml): dax-sql's formats/ossie.js turns the latter into the
// .bim it stands for, and from there the two are one. What is this extension's: reading a Direct Lake
// model's tables from OneLake — each table's expression names a workspace and an item by GUID,
// the host names them (setTableNamer) and the compiled SQL reads each by its SQL name,
// ws.lakehouse.schema.table, the one any query writes — and where views are kept
// (the extension host, per account: core/models/semviews.js). This module is shared by the panel and
// the host's command line (cli/agent.js); `modules` lets the host hand in the compiler.
// =============================================================================
import { PINS, npmFile, npmEsm } from "./cdn.js";
import { quoteIdent, sqlStr, sqlPart, stripBom, basename } from "./paths.js";
import { EXPLORE_CASTS, withSource } from "./explore/query.js";

const lc = s => String(s).toLowerCase();

// A model's SQL name is <workspace>.<model>_semanticmodel, its kind after its name as an item's
// is, and nothing shorter (core/names.js modelSqlName). The engine lists it in its own catalog,
// onelake, where dax-sql keeps the view: dax-sql reaches a view by db.schema.name alone, so a
// statement's two-part model names are read in that catalog (createViews' db).
export const MODEL_KIND = "semanticmodel";
const MODEL_DB = "onelake";
const SUFFIX = `_${MODEL_KIND}`;
const viewName = model => `${model}${SUFFIX}`;
// The model a view's name is: "nem_semanticmodel" -> "nem", null for one that is not a model's.
const modelOf = view => (lc(view).endsWith(SUFFIX) && view.length > SUFFIX.length ? String(view).slice(0, -SUFFIX.length) : null);
export const modelSqlName = (workspace, name) => [workspace, viewName(name)].map(sqlPart).join(".");
// A model's view, as hasView and the like take it.
export const modelKey = (workspace, model) => [MODEL_DB, workspace, viewName(model)];
const fullName = v => [v.schema, v.name].map(sqlPart).join(".");

let modulesP = null;
function compilerModules() {
  modulesP = modulesP || Promise.all([
    import(npmFile(PINS.daxSql, "src/index.js")),
    import(npmFile(PINS.daxSql, "formats/tmsl.js")),
    import(npmFile(PINS.daxSql, "formats/ossie.js")),
    import(npmFile(PINS.daxSql, "formats/model.js")),
    import(npmFile(PINS.daxSql, "formats/tmdl.js")),
    import(npmEsm(PINS.yaml)),
  ]).then(([c, t, o, m, d, y]) => compilerBundle(c, t, o, m, d, y))
    .catch(e => { modulesP = null; throw new Error(`Could not load the DAX compiler: ${e.message}`); });
  return modulesP;
}

// What this module uses of dax-sql (and the YAML parser), from its modules as loaded: the panel's
// (compilerModules) and the command line's (cli/agent.js) alike. The readers of model files are all dax-sql's.
export function compilerBundle(c, t, o, m, d, y) {
  return {
    createCompiler: c.createCompiler, createViews: c.createViews, tmslToModel: t.tmslToModel,
    directLakeTables: t.directLakeTables, unplacedTables: t.unplacedTables, storageMode: t.storageMode,
    ossieToTmsl: o.ossieToTmsl, tmslToOssie: o.tmslToOssie, ossieSources: o.ossieSources, tmslType: o.tmslType,
    fabricRefusals: o.fabricRefusals, OSSIE: o.OSSIE,
    readModel: m.readModel, formatOf: m.formatOf, tmdlToTmsl: d.tmdlToTmsl,
    parseYaml: y.parse, parseDocument: y.parseDocument, stringifyYaml: y.stringify,
  };
}

// The views (dax-sql's registry) and, per view, its Direct Lake tables.
let mods = null, views = null;
// The host hands its modules in before it reads a model (the readers below need them); ready() too.
export const useModules = m => { mods = mods || m; };
const need = () => {
  if (!mods) throw new Error("the DAX compiler is not loaded yet");
  return mods;
};
const lakes = new Map();   // lower-cased view name -> directLakeTables()
// What the data says of each view's model (takeStats), by its lower-cased fullName: { s, compiler, sig, tables }.
const stats = new Map();
async function ready(modules) {
  if (!views) {
    mods = modules || mods || await compilerModules();
    // A statement reaches a model by its whole name alone (NAMING.md): `FROM nem` is not a model. `db`: a model's
    // name as SQL writes it, ws.model_semanticmodel, is read in the engine's catalog, where the views are.
    views = mods.createViews({ fullNames: true, db: MODEL_DB });
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

// The Ossie SQL dialect of the spec dax-sql reads (OSSIE.dialects.standard): Model's YAML sets any other apart.
// null until dax-sql is loaded.
export const ossieStandard = () => (mods && mods.OSSIE ? mods.OSSIE.dialects.standard : null);

// What Fabric's Publish refuses in a view's YAML as it is shown, line index -> why: dax-sql's fabricRefusals says
// where in each file's document ([file, path]), and the YAML parser says which lines that is. `files`: [{ path, text,
// offset }], `offset` the line the file's text starts at in what is shown. A text that is not YAML yet (typing)
// refuses nothing: Save says why it doesn't open.
export function publishRefusalLines(files) {
  const out = new Map();
  if (!mods || !mods.fabricRefusals) return out;
  const docs = new Map();
  try {
    for (const f of files) docs.set(String(f.path), { f, doc: mods.parseDocument(stripBom(f.text)) });
    if ([...docs.values()].some(({ doc }) => doc.errors.length)) return out;
    const refusals = mods.fabricRefusals(Object.fromEntries([...docs].map(([p, { doc }]) => [p, doc.toJS()])));
    for (const r of refusals) {
      const at = docs.get(String(r.file)) || (docs.size === 1 ? [...docs.values()][0] : null);
      if (!at) continue;
      for (const line of linesAt(at.doc, stripBom(at.f.text), r.path || [])) {
        const i = line + (at.f.offset || 0);
        if (!out.has(i)) out.set(i, r.why);
      }
    }
  } catch (e) {
    console.warn(`[semantic] what Publish refuses could not be read: ${e.message}`);
  }
  return out;
}
// The lines a path of a YAML document covers: its key's line, and its value's lines.
function linesAt(doc, text, path) {
  const lineOf = offset => text.slice(0, offset).split("\n").length - 1;
  const out = [];
  const last = path[path.length - 1];
  if (typeof last === "string") {
    const parent = path.length > 1 ? doc.getIn(path.slice(0, -1), true) : doc.contents;
    const pair = parent && Array.isArray(parent.items) ? parent.items.find(p => p && p.key && (p.key.value ?? p.key) === last) : null;
    if (pair && pair.key && pair.key.range) out.push(lineOf(pair.key.range[0]));
  }
  const node = path.length ? doc.getIn(path, true) : doc.contents;
  if (node && node.range) {
    const a = lineOf(node.range[0]), b = lineOf(Math.max(node.range[0], node.range[1] - 1));
    for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
}

// The parts of a dotted SQL name, as written ("my ws" keeps its quotes), and one without them.
export const nameParts = ident => String(ident).match(/"(?:[^"]|"")*"|[^.]+/g) ?? [];
export const unquote = p => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p);

// The bim's Direct Lake tables, by lower-cased table name: where each one lives in OneLake, as dax-sql's
// directLakeTables reads them from the TMSL. { lh: { workspace, item }, t: { schema, table } } for one its
// Direct Lake expression places by GUIDs, { item, t } for one named item.schema.table in the model's workspace.
export function directLakeTables(bim) {
  const out = new Map();
  for (const [name, l] of need().directLakeTables(bim)) {
    // One over a SQL endpoint is read once the host has said the item behind it (core/models/sqlendpoint.js).
    if (l.viaSqlEndpoint) continue;
    const t = { schema: l.schema, table: l.entity };
    out.set(name, l.inWorkspace ? { item: l.item, t } : { lh: { workspace: l.workspace, item: l.item }, t });
  }
  return out;
}

// The lakehouses a model reads, each once: by GUID, { workspace, item }, from a Direct Lake
// expression; by name, { workspaceName, itemName }, from tables named item.schema.table, in
// `workspace`, the model's.
export function lakehousesOf(bim, workspace = null) {
  const out = new Map();
  for (const l of directLakeTables(bim).values()) {
    if (l.lh) out.set(`${l.lh.workspace}/${l.lh.item}`, l.lh);
    else out.set(lc(JSON.stringify([l.item])), { workspaceName: workspace, itemName: l.item });
  }
  return [...out.values()];
}

// What kind of model it is (dax-sql's storageMode), as a phrase for saying why it cannot be opened: "an
// Import model", "a DirectQuery model", "a composite model", or Direct Lake over a SQL endpoint the host could
// not read from OneLake (core/models/sqlendpoint.js).
export function storageMode(bim) {
  const mode = need().storageMode(bim);
  if (mode === "directlake") {
    const lakes = lakehousesOf(bim).length;
    return lakes ? `Direct Lake on ${lakes} lakehouses` : "Direct Lake over a SQL endpoint";
  }
  return { composite: "a composite model", directquery: "a DirectQuery model", dual: "a Dual-mode model" }[mode] ?? "an Import model";
}

// Who turns a Direct Lake table into its SQL name: the host, which reads what an item's GUIDs are
// called from OneLake's own listings, or finds an item named in a workspace and its kind in the tree's
// listing. Set once by the panel and by the command line.
let tableNamer = null;
export const setTableNamer = fn => { tableNamer = fn; };

// Who reads a lakehouse table's columns from its metadata, no rows read: [{ name, type }] of
// { workspace, lakehouse (its name), schema, table }. Set once by the panel and by the command line.
let columnReader = null;
export const setColumnReader = fn => { columnReader = fn; };

// directLakeTables(), each with its SQL name as `ident`; `workspace` is the model's, where a
// table named item.schema.table is.
async function namedLakeTables(bim, workspace) {
  const lake = directLakeTables(bim);
  const list = [...lake.values()];
  if (!list.length) return lake;
  if (!tableNamer) throw new Error("Direct Lake tables cannot be named here");
  const names = await tableNamer(list.map(l => (l.lh ? { ...l.lh, ...l.t } : { workspaceName: workspace, itemName: l.item, ...l.t })));
  list.forEach((l, i) => { l.ident = names[i]; });
  return lake;
}

// A model file's format, from its path and text with nothing parsed (dax-sql's formatOf): 'tmsl', 'tmdl', 'ossie',
// or null for no model (a dbt schema.yml, one file of a Power BI project's TMDL folder). `modules`: the host's.
export async function formatOf(path, text, modules = null) {
  return (await ready(modules)).formatOf(path, text);
}

// The tables a model names schema.table and nothing more, as a Fabric semantic view's YAML does
// (`source: dbo.sales`): dax-sql's unplacedTables, in no lakehouse until one is said. [{ table (the model's), schema, entity }].
export function bareTables(bim) {
  const unplaced = need().unplacedTables(bim);
  return (bim?.model?.tables ?? []).filter(t => unplaced.has(lc(t.name))).map(t => ({ table: t.name, ...unplaced.get(lc(t.name)) }));
}

// A model file's TMSL, by dax-sql's reader of its format (readModel): `lakehouse`, where its schema.table tables are
// (dax-sql's catalog), for a file that doesn't say; `columnsOf`, the columns of an Ossie dataset that lists none, as
// dax-sql asks them. What a metric dax-sql left out is, is `skipped` on it, as defineView says it.
export function bimOf(path, text, m = need(), { lakehouse = null, columnsOf = null } = {}) {
  const { bim, skipped } = m.readModel(path, text, { parseYaml: m.parseYaml, ...(lakehouse ? { catalog: lakehouse } : {}),
    ...(columnsOf ? { columnsOf } : {}) });
  if (bim && typeof bim === "object") Object.defineProperty(bim, "skipped", { value: skipped, enumerable: false, configurable: true });
  return bim;
}

// The same, with the columns of each Ossie dataset that lists none read first, from its lakehouse table's metadata
// (setColumnReader): Fabric gives such a dataset every column its table has. dax-sql says which datasets
// (ossieSources) and asks for them as it reads. A table that can't be asked has its relationships' columns.
async function bimWithColumns(path, text, m, { lakehouse = null, workspace = null } = {}) {
  if (m.formatOf(path, text) !== "ossie" || !columnReader || !workspace) return bimOf(path, text, m, { lakehouse });
  let doc;
  try { doc = m.parseYaml(stripBom(text)); } catch (_) { return bimOf(path, text, m, { lakehouse }); }   // readModel says why
  const read = new Map();
  await Promise.all(m.ossieSources(doc).map(async ({ source }) => {
    const parts = nameParts(String(source ?? "")).map(unquote);
    const at = parts.length === 3 ? { lakehouse: parts[0], schema: parts[1], table: parts[2] }
      : lakehouse && parts.length === 2 ? { lakehouse, schema: parts[0], table: parts[1] }
      : lakehouse && parts.length === 1 ? { lakehouse, schema: "dbo", table: parts[0] } : null;
    if (!at) return;
    try { read.set(String(source), await columnReader({ workspace, ...at })); }
    catch (e) { console.warn(`[semantic] the columns of ${source} could not be read: ${e.message}`); }
  }));
  return bimOf(path, text, m, { lakehouse, columnsOf: ({ source }) => read.get(String(source)) ?? null });
}

// Where a table's SQL name says it lives: its first two parts (ws.lakehouse), as written.
function itemOfIdent(ident) {
  let dots = 0, q = false;
  for (let i = 0; i < ident.length; i++) {
    if (ident[i] === '"') q = !q;
    else if (ident[i] === "." && !q && ++dots === 2) return ident.slice(0, i);
  }
  return ident;
}

/**
 * A semantic view of a model file's text (a .bim, or an Ossie .yaml), of the model `name` in
 * `schema`, the model's workspace: SQL names it ws.model_semanticmodel. `mode`: 'create',
 * 'replace' or 'if_not_exists' (dax-sql's). Returns what the model view draws:
 * { name (its SQL name), view (the model's name), schema, file, sample, directLake, bim, exploreCompiler, lakeTables }:
 * `lakeTables`, each Direct Lake table's SQL name by its model table's name, lower-cased.
 */
export async function defineView(name, path, text, mode = "replace", modules = null, schema = null, lakehouse = null) {
  if (!schema) throw new Error(`a semantic model is named <workspace>.<model>${SUFFIX}: ${name} has no workspace`);
  const mods = await ready(modules);
  const { createCompiler, tmslToModel } = mods;
  const bim = await bimWithColumns(path, text, mods, { lakehouse, workspace: schema });
  const lake = await namedLakeTables(bim, schema);
  // A Direct Lake table is read by its SQL name, the engine making its view as a query
  // names it. Any other has no OneLake table behind it: a shorter name would resolve to
  // whatever happens to carry it in the engine, such as a Files/ view, so it is refused.
  const tableSource = t => {
    const l = lake.get(lc(t.name));
    if (l) return l.ident;
    // `t` is dax-sql's table: what the model file says of it is in the bim's.
    const bare = bareTables(bim).find(b => lc(b.table) === lc(t.name));
    throw new Error(`${t.name} is not a OneLake table, so it has no workspace.lakehouse.schema.table name to read` +
      (bare ? `: it is named ${bare.schema}.${bare.entity}, in no lakehouse — open the model file from disk and pick the lakehouse it reads` : ""));
  };
  // The items its tables are read from, by their SQL names — a model may read several.
  const where = [...new Set([...lake.values()].map(l => itemOfIdent(l.ident)))];
  // What the data says of the model (takeStats), empty until it is read: a key not answered yet is
  // tested in the SQL, as with no stats. Defined again from the same file and tables (the command line
  // defines every kept view for each statement), the model keeps it: it holds while its tables' snapshots do.
  const sig = JSON.stringify([path, text, [...lake.values()].map(l => l.ident)]);
  const was = stats.get(lc([schema, viewName(name)].map(sqlPart).join(".")));
  const s = was && was.sig === sig ? was.s : { facts: { orphans: {}, trailingSpaces: {} }, at: null };
  // dax-sql's facts option, read live: freshStats fills these objects in place as the data answers.
  const known = { facts: s.facts };
  const at = { path, mode, db: MODEL_DB, schema, tableSource, tablesFrom: where.join(", ") || null, ...known };
  const done = views.define(viewName(name), tmslToModel(bim), at);
  const v = views.get(modelKey(schema, name));
  if (done === "created") {
    lakes.set(lc(v.sqlName), lake);
    stats.set(lc(fullName(v)), { s, compiler: v.compiler, sig, tables: new Map([...lake].map(([table, l]) => [table, l.ident])), pending: null });
  }
  // Explore's (explore/query.js): its rows go straight to the page, cast as EXPLORE_CASTS says.
  const exploreCompiler = createCompiler(tmslToModel(bim), { tableSource, castOutput: EXPLORE_CASTS, ...known });
  return { name: fullName(v), view: modelOf(v.name), schema, file: basename(path), sample: sampleQuery(v),
           directLake: lake.size, bim, exploreCompiler, done, skipped: bim.skipped ?? [],
           lakeTables: Object.fromEntries([...lake].map(([table, l]) => [table, l.ident])) };
}

// Whether a model file's text opens as a model, with nothing defined: throws what opening it would
// say. A model file's Save asks it first, so a file is never written into one that doesn't open.
export async function checkModel(fileName, text, modules = null) {
  const mods = await ready(modules);
  mods.tmslToModel(bimOf(fileName, text, mods));
}

// A model opened from a file, in its workspace: under the semantic model's own name when it is
// one (the tree's click), else the file's — ws.nem_semanticmodel for nem.bim or nem.yaml.
// `lakehouse`: where its schema.table tables are, for a file that doesn't say (bimOf).
export const registerModel = (fileName, text, modules = null, schema = null, name = null, lakehouse = null) =>
  defineView(name || modelName(fileName), fileName, text, "replace", modules, schema, lakehouse);

// A Fabric semantic view: <lakehouse>/Context/Semantic Views/<view>/, its .yaml in Microsoft's format
// (https://learn.microsoft.com/en-us/fabric/fundamentals/semantic-views-yaml-reference). [, item, view] of a path in one.
export const FABRIC_VIEW_PATH = /^([^/]+)\/Context\/Semantic Views\/([^/]+)\//;
// The TMDL Fabric's Publish writes of a view (<lakehouse>/SystemContext/Semantic Views/<view>/<view>.tmdl): the
// model Fabric made, whole. [, item, view] of a path to one.
export const SYSTEM_VIEW_TMDL = /^([^/]+)\/SystemContext\/Semantic Views\/([^/]+)\/[^/]+\.tmdl$/i;

/**
 * A Fabric semantic view as TMSL, the model Fabric's Publish makes of it, read by dax-sql (readModel, as: 'fabric'):
 * its files (`files`, [{ path, text }]) merged as Fabric merges them, each dataset a Direct Lake table of the view's
 * lakehouse (`lakehouse`, its name) with the columns its table has (`columnsOf(schema, table)`, [{ name, type }]: read
 * here first, for the datasets dax-sql lists), and the DAX metrics in Fabric's Metrics table. What Publish refuses but
 * a model can do without is left out by dax-sql, and is `skipped` on the TMSL.
 */
export async function fabricViewBim(view, files, { lakehouse, columnsOf }, modules = null) {
  const m = await ready(modules);
  if (!files.length) throw new Error(`${view} has no .yaml file in its folder`);
  const folder = Object.fromEntries(files.map(f => [String(f.path), String(f.text)]));
  const read = { parseYaml: m.parseYaml, as: "fabric", catalog: lakehouse };
  // The columns of every dataset the view keeps, read before dax-sql asks: its readers are not asynchronous.
  const cols = new Map();
  let sources = null;
  try { sources = m.ossieSources(Object.fromEntries(files.map(f => [String(f.path), m.parseYaml(stripBom(f.text))])), { as: "fabric" }); }
  catch (_) { /* not YAML, or not a view: readModel says which, by file */ }
  if (sources) {
    await Promise.all(sources.map(async ({ source }) => {
      const [schema, table] = nameParts(String(source)).map(unquote);
      cols.set(String(source), await columnsOf(schema, table).catch(() => []));
    }));
  }
  const { bim, skipped } = m.readModel(`Semantic Views/${view}`, folder, { ...read, columnsOf: ({ source }) => cols.get(String(source)) ?? [] });
  Object.defineProperty(bim, "skipped", { value: skipped, enumerable: false, configurable: true });
  return bim;
}

// A column's type in TMSL's words, from the Iceberg schema (long, decimal(18,2), timestamp) or DuckDB's DESCRIBE
// (BIGINT, DECIMAL(18,2), TIMESTAMP WITH TIME ZONE): dax-sql's tmslType. null: a type a model can't hold, left out.
const tmslType = type => (typeof type === "string" ? need().tmslType(type) : null);   // not a string: Iceberg's struct, list or map

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

// A part of a model's SQL name: bare, or quoted in double quotes or backticks (modelNameParts).
const PART_RE = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|[A-Za-z_\\u00C0-\\uFFFF][A-Za-z0-9_$\\u00C0-\\uFFFF]*)';
const DOT_RE = "\\s*\\.\\s*";
const unq = x => (x[0] === '"' ? x.slice(1, -1).replace(/""/g, '"') : x[0] === '`' ? x.slice(1, -1).replace(/``/g, '`') : x);
const partsOf = name => [...name.matchAll(new RegExp(PART_RE, "g"))].map(m => unq(m[0]));
// A dotted name's model, { workspace, model, qualified }, or null when it names none.
function modelRef(parts) {
  const p = parts.length === 3 && lc(parts[0]) === MODEL_DB ? parts.slice(1) : parts;
  const model = p.length === 2 && modelOf(p[1]);
  return model ? { workspace: p[0], model, qualified: p !== parts } : null;
}
// The models a statement reads (ws.model_semanticmodel, or onelake.ws.model_semanticmodel), as dax-sql's
// tokenizer finds them (views.names: comments, strings and quoted names as SQL has them), each
// { parts, view, ref }: `ref`, the model's { workspace, model }.
function modelsNamed(sql) {
  return views.names(String(sql), { match: parts => !!modelRef(parts) })
    .map(n => ({ ...n, ref: modelRef(n.parts) }));
}

// The semantic models a statement names that are not views here yet, as [{ workspace, model }] as written:
// the host opens each before the statement runs.
export async function unopenedModels(sql, modules = null) {
  const s = String(sql);
  if (!lc(s).includes(SUFFIX) || VIEW_DDL.test(s)) return [];   // CREATE / DROP: refused, not opened
  await ready(modules);
  const out = [];
  for (const { ref } of modelsNamed(s)) {
    if (hasView(modelKey(ref.workspace, ref.model))) continue;
    if (!out.some(r => lc(r.workspace) === lc(ref.workspace) && lc(r.model) === lc(ref.model))) {
      out.push({ workspace: ref.workspace, model: ref.model });
    }
  }
  return out;
}

// What the data says of the models a statement names: which relationships' many side holds a key
// its one side lacks (dax-sql's orphans), and which text columns end in spaces (trailingSpaces). With
// them a relationship whose keys all match has no blank-row test, and a padded column reads trimmed, as
// Power BI loads it. They are facts of the rows at the DuckLake snapshots they were read at, so they
// are read again when one of the model's tables is at another snapshot. `run` runs SQL on the engine
// ({ rows: [{ name: value }] }); `snapshots(names)` is each table's snapshot by its SQL name, null for
// one the lake doesn't hold, whose keys stay tested in the SQL. A check that fails leaves its keys
// tested in the SQL, as before.
export async function takeStats(sql, run, snapshots) {
  const s = String(sql);
  if (!views || !lc(s).includes(SUFFIX)) return;
  const done = new Set();
  for (const { ref } of modelsNamed(s)) {
    const v = views.get(modelKey(ref.workspace, ref.model));
    if (!v || done.has(fullName(v))) continue;
    done.add(fullName(v));
    await takeStatsOf(fullName(v), run, snapshots);
  }
}

// The same, of one view by its name (defineView's `name`). One look at a time for a model: a second
// query waits for the first's.
export function takeStatsOf(name, run, snapshots) {
  const rec = stats.get(lc(name));
  if (!rec) return Promise.resolve();
  rec.pending = (rec.pending || Promise.resolve())
    .then(() => freshStats(rec, run, snapshots))
    .catch(e => console.warn(`[stats] ${name}: ${e.message}`));
  return rec.pending;
}

async function freshStats({ s, compiler, tables }, run, snapshots) {
  const names = [...tables.keys()];
  const at = async () => {
    const list = await snapshots(names.map(t => tables.get(t)));
    return new Map(names.map((t, i) => [t, list?.[i] ?? null]));
  };
  const now = await at();
  if (s.at && names.every(t => s.at.get(t) === now.get(t))) return;
  // The compilers read these very objects (dax-sql's facts option): emptied and filled in place, never replaced.
  const { orphans, trailingSpaces } = s.facts;
  for (const k of Object.keys(orphans)) delete orphans[k];
  for (const k of Object.keys(trailingSpaces)) delete trailingSpaces[k];
  s.at = null;
  // dax-sql writes the one statement of both checks and reads its row back; the engine runs it.
  const check = compiler.factsCheck();
  const asked = Object.keys(check.tables.orphans).length + Object.keys(check.tables.trailingSpaces).length;
  const got = asked ? check.read((await run(check.sql)).rows[0] || {}) : { orphans: {}, trailingSpaces: {} };
  // A table the answers hold for: in the lake, at the snapshot it was at before the check (or the first,
  // when the check is what brought it here), so its rows didn't move under it.
  const after = await at();
  const pinned = table => {
    const a = after.get(lc(table)), b = now.get(lc(table));
    return a != null && (b == null || a === b);
  };
  for (const [k, v] of Object.entries(got.orphans)) if (check.tables.orphans[k].every(pinned)) orphans[k] = v;
  for (const k of Object.keys(got.trailingSpaces)) if (check.tables.trailingSpaces[k].every(pinned)) trailingSpaces[k] = true;
  s.at = after;
}

// A model's SQL name read back: { workspace, model }, or null when it is not one.
export function modelNameParts(sqlName) {
  const s = String(sqlName).trim();
  const whole = new RegExp(`^${PART_RE}(?:${DOT_RE}${PART_RE})*$`);
  const ref = whole.test(s) && modelRef(partsOf(s));
  return ref ? { workspace: ref.workspace, model: ref.model } : null;
}

export function dropView(name) {
  const v = views && views.get(name);
  if (!v) return;
  views.drop([v.db, v.schema, v.name], { ifExists: true });
  lakes.delete(lc(v.sqlName));
  stats.delete(lc(fullName(v)));
}

export const hasView = name => !!(views && views.get(name));

// Whether a statement can be about a semantic model: one is named ws.model_semanticmodel, and
// described by SHOW SEMANTIC …. Any other statement has no use for the views, loaded or not. A
// false yes costs only a wait.
export function aboutModels(sql) {
  return lc(String(sql)).includes("semantic");
}

// SHOW SEMANTIC VIEWS: every model the catalog has (the engine lists each one the cache knows,
// engine-host.js listCatalog), in dax-sql's columns. A model opened here has its file and the
// items its tables are read from; one not opened yet has neither.
const SHOW_VIEWS = /^\s*show\s+semantic\s+views\s*;?\s*$/i;
function showViewsSql() {
  const opened = views ? views.list() : [];
  const rows = opened.map(v => `(${[v.schema, v.name, v.path, v.tablesFrom].map(x => (x == null ? "NULL" : sqlStr(x))).join(", ")})`);
  const o = rows.length
    ? `(VALUES ${rows.join(", ")}) o(schema_name, view_name, path, tables_from)`
    : "(SELECT NULL::VARCHAR AS schema_name, NULL::VARCHAR AS view_name, NULL::VARCHAR AS path, NULL::VARCHAR AS tables_from WHERE false) o";
  // A model is a view named <model>_semanticmodel in a workspace's schema, which is a schema of the engine's
  // catalog directly: a table of that name is in an item's schema, under its workspace.
  return `SELECT v.database_name, v.schema_name, v.view_name, o.path, o.tables_from
FROM duckdb_views() v JOIN duckdb_schemas() s ON s.database_oid = v.database_oid AND s.oid = v.schema_oid
LEFT JOIN ${o}
  ON lower(o.schema_name) = lower(v.schema_name) AND lower(o.view_name) = lower(v.view_name)
WHERE v.database_name = '${MODEL_DB}' AND s.parent_schema_oid IS NULL AND lower(v.schema_name) <> 'main'
  AND lower(v.view_name) LIKE '%\\${SUFFIX}' ESCAPE '\\' AND length(v.view_name) > ${SUFFIX.length}
ORDER BY v.schema_name, v.view_name`;
}

// dax-sql's CREATE and DROP SEMANTIC VIEW, which this extension does not take: a model is
// there because Fabric has it (or a lakehouse's Files/ holds it), never because SQL made it.
const VIEW_DDL = /^\s*(create(\s+or\s+replace)?|drop)\s+semantic\s+view\b/i;
const NO_DDL ="Not run: a semantic model is not made or dropped " +
  `in SQL — open one in the tree, or name it <workspace>.<model>${SUFFIX} in a query.`;

/**
 * What a statement asks, in dax-sql's words (createViews().rewrite): null when it names no
 * view, else { sql } to run, and `compiled`, dax-sql's SQL alone (sql is it, with the
 * statement as written in a comment in front). One statement.
 */
export async function statement(sql, modules = null) {
  if (SHOW_VIEWS.test(String(sql))) return { sql: showViewsSql() };
  // Refused before dax-sql reads it: whether the view exists is not the question.
  if (VIEW_DDL.test(String(sql))) throw new Error(NO_DDL);
  if (!views) {
    // Nothing defined yet: only a statement about views needs the compiler loaded.
    if (!/\bsemantic\b/i.test(String(sql))) return null;
    await ready(modules);
  }
  const out = views.rewrite(String(sql));
  if (!out) return null;
  if (out.length !== 1) throw new Error("Run one statement at a time (no ';').");
  const [s] = out;
  if (s.sql == null) throw new Error(NO_DDL);
  return { sql: withSource(sql, s.sql), compiled: s.sql };
}

// A view's Direct Lake tables: the model's table name, the engine's view of it — which SQL
// can name directly to read the raw table — and where it lives in OneLake: `lh` (by GUID) for one its
// Direct Lake expression places, `item` (by name, in the model's workspace) for one named item.schema.table.
export function lakeTablesOf(name) {
  const v = views && views.get(name);
  const lake = v && lakes.get(lc(v.sqlName));
  if (!lake) return [];
  return [...lake].map(([table, l]) => ({ table, ident: l.ident, schema: l.t.schema, entity: l.t.table, lh: l.lh, item: l.item }));
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
  const name = sqlPart;
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
