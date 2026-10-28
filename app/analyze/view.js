// =============================================================================
// analyze/view.js — what a .bim opens as: its semantic model, on three pages
// =============================================================================
//   Model     the star of its tables and relationships, and what the model says of the
//             table picked (model.js)
//   Explore   the model's fields dragged onto shelves, drawn as a pivot or a chart
//             (explore.js, ECharts)
//   SQL       a box of SQL in which a SELECT ... FROM <model> asks the model (its columns,
//             and its measures as AGG("name")); Preview, Show plan, Download CSV
// Ported from the Analyze tab of analytics-as-code's dashboard. The host (app.js) says how
// a model's SQL is compiled and run: `rewrite` compiles what the user typed (semantic.js),
// `run` opens the tables a compiled SQL reads and runs it, returning the engine's result.
// =============================================================================

import { PINS, npmFile } from '../cdn.js';
import { escapeHtml } from '../paths.js';
import { renderModel } from './model.js';
import { createExplorer } from './explore.js';
import { createModelQuery } from './query.js';
import { PALETTE, registerChartTheme } from './theme.js';

const PAGES = [['model', 'Model'], ['explore', 'Explore'], ['sql', 'SQL']];
const PREVIEW_ROWS = 500;

// ECharts' own minified build, as a classic script (window.echarts): the build the dashboard
// this is ported from runs. jsDelivr's +esm repackaging of it draws an empty canvas.
let echartsP = null;
const loadEcharts = () => (echartsP ??= new Promise((resolve, reject) => {
  if (window.echarts) return resolve(window.echarts);
  const s = document.createElement('script');
  s.src = npmFile(PINS.echarts, 'dist/echarts.min.js');
  s.onload = () => window.echarts ? resolve(window.echarts) : reject(new Error('echarts.min.js defined no echarts'));
  s.onerror = () => reject(new Error(`could not load ${s.src}`));
  document.head.append(s);
}).catch(e => { echartsP = null; throw e; }));

