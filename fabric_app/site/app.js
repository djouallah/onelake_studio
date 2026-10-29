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

// Until Explore is on screen: the step under way, centred, and the seconds since the page
// opened, so a slow start (a cold function, DuckDB's first download) never looks broken.
const t0 = performance.now();
const boot = {
  el: () => document.getElementById("boot"),
  step(s) { const b = this.el(); if (b && s) b.querySelector(".step").textContent = s; },
  tick: setInterval(() => {
    const b = document.getElementById("boot");
    if (b) b.querySelector(".elapsed").textContent = `${Math.round((performance.now() - t0) / 1000)} s`;
  }, 500),
  fail(s) { clearInterval(this.tick); const b = this.el(); if (b) { b.classList.add("error"); this.step(s); } },
  done() { clearInterval(this.tick); this.el()?.remove(); },
};

// ECharts, off the critical path: loaded beside everything else, waited for only when a
// chart is drawn. The site's own copy (vendor/, src/vendored.js WEBAPP).
const echartsReady = new Promise((resolve, reject) => {
  const s = Object.assign(document.createElement("script"),
    { src: new URL("./vendor/npm/echarts@5.5.1/dist/echarts.min.js", import.meta.url).href, async: true });
  s.onload = () => resolve(window.echarts);
  s.onerror = () => reject(new Error("the chart library could not be loaded"));
  document.head.append(s);
});
echartsReady.catch(() => {});

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
    const data = createDataSource({
      onStatus: s => { boot.step(s); status(boot.el() ? "" : s); },
      onProgress: p => status(p ? (p.detail || p.label) : ""),
    });
    boot.step("Signing in to Fabric…");
    await data.init();
    boot.step("Building Explore…");
    const doc = data.model();
    const bim = Array.isArray(doc.datasets) ? ossieToTmsl(doc) : doc;
    // What SQL calls the model: its own name when SQL can write it bare, else "model".
    const name = /^[A-Za-z_]\w*$/.test(String(doc.name ?? "")) ? doc.name : "model";
    document.title = `${doc.name || name} · Explore`;
    status("");
    boot.done();
    mountExplore(document.getElementById("explore"), {
      name, title: String(doc.name || name), tmsl: tmslOf(bim),
      compiler: createCompiler(tmslToModel(bim), { tableSource: t => `v_${t.name}`, castOutput: EXPLORE_CASTS }),
      run: async (sql, dax) => resultOf(await data.query(sql, dax)),
      // data.js logs every query itself, with its wait and its engine.
      hostLogs: true,
      echarts: () => echartsReady,
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
    if (boot.el()) boot.fail(`Error: ${e?.message || e}`);
    else status(`Error: ${e?.message || e}`, "error");
  }
}
