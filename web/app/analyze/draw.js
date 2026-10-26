// =============================================================================
// analyze/draw.js — the drawing helpers the model view uses: value formats, tints,
// small-multiple grids, the star layout of the model
// =============================================================================
// Ported from analytics-as-code's dashboard (frontend/draw.js), the helpers Analyze needs
// and nothing else.
// =============================================================================

// A date string moved by n days.
export function shiftDate(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// A value written as a model's format string says (Power BI's: `#,##0`, `0.0`, `$#,##0.00`):
// the decimals after the point, grouping with a comma, a leading currency sign. Text, dates
// and a format it does not read are written as they are.
export function formatValue(v, format) {
  if (v == null || v === '') return '';
  if (typeof v !== 'number') return String(v);
  const m = /^([$€£]?)([#,]*0)(?:\.(0+))?$/.exec(format ?? '');
  const digits = m ? (m[3]?.length ?? 0) : Number.isInteger(v) ? 0 : 2;
  const text = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits,
    useGrouping: m ? m[2].includes(',') : false });
  return `${v < 0 ? '-' : ''}${m?.[1] ?? ''}${text}`;
}

// Explore's highlight table: how strong a cell's tint is, 6% to 60% of the colour, between the
// smallest and the largest value shown.
export const shade = (v, min, max) => v == null || !(max > min) ? 0 : Math.round(6 + 54 * (v - min) / (max - min));
export const extent = values => {
  const xs = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  return xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 0];
};

// Explore's small multiples: n plot areas one above the other, in percent of the chart below
// `top`, each under a line for its title.
export const stackedGrids = (n, top = 0) => Array.from({ length: n }, (_, i) => {
  const at = top + i * (100 - top) / n;
  return { title: `${at + 0.5}%`, grid: { left: 4, right: 16, containLabel: true, top: `${at + 5}%`, height: `${(100 - top) / n - 11}%` } };
});

// The semantic model as a star (Model page): the tables a relationship points to (the
// dimensions) in a centre column, in the model's order, and the facts on either side of it,
// each as near as it can be to the height of the dimensions it reaches, so that few lines
// cross. `tables` is [{ name, lines }] (a card's text lines under its name), `rels` the
// model's relationships between those tables. Pixels of the SVG: a card is MODEL_CARD.w wide,
// its name in the first MODEL_CARD.head, then a line every MODEL_CARD.line. A line ends at a
// port spread along the side of its card, in the order of the cards at its other ends.
export const MODEL_CARD = { w: 210, head: 30, line: 16, pad: 10, gap: 130, vgap: 16 };
export function modelLayout(tables, rels) {
  const { w, head, line, pad, gap, vgap } = MODEL_CARD;
  const dims = new Set(rels.map(r => r.toTable));
  const boxes = {};
  let y = 0;
  for (const t of tables.filter(t => dims.has(t.name))) {
    boxes[t.name] = { x: w + gap, y, w, h: head + line * t.lines + pad, dim: true };
    y += boxes[t.name].h + vgap;
  }
  const middle = b => b.y + b.h / 2;
  const facts = tables.filter(t => !dims.has(t.name)).map(t => {
    const reach = rels.filter(r => r.fromTable === t.name && boxes[r.toTable]).map(r => middle(boxes[r.toTable]));
    return { t, at: reach.length ? reach.reduce((s, v) => s + v, 0) / reach.length : 0 };
  }).sort((a, b) => a.at - b.at);
  const next = [0, 0];
  facts.forEach(({ t, at }, i) => {
    const side = i % 2, h = head + line * t.lines + pad;
    const top = Math.max(next[side], at - h / 2);
    boxes[t.name] = { x: side ? 2 * (w + gap) : 0, y: top, w, h, dim: false };
    next[side] = top + h + vgap;
  });
  // Which side of a card a line leaves from: towards the other card, or (two dimensions,
  // one above the other) the left side of both.
  const sideOf = (b, other) => b.x === other.x ? 'l' : b.x < other.x ? 'r' : 'l';
  const ends = rels.map(r => {
    const a = boxes[r.fromTable], b = boxes[r.toTable];
    return { r, a: { box: a, side: sideOf(a, b), other: b }, b: { box: b, side: sideOf(b, a), other: a } };
  });
  const ports = {};
  for (const e of ends) for (const end of [e.a, e.b]) (ports[`${end.box.x},${end.box.y},${end.side}`] ??= []).push(end);
  for (const list of Object.values(ports)) {
    list.sort((p, q) => middle(p.other) - middle(q.other));
    list.forEach((end, i) => {
      const b = end.box;
      end.x = end.side === 'r' ? b.x + b.w : b.x;
      end.y = b.y + head + (b.h - head) * (i + 1) / (list.length + 1);
    });
  }
  const label = (end, text) => ({ x: end.side === 'r' ? end.x + 6 : end.x - 6, y: end.y - 4, anchor: end.side === 'r' ? 'start' : 'end', text });
  const edges = ends.map(({ r, a, b }) => {
    const out = s => s === 'r' ? 1 : -1;
    const reach = a.box.x === b.box.x ? 50 : gap / 2;
    const c1 = [a.x + out(a.side) * reach, a.y], c2 = [b.x + out(b.side) * reach, b.y];
    return {
      from: r.fromTable, to: r.toTable, both: r.crossFilteringBehavior === 'bothDirections', active: r.isActive !== false,
      d: `M${a.x},${a.y} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${b.x},${b.y}`,
      mid: { x: (a.x + 3 * c1[0] + 3 * c2[0] + b.x) / 8, y: (a.y + 3 * c1[1] + 3 * c2[1] + b.y) / 8 },
      many: label(a, '*'), one: label(b, '1'),
    };
  });
  const all = Object.values(boxes);
  return { width: 3 * w + 2 * gap, height: all.length ? Math.max(...all.map(b => b.y + b.h)) : 0, boxes, edges };
}
