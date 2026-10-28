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
// A .bim's model view. Explore's chart library is imported when Explore first opens.
import { mountAnalyze } from './analyze/view.js';
import { tmslOf } from './analyze/model.js';
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
let activeFile = null;       // the file behind it, when a file is what was opened
let lastResult = null;       // { fields, rows } for CSV export
let docMode = 'pretty';      // Pretty | Raw for a document result; a session preference
let docSeq = 0;              // a slow renderer import must not paint over a newer result
// Whether THIS result's source could be a document at all. Shape alone is not enough:
// a one-column, one-row parquet is still a table. Set per query by runQuery.
let docAllowed = true;
let docSourceExt = '';           // ...and which file it came from, when it came from one
let activeDocEligible = false;   // the same two answers for the loaded table/file, for Preview
let activeDocExt = '';
let activeInfo = null;       // the selected TABLE's info object — what the Stats tab renders
let viewMode = 'data';       // Data | Stats for a selected table
let statsPrev = null;        // hidden-flags of the data surfaces while Stats covers them
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
  // Preview means "show me this thing", so it always pays for the table if it has to.
  $('previewBtn').onclick = () => {
    const ident = activeIdent || (activeTableRef && identOf(activeTableRef));
    if (!ident) return;
    runWithTable(previewSql(ident, activeDocEligible));
  };
  $('csvBtn').onclick = saveActive;
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
  const entry = { name: basename(m.path), path: m.path, isDir: false, bytes: m.bytes || 0 };
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
      $('previewBtn').disabled = false;
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
// (analyze/view.js) in place of the editor and the results — Model, SQL, Explore — and is
// registered (semantic.js) so SQL anywhere, the main editor's included, can name it.
let modelView = null;
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
    const m = await semantic.registerModel(file.name, bim);
    // Kept by the host as a semantic view too, so it is there after a restart and the
    // command line can name it. Best effort: the view on screen does not depend on it.
    engine.semanticCreate(m.name, fromOneLake ? abfssUrl(lakehouse.workspace, file.path) : file.path)
      .catch(e => console.warn(`[views] ${m.name} not kept: ${e.message}`));
    if (my !== selSeq) return;
    $('modelView').closest('section').classList.add('modelOpen');
    $('modelView').hidden = false;
    modelView = mountAnalyze($('modelView'), {
      name: m.name, file: m.file, tmsl: tmslOf(m.bim), exploreCompiler: m.exploreCompiler, sample: m.sample,
      rewrite: semantic.rewrite,
      run: runModelSql,
      setStatus,
      saveText: (name, text) => engine.saveText(name, text),
      loadState: viewState.get,
      saveState: viewState.set,
      // Explore as a Fabric app of its own (src/exportapp.js): its tables come from the one
      // lakehouse the model names, so a model that names none, or several, has no button.
      exportToFabric: semantic.lakehousesOf(m.bim).length === 1
        ? state => engine.exportExplore({ file: file.name, name: m.name, text: bim, state })
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
    try {
      if (v.error) throw new Error(v.error);
      await semantic.defineView(v.name, v.path, v.text, 'replace');
    } catch (e) { console.warn(`[views] ${v.name}: ${e.message}`); }
  }
}

// CREATE or DROP SEMANTIC VIEW, carried out: the host reads the .bim and keeps the pointer,
// and the page defines (or forgets) the view. Returns what the status bar says.
async function semanticDdl({ create, drop }) {
  if (drop) {
    await engine.semanticDrop(drop.name);
    const had = semantic.hasView(drop.name);
    semantic.dropView(drop.name);
    return had ? `Semantic view ${drop.name} dropped.` : `No semantic view ${drop.name}.`;
  }
  if (create.mode === 'if_not_exists' && semantic.hasView(create.name))
    return `Semantic view ${create.name} already exists.`;
  const v = await engine.semanticCreate(create.name, create.path, lakehouse);
  const m = await semantic.defineView(v.name, v.path, v.text, create.mode === 'create' ? 'create' : 'replace');
  return `Semantic view ${m.name} created from ${v.path}` +
         (m.directLake ? ` — ${m.directLake} Direct Lake table(s), read from OneLake as a query needs them` : '') + '.';
}

