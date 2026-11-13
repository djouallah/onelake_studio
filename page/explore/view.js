// =============================================================================
// explore/view.js — a semantic model's Explore: Model, Visual and Report
// =============================================================================
//   Model     the star of its tables and relationships, and what the model says of the
//             table picked (model.js)
//   Visual    (the 'pivot' page) the model's fields dragged onto shelves, drawn as a pivot or a chart
//             (explore.js, ECharts). Its query is always its shelves', a JSON visual query whose
//             SQL is made behind the scenes: it has no SQL box. Show plan puts that query's
//             profile and plan tree in place of the view (profile.js). Download CSV writes its
//             rows. Add to report (a host that saves the Report) puts the visual on the Report.
//   Report    pages of tiles the host reads (ctx.report: Export to Fabric's report.json, or the
//             file the host keeps before an export; none at first), each tile a SELECT over the
//             model, a visual (a slicer among them) or text, drawn by report.js, one page at a
//             time under the pages' names. A host that saves the Report: + adds a page, a
//             double-click renames one, its ✕ deletes it, and dragged it moves; a tile's ✕ takes
//             it out, its grip moves it (onto a page's name: to that page), ⧉ copies it, a
//             double-click renames it, ✎ opens a visual's shelves in Visual under a strip that
//             updates the tile, and Add text adds a text tile
// Model's Diagram | YAML (or BIM) shows the model drawn, or its file as written (pretty.js).
// The bar: the page tabs, then each page's own: Model's Keep offline, then Diagram | YAML, Create
// Semantic Model (a model file only) and Open in Excel at the right; Visual's Show plan, Download CSV and Add to report; the Report's Add
// text and Export to Fabric, which publishes the Report as a Fabric app.
// The same file in the panel and in Export to Fabric's app: the host says how a model's SQL is compiled
// and run, and where ECharts comes from (`ctx`); nothing here knows the engine.
// =============================================================================

import { toCsv } from '../paths.js';
import { renderModel } from './model.js';
import { el } from './dom.js';
import { createExplorer, pivotTitle, modelFields, valuesSql, setRowCap } from './explore.js';
import { compileModelSql } from './query.js';
import { createPlanView, profileSql, elapsed, profileColors } from './profile.js';
import { PALETTE, PALETTES, STYLES, registerChartTheme } from './theme.js';
import { prettyModelText, extensionVendors, foreignDialects } from './pretty.js';
import { drawReport, reportPages, withPages, newPageName, pickWhere } from './report.js';
import { cleanFormat, paneRow, paneSelect, paneCheck, paneColour, SIZES } from './format.js';

const PAGES = [['model', 'Model'], ['pivot', 'Visual'], ['report', 'Report']];
const REPORT_POLL_MS = 2000;

