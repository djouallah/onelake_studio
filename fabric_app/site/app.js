// =============================================================================
// app.js — Export to Fabric's app: a semantic model's Report, and its Explore
// =============================================================================
// OneLake Studio's own Report (explore/view.js, its Report page alone), over the data source of
// this app (storage/data.js): it signs in, its function says where the tables are, and DuckDB-WASM
// reads them in this browser. On a semantic model (engine.json), the data source is
// storage/modeldata.js instead: each query runs as DAX on the semantic model, as the person signed
// in, and this page loads no DuckDB. Either way the model is model.json, the model as exported. Nothing
// here is specific to one model; the export writes only rayfin.config.json (the backend), explore.json
// (the shelves the first view shows), model.json, and on a semantic model engine.json. The Report page
// is report.json (explore/report.js draws it), which no export writes over: Studio's Report tab
// (Add to report, a tile's ✕) and the zip's owner grow it, and here it only reads.
// =============================================================================
import { mountExplore } from "./explore/view.js";
import { tmslOf } from "./explore/model.js";
import { EXPLORE_CASTS } from "./explore/query.js";
import { createCompiler } from "./semantic/src/index.js";
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

// The Report's tiles (explore/report.js), as the export wrote them: report.json.
const report = { load: async () => {
  const r = await fetch(new URL("./report.json" + v, import.meta.url));
  if (!r.ok) throw new Error(`report.json: ${r.status}`);
  return { spec: await r.json(), stamp: null };
} };

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
    const { engine, name: modelName } = await fetch(new URL("./engine.json" + v, import.meta.url)).then(r => (r.ok ? r.json() : {}), () => ({}));
    if (engine === "semanticModel") return await startModel(first, modelName);
    const { createDataSource } = await import("./storage/data.js");
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
    const compiler = createCompiler(tmslToModel(bim), { tableSource: t => `v_${t.name}`, castOutput: EXPLORE_CASTS });
    mountExplore(document.getElementById("explore"), {
      name, tmsl: tmslOf(bim),
      compiler,
      run: async sql => resultOf(await data.query(sql)),
      report, pages: ["report"],
      echarts: () => echartsReady,
      saveText: download,
      loadState: key => { try { return JSON.parse(localStorage.getItem(key)) ?? first; } catch { return first; } },
      saveState: (key, s) => { try { localStorage.setItem(key, JSON.stringify(s)); } catch {} },
      setStatus: status,
      profileSet: true,
      htmlPlan: true,
    });
    // The model's other tables, opened in the background for the next query.
    data.attachAgg();
  } catch (e) {
    console.error(e);
    if (boot.el()) boot.fail(`Error: ${e?.message || e}`);
    else status(`Error: ${e?.message || e}`, "error");
  }
}

// The semantic model refused the person signed in (storage/modeldata.js): one box over the page,
// once, as every query would be refused the same way.
function showRefused(model) {
  if (document.getElementById("refused")) return;
  const card = document.createElement("div");
  for (const t of [`You can't read the semantic model ${model}.`, "Ask its owner for Build permission on it, then reload."]) {
    card.append(Object.assign(document.createElement("p"), { textContent: t }));
  }
  const box = Object.assign(document.createElement("div"), { id: "refused" });
  box.setAttribute("role", "alert");
  box.append(card);
  document.body.append(box);
}

// On a semantic model: Explore's queries over the model go to the data source as they are written;
// it turns them into DAX and runs them there, so the page's compiler passes them through.
async function startModel(first, modelName) {
  const { createModelSource } = await import("./storage/modeldata.js");
  const data = createModelSource({ onStatus: s => boot.step(s) });
  await data.init();
  boot.step("Building Explore…");
  const doc = data.model();
  const bim = Array.isArray(doc.datasets) ? ossieToTmsl(doc) : doc;
  const name = /^[A-Za-z_]\w*$/.test(String(doc.name ?? "")) ? doc.name : "model";
  document.title = `${doc.name || name} · Explore`;
  status("");
  boot.done();
  const run = async sql => {
    try { return await data.run(sql); }
    catch (e) { if (e.refused) showRefused(modelName || String(doc.name || name)); throw e; }
  };
  mountExplore(document.getElementById("explore"), {
    name, tmsl: tmslOf(bim),
    compiler: { isDax: t => /^\s*(DEFINE|EVALUATE)\b/i.test(t), compileStatement: text => ({ sql: text }) },
    run,
    report, pages: ["report"],
    shownSql: sql => data.shownSql(sql),
    echarts: () => echartsReady,
    saveText: download,
    loadState: key => { try { return JSON.parse(localStorage.getItem(key)) ?? first; } catch { return first; } },
    saveState: (key, s) => { try { localStorage.setItem(key, JSON.stringify(s)); } catch {} },
    setStatus: status,
    profileSet: false,
    htmlPlan: false,
  });
}
