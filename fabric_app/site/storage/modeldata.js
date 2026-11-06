// =============================================================================
// modeldata.js — the app's data source on a semantic model: the function runs every query
// =============================================================================
// An app exported as DirectQuery or Direct Lake reads nothing in this browser and runs no DuckDB:
// Explore's query over the model goes to the app's function (semanticModel, rayfin/functions),
// which turns it into DAX and runs it on the semantic model the export made of the model file. The
// page sends only SELECTs over the model; the function takes nothing else.
//
//   const data = createModelSource({ onStatus });
//   await data.init()        signs in, and reads the model through the function
//   data.model()             the model, as the lakehouse holds it now
//   await data.run(sql)      Explore's SQL ({ fields, rows, numRows }); its wrappers, below
//   await data.shownSql(q)   the DAX a query over the model runs as (a plan's SQL tab)
// =============================================================================
import { createAuth } from "./auth.js";

// Explore wraps its query in DuckDB's SQL (its preview as text, its count, its plan and profile:
// explore/view.js, shared with the DuckDB app); here each is asked of the function for the query
// inside it.
const AS_TEXT = /^\s*SELECT COLUMNS\(\*\)::VARCHAR FROM \(\n([\s\S]*)\n\)(?: LIMIT (\d+))?\s*$/;
const COUNTED = /^\s*SELECT COUNT\(\*\) AS cnt FROM \(\n([\s\S]*)\n\)\s*$/;
const PROFILED = /^\s*EXPLAIN\s*\(\s*ANALY[SZ]E\s*,\s*FORMAT\s+json\s*\)\s*/i;
const EXPLAINED = /^\s*EXPLAIN\s+(?!\()([\s\S]*)$/i;

export function createModelSource({ onStatus = () => {} } = {}) {
  const auth = createAuth();
  let doc = null;

  async function call(request) {
    const rayfin = await auth.client();
    const r = await rayfin.functions.semanticModel.invoke({ request: JSON.stringify(request) }, { timeoutMs: 240000 });
    if (r?.error) throw new Error(r.error);
    return r;
  }

  async function init() {
    onStatus("Signing in to Fabric…");
    await auth.signIn();
    onStatus("Reading the model…");
    doc = (await call({ mode: "model" })).model;
    if (!doc) throw new Error("the function gave no model");
  }

  // Its rows as Explore reads them: the column names, each row an object.
  async function rows(query, keep) {
    const r = await call({ mode: "rows", query, ...(keep == null ? {} : { rows: keep }) });
    const fields = r.fields ?? [];
    return { fields, rows: (r.rows ?? []).map(a => Object.fromEntries(fields.map((f, i) => [f, a[i]]))), numRows: r.numRows ?? 0 };
  }
  const dax = async query => (await call({ mode: "sql", query })).sql;
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
