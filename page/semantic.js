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
// statement's model names are given that catalog before dax-sql reads them (withCatalog).
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
    // A statement reaches a model by its whole name alone (NAMING.md): `FROM nem` is not a model.
    views = mods.createViews({ fullNames: true });
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
export function lakeExpressions(bim) {
  const text = e => (Array.isArray(e) ? e.join("\n") : String(e ?? ""));
  const url = /onelake\.dfs\.fabric\.microsoft\.com\/([0-9a-f-]{36})\/([0-9a-f-]{36})/i;
  const found = new Map();
  for (const e of bim?.model?.expressions ?? []) {
    const m = url.exec(text(e.expression));
    if (m) found.set(e.name, { workspace: lc(m[1]), item: lc(m[2]) });
  }
  return found;
}

// The parts of a dotted SQL name, as written ("my ws" keeps its quotes), and one without them.
export const nameParts = ident => String(ident).match(/"(?:[^"]|"")*"|[^.]+/g) ?? [];
export const unquote = p => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p);

// A table an Ossie model names in its own workspace: its `source` is item.schema.table, as
// Fabric's SQL endpoint names it, which dax-sql reads back as a partition with no expression
// whose schema is item.schema. { item, schema, table }, unquoted, or null.
function namedInWorkspace(s) {
  if (!s?.entityName || s.expressionSource || !s.schemaName) return null;
  const parts = nameParts(s.schemaName);
  return parts.length === 2 ? { item: unquote(parts[0]), schema: unquote(parts[1]), table: unquote(s.entityName) } : null;
}

// The lakehouses a model reads, each once: by GUID, { workspace, item }, from a Direct Lake
// expression; by name, { workspaceName, itemName }, from tables named item.schema.table, in
// `workspace`, the model's. The one an Ossie model reads is its Iceberg catalog (Export to
// Fabric, fabric_app/export/exportapp.js).
export function lakehousesOf(bim, workspace = null) {
  const out = new Map();
  for (const l of lakeExpressions(bim).values()) out.set(`${l.workspace}/${l.item}`, l);
  for (const t of bim?.model?.tables ?? []) {
    const n = namedInWorkspace(t.partitions?.[0]?.source);
    if (n) out.set(lc(JSON.stringify([n.item])), { workspaceName: workspace, itemName: n.item });
  }
  return [...out.values()];
}

// What kind of model it is, as a phrase for saying why it cannot be opened: "an Import
// model", "a DirectQuery model", "a composite model", or Direct Lake over a SQL endpoint the
// host could not read from OneLake (core/models/sqlendpoint.js). A partition without a mode
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

// The bim's OneLake tables, by table name: { lh, t } for one its Direct Lake expression places
// by GUIDs, { item, t } for one named item.schema.table in the model's workspace.
export function directLakeTables(bim) {
  const found = lakeExpressions(bim);
  const tables = new Map();
  for (const t of bim?.model?.tables ?? []) {
    const s = t.partitions?.[0]?.source;
    const named = namedInWorkspace(s);
    if (named) { tables.set(lc(t.name), { item: named.item, t: { schema: named.schema, table: named.table } }); continue; }
    const lake = s?.expressionSource && found.get(s.expressionSource);
    if (!lake) continue;
    tables.set(lc(t.name), {
      lh: { workspace: lake.workspace, item: lake.item },
      t: { schema: s.schemaName ?? "dbo", table: s.entityName ?? t.name },
    });
  }
  return tables;
}

// Who turns a Direct Lake table into its SQL name: the host, which asks the Fabric API what
// an item's GUIDs are called, or finds an item named in a workspace and its kind in the tree's
// listing. Set once by the panel and by the command line.
let tableNamer = null;
export const setTableNamer = fn => { tableNamer = fn; };

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

// Whether a file of this name is an Ossie model rather than a .bim.
export const isOssiePath = path => /\.ya?ml$/i.test(String(path));

// Whether a YAML file's text is an Ossie model: its top level has the datasets and the spec's
// version. A dbt schema.yml, a pipeline's config, has neither, and stays a document.
export const isOssie = text =>
  /^datasets:/m.test(String(text)) && /^version:/m.test(String(text));

