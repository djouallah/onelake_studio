// =============================================================================
// app.js — the OneLake Studio panel
// =============================================================================
// A view, driven by the extension: the OneLake tree in the editor's sidebar says what to
// open (open-table / open-file), and this page shows it — a table's statistics, its first
// rows, the SQL box, a file as a table or a document, a .bim (or an Ossie .yaml)
// as its semantic model. Every statement and every OneLake read goes to the extension host
// (data.js -> host.js); this file only decides what to show.
// =============================================================================
import { createEngine } from './data.js';
import { isDocResult, textLinesDoc, fileExt, isTextExt, escapeHtml, basename,
         IMAGE_EXTS, abfssUrl, ageNote, sqlPart } from './paths.js';
// Static import is safe: docview.js is tiny — the markdown renderer it uses is imported
// only inside renderMarkdown(), and only for a document that IS markdown.
import { renderDocument } from './docview.js';
import { mountGrid } from './grid.js';
import { mountChart } from './chart.js';
import { mountDbBrowser, dbOverviewHtml, dbObjectHtml } from './dbview.js';
// Static too, and as cheap: the DAX compiler it runs is imported on the first model only.
import * as semantic from './semantic.js';
// A .bim's model view. Explore's chart library is loaded when the Pivot first opens.
import { mountExplore } from './explore/view.js';
import { setRowCap } from './explore/explore.js';
import { PINS, npmFile } from './cdn.js';
import { tmslOf } from './explore/model.js';
import { createPlanView, profileSql, elapsed, profileColors } from './explore/profile.js';
import { vscodeApi } from './vscode-api.js';
import { statements, statementAt, errorOffset, setVariable, variablesIn, bindVariables, literal } from './querytext.js';

const $ = id => document.getElementById(id);

// Per-panel UI state (Explore's shelves), kept by VS Code for this webview: it survives
// the tab being hidden and the window reloading, with no browser storage involved.
const viewState = {
  get: key => (vs.getState() || {})[key],
  set: (key, value) => vs.setState({ ...(vs.getState() || {}), [key]: value }),
};
const cfg = window.ONELAKE_STUDIO_CONFIG || {};
const vs = vscodeApi();
// The settings the page reads as it goes: as of the panel's opening, then as the host posts them.
const settings = { tableOpensOn: cfg.tableOpensOn, gridThousandsSeparator: cfg.gridThousandsSeparator,
                   selectTopRows: cfg.selectTopRows || 1000 };

let engine = null;
let engineReady = null;      // resolves when engine.init() has finished; gates every use of it
let lakehouse = null;        // { workspace, item }
let activeSqlName = null;    // the selected table's SQL name (lakehouse.ws.item.schema.table)
// The SQL behind what is on screen (a query's, a table's first rows, a file's preview): what
// Profile and Export work from.
let currentSql = '';
// How the last runQuery or showPlan went, for the box: its error, and whether the SQL run was a
// semantic model's compiled SQL (positions are not the box's).
let lastRun = { error: null, rewritten: false };
let activeFile = null;       // the file behind it, when a file is what was opened
let lastResult = null;       // { fields, rows } for CSV export
let docMode = 'pretty';      // Pretty | Raw for a document result; a session preference
let docSeq = 0;              // a slow renderer import must not paint over a newer result
// Whether THIS result's source could be a document at all. Shape alone is not enough:
// a one-column, one-row parquet is still a table. Set per query by runQuery.
let docAllowed = true;
let docSourceExt = '';           // ...and which file it came from, when it came from one
let activeDocEligible = false;   // the same two answers for the loaded table/file
let activeDocExt = '';
let activeInfo = null;       // the selected TABLE's info object — what the Stats tab renders
let viewMode = 'data';       // 'data' | 'stats' | 'history' for a selected table
let statsPrev = null;        // hidden-flags of the data surfaces while Stats/History cover them
let tablePivot = null;       // the Pivot's view, { table, view }, of the table it was opened on
// A Delta table's own log, each half once its tab asks: { table, value | error | pending }
// for Stats, { table, entries, total, oldest, pending, error } for History. `table` is the
// activeTableRef it belongs to; another selection makes it stale.
let deltaState = null;
let deltaHistory = null;
// The table's file layout, from what the lake holds of it: { table, value | error | pending }.
let healthState = null;
// A selection buys the cheapest thing that answers the question: 'stats' = metadata
// only, 'peek' = the first rows. Each only when asked for; a query reads the rest.
let activeTableRef = null;   // the table object behind the selection, for escalating
let tableStage = 'none';     // 'none' | 'stats' | 'peek'
let rowsOutOfReach = null;   // the table whose Data tab is hidden (checkDataTab)

// The extension's read log prints these beside its own lines.
const reportBoot = b => vs.postMessage({ type: 'boot', ...b });
const reportOpened = (kind, label, ms) => vs.postMessage({ type: 'opened', kind, label, ms });

// Which of several statements is running (runBox), said in front of what each says: "2/3 · ".
let stepNote = '';
function setStatus(msg, type = '') {
  const el = $('status');
  if (stepNote) msg = `${stepNote} · ${msg}`;
  el.textContent = msg;
  el.className = type;
  // One ellipsised line; an error is long and its useful half is the tail. Hover for it,
  // click an error open.
  el.title = msg;
  el.classList.toggle('clickable', type === 'error');
  el.onclick = type === 'error' ? () => el.classList.toggle('expanded') : null;
  el.onkeydown = type === 'error' ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.classList.toggle('expanded'); } } : null;
  if (type === 'error') { el.tabIndex = 0; el.setAttribute('role', 'button'); }
  else { el.removeAttribute('tabindex'); el.setAttribute('role', 'status'); }
  if (type !== 'error') el.classList.remove('expanded');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// The landing page is a query result: the engine reads the README packaged with the
// extension (a path the host's DuckDB may read) and the Pretty view renders it.
const README_SQL = cfg.readmeUrl
  ? `select content from read_text('${String(cfg.readmeUrl).replace(/'/g, "''")}')`
  : '';