// `ctx`:
//   name             the model's name: what SQL calls it (FROM <name>)
//   text, ext        (optional) the model's file and its extension: Model's Diagram | YAML switch
//   tmsl             the model, as model.js's tmslOf reads it
//   compiler         dax-sql's compiler over the model, with the host's tableSource and
//                    query.js's EXPLORE_CASTS
//   run(sql)         a compiled SQL's result: { fields, rows, numRows, truncated?, limit? }
//   echarts()        ECharts (a promise)
//   worldMap()       (optional) the world's outline, a GeoJSON (a promise): what a map draws over
//   saveText(name, text)  a CSV saved: answers where (or null: dismissed)
//   loadState(key), saveState(key, s)  the shelves, between visits
//   setStatus(text, kind)  (optional) the host's status line
//   profileSet       whether the profile's SQL sets its own metrics (profile.js): false for an
//                    engine that set them and locked its configuration (the extension's)
//   htmlPlan         Show plan's tree as DuckDB's HTML page in a frame (the Fabric app), else
//                    its text plan (the panel: its CSP runs no inline script)
//   exportToFabric(state)  (optional) the Report's Export to Fabric button: the Report published as
//                    a Fabric app (fabric_app/export/exportapp.js; `state`, the shelves, or null), on what the model
//                    is, so nothing is asked here; answers what to say when it is done
//   createSemanticModel()  (optional) a model file's Create Semantic Model button, on the Model page:
//                    the tree's own (fabric_app/export/exportflow.js), its dialog the host's; answers what to say
//   openInExcel()    (optional) the Open in Excel button: this model in a new workbook, as a live
//                    PivotTable (xmla); answers what to say when it is open
//   keepOffline      (optional) { state(), set(on) }: the Keep offline switch beside the tabs, every
//                    table of this model on this machine (core/models/modeldata.js); both answer what it shows:
//                    { on, say, tone, meter, tip, busy }
//   editSql(sql)     (optional) the Edit SQL button: the shelves' query, all its rows, handed
//                    to the host's own SQL editor, which runs it and saves its CSV, so Show plan
//                    and Download CSV are left out
//   plainSql         (optional) { from, measure(name) }: editSql's query as SQL over one table
//                    (explore.js's modelSql), else SQL over the model
//   close()          (optional) a Close button, after Edit SQL
//   report           (optional) the Report page's pages: { load(), stamp()?, save()? }. load answers
//                    { spec, stamp } (report.js's spec: { pages }, or { tiles } as written before
//                    pages); stamp(), asked while the page is on screen, answers a value that
//                    changes when the report does; save(spec, stamp) writes it, always as pages,
//                    refused when it changed since `stamp` (Add to report, the tiles' ✕ and the
//                    pages' +: none, a Report that only reads). No report: no page
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
  // The most rows a visual asks for: what a result may keep where this runs.
  if (ctx.maxRows) setRowCap(ctx.maxRows);
  const setStatus = ctx.setStatus || (() => {});
  const btn = (text, onclick, primary) => el('button', { type: 'button', class: `btn-explore${primary ? ' primary' : ''}`, onclick }, text);

  // --- The frame: the subtabs and each page's actions, then one element per page ---
  const pages = PAGES.filter(([k]) => (k !== 'report' || ctx.report) && (!ctx.pages || ctx.pages.includes(k)));
  const tabs = pages.map(([k, t], i) => el('button', { type: 'button', class: `subtab${i ? '' : ' active'}`, role: 'tab',
    'data-apage': k, 'aria-selected': String(!i), tabindex: i ? '-1' : '0' }, t));
  const planToggle = btn('Show plan', () => (planMode ? closePlan() : openPlan()));
  planToggle.title = "The plan of this visual's query: its profile and its tree";
  // One button of the bar is lit: Add to report where the host saves the Report, else Download CSV.
  const csvBtn = btn('Download CSV', download, !ctx.report?.save);
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
  addBtn?.classList.add('primary');
  const textBtn = ctx.report?.save ? hostBtn('Add text', 'Adding…', () => addText(), 'A text tile on this page: headings, bold, links and lists') : null;
  // Each page's buttons, at the right of the bar: Visual's, the Report's, the Model's.
  const actions = el('div', { class: 'explore-actions', hidden: true },
    ...(editBtn ? [editBtn, closeBtn] : [planToggle, csvBtn, addBtn]));
  const themeBtn = ctx.report?.save ? btn('Theme', () => toggleTheme()) : null;
  if (themeBtn) { themeBtn.title = "The report's colours and text, and its tiles' titles and filters"; themeBtn.setAttribute('aria-pressed', 'false'); }
  const reportActions = exportBtn || textBtn ? el('div', { class: 'explore-actions', hidden: true }, themeBtn, textBtn, exportBtn) : null;
  // The Report: its pages' names (reportStrip), then a page's tiles, each page drawn once it is shown.
  const pageStrip = el('div', { class: 'rp-pages', hidden: true });
  const pageHost = el('div', { class: 'rp-page-host' });
  // The Report's Theme opens its pane at the right of the tiles (drawTheme, below).
  const formatPane = el('aside', { class: 'rp-pane', hidden: true, 'aria-label': 'Format' });
  // The report's filter bar, over its pages' names (drawBar, below).
  const filterBar = el('div', { class: 'rp-bar', hidden: true });
  // Over them all: the report's title (its `title`; a host that saves it: a double-click edits it)
  // and when its tiles last had their answers (drawTop, below).
  const reportTitle = el('h1', { class: 'rp-title' });
  const readAt = el('span', { class: 'rp-read' });
  const reportTop = el('div', { class: 'rp-top', hidden: true }, reportTitle, readAt);
  const reportPage = el('div', { class: 'report-page', hidden: true }, reportTop, filterBar, pageStrip, el('div', { class: 'rp-work' }, pageHost, formatPane));
  const modelPage = el('div', { class: 'model-page' });
  const pivotPage = el('div', { class: 'explore-page', hidden: true });
  // Over Visual while a Report tile is edited there (editTile): its title, Update tile and Cancel.
  const titleBox = el('input', { type: 'text', class: 'explore-editing-title', 'aria-label': 'Tile title' });
  titleBox.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); updateTile(); } });
  const editStrip = el('div', { class: 'explore-editing', hidden: true },
    el('span', { class: 'explore-editing-say' }, 'Editing a Report tile'),
    el('label', {}, 'Title', titleBox),
    btn('Update tile', () => updateTile(), true), btn('Cancel', () => endEdit(false)));

  // Show plan: the plan of the shelves' query, in place of the view.
  const planView = el('div', { class: 'explore-plan' });
  const planPage = el('div', { class: 'explore-sql-page', hidden: true }, planView);

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
    reportPage, modelArea, editStrip, pivotPage, planPage);

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
    if (planMode && p !== 'pivot') closePlan();
    reportPage.hidden = p !== 'report';
    if (ctx.report) {
      if (p === 'report') {
        wakeReport();
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
    pivotPage.hidden = p !== 'pivot' || planMode;
    editStrip.hidden = !editing || p !== 'pivot';
    actions.hidden = p !== 'pivot';
    if (reportActions) reportActions.hidden = p !== 'report';
    if (p === 'pivot') openExplorer();
  }

  // --- Report: the host's pages (ctx.report.load), drawn; drawn again when they change ---
  // Its SQL names the model as SQL calls it here (ctx.name), so a tile's statement runs as it is from Logs or
  // the SQL box; the tiles are saved with no name. One page on screen (reportAt);
  // each page shown is drawn once and kept, hidden, with its picks, until the Report is drawn again.
  let reportStamp = null, reportTimer = null, reportSeq = 0, reportAt = 0;
  const pageViews = new Map();   // page index -> { box, view }
  // A tile's query, shared while it runs: the Report drawn again (its file changed) asks the same
  // SQL again, and waits on the run already going rather than starting a second.
  const reportRuns = new Map();   // sql -> its run, while it runs
  let reportLeft = false, reportWaiters = [];
  const modelName = ctx.name || 'model';
  const reportSql = text => {
    const sql = compileModelSql(ctx.compiler, text, modelName);
    if (!reportRuns.has(sql)) reportRuns.set(sql, run(sql).finally(() => reportRuns.delete(sql)));
    return reportRuns.get(sql);
  };
  // What report.js waits on before each tile of page `at`: that page on screen. And what it asks
  // when one was stopped (drawReport).
  const reportShown = at => (page === 'report' && reportAt === at ? Promise.resolve()
    : new Promise(go => reportWaiters.push({ at, go })));
  function wakeReport() {
    if (page !== 'report') return;
    const now = reportWaiters.filter(w => w.at === reportAt);
    reportWaiters = reportWaiters.filter(w => w.at !== reportAt);
    for (const w of now) w.go();
  }
  const leftWhileRunning = () => { const was = reportLeft; reportLeft = false; return was; };
  // The Report's charts are drawn in the Report's own colours (its theme's background), read off its page.
  const reportCss = name => getComputedStyle(reportPage).getPropertyValue(name).trim();
  const reportEcharts = async () => { const ec = await ctx.echarts(); registerChartTheme(ec, reportCss, 'report'); return ec; };
  // The report's background (its theme's): the editor's, or the Report's own dark or light.
  const BACKGROUNDS = [['editor', 'Editor'], ['dark', 'Dark'], ['light', 'Light']];
  // A style (theme.js STYLES) has its own colours: the background is the theme's only without one.
  const styleOf = theme => (Object.hasOwn(STYLES, theme?.style ?? '') ? theme.style : null);
  function paintBackground() {
    const theme = shownReport?.spec?.theme, style = styleOf(theme), bg = style ? null : theme?.background;
    for (const [k] of BACKGROUNDS) reportPage.classList.toggle(`rp-bg-${k}`, k !== 'editor' && k === bg);
    for (const k of Object.keys(STYLES)) reportPage.classList.toggle(`rp-style-${k}`, k === style);
  }
  // Add to report changed the tiles while the Report was not on screen: drawn again when it is.
  let reportChanged = false;
  // The report on screen and the stamp it was read at: what a save writes over (saveSpec); its pages
  // (report.js reportPages), and the tiles of the page on screen.
  let shownReport = null, shownPages = [];
  const shownTiles = () => (Array.isArray(shownPages[reportAt]?.tiles) ? shownPages[reportAt].tiles : []);
  // The pages drawn so far, gone; whatever waited on one of them is let go (it sees it is gone).
  function dropPages() {
    for (const { view } of pageViews.values()) view.destroy();
    pageViews.clear();
    for (const w of reportWaiters.splice(0)) w.go();
  }
  // A page's name after a + is ready to rename (drawStrip).
  let renameNext = null;
  async function drawReportPage() {
    const my = ++reportSeq;
    reportChanged = false;
    if (!pageViews.size) pageHost.replaceChildren(el('div', { class: 'ex-empty' }, 'Reading the report…'));
    try {
      const { spec, stamp } = await ctx.report.load();
      if (my !== reportSeq || destroyed) return;
      reportStamp = stamp ?? null;
      shownReport = { spec, stamp: reportStamp };
      shownPages = reportPages(spec);
      paintBackground();
      dropPages();
      pageHost.replaceChildren();
      reportAt = Math.max(0, Math.min(reportAt, shownPages.length - 1));
      drawTop();
      drawBar();
      drawStrip();
      showReportPage(reportAt);
      if (themeOpen) drawTheme();
    } catch (e) {
      if (my !== reportSeq || destroyed) return;
      dropPages();
      pageStrip.hidden = true;
      pageHost.replaceChildren(el('div', { class: 'ex-error' }, `The report could not be read: ${e.message}`));
    }
  }
  // Page `i` on screen: drawn the first time; the page left keeps its picks. A tile running on the
  // page left is stopped, and runs again when its page is back.
  function showReportPage(i) {
    if (i !== reportAt && reportRuns.size && ctx.cancel) { reportLeft = true; ctx.cancel(); }
    reportAt = i;
    if (!pageViews.has(i)) {
      const box = el('div', { class: 'rp-page-view' });
      pageHost.append(box);
      pageViews.set(i, { box, view: drawReport(box, { tiles: shownPages[i]?.tiles, theme: shownReport?.spec?.theme }, pageCtx(i)) });
    }
    for (const [k, { box }] of pageViews) box.hidden = k !== i;
    // The Theme pane lists the tiles of the page on screen.
    if (themeOpen) drawTheme();
    markStrip();
    if (addBtn) addBtn.title = `This visual, as it is, as a tile of ${shownPages.length > 1 ? `the page ${shownPages[i].name}` : 'the Report'}`;
    wakeReport();
  }
  function pageCtx(i) {
    const saves = !!ctx.report.save;
    return { sql: reportSql, name: modelName, echarts: reportEcharts, shown: () => reportShown(i), leftWhileRunning,
             cancel: ctx.cancel, parallel: ctx.reportParallel, model: ctx.tmsl, css: reportCss, chartTheme: 'report',
             remove: saves ? removeTile : undefined, layout: saves ? layoutTiles : undefined,
             duplicate: saves ? duplicateTile : undefined, rename: saves ? renameTile : undefined,
             edit: saves ? editTile : undefined, setText: saves ? setText : undefined,
             toPage: saves && shownPages.length > 1 ? { at: pageUnder, drop: tileToPage } : undefined,
             where: barWhere, mapReady,
             done: () => { readAt.textContent = `Data read ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; } };
  }
  // The report's title and its "data read" time, once it has a tile. A host that saves the Report
  // and has no title yet: "Add a title", shown while the pointer is over the line.
  function drawTop() {
    const saves = !!ctx.report.save, title = String(shownReport?.spec?.title ?? '').trim();
    reportTop.hidden = !shownPages.some(p => Array.isArray(p.tiles) && p.tiles.length);
    reportTitle.textContent = title || (saves ? 'Add a title' : '');
    reportTitle.classList.toggle('rp-title-none', !title);
    if (saves) reportTitle.title = 'Double-click to edit'; else reportTitle.removeAttribute('title');
  }
  reportTitle.addEventListener('dblclick', () => {
    if (!ctx.report.save) return;
    const was = String(shownReport?.spec?.title ?? '').trim();
    const input = el('input', { type: 'text', class: 'rp-title-edit', value: was, placeholder: 'Report title', 'aria-label': 'Report title' });
    let done = false;
    const end = keep => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      input.replaceWith(reportTitle);
      if (keep && next !== was) setTitle(next);
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); end(true); }
      else if (e.key === 'Escape') { e.preventDefault(); end(false); }
    });
    input.addEventListener('blur', () => end(true));
    reportTitle.replaceWith(input);
    input.focus();
    input.select();
  });

  // The world's map, registered with ECharts the first time a map is drawn (the host's file).
  let mapP = null;
  const mapReady = () => (mapP ??= (async () => {
    const ec = await ctx.echarts();
    if (ec.getMap?.('world')) return;
    if (!ctx.worldMap) throw new Error('this window has no map of the world');
    ec.registerMap('world', await ctx.worldMap());
  })().catch(e => { mapP = null; throw e; }));

  // --- The filter bar: the report's `filters` ([{ field, style }]), over every page. What is
  // picked in one is a condition of every tile's query, but those whose format ignores it, as the
  // Filters shelf writes one (report.js pickWhere): a dropdown's one value, a list's values, or
  // dates from and to (with 3d, 7d, 30d, 1y and All, back from the latest day the column has).
  // Picked, the pages are drawn again, and their picks in tiles go. A host that saves the Report:
  // + Filter adds one, its ✕ takes it out.
  const barPicks = new Map();   // field -> { values } | { range: [from, to] }
  let barFields = null;
  const reportFields = () => (barFields ??= modelFields(ctx.tmsl));
  const barFilters = () => (Array.isArray(shownReport?.spec?.filters) ? shownReport.spec.filters.filter(x => x && typeof x.field === 'string') : []);
  function barWhere(tile) {
    const ignored = new Set(Array.isArray(tile?.ignore) ? tile.ignore : []);
    return barFilters().filter(x => !ignored.has(x.field) && barPicks.has(x.field)).flatMap(x => pickWhere(x.field, barPicks.get(x.field)));
  }
  const barValues = new Map();  // field (and 'latest:'+field) -> a promise of its values
  const valuesOf = (id, opts = {}) => {
    const key = `${opts.desc ? 'latest' : ''}:${opts.top ?? ''}:${id}`;
    if (!barValues.has(key)) {
      barValues.set(key, reportSql(valuesSql(reportFields(), id, { ...opts, name: modelName })).then(r => r.rows.map(x => x.v))
        .catch(e => { barValues.delete(key); throw e; }));
    }
    return barValues.get(key);
  };
  // The bar's picks changed: every page drawn again with them, its tiles' picks gone.
  function barChanged() {
    dropPages();
    pageHost.replaceChildren();
    showReportPage(reportAt);
    drawBar();
  }
  const fieldName = id => reportFields().byId.get(id)?.name ?? id;
  const DAY = 864e5;
  const dayBack = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);
  function drawBar() {
    const saves = !!ctx.report.save, filters = barFilters();
    for (const k of [...barPicks.keys()]) if (!filters.some(x => x.field === k)) barPicks.delete(k);
    filterBar.hidden = !filters.length && !saves;
    const items = filters.map(x => {
      const label = el('span', { class: 'rp-bar-label' }, fieldName(x.field));
      const remove = saves ? el('button', { type: 'button', class: 'rp-bar-x', title: 'Take this filter out of the report',
        'aria-label': `Take the filter on ${fieldName(x.field)} out`, onclick: () => removeFilter(x.field) }, '✕') : null;
      return el('div', { class: 'rp-bar-item' }, label, barControl(x), remove);
    });
    filterBar.replaceChildren(...items, saves ? addFilterButton() : null);
  }
  function barControl(x) {
    const id = x.field, picked = barPicks.get(id);
    if (x.style === 'dates') {
      const from = el('input', { type: 'date', value: picked?.range?.[0] ?? '', 'aria-label': `${fieldName(id)} from` });
      const to = el('input', { type: 'date', value: picked?.range?.[1] ?? '', 'aria-label': `${fieldName(id)} to` });
      const set = range => { if (range[0] || range[1]) barPicks.set(id, { range: [range[0] || null, range[1] || null] }); else barPicks.delete(id); barChanged(); };
      from.addEventListener('change', () => set([from.value, to.value]));
      to.addEventListener('change', () => set([from.value, to.value]));
      const preset = (t, days) => el('button', { type: 'button', class: 'rp-bar-preset', onclick: async () => {
        if (!days) { set([null, null]); return; }
        try {
          const latest = String((await valuesOf(id, { top: 1, desc: true }))[0] ?? '').slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(latest)) set([dayBack(latest, days - 1), latest]);
        } catch (e) { setStatus(`${fieldName(id)}: ${e.message}`, 'error'); }
      } }, t);
      return el('span', { class: 'rp-bar-dates' }, from, el('span', { class: 'rp-bar-to' }, 'to'), to,
        preset('3d', 3), preset('7d', 7), preset('30d', 30), preset('1y', 365), preset('All', 0));
    }
    if (x.style === 'list') {
      const n = picked?.values?.length ?? 0;
      const b = el('button', { type: 'button', class: 'rp-bar-pick', 'aria-haspopup': 'dialog' }, n ? `${n === 1 ? String(picked.values[0] ?? '(blank)') : `${n} selected`} ▾` : 'All ▾');
      b.addEventListener('click', () => openList(id, b));
      return b;
    }
    // A dropdown: All, or one value.
    const sel = el('select', { 'aria-label': fieldName(id) }, el('option', { value: '' }, 'All'));
    valuesOf(id).then(values => {
      sel.append(...values.map((v, i) => el('option', { value: String(i), selected: picked?.values?.length === 1 && picked.values[0] === v }, v == null ? '(blank)' : String(v))));
      sel.onchange = () => { if (sel.value === '') barPicks.delete(id); else barPicks.set(id, { values: [values[Number(sel.value)]] }); barChanged(); };
    }, e => sel.append(el('option', { disabled: true }, e.message)));
    return sel;
  }
  // A list filter's values to tick, searched, under its button; Apply keeps them.
  let barPop = null;
  const closeBarPop = () => { barPop?.remove(); barPop = null; };
  async function openList(id, anchor) {
    closeBarPop();
    const picked = new Set(barPicks.get(id)?.values ?? []);
    const find = el('input', { type: 'search', placeholder: 'Search', 'aria-label': `Search ${fieldName(id)}` });
    const boxes = el('div', { class: 'rp-bar-values' }, el('p', { class: 'rp-say' }, 'Reading values…'));
    const apply = () => { if (picked.size) barPicks.set(id, { values: [...picked] }); else barPicks.delete(id); closeBarPop(); barChanged(); };
    barPop = el('div', { class: 'rp-bar-pop', role: 'dialog', 'aria-label': fieldName(id) }, find, boxes,
      el('div', { class: 'rp-bar-pop-foot' }, btn('Clear', () => { picked.clear(); apply(); }), btn('Cancel', closeBarPop), btn('Apply', apply, true)));
    barPop.addEventListener('keydown', e => { if (e.key === 'Escape') closeBarPop(); });
    const r = anchor.getBoundingClientRect();
    Object.assign(barPop.style, { left: `${Math.max(8, r.left)}px`, top: `${r.bottom + 4}px` });
    document.body.append(barPop);
    let values;
    try { values = await valuesOf(id); } catch (e) { boxes.replaceChildren(el('p', { class: 'rp-say error' }, e.message)); return; }
    // At most 150 shown: the search narrows them.
    const show = () => {
      const term = find.value.toLowerCase();
      const hits = values.filter(v => String(v ?? '(blank)').toLowerCase().includes(term));
      boxes.replaceChildren(...hits.slice(0, 150).map(v => {
        const c = el('input', { type: 'checkbox', checked: picked.has(v) });
        c.addEventListener('change', () => { if (c.checked) picked.add(v); else picked.delete(v); });
        return el('label', {}, c, v == null ? '(blank)' : String(v));
      }), hits.length > 150 ? el('p', { class: 'rp-say' }, `the first 150 of ${hits.length}: search for the rest`) : null);
    };
    find.addEventListener('input', show);
    show();
    find.focus();
  }
  // + Filter: a column of the model and how it is picked, added to the bar.
  function addFilterButton() {
    const add = el('button', { type: 'button', class: 'rp-bar-add', title: 'Add a filter over every page' }, '+ Filter');
    add.addEventListener('click', () => {
      const cols = reportFields().tables.flatMap(t => t.columns.filter(c => !c.derived).map(c => [c.id, `${t.name} › ${c.name}`, c.type]));
      const used = new Set(barFilters().map(x => x.field));
      const col = el('select', { 'aria-label': 'Column' }, cols.filter(([id]) => !used.has(id)).map(([id, t]) => el('option', { value: id }, t)));
      const style = el('select', { 'aria-label': 'How it is picked' },
        el('option', { value: 'dropdown' }, 'Dropdown'), el('option', { value: 'list' }, 'List'), el('option', { value: 'dates' }, 'Dates'));
      const fit = () => { if (cols.find(([id]) => id === col.value)?.[2] === 'date') style.value = 'dates'; else if (style.value === 'dates') style.value = 'dropdown'; };
      col.addEventListener('change', fit);
      fit();
      const form = el('div', { class: 'rp-bar-form' }, col, style,
        btn('Add', () => addFilter({ field: col.value, style: style.value }), true), btn('Cancel', () => drawBar()));
      add.replaceWith(form);
      col.focus();
    });
    return add;
  }
  const saveFilters = next => inTurn(async () => {
    try { await saveSpec(pages => pages, { filters: next.length ? next : undefined }); }
    catch (e) { setStatus(`Filter: ${e.message}`, 'error'); }
    if (!destroyed) drawReportPage();
  });
  const addFilter = x => { if (x.field) saveFilters([...barFilters(), x]); };
  const removeFilter = id => { barPicks.delete(id); saveFilters(barFilters().filter(x => x.field !== id)); };

  // --- The Theme pane (the Report's Theme): the report's colours, its text size and its colours by
  // value, for every page; and each tile of the page on screen: its title shown or not and its
  // size, and the filter bar's filters it follows. A change is saved, and the page drawn again.
  // A tile's look is its Visual's: its Format pane, in Visual (✎).
  let themeOpen = false;
  function toggleTheme() {
    themeOpen = !themeOpen;
    themeBtn?.setAttribute('aria-pressed', String(themeOpen));
    drawTheme();
  }
  function drawTheme() {
    formatPane.hidden = !themeOpen;
    if (!themeOpen) { formatPane.replaceChildren(); return; }
    formatPane.replaceChildren(
      el('div', { class: 'rp-pane-head' }, el('strong', {}, 'Theme'),
        el('button', { type: 'button', class: 'rp-pane-x', title: 'Close', 'aria-label': 'Close the theme pane', onclick: toggleTheme }, '✕')),
      el('div', { class: 'rp-pane-body' }, themeRows(), tileRows()));
  }
  // The page's tiles: each one's title, and the filters it follows.
  function tileRows() {
    const tiles = shownTiles(), bar = barFilters();
    if (!tiles.length) return [];
    return [el('h3', { class: 'rp-pane-sub' }, 'Tiles on this page'), ...tiles.map((t, i) => {
      const name = String(t.title ?? '') || (t.kind === 'text' ? 'Text' : 'Untitled');
      const ignored = new Set(Array.isArray(t.ignore) ? t.ignore : []);
      return el('div', { class: 'rp-pane-tile' },
        paneRow(name, el('label', { class: 'rp-pane-check' }, paneCheck(t.showTitle !== false, v => setTile(i, { showTitle: v ? undefined : false }),
          `Show the title of ${name}`), 'title'),
          paneSelect(t.titleSize ?? 'M', SIZES, v => setTile(i, { titleSize: v === 'M' ? undefined : v }), `Title size of ${name}`)),
        ...(t.kind === 'text' ? [] : bar.map(x => paneRow('', el('label', { class: 'rp-pane-check' },
          paneCheck(!ignored.has(x.field), v => setTile(i, { ignore: v ? [...ignored].filter(k => k !== x.field) : [...ignored, x.field] }),
            `${name} follows the filter on ${fieldName(x.field)}`), `follows ${fieldName(x.field)}`)))));
    })];
  }
  // A tile's own keys changed by `patch` (undefined, or an empty list: taken out); saved, and the page drawn again.
  const setTile = (i, patch) => inTurn(async () => {
    try {
      await saveReport(p => {
        if (!p.tiles[i]) throw new Error('the tile is no longer on the report');
        return { ...p, tiles: p.tiles.map((t, j) => {
          if (j !== i) return t;
          const next = { ...t, ...patch };
          for (const [k, v] of Object.entries(patch)) if (v === undefined || (Array.isArray(v) && !v.length)) delete next[k];
          return next;
        }) };
      });
    } catch (e) {
      setStatus(`Theme: ${e.message}`, 'error');
    }
    if (!destroyed) drawReportPage();
  });
  const PALETTE_NAMES = [['studio', 'Studio'], ['ocean', 'Ocean'], ['warm', 'Warm'], ['mono', 'Mono']];
  function themeRows() {
    const theme = shownReport?.spec?.theme ?? {};
    const name = `rp-palette-${Math.random().toString(36).slice(2, 8)}`;
    // The whole look at once: Studio (the editor's colours, or the background picked below), or a style of its own.
    const style = styleOf(theme);
    const styles = el('div', { class: 'subtabs', role: 'group', 'aria-label': 'Style' }, [['studio', 'Studio'], ...Object.entries(STYLES).map(([k, s]) => [k, s.name])].map(([k, t]) =>
      el('button', { type: 'button', class: `subtab${(style ?? 'studio') === k ? ' active' : ''}`, 'aria-pressed': String((style ?? 'studio') === k),
        onclick: () => setTheme({ style: k === 'studio' ? undefined : k }) }, t)));
    // A style's own colours come first, and are the ones in use until another is picked.
    const own = style ?? 'studio';
    const colours = [...(style ? [[style, STYLES[style].name]] : []), ...PALETTE_NAMES].map(([k, t]) => {
      const radio = el('input', { type: 'radio', name, value: k, checked: (theme.palette ?? own) === k });
      radio.addEventListener('change', () => setTheme({ palette: k === own ? undefined : k }));
      return el('label', { class: 'rp-pane-palette' }, radio, el('span', {}, t),
        el('span', { class: 'rp-pane-chips', 'aria-hidden': 'true' }, PALETTES[k].slice(0, 6).map(c => el('i', { style: `background:${c}` }))));
    });
    const size = theme.textSize ?? 'M';
    const sizes = el('div', { class: 'subtabs', role: 'group', 'aria-label': 'Text size' }, SIZES.map(([k, t]) =>
      el('button', { type: 'button', class: `subtab${size === k ? ' active' : ''}`, 'aria-pressed': String(size === k),
        onclick: () => setTheme({ textSize: k === 'M' ? undefined : k }) }, t)));
    const bg = BACKGROUNDS.some(([k]) => k === theme.background) ? theme.background : 'editor';
    const backgrounds = el('div', { class: 'subtabs', role: 'group', 'aria-label': 'Background' }, BACKGROUNDS.map(([k, t]) =>
      el('button', { type: 'button', class: `subtab${bg === k ? ' active' : ''}`, 'aria-pressed': String(bg === k),
        title: k === 'editor' ? "The editor's colours, whatever its theme" : `The Report's own ${k} colours, in any editor theme`,
        onclick: () => setTheme({ background: k === 'editor' ? undefined : k }) }, t)));
    return [paneRow('Style', styles), ...(style ? [] : [paneRow('Background', backgrounds)]), paneRow('Colours', el('div', { class: 'rp-pane-palettes' }, colours)), paneRow('Text size', sizes), ...valueColourRows(theme),
      el('p', { class: 'rp-say' }, "Every page. A tile's own colours win over the Report's.")];
  }
  // Colours by value: a column's values, each given a colour that every tile draws it in.
  let colourColumn = null;
  function valueColourRows(theme) {
    const cols = reportFields().tables.flatMap(t => t.columns.filter(c => c.type === 'text').map(c => [c.id, `${t.name} › ${c.name}`]));
    const pick = paneSelect(colourColumn ?? '', [['', 'Pick a column'], ...cols], v => { colourColumn = v || null; drawTheme(); }, 'Column whose values get colours');
    const list = el('div', { class: 'rp-pane-values' });
    if (colourColumn) {
      list.append(el('p', { class: 'rp-say' }, 'Reading values…'));
      valuesOf(colourColumn, { top: 60 }).then(values => {
        const set = theme.colors ?? {};
        list.replaceChildren(...values.filter(v => v != null).map((v, i) => el('label', { class: 'rp-pane-swatch' },
          paneColour(set[String(v)] ?? PALETTE[i % PALETTE.length], c => setTheme({ colors: { ...theme.colors, [String(v)]: c } }), `Colour of ${v}`), String(v))));
      }, e => list.replaceChildren(el('p', { class: 'rp-say error' }, e.message)));
    }
    return [paneRow('Value colours', pick,
      theme.colors ? el('button', { type: 'button', class: 'rp-pane-reset', onclick: () => setTheme({ colors: undefined }) }, 'Reset') : null), list];
  }
  // The report's theme changed: saved, and the page drawn again in it.
  const setTitle = title => inTurn(async () => {
    try { await saveSpec(pages => pages, { title: title || undefined }); }
    catch (e) { setStatus(`Title: ${e.message}`, 'error'); }
    if (!destroyed) drawTop();
  });
  const setTheme = patch => inTurn(async () => {
    const theme = cleanFormat({ ...(shownReport?.spec?.theme ?? {}), ...patch });
    try { await saveSpec(pages => pages, { theme: Object.keys(theme).length ? theme : undefined }); }
    catch (e) { setStatus(`Theme: ${e.message}`, 'error'); }
    if (!destroyed) drawReportPage();
  });

  // --- The pages' names, over the tiles: a click shows one. A host that saves the Report: a
  // double-click renames one, its ✕ deletes it (asked first when it has tiles), dragged it moves,
  // and + adds one. A Report that only reads shows the names only when it has two pages or more.
  // Each page's name beside its tab: while a page is renamed, an input is in the tab in its place.
  let pageTabs = [], pageNames = [];
  function drawStrip() {
    const saves = !!ctx.report.save;
    pageStrip.hidden = !saves && shownPages.length < 2;
    pageNames = [];
    pageTabs = shownPages.map((p, i) => {
      const name = el('button', { type: 'button', class: 'rp-page-name', role: 'tab',
        ...(saves ? { title: 'Double-click to rename, drag to move' } : {}),
        onclick: () => { if (i !== reportAt) showReportPage(i); },
        onkeydown: e => {
          const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
          if (!k) return;
          e.preventDefault();
          const next = (i + k + shownPages.length) % shownPages.length;
          showReportPage(next);
          pageNames[next].focus();
        } }, p.name);
      pageNames.push(name);
      if (saves) name.addEventListener('dblclick', () => renamePageIn(i, name));
      const tab = el('div', { class: 'rp-page', 'data-page': i, draggable: saves ? 'true' : null }, name,
        saves && shownPages.length > 1 ? el('button', { type: 'button', class: 'rp-page-x', title: 'Delete this page',
          'aria-label': `Delete the page ${p.name}`, onclick: () => askDelete(i) }, '✕') : null);
      if (saves) {
        tab.addEventListener('dragstart', e => { e.dataTransfer.setData('text/x-report-page', String(i)); e.dataTransfer.effectAllowed = 'move'; });
        tab.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/x-report-page')) { e.preventDefault(); tab.classList.add('rp-drop'); } });
        tab.addEventListener('dragleave', () => tab.classList.remove('rp-drop'));
        tab.addEventListener('drop', e => {
          tab.classList.remove('rp-drop');
          const from = Number(e.dataTransfer.getData('text/x-report-page'));
          if (Number.isInteger(from) && from !== i) { e.preventDefault(); movePage(from, i); }
        });
      }
      return tab;
    });
    pageStrip.replaceChildren(el('div', { class: 'rp-page-tabs', role: 'tablist', 'aria-label': 'Report pages' }, pageTabs),
      saves ? el('button', { type: 'button', class: 'rp-page-add', title: 'Add a page', 'aria-label': 'Add a page', onclick: () => addPage() }, '+') : null);
    if (renameNext != null && pageNames[renameNext]) renamePageIn(renameNext, pageNames[renameNext]);
    renameNext = null;
  }
  function markStrip() {
    pageTabs.forEach((t, k) => {
      const on = k === reportAt, name = pageNames[k];
      t.classList.toggle('active', on);
      name.setAttribute('aria-selected', String(on));
      name.tabIndex = on ? 0 : -1;
    });
  }
  // A dragged tile's grip at (x, y): the other page whose name is under it, marked; null (and
  // nothing marked) when there is none, or x is null.
  function pageUnder(x, y) {
    const tab = x == null ? null : document.elementFromPoint(x, y)?.closest?.('.rp-page');
    const k = tab && pageStrip.contains(tab) ? Number(tab.dataset.page) : null;
    const to = k != null && k !== reportAt ? k : null;
    pageTabs.forEach((t, j) => t.classList.toggle('rp-drop', j === to));
    return to;
  }
  // A page's name, typed in its place: Enter or leaving it keeps it, Esc puts it back.
  function renamePageIn(i, name) {
    const was = shownPages[i].name;
    const input = el('input', { type: 'text', class: 'rp-page-rename', value: was, 'aria-label': 'Page name', size: Math.max(6, was.length) });
    let done = false;
    const end = keep => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      input.replaceWith(name);
      if (keep && next && next !== was) { name.textContent = next; renamePage(i, next); }
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); end(true); }
      else if (e.key === 'Escape') { e.preventDefault(); end(false); }
    });
    input.addEventListener('blur', () => end(true));
    name.replaceWith(input);
    input.focus();
    input.select();
  }
  // A page's ✕: an empty page goes; one with tiles asks first, beside the names.
  function askDelete(i) {
    const n = Array.isArray(shownPages[i]?.tiles) ? shownPages[i].tiles.length : 0;
    if (!n) { deletePage(i); return; }
    pageStrip.querySelector('.rp-page-ask')?.remove();
    const ask = el('div', { class: 'rp-page-ask', role: 'alertdialog', 'aria-label': 'Delete the page' },
      el('span', {}, `Delete "${shownPages[i].name}" and its ${n === 1 ? 'tile' : `${n} tiles`}?`),
      btn('Delete', () => { ask.remove(); deletePage(i); }, true), btn('Cancel', () => ask.remove()));
    pageStrip.append(ask);
    ask.querySelector('button').focus();
  }

  // Every save, one after another: each writes over the one before, by the stamp it answered
  // (two quick moves would otherwise both write over the first stamp, and the second be refused).
  let saving = Promise.resolve();
  const inTurn = work => (saving = saving.then(work, work));
  // `edit(pages)`: the pages to save, from those on screen (else read, when the Report was never
  // drawn), each page's tiles a list, saved over them as pages: refused when they changed since,
  // by a person or an agent.
  // `extra`: the report's own keys beside its pages (its theme), set, or taken out when undefined.
  async function saveSpec(edit, extra = {}) {
    const base = shownReport ?? await ctx.report.load();
    const pages = edit(reportPages(base.spec).map(p => ({ ...p, tiles: Array.isArray(p.tiles) ? p.tiles : [] })));
    const spec = withPages(base.spec, pages);
    for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete spec[k]; else spec[k] = v; }
    const saved = await ctx.report.save(spec, base.stamp ?? null);
    shownReport = { spec, stamp: saved?.stamp ?? null };
    shownPages = reportPages(spec);
    // So the look every few seconds does not draw again what is on screen.
    reportStamp = shownReport.stamp;
    return spec;
  }
  // `edit(page)`: page `at` (the one on screen), { name, tiles }, as it is to be saved.
  const saveReport = (edit, at = reportAt) => saveSpec(pages => {
    if (!pages[at]) throw new Error('the page is no longer on the report');
    return pages.map((p, k) => (k === at ? edit(p) : p));
  });

  // + : a page after the others, on screen, its name ready to rename.
  const addPage = () => inTurn(async () => {
    let at = null;
    try {
      await saveSpec(pages => { at = pages.length; return [...pages, { name: newPageName(pages), tiles: [] }]; });
    } catch (e) {
      at = null;
      setStatus(`Add a page: ${e.message}`, 'error');
    }
    if (at != null) { reportAt = at; renameNext = at; }
    if (!destroyed) drawReportPage();
  });
  // A page's name, typed in its place (drawn already): only saved, drawn again when refused.
  const renamePage = (i, name) => inTurn(async () => {
    try { await saveReport(p => ({ ...p, name }), i); }
    catch (e) {
      setStatus(`Rename the page: ${e.message}`, 'error');
      if (!destroyed) drawReportPage();
    }
  });
  const deletePage = i => inTurn(async () => {
    const name = shownPages[i]?.name;
    try {
      await saveSpec(pages => {
        if (!pages[i] || pages.length < 2) throw new Error('a report keeps one page at least');
        return pages.filter((_, k) => k !== i);
      });
      if (reportAt > i || reportAt >= shownPages.length) reportAt = Math.max(0, reportAt - 1);
      setStatus(`Deleted the page "${name}".`, 'ok');
    } catch (e) {
      setStatus(`Delete the page: ${e.message}`, 'error');
    }
    if (!destroyed) drawReportPage();
  });
  // A name dragged onto another: the page goes where that one is, the page on screen stays on screen.
  const movePage = (from, to) => inTurn(async () => {
    try {
      const order = shownPages.map((_, k) => k);
      order.splice(to, 0, ...order.splice(from, 1));
      await saveSpec(pages => {
        if (!pages[from] || !pages[to]) throw new Error('the page is no longer on the report');
        return order.map(k => pages[k]);
      });
      reportAt = order.indexOf(reportAt);
    } catch (e) {
      setStatus(`Move the page: ${e.message}`, 'error');
    }
    if (!destroyed) drawReportPage();
  });
  // A tile's grip dropped on another page's name: the tile goes there, as big as it was, in the
  // first place it fits; the page on screen stays.
  const tileToPage = (i, to) => inTurn(async () => {
    const tile = shownTiles()[i], name = shownPages[to]?.name;
    try {
      await saveSpec(pages => {
        const from = pages[reportAt];
        if (!from?.tiles[i] || !pages[to]) throw new Error('the tile or the page is no longer on the report');
        const { layout, size: _, ...moved } = from.tiles[i];
        if (layout?.w && layout?.h) moved.layout = { w: layout.w, h: layout.h };
        return pages.map((p, k) => (k === reportAt ? { ...p, tiles: p.tiles.filter((_, j) => j !== i) }
          : k === to ? { ...p, tiles: [...p.tiles, moved] } : p));
      });
      setStatus(`Moved "${tile?.title || 'the tile'}" to the page ${name}.`, 'ok');
    } catch (e) {
      setStatus(`Move the tile: ${e.message}`, 'error');
    }
    if (!destroyed) drawReportPage();
  });
  // Add text: an empty text tile after this page's own, written in by a double-click on it.
  const addText = () => inTurn(async () => {
    await saveReport(p => ({ ...p, tiles: [...p.tiles, { title: '', kind: 'text', text: '' }] }));
    if (!destroyed) drawReportPage();
    return 'Added a text tile: double-click it to write.';
  });
  // A text tile's Markdown, typed in its place (report.js drew it already): only saved, drawn again
  // when the save is refused.
  const setText = (i, text) => inTurn(async () => {
    try {
      await saveReport(p => {
        if (!p.tiles[i]) throw new Error('the tile is no longer on the report');
        return { ...p, tiles: p.tiles.map((t, j) => (j === i ? { ...t, text } : t)) };
      });
    } catch (e) {
      setStatus(`Text: ${e.message}`, 'error');
      if (!destroyed) drawReportPage();
    }
  });
  // The ✕ on a tile: the tiles without it, and drawn again (their answers are kept: run()).
  const removeTile = i => inTurn(async () => {
    const tile = shownTiles()[i];
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
    const tile = shownTiles()[i];
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
  // A tile's title, or its subtitle (`key`), typed in its place (report.js drew it already): only
  // saved, and drawn again when the save is refused. A subtitle left empty is none.
  const renameTile = (i, text, key = 'title') => inTurn(async () => {
    try {
      await saveReport(spec => {
        if (!spec.tiles[i]) throw new Error('the tile is no longer on the report');
        return { ...spec, tiles: spec.tiles.map((t, j) => {
          if (j !== i) return t;
          const { [key]: _, ...rest } = t;
          return key === 'subtitle' && !text ? rest : { ...t, [key]: text };
        }) };
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
    const tile = shownTiles()[i];
    if (tile?.kind !== 'pivot' || !tile.pivot) return;
    show('pivot');
    await openExplorer();
    if (!explorer || destroyed) return;
    await explorer.ready;
    const title = String(tile.title ?? '');
    const own = (() => { try { return pivotTitle({ rows: [], cols: [], values: [], ...tile.pivot }); } catch { return null; } })();
    editing = { index: i, page: reportAt, title, auto: title === own, before: editing?.before ?? explorer.state() };
    explorer.setState(tile.pivot);
    titleBox.value = title;
    if (planMode) closePlan();
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
      }, editing.page);
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
    reportAt = editing.page;
    editing = null;
    explorer?.setState(before);
    if (saved) reportChanged = true;
    show('report');
  }
  // Add to report: the shelves on screen, as a pivot tile after the tiles of the page last on screen.
  // Read first: the Report may have changed, or never been drawn, since.
  const addToReport = () => inTurn(async () => {
    const state = explorer?.state();
    if (!state || !explorer.query()) throw new Error('put a field on the shelves first');
    const title = pivotTitle(state);
    shownReport = await ctx.report.load();
    shownPages = reportPages(shownReport.spec);
    reportAt = Math.max(0, Math.min(reportAt, shownPages.length - 1));
    await saveReport(spec => ({ ...spec, tiles: [...spec.tiles, { title, kind: 'pivot', pivot: state }] }));
    if (page === 'report') drawReportPage(); else reportChanged = true;
    return `Added "${title}" to ${shownPages.length > 1 ? `the page ${shownPages[reportAt].name}` : 'the report'}.`;
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
  if (pages.some(([k]) => k === 'model')) renderModel(modelPage, ctx.tmsl, { title: `Semantic model ${ctx.name}`, openTable: ctx.openTable });
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
      if (destroyed) return;
      if (echarts) {
        registerChartTheme(echarts, css);
        for (const [box, c] of charts) { resized.unobserve(box); c.dispose(); }
        charts.clear();
        explorer?.redraw();
      }
      // The Report's tiles too, each drawn again in the theme (reportEcharts registers it).
      if (ctx.report && reportSeq && shownReport) barChanged();
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
      mapReady,
      loadState: () => ctx.loadState(ctx.stateKey ?? `explore.${ctx.name}`),
      saveState: s => ctx.saveState(ctx.stateKey ?? `explore.${ctx.name}`, s),
    });
  }

  // --- Show plan: in place of the view, the plan of the query its shelves make: the profile
  // (EXPLAIN ANALYZE, which runs the query once more) and the tree. Visual has no SQL box: its
  // query is always the shelves' (a JSON visual query, the SQL made from it behind the scenes).
  let planMode = false;
  function openPlan() {
    const q = explorer?.query()?.sql;
    if (!q) { setStatus('Put a field on the shelves first', 'error'); return; }
    let sql;
    try { sql = compile(q); }
    catch (e) { setStatus(`Plan: ${e.message}`, 'error'); return; }
    planMode = true;
    planView.replaceChildren(createPlanView({
      profile: async () => (await run(profileSql(sql, { set: ctx.profileSet !== false }), { fresh: true })).rows[0]?.explain_value,
      tree: () => planTree(sql),
      colors: () => profileColors(css),
      elapsed,
    }));
    pivotPage.hidden = true;
    planPage.hidden = false;
    planToggle.textContent = 'Show visual';
  }
  function closePlan() {
    planMode = false;
    planView.replaceChildren();
    planPage.hidden = true;
    pivotPage.hidden = page !== 'pivot';
    planToggle.textContent = 'Show plan';
    explorer?.redraw();   // the chart takes its box's size again
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

  // --- Download CSV: the shelves' query, all its rows ---
  async function download() {
    const base = explorer?.query({ cap: 0, totals: false })?.sql;
    if (!base) { setStatus('Put a field on the shelves first', 'error'); return; }
    csvBtn.disabled = true;
    csvBtn.textContent = 'Exporting…';
    try {
      // Every column as DuckDB prints it: a DATE, TIMESTAMP or DECIMAL would otherwise be its raw number.
      const res = await run(`SELECT COLUMNS(*)::VARCHAR FROM (\n${compile(base)}\n)`, { fresh: true });
      const text = toCsv(res.fields, res.rows, { eol: '\n' }) + '\n';
      const saved = await ctx.saveText(`${ctx.name}.csv`, text);
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
      dropPages();
      closeBarPop();
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