// The TMSL a model file's text is: a .bim as it is, an Ossie model as the .bim it stands for.
export function bimOf(path, text, mods) {
  const body = stripBom(text);
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
export async function defineView(name, path, text, mode = "replace", modules = null, schema = null) {
  if (!schema) throw new Error(`a semantic model is named <workspace>.<model>${SUFFIX}: ${name} has no workspace`);
  const mods = await ready(modules);
  const { createCompiler, tmslToModel } = mods;
  const bim = bimOf(path, text, mods);
  const lake = await namedLakeTables(bim, schema);
  // A Direct Lake table is read by its SQL name, the engine making its view as a query
  // names it. Any other has no OneLake table behind it: a shorter name would resolve to
  // whatever happens to carry it in the engine, such as a Files/ view, so it is refused.
  const tableSource = t => {
    const l = lake.get(lc(t.name));
    if (l) return l.ident;
    throw new Error(`${t.name} is not a OneLake table, so it has no workspace.lakehouse.schema.table name to read`);
  };
  // The items its tables are read from, by their SQL names — a model may read several.
  const where = [...new Set([...lake.values()].map(l => itemOfIdent(l.ident)))];
  const at = { path, mode, db: MODEL_DB, schema, tableSource, tablesFrom: where.join(", ") || null };
  const done = views.define(viewName(name), tmslToModel(bim), at);
  const v = views.get(modelKey(schema, name));
  if (done === "created") lakes.set(lc(v.sqlName), lake);
  // Explore's (explore/query.js): its rows go straight to the page, cast as EXPLORE_CASTS says.
  const exploreCompiler = createCompiler(tmslToModel(bim), { tableSource, castOutput: EXPLORE_CASTS });
  return { name: fullName(v), view: modelOf(v.name), schema, file: basename(path), sample: sampleQuery(v),
           directLake: lake.size, bim, exploreCompiler, done,
           lakeTables: Object.fromEntries([...lake].map(([table, l]) => [table, l.ident])) };
}

// A model opened from a file, in its workspace: under the semantic model's own name when it is
// one (the tree's click), else the file's — ws.nem_semanticmodel for nem.bim or nem.yaml.
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

// The semantic models a statement names (ws.model_semanticmodel, or onelake.ws.model_semanticmodel)
// that are not views here yet, as [{ workspace, model }] as written: the host opens each before
// the statement runs. Comments and string literals are skipped.
// A part: bare, or quoted in double quotes or backticks.
const PART_RE = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|[A-Za-z_\\u00C0-\\uFFFF][A-Za-z0-9_$\\u00C0-\\uFFFF]*)';
const DOT_RE = "\\s*\\.\\s*";
// A whole dotted name, as group 1, or a comment or a string, which is skipped.
const DOTTED = new RegExp(`--[^\\n]*|/\\*[\\s\\S]*?\\*/|'(?:[^']|'')*'|` +
  `(?<![.\\w$"\\u00C0-\\uFFFF])(${PART_RE}(?:${DOT_RE}${PART_RE})*)(?!${DOT_RE}${PART_RE})`, "g");
const unq = x => (x[0] === '"' ? x.slice(1, -1).replace(/""/g, '"') : x[0] === '`' ? x.slice(1, -1).replace(/``/g, '`') : x);
const partsOf = name => [...name.matchAll(new RegExp(PART_RE, "g"))].map(m => unq(m[0]));
// A dotted name's model, { workspace, model, qualified }, or null when it names none.
function modelRef(parts) {
  const p = parts.length === 3 && lc(parts[0]) === MODEL_DB ? parts.slice(1) : parts;
  const model = p.length === 2 && modelOf(p[1]);
  return model ? { workspace: p[0], model, qualified: p !== parts } : null;
}
export function unopenedModels(sql) {
  const s = String(sql);
  if (!lc(s).includes(SUFFIX) || VIEW_DDL.test(s)) return [];   // CREATE / DROP: refused, not opened
  const out = [];
  for (const m of s.matchAll(DOTTED)) {
    const ref = m[1] && modelRef(partsOf(m[1]));
    if (!ref || hasView(modelKey(ref.workspace, ref.model))) continue;
    if (!out.some(r => lc(r.workspace) === lc(ref.workspace) && lc(r.model) === lc(ref.model))) {
      out.push({ workspace: ref.workspace, model: ref.model });
    }
  }
  return out;
}

// The statement with each model it names in the catalog dax-sql keeps it in: ws.nem_semanticmodel
// is onelake.ws.nem_semanticmodel to dax-sql, which reaches a view by its whole db.schema.name.
function withCatalog(sql) {
  const s = String(sql);
  if (!lc(s).includes(SUFFIX)) return s;
  return s.replace(DOTTED, (all, name) => {
    const ref = name && modelRef(partsOf(name));
    return ref && !ref.qualified ? `${MODEL_DB}.${name}` : all;
  });
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
  const out = views.rewrite(withCatalog(sql));
  if (!out) return null;
  if (out.length !== 1) throw new Error("Run one statement at a time (no ';').");
  const [s] = out;
  if (s.sql == null) throw new Error(NO_DDL);
  return { sql: withSource(sql, s.sql), compiled: s.sql };
}

// A view's Direct Lake tables: the model's table name, the engine's view of it — which SQL
// can name directly to read the raw table — and where it lives in OneLake (by GUID).
export function lakeTablesOf(name) {
  const v = views && views.get(name);
  const lake = v && lakes.get(lc(v.sqlName));
  if (!lake) return [];
  return [...lake].map(([table, l]) => ({ table, ident: l.ident, schema: l.t.schema, entity: l.t.table, lh: l.lh }));
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
