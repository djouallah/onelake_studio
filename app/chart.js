// =============================================================================
// chart.js — any result as a chart, with no model: a column across, numbers up
// =============================================================================
// The Chart button's view: a bar, line or scatter chart of the rows the page holds, one
// column along X and one numeric column (or every numeric one) up Y. Nothing is queried: it
// draws what the grid holds. Apart from a table's Pivot, which builds SQL; this only looks.
// =============================================================================

import { PALETTE, registerChartTheme } from './explore/theme.js';

const NUMERIC_TYPE = /^(U?(TINY|SMALL|BIG|HUGE)INT|U?INTEGER|DOUBLE|FLOAT|DECIMAL|HUGEINT)/;
const MAX_POINTS = 10000;   // past this a chart is a smear: the first rows are drawn, and it says so

// The columns that can go up Y: numeric by type, or holding numbers in every non-empty cell.
export function numericColumns(res) {
  return res.fields.filter((f, i) => NUMERIC_TYPE.test((res.types || [])[i] || '') ||
    (res.rows.length > 0 && res.rows.slice(0, 200).every(r => r[f] == null || (r[f] !== '' && !Number.isNaN(Number(r[f]))))));
}

// The first guess: X the first column that is not a number (else the first), Y the first
// number that is not X.
export function guessAxes(res) {
  const nums = numericColumns(res);
  const x = res.fields.find(f => !nums.includes(f)) || res.fields[0];
  const y = nums.find(f => f !== x) || null;
  return { x, y };
}

/** The chart view in `root`: its controls, then the chart. Returns { destroy }. */
export async function mountChart(root, res, { echarts, css, say = () => {} }) {
  const ec = await echarts();
  registerChartTheme(ec, css);
  const nums = numericColumns(res);
  const { x: x0, y: y0 } = guessAxes(res);
  const opt = (v, label = v) => `<option value="${String(v).replace(/"/g, '&quot;')}">${String(label).replace(/</g, '&lt;')}</option>`;
  root.innerHTML = `<div class="chartBar">
      <label>Chart <select data-k="type">${opt('bar', 'Bar')}${opt('line', 'Line')}${opt('scatter', 'Scatter')}</select></label>
      <label>X <select data-k="x">${res.fields.map(f => opt(f)).join('')}</select></label>
      <label>Y <select data-k="y">${nums.length > 1 ? opt('*', 'Every number') : ''}${nums.map(f => opt(f)).join('')}</select></label>
      <span class="chartNote"></span>
    </div><div class="chartBox"></div>`;
  const pick = k => root.querySelector(`[data-k="${k}"]`);
  pick('x').value = x0;
  if (y0) pick('y').value = y0;
  const box = root.querySelector('.chartBox');
  const chart = ec.init(box, 'studio');
  const resized = new ResizeObserver(() => chart.resize());
  resized.observe(box);

  function draw() {
    const type = pick('type').value, x = pick('x').value, y = pick('y').value;
    if (!nums.length) { root.querySelector('.chartNote').textContent = 'No numeric column to draw.'; chart.clear(); return; }
    const ys = y === '*' ? nums.filter(f => f !== x) : [y];
    const rows = res.rows.slice(0, MAX_POINTS);
    root.querySelector('.chartNote').textContent = res.rows.length > MAX_POINTS
      ? `The first ${MAX_POINTS.toLocaleString('en')} of ${res.rows.length.toLocaleString('en')} rows.` : '';
    const num = v => (v == null || v === '' ? null : Number(v));
    const xNumeric = type === 'scatter' && nums.includes(x);
    chart.setOption({
      color: PALETTE,
      tooltip: { trigger: type === 'scatter' ? 'item' : 'axis' },
      legend: ys.length > 1 ? { top: 0 } : undefined,
      grid: { left: 8, right: 16, top: ys.length > 1 ? 32 : 16, bottom: 8, containLabel: true },
      xAxis: xNumeric ? { type: 'value', name: x, scale: true }
        : { type: 'category', name: x, data: rows.map(r => (r[x] == null ? '(blank)' : String(r[x]))) },
      yAxis: { type: 'value', name: ys.length === 1 ? ys[0] : '', scale: type === 'scatter' },
      series: ys.map(f => ({
        name: f, type,
        data: xNumeric ? rows.map(r => [num(r[x]), num(r[f])]) : rows.map(r => num(r[f])),
        ...(type === 'line' ? { showSymbol: rows.length <= 200 } : {}),
        ...(type === 'scatter' ? { symbolSize: rows.length > 2000 ? 3 : 6 } : {}),
      })),
    }, true);
  }
  root.querySelector('.chartBar').onchange = draw;
  draw();
  say(`A chart of ${res.rows.length.toLocaleString('en')} row(s): Show Rows puts the grid back.`);
  return { destroy() { resized.disconnect(); chart.dispose(); root.replaceChildren(); } };
}
