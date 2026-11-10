// =============================================================================
// explore/format.js — a Visual's format, and the pane that sets it
// =============================================================================
// A Visual's shelves hold its format (`format`, beside rows, cols, values …), set in Visual's
// Format pane and kept with them: a Report tile made from it draws it the same way.
//   { colors: { series: '#rrggbb' }, labels: true, legend: 'top'|'bottom'|'right'|'off',
//     xTitle, yTitle, yMin, yMax, zoom: true, maxLabel: true, totalLine: true,
//     measures: { measure: { as: 'bar'|'line'|'area'|'dashed', axis: 'right' } },
//     numbers: { field: style }, byValue: { field: 'background'|'bar' }, banded: true,
//     figureSize: 'S'|'L', figureColor: '#rrggbb', change: measure, goodWhen: 'down' }
// every key optional: left out, as before. A chart's goes over its ECharts option (formatChart);
// the rest is Visual's own drawing's (formatLook, explore.js pivotView). A Report's theme is its
// own (report.js): { palette, textSize, colors: { value: '#rrggbb' } }.
// =============================================================================

import { el } from './dom.js';

// A number's style, as the pane names it, and the format string it is.
export const NUMBER_STYLES = [['auto', 'Auto', null], ['int', '1,234', '#,##0'], ['dec2', '1,234.56', '#,##0.00'],
  ['short', '1.2K', '#,##0.0a'], ['pct', '12%', '0%'], ['usd', '$1,234', '$#,##0']];
/** A number style's format string; null for Auto or one it does not know. */
export const numberFormat = style => NUMBER_STYLES.find(([k]) => k === style)?.[2] ?? null;
export const TEXT_SIZES = { S: 10, L: 14 };

/**
 * What a format gives Visual's drawing (explore.js pivotView's `look`): a field's format string
 * by its name, a table's colours by value and bands, a chart's labels, measures in one plot,
 * total line and highest point, a card's figures' size, colour and change.
 */
export function formatLook(f = {}) {
  const formats = Object.fromEntries(Object.entries(f.numbers ?? {}).map(([k, s]) => [k, numberFormat(s)]).filter(([, v]) => v));
  return { formats, byValue: f.byValue, labels: !!f.labels, measures: f.measures, totalLine: !!f.totalLine, maxLabel: !!f.maxLabel,
           change: f.change, goodWhen: f.goodWhen, banded: !!f.banded, figureSize: f.figureSize, figureColor: f.figureColor };
}

/**
 * A chart's ECharts option with a format over it (`f`): series colours by name, the legend's
 * place (off, or one shown where there was none), the category axis's title, the value axes'
 * title and range, a zoom slider, and, with `textSize`, the size of its axes' and legend's
 * text. `label` (fmt(series, value)): every series' values written on it, when f.labels. Pure:
 * the option given is not changed.
 */