// A compiled SQL of a model, run: the Direct Lake tables it reads opened first (each in its
// own schema, semantic.js), then the SQL through the engine's read-only path. Stoppable.
async function runModelSql(sql) {
  setBusy(true, { stoppable: true });
  try {
    await engineReady;
    for (const x of semantic.tablesFor(sql))
      await engine.loadTable(x.lh, x.t, { viewSchema: x.viewSchema });
    return await engine.runSql(sql);
  } finally {
    setBusy(false);
  }
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
  activeIdent = null;            // no table behind this: Preview/Run stay disabled
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
    tableStage = info.stage === 'loaded' ? 'loaded' : 'stats';
    setActiveStats(info);
    showStats();                    // statistics are the landing view for a table
    $('sqlEditor').value = previewSql(identOf(t), false);
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

// The identifier a table's view WILL have, derivable without opening anything.
const identOf = t => t.schema ? `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`
                              : quoteIdent(t.table);

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
// `sql` replaces the editor contents when given (the Preview button).
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
    const model = await semantic.statement(sql);
    if (stale()) return false;
    // CREATE / DROP SEMANTIC VIEW: dax-sql has checked it; the host keeps the view.
    if (model && (model.create || model.drop)) {
      clearResults();
      setStatus(await semanticDdl(model), 'ok');
      return true;
    }
    if (model) docAllowed = false;
    for (const x of model ? model.tables : [])
      await engine.loadTable(x.lh, x.t, { viewSchema: x.viewSchema });
    if (stale()) return false;
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

function renderResults(res) {
  const table = $('resultsTable');
  const hint = $('resultsHint');
  clearResults();
  if (!res.fields.length) {
    table.hidden = true; hint.hidden = false; hint.textContent = '(no columns)';
    return;
  }
  hint.hidden = true; table.hidden = false;
  const types = res.types || [];
  const head = '<thead><tr>' + res.fields.map((f, i) => {
    const t = types[i] || '';
    return `<th class="${NUMERIC_TYPE.test(t) ? 'num' : ''}" title="${escapeHtml(f + ' ' + t)}">` +
      `<span class="cname">${escapeHtml(f)}</span>` +
      `<span class="ctype">${escapeHtml(t)}</span></th>`;
  }).join('') + '</tr></thead>';

  if (!res.rows.length) {
    table.innerHTML = head +
      `<tbody><tr><td colspan="${res.fields.length}">(no rows)</td></tr></tbody>`;
    return;
  }
  const rows = res.rows.slice(0, MAX_DOM_ROWS);
  const body = '<tbody>' + rows.map(r => '<tr>' + res.fields.map(f => {
    const v = r[f];
    const num = typeof v === 'number';
    return `<td class="${num ? 'num' : ''}">${escapeHtml(cellText(v))}</td>`;
  }).join('') + '</tr>').join('') + '</tbody>';
  table.innerHTML = head + body;

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
// Stats view: Data | Stats for a selected table. Everything on the card is metadata
// already fetched — rendering it is synchronous and free.
// ---------------------------------------------------------------------------
function setActiveStats(info) {
  activeInfo = (info && info.stats) ? info : null;
  $('viewBar').hidden = !activeInfo;
  if (!activeInfo && viewMode === 'stats') showData();
}

function setViewTabs() {
  $('viewData').classList.toggle('active', viewMode === 'data');
  $('viewStats').classList.toggle('active', viewMode === 'stats');
}

// Stats covers the result surfaces rather than replacing them: whatever was showing is
// put back exactly on return.
function showStats() {
  if (!activeInfo || viewMode === 'stats') return;
  viewMode = 'stats';
  statsPrev = ['resultsHint', 'docView', 'resultsTable', 'docBar']
    .map(id => [id, $(id).hidden]);
  for (const [id] of statsPrev) $(id).hidden = true;
  $('statsView').innerHTML = statsCardHtml(activeInfo);
  $('statsView').hidden = false;
  setViewTabs();
}

// The Data tab is where the user first asks to see rows.
function onDataTab() {
  if (viewMode !== 'stats') return;
  if (tableStage === 'stats' && activeTableRef) { peekIntoView(); return; }
  showData();
}

function showData() {
  if (viewMode !== 'stats') return;
  viewMode = 'data';
  $('statsView').hidden = true;
  if (statsPrev) for (const [id, h] of statsPrev) $(id).hidden = h;
  statsPrev = null;
  setViewTabs();
}

// Only what the Iceberg snapshot metadata said — a fact it doesn't carry is an em dash.
function statsCardHtml(info) {
  const s = info.stats || {};
  const n = v => v == null ? '—' : Number(v).toLocaleString('en');
  const deletes = info.posDeletes || info.eqDeletes || s.totalDeleteFiles;
  const rows = [];
  rows.push(['Rows', n(info.totalRecords) +
    (deletes ? ' (physical — before delete files are applied)' : '')]);
  rows.push(['Data files', n(info.fileCount)]);
  if (deletes) rows.push(['Delete files', n(s.totalDeleteFiles)]);
  rows.push(['Total size', s.totalFilesSize == null ? '—' : engine.fmtBytes(s.totalFilesSize)]);
  if (s.totalFilesSize && info.fileCount)
    rows.push(['Avg file size', engine.fmtBytes(s.totalFilesSize / info.fileCount)]);
  rows.push(['Columns', n((info.columns || []).length)]);
  rows.push(['Partitioning', (s.partitionColumns || []).length ? s.partitionColumns.join(', ') : 'none']);
  rows.push(['Compression', s.codec || '—']);
  rows.push(['Last write', s.snapshotTs == null ? '—' :
    new Date(s.snapshotTs).toLocaleString('en') + (s.operation ? ` (${s.operation})` : '')]);
  rows.push(['Snapshots', n(s.snapshotCount || null)]);
  if (s.formatVersion != null) rows.push(['Format', `Iceberg v${s.formatVersion}`]);
  if (s.vorderProp != null) rows.push(['V-Order', s.vorderProp ? 'enabled' : 'disabled']);

  const cols = info.columns || [];
  const colList = cols.length
    ? '<h3>Columns</h3><table>' + cols.map(c =>
        `<tr><th>${escapeHtml(c.name)}</th><td>${escapeHtml(c.type || '')}</td></tr>`).join('') +
      '</table>'
    : '';
  const note = info.stage === 'loaded'
    ? 'From the Iceberg snapshot metadata — nothing was scanned to show this.'
    : 'From the Iceberg snapshot metadata — no data has been read yet. ' +
      'Open Data for the first rows, or Preview to query the table.';
  return '<table>' + rows.map(([k, v]) =>
    `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`).join('') +
    '</table>' + colList + `<p class="statsNote">${escapeHtml(note)}</p>`;
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
  // Run needs only the engine; Preview needs something selected.
  $('runBtn').disabled = !engineUp || b;
  $('previewBtn').disabled = !(activeIdent || activeTableRef) || b;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
showVersion();
wireUi();
engine = createEngine({ onStatus: setStatus, onBoot: reportBoot });
engineReady = engine.init();
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
      await openModelView({ name: String(m.name || 'model.bim'), path: String(m.path || '') }, String(m.text || ''));
      reportOpened('file', String(m.name || 'model.bim'), Date.now() - t0);
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
