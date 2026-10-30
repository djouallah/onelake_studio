// =============================================================================
// app.js — the OneLake Studio panel
// =============================================================================
// A view, driven by the extension: the OneLake tree in the editor's sidebar says what to
// open (open-table / open-file), and this page shows it — a table's statistics, its first
// rows, a SQL editor over it, a file as a table or a document, a .bim (or an Ossie .yaml)
// as its semantic model. Every statement and every OneLake read goes to the extension host
// (data.js -> host.js); this file only decides what to show.
// =============================================================================
import { createEngine } from './data.js';
import { isDocResult, textLinesDoc, fileExt, isTextExt, escapeHtml, basename,
         IMAGE_EXTS, sqlNeedsTable, quoteIdent, abfssUrl } from './paths.js';
// Static import is safe: docview.js is tiny — the markdown renderer it uses is imported
// only inside renderMarkdown(), and only for a document that IS markdown.
import { renderDocument } from './docview.js';
// Static too, and as cheap: the DAX compiler it runs is imported on the first model only.
import * as semantic from './semantic.js';
// A .bim's model view. Explore's chart library is loaded when the Pivot first opens.
import { mountExplore } from './explore/view.js';
import { PINS, npmFile } from './cdn.js';
import { tmslOf } from './explore/model.js';
import { createPlanView, profileSql } from './explore/profile.js';
import { PALETTE } from './explore/theme.js';
import { vscodeApi } from './vscode-api.js';

const $ = id => document.getElementById(id);

// Per-panel UI state (Explore's shelves), kept by VS Code for this webview: it survives
// the tab being hidden and the window reloading, with no browser storage involved.
const viewState = {
  get: key => (vs.getState() || {})[key],
  set: (key, value) => vs.setState({ ...(vs.getState() || {}), [key]: value }),
};
const cfg = window.ONELAKE_STUDIO_CONFIG || {};
const vs = vscodeApi();

// Cap on rendered rows only. The CSV saves everything the engine materialised, which is
// itself capped — runQuery says so when the two differ.
const MAX_DOM_ROWS = 2000;
let engine = null;
let engineReady = null;      // resolves when engine.init() has finished; gates every use of it
let engineUp = false;        // ...and the settled form of it, for the synchronous checks
let lakehouse = null;        // { workspace, item }
let activeIdent = null;      // quoted identifier of the loaded table
let activeSqlName = null;    // the selected table's SQL name (lakehouse.ws.item.schema.table)
let activeQuery = null;      // the saved query in the SQL box (its name), when one was opened or saved
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
// A selection buys the cheapest thing that answers the question: 'stats' = metadata
// only, 'peek' = the first rows, 'loaded' = a real view. Each only when asked for.
let activeTableRef = null;   // the table object behind the selection, for escalating
let tableStage = 'none';     // 'none' | 'stats' | 'peek' | 'loaded'
let freshLoad = null;        // info from an escalation that still owes the user a report

// The extension's read log prints these beside its own lines.
const reportBoot = b => vs.postMessage({ type: 'boot', ...b });
const reportOpened = (kind, label, ms) => vs.postMessage({ type: 'opened', kind, label, ms });

function setStatus(msg, type = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = type;
  // One ellipsised line; an error is long and its useful half is the tail. Hover for it,
  // click an error open.
  el.title = msg;
  el.classList.toggle('clickable', type === 'error');
  el.onclick = type === 'error' ? () => el.classList.toggle('expanded') : null;
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
  // Wrapped, not passed directly: onclick hands the handler a MouseEvent.
  $('runBtn').onclick = () => runWithTable();
  // Disable on the way out: the load ends at its next checkpoint, not this instant.
  $('stopBtn').onclick = () => {
    engine.cancelLoad();
    $('stopBtn').disabled = true;
    setStatus('Stopping…');
  };
  $('planBtn').onclick = () => showPlan();
  $('pivotBtn').onclick = openPivot;
  $('csvBtn').onclick = saveActive;
  $('saveQueryBtn').onclick = saveQuery;
  $('docPretty').onclick = () => {
    if (docMode === 'pretty' || !lastResult) return;
    docMode = 'pretty';
    showDoc(docOf(lastResult));
  };
  $('docRaw').onclick = () => {
    docMode = 'raw';
    setDocTabs();
    $('docView').hidden = true;
    $('resultsTable').hidden = false;
  };
  $('viewData').onclick = onDataTab;
  $('viewStats').onclick = showStats;
  $('viewHistory').onclick = showHistory;
  $('statsView').addEventListener('click', e => { if (e.target.id === 'historyMore') loadHistory(true); });
  $('sqlEditor').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runWithTable(); }
  });
  $('readSrc').onclick = () => vs.postMessage({ type: 'show-log' });
}

