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
// chart is drawn. The site's own copy (vendor/, core/vendored.js WEBAPP).
const echartsReady = new Promise((resolve, reject) => {
  const s = Object.assign(document.createElement("script"),
    { src: new URL("./vendor/npm/echarts@5.5.1/dist/echarts.min.js", import.meta.url).href, async: true });
  s.onload = () => resolve(window.echarts);
  s.onerror = () => reject(new Error("the chart library could not be loaded"));
  document.head.append(s);
});
echartsReady.catch(() => {});
// The world's outline a map draws over, read the first time a map is drawn.
const worldMap = async () => {
  const r = await fetch(new URL("./vendor/npm/echarts@4.9.0/map/json/world.json", import.meta.url));
  if (!r.ok) throw new Error(`the world's map: ${r.status}`);
  return r.json();
};

// An Arrow result as Explore reads one: the column names, the rows as plain objects.
const resultOf = table => ({
  fields: table.schema.fields.map(f => f.name),
  rows: table.toArray().map(r => r.toJSON()),
  numRows: table.numRows,
});

// One of the site's JSON files, or `missing` when it has none: the hosting answers a file a site
// lacks with its index.html (200), which is not JSON.
const siteJson = (name, missing) => fetch(new URL(`./${name}${v}`, import.meta.url))
  .then(r => (r.ok ? r.text() : null), () => null)
  .then(text => { try { return text == null ? missing : JSON.parse(text); } catch { return missing; } });

// What the page runs on and its Report, asked for now, together: each was asked for when the one before had
// answered, and report.json only once the engines were up.
const engineRead = siteJson("engine.json", {});
const reportRead = siteJson("report.json", null);

// The Report's tiles (explore/report.js), as the export wrote them: report.json.
const report = { load: async () => {
  const spec = await reportRead;
  if (!spec) throw new Error("the site has no report.json: export the app again");
  return { spec, stamp: null };
} };

function download(name, text) {
  const a = Object.assign(document.createElement("a"),
    { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}

const titled = text => { const h = document.getElementById("app-title"); if (h) h.textContent = text; };

export async function start() {
  try {
    // The shelves a first Visual would show (explore.json): the app shows the Report alone, so they aren't fetched.
    const first = null;
    const { engine, name: modelName } = (await engineRead) || {};
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
    titled(doc.name || name);
    status("");
    boot.done();
    const compiler = createCompiler(tmslToModel(bim), { tableSource: t => `v_${t.name}`, castOutput: EXPLORE_CASTS });
    mountExplore(document.getElementById("explore"), {
      name, tmsl: tmslOf(bim),
      compiler,
      run: async sql => resultOf(await data.query(sql)),
      // Every tile asks at once: the engines take a query each (storage/queue.js), and the columns the tiles
      // read between them come down as one batch (storage/data.js), not a tile's at a time.
      report, pages: ["report"], reportParallel: Infinity,
      echarts: () => echartsReady,
      worldMap,
      saveText: download,
      loadState: key => { try { return JSON.parse(localStorage.getItem(key)) ?? first; } catch { return first; } },
      saveState: (key, s) => { try { localStorage.setItem(key, JSON.stringify(s)); } catch {} },
      setStatus: status,
      profileSet: true,
      htmlPlan: true,
    });
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
  titled(doc.name || name);
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
    // Each tile is a request to the model: four at a time, not one after another.
    report, pages: ["report"], reportParallel: 4,
    echarts: () => echartsReady,
    worldMap,
    saveText: download,
    loadState: key => { try { return JSON.parse(localStorage.getItem(key)) ?? first; } catch { return first; } },
    saveState: (key, s) => { try { localStorage.setItem(key, JSON.stringify(s)); } catch {} },
    setStatus: status,
    profileSet: false,
    htmlPlan: false,
  });
}
