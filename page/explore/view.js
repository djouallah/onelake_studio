// =============================================================================
// explore/view.js — a semantic model's Explore: Model and Pivot
// =============================================================================
//   Model     the star of its tables and relationships, and what the model says of the
//             table picked (model.js)
//   Pivot     the model's fields dragged onto shelves, drawn as a pivot or a chart
//             (explore.js, ECharts). Its query is always its shelves', a JSON visual query whose
//             SQL is made behind the scenes: it has no SQL box. Show plan puts that query's
//             profile and plan tree in place of the view (profile.js). Download CSV writes its
//             rows.
// Model's Diagram | YAML (or BIM) shows the model drawn, or its file as written (pretty.js).
// The bar: the page tabs, then each page's own: Model's Keep offline, then Diagram | YAML, Save and Publish at
// the right; Pivot's Show plan and Download CSV.
// The host says how a model's SQL is compiled and run, and where ECharts comes from (`ctx`); nothing here
// knows the engine.
// =============================================================================

import { toCsv } from '../paths.js';
import { renderModel } from './model.js';
import { el } from './dom.js';
import { createExplorer, setRowCap } from './explore.js';
import { compileModelSql } from './query.js';
import { createPlanView, profileSql, elapsed, profileColors } from './profile.js';
import { PALETTE, registerChartTheme } from './theme.js';
import { prettyModelText, extensionVendors } from './pretty.js';

const PAGES = [['model', 'Model'], ['pivot', 'Pivot']];

