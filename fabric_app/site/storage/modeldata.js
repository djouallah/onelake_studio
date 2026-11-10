// =============================================================================
// modeldata.js — the app's data source on a semantic model, queried as the person viewing it
// =============================================================================
// An app exported as DirectQuery or Direct Lake reads nothing in this browser and runs no DuckDB:
// Explore's query over the model is turned into DAX here (dax-sql, semantic/) and runs on the
// semantic model the export made of the model file, through the app's fabric-semanticmodel
// connector. The connector is delegated, Fabric Apps' only way to a semantic model: the query runs
// as whoever is signed in, with their permissions on the model, Build included.
// The model is the site's model.json: the definition the semantic model was made from, written by
// the export beside the page. Not the lakehouse's file, which can change after the export when the
// semantic model does not, and DAX written from it would name what the semantic model lacks.
// How many rows each query asks for, and whether an answer was cut, is storage/modelrows.js.
//
//   const data = createModelSource({ onStatus });
//   await data.init()        signs in, and reads the model the semantic model was made from
//   data.model()             that model
//   await data.run(sql)      Explore's SQL ({ fields, rows, numRows, truncated, limit }); its wrappers, below
// =============================================================================
import { createAuth } from "./auth.js";
import { firstRows, counting, kept, MAX_ROWS } from "./modelrows.js";
import { createCompiler, parseQuery } from "../semantic/src/index.js";
import { printDaxQuery } from "../semantic/core/sql.js";
import { tmslToModel } from "../semantic/formats/tmsl.js";
import { ossieToTmsl } from "../semantic/formats/ossie.js";

// The site's own copy (vendor/, core/vendored.js WEBAPP.rayfinSemanticModel): the connector's
// runtime, which decodes its Arrow answer.
const SEMANTIC_MODEL_ESM = new URL("../vendor/npm/@microsoft/rayfin-connector-fabric-semanticmodel@1.36.1/+esm.js", import.meta.url).href;
// The connector's name in the app's settings (fabric_app/export/fabricapp.js, MODEL_CONNECTOR).
const CONNECTOR = "model";
// The model the semantic model was made from (fabric_app/export/exportapp.js, writeModel), of this build.
const MODEL_JSON = new URL("../model.json" + new URL(import.meta.url).search, import.meta.url).href;

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

// The model refusing whoever is signed in, from the connector's failed answer: Power BI's own refusal
// (category 'api'), not the empty-body 401 the connector says is a token problem, not a DAX error.
const REFUSED = /\b40[13]\b|unauthori[sz]ed|forbidden|not ?authori[sz]ed|permission|access (is )?denied/i;
const refusedBy = e => e.category === "api" && !/empty body/i.test(e.message ?? "")
  && REFUSED.test(`${e.code ?? ""} ${e.message ?? ""} ${e.details ?? ""}`);

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
    const r = await fetch(MODEL_JSON);
    if (!r.ok) throw new Error(`the site has no model.json (HTTP ${r.status}): export the app again`);
    doc = await r.json();
    compiler = createCompiler(tmslToModel(Array.isArray(doc.datasets) ? ossieToTmsl(doc) : doc));
  }

  // A SELECT over the model as DAX: { dax, limit, offset }, the SQL's LIMIT and OFFSET apart.
  function daxOf(query) {
    if (!compiler.isSql(query)) throw new Error("the app runs SELECT … FROM the model, and nothing else");
    return compiler.sqlToDax(query);
  }

  // One DAX query on the semantic model: its answer's { columns, rows }.
  async function answer(dax) {
    const r = await (await auth.client()).connectors[CONNECTOR].executeQuery({ query: dax });
    if (r?.status !== "success") {
      const e = r?.error ?? {};
      console.error("semantic model query failed", e);
      // `refused`: app.js says so in a box over the page.
      throw Object.assign(new Error(`${e.message || "the semantic model gave no answer"}${e.recoveryHint ? ` (${e.recoveryHint})` : ""}`),
                          { refused: refusedBy(e) });
    }
    return r.table;
  }

  // Its rows as Explore reads them: the column names, each row an object. `keep`: the most kept,
  // MAX_ROWS at most. The semantic model sends only those up to the last one kept, and one more:
  // whether rows were left.
  async function rows(query, keep) {
    const { dax, limit, offset } = daxOf(query);
    const from = Number(offset) || 0;
    const asked = Math.min(keep == null ? Infinity : Math.max(0, Number(keep) || 0), limit == null ? Infinity : Number(limit));
    const n = Math.min(MAX_ROWS, asked);
    const tree = treeOf(dax);
    const cut = tree && firstRows(tree, from + n + 1);
    const table = await answer(cut ? printDaxQuery(cut) : dax);
    const fields = table.columns.map(c => fieldName(c.name));
    const out = kept(table.rows, fields.length, { from, n, asked, askedFor: cut ? from + n + 1 : null });
    return { fields, rows: out.rows.map(a => Object.fromEntries(fields.map((f, i) => [f, value(a[i])]))), numRows: out.rows.length,
             truncated: out.truncated, limit: out.limit };
  }
  const dax = async query => daxOf(query).dax;
  // The DAX as a tree to cut, or null: one this can't read again runs as it is, uncut.
  const treeOf = text => { try { return parseQuery(text); } catch (_) { return null; } };
  const one = (name, v) => ({ fields: [name], rows: [{ [name]: v }], numRows: 1 });

  // How many rows: counted on the semantic model, so no cap on an answer stands in for the count.
  // A count it refuses to run is the rows' own, as before.
  async function count(query) {
    const { dax, limit, offset } = daxOf(query);
    const tree = treeOf(dax);
    const q = tree && counting(tree);
    if (q) {
      try {
        const t = await answer(printDaxQuery(q));
        const total = Math.max(0, (Number(t.rows[0]?.[0]) || 0) - (Number(offset) || 0));
        return limit == null ? total : Math.min(total, Number(limit));
      } catch (e) {
        if (e.refused) throw e;
        console.warn("the semantic model did not count the rows: they are counted as sent", e);
      }
    }
    return (await rows(query)).numRows;
  }

  async function run(sql) {
    let m;
    if ((m = AS_TEXT.exec(sql))) {
      const res = await rows(m[1], m[2] ? Number(m[2]) : undefined);
      const text = v => (v == null ? v : typeof v === "object" ? JSON.stringify(v) : String(v));
      return { ...res, rows: res.rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, text(v)]))) };
    }
    if ((m = COUNTED.exec(sql))) return one("cnt", await count(m[1]));
    if (PROFILED.test(sql)) return one("explain_value", await profile(sql.replace(PROFILED, "")));
    if ((m = EXPLAINED.exec(sql))) return one("explain_value", `The semantic model shows no plan. The query runs as:\n\n${await dax(m[1])}`);
    return rows(sql);
  }

  // A profile in the shape Explore's profile view reads (explore/profile.js): the semantic model
  // gives no operators, so it is the query's one run, as a whole, uncut.
  async function profile(query) {
    const t0 = performance.now();
    const table = await answer(await dax(query));
    const secs = (performance.now() - t0) / 1000;
    return JSON.stringify({ latency: secs, operator: [{ operator_name: "SEMANTIC MODEL QUERY", operator_timing: secs,
      operator_cardinality: table.rows.length, extra_info: {}, children: [] }] });
  }

  return { init, model: () => doc, run };
}
