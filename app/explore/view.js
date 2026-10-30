// =============================================================================
// explore/view.js — a semantic model's Explore: Model, Pivot and Logs
// =============================================================================
//   Model     the star of its tables and relationships, and what the model says of the
//             table picked (model.js)
//   Pivot     the model's fields dragged onto shelves, drawn as a pivot or a chart
//             (explore.js, ECharts). Show SQL swaps the pivot for its SQL in a box the user
//             edits (a SELECT … FROM <model> asks the model; any other SQL runs as written);
//             Show plan puts the query's profile and plan in place of the results
//             (profile.js). Download CSV writes the pivot's rows, or the box's.
//   Logs      what this session ran, with timings (logs.js, perflog.js)
// The same file in the panel and in Export to Fabric's app: the host says how a model's SQL is compiled
// and run, and where ECharts comes from (`ctx`); nothing here knows the engine.
// =============================================================================

import { escapeHtml, toCsv } from '../paths.js';
import { renderModel } from './model.js';
import { el } from './dom.js';
import { createExplorer } from './explore.js';
import { compileModelSql } from './query.js';
import { createPlanView, profileSql, elapsed, profileColors } from './profile.js';
import { mountLogs } from './logs.js';
import { perf } from './perflog.js';
import { PALETTE, registerChartTheme } from './theme.js';

const PAGES = [['model', 'Model'], ['pivot', 'Pivot'], ['logs', 'Logs']];
const PREVIEW_ROWS = 500;

