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
// Semantic Model (a model file only) and Open in Excel at the right; Visual's Show SQL, Download CSV and Add to report; the Report's Add
// text and Export to Fabric, which publishes the Report as a Fabric app.
// The same file in the panel and in Export to Fabric's app: the host says how a model's SQL is compiled
// and run, and where ECharts comes from (`ctx`); nothing here knows the engine.
// =============================================================================

import { escapeHtml, toCsv } from '../paths.js';
import { renderModel } from './model.js';
import { el } from './dom.js';
import { createExplorer, pivotTitle, modelFields, valuesSql } from './explore.js';
import { compileModelSql } from './query.js';
import { createPlanView, profileSql, elapsed, profileColors } from './profile.js';
import { PALETTE, PALETTES, registerChartTheme } from './theme.js';
import { prettyModelText, extensionVendors, foreignDialects } from './pretty.js';
import { drawReport, reportPages, withPages, newPageName, pickWhere, NUMBER_STYLES } from './report.js';

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
//   worldMap()       (optional) the world's outline, a GeoJSON (a promise): what a map draws over
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
  const textBtn = ctx.report?.save ? hostBtn('Add text', 'Adding…', () => addText(), 'A text tile on this page: headings, bold, links and lists') : null;
  // Each page's buttons, at the right of the bar: Visual's, the Report's, the Model's.
  const actions = el('div', { class: 'explore-actions', hidden: true },
    ...(editBtn ? [editBtn, closeBtn] : [sqlToggle, csvBtn, addBtn]));
  const reportActions = exportBtn || textBtn ? el('div', { class: 'explore-actions', hidden: true }, textBtn, exportBtn) : null;
  // The Report: its pages' names (reportStrip), then a page's tiles, each page drawn once it is shown.
  const pageStrip = el('div', { class: 'rp-pages', hidden: true });
  const pageHost = el('div', { class: 'rp-page-host' });
  // A tile's 🖌 opens the format pane at the right of the tiles (formatting, below).
  const formatPane = el('aside', { class: 'rp-pane', hidden: true, 'aria-label': 'Format' });
  // The report's filter bar, over its pages' names (drawBar, below).
  const filterBar = el('div', { class: 'rp-bar', hidden: true });
  const reportPage = el('div', { class: 'report-page', hidden: true }, filterBar, pageStrip, el('div', { class: 'rp-work' }, pageHost, formatPane));
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
    pivotPage.hidden = p !== 'pivot' || sqlMode;
    editStrip.hidden = !editing || p !== 'pivot';
    actions.hidden = p !== 'pivot';
    if (reportActions) reportActions.hidden = p !== 'report';
    if (p === 'pivot') openExplorer();
  }

  // --- Report: the host's pages (ctx.report.load), drawn; drawn again when they change ---
  // Its SQL says FROM model, whatever the model is called here. One page on screen (reportAt);
  // each page shown is drawn once and kept, hidden, with its picks, until the Report is drawn again.
  let reportStamp = null, reportTimer = null, reportSeq = 0, reportAt = 0;
  const pageViews = new Map();   // page index -> { box, view }
  // A tile's query, shared while it runs: the Report drawn again (its file changed) asks the same
  // SQL again, and waits on the run already going rather than starting a second.
  const reportRuns = new Map();   // sql -> its run, while it runs
  let reportLeft = false, reportWaiters = [];
  const reportSql = text => {
    const sql = compileModelSql(ctx.compiler, text, 'model');
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
  const reportEcharts = async () => { const ec = await ctx.echarts(); registerChartTheme(ec, css); return ec; };
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
      dropPages();
      pageHost.replaceChildren();
      reportAt = Math.max(0, Math.min(reportAt, shownPages.length - 1));
      drawBar();
      drawStrip();
      showReportPage(reportAt);
      if (formatting) drawPane();
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
    // The pane is on a tile of the page it was opened on.
    if (formatting && formatting.page !== i) closeFormat();
    else if (formatting) pageViews.get(i).view.mark(formatting.index);
    markStrip();
    if (addBtn) addBtn.title = `This visual, as it is, as a tile of ${shownPages.length > 1 ? `the page ${shownPages[i].name}` : 'the Report'}`;
    wakeReport();
  }
  function pageCtx(i) {
    const saves = !!ctx.report.save;
    return { sql: reportSql, echarts: reportEcharts, shown: () => reportShown(i), leftWhileRunning,
             cancel: ctx.cancel, model: ctx.tmsl, css,
             remove: saves ? removeTile : undefined, layout: saves ? layoutTiles : undefined,
             duplicate: saves ? duplicateTile : undefined, rename: saves ? renameTile : undefined,
             edit: saves ? editTile : undefined, setText: saves ? setText : undefined,
             toPage: saves && shownPages.length > 1 ? { at: pageUnder, drop: tileToPage } : undefined,
             format: saves ? openFormat : undefined,
             where: barWhere, mapReady,
             // The pane's colours follow the series the tile draws.
             drawn: k => { if (formatting?.tab === 'tile' && formatting.page === i && formatting.index === k && seriesChanged()) drawPane(); } };
  }

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
    const ignored = new Set(Array.isArray(tile?.format?.ignore) ? tile.format.ignore : []);
    return barFilters().filter(x => !ignored.has(x.field) && barPicks.has(x.field)).flatMap(x => pickWhere(x.field, barPicks.get(x.field)));
  }
  const barValues = new Map();  // field (and 'latest:'+field) -> a promise of its values
  const valuesOf = (id, opts = {}) => {
    const key = `${opts.desc ? 'latest' : ''}:${opts.top ?? ''}:${id}`;
    if (!barValues.has(key)) {
      barValues.set(key, reportSql(valuesSql(reportFields(), id, opts)).then(r => r.rows.map(x => x.v))
        .catch(e => { barValues.delete(key); throw e; }));
    }
    return barValues.get(key);
  };
  // The bar's picks changed: every page drawn again with them, its tiles' picks gone.
  function barChanged() {
    dropPages();
    pageHost.replaceChildren();
    showReportPage(reportAt);
    if (formatting) drawPane();
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

  // --- The format pane, a tile's 🖌: its Tile tab sets what the tile shows (its `format`), its
  // Report tab the report's theme. A change is drawn at once (report.js restyle; a theme draws
  // the page again) and saved, one after another; ✕ closes it. On the page it was opened on only.
  let formatting = null;   // { page, index, tab: 'tile' | 'report', format, series }
  const viewOf = () => pageViews.get(reportAt)?.view;
  function openFormat(i) {
    formatting = { page: reportAt, index: i, tab: 'tile', format: shownTiles()[i]?.format ?? {}, series: '' };
    viewOf()?.mark(i);
    drawPane();
  }
  function closeFormat() {
    if (!formatting) return;
    formatting = null;
    for (const { view } of pageViews.values()) view.mark(-1);
    formatPane.hidden = true;
    formatPane.replaceChildren();
  }
  function seriesChanged() {
    const names = JSON.stringify(viewOf()?.about(formatting.index)?.series ?? []);
    return names !== formatting.series;
  }
  // A format with nothing left unset: no undefined key, no empty list of colours, numbers or colours by value.
  function cleanFormat(f) {
    const out = {};
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) { if (v.length) out[k] = v; continue; }
      if (k === 'measures') {
        const kept = Object.fromEntries(Object.entries(v).map(([m, d]) => [m, cleanFormat(d ?? {})]).filter(([, d]) => Object.keys(d).length));
        if (Object.keys(kept).length) out[k] = kept;
        continue;
      }
      if (typeof v === 'object') {
        const kept = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== null && x !== ''));
        if (Object.keys(kept).length) out[k] = kept;
      } else out[k] = v;
    }
    return out;
  }
  // The pane's controls, each a row: its label, then its controls.
  const paneRow = (label, ...kids) => el('div', { class: 'rp-pane-row' }, el('span', { class: 'rp-pane-label' }, label),
    el('div', { class: 'rp-pane-ctl' }, ...kids));
  const paneSelect = (value, options, set, label) => {
    const s = el('select', { 'aria-label': label }, options.map(([v, t]) => el('option', { value: v, selected: v === value }, t)));
    s.addEventListener('change', () => set(s.value));
    return s;
  };
  const paneCheck = (on, set, label) => {
    const c = el('input', { type: 'checkbox', checked: !!on, 'aria-label': label });
    c.addEventListener('change', () => set(c.checked));
    return c;
  };
  const paneInput = (value, set, label, type = 'text') => {
    const i = el('input', { type, class: 'rp-pane-input', value: value ?? '', 'aria-label': label });
    i.addEventListener('change', () => set(i.value));
    return i;
  };
  const hex = c => (/^#[0-9a-f]{6}$/i.test(c ?? '') ? c : '#888888');
  const paneColour = (value, set, label) => {
    const i = el('input', { type: 'color', class: 'rp-pane-colour', value: hex(value), 'aria-label': label, title: label });
    i.addEventListener('change', () => set(i.value));
    return i;
  };
  const SIZES = [['S', 'S'], ['M', 'M'], ['L', 'L']];
  function drawPane() {
    if (!formatting) return;
    const tile = shownTiles()[formatting.index];
    if (formatting.page !== reportAt || !tile) { closeFormat(); return; }
    formatPane.hidden = false;
    const tab = (key, label) => el('button', { type: 'button', class: `subtab${formatting.tab === key ? ' active' : ''}`, role: 'tab',
      'aria-selected': String(formatting.tab === key), onclick: () => { formatting.tab = key; drawPane(); } }, label);
    formatPane.replaceChildren(
      el('div', { class: 'rp-pane-head' }, el('div', { class: 'subtabs', role: 'tablist', 'aria-label': 'Format' }, tab('tile', 'Tile'), tab('report', 'Report')),
        el('button', { type: 'button', class: 'rp-pane-x', title: 'Close', 'aria-label': 'Close the format pane', onclick: closeFormat }, '✕')),
      el('div', { class: 'rp-pane-body' }, formatting.tab === 'tile' ? tileRows() : themeRows()));
  }
  function tileRows() {
    const f = formatting.format;
    const about = viewOf()?.about(formatting.index) ?? { kind: 'chart', series: [], numbers: [] };
    formatting.series = JSON.stringify(about.series);
    const set = patch => setFormat(patch);
    const rows = [paneRow('Title', el('label', { class: 'rp-pane-check' }, paneCheck(f.title !== false, v => set({ title: v ? undefined : false }), 'Show the title'), 'show'),
      el('span', { class: 'rp-pane-label' }, 'Size'), paneSelect(f.titleSize ?? 'M', SIZES, v => set({ titleSize: v === 'M' ? undefined : v }), 'Title size'))];
    if (about.kind === 'chart') {
      if (about.series.length) {
        rows.push(paneRow('Colours', ...about.series.map(s => el('label', { class: 'rp-pane-swatch' },
          paneColour(f.colors?.[s.name] ?? s.color, v => set({ colors: { ...f.colors, [s.name]: v } }), `Colour of ${s.name}`), s.name)),
          f.colors ? el('button', { type: 'button', class: 'rp-pane-reset', onclick: () => { set({ colors: undefined }); drawPane(); } }, 'Reset') : null));
      }
      rows.push(paneRow('Data labels', paneCheck(f.labels, v => set({ labels: v || undefined }), 'Data labels')),
        paneRow('Legend', paneSelect(f.legend ?? 'auto', [['auto', 'Auto'], ['top', 'Top'], ['bottom', 'Bottom'], ['right', 'Right'], ['off', 'Off']],
          v => set({ legend: v === 'auto' ? undefined : v }), 'Legend')),
        paneRow('X axis title', paneInput(f.xTitle, v => set({ xTitle: v.trim() || undefined }), 'X axis title')),
        paneRow('Y axis title', paneInput(f.yTitle, v => set({ yTitle: v.trim() || undefined }), 'Y axis title')),
        paneRow('Y from', paneInput(f.yMin, v => set({ yMin: v === '' ? undefined : Number(v) }), 'Y axis from', 'number'),
          el('span', { class: 'rp-pane-label' }, 'to'), paneInput(f.yMax, v => set({ yMax: v === '' ? undefined : Number(v) }), 'Y axis to', 'number')),
        paneRow('Total line', paneCheck(f.totalLine, v => set({ totalLine: v || undefined }), 'Each measure\'s total as a line across')),
        paneRow('Highest point', paneCheck(f.maxLabel, v => set({ maxLabel: v || undefined }), 'Label the highest point')),
        paneRow('Zoom slider', paneCheck(f.zoom, v => set({ zoom: v || undefined }), 'A zoom slider under the chart')));
      // Several measures: one plot, each drawn as it says, on the left axis or the right one.
      if (about.numbers.length > 1) {
        const drawn = (n, patch) => set({ measures: { ...f.measures, [n]: { ...f.measures?.[n], ...patch } } });
        rows.push(el('h3', { class: 'rp-pane-sub' }, 'Measures in one plot'), ...about.numbers.map(n => paneRow(n,
          paneSelect(f.measures?.[n]?.as ?? 'auto', [['auto', 'As the chart'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'], ['dashed', 'Dashed line']],
            v => drawn(n, { as: v === 'auto' ? undefined : v }), `Draw ${n} as`),
          paneSelect(f.measures?.[n]?.axis ?? 'left', [['left', 'Left'], ['right', 'Right']], v => drawn(n, { axis: v === 'left' ? undefined : v }), `Axis of ${n}`))),
          f.measures ? el('button', { type: 'button', class: 'rp-pane-reset', onclick: () => { set({ measures: undefined }); drawPane(); } }, 'One plot each') : null);
      }
    }
    if (about.kind === 'table') {
      if (about.numbers.length) {
        rows.push(el('h3', { class: 'rp-pane-sub' }, 'Colour by value'), ...about.numbers.map(n => paneRow(n,
          paneSelect(f.byValue?.[n] ?? 'none', [['none', 'None'], ['background', 'Background'], ['bar', 'Bar']],
            v => set({ byValue: { ...f.byValue, [n]: v === 'none' ? undefined : v } }), `Colour ${n} by value`))));
      }
      rows.push(paneRow('Banded rows', paneCheck(f.banded, v => set({ banded: v || undefined }), 'Banded rows')));
    }
    if (about.kind === 'card') {
      rows.push(paneRow('Number size', paneSelect(f.figureSize ?? 'M', SIZES, v => set({ figureSize: v === 'M' ? undefined : v }), 'Number size')),
        paneRow('Colour', paneColour(f.figureColor ?? css('--text'), v => set({ figureColor: v }), 'Colour of the numbers'),
          f.figureColor ? el('button', { type: 'button', class: 'rp-pane-reset', onclick: () => { set({ figureColor: undefined }); drawPane(); } }, 'Reset') : null));
      // The change: a measure on Values shown under the figure as ▲ or ▼.
      if (about.numbers.length > 1) {
        rows.push(paneRow('Change', paneSelect(f.change ?? '', [['', 'None'], ...about.numbers.slice(1).map(n => [n, n])],
          v => set({ change: v || undefined }), 'The measure shown as the change')),
          paneRow('Good when', paneSelect(f.goodWhen ?? 'up', [['up', 'It goes up'], ['down', 'It goes down']],
            v => set({ goodWhen: v === 'up' ? undefined : v }), 'When the change is good')));
      }
    }
    if (about.kind !== 'slicer' && about.kind !== 'text' && about.numbers.length) {
      rows.push(el('h3', { class: 'rp-pane-sub' }, 'Numbers'), ...about.numbers.map(n => paneRow(n,
        paneSelect(f.numbers?.[n] ?? 'auto', NUMBER_STYLES.map(([k, t]) => [k, t]),
          v => set({ numbers: { ...f.numbers, [n]: v === 'auto' ? undefined : v } }), `Numbers of ${n}`))));
    }
    // The filter bar's filters this tile follows (all, unless it ignores some).
    const bar = barFilters();
    if (about.kind !== 'text' && bar.length) {
      const ignored = new Set(f.ignore ?? []);
      rows.push(el('h3', { class: 'rp-pane-sub' }, 'Follows the filters'), ...bar.map(x => paneRow(fieldName(x.field),
        paneCheck(!ignored.has(x.field), v => set({ ignore: v ? (f.ignore ?? []).filter(k => k !== x.field) : [...(f.ignore ?? []), x.field] }),
          `Follow the filter on ${fieldName(x.field)}`))));
    }
    return rows;
  }
  // A tile's format changed by `patch`: drawn at once, then saved; refused, the Report is drawn
  // again as it is now.
  function setFormat(patch) {
    if (!formatting) return;
    const { page, index } = formatting;
    const format = cleanFormat({ ...formatting.format, ...patch });
    const refilter = 'ignore' in patch;
    formatting.format = format;
    viewOf()?.restyle(index, format);
    inTurn(async () => {
      try {
        await saveReport(p => {
          if (!p.tiles[index]) throw new Error('the tile is no longer on the report');
          return { ...p, tiles: p.tiles.map((t, j) => {
            if (j !== index) return t;
            const { format: _, ...rest } = t;
            return Object.keys(format).length ? { ...rest, format } : rest;
          }) };
        }, page);
        if (refilter && !destroyed) barChanged();
      } catch (e) {
        setStatus(`Format: ${e.message}`, 'error');
        if (!destroyed) drawReportPage();
      }
    });
  }
  const PALETTE_NAMES = [['studio', 'Studio'], ['ocean', 'Ocean'], ['warm', 'Warm'], ['mono', 'Mono']];
  function themeRows() {
    const theme = shownReport?.spec?.theme ?? {};
    const name = `rp-palette-${Math.random().toString(36).slice(2, 8)}`;
    const colours = PALETTE_NAMES.map(([k, t]) => {
      const radio = el('input', { type: 'radio', name, value: k, checked: (theme.palette ?? 'studio') === k });
      radio.addEventListener('change', () => setTheme({ palette: k === 'studio' ? undefined : k }));
      return el('label', { class: 'rp-pane-palette' }, radio, el('span', {}, t),
        el('span', { class: 'rp-pane-chips', 'aria-hidden': 'true' }, PALETTES[k].slice(0, 6).map(c => el('i', { style: `background:${c}` }))));
    });
    const size = theme.textSize ?? 'M';
    const sizes = el('div', { class: 'subtabs', role: 'group', 'aria-label': 'Text size' }, SIZES.map(([k, t]) =>
      el('button', { type: 'button', class: `subtab${size === k ? ' active' : ''}`, 'aria-pressed': String(size === k),
        onclick: () => setTheme({ textSize: k === 'M' ? undefined : k }) }, t)));
    return [paneRow('Colours', el('div', { class: 'rp-pane-palettes' }, colours)), paneRow('Text size', sizes), ...valueColourRows(theme),
      el('p', { class: 'rp-say' }, "Every page. A tile's own colours win over the Report's.")];
  }
  // Colours by value: a column's values, each given a colour that every tile draws it in.
  let colourColumn = null;
  function valueColourRows(theme) {
    const cols = reportFields().tables.flatMap(t => t.columns.filter(c => c.type === 'text').map(c => [c.id, `${t.name} › ${c.name}`]));
    const pick = paneSelect(colourColumn ?? '', [['', 'Pick a column'], ...cols], v => { colourColumn = v || null; drawPane(); }, 'Column whose values get colours');
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
  const setTheme = patch => inTurn(async () => {
    const theme = cleanFormat({ ...(shownReport?.spec?.theme ?? {}), ...patch });
    try { await saveSpec(pages => pages, { theme: Object.keys(theme).length ? theme : undefined }); }
    catch (e) { setStatus(`Format: ${e.message}`, 'error'); }
    if (!destroyed) drawReportPage();
  });

  // --- The pages' names, over the tiles: a click shows one. A host that saves the Report: a
  // double-click renames one, its ✕ deletes it (asked first when it has tiles), dragged it moves,
  // and + adds one. A Report that only reads shows the names only when it has two pages or more.
  let pageTabs = [];
  function drawStrip() {
    const saves = !!ctx.report.save;
    pageStrip.hidden = !saves && shownPages.length < 2;
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
          pageTabs[next].querySelector('.rp-page-name').focus();
        } }, p.name);
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
    if (renameNext != null && pageTabs[renameNext]) renamePageIn(renameNext, pageTabs[renameNext].querySelector('.rp-page-name'));
    renameNext = null;
  }
  function markStrip() {
    pageTabs.forEach((t, k) => {
      const on = k === reportAt, name = t.querySelector('.rp-page-name');
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
    closeFormat();
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
    closeFormat();
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
    closeFormat();
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
    closeFormat();
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
  const layoutTiles = list => {
    // The tiles are in their new order on screen already: the pane follows its tile.
    if (formatting?.page === reportAt) formatting.index = list.findIndex(l => l.from === formatting.index);
    return layoutSave(list);
  };
  const layoutSave = list => inTurn(async () => {
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
