// =============================================================================
// explore/view.js — a semantic model's Explore: Model, Visual and Report
// =============================================================================
//   Model     the star of its tables and relationships, and what the model says of the
//             table picked (model.js)
//   Visual    (the 'pivot' page) the model's fields dragged onto shelves, drawn as a pivot or a chart
//             (explore.js, ECharts). Show SQL swaps the pivot for its SQL in a box the user
//             edits (a SELECT … FROM <model> asks the model; any other SQL runs as written);
//             Show plan puts the query's profile and plan in place of the results
//             (profile.js). Download CSV writes the pivot's rows, or the box's. Add to report
//             (a host that saves the Report) puts the visual on the Report as a tile.
//   Report    tiles the host reads (ctx.report: Export to Fabric's report.json, or the file the
//             host keeps before an export; none at first), each a SELECT over the model or
//             a visual (a slicer among them), drawn by report.js; a ✕ takes one out, its grip
//             moves it, ⧉ copies it, a double-click renames it, and ✎ opens a visual's shelves in
//             Visual under a strip that updates the tile (a host that saves the Report)
// Model's Diagram | YAML (or BIM) shows the model drawn, or its file as written (pretty.js).
// The bar: the page tabs, then each page's own: Model's Keep offline, then Diagram | YAML, Create
// Semantic Model (a model file only) and Open in Excel at the right; Visual's Show SQL, Download CSV and Add to report; the Report's Export to
// Fabric, which publishes the Report as a Fabric app.
// The same file in the panel and in Export to Fabric's app: the host says how a model's SQL is compiled
// and run, and where ECharts comes from (`ctx`); nothing here knows the engine.
// =============================================================================

import { escapeHtml, toCsv } from '../paths.js';
import { renderModel } from './model.js';
import { el } from './dom.js';
import { createExplorer, pivotTitle } from './explore.js';
import { compileModelSql } from './query.js';
import { createPlanView, profileSql, elapsed, profileColors } from './profile.js';
import { PALETTE, registerChartTheme } from './theme.js';
import { prettyModelText, extensionVendors, foreignDialects } from './pretty.js';
import { drawReport } from './report.js';

const PAGES = [['model', 'Model'], ['pivot', 'Visual'], ['report', 'Report']];
const PREVIEW_ROWS = 500;
// The SQL box's rows in all, a column beside the query's own (runSql), not shown.
const TOTAL_NAME = '__onelake_rows_in_all';
const TOTAL_COL = `"${TOTAL_NAME}"`;
const REPORT_POLL_MS = 2000;

// `ctx`:
//   name             the model's name: what SQL calls it (FROM <name>)
//   text, ext        (optional) the model's file and its extension: Model's Diagram | YAML switch
//   tmsl             the model, as model.js's tmslOf reads it
//   compiler         dax-sql's compiler over the model, with the host's tableSource and
//                    query.js's EXPLORE_CASTS
//   run(sql)         a compiled SQL's result: { fields, rows, numRows, truncated?, limit? }
//   echarts()        ECharts (a promise)
//   saveText(name, text)  a CSV saved: answers where (or null: dismissed)
//   loadState(key), saveState(key, s)  the shelves, between visits
//   setStatus(text, kind)  (optional) the host's status line
//   profileSet       whether the profile's SQL sets its own metrics (profile.js): false for an
//                    engine that set them and locked its configuration (the extension's)
//   htmlPlan         Show plan's tree as DuckDB's HTML page in a frame (the Fabric app), else
//                    its text plan (the panel: its CSP runs no inline script)
//   exportToFabric(state)  (optional) the Report's Export to Fabric button: the Report published as
//                    a Fabric app (src/exportapp.js; `state`, the shelves, or null), on what the model
//                    is, so nothing is asked here; answers what to say when it is done
//   createSemanticModel()  (optional) a model file's Create Semantic Model button, on the Model page:
//                    the tree's own (src/exportflow.js), its dialog the host's; answers what to say
//   openInExcel()    (optional) the Open in Excel button: this model in a new workbook, as a live
//                    PivotTable (src/xmla); answers what to say when it is open
//   keepOffline      (optional) { state(), set(on) }: the Keep offline switch beside the tabs, every
//                    table of this model on this machine (src/modeldata.js); both answer what it shows:
//                    { on, say, tone, meter, tip, busy }
//   editSql(sql)     (optional) the Edit SQL button: the shelves' query, all its rows, handed
//                    to the host's own SQL editor, which runs it and saves its CSV, so Show SQL
//                    and Download CSV are left out
//   plainSql         (optional) { from, measure(name) }: editSql's query as SQL over one table
//                    (explore.js's modelSql), else SQL over the model
//   close()          (optional) a Close button, after Edit SQL
//   report           (optional) the Report page's tiles: { load(), stamp()?, save()? }. load answers
//                    { spec, stamp } (report.js's spec); stamp(), asked while the page is on
//                    screen, answers a value that changes when the tiles do; save(spec, stamp)
//                    writes the tiles, refused when they changed since `stamp` (Add to report and
//                    the tiles' ✕: none, a Report that only reads). No report: no page
//   pages            (optional) the pages shown, of 'model', 'pivot', 'report' (default: all
//                    there are), in that order. One page: no page tabs.
//   openOn           (optional) the page it opens on (default: the first shown)
//   stateKey         (optional) where its shelves are kept (default: explore.<name>)
// Returns { destroy }.