export function formatChart(option, f = {}, { textSize, label } = {}) {
  const o = { ...option };
  const list = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const put = (key, items) => { if (o[key] != null) o[key] = Array.isArray(option[key]) ? items : items[0]; };
  const grids = list(o.grid).map(g => ({ ...g }));
  const room = (side, px) => grids.forEach(g => { if (typeof g[side] === 'number') g[side] += px; });
  const font = TEXT_SIZES[textSize];
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const axisOf = a => {
    const out = { ...a, ...(font ? { axisLabel: { ...a.axisLabel, fontSize: font } } : {}) };
    if (a.type === 'value' || a.type === 'log') {
      if (f.yTitle) Object.assign(out, { name: f.yTitle, nameLocation: 'end', nameTextStyle: { align: 'left' } });
      if (num(f.yMin)) out.min = f.yMin;
      if (num(f.yMax)) out.max = f.yMax;
    }
    return out;
  };
  const xs = list(o.xAxis).map(axisOf), ys = list(o.yAxis).map(axisOf);
  // The category axis's title under the last one drawn with its labels (several plots share it).
  // The x axes first: a heatmap's rows are a category axis too. Bars lying down have theirs up the side.
  const isCat = a => a.type === 'category' || a.type === 'time';
  const last = axes => [...axes].reverse().find(a => isCat(a) && a.axisLabel?.show !== false) ?? [...axes].reverse().find(isCat);
  const titled = last(xs) ?? last(ys);
  if (f.xTitle && titled) {
    Object.assign(titled, { name: f.xTitle, nameLocation: 'middle', nameGap: xs.includes(titled) ? 30 : 60 });
    if (xs.includes(titled)) room('bottom', 22);
  }
  put('xAxis', xs);
  put('yAxis', ys);
  if (f.legend === 'off') o.legend = { ...o.legend, show: false };
  else if (f.legend) {
    const at = { top: { top: 0, left: 'center', orient: 'horizontal' }, bottom: { top: 'auto', bottom: 0, left: 'center', orient: 'horizontal' },
      right: { top: 'middle', right: 0, left: 'auto', orient: 'vertical' } }[f.legend];
    if (at) {
      o.legend = { type: 'scroll', ...o.legend, show: true, ...at };
      if (f.legend === 'bottom') room('bottom', 26);
      if (f.legend === 'right') room('right', 110);
      if (f.legend === 'top' && !option.legend) grids.forEach(g => { if (typeof g.top === 'number') g.top = Math.max(g.top, 32); });
    }
  }
  if (font && o.legend) o.legend = { ...o.legend, textStyle: { ...o.legend.textStyle, fontSize: font } };
  // A zoom slider under the plot, on its category axes (and a wheel or a pinch inside it).
  if (f.zoom && [...xs, ...ys].some(isCat)) {
    const on = xs.some(isCat) ? { xAxisIndex: xs.map((a, i) => (isCat(a) ? i : -1)).filter(i => i >= 0) }
      : { yAxisIndex: ys.map((a, i) => (isCat(a) ? i : -1)).filter(i => i >= 0) };
    o.dataZoom = [{ type: 'inside', ...on }, { type: 'slider', ...on, height: 18, bottom: 4, ...(on.yAxisIndex ? { width: 18, right: 4, height: undefined, bottom: undefined } : {}) }];
    room(on.yAxisIndex ? 'right' : 'bottom', 30);
  }
  if (o.grid != null) o.grid = Array.isArray(option.grid) ? grids : grids[0];
  const colors = f.colors && typeof f.colors === 'object' ? f.colors : {};
  o.series = list(o.series).map(s => {
    const c = colors[s.name];
    return { ...s,
      ...(c ? { itemStyle: { ...s.itemStyle, color: c }, ...(s.type === 'line' ? { lineStyle: { ...s.lineStyle, color: c } } : {}) } : {}),
      ...(f.labels && label ? { label: { show: true, position: 'top', fontSize: 10, formatter: p => label(s.name, p.value) } } : {}) };
  });
  return o;
}