function wireUi() {
  // A double click is one click, as in the tree: the second does nothing, so Run runs once and a
  // removed chip doesn't take the next. dblclick is its own event, for the grid's inspector.
  document.addEventListener('click', e => {
    if (e.detail > 1 && !e.target.closest('input, textarea, select')) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  // Disable on the way out: the load ends at its next checkpoint, not this instant.
  $('stopBtn').onclick = () => {
    stops++;
    engine.cancelLoad();
    $('stopBtn').disabled = true;
    setStatus('Stopping…');
  };
  $('pivotBtn').onclick = openPivot;
  $('csvBtn').onclick = saveActive;
  $('runBtn').onclick = () => runBox();
  $('planBtn').onclick = () => runBox({ plan: true });
  $('saveQueryBtn').onclick = saveBox;
  $('sqlEditor').addEventListener('keydown', onBoxKey);
  $('sqlEditor').addEventListener('input', keepDraft);
  $('profileBtn').onclick = profileResult;
  $('chartBtn').onclick = toggleChart;
  $('docPretty').onclick = () => {
    if (docMode === 'pretty' || !lastResult) return;
    docMode = 'pretty';
    // The document as the query gave it: a sorted grid must not reorder its lines.
    showDoc('doc' in lastResult ? lastResult.doc : docOf(lastResult));
  };
  $('docRaw').onclick = () => {
    docMode = 'raw';
    setDocTabs();
    $('docView').hidden = true;
    $('resultsTable').hidden = false;
    $('gridBar').hidden = !grid;
  };
  $('viewData').onclick = onDataTab;
  $('viewStats').onclick = showStats;
  $('viewHistory').onclick = showHistory;
  $('statsView').addEventListener('click', e => {
    if (e.target.id === 'historyMore') loadHistory(true);
    // An Iceberg snapshot's Query: the table as it was then, in the box.
    const snap = e.target.closest('button[data-snapshot]');
    if (snap) querySnapshot(snap.dataset.snapshot);
  });
  $('dbOverview').addEventListener('click', e => {
    const b = e.target.closest('button[data-object]');
    const o = b && db && db.info.dbCatalog.objects[Number(b.dataset.object)];
    if (o) selectDbObject(o);
  });
  $('readSrc').onclick = () => vs.postMessage({ type: 'show-log' });
}

async function startEngine() {
  // Taken before the boot: a click during it (a model opened from the tree, say) outranks everything
  // said below, the welcome page too.
  const before = selSeq;
  await engineReady;
  let landingFailed = false;
  // Not when a query from the box got here first: its result is what was asked for.
  if (README_SQL && !currentSql && selSeq === before) landingFailed = !await runQuery({ sql: README_SQL });
  // A click while the welcome page was loading owns the status bar (and cancelled it).
  if (selSeq !== before || activeTableRef || activeFile || modelView) return;
  setStatus('DuckDB ready — pick a table in the OneLake sidebar, or write SQL in the box.' +
    (landingFailed ? ' (The welcome page could not be read — the engine itself is fine.)' : ''),
    landingFailed ? 'warn' : 'ok');
}

// ---------------------------------------------------------------------------
// What the tree asked for
// ---------------------------------------------------------------------------
// The last click wins. Loads run for seconds, so one that resumes after a NEWER selection
// must not touch the screen: each selection takes a ticket, and after every await a stale
// ticket stands down silently (the engine already cancelled the stale load).
let selSeq = 0;
// The same for what fills the results pane: a query (or the Data tab's first rows) that
// lands after a newer one was started stands down rather than paint over it.
let runSeq = 0;

// The panel follows the tree: moving to another lakehouse hands the previous one's views
// back before anything of the new one is opened. False when a newer click moved on while
// this one waited: its table belongs to a lakehouse no longer on screen, so it opens nothing.
let goSeq = 0;
// A Refresh under way (the 'reset' message): what is opened next waits for it, or the reset's end would
// let go of what that open made.
let resetting = null;
async function goToLakehouse(workspace, item) {
  const my = ++goSeq;
  await engineReady;
  if (resetting) await resetting.catch(() => {});
  if (my !== goSeq) return false;
  if (lakehouse && lakehouse.workspace === workspace && lakehouse.item === item) return true;
  const resetP = lakehouse ? leaveLakehouse({ forget: false }) : null;
  lakehouse = { workspace, item };
  if (resetP) await resetP;
  return my === goSeq;
}

// What was on screen belonged to the lakehouse being left: a file kept on screen with no
// lakehouse behind it offered a Save that could only fail.
function leaveLakehouse(opts) {
  closeModelView();
  closeDb();
  ++selSeq;                     // a load still under way belongs to the lakehouse being left
  currentSql = '';
  activeFile = null;
  setActiveStats(null);
  activeTableRef = null; tableStage = 'none';
  clearResults();
  $('activeTable').textContent = 'No table selected';
  setBusy(false);
  return engine.reset(opts);
}

async function openTable(m) {
  if (!await goToLakehouse(m.workspace, m.item)) return;
  await selectTable({ schema: m.schema || '', table: m.table });
}

// The message carries everything a listing would have: the tree just read this
// directory. Whether a reader exists is loadFile's to decide, and it says so.
async function openFile(m) {
  if (!await goToLakehouse(m.workspace, m.item)) return;
  const entry = { name: basename(m.path), path: m.path, isDir: false, bytes: m.bytes || 0,
                  modelWorkspace: m.modelWorkspace || null, openOn: m.openOn || null };
  if (IMAGE_EXTS.has(fileExt(entry.name))) await selectImage(entry);
  else await selectFile(entry);
}

async function selectFile(file) {
  if (fileExt(file.name) === 'bim') return openModelView(file);
  // A .yaml is an Apache Ossie model when its text says so; any other is a document.
  if (['yaml', 'yml'].includes(fileExt(file.name))) {
    const my = ++selSeq;
    const text = await ossieText(file);
    if (my !== selSeq) return;
    if (text != null) return openModelView(file, text, { fromOneLake: true });
  }
  closeModelView();
  closeDb();
  const my = ++selSeq;
  engine.cancelLoad();
  $('activeTable').textContent = file.name;
  // Only plain-text formats are read as a document (one row per line). Every other
  // reader produces a TABLE, and a table with one cell in it is still a table.
  activeFile = file;
  activeDocExt = fileExt(file.name);
  activeDocEligible = isTextExt(activeDocExt);
  setActiveStats(null);          // a file is not a table; no snapshot behind it
  activeTableRef = null; tableStage = 'none';
  clearResults(`(loading ${file.name}…)`);
  setBusy(true, { stoppable: true });
  try {
    const info = await engine.loadFile(lakehouse, file);
    if (my !== selSeq) return;
    if (info.db) {
      openDb(file, info);
    } else if (info.ident) {
      const preview = previewSql(info.source || info.ident, activeDocEligible);
      offerInBox(preview);
      reportLoad(info, await runQuery({ sql: preview, doc: activeDocEligible, ext: activeDocExt }));
    } else {
      reportLoad(info, true);
    }
  } catch (e) {
    if (my !== selSeq) return;
    if (e.cancelled) {
      clearResults('(no result — loading stopped)');
      setStatus(`Stopped loading ${file.name}.`);
    } else {
      clearResults('(no result — the file could not be opened)');
      setStatus('Load failed: ' + e.message, 'error');
      console.error(e);
    }
  } finally {
    if (my === selSeq) setBusy(false);
  }
}

// The text of a YAML file in Files/ that is an Ossie model, or null: it opens as a document.
async function ossieText(file) {
  try {
    await engineReady;
    const text = new TextDecoder().decode(await engine.readFileBytes(lakehouse, file));
    return semantic.isOssie(text) ? text : null;
  } catch (e) {
    console.warn(`[ossie] ${file.name}: ${e.message}`);
    return null;
  }
}

// A .bim (or an Ossie .yaml) is a semantic model, not a document: it opens as its model view
// (explore/view.js) in place of the editor and the results — Model and Pivot — and is
// registered (semantic.js) so SQL anywhere, the main editor's included, can name it.
let modelView = null;

// ECharts' own minified build, as a classic script (window.echarts), from the vendored copy.
// jsDelivr's +esm repackaging of it draws an empty canvas.
let echartsP = null;
const loadEcharts = () => (echartsP ??= new Promise((resolve, reject) => {
  if (window.echarts) return resolve(window.echarts);
  const s = document.createElement('script');
  s.src = npmFile(PINS.echarts, 'dist/echarts.min.js');
  s.onload = () => window.echarts ? resolve(window.echarts) : reject(new Error('echarts.min.js defined no echarts'));
  s.onerror = () => reject(new Error(`could not load ${s.src}`));
  document.head.append(s);
}).catch(e => { echartsP = null; throw e; }));
// The world's outline a map draws over (Explore's map mark), from the vendored copy.
const loadWorldMap = async () => {
  const r = await fetch(npmFile(PINS.worldMap, 'map/json/world.json'));
  if (!r.ok) throw new Error(`the world's map: ${r.status}`);
  return r.json();
};
function closeModelView() {
  if (!modelView) return;
  modelView.destroy();
  modelView = null;
  $('modelView').hidden = true;
  $('modelView').closest('section').classList.remove('modelOpen');
  // The host keeps a model's tab as that model's while it shows it (panel.js revealTab).
  vs.postMessage({ type: 'model-closed' });
}

// A .bim from Files/ (read through the host), or the .yaml the extension downloaded from
// Fabric and hands over as text (open-model): the same view either way. An Ossie .yaml from
// Files/ comes with its text already read (selectFile looked), and is still a OneLake file.
async function openModelView(file, text = null, { fromOneLake = text == null } = {}) {
  closeModelView();
  closeDb();
  const my = ++selSeq;
  engine.cancelLoad();
  $('activeTable').textContent = file.name;
  activeFile = fromOneLake ? file : null;   // only a OneLake file can be saved as itself
  activeDocExt = 'bim'; activeDocEligible = false;
  setActiveStats(null);
  activeTableRef = null; tableStage = 'none';
  clearResults();
  setBusy(true, { stoppable: true });
  setStatus(`Reading ${file.name}…`);
  try {
    // A model handed over as text (the tree's click) is drawn without waiting on the
    // engine's boot: only its queries need DuckDB, and runModelSql waits for it.
    if (fromOneLake) await engineReady;
    const bim = text != null ? text : new TextDecoder().decode(await engine.readFileBytes(lakehouse, file));
    // semanticmodel.ws.model: the semantic model the tree opened, by its own workspace and
    // name; else the file, in the workspace it is in (a file from disk: the one its tables are in), by its name.
    const schema = file.modelWorkspace || file.localWorkspace || (fromOneLake && lakehouse ? lakehouse.workspace : null);
    const m = await semantic.registerModel(file.name, bim, null, schema, file.modelName);
    // Kept by the host as a semantic view too, so it is there after a restart and the
    // command line can name it. Best effort: the view on screen does not depend on it.
    // An app's file holds its model in a zip, which no view can read: not kept.
    if (!file.appFile) {
      engine.semanticKeep(m.view, fromOneLake ? abfssUrl(lakehouse.workspace, file.path) : file.path, m.schema)
        .catch(e => console.warn(`[views] ${m.name} not kept: ${e.message}`));
    }
    if (my !== selSeq) return;
    $('modelView').closest('section').classList.add('modelOpen');
    $('modelView').hidden = false;
    modelView = mountExplore($('modelView'), {
      // The tab and the header already say the file: the bar says only the model's name.
      name: m.name, tmsl: tmslOf(m.bim), compiler: m.exploreCompiler,
      text: bim, ext: (/\.([^.]+)$/.exec(file.name) || [])[1] || '',
      run: runModelSql,
      cancel: () => engine.cancelLoad(),
      echarts: loadEcharts,
      worldMap: loadWorldMap,
      setStatus,
      saveText: (name, text) => engine.saveText(name, text),
      copyText,
      loadState: viewState.get,
      saveState: viewState.set,
      // The native engine set the profile's metrics before it locked its configuration, and
      // the panel's CSP runs no inline script (DuckDB's HTML plan): its text plan instead.
      profileSet: false,
      htmlPlan: false,
      // Explore as a Fabric app of its own (fabric_app/export/exportapp.js). A model file in OneLake: the app reads
      // it where it is, and the tables of the one lakehouse it names, or a semantic model is made of it;
      // one that names no lakehouse or several has no button. A Power BI semantic model: the app
      // queries it as it is, whatever it reads, and nothing is asked or written for it. A model file
      // from disk (a download, say): client side as a OneLake file is, in the workspace its tables are in,
      // when it names one lakehouse. A client-side app's file opened from disk: that file, published as it
      // is (its model.yaml, its report); one exported from a file on disk names no Files/ path.
      exportToFabric: file.appFile ? state => engine.exportExplore({ appFile: file.appFile, file: file.appModelFile, name: m.view,
        text: bim, state, workspace: file.appModel.split('/')[0], path: file.appModel.split('/').slice(1).join('/'),
        onDisk: !/^[^/]+\/[^/]+\/Files\//i.test(file.appModel) })
        : (fromOneLake || !file.modelWorkspace ? (fromOneLake || file.localWorkspace) && semantic.lakehousesOf(m.bim).length === 1 : true)
        ? state => engine.exportExplore(fromOneLake
          ? { file: file.name, name: m.view, text: bim, state, workspace: lakehouse.workspace, path: file.path }
          : file.modelWorkspace
          ? { file: file.name, name: m.view, text: bim, state, model: { workspace: file.modelWorkspace, name: file.modelName || m.view } }
          : { file: file.name, name: m.view, text: bim, state, workspace: file.localWorkspace, onDisk: true })
        : undefined,
      // Any model, wherever its file is, by its SQL name. On Windows: Excel's provider is Windows only.
      // A model file in OneLake, made a Power BI semantic model as the tree's ⛁ does it. A semantic model is one already.
      createSemanticModel: fromOneLake
        ? () => engine.createSemanticModel({ file: file.name, text: bim, workspace: lakehouse.workspace, path: file.path })
        : undefined,
      openInExcel: cfg.windows ? () => engine.openInExcel({ workspace: m.schema, model: m.view }) : undefined,
      // The Model page's table: the OneLake table behind it, in a tab of its own. Only a Direct Lake table has one.
      openTable: table => {
        const sqlName = m.lakeTables && m.lakeTables[String(table).toLowerCase()];
        if (!sqlName) { setStatus(`${table} is not a OneLake table, so there is no table to open.`, 'error'); return; }
        engine.openTable(sqlName).catch(e => setStatus(`Could not open ${table}: ${e.message}`, 'error'));
      },
      keepOffline: {
        state: () => engine.offlineState({ workspace: m.schema, model: m.view }),
        set: on => engine.setOffline({ workspace: m.schema, model: m.view, on }),
      },
      // The Report tab: the tiles in this model's Export to Fabric zip, else the file the host
      // keeps for it, else none (fabric_app/export/exportflow.js reportOf), drawn again when they change; Add
      // to report and a tile's ✕ save them (reportSave). It opens on Model, or on the Report for an app's file.
      report: {
        load: () => engine.modelReport({ workspace: m.schema, model: m.view }),
        stamp: () => engine.modelReportStamp({ workspace: m.schema, model: m.view }),
        save: (spec, stamp) => engine.modelReportSave({ workspace: m.schema, model: m.view, spec, stamp }),
      },
      openOn: file.openOn || 'model',
    });
    setStatus(`${file.name} is the semantic model ${m.name}` +
              (m.directLake ? ` — ${m.directLake} Direct Lake table(s), opened from OneLake as a query needs them` : '') +
              '. SQL anywhere can name it.', 'ok');
  } catch (e) {
    if (my !== selSeq) return;
    setStatus(`${file.name} does not open as a semantic model: ${e.message}`, 'error');
    console.error(e);
  } finally {
    if (my === selSeq) setBusy(false);
  }
}

// Semantic views the host keeps (core/models/semviews.js), defined once the engine is up so SQL can
// name them; every query waits for this. One that no longer reads is skipped, and says so.
let viewsListed = Promise.resolve([]);
let viewsReady = Promise.resolve();
async function listViews() {
  await engineReady;
  try { return await engine.semanticViews(); } catch (e) { console.warn('[views]', e.message); return []; }
}
// What a statement waits for before it compiles: the views, only if it can name one. Listing them
// reads this machine alone; defining them can wait on the Fabric API, for an item not named yet.
async function viewsFor(sql) {
  if (semantic.aboutModels(sql)) await viewsReady;
}
async function loadViews() {
  await engineReady;
  const t0 = Date.now();
  const list = await viewsListed;
  for (const v of list) {
    if (!v.schema) continue;   // named before models were semanticmodel.ws.model
    try {
      if (v.error) throw new Error(v.error);
      await semantic.defineView(v.name, v.path, v.text, 'replace', null, v.schema);
    } catch (e) { console.warn(`[views] ${v.name}: ${e.message}`); }
  }
  // Every query waits for this (viewsReady), so the read log says how long it took.
  reportBoot({ what: `${list.length} semantic views loaded`, stages: [], totalMs: Date.now() - t0 });
}

// The semantic models a statement names (semanticmodel.ws.model) that are not views here
// yet, opened by the host — a local copy of each, read from Fabric the first time, and kept —
// and defined, so the statement compiles as if they had been open all along.
async function openModels(sql) {
  for (const ref of semantic.unopenedModels(sql)) {
    setStatus(`Opening the semantic model ${ref.workspace}.${ref.model}…`);
    const v = await engine.semanticOpen(ref);
    await semantic.defineView(v.name, v.path, v.text, 'replace', null, v.schema);
  }
}

// Text on the clipboard, by the host (a plan's SQL tab).
const copyText = text => engine.copyText(text);

// A compiled SQL of a model, run through the engine's read-only path: it names its Direct Lake
// tables by their SQL names, and the host opens each as the SQL reaches it. Stoppable.
let modelRuns = 0;
async function runModelSql(sql) {
  modelRuns++;
  const my = selSeq;
  setBusy(true, { stoppable: true });
  try {
    await engineReady;
    const res = await engine.runSql(sql);
    // Explore's Show plan: its profile, in the shape its view reads (profileJson, below).
    if (PROFILE_SQL.test(sql) && res.rows[0]?.explain_value != null) {
      res.rows[0].explain_value = profileJson(res.rows[0].explain_value);
    }
    return res;
  } finally {
    // A Pivot's newer query may still be running when an older one ends, and it keeps its Stop. So
    // does whatever took the pane since: a click's load, or a query from the box.
    if (--modelRuns === 0 && my === selSeq && !running) setBusy(false);
  }
}

// A profile (EXPLAIN (ANALYZE, FORMAT json)) as this engine writes it, in the shape Explore's
// profile view reads (explore/profile.js parseProfile, shared with the exported app, which
// runs DuckDB-WASM and keeps the older flat keys):
//   - DuckDB 2.0 nests its totals: planner.total_time, optimizer.total_time,
//     physical_planner.total_time, query.total_time and total_rows_scanned,
//     system.peak_buffer_memory; and an operator's rows scanned are `rows_scanned`;
//   - the native engine runs every statement prepared, so the plan has an EXECUTE above it,
//     which would otherwise be taken for the query's top operator (its rows: 0).
const PROFILE_SQL = /^\s*EXPLAIN\s*\(\s*ANALY[SZ]E\s*,\s*FORMAT\s+json\s*\)/i;

function profileJson(json) {
  let p;
  try { p = typeof json === 'string' ? JSON.parse(json) : json; } catch (_) { return json; }
  const total = v => (v && typeof v === 'object' ? v.total_time : v);
  const out = { ...p };
  if (p.planner != null) out.planner = total(p.planner);
  if (p.optimizer != null && p.all_optimizers == null) out.all_optimizers = total(p.optimizer);
  if (p.physical_planner != null) out.physical_planner = total(p.physical_planner);
  if (p.query && typeof p.query === 'object') {
    if (p.latency == null) out.latency = p.query.total_time;
    if (p.cumulative_rows_scanned == null && p.query.total_rows_scanned) out.cumulative_rows_scanned = p.query.total_rows_scanned;
  }
  if (p.system && p.system_peak_buffer_memory == null) out.system_peak_buffer_memory = p.system.peak_buffer_memory;
  const fix = n => {
    const kids = (n.children ?? []).flatMap(k => (/^EXECUTE$/i.test(k.type ?? k.operator_type ?? k.operator_name ?? '')
      ? (k.children ?? []).map(fix) : [fix(k)]));
    const m = { ...n, children: kids };
    if (m.operator_rows_scanned == null && m.rows_scanned != null) m.operator_rows_scanned = m.rows_scanned;
    return m;
  };
  if (Array.isArray(p.operator)) out.operator = p.operator.map(fix);
  if (Array.isArray(p.children)) out.children = p.children.map(fix);
  return JSON.stringify(out);
}

// The image on screen holds one object URL. clearResults() is the only place the <img>
// leaves the DOM, so it is the only place the URL is revoked.
let imageUrl = null;

// An image never goes through DuckDB: the host reads its bytes and they are shown over a
// blob URL.
async function selectImage(file) {
  closeModelView();
  closeDb();
  const my = ++selSeq;
  engine.cancelLoad();
  $('activeTable').textContent = file.name;
  activeFile = file;
  activeDocExt = '';
  currentSql = '';
  setActiveStats(null);
  activeTableRef = null; tableStage = 'none';
  activeDocEligible = false;
  clearResults(`(loading ${file.name}…)`);
  setBusy(true);
  try {
    const bytes = await engine.readFileBytes(lakehouse, file);
    if (my !== selSeq) return;
    clearResults();              // revokes the previous image's URL, bumps docSeq
    imageUrl = URL.createObjectURL(
      new Blob([bytes], { type: IMAGE_EXTS.get(fileExt(file.name)) }));
    $('docView').innerHTML = `<img src="${imageUrl}" alt="${escapeHtml(file.name)}">`;
    $('docView').hidden = false;
    $('csvBtn').disabled = false;
    setSaveLabel();              // "Save file" — the image is a file on screen
    setStatus(`${file.name} — ${engine.fmtBytes(bytes.length)}.`, 'ok');
  } catch (e) {
    if (my !== selSeq) return;
    clearResults('(no result — the image could not be read)');
    setStatus('Load failed: ' + e.message, 'error');
    console.error(e);
  } finally {
    if (my === selSeq) setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// A database file: what it holds beside the box and the results (dbview.js), for as long as it
// is open. A query from the box leaves it there, since the query's tables are what it lists.
// ---------------------------------------------------------------------------
let db = null;               // { file, info, browser }

function closeDb() {
  if (!db) return;
  db.browser.destroy();
  db = null;
  $('dbRail').hidden = true;
}

function openDb(file, info) {
  closeDb();
  $('dbRail').hidden = false;
  const browser = mountDbBrowser($('dbRail'), {
    title: file.name, catalog: info.dbCatalog, quote: sqlPart,
    onOverview: showDbOverview,
    onPick: selectDbObject,
    onInsert: insertDbName,
  });
  db = { file, info, browser };
  // Not run: the box starts from the first table, as a table's own tab does.
  if (info.ident) offerInBox(previewSql(info.ident, false));
  showDbOverview();
}

// The whole file, in place of the results. Reads nothing: what it says came with the attach.
function showDbOverview() {
  if (!db) return;
  ++selSeq;                     // whatever was loading for the last click stands down
  engine.cancelLoad();
  const { file, info, browser } = db;
  $('activeTable').textContent = file.name;
  activeFile = file;
  activeSqlName = null;
  activeTableRef = null; tableStage = 'none';
  currentSql = '';
  setActiveStats(null);
  clearResults();
  $('dbOverview').innerHTML = dbOverviewHtml(info.dbCatalog,
    { engine: info.dbEngine, size: engine.fmtBytes(info.bytes), alias: info.dbAlias });
  $('dbOverview').hidden = false;
  setBusy(false);
  browser.select('overview');
  reportLoad(info, true);
}

// A table or view of the file: as a table in OneLake opens, Stats leading, with no row read
// until Data is asked for. It has no history to show.
function selectDbObject(o) {
  if (!db) return;
  ++selSeq;
  engine.cancelLoad();
  $('activeTable').textContent = `${o.schema}.${o.name}`;
  activeFile = db.file;
  activeDocEligible = false;
  activeDocExt = '';
  activeSqlName = o.sqlName;
  activeTableRef = { schema: o.schema, table: o.name };
  tableStage = 'stats';
  clearResults('(no rows read yet — open the Data tab)');
  setActiveStats(null);
  setActiveStats({ label: o.name, db: o, stats: {}, columns: o.columns });
  showStats();
  currentSql = previewSql(o.sqlName, false);
  offerInBox(currentSql);
  setBusy(false);
  db.browser.select(o.id);
  setStatus(`${o.sqlName} — from the file's catalog, no rows read. Open Data for the first rows.`);
  if (settings.tableOpensOn === 'data') peekDbObject(o);
}

// Its first rows, through the box's own path. As for a table in OneLake, Export and Profile then
// go by the whole table, not these rows.
async function peekDbObject(o) {
  const my = selSeq;
  const ok = await runQuery({ sql: previewSql(o.sqlName, false), doc: false });
  if (!ok || my !== selSeq) return;
  tableStage = 'peek';
  currentSql = `SELECT * FROM ${o.sqlName}`;
  setStatus(`The first ${lastResult.rows.length} row(s). Query the whole table in the box.`);
}

// A name from the tree, at the box's cursor. What the box was only offered goes: nothing typed there.
function insertDbName(name) {
  const box = showBox();
  box.focus();
  if (box.value === offered) box.select();
  typeInBox(box, name);
  keepDraft();
}

// ---------------------------------------------------------------------------
// A table: statistics, then rows, then a view — each only when asked for
// ---------------------------------------------------------------------------
async function selectTable(t) {
  closeModelView();
  closeDb();
  const my = ++selSeq;
  // A click is also a verdict on whatever is still running: stop it now.
  engine.cancelLoad();
  $('activeTable').textContent = t.schema ? `${t.schema}.${t.table}` : t.table;
  activeFile = null;
  activeDocEligible = false;    // a table, whatever shape the preview comes back
  activeDocExt = '';
  activeSqlName = null;
  currentSql = '';
  activeTableRef = t;
  tableStage = 'none';
  // The previous table's rows must not sit on screen under the new table's name.
  clearResults(`(no rows read yet — open the Data tab)`);
  setActiveStats(null);
  // Stoppable: the catalog may be waiting on Fabric to write a table's Iceberg metadata.
  setBusy(true, { stoppable: true });
  try {
    // Selecting a table reads its METADATA and nothing else — from the host's cache when
    // the table was ever opened before.
    const info = await engine.statTable(lakehouse, t);
    if (my !== selSeq) return;
    activeSqlName = info.sqlName || info.ident;
    tableStage = 'stats';
    await checkDataTab();
    if (my !== selSeq) return;
    setActiveStats(info);
    showStats();                    // statistics are the landing view for a table
    setViewTabs();
    // Not run: Profile and Export read the rows by it, and the box starts from it.
    currentSql = activeSqlName ? previewSql(activeSqlName, false) : '';
    if (currentSql) offerInBox(currentSql);
    setStatus(engine.describeLoad(info));
    if (rowsOutOfReach === t) {
      setStatus('Offline, and none of this table\'s rows have been read here, so it has no Data tab.');
      return;
    }
    // Asked to land on the rows: the same as clicking Data.
    if (settings.tableOpensOn === 'data') { await peekIntoView(); return; }
    // Nothing of the table is read until Data is clicked: a first read syncs its log and brings its files here.
  } catch (e) {
    if (my !== selSeq) return;
    reportTableError(e);
  } finally {
    if (my === selSeq) setBusy(false);
  }
}

function reportTableError(e) {
  // A load the user stopped is not a failure.
  if (e.cancelled) {
    clearResults('(no result — loading stopped)');
    setStatus(`Stopped loading ${$('activeTable').textContent}.`);
  } else {
    clearResults('(no result — the table could not be opened)');
    setStatus('Load failed: ' + e.message, 'error');
    console.error(e);
  }
}

// Offline, a table with none of its rows read has nothing for the Data tab but an error, so it has no
// Data tab. Online the rows are one read away, and it stays. Asked each time, as the answer moves
// with the connection and with what has been read.
async function checkDataTab() {
  const t = activeTableRef;
  if (!t || !lakehouse) return;
  const out = await engine.rowsOutOfReach(lakehouse, t).catch(() => false);
  if (activeTableRef === t) rowsOutOfReach = out ? t : null;
}

// The Data tab's first click: the first rows, which the selection already started reading.
async function peekIntoView() {
  if (activeInfo && activeInfo.db) return peekDbObject(activeInfo.db);
  const my = selSeq, run = ++runSeq;
  const stale = () => my !== selSeq || run !== runSeq;
  const t0 = Date.now();
  setBusy(true, { stoppable: true });
  try {
    const out = await engine.peekTable(lakehouse, activeTableRef);
    if (stale()) return;
    tableStage = 'peek';
    docAllowed = false;             // a peek is a table, whatever shape it comes back
    // A copy: the grid sorts its rows in place, and `out` is the peek kept for the next click.
    const shown = { ...out, rows: out.rows.slice() };
    renderResults(shown);           // this lands the pane in the Data view by itself
    // These rows are on screen like any others. Export and Profile go by the query, the whole table.
    lastResult = shown;
    if (activeSqlName) currentSql = `SELECT * FROM ${activeSqlName}`;
    $('chartBtn').disabled = !out.rows.length;
    $('csvBtn').disabled = !out.rows.length || !currentSql;
    $('profileBtn').disabled = !out.rows.length || !currentSql;
    reportOpened('rows', $('activeTable').textContent, Date.now() - t0);
    setStatus(`The first ${out.rows.length} row(s). Query the whole table in the box.`);
  } catch (e) {
    if (stale()) return;
    reportTableError(e);
  } finally {
    if (!stale()) setBusy(false);
  }
}

// A load with warnings is not a success, and a failed preview's error stays on screen.
function reportLoad(info, queryOk) {
  if (!queryOk) return;
  const warnings = info.warnings || [];
  setStatus(
    engine.describeLoad(info) + (warnings.length ? '. Warning: ' + warnings.join('; ') : '') + '.',
    warnings.length ? 'warn' : 'ok');
}

// ---------------------------------------------------------------------------
// Run SQL -> results
// ---------------------------------------------------------------------------
// A table gets its first rows (selectTopRows); a text file gets ALL of it — a LIMIT would cut the
// document silently. The engine's own row cap still applies and still says so.
const previewSql = (ident, whole) => `SELECT * FROM ${ident}` + (whole ? '' : ` LIMIT ${settings.selectTopRows}`);

// Plan: where the editor's query spends its time, in place of the results — Explore's own
// view of it (explore/profile.js): the profile (EXPLAIN ANALYZE, so the query runs once to be
// measured) and DuckDB's plan tree. A semantic model's query is planned as the SQL it
// compiles to. Running a query puts the results back.
const pageCss = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// Plans and profiles under way. Each runs the whole query, so a Plan waits for them rather
// than start another on every click.
let planning = 0;
const holdPlan = on => { planning += on ? 1 : -1; };
const held = (work, my) => async () => {
  holdPlan(true);
  setBusy(true, { stoppable: true });
  try { return await work(); }
  finally {
    holdPlan(false);
    if (my === selSeq) setBusy(false);
  }
};
// Returns whether the plan is on screen; what went wrong is in lastRun.
async function showPlan(text) {
  lastRun = { error: null, rewritten: false };
  text = String(text || '').trim();
  if (!text) { setStatus('Write a query to plan it.'); return false; }
  if (planning) { setStatus('A plan is still being measured: wait for it, then plan again.', 'warn'); return false; }
  currentSql = text;
  setStatus('Planning…');
  const my = selSeq;
  holdPlan(true);
  setBusy(true, { stoppable: true });
  try {
    await engineReady;
    await viewsFor(text);
    await openModels(text);
    const model = await semantic.statement(text, null);
    lastRun.rewritten = !!model;
    const sql = model ? model.sql : text.replace(/;\s*$/, '');
    if (my !== selSeq) return false;
    // Runs nothing, and it is where bad SQL or a table not held fails: below, so the box hears.
    // On a line of its own, so DuckDB's error quotes the statement's line and not this word.
    const explained = await engine.runSql(`EXPLAIN\n${sql}`);
    if (my !== selSeq) return false;
    clearResults();
    const view = $('planView');
    view.replaceChildren(createPlanView({
      sql: () => sql, copy: copyText,
      profile: held(async () => {
        try {
          return profileJson((await engine.runSql(profileSql(sql, { set: false }))).rows[0]?.explain_value);
        } catch (e) {
          // Past the EXPLAIN, the box has its answer: the view and this line say it.
          if (my === selSeq) setStatus(e.cancelled ? 'Stopped.' : 'Plan failed: ' + e.message, e.cancelled ? undefined : 'error');
          throw e;
        }
      }, my),
      tree: async () => {
        const pre = document.createElement('pre');
        pre.className = 'sm-plan';
        pre.textContent = explained.rows.map(r => r.explain_value ?? Object.values(r).join('  ')).join('\n');
        return pre;
      },
      colors: () => profileColors(pageCss),
      elapsed,
    }));
    view.hidden = false;
    // The plan is the query's, not one of the table's tabs: Stats | History | Data step aside.
    $('viewBar').hidden = true;
    $('resultsHint').hidden = true;
    setStatus('Query plan — Run ▶ (Ctrl+Enter) for the results.');
    return true;
  } catch (e) {
    if (my === selSeq) {
      // As a query that fails: nothing on screen belongs to another statement.
      clearResults('(no plan — the query failed)');
      lastRun.error = e.message;
      setStatus('Plan failed: ' + e.message, 'error');
    }
    return false;
  } finally {
    holdPlan(false);
    if (my === selSeq) setBusy(false);
  }
}

// `doc` says whether a document view may be offered for this result at all. Returns
// whether the query succeeded, so a caller with its own message can keep quiet; what went
// wrong is in lastRun.
let running = 0;   // queries under way: a kept result waits for them rather than stop them
let stops = 0;     // presses of Stop: one before a statement reaches the host has nothing to cancel yet
// `summarize`: SUMMARIZE of this query instead (Profile), of the SQL it compiles to.
async function runQuery({ sql, doc = true, ext = '', summarize = null } = {}) {
  sql = String(summarize != null ? `SUMMARIZE ${summarize}` : sql ?? '');
  currentSql = sql;
  lastRun = { error: null, rewritten: false };
  running++;
  // A click in the tree outranks a query already on its way — the welcome page's, above
  // all, which a click that opens the panel races. Each await below can be where that
  // click lands, and a cancel sent before the statement reaches the host stops nothing,
  // so the result itself has to stand down rather than paint over the click's view.
  // The box runs a query even while one is under way: the newer one owns the pane.
  const my = selSeq, run = ++runSeq, stopsAtStart = stops;
  const stale = () => my !== selSeq || run !== runSeq;
  setBusy(true, { stoppable: true });
  docAllowed = doc;
  docSourceExt = ext;
  let t0 = performance.now();
  // Said at once, and counted, by the page alone: however long the host takes to answer, a click
  // always shows it landed. A result shows when it has all arrived, so how far it has got is said too.
  const asked = performance.now();
  let rowsSoFar = 0;
  setStatus('Running…');
  const ticker = setInterval(() => {
    if (stale() || !/^(?:\d+\/\d+ · )?Running/.test($('status').textContent)) return;
    setStatus(`Running… ${elapsed(asked)}${rowsSoFar ? `, ${rowsSoFar.toLocaleString('en')} rows so far` : ''}`);
  }, 1000);
  try {
    await engineReady;   // the box can send a query before the engine is up
    // A query of a semantic model runs as the SQL dax-sql compiles it to, once the tables
    // that SQL reads are open; every other query runs as written, and does not wait for them.
    const source = summarize != null ? String(summarize) : sql;
    await viewsFor(source);
    await openModels(source);
    if (stale()) return false;
    const onRows = n => { rowsSoFar = n; };
    let model = null, statementSql;
    if (summarize != null) {
      // The SUMMARIZE is of the SQL the query compiles to.
      const compiled = await semantic.statement(source, null).catch(() => null);
      statementSql = `SUMMARIZE ${(compiled ? compiled.sql : source).trim().replace(/;+\s*$/, '')}`;
      currentSql = statementSql;
    } else {
      model = await semantic.statement(sql, null);
      statementSql = model ? model.sql : sql;
    }
    if (stale()) return false;
    if (model) docAllowed = false;
    lastRun.rewritten = !!model;
    t0 = performance.now();
    if (stops !== stopsAtStart) throw Object.assign(new Error('Stopped'), { cancelled: true });
    const res = await engine.runSql(statementSql, { onRows });
    if (stale()) return false;
    renderResults(res);
    lastResult = res;
    const ms = Math.round(performance.now() - t0);
    // Every row held is in the grid (grid.js draws only those in view); res.truncated means there
    // are more than it holds. Export… runs the query again, so it still writes every row.
    let msg = `${res.rows.length.toLocaleString('en')} row(s) in ${ms} ms`;
    if (res.truncated)
      msg = `The first ${res.rows.length.toLocaleString('en')} of ${res.numRows.toLocaleString('en')} rows, in ${ms} ms. ` +
            `Narrow the query to see the rest here: Export… writes every row`;
    const age = ageNote(res.asOf);
    if (age) msg += `. The ${age}`;
    setStatus(msg, res.truncated ? 'warn' : 'ok');
    $('csvBtn').disabled = res.rows.length === 0;
    $('profileBtn').disabled = res.rows.length === 0 || /^\s*summarize\b/i.test(sql);
    $('chartBtn').disabled = res.rows.length === 0;
    setSaveLabel();
    return true;
  } catch (e) {
    // Most likely cancelled by the very click that superseded it: not this query's screen.
    if (stale()) return false;
    // The pane is not a scratchpad of whatever last worked.
    if (e.cancelled) {
      clearResults('(no result — query stopped)');
      setStatus('Stopped.');
      return false;
    }
    // The whole message, where it can wrap: the status line holds one line of it.
    clearResults(e.message, { error: true });
    lastRun.error = e.message;
    setStatus('Query error: ' + e.message, 'error');
    console.error(e);
    return false;
  } finally {
    clearInterval(ticker);
    running--;
    // The newer selection's load owns the busy state now.
    if (!stale()) setBusy(false);
  }
}

// Empty the whole pane. Every path that ends without a result goes through here, so
// nothing on screen ever belongs to a query other than the current one.
function clearResults(hint = '', { error = false } = {}) {
  docSeq++;              // an in-flight showDoc() must not paint over this
  if (grid) { grid.destroy(); grid = null; }
  hideChart();
  underChart = null;
  $('chartBtn').disabled = true;
  viewMode = 'data';
  statsPrev = null;
  $('statsView').hidden = true;
  $('statsView').innerHTML = '';
  $('dbOverview').hidden = true;
  $('dbOverview').innerHTML = '';
  setViewTabs();
  $('docBar').hidden = true;
  $('docView').hidden = true;
  $('docView').innerHTML = '';
  if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
  $('resultsTable').hidden = true;
  $('resultsTable').innerHTML = '';
  $('resultsTable').onclick = null;
  $('planView').hidden = true;
  $('planView').replaceChildren();
  $('viewBar').hidden = !activeInfo;   // the table's tabs come back once the plan goes
  $('resultsHint').hidden = !hint;
  $('resultsHint').textContent = hint;
  $('resultsHint').classList.toggle('error', error);
  lastResult = null;
  $('csvBtn').disabled = true;
  $('profileBtn').disabled = true;
  setSaveLabel();
}

// The document a result holds, or null: read_text()'s one cell, or a text file's lines.
function docOf(res) {
  if (!docAllowed || !res) return null;
  return isDocResult(res) ? res.rows[0][res.fields[0]] : textLinesDoc(res);
}

// The grid on screen (grid.js), while a result is.
let grid = null;
const gridUi = () => ({
  filter: $('gridFilter'), count: $('gridCount'),
  inspector: { root: $('inspector'), title: $('inspectorTitle'), body: $('inspectorBody'),
               copy: $('inspectorCopy'), close: $('inspectorClose') },
});

function renderResults(res) {
  const table = $('resultsTable');
  const hint = $('resultsHint');
  clearResults();
  if (!res.fields.length) {
    table.hidden = true; hint.hidden = false; hint.textContent = '(no columns)';
    return;
  }
  hint.hidden = true; table.hidden = false;
  // A header click sorts every row the result holds, in place. Export… runs the SQL again, so it
  // doesn't keep this order.
  grid = mountGrid(table, table.closest('.resultsWrap'), res, {
    ui: gridUi(),
    copyText: text => engine.copyText(text).catch(e => setStatus('Could not copy: ' + e.message, 'error')),
    say: text => setStatus(text, 'ok'),
    grouped: () => settings.gridThousandsSeparator,
  });

  // The grid stays the source of truth; a document result additionally gets Pretty — kept as
  // it reads now, before any sort.
  const doc = docOf(res);
  res.doc = doc;
  if (doc != null) {
    $('docBar').hidden = false;
    setDocTabs();
    if (docMode === 'pretty') showDoc(doc);
  }
}

// ---------------------------------------------------------------------------
// Document view — JSON re-indented, markdown rendered, anything else as stored. Fails
// closed: any renderer trouble leaves the escaped grid on screen.
// ---------------------------------------------------------------------------
const DOC_KIND_TITLE = {
  json: 'Rendered as indented JSON',
  markdown: 'Rendered as markdown',
  text: 'Shown as plain text, exactly as stored',
};

async function showDoc(text) {
  const seq = ++docSeq;
  try {
    const { html, kind } = await renderDocument(text, docSourceExt);
    if (seq !== docSeq || docMode !== 'pretty') return;
    $('docView').innerHTML = html;
    $('docView').classList.toggle('prose', kind === 'markdown');
    $('docView').hidden = false;
    $('resultsTable').hidden = true;
    $('gridBar').hidden = true;
    $('docPretty').title = DOC_KIND_TITLE[kind] || '';
    setDocTabs();
  } catch (e) {
    if (seq !== docSeq) return;
    $('docBar').hidden = true;
    setStatus('Document renderer unavailable (' + e.message + ') — showing raw.', 'warn');
  }
}

function setDocTabs() {
  $('docPretty').classList.toggle('active', docMode === 'pretty');
  $('docRaw').classList.toggle('active', docMode !== 'pretty');
}

// ---------------------------------------------------------------------------
// Stats view: Stats | History | Data for a selected table. Everything on the Stats and
// History tabs is metadata: the Iceberg snapshot already fetched, and for a table written
// as Delta, its own log, read once when one of the two is first shown.
// ---------------------------------------------------------------------------
function setActiveStats(info) {
  activeInfo = (info && info.stats) ? info : null;
  $('viewBar').hidden = !activeInfo;
  $('viewHistory').hidden = !!(activeInfo && activeInfo.db);
  $('pivotBtn').disabled = !activeInfo || !activeSqlName;
  $('pivotBtn').closest('section').classList.toggle('tableOpen', !!activeInfo);
  if (!activeInfo) dropTablePivot();   // a new selection: the pivot was the last table's
  if (!activeInfo && viewMode !== 'data') showData();
  else if (activeInfo && viewMode !== 'data') renderMeta();
}

function setViewTabs() {
  for (const [id, mode] of [['viewData', 'data'], ['viewStats', 'stats'], ['viewHistory', 'history']]) {
    $(id).classList.toggle('active', viewMode === mode);
    $(id).setAttribute('aria-pressed', String(viewMode === mode));
  }
  $('viewData').hidden = !!rowsOutOfReach && rowsOutOfReach === activeTableRef && viewMode !== 'data';
}

const isDelta = info => !!(info && info.stats && info.stats.format === 'delta');

// Stats and History cover the result surfaces rather than replacing them: whatever was
// showing is put back exactly on return.
function showMeta(mode) {
  if (!activeInfo || viewMode === mode) return;
  if (viewMode === 'data') {
    statsPrev = ['resultsHint', 'docView', 'resultsTable', 'docBar', 'gridBar', 'chartView']
      .map(id => [id, $(id).hidden]);
    for (const [id] of statsPrev) $(id).hidden = true;
  }
  viewMode = mode;
  $('statsView').hidden = false;
  renderMeta();
  setViewTabs();
  // A Delta table's log is read per tab, only once that tab is shown.
  if (isDelta(activeInfo)) (mode === 'history' ? loadHistory : loadDeltaState)();
}
const showStats = () => showMeta('stats');
const showHistory = () => showMeta('history');

const mine = x => (x && x.table === activeTableRef ? x : null);
function renderMeta() {
  const onelakeTable = viewMode === 'stats' && activeInfo && !activeInfo.db && activeTableRef;
  $('statsView').innerHTML = viewMode === 'history'
    ? historyHtml(activeInfo, mine(deltaHistory))
    : (onelakeTable ? healthHtml(mine(healthState)) : '') + statsCardHtml(activeInfo, mine(deltaState));
  if (onelakeTable && !mine(healthState)) loadHealth();
}

// What the lake holds of the table, and what its layout says: read here, never from OneLake.
async function loadHealth() {
  const t = activeTableRef;
  if (!t || mine(healthState)) return;
  healthState = { table: t, pending: true };
  let next;
  try { next = { table: t, value: await engine.tableHealth(lakehouse, t) }; }
  catch (e) { next = { table: t, error: (e && e.message) || String(e) }; }
  if (activeTableRef !== t) return;
  healthState = next;
  if (viewMode === 'stats') renderMeta();
}

// A lakehouse's tables as the lake holds them, findings first: one row each, a click opens it in a tab.
async function showLakehouseHealth(m) {
  if (!await goToLakehouse(m.workspace, m.item)) return;
  closeModelView();
  closeDb();
  const my = ++selSeq;
  engine.cancelLoad();
  activeFile = null;
  setActiveStats(null);
  activeTableRef = null; tableStage = 'none'; activeSqlName = null;
  const name = String(m.name || m.item).replace(/\.[^.]+$/, '');
  $('activeTable').textContent = `Table Health · ${name}`;
  clearResults('(reading what the lake holds…)');
  let rows;
  try { rows = await engine.lakehouseHealth(lakehouse); }
  catch (e) { if (my === selSeq) clearResults(`Table Health could not be worked out: ${e.message}`, { error: true }); return; }
  if (my !== selSeq) return;
  clearResults('');
  $('docView').innerHTML = lakehouseHealthHtml(name, rows);
  $('docView').hidden = false;
  $('docView').onclick = e => {
    const tr = e.target.closest('tr[data-sql]');
    if (tr) engine.openTable(tr.dataset.sql).catch(err => setStatus(`Could not open it: ${err.message}`, 'error'));
  };
}
function lakehouseHealthHtml(name, rows) {
  const held = rows.filter(r => r.inLake), found = held.filter(r => r.findings.length);
  const notRead = rows.length - held.length;
  const head = `<h2>Table Health · ${escapeHtml(name)}</h2><p class="statsNote">${n0(rows.length)} tables · ` +
    `${n0(found.length)} with findings${notRead ? ` · ${n0(notRead)} not read yet` : ''}</p>`;
  if (!rows.length) return head + '<p class="statsNote">No table of this lakehouse is known here yet: open it in the tree first.</p>';
  const cell = (v, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${escapeHtml(String(v))}</td>`;
  const body = rows.map(r => {
    const label = r.schema ? `${r.schema}.${r.table}` : r.table;
    if (!r.inLake) return `<tr data-sql="${escapeHtml(r.sqlName)}" class="notRead">${cell(label)}${cell('not read yet', 'action')}<td></td><td></td><td></td><td></td></tr>`;
    const f = r.facts, x = r.findings;
    return `<tr data-sql="${escapeHtml(r.sqlName)}">${cell(label)}` +
      cell(x.length ? x.map(y => y.finding).join(', ') : '—', x.length ? 'finding' : '') +
      cell(n0(f.files), 'num') + cell(f.files ? fmtMB(f.bytes / f.files) : '—', 'num') +
      cell(f.records && f.deleted ? `${Math.round(100 * f.deleted / f.records)}%` : '—', 'num') +
      cell(x.length ? x.map(y => y.action).filter((a, i, all) => all.indexOf(a) === i).join('; ') : '', 'action') + '</tr>';
  }).join('');
  return head + '<table class="health tableHealth"><thead><tr><th>Table</th><th>Finding</th><th class="num">Files</th>' +
    '<th class="num">Avg file</th><th class="num">Deleted</th><th>Action</th></tr></thead><tbody>' + body + '</tbody></table>' +
    '<p class="statsNote">From what this machine holds of each table: nothing was asked of OneLake. A table no query has read yet has no files here to look at.</p>';
}

const fmtMB = b => `${(b / 1048576).toLocaleString('en', { maximumFractionDigits: b < 10485760 ? 1 : 0 })} MB`;
function healthHtml(h) {
  if (!h || h.pending) return '';
  if (h.error) return `<h3>Health</h3><p class="statsNote">${escapeHtml(`Could not be worked out: ${h.error}`)}</p>`;
  const v = h.value;
  if (!v.inLake) {
    return '<h3>Health</h3><p class="statsNote">Its files are known here once a query has read the table: open Data, or query it.</p>';
  }
  const f = v.facts, found = v.findings || [];
  const head = `<h3>Health · ${found.length ? `${found.length} finding${found.length === 1 ? '' : 's'}` : 'no findings'}</h3>`;
  const list = found.length ? '<table class="health">' + found.map(x =>
    `<tr><td class="finding">${escapeHtml(x.finding)}</td><td>${escapeHtml(x.detail)}</td><td class="action">${escapeHtml(x.action)}</td></tr>`).join('') + '</table>' : '';
  const most = Math.max(1, ...f.sizes.map(b => b.files));
  const sizes = f.files ? '<table class="sizes">' + f.sizes.filter(b => b.files).map(b =>
    `<tr><th>${escapeHtml(b.label)}</th><td class="bar"><span style="width:${(100 * b.files / most).toFixed(1)}%"></span></td><td class="num">${n0(b.files)}</td></tr>`).join('') + '</table>' : '';
  const rows = [['Files', `${n0(f.files)}, ${fmtMB(f.files ? f.bytes / f.files : 0)} on average`]];
  if (f.deleted) rows.push(['Deleted rows', `${n0(f.deleted)} of ${n0(f.records)}, still in the files`]);
  const g = f.footers;
  const seen = g ? ` (${n0(g.files)} of ${n0(f.files)} files: the ones kept here)` : '';
  rows.push(['V-Order', g ? `${g.vorder === g.files ? 'yes' : g.vorder ? `${n0(g.vorder)} files` : 'no'}${seen}` : '— (no file of it is kept here)']);
  if (g && g.groups) rows.push(['Row groups', `${(g.groups / g.files).toLocaleString('en', { maximumFractionDigits: 1 })} per file, ` +
    `${n0(Math.round(g.rows / g.groups))} rows each${seen}`]);
  if (f.checkpointGap != null) rows.push(['Since the last checkpoint', `${n0(f.checkpointGap)} commits`]);
  return head + list + '<h3>File sizes</h3>' + sizes + kvTable(rows) +
    '<p class="statsNote">From what this machine holds of the table: nothing was asked of OneLake.</p>';
}

// The table as of its converted Delta version: one request the first time, and kept by
// the host for good — a version never changes.
async function loadDeltaState() {
  const t = activeTableRef;
  if (!t || mine(deltaState)) return;
  deltaState = { table: t, pending: true };
  let next;
  try { next = { table: t, value: await engine.deltaState(lakehouse, t) }; }
  catch (e) { next = { table: t, error: (e && e.message) || String(e) }; }
  if (activeTableRef !== t) return;
  deltaState = next;
  if (viewMode === 'stats') renderMeta();
}

// The commits, a page at a time: the first page when History opens, the next only when
// asked for. `more` appends to what is on screen.
async function loadHistory(more = false) {
  const t = activeTableRef;
  const had = mine(deltaHistory);
  if (!t || (had && (had.pending || (!more && !had.error)))) return;
  const skip = more && had && had.entries ? had.entries.length : 0;
  deltaHistory = { ...(more ? had : {}), table: t, pending: true, error: null };
  if (more) renderMeta();
  let next;
  try {
    const page = await engine.deltaHistory(lakehouse, t, skip);
    next = { ...page, table: t, entries: [...(more && had.entries ? had.entries : []), ...page.entries] };
  } catch (e) { next = { ...(more ? had : {}), table: t, error: (e && e.message) || String(e) }; }
  if (activeTableRef !== t) return;
  deltaHistory = next;
  if (viewMode === 'history') renderMeta();
}

// The Data tab is where the user first asks to see rows.
function onDataTab() {
  if (viewMode === 'data') return;
  // A query's results already under Stats are put back as they were, not replaced by a peek.
  if (tableStage === 'stats' && activeTableRef && !lastResult) { peekIntoView(); return; }
  showData();
}

function showData() {
  if (viewMode === 'data') return;
  viewMode = 'data';
  $('statsView').hidden = true;
  if (statsPrev) for (const [id, h] of statsPrev) $(id).hidden = h;
  statsPrev = null;
  setViewTabs();
}

// Pivot: the table as a model of its own (semantic.tableModel) in Explore's pivot, in place
// of the results until closed. It is made from the metadata already on screen, so opening it
// reads nothing: the first read is the first field put on a shelf. Kept while the table stays
// selected; closing it puts the table's tabs back as they were.
function setPivotOpen(open) {
  $('pivotView').hidden = !open;
  $('pivotView').closest('section').classList.toggle('pivotOpen', open);
}
const closePivot = () => setPivotOpen(false);
// Edit SQL: the pivot's query in the box, as SQL over the table, to be taken further by hand.
// Asked for, never on close.
function editPivotSql(sql) {
  if (!tablePivot) return;
  closePivot();
  putInBox(sql);
  setStatus("The pivot's query is in the box, over the table: run it (Ctrl+Enter), or change it first.", 'ok');
}
async function openPivot() {
  if (!activeInfo || !activeSqlName) return;
  if (tablePivot && tablePivot.table !== activeTableRef) dropTablePivot();
  setPivotOpen(true);
  if (tablePivot) return;
  const t = activeTableRef, sqlName = activeSqlName;
  tablePivot = { table: t, view: null };
  $('pivotView').innerHTML = '<div class="hint">Opening the pivot…</div>';
  try {
    const m = await semantic.tableModel(t.table, sqlName, activeInfo.columns);
    if (!tablePivot || tablePivot.table !== t) return;
    tablePivot.view = mountExplore($('pivotView'), {
      name: m.name,
      tmsl: tmslOf(m.tmsl), compiler: m.compiler,
      pages: ['pivot'], stateKey: `pivot.${sqlName}`,
      run: runModelSql,
      cancel: () => engine.cancelLoad(),
      echarts: loadEcharts,
      worldMap: loadWorldMap,
      setStatus,
      saveText: (name, text) => engine.saveText(name, text),
      copyText,
      loadState: viewState.get,
      saveState: viewState.set,
      profileSet: false,   // as the model view's (openModelView)
      htmlPlan: false,
      editSql: editPivotSql,
      plainSql: m.plainSql,
      close: closePivot,
    });
  } catch (e) {
    if (!tablePivot || tablePivot.table !== t) return;
    tablePivot = null;
    $('pivotView').innerHTML = `<div class="hint">${escapeHtml(`The pivot could not open: ${e.message}`)}</div>`;
    setStatus(`Visual: ${e.message}`, 'error');
    console.error(e);
  }
}
function dropTablePivot() {
  if (!tablePivot) return;
  tablePivot.view?.destroy();
  tablePivot = null;
  $('pivotView').replaceChildren();
  closePivot();
}

const n0 = v => v == null ? '—' : Number(v).toLocaleString('en');
const when = ms => ms == null ? '—' : new Date(ms).toLocaleString('en');
const kvTable = rows => '<table>' + rows.map(([k, v]) =>
  `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`).join('') + '</table>';
const columnsHtml = info => {
  const cols = info.columns || [];
  return cols.length
    ? '<h3>Columns</h3><table>' + cols.map(c =>
        `<tr><th>${escapeHtml(c.name)}</th><td>${escapeHtml(c.type || '')}</td></tr>`).join('') +
      '</table>'
    : '';
};

// A table written as Iceberg: only what the snapshot metadata said — a fact it doesn't
// carry is an em dash.
function statsCardHtml(info, delta) {
  if (info.db) return dbObjectHtml(info.db);
  if (isDelta(info)) return deltaCardHtml(info, delta);
  const s = info.stats || {};
  const deletes = info.posDeletes || info.eqDeletes || s.totalDeleteFiles;
  const rows = [];
  rows.push(['Rows', n0(info.totalRecords) +
    (deletes ? ' (physical — before delete files are applied)' : '')]);
  rows.push(['Data files', n0(info.fileCount)]);
  if (deletes) rows.push(['Delete files', n0(s.totalDeleteFiles)]);
  rows.push(['Total size', s.totalFilesSize == null ? '—' : engine.fmtBytes(s.totalFilesSize)]);
  if (s.totalFilesSize && info.fileCount)
    rows.push(['Avg file size', engine.fmtBytes(s.totalFilesSize / info.fileCount)]);
  rows.push(['Columns', n0((info.columns || []).length)]);
  rows.push(['Partitioning', (s.partitionColumns || []).length ? s.partitionColumns.join(', ') : 'none']);
  rows.push(['Compression', s.codec || '—']);
  rows.push(['Last write', s.snapshotTs == null ? '—' :
    when(s.snapshotTs) + (s.operation ? ` (${s.operation})` : '')]);
  rows.push(['Snapshots', n0(s.snapshotCount || null)]);
  if (s.formatVersion != null) rows.push(['Format', `Iceberg v${s.formatVersion}`]);
  if (s.vorderProp != null) rows.push(['V-Order', s.vorderProp ? 'enabled' : 'disabled']);

  const note = 'From the Iceberg snapshot metadata — no data has been read yet. ' +
    'Open Data for the first rows, or query the table in the box.';
  return kvTable(rows) + columnsHtml(info) + `<p class="statsNote">${escapeHtml(note)}</p>`;
}

// A table written as Delta, as of the version its Iceberg metadata was converted from —
// the same version the row count describes, so every line on the card agrees.
function deltaCardHtml(info, state) {
  const s = info.stats || {};
  const d = state && state.value;
  const rows = [];
  rows.push(['Format', 'Delta' + (d && d.minReaderVersion != null
    ? ` (reader v${d.minReaderVersion}, writer v${d.minWriterVersion})` : '')]);
  if (s.deltaVersion != null) rows.push(['Version', n0(s.deltaVersion)]);
  rows.push(['Rows', n0(info.totalRecords)]);
  if (d && d.deletedRows) rows.push(['Deleted rows', `${n0(d.deletedRows)} (deletion vectors, not yet purged)`]);
  rows.push(['Data files', n0(d && d.numFiles != null ? d.numFiles : info.fileCount)]);
  const size = d && d.sizeBytes != null ? d.sizeBytes : s.totalFilesSize;
  rows.push(['Total size', size == null ? '—' : engine.fmtBytes(size)]);
  rows.push(['Columns', n0((info.columns || []).length)]);
  rows.push(['Partitioning', (d ? d.partitionColumns : s.partitionColumns || []).join(', ') || 'none']);
  rows.push(['Compression', s.codec || '—']);
  rows.push(['Last write', s.snapshotTs == null ? '—' :
    when(s.snapshotTs) + (s.operation ? ` (${s.operation})` : '')]);
  if (d && d.createdTime != null) rows.push(['Created', when(d.createdTime)]);
  if (d) rows.push(['Features', d.features.length ? d.features.join(', ') : 'none']);

  const props = d ? Object.entries(d.properties || {}).sort(([a], [b]) => a.localeCompare(b)) : [];
  const propsHtml = props.length ? '<h3>Table properties</h3>' + kvTable(props) : '';
  const note = !state || state.pending ? 'Reading the Delta log…'
    : state.error ? `The Delta log could not be read: ${state.error}. What is shown comes from the Iceberg metadata.`
    : !d.source ? 'The Delta log keeps no summary of this version (no crc, no checkpoint), so only the Iceberg metadata is shown.'
    : `From the Delta log${d.source === 'checkpoint' ? ` (its checkpoint at version ${n0(d.asOf)})` : ''} and the ` +
      'Iceberg metadata Fabric converted from it — nothing was scanned to show this.';
  return kvTable(rows) + propsHtml + columnsHtml(info) + `<p class="statsNote">${escapeHtml(note)}</p>`;
}

// A snapshot against the newest one (the table now): rows, and columns by name.
const rowsVsNow = (h, now) => {
  if (h === now || h.totalRows == null || !now || now.totalRows == null) return '—';
  const d = now.totalRows - h.totalRows;
  return d === 0 ? 'same' : `${d > 0 ? '+' : '−'}${n0(Math.abs(d))} since`;
};
const columnsVsNow = h => !h.columns ? '—'
  : [h.columns.added.length ? `added since: ${h.columns.added.join(', ')}` : '',
     h.columns.removed.length ? `dropped since: ${h.columns.removed.join(', ')}` : ''].filter(Boolean).join('; ');

// An Iceberg snapshot, queried as it was: its rows, in the box.
function querySnapshot(id) {
  if (!activeInfo || !activeInfo.metadataLocation || !/^\d+$/.test(String(id))) return;
  const loc = String(activeInfo.metadataLocation).replace(/'/g, "''");
  putInBox(`-- ${activeSqlName || $('activeTable').textContent} as of snapshot ${id}\n` +
           `SELECT *\nFROM iceberg_scan('${loc}', snapshot_from_id = ${id})\nLIMIT ${settings.selectTopRows};\n`);
  setStatus(`Snapshot ${id} is in the box: run it (Ctrl+Enter).`, 'ok');
}

// Newest first: the Delta log's commits, or an Iceberg table's snapshots.
function historyHtml(info, hist) {
  const deltaTable = isDelta(info);
  if (deltaTable && (!hist || (hist.pending && !hist.entries))) return '<p class="statsNote">Reading the Delta log…</p>';
  if (deltaTable && hist.error && !hist.entries)
    return `<p class="statsNote">${escapeHtml(`The Delta log could not be read: ${hist.error}`)}</p>`;
  const list = deltaTable ? hist.entries : (info.stats.history || []);
  if (!list.length) return '<p class="statsNote">No history recorded.</p>';

  const files = h => h.filesAdded == null && h.filesRemoved == null ? '—'
    : `+${n0(h.filesAdded || 0)} / −${n0(h.filesRemoved || 0)}`;
  const params = h => h.parameters ? Object.entries(h.parameters)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ') : '';
  const cols = deltaTable
    ? [['Version', h => h.version, 'num'], ['When', h => when(h.timestamp)], ['Operation', h => h.operation || '—'],
       ['Rows added', h => n0(h.rowsAdded), 'num'], ['Rows deleted', h => n0(h.rowsRemoved), 'num'],
       ['Rows updated', h => n0(h.rowsUpdated), 'num'], ['Files', files, 'num'],
       ['Size added', h => h.bytesAdded == null ? '—' : engine.fmtBytes(h.bytesAdded), 'num'],
       ['Engine', h => h.engine || '—'], ['User', h => h.user || '—'], ['Parameters', params, 'params']]
    : [['Snapshot', h => h.version, 'num'], ['When', h => when(h.timestamp)], ['Operation', h => h.operation || '—'],
       ['Rows added', h => n0(h.rowsAdded), 'num'], ['Rows deleted', h => n0(h.rowsRemoved), 'num'],
       ['Files', files, 'num'], ['Size added', h => h.bytesAdded == null ? '—' : engine.fmtBytes(h.bytesAdded), 'num'],
       ['Total rows', h => n0(h.totalRows), 'num'], ['Rows vs now', h => rowsVsNow(h, list[0]), 'num'],
       ['Columns vs now', columnsVsNow], ['Engine', h => h.engine || '—']];
  // A column nobody filled (no commit carried a user) is noise, not information.
  const shown = cols.filter(([, f], i) => i < 3 || list.some(h => !['—', ''].includes(String(f(h)))));
  // An Iceberg snapshot can be queried as it was (iceberg_scan's snapshot_from_id).
  const canQuery = !deltaTable && !!info.metadataLocation;
  const table = '<table class="history"><tr>' + (canQuery ? '<th></th>' : '') + shown.map(([h]) => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>' +
    list.map(h => '<tr>' + (canQuery ? `<td><button data-snapshot="${escapeHtml(h.version)}" title="This snapshot's rows, as a query in the box">Query</button></td>` : '') +
      shown.map(([, f, cls]) =>
      `<td${cls ? ` class="${cls}"` : ''}>${escapeHtml(String(f(h)))}</td>`).join('') + '</tr>').join('') +
    '</table>';
  if (!deltaTable) {
    const note = `The table's Iceberg snapshots, newest first (${n0(list.length)} of ${n0(info.stats.snapshotCount)}).`;
    return table + `<p class="statsNote">${escapeHtml(note)}</p>`;
  }
  // Each page is a request per commit, so the next one is read only when asked for.
  const more = list.length < hist.total
    ? `<p><button id="historyMore"${hist.pending ? ' disabled' : ''}>${hist.pending ? 'Reading…' : 'Show 10 more'}</button></p>` : '';
  const note = `The newest ${n0(list.length)} of ${n0(hist.total)} commit(s) in the Delta log` +
    (hist.oldest > 0 ? `; versions before ${n0(hist.oldest)} were cleaned up by log retention.` : '.') +
    (hist.error ? ` The next page could not be read: ${hist.error}` : '');
  return table + more + `<p class="statsNote">${escapeHtml(note)}</p>`;
}

// ---------------------------------------------------------------------------
// Saving: a grid of rows saves as CSV; a FILE opened from the tree saves as that file,
// byte for byte, straight from OneLake.
// ---------------------------------------------------------------------------
function saveIsFile() {
  return !!(activeFile && (imageUrl || (lastResult && docOf(lastResult) != null)));
}

function setSaveLabel() {
  const btn = $('csvBtn');
  const file = saveIsFile();
  btn.textContent = file ? 'Save file' : 'Export…';
  btn.title = file ? `Save ${activeFile.name} exactly as it is stored`
                   : 'Every row of the query, to a CSV, Parquet or Excel file';
}

// Both go through VS Code's own save dialog (the host writes the file): the bytes of a
// OneLake file never cross into the page to be saved, and a dismissed dialog is no error.
async function saveActive() {
  const btn = $('csvBtn');
  btn.disabled = true;
  // What was on screen: a click elsewhere meanwhile has set the button for what is there now.
  const shown = lastResult, image = imageUrl;
  try {
    const saved = saveIsFile()
      ? await engine.saveOneLakeFile(lakehouse, activeFile)
      : await exportQuery();
    if (saved) setStatus(`Saved ${saved}.`, 'ok');
  } catch (e) {
    setStatus('Save failed: ' + e.message, 'error');
  } finally {
    if (lastResult === shown && imageUrl === image) btn.disabled = false;
  }
}

// A query from the box: the panel is the query's now, not the last table's or file's. A query
// names its tables Kind.workspace.item.schema.table, so it runs as it is, whatever was selected.
function enterQuery(title) {
  closeModelView();
  ++selSeq;                     // whatever was loading for the last click stands down
  engine.cancelLoad();
  activeTableRef = null;
  activeFile = null;
  activeSqlName = null;
  activeDocEligible = false;
  activeDocExt = '';
  tableStage = 'none';
  setActiveStats(null);         // the last table's tabs and pivot are not this query's
  if (db) db.browser.select(null);
  $('activeTable').textContent = title ? `Query: ${title}` : 'Query';
}

// The SQL box: written, run and saved here, so a query never opens a .sql file, and nothing else
// in VS Code has a say in it. It holds one query: the saved one it came from, when it did. A .sql file
// opened from disk is one too, and `boxFile` is its path: Save writes it back there.
let activeQuery = null;
let boxFile = null;
const sameName = (a, b) => a != null && String(a).toLowerCase() === String(b).toLowerCase();
function nameBoxQuery(name) {
  activeQuery = name;
  keepDraft();
}
// Kept by the host, so it comes back with the next panel, in the next window too.
let draftTimer = null;
function keepDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (engine) engine.saveDraft({ sql: $('sqlEditor').value, name: activeQuery }).catch(() => {});
  }, 500);
}
// The box on screen, with whatever covers it put away.
function showBox() {
  closeModelView();
  if (tablePivot) closePivot();
  return $('sqlEditor');
}
// Text put in the box as if typed, so Ctrl+Z brings back what was there. value= and setRangeText
// both empty a textarea's undo.
function typeInBox(box, text) {
  box.focus();
  if (!document.execCommand('insertText', false, text)) box.setRangeText(text, box.selectionStart, box.selectionEnd, 'end');
}
function putInBox(sql) {
  const box = showBox();
  box.focus();
  box.select();
  typeInBox(box, sql);
  clearTimeout(draftTimer);     // what was put here isn't a draft to keep
  nameBoxQuery(null);
  boxFile = null;
  box.setSelectionRange(0, 0);
}
// What was clicked, as SQL to start from: a click isn't a request to type, so the cursor stays where
// it is, and it never replaces what someone wrote. Nor is it a draft to keep.
let offered = '';
function offerInBox(sql) {
  const box = $('sqlEditor');
  if (box.value.trim() && box.value !== offered) return;
  box.value = offered = sql;
  activeQuery = null;
  boxFile = null;
}
function openInBox(sql, name, file = null) {
  putInBox(sql);
  nameBoxQuery(name);
  boxFile = file;
  $('activeTable').textContent = name ? `Query: ${name}` : 'Query';
  setStatus(name ? `${name} — Run ▶ (Ctrl+Enter) to run it.` : 'Run ▶ (Ctrl+Enter) runs the statement under the cursor.');
}
let leavingBox = false;
function onBoxKey(e) {
  const box = e.target;
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runBox(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveBox(); }
  else if (e.key === 'Tab' && !e.shiftKey) {
    // Tab indents here, so Esc then Tab is how the keyboard leaves the box.
    if (leavingBox) { leavingBox = false; return; }
    e.preventDefault();
    typeInBox(box, '  ');
    keepDraft();
  }
  leavingBox = e.key === 'Escape';
}
// The selection when there is one, else the statement under the cursor: { start, end }.
function boxStatement() {
  const box = $('sqlEditor'), text = box.value;
  if (box.selectionStart !== box.selectionEnd) {
    const span = { start: box.selectionStart, end: box.selectionEnd };
    return text.slice(span.start, span.end).trim() ? span : null;
  }
  return statementAt(statements(text), box.selectionStart);
}
// Query variables for this session, by lower-cased name: SET VARIABLE in the box sets one,
// getvariable('name') reads it, and one never set is asked for the first time it is read.
const variables = new Map();
async function bindBoxVariables(sql) {
  for (const name of variablesIn(sql)) {
    if (variables.has(name.toLowerCase())) continue;
    const typed = await engine.askVariable(name);
    if (typed == null) return null;
    variables.set(name.toLowerCase(), literal(typed));
  }
  return bindVariables(sql, variables);
}
async function runBox({ plan = false } = {}) {
  const box = $('sqlEditor'), text = box.value;
  const span = boxStatement();
  if (!span) { setStatus('Nothing here to run: write a statement, or put the cursor in one.'); return; }
  // A selection can hold several statements: each runs in turn, in order, and the run stops at the first that
  // fails, with the cursor on it. What the last one answers is on screen.
  const parts = statements(text.slice(span.start, span.end)).map(p => ({ start: span.start + p.start, end: span.start + p.end }));
  if (parts.length <= 1) return runOne(parts[0] || span, { plan, text });
  if (plan) { setStatus('Plan shows one statement: put the cursor in one, or select only that one.', 'warn'); return; }
  try {
    for (let i = 0; i < parts.length; i++) {
      stepNote = `${i + 1}/${parts.length}`;
      if (!await runOne(parts[i], { text })) return;
    }
  } finally { stepNote = ''; }
}
// One statement of the box, `span` of `text`: true when it ran.
async function runOne(span, { plan = false, text }) {
  const box = $('sqlEditor');
  const written = text.slice(span.start, span.end);
  try {
    // SET VARIABLE is the page's, not the engine's: kept here and answered at once. Bound now:
    // DuckDB never holds the variables, so getvariable('a') in b's value would be NULL.
    const set = setVariable(written);
    if (set) {
      const value = await bindBoxVariables(set.value);
      if (value == null) { setStatus('Cancelled: the variable has no value.'); return false; }
      variables.set(set.name.toLowerCase(), value);
      setStatus(`${set.name} = ${value}`, 'ok');
      return true;
    }
    const sql = await bindBoxVariables(written);
    if (sql == null) { setStatus('Cancelled: the query needs that variable.'); return false; }
    // Before anything is cancelled: this Plan would be refused, and would have stopped the one under way.
    if (plan && planning) { setStatus('A plan is still being measured: wait for it, then plan again.', 'warn'); return false; }
    enterQuery(activeQuery);
    // EXPLAIN [ANALYZE] written in the box is Plan: the profile and the tree, not two columns of text.
    // One with options, EXPLAIN (FORMAT json) …, runs as written: its text is what was asked for.
    const explain = /^\s*EXPLAIN(?:\s+ANALY[SZ]E)?\s+(?!\()/i.exec(sql);
    const ok = plan || explain ? await showPlan(explain ? sql.slice(explain[0].length) : sql) : await runQuery({ sql });
    // The cursor goes where DuckDB says the error is, as the statement is written. Not a
    // selection: the next Ctrl+Enter runs the statement again, not one word of it.
    // One of several with no place in it said: the statement's start.
    if (!ok && lastRun.error && box.value === text) {
      const at = lastRun.rewritten ? null : errorOffset(lastRun.error, written);
      if (at != null || stepNote) { box.focus(); box.setSelectionRange(span.start + (at || 0), span.start + (at || 0)); }
    }
    return ok;
  } catch (e) {
    setStatus('Could not run that: ' + e.message, 'error');
    return false;
  }
}
// Save Query: back to the .sql file the box came from, over the saved query it came from, else as the next
// free "Query N", with nothing asked (Rename in the tree names it).
async function saveBox() {
  const sql = $('sqlEditor').value;
  if (!sql.trim()) { setStatus('Nothing to save: write a query first.'); return; }
  try {
    const saved = await engine.saveQuery(activeQuery || '', sql, boxFile);
    nameBoxQuery(saved.name);
    if ($('activeTable').textContent.startsWith('Query')) $('activeTable').textContent = `Query: ${saved.name}`;
    setStatus(saved.file ? `Saved to ${saved.file}.` : `Saved as ${saved.name} under Queries.`, 'ok');
  } catch (e) {
    setStatus('Could not save the query: ' + e.message, 'error');
  }
}

// Chart: the rows on screen drawn (chart.js), in place of the grid until Show Rows.
let chart = null, chartSeq = 0;
// What the chart covers, put back on Show Rows: the Pretty document, or the grid, and the Raw/Pretty bar.
let underChart = null;
function hideChart() {
  chartSeq++;
  if (chart) { chart.destroy(); chart = null; }
  $('chartView').hidden = true;
  $('chartBtn').textContent = 'Chart';
}
function showUnderChart() {
  const was = underChart || { doc: false, docBar: $('docBar').hidden };
  underChart = null;
  $('docBar').hidden = was.docBar;
  $('docView').hidden = !was.doc;
  $('resultsTable').hidden = was.doc;
  $('gridBar').hidden = was.doc || !grid;
}
async function toggleChart() {
  if (chart || !$('chartView').hidden) {
    hideChart();
    showUnderChart();
    return;
  }
  if (!lastResult || !lastResult.rows.length) return;
  const seq = ++chartSeq;
  underChart = { doc: !$('docView').hidden, docBar: $('docBar').hidden };
  $('chartView').hidden = false;
  $('resultsTable').hidden = true;
  $('gridBar').hidden = true;
  $('docView').hidden = true;
  $('docBar').hidden = true;
  $('chartBtn').textContent = 'Show Rows';
  try {
    const c = await mountChart($('chartView'), lastResult, { echarts: loadEcharts, css: pageCss, say: t => setStatus(t, 'ok') });
    if (seq !== chartSeq) { c.destroy(); return; }
    chart = c;
  } catch (e) {
    if (seq === chartSeq) { hideChart(); showUnderChart(); setStatus('Could not draw the chart: ' + e.message, 'error'); }
  }
}

// A VS Code theme switch: the chart is drawn again in the new theme (ECharts cannot re-theme one).
new MutationObserver(() => { if (chart) { hideChart(); showUnderChart(); toggleChart(); } })
  .observe(document.body, { attributes: true, attributeFilter: ['class'] });

// Profile: each column of the query on screen, every row of it — DuckDB's SUMMARIZE: its type,
// min and max, distinct values (approximately), average, spread, quartiles, count and nulls. In
// place of the result; running the query again puts it back. A semantic model's query is
// profiled as the SQL it compiles to.
async function profileResult() {
  if (!currentSql) return;
  const title = ($('activeTable').textContent || '').replace(/^(Query|Profile): /, '');
  $('activeTable').textContent = `Profile: ${title || 'query'}`;
  await runQuery({ summarize: currentSql, doc: false });
}

// Export: the query on screen, every row (not the rows the page holds), to a file: the host
// asks which format and where, and its DuckDB writes it. A semantic model's query is exported as
// the SQL it compiles to.
async function exportQuery() {
  if (!currentSql) return null;
  const name = ($('activeTable').textContent || 'query').replace(/^Query: /, '');
  const model = await semantic.statement(currentSql, null);
  return engine.exportResult({ sql: model ? model.sql : currentSql, name });
}

// ---------------------------------------------------------------------------
// Status bar: where the last answers came from, and which build this is
// ---------------------------------------------------------------------------
// Every OneLake request is the host's, so the page cannot see them — the extension counts
// a burst and sends the total. Not written through setStatus: this is a standing fact.
function showReads(m) {
  const el = $('readSrc');
  el.hidden = false;
  el.className = '';
  const secs = ((m.netMs || 0) / 1000).toFixed(1);
  if (!m.misses) {
    el.textContent = '▤ cache';
    el.className = 'local';
  } else if (m.hits) {
    el.textContent = `▤ ${m.hits} · ☁ ${m.misses} · ${secs}s`;
  } else {
    el.textContent = `☁ OneLake · ${secs}s`;
  }
  el.title = [
    `${m.reads} answer(s) behind the last thing you waited for.`,
    m.hits ? `${m.hits} from this machine's cache.` : 'None came from the cache.',
    m.misses ? `${m.misses} from OneLake (${secs}s).` : '',
    'Click for the full read log.',
  ].filter(Boolean).join('\n');
}

// A Marketplace install, a sideloaded vsix and an F5 checkout look identical from inside;
// the stamp is what tells them apart.
function showVersion() {
  const b = cfg.build || {};
  const commit = b.commit || 'unknown';
  $('statusVer').textContent = `build ${commit}${b.dev ? ' · dev' : ''}`;
  $('statusVer').title = `OneLake Studio ${b.version || ''} at ${commit}`.trim();
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
// `stoppable`: table loads, file loads and queries — everything cancelLoad() reaches.
function setBusy(b, { stoppable = false } = {}) {
  const stop = $('stopBtn');
  stop.hidden = !(b && stoppable);
  if (!stop.hidden) stop.disabled = false;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
showVersion();
wireUi();
engine = createEngine({ onStatus: setStatus, onBoot: reportBoot, viewTag: cfg.viewTag, topRows: () => settings.selectTopRows, ...(cfg.maxRows ? { maxRows: cfg.maxRows } : {}) });
// A visual, a pivot and a Report tile ask for as many rows as a result may keep (maxResultRows).
if (cfg.maxRows) setRowCap(cfg.maxRows);
engineReady = engine.init();
if (cfg.draft) {
  $('sqlEditor').value = String(cfg.draft.sql || '');
  nameBoxQuery(cfg.draft.name ? String(cfg.draft.name) : null);
}
semantic.setTableNamer(list => engine.nameTables(list));
viewsListed = listViews();
viewsReady = loadViews().catch(e => console.warn('[views]', e.message));

startEngine().catch(e => {
  setStatus('Engine failed to start: ' + e.message, 'error');
  console.error(e);
});

// The extension's messages: the tree's clicks, and facts about the host's reads.
window.addEventListener('message', async e => {
  const m = e.data || {};
  try {
    if (m.type === 'open-table') {
      const t0 = Date.now();
      await openTable(m);
      reportOpened('table', m.schema ? `${m.schema}.${m.table}` : m.table, Date.now() - t0);
    } else if (m.type === 'open-file') {
      const t0 = Date.now();
      await openFile(m);
      reportOpened('file', basename(m.path), Date.now() - t0);
    }
    // A Refresh: what this side holds about the old listings is suspect.
    // A semantic model the extension downloaded to this machine, handed over as text.
    else if (m.type === 'open-model') {
      const t0 = Date.now();
      // Reported even when it fails: the host's progress notification waits for this.
      try {
        // From the tree a semantic model (modelWorkspace); from disk a model file, or an app's file
        // (appFile) on its own model, in the workspace its tables are in (workspace).
        await openModelView({ name: String(m.name || 'model.yaml'), path: String(m.path || ''),
                              modelWorkspace: m.modelWorkspace ? String(m.modelWorkspace) : null,
                              localWorkspace: m.workspace ? String(m.workspace) : null,
                              appFile: m.appFile ? String(m.appFile) : null,
                              appModel: m.appModel ? String(m.appModel) : null,
                              appModelFile: m.appModelFile ? String(m.appModelFile) : null,
                              openOn: m.openOn ? String(m.openOn) : null,
                              modelName: m.modelName ? String(m.modelName) : null }, String(m.text || ''));
      } finally {
        reportOpened('file', String(m.name || 'model.yaml'), Date.now() - t0);
      }
    }
    // SQL for the box, from the tree: a new query, a saved one, Select Top Rows (run at once).
    // A .sql file from disk too, with its path: Save writes it back there.
    else if (m.type === 'query') openInBox(String(m.sql ?? ''), m.name ? String(m.name) : null, m.file ? String(m.file) : null);
    else if (m.type === 'run-sql') { openInBox(String(m.sql ?? ''), null); await runBox(); }
    // A lakehouse's Table Health: every table this machine holds, from the lake.
    else if (m.type === 'lakehouse-health') await showLakehouseHealth(m);
    // Go to: a name, put at the cursor.
    else if (m.type === 'insert-sql') {
      const box = showBox();
      typeInBox(box, String(m.text ?? ''));
      box.focus();
      keepDraft();
    }
    else if (m.type === 'query-renamed') { if (sameName(activeQuery, m.from)) nameBoxQuery(String(m.to)); }
    else if (m.type === 'query-deleted') { if (sameName(activeQuery, m.name)) nameBoxQuery(null); }
    else if (m.type === 'clear-variables') {
      setStatus(`${variables.size} query variable(s) cleared.`, 'ok');
      variables.clear();
    }
    else if (m.type === 'reset') {
      await engineReady;
      // No lakehouse from the start, and a goToLakehouse already under way stands down.
      const left = leaveLakehouse();
      lakehouse = null;
      ++goSeq;
      resetting = left;
      try { await left; } finally { if (resetting === left) resetting = null; }
    }
    else if (m.type === 'reads') showReads(m);
    // The webview's context menu on the grid: Copy, with headers, as CSV, Markdown or JSON.
    else if (m.type === 'grid-copy') { if (grid) grid.copy(String(m.as || 'tsv')); }
    else if (m.type === 'grid-open') {
      if (grid) await engine.openDocument({ as: m.as === 'json' ? 'json' : 'csv', content: grid.text(m.as === 'json' ? 'json' : 'csv') });
    }
    // Why the catalog is taking long — conversion pending, catalog busy.
    else if (m.type === 'status' && m.message) setStatus(m.message);
    // Offline or back: whether the table on screen can have a Data tab.
    else if (m.type === 'connectivity') {
      if (activeInfo && activeTableRef) { await engineReady; await checkDataTab(); setViewTabs(); }
    }
    else if (m.type === 'settings') {
      settings.tableOpensOn = m.tableOpensOn;
      settings.gridThousandsSeparator = m.gridThousandsSeparator;
      if (m.selectTopRows) settings.selectTopRows = m.selectTopRows;
      if (grid) grid.redraw();
    }
  } catch (err) {
    setStatus('Could not open that: ' + err.message, 'error');
    console.error(err);
  }
});

// Said as soon as the listener above exists: until then the extension holds the last click
// rather than dropping it. Not held for the engine — every handler waits for engineReady
// itself, and a semantic model handed over as text needs no engine to be drawn. A boot
// that FAILS is said too, so the extension can offer a reload instead of a spinner.
vs.postMessage({ type: 'ready' });
engineReady.catch(e => vs.postMessage({ type: 'boot-failed', message: (e && e.message) || String(e) }));