// The Keep offline switch: what it shows is the host's to say, and it asks often only while
// something is coming down. A refusal stays on the line until the switch is next touched.
const OFFLINE_BUSY_MS = 2000, OFFLINE_QUIET_MS = 30_000;
function offlineSwitch({ state, set }) {
  const id = `keep-offline-${Math.random().toString(36).slice(2, 8)}`;
  const toggle = el('button', { type: 'button', class: 'keep-switch', role: 'switch', id, 'aria-checked': 'false', 'aria-label': 'Keep offline' });
  const label = el('label', { for: id }, 'Keep offline');
  const fill = el('i', {});
  const meter = el('span', { class: 'keep-meter', 'aria-hidden': 'true', hidden: true }, fill);
  const say = el('span', { class: 'keep-say' });
  const root = el('div', { class: 'keep-offline' }, toggle, label, meter, say);
  let timer = null, gone = false, refusal = null, setting = false, asking = 0;
  const OFF_TIP = 'Keep every table of this model on this machine, so it answers from disk and with no connection';

  function draw(s) {
    toggle.setAttribute('aria-checked', String(!!s.on));
    say.textContent = s.say || '';
    say.className = `keep-say${s.tone ? ` ${s.tone}` : ''}`;
    meter.hidden = s.meter == null;
    if (s.meter != null) fill.style.width = `${s.meter}%`;
    const tip = s.tip || (s.on ? '' : OFF_TIP);
    toggle.title = tip;
    label.title = tip;
    say.title = tip;
  }
  function again(busy) {
    clearTimeout(timer);
    if (!gone) timer = setTimeout(look, busy ? OFFLINE_BUSY_MS : OFFLINE_QUIET_MS);
  }
  async function look() {
    if (gone || setting) return;
    const mine = ++asking;
    let s = null;
    try { s = await state(); } catch (_) { /* the next look can say */ }
    if (gone || setting || mine !== asking) return;
    if (s) draw(refusal && !s.on ? refusal : s);
    again(!!(s && s.busy));
  }
  toggle.addEventListener('click', async () => {
    const on = toggle.getAttribute('aria-checked') !== 'true';
    setting = true;
    refusal = null;
    clearTimeout(timer);
    toggle.disabled = true;
    draw({ on, say: on ? 'Checking its tables…' : '', tone: '' });
    let s = null;
    try {
      s = await set(on);
      if (s.refused) refusal = s;
    } catch (e) {
      s = { on: !on, say: e.message, tone: 'bad', busy: false };
      refusal = s.on ? null : s;
    }
    setting = false;
    toggle.disabled = false;
    if (gone) return;
    draw(s);
    again(!!s.busy);
  });
  draw({ on: false });
  look();
  return { root, destroy() { gone = true; clearTimeout(timer); } };
}

