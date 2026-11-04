// =============================================================================
// sqldata.js — the app's data source in SQL endpoint mode: the function runs every query
// =============================================================================
// An app exported in SQL endpoint mode (OneLake Studio's onelakeStudio.sqlEngine) reads nothing
// in this browser and runs no DuckDB: Explore's query over the model goes to the app's function
// (sqlEndpoint, rayfin/functions), which compiles it to T-SQL and runs it on the lakehouse's SQL
// endpoint. The page sends only SELECTs over the model; the function takes nothing else.
//
//   const data = createSqlSource({ onStatus });
//   await data.init()        signs in, and reads the model through the function
//   data.model()             the model, as the lakehouse holds it now
//   await data.run(sql)      Explore's SQL ({ fields, rows, numRows }); its wrappers, below
//   await data.shownSql(q)   the T-SQL a query over the model runs as (a plan's SQL tab)
// =============================================================================
import { createAuth } from "./auth.js";

// Explore wraps its query in DuckDB's SQL (its preview as text, its count, its plan and profile:
// explore/view.js, shared with the DuckDB app); here each is asked of the function for the query
// inside it. The same wrappers the extension unwraps in SQL endpoint mode (app/app.js).
const AS_TEXT = /^\s*SELECT COLUMNS\(\*\)::VARCHAR FROM \(\n([\s\S]*)\n\)(?: LIMIT (\d+))?\s*$/;
const COUNTED = /^\s*SELECT COUNT\(\*\) AS cnt FROM \(\n([\s\S]*)\n\)\s*$/;
const PROFILED = /^\s*EXPLAIN\s*\(\s*ANALY[SZ]E\s*,\s*FORMAT\s+json\s*\)\s*/i;
const EXPLAINED = /^\s*EXPLAIN\s+(?!\()([\s\S]*)$/i;

export function createSqlSource({ onStatus = () => {} } = {}) {
  const auth = createAuth();
  let doc = null;

  async function call(request) {
    const rayfin = await auth.client();
    const r = await rayfin.functions.sqlEndpoint.invoke({ request: JSON.stringify(request) }, { timeoutMs: 240000 });
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
  const plan = async query => (await call({ mode: "plan", query })).plan ?? [];
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
    if ((m = EXPLAINED.exec(sql))) return one("explain_value", planText(await plan(m[1])));
    return rows(sql);
  }

  // A profile in the shape Explore's profile view reads (explore/profile.js): the query runs once
  // more for its time, which goes to its operators as their estimated costs share it; an
  // operator's rows are the endpoint's estimate, the top one's the rows it returned.
  async function profile(query) {
    const tree = await plan(query);
    const t0 = performance.now();
    const res = await rows(query, 0);
    const secs = (performance.now() - t0) / 1000;
    const cost = tree.reduce(function sum(s, n) { return n.children.reduce(sum, s + n.cost); }, 0) || 1;
    const node = (n, top) => ({
      operator_name: (n.logical && n.logical !== n.op ? `${n.op} (${n.logical})` : n.op).toUpperCase(),
      operator_timing: secs * n.cost / cost,
      operator_cardinality: top ? res.numRows : n.rows,
      extra_info: { ...(n.table ? { Table: n.table } : {}), "Estimated Cardinality": Math.round(n.rows) },
      children: n.children.map(k => node(k, false)),
    });
    return JSON.stringify({ latency: secs, operator: tree.map(n => node(n, true)) });
  }

  return { init, model: () => doc, run, shownSql: async query => (await call({ mode: "sql", query })).sql };
}

// The endpoint's estimated plan as text: an operator a line, its inputs below it.
function planText(roots) {
  const lines = [];
  const line = (n, depth) => {
    const name = n.logical && n.logical !== n.op ? `${n.op} (${n.logical})` : n.op;
    lines.push(`${"  ".repeat(depth)}${name}  ~${Math.round(n.rows).toLocaleString("en")} rows  cost ${n.cost.toFixed(4)}${n.table ? `  ${n.table}` : ""}`);
    n.children.forEach(k => line(k, depth + 1));
  };
  roots.forEach(n => line(n, 0));
  return lines.join("\n") || "(no plan)";
}
