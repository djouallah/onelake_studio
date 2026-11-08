// =============================================================================
// explore/report.js — a model's Report: tiles, each one SELECT over the model, drawn
// =============================================================================
// The Report is data (site/report.json in Export to Fabric's zip; the first tiles before there is
// one): { tiles: [{ title, kind, sql, formats?, echarts?, wide? }] }. A tile's SQL is a SELECT over
// the model, FROM model, in the SQL the SQL box takes.
//   kind 'kpi'    one row: each column a figure
//   kind 'bar'    the first column across, every other column a series (also 'line')
//   kind 'table'  the rows as they are
// `formats`: a column's format string; `echarts` (bar, line): an ECharts option merged over the
// tile's own. A tile that fails says so in its own box, and the rest still draw.
// The same file in the panel and in Export to Fabric's app: the host says how SQL runs (`sql`).
// =============================================================================

import { el } from './dom.js';
import { formatValue } from './draw.js';
import { PALETTE } from './theme.js';

const KINDS = new Set(['kpi', 'bar', 'line', 'table']);

// `b` over `a`: objects key by key, arrays item by item, anything else replaced.
export function merge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (i in b ? merge(a[i], b[i]) : a[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
    return out;
  }
  return b === undefined ? a : b;
}

// A value as the tile says: its column's format string, else a number grouped, at most two decimals.
function formatter(tile) {
  return (column, v) => (tile.formats?.[column] || typeof v !== 'number' ? formatValue(v, tile.formats?.[column])
    : v.toLocaleString('en-US', { maximumFractionDigits: 2 }));
}

/**
 * The Report in `root`. `ctx`: sql(text) -> { fields, rows }; echarts() -> ECharts with the theme
 * 'studio' registered. Returns { destroy }.
 */
export function drawReport(root, spec, ctx) {
  const charts = [];
  const resized = new ResizeObserver(entries => { for (const e of entries) charts.find(c => c.box === e.target)?.chart.resize(); });
  const tiles = Array.isArray(spec?.tiles) ? spec.tiles : null;
  const grid = el('div', { class: 'rp' });
  root.replaceChildren(grid);
  if (!tiles) grid.append(el('p', { class: 'rp-say error' }, 'The report has no "tiles" list.'));
  else if (!tiles.length) grid.append(el('p', { class: 'rp-say' }, 'The report has no tiles yet.'));
  let gone = false;
  for (const tile of tiles ?? []) {
    const body = el('div', {}, el('p', { class: 'rp-say' }, 'Running…'));
    const wide = tile.wide ?? (tile.kind === 'kpi' || tile.kind === 'table');
    grid.append(el('section', { class: `rp-tile${wide ? ' wide' : ''}` }, el('h2', {}, String(tile.title ?? '')), body));
    drawTile(body, tile).catch(e => { if (!gone) body.replaceChildren(el('p', { class: 'rp-say error' }, e?.message || String(e))); });
  }

  async function drawTile(body, tile) {
    if (!KINDS.has(tile.kind)) throw new Error(`a tile's kind is kpi, bar, line or table, not ${JSON.stringify(tile.kind)}`);
    if (typeof tile.sql !== 'string' || !tile.sql.trim()) throw new Error('the tile has no sql');
    const res = await ctx.sql(tile.sql);
    if (gone) return;
    const fmt = formatter(tile);
    if (!res.rows.length) { body.replaceChildren(el('p', { class: 'rp-say' }, 'No rows.')); return; }
    if (tile.kind === 'kpi') {
      const row = res.rows[0];
      body.replaceChildren(el('div', { class: 'rp-kpis' },
        res.fields.map(f => el('div', { class: 'rp-kpi' }, el('span', {}, f), el('b', {}, fmt(f, row[f]))))));
      return;
    }
    if (tile.kind === 'table') {
      body.replaceChildren(el('div', { class: 'rp-table' }, el('table', {},
        el('thead', {}, el('tr', {}, res.fields.map(f => el('th', {}, f)))),
        el('tbody', {}, res.rows.map(r => el('tr', {}, res.fields.map(f =>
          el('td', typeof r[f] === 'number' ? { class: 'num' } : {}, fmt(f, r[f])))))))));
      return;
    }
    // A chart: the first column across, the others up.
    const [x, ...ys] = res.fields;
    const box = el('div', { class: 'rp-chart' });
    body.replaceChildren(box);
    const echarts = await ctx.echarts();
    if (gone) return;
    const chart = echarts.init(box, 'studio');
    charts.push({ box, chart });
    resized.observe(box);
    const option = {
      aria: { enabled: true },
      color: PALETTE,
      tooltip: { trigger: 'axis', valueFormatter: v => fmt(ys[0], v) },
      legend: ys.length > 1 ? { top: 0 } : undefined,
      grid: { left: 8, right: 16, top: ys.length > 1 ? 32 : 12, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: res.rows.map(r => (r[x] == null ? '(blank)' : String(r[x]))) },
      yAxis: { type: 'value' },
      series: ys.map(f => ({ name: f, type: tile.kind, data: res.rows.map(r => r[f]),
        ...(tile.kind === 'line' ? { showSymbol: res.rows.length <= 60 } : {}) })),
    };
    chart.setOption(tile.echarts && typeof tile.echarts === 'object' ? merge(option, tile.echarts) : option);
  }

  return {
    destroy() {
      gone = true;
      resized.disconnect();
      for (const { chart } of charts) chart.dispose();
      root.replaceChildren();
    },
  };
}
