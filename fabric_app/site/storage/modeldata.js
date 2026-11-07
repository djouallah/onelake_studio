// =============================================================================
// modeldata.js — the app's data source on a semantic model, queried as the person viewing it
// =============================================================================
// An app exported as DirectQuery or Direct Lake reads nothing in this browser and runs no DuckDB:
// Explore's query over the model is turned into DAX here (dax-sql, semantic/) and runs on the
// semantic model the export made of the model file, through the app's fabric-semanticmodel
// connector. The connector is delegated, Fabric Apps' only way to a semantic model: the query runs
// as whoever is signed in, with their permissions on the model (Build) and its row-level security.
// The app's function gives only the model file (semanticModel, rayfin/functions).
//
//   const data = createModelSource({ onStatus });
//   await data.init()        signs in, and reads the model through the function
//   data.model()             the model, as the lakehouse holds it now
//   await data.run(sql)      Explore's SQL ({ fields, rows, numRows }); its wrappers, below
//   await data.shownSql(q)   the DAX a query over the model runs as (a plan's SQL tab)
// =============================================================================
import { createAuth } from "./auth.js";
import { createCompiler } from "../semantic/src/index.js";
import { tmslToModel } from "../semantic/formats/tmsl.js";
import { ossieToTmsl } from "../semantic/formats/ossie.js";

// The site's own copy (vendor/, src/vendored.js WEBAPP.rayfinSemanticModel): the connector's
// runtime, which decodes its Arrow answer.
const SEMANTIC_MODEL_ESM = new URL("../vendor/npm/@microsoft/rayfin-connector-fabric-semanticmodel@1.36.1/+esm.js", import.meta.url).href;
// The connector's name in the app's settings (src/fabricapp.js, MODEL_CONNECTOR).
const CONNECTOR = "model";
const MAX_ROWS = 100_000;   // the most rows one answer keeps; past it they are only counted

// Explore wraps its query in DuckDB's SQL (its preview as text, its count, its plan and profile:
// explore/view.js, shared with the DuckDB app); here each is asked of the model for the query
// inside it.
const AS_TEXT = /^\s*SELECT COLUMNS\(\*\)::VARCHAR FROM \(\n([\s\S]*)\n\)(?: LIMIT (\d+))?\s*$/;
const COUNTED = /^\s*SELECT COUNT\(\*\) AS cnt FROM \(\n([\s\S]*)\n\)\s*$/;
const PROFILED = /^\s*EXPLAIN\s*\(\s*ANALY[SZ]E\s*,\s*FORMAT\s+json\s*\)\s*/i;
const EXPLAINED = /^\s*EXPLAIN\s+(?!\()([\s\S]*)$/i;

// A value as Explore shows it: a date as 2024-01-31, a time stamp as 2024-01-31 10:05:06.
function value(v) {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(v)) return v ?? null;
  const s = v.replace(/(Z|[+-]\d\d:\d\d)$/, "");
  if (/T00:00:00(\.0+)?$/.test(s)) return s.slice(0, 10);
  return s.replace("T", " ").replace(/\.0+$/, "");
}

// A column of the answer by the name SQL gave it: 'Table'[Column] and [name] are the bracketed name.
const fieldName = key => /\[((?:[^\]]|\]\])*)\]$/.exec(key)?.[1]?.replace(/\]\]/g, "]") ?? key;

export function createModelSource({ onStatus = () => {} } = {}) {
  const auth = createAuth({
    connectors: async () => {
      const { fabricSemanticModel } = await import(SEMANTIC_MODEL_ESM);
      return { configs: { [CONNECTOR]: { connector: "fabric-semanticmodel" } }, runtimes: { [CONNECTOR]: fabricSemanticModel() } };
    },
  });
  let doc = null;
  let compiler = null;

  async function init() {
    onStatus("Signing in to Fabric…");
    await auth.signIn();
    onStatus("Reading the model…");
    const rayfin = await auth.client();
    const r = await rayfin.functions.semanticModel.invoke({ request: JSON.stringify({ mode: "model" }) }, { timeoutMs: 240000 });
    if (r?.error) throw new Error(r.error);
    doc = r?.model;
    if (!doc) throw new Error("the function gave no model");
    compiler = createCompiler(tmslToModel(Array.isArray(doc.datasets) ? ossieToTmsl(doc) : doc));
  }

  // A SELECT over the model, whole, as DAX: { dax, limit, offset }, the last two applied here.
  function daxOf(query) {
    if (!compiler.isSql(query)) throw new Error("the app runs SELECT … FROM the model, and nothing else");
    return compiler.sqlToDax(query);
  }

  // Its rows as Explore reads them: the column names, each row an object. `keep`: the most kept,
  // MAX_ROWS at most; 0 only counts them.
  async function rows(query, keep) {
    const { dax, limit, offset } = daxOf(query);
    const r = await (await auth.client()).connectors[CONNECTOR].executeQuery({ query: dax });
    if (r?.status !== "success") {
      const e = r?.error ?? {};
      throw new Error(`${e.message || "the semantic model gave no answer"}${e.recoveryHint ? ` (${e.recoveryHint})` : ""}`);
    }
    const fields = r.table.columns.map(c => fieldName(c.name));
    const from = Number(offset) || 0;
    const all = r.table.rows.slice(from, limit == null ? undefined : from + Number(limit));
    const n = Math.max(0, Math.min(MAX_ROWS, keep == null ? MAX_ROWS : Number(keep) || 0));
    return { fields, rows: all.slice(0, n).map(a => Object.fromEntries(fields.map((f, i) => [f, value(a[i])]))), numRows: all.length };
  }
  const dax = async query => daxOf(query).dax;
  const one = (name, v) => ({ fields: [name], rows: [{ [name]: v }], numRows: 1 });

  async function run(sql) {
    let m;
    if ((m = AS_TEXT.exec(sql))) {
      const res = await rows(m[1], m[2] ? Number(m[2]) : undefined);
      const text = v => (v == null ? v : typeof v === "object" ? JSON.stringify(v) : String(v));
      return { ...res, rows: res.rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, text(v)]))) };
    }
    if ((m = COUNTED.exec(sql))) return one("cnt", (await rows(m[1], 0)).numRows);
    if (PROFILED.test(sql)) return one("explain_value", await profile(sql.replace(PROFILED, "")));
    if ((m = EXPLAINED.exec(sql))) return one("explain_value", `The semantic model shows no plan. The query runs as:\n\n${await dax(m[1])}`);
    return rows(sql);
  }

  // A profile in the shape Explore's profile view reads (explore/profile.js): the semantic model
  // gives no operators, so it is the query's one run, as a whole.
  async function profile(query) {
    const t0 = performance.now();
    const res = await rows(query, 0);
    const secs = (performance.now() - t0) / 1000;
    return JSON.stringify({ latency: secs, operator: [{ operator_name: "SEMANTIC MODEL QUERY", operator_timing: secs,
      operator_cardinality: res.numRows, extra_info: {}, children: [] }] });
  }

  return { init, model: () => doc, run, shownSql: dax };
}