export function mountExplore(root, ctx) {
  const setStatus = ctx.setStatus || (() => {});
  const btn = (text, onclick, primary) => el('button', { type: 'button', class: `btn-explore${primary ? ' primary' : ''}`, onclick }, text);

  // --- The frame: the subtabs and each page's actions, then one element per page ---
  const pages = PAGES.filter(([k]) => (k !== 'report' || ctx.report) && (!ctx.pages || ctx.pages.includes(k)));
  const tabs = pages.map(([k, t], i) => el('button', { type: 'button', class: `subtab${i ? '' : ' active'}`, role: 'tab',
    'data-apage': k, 'aria-selected': String(!i), tabindex: i ? '-1' : '0' }, t));
  const sqlToggle = btn('Show SQL', () => (sqlMode ? closeSql() : openSql()));
  const csvBtn = btn('Download CSV', download, true);
  const exportBtn = ctx.exportToFabric ? btn('Export to Fabric', () => exportApp()) : null;
  if (exportBtn) exportBtn.title = 'Publish this Report, on this model, as a Fabric app (a local copy is written too)';
  // What the host does and says how it went, with the button waiting meanwhile.
  const hostBtn = (label, doing, fn, title) => {
    const b = btn(label, async () => {
      b.disabled = true;
      b.textContent = doing;
      try {
        const said = await fn();
        if (said) setStatus(said, 'ok');
      } catch (e) {
        setStatus(`${label}: ${e.message}`, 'error');
      } finally {
        b.disabled = false;
        b.textContent = label;
      }
    });
    b.title = title;
    return b;
  };
  const createBtn = ctx.createSemanticModel
    ? hostBtn('Create Semantic Model', 'Creating…', ctx.createSemanticModel, 'A Power BI semantic model of this file, in its workspace') : null;
  const excelBtn = ctx.openInExcel
    ? hostBtn('Open in Excel', 'Opening…', ctx.openInExcel, 'This model in a new Excel workbook, as a live PivotTable') : null;
  const keepOffline = ctx.keepOffline ? offlineSwitch(ctx.keepOffline) : null;
  const editBtn = ctx.editSql ? btn('Edit SQL', () => {
    const sql = explorer?.query({ cap: 0, plain: ctx.plainSql ?? null })?.sql;
    if (sql) ctx.editSql(sql); else setStatus('Put a field on the shelves first', 'error');
  }, true) : null;
  if (editBtn) editBtn.title = 'This query in the SQL box, to take further by hand (the pivot is kept)';
  const closeBtn = ctx.close ? btn('Close', ctx.close) : null;
  const addBtn = ctx.report?.save ? hostBtn('Add to report', 'Adding…', () => addToReport(), 'This visual, as it is, as a tile of the Report') : null;
  // Each page's buttons, at the right of the bar: Visual's, the Report's, the Model's.
  const actions = el('div', { class: 'explore-actions', hidden: true },
    ...(editBtn ? [editBtn, closeBtn] : [sqlToggle, csvBtn, addBtn]));
  const reportActions = exportBtn ? el('div', { class: 'explore-actions', hidden: true }, exportBtn) : null;
  const reportPage = el('div', { class: 'report-page', hidden: true });
  const modelPage = el('div', { class: 'model-page' });
  const pivotPage = el('div', { class: 'explore-page', hidden: true });
  // Over Visual while a Report tile is edited there (editTile): its title, Update tile and Cancel.
  const titleBox = el('input', { type: 'text', class: 'explore-editing-title', 'aria-label': 'Tile title' });
  titleBox.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); updateTile(); } });
  const editStrip = el('div', { class: 'explore-editing', hidden: true },
    el('span', { class: 'explore-editing-say' }, 'Editing a Report tile'),
    el('label', {}, 'Title', titleBox),
    btn('Update tile', () => updateTile(), true), btn('Cancel', () => endEdit(false)));

  // Show SQL: the pivot's SQL in a box the user edits, in place of the whole pivot.
  const ta = el('textarea', { spellcheck: 'false', wrap: 'off', 'aria-label': 'SQL over the semantic model' });
  const info = el('div', { class: 'explore-info' });
  const out = el('table', { class: 'explore-table' });
  const outWrap = el('div', { class: 'explore-table-wrap' }, out);
  const planView = el('div', { class: 'explore-plan', hidden: true });
  const runBtn = btn('Run', runSql, true), planBtn = btn('Show plan', showPlan);
  const sqlPage = el('div', { class: 'explore-sql-page', hidden: true },
    el('div', { class: 'explore-controls' }, runBtn, planBtn),
    el('div', { class: 'explore-sql' },
      el('div', { class: 'explore-sql-head' },
        el('label', {}, 'SQL ', el('span', {}, `— a SELECT … FROM ${ctx.name} asks the semantic model (its columns, and its measures as AGG("name")); any other SQL runs as written. Ctrl+Enter runs.`)),
        btn('Reset', fillSql)),
      ta),
    info, outWrap, planView);

  // Model: the model drawn, or its file as written, by a switch named for the file's format.
  const viewTab = (label, asText) => el('button', { type: 'button', class: 'subtab', role: 'tab', onclick: () => showText(asText) }, label);
  const diagramTab = viewTab('Diagram', false), fileTab = viewTab(/^bim$/i.test(ctx.ext || '') ? 'BIM' : 'YAML', true);
  const textPre = el('pre', { class: 'text-file', hidden: true });
  // Over the file, when it has custom_extensions or a dialect other than Ossie SQL: what its amber
  // lines are (pretty.js tk-ext).
  const ossie = ctx.text != null && !/^bim$/i.test(ctx.ext || '');
  const vendors = ossie ? extensionVendors(ctx.text) : [];
  const dialects = ossie ? foreignDialects(ctx.text) : [];
  const extName = `${vendors.length && vendors.every(v => v.toUpperCase() === 'POWER_BI') ? 'Power BI' : 'vendor'} extension`;
  const textNote = el('p', { class: 'text-file-note', hidden: true }, el('span', { class: 'swatch' }),
    !dialects.length ? `Amber: ${extName}, what Ossie has no field for`
      : !vendors.length ? `Amber: expressions in ${dialects.join(', ')}, not Ossie SQL`
      : `Amber: not plain Ossie SQL — the ${extName}, and expressions in ${dialects.join(', ')}`);
  // At the right of the bar, before Create Semantic Model and Open in Excel. On the Model page only.
  const modelSwitch = ctx.text == null ? null
    : el('div', { class: 'subtabs model-switch', role: 'tablist', 'aria-label': 'How the model is shown' }, diagramTab, fileTab);
  const modelActions = modelSwitch || createBtn || excelBtn
    ? el('div', { class: 'explore-actions', hidden: true }, modelSwitch, createBtn, excelBtn) : null;
  const modelArea = el('div', { class: 'model-area' }, modelPage, textNote, textPre);

  root.replaceChildren(
    el('div', { class: 'subtab-bar' },
      el('div', { class: 'subtabs', role: 'tablist', 'aria-label': 'Semantic model pages', hidden: pages.length < 2 }, tabs),
      keepOffline?.root,
      modelActions,
      actions,
      reportActions),
    reportPage, modelArea, editStrip, pivotPage, sqlPage);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSql(); } });

  for (const b of tabs) {
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus(); next.click();
    });
    b.addEventListener('click', () => show(b.dataset.apage));
  }
  let page = ctx.openOn && pages.some(([k]) => k === ctx.openOn) ? ctx.openOn : pages[0][0];
  function show(p) {
    page = p;
    for (const b of tabs) {
      const on = b.dataset.apage === p;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (sqlMode && p !== 'pivot') closeSql();
    reportPage.hidden = p !== 'report';
    if (ctx.report) {
      if (p === 'report') {
        for (const go of reportWaiters.splice(0)) go();
        if (!reportSeq || reportChanged) drawReportPage();
      } else if (reportRuns.size && ctx.cancel) {
        // The Report left with a tile running: stopped, so what is asked next has the engine. The
        // tile runs again when the Report is back.
        reportLeft = true;
        ctx.cancel();
      }
      watchReport(p === 'report');
    }
    modelArea.hidden = p !== 'model';
    if (keepOffline) keepOffline.root.hidden = p !== 'model';
    if (modelActions) modelActions.hidden = p !== 'model';
    pivotPage.hidden = p !== 'pivot' || sqlMode;
    editStrip.hidden = !editing || p !== 'pivot';
    actions.hidden = p !== 'pivot';
    if (reportActions) reportActions.hidden = p !== 'report';
    if (p === 'pivot') openExplorer();
  }

  // --- Report: the host's tiles (ctx.report.load), drawn; drawn again when they change ---
  // Its SQL says FROM model, whatever the model is called here.
  let reportView = null, reportStamp = null, reportTimer = null, reportSeq = 0;
  // A tile's query, shared while it runs: the Report drawn again (its file changed) asks the same
  // SQL again, and waits on the run already going rather than starting a second.
  const reportRuns = new Map();   // sql -> its run, while it runs
  let reportLeft = false, reportWaiters = [];
  const reportSql = text => {
    const sql = compileModelSql(ctx.compiler, text, 'model');
    if (!reportRuns.has(sql)) reportRuns.set(sql, run(sql).finally(() => reportRuns.delete(sql)));
    return reportRuns.get(sql);
  };
  // What report.js waits on before each tile, and asks when one was stopped (drawReport).
  const reportShown = () => (page === 'report' ? Promise.resolve() : new Promise(r => reportWaiters.push(r)));
  const leftWhileRunning = () => { const was = reportLeft; reportLeft = false; return was; };
  const reportEcharts = async () => { const ec = await ctx.echarts(); registerChartTheme(ec, css); return ec; };
  // A model column's dataType, for a pick's literal (report.js): by its table, or the one column
  // of its name when there is no table.
  const columnType = (table, column) => {
    const is = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    const found = (ctx.tmsl?.tables ?? []).filter(t => table == null || is(t.name, table))
      .flatMap(t => (t.columns ?? []).filter(c => is(c.name, column)));
    return found.length === 1 ? found[0].dataType : undefined;
  };
  // Add to report changed the tiles while the Report was not on screen: drawn again when it is.
  let reportChanged = false;
  // The tiles on screen and the stamp they were read at: what a save writes over (saveReport).
  let shownReport = null;
  async function drawReportPage() {
    const my = ++reportSeq;
    reportChanged = false;
    if (!reportView) reportPage.replaceChildren(el('div', { class: 'ex-empty' }, 'Reading the report…'));
    try {
      const { spec, stamp } = await ctx.report.load();
      if (my !== reportSeq || destroyed) return;
      reportStamp = stamp ?? null;
      shownReport = { spec, stamp: reportStamp };
      reportView?.destroy();
      const saves = !!ctx.report.save;
      reportView = drawReport(reportPage, spec, { sql: reportSql, echarts: reportEcharts, shown: reportShown, leftWhileRunning,
                                                  cancel: ctx.cancel, columnType, model: ctx.tmsl, css,
                                                  remove: saves ? removeTile : undefined, layout: saves ? layoutTiles : undefined,
                                                  duplicate: saves ? duplicateTile : undefined, rename: saves ? renameTile : undefined,
                                                  edit: saves ? editTile : undefined });
    } catch (e) {
      if (my !== reportSeq || destroyed) return;
      reportView?.destroy();
      reportView = null;
      reportPage.replaceChildren(el('div', { class: 'ex-error' }, `The report could not be read: ${e.message}`));
    }
  }
  // Every save, one after another: each writes over the one before, by the stamp it answered
  // (two quick moves would otherwise both write over the first stamp, and the second be refused).
  let saving = Promise.resolve();
  const inTurn = work => (saving = saving.then(work, work));
  // `edit(spec)`: the tiles to save, from those on screen (else read, when the Report was never
  // drawn), saved over them: refused when they changed since, by a person or an agent.
  async function saveReport(edit) {
    const base = shownReport ?? await ctx.report.load();
    const spec = edit({ ...base.spec, tiles: Array.isArray(base.spec?.tiles) ? base.spec.tiles : [] });
    const saved = await ctx.report.save(spec, base.stamp ?? null);
    shownReport = { spec, stamp: saved?.stamp ?? null };
    // So the look every few seconds does not draw again what is on screen.
    reportStamp = shownReport.stamp;
    return spec;
  }
  // The ✕ on a tile: the tiles without it, and drawn again (their answers are kept: run()).
  const removeTile = i => inTurn(async () => {
    const tile = shownReport?.spec.tiles?.[i];
    try {
      await saveReport(spec => ({ ...spec, tiles: spec.tiles.filter((_, j) => j !== i) }));
      setStatus(`Removed "${tile?.title ?? 'the tile'}" from the report.`, 'ok');
    } catch (e) {
      setStatus(`Remove from the report: ${e.message}`, 'error');
    }
    if (!destroyed) drawReportPage();
  });
  // A tile's grip or ◢: laid out on screen already (report.js), so only saved: each tile in its new
  // order, with its place; an earlier build's `size` goes. Drawn again only when the save is
  // refused, as the file is now.
  const layoutTiles = list => inTurn(async () => {
    try {
      await saveReport(spec => ({ ...spec, tiles: list.map(({ from, layout }) => {
        const { size: _, ...tile } = spec.tiles[from];
        return { ...tile, layout };
      }) }));
    } catch (e) {
      setStatus(`Layout: ${e.message}`, 'error');
      if (!destroyed) drawReportPage();
    }
  });
  // A tile's ⧉: a copy of it after the Report's own tiles, as big as it is, in the first place it fits.
  const duplicateTile = i => inTurn(async () => {
    const tile = shownReport?.spec.tiles?.[i];
    try {
      await saveReport(spec => {
        if (!spec.tiles[i]) throw new Error('the tile is no longer on the report');
        const { layout, size: _, ...copy } = spec.tiles[i];
        return { ...spec, tiles: [...spec.tiles, { ...copy, ...(layout?.w && layout?.h ? { layout: { w: layout.w, h: layout.h } } : {}) }] };
      });
      setStatus(`Duplicated "${tile?.title ?? 'the tile'}".`, 'ok');
    } catch (e) {
      setStatus(`Duplicate: ${e.message}`, 'error');
    }
    if (!destroyed) drawReportPage();
  });
  // A tile's title, typed in its place (report.js drew it already): only saved, and drawn again
  // when the save is refused.
  const renameTile = (i, title) => inTurn(async () => {
    try {
      await saveReport(spec => {
        if (!spec.tiles[i]) throw new Error('the tile is no longer on the report');
        return { ...spec, tiles: spec.tiles.map((t, j) => (j === i ? { ...t, title } : t)) };
      });
    } catch (e) {
      setStatus(`Rename: ${e.message}`, 'error');
      if (!destroyed) drawReportPage();
    }
  });
  // A pivot tile's ✎: its shelves in Visual, under the strip that updates it. `editing`: the tile's
  // index and title, whether that title was its shelves' own (then it follows them), and the shelves
  // Visual had before, put back once the edit is done. A second ✎ keeps those first shelves.
  let editing = null;
  async function editTile(i) {
    const tile = shownReport?.spec.tiles?.[i];
    if (tile?.kind !== 'pivot' || !tile.pivot) return;
    show('pivot');
    await openExplorer();
    if (!explorer || destroyed) return;
    await explorer.ready;
    const title = String(tile.title ?? '');
    const own = (() => { try { return pivotTitle({ rows: [], cols: [], values: [], ...tile.pivot }); } catch { return null; } })();
    editing = { index: i, title, auto: title === own, before: editing?.before ?? explorer.state() };
    explorer.setState(tile.pivot);
    titleBox.value = title;
    if (sqlMode) closeSql();
    show('pivot');
  }
  // Update tile: the shelves on screen, and the title, written into the tile; its place stays.
  const updateTile = () => inTurn(async () => {
    if (!editing || !explorer) return;
    if (!explorer.query()) { setStatus('Update tile: put a field on the shelves first', 'error'); return; }
    const state = explorer.state(), typed = titleBox.value.trim();
    const title = (editing.auto && typed === editing.title) || !typed ? pivotTitle(state) : typed;
    const { index } = editing;
    try {
      await saveReport(spec => {
        if (!spec.tiles[index]) throw new Error('the tile is no longer on the report');
        return { ...spec, tiles: spec.tiles.map((t, j) => (j === index ? { ...t, title, pivot: state } : t)) };
      });
    } catch (e) {
      setStatus(`Update tile: ${e.message}`, 'error');
      return;
    }
    endEdit(true);
    setStatus(`Updated "${title}".`, 'ok');
  });
  // The edit done (`saved`) or cancelled: Visual's shelves from before, and the Report on screen.
  function endEdit(saved) {
    if (!editing) return;
    const { before } = editing;
    editing = null;
    explorer?.setState(before);
    if (saved) reportChanged = true;
    show('report');
  }
  // Add to report: the shelves on screen, as a pivot tile after the Report's own. Read first: the
  // Report may have changed, or never been drawn, since.
  const addToReport = () => inTurn(async () => {
    const state = explorer?.state();
    if (!state || !explorer.query()) throw new Error('put a field on the shelves first');
    const title = pivotTitle(state);
    shownReport = await ctx.report.load();
    await saveReport(spec => ({ ...spec, tiles: [...spec.tiles, { title, kind: 'pivot', pivot: state }] }));
    if (page === 'report') drawReportPage(); else reportChanged = true;
    return `Added "${title}" to the report.`;
  });
  // While the Report is on screen, its file is looked at every few seconds (ctx.report.stamp):
  // an edit to it, by a person or an agent, is drawn without a click.
  function watchReport(on) {
    clearInterval(reportTimer);
    reportTimer = null;
    if (!on || !ctx.report.stamp) return;
    reportTimer = setInterval(async () => {
      try { if ((await ctx.report.stamp()) !== reportStamp && page === 'report' && !destroyed) drawReportPage(); }
      catch { /* asked again next time */ }
    }, REPORT_POLL_MS);
  }

  // --- Model ---
  if (pages.some(([k]) => k === 'model')) renderModel(modelPage, ctx.tmsl, { title: `Semantic model ${ctx.name}` });
  let coloured = false;   // the file, coloured the first time it is shown
  function showText(on) {
    for (const [b, active] of [[diagramTab, !on], [fileTab, on]]) {
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    }
    if (on && !coloured) {
      coloured = true;
      const html = prettyModelText(ctx.text, ctx.ext);
      if (html == null) textPre.textContent = ctx.text; else textPre.innerHTML = html;
    }
    modelPage.hidden = on;
    textPre.hidden = !on;
    textNote.hidden = !on || !(vendors.length || dialects.length) || !textPre.querySelector('.tk-ext');
  }
  showText(false);

  // --- Running: compiled once, answered from this view's results when it ran before ---
  const compile = text => compileModelSql(ctx.compiler, text, ctx.name);
  // Results, kept for the life of this view by the SQL that produced them: the model is read
  // only, so the same SQL is the same rows — the pivot toggling Totals or swapping back, Show
  // SQL's unedited box, are answered here. Only answers are kept, never a failure or a Stop;
  // a CSV and a profile run fresh.
  const results = new Map();   // sql -> result, oldest first
  async function run(sql, { fresh = false } = {}) {
    if (!fresh && results.has(sql)) {
      const hit = results.get(sql);
      results.delete(sql);
      results.set(sql, hit);
      return hit;
    }
    const res = await ctx.run(sql);
    if (!fresh) {
      results.set(sql, res);
      if (results.size > 40) results.delete(results.keys().next().value);
    }
    return res;
  }

  // --- Pivot ---
  const charts = new Map();
  const resized = new ResizeObserver(entries => { for (const e of entries) charts.get(e.target)?.resize(); });
  const css = name => getComputedStyle(root).getPropertyValue(name).trim();
  let explorer = null, destroyed = false, echarts = null;
  // VS Code's theme switch changes the body's class (vscode-dark, vscode-light, …). ECharts 5
  // cannot re-theme a chart, so each is disposed and the pivot draws a new one in the theme
  // registered again from the page's new tokens.
  let bodyClass = document.body.className;
  const themed = new MutationObserver(() => {
    if (document.body.className === bodyClass) return;
    bodyClass = document.body.className;
    // A frame later: VS Code sets the new colour variables beside the class.
    requestAnimationFrame(() => {
      if (!echarts || destroyed) return;
      registerChartTheme(echarts, css);
      for (const [box, c] of charts) { resized.unobserve(box); c.dispose(); }
      charts.clear();
      explorer?.redraw();
    });
  });
  themed.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  // Once, whoever asks first (show, editTile); asked again only after it failed.
  let opening = null;
  function openExplorer() {
    return (opening ??= startExplorer().finally(() => { if (!explorer) opening = null; }));
  }
  async function startExplorer() {
    if (explorer) return;
    pivotPage.replaceChildren(el('div', { class: 'ex-empty' }, 'Loading the chart library…'));
    try {
      echarts = await ctx.echarts();
      registerChartTheme(echarts, css);
    } catch (e) {
      pivotPage.replaceChildren(el('div', { class: 'ex-error' }, `Could not load the chart library: ${e.message}`));
      return;
    }
    if (explorer || destroyed) return;
    explorer = createExplorer(pivotPage, {
      // A table's Visual only builds SQL: no slicer there.
      noSlicer: !!ctx.editSql,
      model: async () => ctx.tmsl,
      name: ctx.name,
      run: async text => (await run(compile(text))).rows,
      cancel: ctx.cancel,
      chart: box => {
        if (!charts.has(box)) { charts.set(box, echarts.init(box, 'studio')); resized.observe(box); }
        return charts.get(box);
      },
      palette: () => PALETTE,
      css,
      loadState: () => ctx.loadState(ctx.stateKey ?? `explore.${ctx.name}`),
      saveState: s => ctx.saveState(ctx.stateKey ?? `explore.${ctx.name}`, s),
    });
  }

  // --- Show SQL ---
  let sqlMode = false, planShown = false;
  const typed = () => ta.value.trim().replace(/;+\s*$/, '');
  function clearResults() { out.innerHTML = ''; info.textContent = ''; }
  function fillSql() {
    ++outSeq;   // a run in flight answers the text this replaces
    showPlanNode(null);
    ta.value = explorer?.query()?.sql ?? '';
    clearResults();
  }
  function openSql() {
    if (!explorer?.query()) { setStatus('Put a field on the shelves first', 'error'); return; }
    sqlMode = true;
    fillSql();
    pivotPage.hidden = true;
    sqlPage.hidden = false;
    sqlToggle.textContent = 'Show visual';
    sqlModeButtons();
    ta.focus();
  }
  function closeSql() {
    sqlMode = false;
    showPlanNode(null);
    sqlPage.hidden = true;
    pivotPage.hidden = page !== 'pivot';
    sqlToggle.textContent = 'Show SQL';
    sqlModeButtons();
    explorer?.redraw();   // the chart takes its box's size again
  }
  // Add to report takes the shelves, not the box: off while the box is shown.
  function sqlModeButtons() {
    if (!addBtn) return;
    addBtn.disabled = sqlMode;
    addBtn.title = sqlMode ? 'Show visual first' : 'This pivot, as it is, as a tile of the Report';
  }
  // Ctrl+Enter reaches runSql while a run or a plan is still going; only the latest may write.
  let outSeq = 0;
  async function busy(button, label, work, current) {
    // Its idle label, from before any run: a second Ctrl+Enter must not keep 'Running…'.
    const was = (button.dataset.idle ??= button.textContent);
    for (const b of [runBtn, planBtn]) b.disabled = true;
    button.textContent = label;
    try { return await work(); }
    catch (e) {
      if (!current()) return;
      if (e.cancelled) { info.textContent = 'Stopped.'; return; }
      info.textContent = e.message?.includes('Out of Memory') ? 'Out of memory: add a filter.' : `Error: ${e.message}`;
      setStatus(`Query error: ${e.message}`, 'error');
      console.error('[explore]', e);
    } finally {
      for (const b of [runBtn, planBtn]) b.disabled = false;
      button.textContent = was;
    }
  }
  function runSql() {
    const base = typed();
    if (!base) { info.textContent = 'Enter a SQL query.'; return; }
    showPlanNode(null);
    clearResults();
    const my = ++outSeq;
    return busy(runBtn, 'Running…', async () => {
      const t0 = performance.now();
      const ticker = setInterval(() => { if (my === outSeq) info.textContent = `Running query… ${elapsed(t0)}`; }, 100);
      try {
        // Every column as DuckDB prints it: a DATE, TIMESTAMP or DECIMAL would otherwise show
        // as its raw number. How many rows there are in all comes in the same run: a COUNT(*)
        // after it ran the whole query a second time (3 s and 3 s on a model's 592 million rows).
        const res = await run(`SELECT COLUMNS(*)::VARCHAR FROM (SELECT *, COUNT(*) OVER () AS ${TOTAL_COL} FROM (\n${compile(base)}\n)) LIMIT ${PREVIEW_ROWS}`);
        if (my !== outSeq) return;
        if (!res.rows.length) { info.textContent = `No rows · ${elapsed(t0)}`; return; }
        const fields = res.fields.filter(c => c !== TOTAL_NAME);
        out.innerHTML = '<thead><tr>' + fields.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead><tbody>' +
          res.rows.map(r => '<tr>' + fields.map(c => `<td>${escapeHtml(r[c] ?? '')}</td>`).join('') + '</tr>').join('') + '</tbody>';
        const total = Number(res.rows[0][TOTAL_NAME] ?? res.rows.length);
        info.textContent = (res.rows.length < total ? `Showing ${res.rows.length} of ${total.toLocaleString()} rows`
          : `${total.toLocaleString()} rows`) + ` · ${elapsed(t0)}`;
        setStatus(`${ctx.name}: ${info.textContent}.`, 'ok');
      } finally { clearInterval(ticker); }
    }, () => my === outSeq);
  }

  // --- Show plan: the profile (EXPLAIN ANALYZE, which runs the query once more) and the tree ---
  function showPlanNode(node) {
    planView.replaceChildren(...(node ? [node] : []));
    planView.hidden = !node;
    outWrap.hidden = !!node;
    planShown = !!node;
    planBtn.textContent = planShown ? 'Show results' : 'Show plan';
  }
  async function planTree(sql) {
    if (ctx.htmlPlan) {
      const res = await run(`EXPLAIN (FORMAT html) ${sql}`);
      const frame = el('iframe', { class: 'plan-frame', title: 'Query plan', sandbox: 'allow-scripts' });
      frame.srcdoc = res.rows.map(r => r.explain_value ?? Object.values(r).join('\n')).join('\n');
      return frame;
    }
    const res = await run(`EXPLAIN ${sql}`);
    return el('pre', { class: 'sm-plan' }, res.rows.map(r => r.explain_value ?? Object.values(r).join('  ')).join('\n'));
  }
  function showPlan() {
    // A second click puts the results back.
    if (planShown) { showPlanNode(null); return runSql(); }
    const base = typed();
    if (!base) { info.textContent = 'Enter a SQL query.'; return; }
    info.textContent = '';
    try {
      const sql = compile(base);
      showPlanNode(createPlanView({
        sql: ctx.shownSql ? () => ctx.shownSql(compile(base)) : sql, copy: ctx.copyText,
        profile: async () => (await run(profileSql(compile(base), { set: ctx.profileSet !== false }), { fresh: true })).rows[0]?.explain_value,
        tree: () => planTree(compile(base)),
        colors: () => profileColors(css),
        elapsed,
      }));
      info.textContent = 'Query plan';
    } catch (e) {
      info.textContent = `Error: ${e.message}`;
      setStatus(`Query error: ${e.message}`, 'error');
    }
  }

  // --- Download CSV: the pivot's query (the shelves, all rows), or the box's SQL once open ---
  async function download() {
    const base = sqlMode ? typed() : explorer?.query({ cap: 0, totals: false })?.sql;
    if (!base) { setStatus(sqlMode ? 'Enter a SQL query' : 'Put a field on the shelves first', 'error'); return; }
    csvBtn.disabled = true;
    csvBtn.textContent = 'Exporting…';
    try {
      // Cast as the box's results are, so the file holds what they show.
      const res = await run(`SELECT COLUMNS(*)::VARCHAR FROM (\n${compile(base)}\n)`, { fresh: true });
      const text = toCsv(res.fields, res.rows, { eol: '\n' }) + '\n';
      const saved = await ctx.saveText(`${ctx.name}-explore.csv`, text);
      if (saved) setStatus(`Saved ${res.rows.length.toLocaleString()} rows${typeof saved === 'string' ? ` to ${saved}` : ''}` +
        (res.truncated ? ` — stopped at the engine's cap of ${res.limit.toLocaleString()}; add a filter for all of them` : '') + '.',
        res.truncated ? 'warn' : 'ok');
    } catch (e) {
      setStatus(`CSV export error: ${e.message}`, 'error');
      console.error('[explore CSV]', e);
    } finally {
      csvBtn.disabled = false;
      csvBtn.textContent = 'Download CSV';
    }
  }

  // --- Export to Fabric: what the app runs on, in a small window under the button (Direct Lake
  // unless changed), then the host does the work and says how it went ---
  async function exportApp() {
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting…';
    try {
      const said = await ctx.exportToFabric(explorer?.state() ?? null);
      if (said) setStatus(said, 'ok');
    } catch (e) {
      setStatus(`Export to Fabric: ${e.message}`, 'error');
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = 'Export to Fabric';
    }
  }

  show(page);

  return {
    destroy() {
      destroyed = true;
      keepOffline?.destroy();
      clearInterval(reportTimer);
      reportView?.destroy();
      explorer?.destroy();
      results.clear();
      resized.disconnect();
      themed.disconnect();
      for (const c of charts.values()) c.dispose();
      charts.clear();
      document.querySelectorAll('.ex-pop').forEach(p => p.remove());
      root.replaceChildren();
    },
  };
}