async function startEngine() {
  await engineReady;
  engineUp = true;
  $('runBtn').disabled = false;   // SQL needs the engine, not a lakehouse
  const before = selSeq;          // a click during boot outranks everything said below
  let landingFailed = false;
  if (README_SQL && !$('sqlEditor').value) {
    $('sqlEditor').value = README_SQL;
    landingFailed = !await runQuery();
  }
  // A click while the welcome page was loading owns the status bar (and cancelled it).
  if (selSeq !== before || activeTableRef || activeFile) return;
  setStatus('DuckDB ready — run SQL now, or pick a table in the OneLake sidebar.' +
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

// The panel follows the tree: moving to another lakehouse hands the previous one's views
// back before anything of the new one is opened.
async function goToLakehouse(workspace, item) {
  await engineReady;
  if (lakehouse && lakehouse.workspace === workspace && lakehouse.item === item) return;
  const resetP = lakehouse ? leaveLakehouse({ forget: false }) : null;
  lakehouse = { workspace, item };
  if (resetP) await resetP;
}

// What was on screen belonged to the lakehouse being left: a file kept on screen with no
// lakehouse behind it offered a Save that could only fail.
function leaveLakehouse(opts) {
  closeModelView();
  activeIdent = null;
  activeQuery = null;
  activeFile = null;
  setActiveStats(null);
  activeTableRef = null; tableStage = 'none';
  clearResults();
  $('activeTable').textContent = 'No table selected';
  setBusy(false);
  return engine.reset(opts);
}

async function openTable(m) {
  await goToLakehouse(m.workspace, m.item);
  await selectTable({ schema: m.schema || '', table: m.table });
}

// The message carries everything a listing would have: the tree just read this
// directory. Whether a reader exists is loadFile's to decide, and it says so.
async function openFile(m) {
  await goToLakehouse(m.workspace, m.item);
  const entry = { name: basename(m.path), path: m.path, isDir: false, bytes: m.bytes || 0,
                  modelWorkspace: m.modelWorkspace || null };
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
  $('sqlEditor').value = `-- loading ${file.name}…`;
  setBusy(true, { stoppable: true });
  try {
    const info = await engine.loadFile(lakehouse, file);
    if (my !== selSeq) return;
    activeIdent = info.ident;
    // A database file with no tables attaches but leaves nothing to preview.
    if (info.ident) {
      $('sqlEditor').value = previewSql(info.ident, activeDocEligible);
      $('runBtn').disabled = false;
      reportLoad(info, await runQuery({ doc: activeDocEligible, ext: activeDocExt }));
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
// (explore/view.js) in place of the editor and the results — Model, Pivot, Logs — and is
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
function closeModelView() {
  if (!modelView) return;
  modelView.destroy();
  modelView = null;
  $('modelView').hidden = true;
  $('modelView').closest('section').classList.remove('modelOpen');
}

// A .bim from Files/ (read through the host), or one the extension downloaded from Fabric
// and hands over as text (open-model): the same view either way. An Ossie .yaml from Files/
// comes with its text already read (selectFile looked), and is still a OneLake file.
async function openModelView(file, text = null, { fromOneLake = text == null } = {}) {
  closeModelView();
  const my = ++selSeq;
  engine.cancelLoad();
  $('activeTable').textContent = file.name;
  activeFile = fromOneLake ? file : null;   // only a OneLake file can be saved as itself
  activeIdent = null;
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
    // name; else the file, in the workspace it is in, by its name.
    const schema = file.modelWorkspace || (fromOneLake && lakehouse ? lakehouse.workspace : null);
    const m = await semantic.registerModel(file.name, bim, null, schema, file.modelName);
    // Kept by the host as a semantic view too, so it is there after a restart and the
    // command line can name it. Best effort: the view on screen does not depend on it.
    engine.semanticKeep(m.view, fromOneLake ? abfssUrl(lakehouse.workspace, file.path) : file.path, m.schema)
      .catch(e => console.warn(`[views] ${m.name} not kept: ${e.message}`));
    if (my !== selSeq) return;
    $('modelView').closest('section').classList.add('modelOpen');
    $('modelView').hidden = false;
    modelView = mountExplore($('modelView'), {
      name: m.name, title: m.file, tmsl: tmslOf(m.bim), compiler: m.exploreCompiler,
      run: runModelSql,
      echarts: loadEcharts,
      setStatus,
      saveText: (name, text) => engine.saveText(name, text),
      loadState: viewState.get,
      saveState: viewState.set,
      // The native engine set the profile's metrics before it locked its configuration, and
      // the panel's CSP runs no inline script (DuckDB's HTML plan): its text plan instead.
      profileSet: false,
      htmlPlan: false,
      logsNote: 'This panel only — kept in memory, nothing is stored. The extension reads OneLake itself; its reads are in the Read Log.',
      // Explore as a Fabric app of its own (src/exportapp.js). The app reads the model from
      // OneLake at run time, and the tables of the one lakehouse it names: a OneLake file is
      // read where it is; a semantic model's local copy is written into its lakehouse by the
      // export, once approved. A model that names no lakehouse or several has no button.
      exportToFabric: semantic.lakehousesOf(m.bim).length === 1 && (fromOneLake || file.modelWorkspace)
        ? state => engine.exportExplore(fromOneLake
          ? { file: file.name, name: m.view, text: bim, state, workspace: lakehouse.workspace, path: file.path }
          : { file: file.name, name: m.view, text: bim, state, model: { workspace: file.modelWorkspace, name: m.view } })
        : undefined,
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

// Semantic views the host keeps (src/semviews.js), defined once the engine is up so SQL can
// name them; every query waits for this. One that no longer reads is skipped, and says so.
let viewsReady = Promise.resolve();
async function loadViews() {
  await engineReady;
  let list = [];
  try { list = await engine.semanticViews(); } catch (e) { console.warn('[views]', e.message); return; }
  for (const v of list) {
    if (!v.schema) continue;   // named before models were semanticmodel.ws.model
    try {
      if (v.error) throw new Error(v.error);
      await semantic.defineView(v.name, v.path, v.text, 'replace', null, v.schema);
    } catch (e) { console.warn(`[views] ${v.name}: ${e.message}`); }
  }
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

// A compiled SQL of a model, run through the engine's read-only path: it names its Direct Lake
// tables by their SQL names, and the host opens each as the SQL reaches it. Stoppable.
async function runModelSql(sql) {
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
    setBusy(false);
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
  const my = ++selSeq;
  $('activeTable').textContent = file.name;
  activeFile = file;
  activeIdent = null;            // no table behind this
  activeQuery = null;
  setActiveStats(null);
  activeTableRef = null; tableStage = 'none';
  activeDocEligible = false;
  clearResults(`(loading ${file.name}…)`);
  $('sqlEditor').value = `-- ${file.name} is an image — shown in the results pane`;
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
// A table: statistics, then rows, then a view — each only when asked for
// ---------------------------------------------------------------------------
async function selectTable(t) {
  closeModelView();
  const my = ++selSeq;
  // A click is also a verdict on whatever is still running: stop it now.
  engine.cancelLoad();
  $('activeTable').textContent = t.schema ? `${t.schema}.${t.table}` : t.table;
  activeFile = null;
  activeDocEligible = false;    // a table, whatever shape the preview comes back
  activeDocExt = '';
  activeIdent = null;           // no view exists yet — nothing is bound until asked for
  activeSqlName = null;
  activeQuery = null;            // the editor gets this table's preview, not the query
  activeTableRef = t;
  tableStage = 'none';
  // The previous table's rows must not sit on screen under the new table's name.
  clearResults(`(no rows read yet — open the Data tab)`);
  setActiveStats(null);
  $('sqlEditor').value = `-- reading ${$('activeTable').textContent} metadata…`;
  // Stoppable: the catalog may be waiting on Fabric to write a table's Iceberg metadata.
  setBusy(true, { stoppable: true });
  try {
    // Selecting a table reads its METADATA and nothing else — from the host's cache when
    // the table was ever opened before.
    const info = await engine.statTable(lakehouse, t);
    if (my !== selSeq) return;
    activeIdent = info.ident;
    activeSqlName = info.sqlName || info.ident;
    tableStage = info.stage === 'loaded' ? 'loaded' : 'stats';
    setActiveStats(info);
    showStats();                    // statistics are the landing view for a table
    $('sqlEditor').value = activeSqlName ? previewSql(activeSqlName, false) : '';
    setStatus(engine.describeLoad(info));
    // The Data tab's rows, started now: selecting a table is the strongest signal its
    // data is about to be looked at. Quiet, superseded by any later click, and its
    // failure is the Data tab's to report.
    if (info.stage !== 'loaded') engine.peekTable(lakehouse, t, { quiet: true }).catch(() => {});
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

// The Data tab's first click: the first rows, which the selection already started reading.
async function peekIntoView() {
  const my = selSeq;
  const t0 = Date.now();
  setBusy(true, { stoppable: true });
  try {
    const out = await engine.peekTable(lakehouse, activeTableRef);
    if (my !== selSeq) return;
    tableStage = 'peek';
    docAllowed = false;             // a peek is a table, whatever shape it comes back
    renderResults(out);             // this lands the pane in the Data view by itself
    reportOpened('rows', $('activeTable').textContent, Date.now() - t0);
    setStatus(`The first ${out.rows.length} row(s). Run a query to read the whole table.`);
  } catch (e) {
    if (my !== selSeq) return;
    reportTableError(e);
  } finally {
    if (my === selSeq) setBusy(false);
  }
}

// A real view, which is what SQL needs. Returns the info, or null if it could not be bound.
async function bindTable() {
  if (!activeTableRef) return null;
  if (tableStage === 'loaded') return activeInfo;
  const my = selSeq;
  setBusy(true, { stoppable: true });
  try {
    const info = await engine.loadTable(lakehouse, activeTableRef);
    if (my !== selSeq) return null;
    activeIdent = info.ident;
    tableStage = 'loaded';
    freshLoad = info;               // owed a report once the caller's query lands
    setActiveStats(info);           // richer now: real columns from DESCRIBE
    return info;
  } catch (e) {
    if (my !== selSeq) return null;
    reportTableError(e);
    return null;
  } finally {
    if (my === selSeq) setBusy(false);
  }
}

// Run SQL against the selected table, binding it first only if the SQL names it.
// `sql` replaces the editor contents when given.
async function runWithTable(sql) {
  if (sql != null) $('sqlEditor').value = sql;
  if (needsBind()) { if (!await bindTable()) return; }
  const ok = await runQuery({ doc: activeDocEligible, ext: activeDocExt });
  if (freshLoad) { reportLoad(freshLoad, ok); freshLoad = null; }
}

// `SELECT 42` with a table selected must not open the table.
function needsBind() {
  return activeTableRef && tableStage !== 'loaded' &&
         sqlNeedsTable($('sqlEditor').value, activeTableRef.table);
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
// A table gets the first hundred rows; a text file gets ALL of it — a LIMIT would cut the
// document silently. The engine's own row cap still applies and still says so.
const previewSql = (ident, whole) => `SELECT * FROM ${ident}` + (whole ? '' : ' LIMIT 100');

// Plan: where the SQL box's query spends its time, in place of the results — Explore's own
// view of it (explore/profile.js): the profile (EXPLAIN ANALYZE, so the query runs once to be
// measured) and DuckDB's plan tree. A semantic model's query is planned as the SQL it
// compiles to. Run puts the results back.
const planElapsed = t0 => `${((performance.now() - t0) / 1000).toFixed(1)} s`;
function planColors() {
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const [scan, join, aggregate, sort, win, filter] = PALETTE;
  return { plan: css('--faint'), scan, join, aggregate, sort, window: win, filter, other: css('--muted') };
}
async function showPlan() {
  const text = $('sqlEditor').value.trim();
  if (!text) { setStatus('Write a query to plan it.'); return; }
  const my = selSeq;
  try {
    await engineReady;
    await viewsReady;
    await openModels(text);
    const model = await semantic.statement(text);
    // The selected table, or a file opened from Files/, is a view only once it is bound.
    if (!model && needsBind()) { if (!await bindTable()) return; }
    if (my !== selSeq) return;
    const sql = model ? model.sql : text.replace(/;\s*$/, '');
    clearResults();
    const view = $('planView');
    view.replaceChildren(createPlanView({
      profile: async () => profileJson((await engine.runSql(profileSql(sql, { set: false }))).rows[0]?.explain_value),
      tree: async () => {
        const res = await engine.runSql(`EXPLAIN ${sql}`);
        const pre = document.createElement('pre');
        pre.className = 'sm-plan';
        pre.textContent = res.rows.map(r => r.explain_value ?? Object.values(r).join('  ')).join('\n');
        return pre;
      },
      colors: planColors,
      elapsed: planElapsed,
    }));
    view.hidden = false;
    // The plan is the query's, not one of the table's tabs: Stats | History | Data step aside.
    $('viewBar').hidden = true;
    $('resultsHint').hidden = true;
    setStatus('Query plan — Run ▶ for the results.');
  } catch (e) {
    if (my === selSeq) setStatus('Plan failed: ' + e.message, 'error');
  }
}

// `doc` says whether a document view may be offered for this result at all. Returns
// whether the query succeeded, so a caller with its own message can keep quiet.
async function runQuery({ doc = true, ext = '' } = {}) {
  const sql = $('sqlEditor').value;
  // A click in the tree outranks a query already on its way — the welcome page's, above
  // all, which a click that opens the panel races. Each await below can be where that
  // click lands, and a cancel sent before the statement reaches the host stops nothing,
  // so the result itself has to stand down rather than paint over the click's view.
  const my = selSeq;
  const stale = () => my !== selSeq;
  setBusy(true, { stoppable: true });
  docAllowed = doc;
  docSourceExt = ext;
  let t0 = performance.now();
  try {
    await engineReady;   // Ctrl+Enter is live before the engine is
    // A query of a semantic model runs as the SQL dax-sql compiles it to, once the tables
    // that SQL reads are open; every other query runs as written.
    await viewsReady;
    await openModels(sql);
    if (stale()) return false;
    const model = await semantic.statement(sql);
    if (stale()) return false;
    if (model) docAllowed = false;
    t0 = performance.now();
    const res = await engine.runSql(model ? model.sql : sql);
    if (stale()) return false;
    renderResults(res);
    lastResult = res;
    const ms = Math.round(performance.now() - t0);
    const shown = Math.min(res.rows.length, MAX_DOM_ROWS);
    // Two caps: MAX_DOM_ROWS only limits what is drawn; res.truncated means the engine
    // stopped materialising, so the CSV is short too.
    let msg = `${res.rows.length.toLocaleString('en')} row(s) in ${ms} ms`;
    if (res.rows.length > shown) msg += ` — showing first ${shown.toLocaleString('en')}`;
    if (res.truncated)
      msg += `. Stopped at ${res.limit.toLocaleString('en')} rows of ` +
             `${res.numRows.toLocaleString('en')} — add a LIMIT or narrow the query; ` +
             `the CSV is capped at the same point`;
    setStatus(msg, res.truncated ? 'warn' : 'ok');
    $('csvBtn').disabled = res.rows.length === 0;
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
    clearResults('(no result — the query failed)');
    setStatus('Query error: ' + e.message, 'error');
    console.error(e);
    return false;
  } finally {
    // The newer selection's load owns the busy state now.
    if (!stale()) setBusy(false);
  }
}

// Column types live in the header cells, under the names.
const NUMERIC_TYPE = /^(U?(TINY|SMALL|BIG|HUGE)INT|U?INTEGER|DOUBLE|FLOAT|DECIMAL)/;

// Empty the whole pane. Every path that ends without a result goes through here, so
// nothing on screen ever belongs to a query other than the current one.
function clearResults(hint = '') {
  docSeq++;              // an in-flight showDoc() must not paint over this
  viewMode = 'data';
  statsPrev = null;
  $('statsView').hidden = true;
  $('statsView').innerHTML = '';
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
  lastResult = null;
  $('csvBtn').disabled = true;
  setSaveLabel();
}

// The document a result holds, or null: read_text()'s one cell, or a text file's lines.
function docOf(res) {
  if (!docAllowed || !res) return null;
  return isDocResult(res) ? res.rows[0][res.fields[0]] : textLinesDoc(res);
}

// The grid's header: each column's name over its type, and the column it is sorted by marked.
function gridHead(res, sort) {
  const types = res.types || [];
  return '<thead><tr>' + res.fields.map((f, i) => {
    const t = types[i] || '';
    const by = sort && sort.col === i;
    return `<th class="${NUMERIC_TYPE.test(t) ? 'num' : ''}" title="${escapeHtml(f + ' ' + t)} — click to sort"` +
      (by ? ` aria-sort="${sort.desc ? 'descending' : 'ascending'}"` : '') + '>' +
      `<span class="cname">${escapeHtml(f)}${by ? (sort.desc ? ' ▼' : ' ▲') : ''}</span>` +
      `<span class="ctype">${escapeHtml(t)}</span></th>`;
  }).join('') + '</tr></thead>';
}

// A result's rows sorted by one column: numbers as numbers (a big integer arrives as text),
// everything else as text with its digits compared as numbers. Empty cells are last either way.
function sortedRows(rows, res, { col, desc }) {
  const f = res.fields[col];
  const numeric = NUMERIC_TYPE.test((res.types || [])[col] || '');
  const key = v => (typeof v === 'number' ? v : numeric && !Number.isNaN(Number(v)) ? Number(v) : cellText(v));
  const filled = [], empty = [];
  for (const r of rows) (r[f] == null || r[f] === '' ? empty : filled).push(r);
  filled.sort((a, b) => {
    const x = key(a[f]), y = key(b[f]);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y
      : String(x).localeCompare(String(y), undefined, { numeric: true });
    return desc ? -c : c;
  });
  return filled.concat(empty);
}

function renderResults(res) {
  const table = $('resultsTable');
  const hint = $('resultsHint');
  clearResults();
  if (!res.fields.length) {
    table.hidden = true; hint.hidden = false; hint.textContent = '(no columns)';
    return;
  }
  hint.hidden = true; table.hidden = false;
  if (!res.rows.length) {
    table.innerHTML = gridHead(res, null) +
      `<tbody><tr><td colspan="${res.fields.length}">(no rows)</td></tr></tbody>`;
    return;
  }
  // A click on a header sorts by that column: ascending, then descending, then back to the
  // order the query gave. Every row the result holds is sorted, not only the ones drawn, and
  // the CSV is saved in the order on screen.
  const original = res.rows.slice();
  let sort = null;   // { col, desc }
  const draw = () => {
    const rows = res.rows.slice(0, MAX_DOM_ROWS);
    table.innerHTML = gridHead(res, sort) + '<tbody>' + rows.map(r => '<tr>' + res.fields.map(f => {
      const v = r[f];
      const num = typeof v === 'number';
      return `<td class="${num ? 'num' : ''}">${escapeHtml(cellText(v))}</td>`;
    }).join('') + '</tr>').join('') + '</tbody>';
  };
  draw();
  table.onclick = e => {
    const th = e.target.closest('thead th');
    if (!th) return;
    const col = th.cellIndex;
    sort = !sort || sort.col !== col ? { col, desc: false } : !sort.desc ? { col, desc: true } : null;
    // In place, so the CSV (lastResult) follows; one row at a time, as 200k rows will not spread.
    const next = sort ? sortedRows(original, res, sort) : original;
    for (let i = 0; i < next.length; i++) res.rows[i] = next[i];
    draw();
  };

  // The grid stays the source of truth; a document result additionally gets Pretty.
  const doc = docOf(res);
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
  $('pivotBtn').disabled = !activeInfo || !activeSqlName;
  $('pivotBtn').closest('section').classList.toggle('tableOpen', !!activeInfo);
  if (!activeInfo) dropTablePivot();   // a new selection: the pivot was the last table's
  if (!activeInfo && viewMode !== 'data') showData();
  else if (activeInfo && viewMode !== 'data') renderMeta();
}

function setViewTabs() {
  $('viewData').classList.toggle('active', viewMode === 'data');
  $('viewStats').classList.toggle('active', viewMode === 'stats');
  $('viewHistory').classList.toggle('active', viewMode === 'history');
}

const isDelta = info => !!(info && info.stats && info.stats.format === 'delta');

// Stats and History cover the result surfaces rather than replacing them: whatever was
// showing is put back exactly on return.
function showMeta(mode) {
  if (!activeInfo || viewMode === mode) return;
  if (viewMode === 'data') {
    statsPrev = ['resultsHint', 'docView', 'resultsTable', 'docBar']
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
  $('statsView').innerHTML = viewMode === 'history'
    ? historyHtml(activeInfo, mine(deltaHistory))
    : statsCardHtml(activeInfo, mine(deltaState));
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
  if (tableStage === 'stats' && activeTableRef) { peekIntoView(); return; }
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
// of the editor and results until closed. It is made from the metadata already on screen, so
// opening it reads nothing: the first read is the first field put on a shelf. Kept while the
// table stays selected; closing it puts the SQL box and the table's tabs back as they were.
function setPivotOpen(open) {
  $('pivotView').hidden = !open;
  $('pivotView').closest('section').classList.toggle('pivotOpen', open);
}
const closePivot = () => setPivotOpen(false);
// Edit SQL: the pivot's query in the SQL box, as SQL over the table, to be taken further by
// hand, as Looker's Open in SQL Runner does. Asked for, never on close; the pivot is kept.
function editPivotSql(sql) {
  if (!tablePivot) return;
  $('sqlEditor').value = sql;
  activeQuery = null;
  closePivot();
  $('sqlEditor').focus();
  setStatus('The pivot\'s query is in the SQL box, over the table. Run it, or change it first.');
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
      echarts: loadEcharts,
      setStatus,
      saveText: (name, text) => engine.saveText(name, text),
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
    setStatus(`Pivot: ${e.message}`, 'error');
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

  const note = info.stage === 'loaded'
    ? 'From the Iceberg snapshot metadata — nothing was scanned to show this.'
    : 'From the Iceberg snapshot metadata — no data has been read yet. ' +
      'Open Data for the first rows, or Run the SQL above to query the table.';
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
       ['Total rows', h => n0(h.totalRows), 'num'], ['Engine', h => h.engine || '—']];
  // A column nobody filled (no commit carried a user) is noise, not information.
  const shown = cols.filter(([, f], i) => i < 3 || list.some(h => !['—', ''].includes(String(f(h)))));
  const table = '<table class="history"><tr>' + shown.map(([h]) => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>' +
    list.map(h => '<tr>' + shown.map(([, f, cls]) =>
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
  btn.textContent = file ? 'Save file' : 'Save CSV';
  btn.title = file ? `Save ${activeFile.name} exactly as it is stored` : '';
}

// Both go through VS Code's own save dialog (the host writes the file): the bytes of a
// OneLake file never cross into the page to be saved, and a dismissed dialog is no error.
async function saveActive() {
  const btn = $('csvBtn');
  btn.disabled = true;
  try {
    const saved = saveIsFile()
      ? await engine.saveOneLakeFile(lakehouse, activeFile)
      : await saveCsv();
    if (saved) setStatus(`Saved ${saved}.`, 'ok');
  } catch (e) {
    setStatus('Save failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Saved queries: the tree's Queries, kept by the host as .sql files. A query names its tables
// Kind.workspace.item.schema.table, so it runs as it is, whatever was selected before.
// ---------------------------------------------------------------------------
function openQuery(name, sql) {
  closeModelView();
  ++selSeq;                     // whatever was loading for the last click stands down
  engine.cancelLoad();
  activeTableRef = null;
  activeFile = null;
  activeIdent = null;
  activeSqlName = null;
  activeDocEligible = false;
  activeDocExt = '';
  tableStage = 'none';
  activeQuery = name || null;
  $('activeTable').textContent = name ? `Query: ${name}` : 'Query';
  $('sqlEditor').value = sql;
  $('sqlEditor').focus();
  setBusy(false);
  setStatus(`${name || 'The query'} — Run ▶ (Ctrl+Enter) to run it.`);
}

// Save Query, one click: over the query that is open, else as a new "Query N" — the tree's
// Rename names it.
// With a semantic model open, the SQL box is hidden: what is saved is the model's own SQL, its
// Show SQL box (the pivot's query, or one typed there), which the SQL box runs as it is — a
// semantic view can be named from any SQL. Each one is a new query.
const modelSqlBox = () => modelView && $('modelView').querySelector('textarea[aria-label="SQL over the semantic model"]');
async function saveQuery() {
  const btn = $('saveQueryBtn');
  const fromModel = !!modelView;
  const sql = fromModel ? (modelSqlBox()?.value ?? '').trim() : $('sqlEditor').value;
  if (fromModel && !sql) { setStatus("Open Show SQL to save the model's query."); return; }
  btn.disabled = true;
  try {
    const saved = await engine.saveQuery(fromModel ? null : activeQuery, sql);
    if (!saved) return;
    if (fromModel) { setStatus(`Saved the model's query as ${saved.name} under Queries — rename it there.`, 'ok'); return; }
    activeQuery = saved.name;
    if (!activeTableRef && !activeFile) $('activeTable').textContent = `Query: ${saved.name}`;
    setStatus(`Saved as ${saved.name} under Queries — rename it there.`, 'ok');
  } catch (e) {
    setStatus('Save failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function saveCsv() {
  if (!lastResult || !lastResult.rows.length) return null;
  const { fields, rows } = lastResult;
  const q = s => {
    const t = cellText(s);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [fields.map(q).join(',')];
  for (const r of rows) lines.push(fields.map(f => q(r[f])).join(','));
  return engine.saveText(($('activeTable').textContent || 'query').replace(/[^\w.-]+/g, '_') + '.csv',
                         lines.join('\r\n'));
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
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// `stoppable`: table loads, file loads and queries — everything cancelLoad() reaches.
function setBusy(b, { stoppable = false } = {}) {
  const stop = $('stopBtn');
  stop.hidden = !(b && stoppable);
  if (!stop.hidden) stop.disabled = false;
  // Run and Plan need only the engine.
  $('runBtn').disabled = !engineUp || b;
  $('planBtn').disabled = !engineUp || b;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
showVersion();
wireUi();
engine = createEngine({ onStatus: setStatus, onBoot: reportBoot });
engineReady = engine.init();
semantic.setTableNamer(list => engine.nameTables(list));
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
        await openModelView({ name: String(m.name || 'model.bim'), path: String(m.path || ''),
                              modelWorkspace: m.modelWorkspace ? String(m.modelWorkspace) : null,
                              modelName: m.modelName ? String(m.modelName) : null }, String(m.text || ''));
      } finally {
        reportOpened('file', String(m.name || 'model.bim'), Date.now() - t0);
      }
    }
    // A saved query from the tree's Queries: into the SQL box, ready to run.
    else if (m.type === 'open-query') {
      openQuery(String(m.name || ''), String(m.sql ?? ''));
    }
    // A saved query renamed (or deleted, `to` null) in the tree: the one open here follows.
    else if (m.type === 'query-renamed') {
      if (activeQuery && activeQuery.toLowerCase() === String(m.from || '').toLowerCase()) {
        activeQuery = m.to || null;
        if (!activeTableRef && !activeFile) $('activeTable').textContent = activeQuery ? `Query: ${activeQuery}` : 'Query';
      }
    }
    else if (m.type === 'reset') { await engineReady; await leaveLakehouse(); lakehouse = null; }
    else if (m.type === 'reads') showReads(m);
    // Why the catalog is taking long — conversion pending, catalog busy.
    else if (m.type === 'status' && m.message) setStatus(m.message);
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