// `ctx`:
//   name             the model's name: what SQL calls it (FROM <name>)
//   text, ext        (optional) the model's file and its extension: Model's Diagram | YAML switch
//   tmsl             the model, as model.js's tmslOf reads it
//   compiler         dax-sql's compiler over the model, with the host's tableSource and
//                    query.js's EXPLORE_CASTS
//   run(sql)         a compiled SQL's result: { fields, rows, numRows, truncated?, limit? }
//   prepare()        (optional) awaited before the shelves' query compiles: what the data says of the
//                    model, read once, which the compiler then uses
//   echarts()        ECharts (a promise)
//   worldMap()       (optional) the world's outline, a GeoJSON (a promise): what a map draws over
//   saveText(name, text)  a CSV saved: answers where (or null: dismissed)
//   saveFileText(text)    (optional) the model's own file written back, when it is one that can be: Save on YAML
//   loadState(key), saveState(key, s)  the shelves, between visits
//   setStatus(text, kind)  (optional) the host's status line
//   publishView()  (optional) a Fabric semantic view's Publish button, on the Model page: what to say after
//   fabricView       (optional) true for a Fabric semantic view: its YAML shows what Fabric's Publish refuses, in red
//   keepOffline      (optional) { state(), set(on) }: the Keep offline switch beside the tabs, every
//                    table of this model on this machine (core/models/modeldata.js); both answer what it shows:
//                    { on, say, tone, meter, tip, busy }
//   editSql(sql)     (optional) the Edit SQL button: the shelves' query, all its rows, handed
//                    to the host's own SQL editor, which runs it and saves its CSV, so Show plan
//                    and Download CSV are left out
//   plainSql         (optional) { from, measure(name) }: editSql's query as SQL over one table
//                    (explore.js's modelSql), else SQL over the model
//   close()          (optional) a Close button, after Edit SQL
//   pages            (optional) the pages shown, of 'model' and 'pivot' (default: both
//                    there are), in that order. One page: no page tabs.
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
  const pages = PAGES.filter(([k]) => !ctx.pages || ctx.pages.includes(k));
  const tabs = pages.map(([k, t], i) => el('button', { type: 'button', class: `subtab${i ? '' : ' active'}`, role: 'tab',
    'data-apage': k, 'aria-selected': String(!i), tabindex: i ? '-1' : '0' }, t));
  const planToggle = btn('Show plan', () => (planMode ? closePlan() : openPlan()));
  planToggle.title = "The plan of this pivot's query: its profile and its tree";
  const csvBtn = btn('Download CSV', download, true);
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
  // A Fabric semantic view's: Fabric's Publish of it (its TMDL and its model), as the tree's ▶ does it.
  const publishBtn = ctx.publishView
    ? hostBtn('Publish', 'Publishing…', ctx.publishView, "Fabric's Publish of this semantic view: its TMDL in SystemContext/, and its model") : null;
  const keepOffline = ctx.keepOffline ? offlineSwitch(ctx.keepOffline) : null;
  const editBtn = ctx.editSql ? btn('Edit SQL', () => {
    const sql = explorer?.query({ cap: 0, plain: ctx.plainSql ?? null })?.sql;
    if (sql) ctx.editSql(sql); else setStatus('Put a field on the shelves first', 'error');
  }, true) : null;
  if (editBtn) editBtn.title = 'This query in the SQL box, to take further by hand (the pivot is kept)';
  const closeBtn = ctx.close ? btn('Close', ctx.close) : null;
  // Each page's buttons, at the right of the bar: Pivot's, the Model's.
  const actions = el('div', { class: 'explore-actions', hidden: true },
    ...(editBtn ? [editBtn, closeBtn] : [planToggle, csvBtn]));
  const modelPage = el('div', { class: 'model-page' });
  const pivotPage = el('div', { class: 'explore-page', hidden: true });
  // Show plan: the plan of the shelves' query, in place of the view.
  const planView = el('div', { class: 'explore-plan' });
  const planPage = el('div', { class: 'explore-sql-page', hidden: true }, planView);

  // Model: the model drawn, or its file as written, by a switch named for the file's format.
  const viewTab = (label, asText) => el('button', { type: 'button', class: 'subtab', role: 'tab', onclick: () => showText(asText) }, label);
  const diagramTab = viewTab('Diagram', false), fileTab = viewTab(/^bim$/i.test(ctx.ext || '') ? 'BIM' : /^tmdl$/i.test(ctx.ext || '') ? 'TMDL' : 'YAML', true);
  const textPre = el('pre', { class: 'text-file', hidden: true });
  // A file that can be saved (ctx.saveFileText) is written in: a box over the coloured <pre>, its own text clear, the
  // <pre> coloured again as it is typed. Save writes it back.
  const editable = ctx.text != null && !!ctx.saveFileText;
  const textBox = editable ? el('textarea', { class: 'text-box', spellcheck: 'false', wrap: 'off', 'aria-label': `${ctx.name}'s file` }) : null;
  const textEdit = editable ? el('div', { class: 'text-edit', hidden: true }, el('div', { class: 'text-layer' }, textPre, textBox)) : null;
  if (editable) { textPre.hidden = false; textPre.setAttribute('aria-hidden', 'true'); }
  const saveBtn = editable ? btn('Save', () => saveFile(), true) : null;
  if (saveBtn) { saveBtn.title = 'Write this text back to the file (Ctrl+S)'; saveBtn.disabled = true; saveBtn.hidden = true; }
  // Over the file, when it has nonportable_extensions: what its amber lines are (pretty.js tk-ext).
  const ossie = ctx.text != null && !/^bim$/i.test(ctx.ext || '');
  const vendors = ossie ? extensionVendors(ctx.text) : [];
  const extName = `${vendors.length && vendors.every(v => v.toUpperCase() === 'POWER_BI') ? 'Power BI' : 'vendor'} extension`;
  const textNote = el('p', { class: 'text-file-note', hidden: true }, el('span', { class: 'swatch' }),
    `Amber: ${extName}, what Ossie has no field for`);
  // At the right of the bar, before Save and Publish. On the Model page only.
  const modelSwitch = ctx.text == null ? null
    : el('div', { class: 'subtabs model-switch', role: 'tablist', 'aria-label': 'How the model is shown' }, diagramTab, fileTab);
  const modelActions = modelSwitch || publishBtn
    ? el('div', { class: 'explore-actions', hidden: true }, modelSwitch, saveBtn, publishBtn) : null;
  const modelArea = el('div', { class: 'model-area' }, modelPage, textNote, textEdit || textPre);

  root.replaceChildren(
    el('div', { class: 'subtab-bar' },
      el('div', { class: 'subtabs', role: 'tablist', 'aria-label': 'Semantic model pages', hidden: pages.length < 2 }, tabs),
      keepOffline?.root,
      modelActions,
      actions),
    modelArea, pivotPage, planPage);

  for (const b of tabs) {
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus(); next.click();
    });
    b.addEventListener('click', () => show(b.dataset.apage));
  }
  let page = pages[0][0];
  function show(p) {
    page = p;
    for (const b of tabs) {
      const on = b.dataset.apage === p;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (planMode && p !== 'pivot') closePlan();
    modelArea.hidden = p !== 'model';
    if (keepOffline) keepOffline.root.hidden = p !== 'model';
    if (modelActions) modelActions.hidden = p !== 'model';
    pivotPage.hidden = p !== 'pivot' || planMode;
    actions.hidden = p !== 'pivot';
    if (p === 'pivot') openExplorer();
  }

  // The world's map, registered with ECharts the first time a map is drawn (the host's file).
  let mapP = null;
  const mapReady = () => (mapP ??= (async () => {
    const ec = await ctx.echarts();
    if (ec.getMap?.('world')) return;
    if (!ctx.worldMap) throw new Error('this window has no map of the world');
    ec.registerMap('world', await ctx.worldMap());
  })().catch(e => { mapP = null; throw e; }));

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
      if (editable) {
        textBox.value = ctx.text;
        colourBox();
      } else {
        const html = prettyModelText(ctx.text, ctx.ext, { publish: !!ctx.fabricView });
        if (html == null) textPre.textContent = ctx.text; else textPre.innerHTML = html;
      }
    }
    modelPage.hidden = on;
    if (editable) { textEdit.hidden = !on; saveBtn.hidden = !on; } else textPre.hidden = !on;
    textNote.hidden = !on || !vendors.length || !textPre.querySelector('.tk-ext');
  }

  // --- The file, written in (editable) ---
  // What the box holds, as the file was: a textarea's value has \n for every line end, so a file written with
  // \r\n is written back with them.
  const crlf = editable && /\r\n/.test(ctx.text);
  const original = editable ? String(ctx.text).replace(/\r\n?/g, '\n') : '';
  const changed = () => textBox.value !== original;
  // The <pre> under the box, as the box's text: coloured as written, up to a size whose colouring keeps up with
  // typing; past it, plain. A last empty line gets a line of its own, so the two stay one height.
  const LIVE_COLOUR_MAX = 512 * 1024;
  let colourTimer = null;
  function colourBox() {
    clearTimeout(colourTimer);
    const text = textBox.value;
    const html = prettyModelText(text, ctx.ext, { asIs: true, max: LIVE_COLOUR_MAX, publish: !!ctx.fabricView });
    if (html == null) textPre.textContent = text + '\n'; else textPre.innerHTML = html + '\n';
  }
  if (editable) {
    textBox.addEventListener('input', () => {
      // At once while it is quick; a big file's colours a moment after the typing stops.
      if (textBox.value.length < 64 * 1024) colourBox(); else { clearTimeout(colourTimer); colourTimer = setTimeout(colourBox, 150); }
      saveBtn.disabled = !changed();
    });
    let leaving = false;
    textBox.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
      else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Tab indents here, as in the SQL box, so Esc then Tab is how the keyboard leaves it.
        if (leaving) { leaving = false; return; }
        e.preventDefault();
        if (!document.execCommand('insertText', false, '  ')) textBox.setRangeText('  ', textBox.selectionStart, textBox.selectionEnd, 'end');
        textBox.dispatchEvent(new Event('input'));
      }
      leaving = e.key === 'Escape';
    });
  }
  // Save: the host checks it opens as a model, writes it, and opens the model again from it — this view goes.
  // One that doesn't open is not written, and stays here to be put right.
  let savingFile = false;
  async function saveFile() {
    if (!editable || savingFile || !changed()) return;
    savingFile = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await ctx.saveFileText(crlf ? textBox.value.replace(/\n/g, '\r\n') : textBox.value);
    } catch (e) {
      setStatus(`Not saved: ${e.message}`, 'error');
    } finally {
      savingFile = false;
      saveBtn.textContent = 'Save';
      saveBtn.disabled = !changed();
    }
  }
  showText(!!ctx.openOnText && ctx.text != null);

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
    });
  });
  themed.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  // Once, whoever asks first; asked again only after it failed.
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
      model: async () => ctx.tmsl,
      name: ctx.name,
      run: async text => { await ctx.prepare?.(); return (await run(compile(text))).rows; },
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

  // --- Show plan: in place of the view, the plan of the query its shelves make: its SQL, the profile
  // (EXPLAIN ANALYZE, which runs the query once more) and the tree. The SQL is shown, never written: the
  // model's SQL the shelves make (SELECT … FROM the model), and the SQL it compiles to. Pivot has no SQL box:
  // its query is always the shelves' (a JSON visual query, the SQL made from it behind the scenes).
  let planMode = false;
  function openPlan() {
    const q = explorer?.query()?.sql;
    if (!q) { setStatus('Put a field on the shelves first', 'error'); return; }
    let sql;
    try { sql = compile(q); }
    catch (e) { setStatus(`Plan: ${e.message}`, 'error'); return; }
    planMode = true;
    planView.replaceChildren(createPlanView({
      sql: [{ label: 'Model SQL', text: q }, { label: 'Compiled SQL', text: sql }],
      copy: ctx.copyText,
      profile: async () => (await run(profileSql(sql), { fresh: true })).rows[0]?.explain_value,
      tree: () => planTree(sql),
      colors: () => profileColors(css),
      elapsed,
    }));
    pivotPage.hidden = true;
    planPage.hidden = false;
    planToggle.textContent = 'Show pivot';
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
      await ctx.prepare?.();
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

  show(page);

  return {
    destroy() {
      destroyed = true;
      keepOffline?.destroy();
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