/** A format with nothing left unset: no undefined key, no empty list or object; a measure's drawing with nothing set goes. */
export function cleanFormat(f = {}) {
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

// --- The pane's controls: each a row, its label then its controls ---------------------------
export const paneRow = (label, ...kids) => el('div', { class: 'rp-pane-row' }, el('span', { class: 'rp-pane-label' }, label),
  el('div', { class: 'rp-pane-ctl' }, ...kids));
export const paneSelect = (value, options, set, label) => {
  const s = el('select', { 'aria-label': label }, options.map(([v, t]) => el('option', { value: v, selected: v === value }, t)));
  s.addEventListener('change', () => set(s.value));
  return s;
};
export const paneCheck = (on, set, label) => {
  const c = el('input', { type: 'checkbox', checked: !!on, 'aria-label': label });
  c.addEventListener('change', () => set(c.checked));
  return c;
};
export const paneInput = (value, set, label, type = 'text') => {
  const i = el('input', { type, class: 'rp-pane-input', value: value ?? '', 'aria-label': label });
  i.addEventListener('change', () => set(i.value));
  return i;
};
const hex = c => (/^#[0-9a-f]{6}$/i.test(c ?? '') ? c : '#888888');
export const paneColour = (value, set, label) => {
  const i = el('input', { type: 'color', class: 'rp-pane-colour', value: hex(value), 'aria-label': label, title: label });
  i.addEventListener('change', () => set(i.value));
  return i;
};
export const SIZES = [['S', 'S'], ['M', 'M'], ['L', 'L']];

/**
 * The Format pane's rows for format `f`, as `about` says what is drawn: { kind: 'chart' |
 * 'table' | 'card' | 'slicer' | 'shape' (a treemap, a calendar, a map), series: [{ name,
 * color }], numbers: [field names] }. `set(patch)` changes it; `redraw()` draws the pane again
 * (after a Reset, which takes rows away). `css(name)`: a token's colour.
 */
export function formatRows(f, about, set, { redraw, css }) {
  const reset = (label, patch) => el('button', { type: 'button', class: 'rp-pane-reset', onclick: () => { set(patch); redraw(); } }, label);
  const rows = [];
  if (about.kind === 'chart') {
    if (about.series.length) {
      rows.push(paneRow('Colours', ...about.series.map(s => el('label', { class: 'rp-pane-swatch' },
        paneColour(f.colors?.[s.name] ?? s.color, v => set({ colors: { ...f.colors, [s.name]: v } }), `Colour of ${s.name}`), s.name)),
        f.colors ? reset('Reset', { colors: undefined }) : null));
    }
    rows.push(paneRow('Data labels', paneCheck(f.labels, v => set({ labels: v || undefined }), 'Data labels')),
      paneRow('Legend', paneSelect(f.legend ?? 'auto', [['auto', 'Auto'], ['top', 'Top'], ['bottom', 'Bottom'], ['right', 'Right'], ['off', 'Off']],
        v => set({ legend: v === 'auto' ? undefined : v }), 'Legend')),
      paneRow('X axis title', paneInput(f.xTitle, v => set({ xTitle: v.trim() || undefined }), 'X axis title')),
      paneRow('Y axis title', paneInput(f.yTitle, v => set({ yTitle: v.trim() || undefined }), 'Y axis title')),
      paneRow('Y from', paneInput(f.yMin, v => set({ yMin: v === '' ? undefined : Number(v) }), 'Y axis from', 'number'),
        el('span', { class: 'rp-pane-label' }, 'to'), paneInput(f.yMax, v => set({ yMax: v === '' ? undefined : Number(v) }), 'Y axis to', 'number')),
      paneRow('Total line', paneCheck(f.totalLine, v => set({ totalLine: v || undefined }), "Each measure's total as a line across")),
      paneRow('Highest point', paneCheck(f.maxLabel, v => set({ maxLabel: v || undefined }), 'Label the highest point')),
      paneRow('Zoom slider', paneCheck(f.zoom, v => set({ zoom: v || undefined }), 'A zoom slider under the chart')));
    // Several measures: one plot, each drawn as it says, on the left axis or the right one.
    if (about.numbers.length > 1) {
      const drawn = (n, patch) => set({ measures: { ...f.measures, [n]: { ...f.measures?.[n], ...patch } } });
      rows.push(el('h3', { class: 'rp-pane-sub' }, 'Measures in one plot'), ...about.numbers.map(n => paneRow(n,
        paneSelect(f.measures?.[n]?.as ?? 'auto', [['auto', 'As the chart'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'], ['dashed', 'Dashed line']],
          v => drawn(n, { as: v === 'auto' ? undefined : v }), `Draw ${n} as`),
        paneSelect(f.measures?.[n]?.axis ?? 'left', [['left', 'Left'], ['right', 'Right']], v => drawn(n, { axis: v === 'left' ? undefined : v }), `Axis of ${n}`))),
        f.measures ? reset('One plot each', { measures: undefined }) : null);
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
        f.figureColor ? reset('Reset', { figureColor: undefined }) : null));
    // The change: a measure on Values shown under the figure as ▲ or ▼.
    if (about.numbers.length > 1) {
      rows.push(paneRow('Change', paneSelect(f.change ?? '', [['', 'None'], ...about.numbers.slice(1).map(n => [n, n])],
        v => set({ change: v || undefined }), 'The measure shown as the change')),
        paneRow('Good when', paneSelect(f.goodWhen ?? 'up', [['up', 'It goes up'], ['down', 'It goes down']],
          v => set({ goodWhen: v === 'up' ? undefined : v }), 'When the change is good')));
    }
  }
  if (about.kind !== 'slicer' && about.numbers.length) {
    rows.push(el('h3', { class: 'rp-pane-sub' }, 'Numbers'), ...about.numbers.map(n => paneRow(n,
      paneSelect(f.numbers?.[n] ?? 'auto', NUMBER_STYLES.map(([k, t]) => [k, t]),
        v => set({ numbers: { ...f.numbers, [n]: v === 'auto' ? undefined : v } }), `Numbers of ${n}`))));
  }
  if (!rows.length) rows.push(el('p', { class: 'rp-say' }, 'Nothing to format here.'));
  return rows;
}
