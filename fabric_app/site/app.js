// =============================================================================
// app.js — Export to Fabric's app: a semantic model's Explore and Logs, nothing else
// =============================================================================
// OneLake Studio's own Explore (explore/view.js: Model, Pivot, Logs), over the data source of
// this app (storage/data.js): it signs in, its function reads the model from the lakehouse and
// says where the tables are, and DuckDB-WASM reads them in this browser. The model is never
// copied into the app: it is the lakehouse's file, as it is now. Nothing here is specific to
// one model; the export writes only rayfin.config.json (the backend) and explore.json (the
// shelves the first view shows).
// =============================================================================
import { createDataSource } from "./storage/data.js";
import { mountExplore } from "./explore/view.js";
import { tmslOf } from "./explore/model.js";
import { EXPLORE_CASTS } from "./explore/query.js";
import { createCompiler } from "./semantic/dax-sql/index.js";
import { tmslToModel } from "./semantic/formats/tmsl.js";
import { ossieToTmsl } from "./semantic/formats/ossie.js";

const v = new URL(import.meta.url).search;
const status = (s, kind = "") => {
  const el = document.getElementById("status");
  el.textContent = s || "";
  el.className = kind === "error" ? "error" : "";
};

// An Arrow result as Explore reads one: the column names, the rows as plain objects.
const resultOf = table => ({
  fields: table.schema.fields.map(f => f.name),
  rows: table.toArray().map(r => r.toJSON()),
  numRows: table.numRows,
});

function download(name, text) {
  const a = Object.assign(document.createElement("a"),
    { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}

export async function start() {
  try {
    const first = await fetch(new URL("./explore.json" + v, import.meta.url)).then(r => (r.ok ? r.json() : null), () => null);
    const data = createDataSource({ onStatus: status, onProgress: p => status(p ? (p.detail || p.label) : "") });
    await data.init();
    const doc = data.model();
    const bim = Array.isArray(doc.datasets) ? ossieToTmsl(doc) : doc;
    // What SQL calls the model: its own name when SQL can write it bare, else "model".
    const name = /^[A-Za-z_]\w*$/.test(String(doc.name ?? "")) ? doc.name : "model";
    document.title = `${doc.name || name} · Explore`;
    status("");
    mountExplore(document.getElementById("explore"), {
      name, title: String(doc.name || name), tmsl: tmslOf(bim),
      compiler: createCompiler(tmslToModel(bim), { tableSource: t => `v_${t.name}`, castOutput: EXPLORE_CASTS }),
      run: async (sql, dax) => resultOf(await data.query(sql, dax)),
      // data.js logs every query itself, with its wait and its engine.
      hostLogs: true,
      echarts: async () => window.echarts,
      saveText: download,
      loadState: key => { try { return JSON.parse(localStorage.getItem(key)) ?? first; } catch { return first; } },
      saveState: (key, s) => { try { localStorage.setItem(key, JSON.stringify(s)); } catch {} },
      setStatus: status,
      profileSet: true,
      htmlPlan: true,
      logsNote: "This session only — kept in memory, nothing is stored. \"http\" rows are the engine's own requests for its data files (Range = a seek in a file).",
    });
    // The model's other tables, opened in the background for the next query.
    data.attachAgg();
  } catch (e) {
    console.error(e);
    status(`Error: ${e?.message || e}`, "error");
  }
}