// `ctx`:
//   name, file       the model's name (what SQL calls it) and its file's
//   tmsl             the model, as model.js's tmslOf reads the .bim
//   exploreCompiler  dax-sql's compiler for Explore's queries (semantic.js)
//   sample           the example query of the SQL page
//   rewrite(text)    { sql } — what the user typed, compiled — or null when it names no model
//   run(sql)         the engine's result of a compiled SQL: { fields, rows, truncated, ... }
//   setStatus(text, kind)
//   exportToFabric(state)  (optional) Explore's Export to Fabric button: the shelves on screen,
//                    published as a Fabric app of this model's Explore alone
//                    (src/exportapp.js); answers what the button says when it is done
// Returns { destroy }.
export function mountAnalyze(root, ctx) {
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v != null) n.setAttribute(k, v);
    }
    n.append(...kids.flat().filter(k => k != null));
    return n;
  };

  // --- The frame: the subtabs, then one element per page ---
  const tabs = PAGES.map(([k, t], i) => el('button', { type: 'button', class: `subtab${i ? '' : ' active'}`, role: 'tab',
    'data-apage': k, 'aria-selected': String(!i), tabindex: i ? '-1' : '0' }, t));
  const modelPage = el('div', { class: 'model-page' });
  const ta = el('textarea', { spellcheck: 'false', wrap: 'off', 'aria-label': 'SQL over the semantic model' });
  const info = el('div', { class: 'analyze-info' });
  const out = el('table', { class: 'analyze-table' });
  const btn = (text, onclick, primary) => el('button', { type: 'button', class: `btn-analyze${primary ? ' primary' : ''}`, onclick }, text);
  const previewBtn = btn('Preview', preview, true), planBtn = btn('Show plan', plan), csvBtn = btn('Save CSV', download);
  const sqlPage = el('div', { class: 'analyze-sql-page', hidden: '' },
    el('div', { class: 'analyze-controls' }, previewBtn, planBtn, csvBtn),
    el('div', { class: 'analyze-sql' },
      el('div', { class: 'analyze-sql-head' },
        el('label', {}, 'SQL ', el('span', {}, `— a SELECT … FROM ${ctx.name} asks the semantic model: its columns, and its measures as AGG("name"). Any other SQL runs as written. Ctrl+Enter previews.`)),
        btn('Example', () => { ta.value = ctx.sample; })),
      ta),
    info,
    el('div', { class: 'analyze-table-wrap' }, out));
  const explorePage = el('div', { class: 'explore-page', hidden: '' });
  root.replaceChildren(
    el('div', { class: 'subtab-bar' },
      el('div', { class: 'subtabs', role: 'tablist', 'aria-label': 'Semantic model pages' }, tabs),
      el('span', { class: 'sm-title' }, `${ctx.file} · semantic model `, el('code', {}, ctx.name))),
    modelPage, explorePage, sqlPage);
  ta.value = ctx.sample;
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); preview(); } });

  for (const b of tabs) {
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus(); next.click();
    });
    b.addEventListener('click', () => show(b.dataset.apage));
  }
  function show(page) {
    for (const b of tabs) {
      const on = b.dataset.apage === page;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    modelPage.hidden = page !== 'model';
    sqlPage.hidden = page !== 'sql';
    explorePage.hidden = page !== 'explore';
    if (page === 'explore') openExplorer();
  }

  // --- Model ---
  renderModel(modelPage, ctx.tmsl, { title: `Semantic model ${ctx.name}` });

  // --- SQL ---
  const typed = () => ta.value.trim().replace(/;+\s*$/, '');
  // What the box says as the SQL that runs: a model's SELECTs compiled in place.
  const compiled = text => ctx.rewrite(text)?.sql ?? text;
  // Results, kept for the life of this view by the SQL that produced them: the model is read
  // only, so the same SQL is the same rows — a Preview run twice, a count, Explore toggling
  // Totals or swapping back, are answered here. Only answers are kept, never a failure or
  // a Stop; the CSV export runs fresh (its rows are many and it is asked for once).
  const results = new Map();   // sql -> result, oldest first
  async function run(sql) {
    if (results.has(sql)) {
      const hit = results.get(sql);
      results.delete(sql);
      results.set(sql, hit);
      return hit;
    }
    const res = await ctx.run(sql);
    results.set(sql, res);
    if (results.size > 40) results.delete(results.keys().next().value);
    return res;
  }
  // Ctrl+Enter reaches preview() while a Preview or a Plan is still running; only the
  // latest may write the result pane.
  let outSeq = 0;
  async function busy(button, label, work) {
    const was = button.textContent;
    for (const b of [previewBtn, planBtn, csvBtn]) b.disabled = true;
    button.textContent = label;
    try { return await work(); }
    catch (e) {
      if (e.cancelled) { info.textContent = 'Stopped.'; return; }
      info.textContent = 'Error: ' + e.message;
      ctx.setStatus('Query error: ' + e.message, 'error');
      console.error('[model view]', e);
    } finally {
      for (const b of [previewBtn, planBtn, csvBtn]) b.disabled = false;
      button.textContent = was;
    }
  }
  function preview() {
    const base = typed();
    if (!base) { info.textContent = 'Enter a SQL query.'; return; }
    out.innerHTML = '';
    info.textContent = '';
    const my = ++outSeq;
    return busy(previewBtn, 'Loading…', async () => {
      const sql = compiled(base);
      // Every column as DuckDB prints it: a DATE, TIMESTAMP or DECIMAL read through Arrow
      // would show as its raw number.
      const res = await run(`SELECT COLUMNS(*)::VARCHAR FROM (\n${sql}\n) LIMIT ${PREVIEW_ROWS}`);
      if (my !== outSeq) return;
      if (!res.rows.length) { info.textContent = 'No rows.'; ctx.setStatus('No rows.', 'ok'); return; }
      out.innerHTML = '<thead><tr>' + res.fields.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead><tbody>' +
        res.rows.map(r => '<tr>' + res.fields.map(c => `<td>${escapeHtml(r[c] ?? '')}</td>`).join('') + '</tr>').join('') + '</tbody>';
      // The count runs the query again: only when the preview is cut at its limit.
      const total = res.rows.length < PREVIEW_ROWS ? res.rows.length
        : Number((await run(`SELECT COUNT(*) AS cnt FROM (\n${sql}\n)`)).rows[0]?.cnt ?? res.rows.length);
      if (my !== outSeq) return;
      info.textContent = res.rows.length < total
        ? `Showing ${res.rows.length} of ${total.toLocaleString()} rows` : `${total.toLocaleString()} rows`;
      ctx.setStatus(`${ctx.name}: ${info.textContent}.`, 'ok');
    });
  }
  function plan() {
    const base = typed();
    if (!base) { info.textContent = 'Enter a SQL query.'; return; }
    out.innerHTML = '';
    info.textContent = '';
    const my = ++outSeq;
    return busy(planBtn, 'Planning…', async () => {
      const res = await run(`EXPLAIN ${compiled(base)}`);
      if (my !== outSeq) return;
      const text = res.rows.map(r => r.explain_value ?? Object.values(r).join('  ')).join('\n');
      out.innerHTML = `<tbody><tr><td><pre class="sm-plan">${escapeHtml(text)}</pre></td></tr></tbody>`;
      info.textContent = 'Query plan (EXPLAIN)';
      ctx.setStatus(`${ctx.name}: query plan.`, 'ok');
    });
  }
  function download() {
    const base = typed();
    if (!base) { info.textContent = 'Enter a SQL query.'; return; }
    return busy(csvBtn, 'Exporting…', () => csvOf(compiled(base), `${ctx.name}.csv`));
  }
  // A CSV of a compiled SQL, cast as the preview is, so the file holds what the preview shows.
  async function csvOf(sql, filename) {
    const res = await ctx.run(`SELECT COLUMNS(*)::VARCHAR FROM (\n${sql}\n)`);
    const cell = v => v == null ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const text = [res.fields.map(cell).join(','), ...res.rows.map(r => res.fields.map(f => cell(r[f])).join(','))].join('\n') + '\n';
    const saved = await ctx.saveText(filename, text);
    if (!saved) return;   // the save dialog was dismissed
    ctx.setStatus(`Saved ${res.rows.length.toLocaleString()} rows to ${saved}` +
      (res.truncated ? ` — stopped at the engine's cap of ${res.limit.toLocaleString()}; add a filter for all of them` : '') + '.',
      res.truncated ? 'warn' : 'ok');
  }

  // --- Explore ---
  const charts = new Map();
  const resized = new ResizeObserver(entries => { for (const e of entries) charts.get(e.target)?.resize(); });
  const css = name => getComputedStyle(root).getPropertyValue(name).trim();
  let explorer = null;
  async function openExplorer() {
    if (explorer) return;
    explorePage.replaceChildren(el('div', { class: 'ex-empty' }, 'Loading the chart library…'));
    let echarts;
    try {
      echarts = await loadEcharts();
      registerChartTheme(echarts, css);
    } catch (e) {
      explorePage.replaceChildren(el('div', { class: 'ex-error' }, `Could not load the chart library: ${e.message}`));
      return;
    }
    if (explorer || destroyed) return;
    const mq = createModelQuery(ctx.tmsl, ctx.exploreCompiler);
    const sqlOf = q => mq.toSQL(mq.toDax(q));
    explorer = createExplorer(explorePage, {
      model: async () => ctx.tmsl,
      toDax: q => mq.toDax(q),
      run: async q => (await run(sqlOf(q))).rows,
      csv: q => csvOf(sqlOf(q), `${ctx.name}-explore.csv`),
      chart: box => {
        if (!charts.has(box)) { charts.set(box, echarts.init(box, 'studio')); resized.observe(box); }
        return charts.get(box);
      },
      palette: () => PALETTE,
      css,
      loadState: () => ctx.loadState(`explore.${ctx.name}`),
      saveState: s => ctx.saveState(`explore.${ctx.name}`, s),
      exportToFabric: ctx.exportToFabric,
    });
  }

  let destroyed = false;
  return {
    destroy() {
      destroyed = true;
      explorer?.destroy();
      results.clear();
      resized.disconnect();
      for (const c of charts.values()) c.dispose();
      charts.clear();
      document.querySelectorAll('.ex-pop').forEach(p => p.remove());
      root.replaceChildren();
    },
  };
}