// `ctx`:
//   name             the model's name: what SQL calls it (FROM <name>)
//   title            what the bar says of it (its file); none: nothing (the host's bar says it)
//   tmsl             the model, as model.js's tmslOf reads it
//   compiler         dax-sql's compiler over the model, with the host's tableSource and
//                    query.js's EXPLORE_CASTS
//   run(sql, dax)    a compiled SQL's result (`dax`: what it stands for, for a host that logs): { fields, rows, numRows, truncated?, limit? }
//   echarts()        ECharts (a promise)
//   saveText(name, text)  a CSV saved: answers where (or null: dismissed)
//   loadState(key), saveState(key, s)  the shelves, between visits
//   setStatus(text, kind)  (optional) the host's status line
//   profileSet       whether the profile's SQL sets its own metrics (profile.js): false for an
//                    engine that set them and locked its configuration (the extension's)
//   htmlPlan         Show plan's tree as DuckDB's HTML page in a frame (the Fabric app), else
//                    its text plan (the panel: its CSP runs no inline script)
//   exportToFabric(state)  (optional) the Export to Fabric button: the shelves on screen,
//                    published as a Fabric app of this Explore (src/exportapp.js); answers
//                    what to say when it is done
//   logsNote         (optional) the Logs page's line
//   editSql(sql)     (optional) the Edit SQL button: the shelves' query, all its rows, handed
//                    to the host's own SQL editor, which runs it and saves its CSV, so Show SQL
//                    and Download CSV are left out
//   plainSql         (optional) { from, measure(name) }: editSql's query as SQL over one table
//                    (explore.js's modelSql), else SQL over the model
//   close()          (optional) a Close button, after Edit SQL
//   hostLogs         the host logs its queries itself (perflog.js), with more than this view
//                    knows (the Fabric app's queue and engine): this view logs none of them
//   pages            (optional) the pages shown, of 'model', 'pivot', 'logs' (default: all);
//                    the first is the one it opens on. One page: no page tabs.
//   stateKey         (optional) where its shelves are kept (default: explore.<name>)
// Returns { destroy }.
export function mountExplore(root, ctx) {
  const setStatus = ctx.setStatus || (() => {});
  const btn = (text, onclick, primary) => el('button', { type: 'button', class: `btn-explore${primary ? ' primary' : ''}`, onclick }, text);

  // --- The frame: the subtabs and the Pivot's actions, then one element per page ---
  const pages = PAGES.filter(([k]) => !ctx.pages || ctx.pages.includes(k));
  const tabs = pages.map(([k, t], i) => el('button', { type: 'button', class: `subtab${i ? '' : ' active'}`, role: 'tab',
    'data-apage': k, 'aria-selected': String(!i), tabindex: i ? '-1' : '0' }, t));
  const sqlToggle = btn('Show SQL', () => (sqlMode ? closeSql() : openSql()));
  const csvBtn = btn('Download CSV', download, true);
  const exportBtn = ctx.exportToFabric ? btn('Export to Fabric', exportApp) : null;
  if (exportBtn) exportBtn.title = 'Publish this Explore, on this model, as a Fabric app (a local copy is written too)';
  const editBtn = ctx.editSql ? btn('Edit SQL', () => {
    const sql = explorer?.query({ cap: 0, plain: ctx.plainSql ?? null })?.sql;
    if (sql) ctx.editSql(sql); else setStatus('Put a field on the shelves first', 'error');
  }, true) : null;
  if (editBtn) editBtn.title = 'This query in the SQL box, to take further by hand (the pivot is kept)';
  const closeBtn = ctx.close ? btn('Close', ctx.close) : null;
  const actions = el('div', { class: 'explore-actions', hidden: true },
    ...(editBtn ? [editBtn, closeBtn] : [sqlToggle, closeBtn, csvBtn]), exportBtn);
  const modelPage = el('div', { class: 'model-page' });
  const pivotPage = el('div', { class: 'explore-page', hidden: true });
  const logsPage = el('div', { class: 'explore-logs-page', hidden: true });

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

  root.replaceChildren(
    el('div', { class: 'subtab-bar' },
      el('div', { class: 'subtabs', role: 'tablist', 'aria-label': 'Semantic model pages', hidden: pages.length < 2 }, tabs),
      actions,
      ctx.title == null ? null : el('span', { class: 'sm-title' }, `${ctx.title} · semantic model `, el('code', {}, ctx.name))),
    modelPage, pivotPage, sqlPage, logsPage);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSql(); } });

  for (const b of tabs) {
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus(); next.click();
    });
    b.addEventListener('click', () => show(b.dataset.apage));
  }
  let page = pages[0][0], logs = null;
  function show(p) {
    page = p;
    for (const b of tabs) {
      const on = b.dataset.apage === p;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (sqlMode && p !== 'pivot') closeSql();
    modelPage.hidden = p !== 'model';
    pivotPage.hidden = p !== 'pivot' || sqlMode;
    logsPage.hidden = p !== 'logs';
    actions.hidden = p !== 'pivot';
    if (p === 'pivot') openExplorer();
    if (p === 'logs') { logs ??= mountLogs(logsPage, { note: ctx.logsNote }); logs.render(); }
  }

  // --- Model ---
  if (pages.some(([k]) => k === 'model')) renderModel(modelPage, ctx.tmsl, { title: `Semantic model ${ctx.name}` });

  // --- Running: compiled once, answered from this view's results when it ran before ---
  const compile = text => compileModelSql(ctx.compiler, text, ctx.name);
  // Results, kept for the life of this view by the SQL that produced them: the model is read
  // only, so the same SQL is the same rows — the pivot toggling Totals or swapping back, Show
  // SQL's unedited box, are answered here. Only answers are kept, never a failure or a Stop;
  // a CSV and a profile run fresh.
  const results = new Map();   // sql -> result, oldest first
  async function run(sql, dax = '', { fresh = false } = {}) {
    if (!fresh && results.has(sql)) {
      const hit = results.get(sql);
      results.delete(sql);
      results.set(sql, hit);
      return hit;
    }
    const res = ctx.hostLogs ? await ctx.run(sql, dax) : await perf.query(sql, () => ctx.run(sql, dax), dax, { queued: false });
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
  let explorer = null, destroyed = false;
  async function openExplorer() {
    if (explorer) return;
    pivotPage.replaceChildren(el('div', { class: 'ex-empty' }, 'Loading the chart library…'));
    let echarts;
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
      run: async text => { const { sql, dax } = compile(text); return (await run(sql, dax)).rows; },
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
    ta.focus();
  }
  function closeSql() {
    sqlMode = false;
    showPlanNode(null);
    sqlPage.hidden = true;
    pivotPage.hidden = page !== 'pivot';
    sqlToggle.textContent = 'Show SQL';
    explorer?.redraw();   // the chart takes its box's size again
  }
  // Ctrl+Enter reaches runSql while a run or a plan is still going; only the latest may write.
  let outSeq = 0;
  async function busy(button, label, work) {
    // Its idle label, from before any run: a second Ctrl+Enter must not keep 'Running…'.
    const was = (button.dataset.idle ??= button.textContent);
    for (const b of [runBtn, planBtn]) b.disabled = true;
    button.textContent = label;
    try { return await work(); }
    catch (e) {
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
        const { sql, dax } = compile(base);
        // Every column as DuckDB prints it: a DATE, TIMESTAMP or DECIMAL would otherwise show
        // as its raw number.
        const res = await run(`SELECT COLUMNS(*)::VARCHAR FROM (\n${sql}\n) LIMIT ${PREVIEW_ROWS}`, dax);
        if (my !== outSeq) return;
        if (!res.rows.length) { info.textContent = `No rows · ${elapsed(t0)}`; return; }
        out.innerHTML = '<thead><tr>' + res.fields.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead><tbody>' +
          res.rows.map(r => '<tr>' + res.fields.map(c => `<td>${escapeHtml(r[c] ?? '')}</td>`).join('') + '</tr>').join('') + '</tbody>';
        // The count runs the query again: only when the rows shown are cut at the limit.
        const total = res.rows.length < PREVIEW_ROWS ? res.rows.length
          : Number((await run(`SELECT COUNT(*) AS cnt FROM (\n${sql}\n)`, dax)).rows[0]?.cnt ?? res.rows.length);
        if (my !== outSeq) return;
        info.textContent = (res.rows.length < total ? `Showing ${res.rows.length} of ${total.toLocaleString()} rows`
          : `${total.toLocaleString()} rows`) + ` · ${elapsed(t0)}`;
        setStatus(`${ctx.name}: ${info.textContent}.`, 'ok');
      } finally { clearInterval(ticker); }
    });
  }

  // --- Show plan: the profile (EXPLAIN ANALYZE, which runs the query once more) and the tree ---
  function showPlanNode(node) {
    planView.replaceChildren(...(node ? [node] : []));
    planView.hidden = !node;
    outWrap.hidden = !!node;
    planShown = !!node;
    planBtn.textContent = planShown ? 'Show results' : 'Show plan';
  }
  async function planTree(sql, dax) {
    if (ctx.htmlPlan) {
      const res = await run(`EXPLAIN (FORMAT html) ${sql}`, dax);
      const frame = el('iframe', { class: 'plan-frame', title: 'Query plan', sandbox: 'allow-scripts' });
      frame.srcdoc = res.rows.map(r => r.explain_value ?? Object.values(r).join('\n')).join('\n');
      return frame;
    }
    const res = await run(`EXPLAIN ${sql}`, dax);
    return el('pre', { class: 'sm-plan' }, res.rows.map(r => r.explain_value ?? Object.values(r).join('  ')).join('\n'));
  }
  function showPlan() {
    // A second click puts the results back.
    if (planShown) { showPlanNode(null); return runSql(); }
    const base = typed();
    if (!base) { info.textContent = 'Enter a SQL query.'; return; }
    info.textContent = '';
    try {
      const { sql, dax } = compile(base);
      showPlanNode(createPlanView({
        profile: async () => (await run(profileSql(sql, { set: ctx.profileSet !== false }), dax, { fresh: true })).rows[0]?.explain_value,
        tree: () => planTree(sql, dax),
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
    const base = sqlMode ? typed() : explorer?.query({ cap: 0 })?.sql;
    if (!base) { setStatus(sqlMode ? 'Enter a SQL query' : 'Put a field on the shelves first', 'error'); return; }
    csvBtn.disabled = true;
    csvBtn.textContent = 'Exporting…';
    try {
      const { sql, dax } = compile(base);
      // Cast as the box's results are, so the file holds what they show.
      const res = await run(`SELECT COLUMNS(*)::VARCHAR FROM (\n${sql}\n)`, dax, { fresh: true });
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

  // --- Export to Fabric: the host does the work and says how it went ---
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

  if (page !== 'model') show(page);

  return {
    // The model's query as it stands: Show SQL's box when it is open, else the shelves'.
    sql: () => (sqlMode ? typed() : explorer?.query()?.sql ?? ''),
    destroy() {
      destroyed = true;
      explorer?.destroy();
      logs?.destroy();
      results.clear();
      resized.disconnect();
      for (const c of charts.values()) c.dispose();
      charts.clear();
      document.querySelectorAll('.ex-pop').forEach(p => p.remove());
      root.replaceChildren();
    },
  };
}
