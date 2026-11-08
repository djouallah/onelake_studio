// =============================================================================
// report.js — this app's Report page: yours to grow
// =============================================================================
// Export to Fabric wrote this file once, with a first few tiles picked from the model. It is
// never written again: every later export keeps it as it is, so edit it freely (by hand, or with
// an agent), then export again to publish it. Delete it and the next export writes a new one.
//
// A tile is a title, how it is drawn, and one SELECT over the model, in the SQL OneLake Studio
// speaks: its columns as "table"."column", its measures as AGG("measure"), FROM model.
//   kind 'kpi'    one row: each column a figure
//   kind 'bar'    the first column across, every other column a series (also 'line')
//   kind 'table'  the rows as they are
// `formats` (optional): a column's format string, as the model writes one (#,##0.00).
// Try a tile's SQL first in OneLake Studio's SQL box, or its command line's `sql`, with the model's
// own name in place of `model`: SELECT … FROM semanticmodel.<workspace>.<model> GROUP BY ALL.
// `draw` below is plain code, and nothing else calls into it: change it as you like.
// =============================================================================

export const TILES = /*TILES*/[];

const CSS = `
.rp { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: var(--gap);
      padding: var(--gap) var(--gutter) 1.5rem; }
.rp-tile { background: var(--card); border: 1px solid var(--hairline); border-radius: var(--radius); padding: 0.8rem 1rem;
           min-width: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.rp-tile.wide { grid-column: 1 / -1; }
.rp-tile h2 { margin: 0; font-size: 0.85rem; font-weight: 600; color: var(--muted); }
.rp-chart { height: 280px; }
.rp-kpis { display: flex; flex-wrap: wrap; gap: 0.6rem 2.2rem; }
.rp-kpi span { display: block; color: var(--muted); font-size: 0.78rem; }
.rp-kpi b { font-size: 1.7rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.rp-table { overflow: auto; max-height: 420px; }
.rp-table table { border-collapse: collapse; width: 100%; font-size: 0.82rem; }
.rp-table th { text-align: left; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--border); padding: 0.35rem 0.6rem;
               position: sticky; top: 0; background: var(--card); }
.rp-table td { border-bottom: 1px solid var(--row-line); padding: 0.3rem 0.6rem; }
.rp-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.rp-say { color: var(--muted); font-size: 0.82rem; }
.rp-say.error { color: var(--err); white-space: pre-wrap; }
`;

// `api`, from app.js:
//   sql(text)       a SELECT over the model (FROM model): { fields, rows }, each row an object
//   echarts()       ECharts, with this page's theme registered as 'studio'
//   palette         the series colours
//   format(v, fmt)  a value as a format string writes it
export async function draw(root, api) {
  if (!document.getElementById('rp-style')) document.head.append(Object.assign(document.createElement('style'), { id: 'rp-style', textContent: CSS }));
  const grid = make('div', 'rp');
  root.replaceChildren(grid);
  if (!TILES.length) grid.append(make('p', 'rp-say', 'No tiles yet: add them to TILES in site/report.js.'));
  await Promise.all(TILES.map(tile => {
    const box = make('section', `rp-tile${tile.kind === 'kpi' || tile.kind === 'table' ? ' wide' : ''}`);
    box.append(make('h2', '', tile.title || ''));
    const body = make('div', '', '');
    body.append(make('p', 'rp-say', 'Running…'));
    box.append(body);
    grid.append(box);
    return drawTile(body, tile, api).catch(e => body.replaceChildren(make('p', 'rp-say error', e.message || String(e))));
  }));
}

async function drawTile(body, tile, api) {
  const res = await api.sql(tile.sql);
  // A column's format string when the tile has one, else a number grouped, at most two decimals.
  const fmt = (f, v) => (tile.formats?.[f] || typeof v !== 'number' ? api.format(v, tile.formats?.[f])
    : v.toLocaleString('en-US', { maximumFractionDigits: 2 }));
  if (!res.rows.length) { body.replaceChildren(make('p', 'rp-say', 'No rows.')); return; }
  if (tile.kind === 'kpi') {
    const row = res.rows[0];
    const kpis = make('div', 'rp-kpis');
    for (const f of res.fields) {
      const k = make('div', 'rp-kpi');
      k.append(make('span', '', f), make('b', '', fmt(f, row[f])));
      kpis.append(k);
    }
    body.replaceChildren(kpis);
    return;
  }
  if (tile.kind === 'table') {
    const wrap = make('div', 'rp-table'), table = make('table', '');
    const head = make('tr', '');
    for (const f of res.fields) head.append(make('th', '', f));
    table.append(head);
    for (const r of res.rows) {
      const tr = make('tr', '');
      for (const f of res.fields) tr.append(make('td', typeof r[f] === 'number' ? 'num' : '', fmt(f, r[f])));
      table.append(tr);
    }
    wrap.append(table);
    body.replaceChildren(wrap);
    return;
  }
  // A chart: the first column across, the others up.
  const [x, ...ys] = res.fields;
  const box = make('div', 'rp-chart');
  body.replaceChildren(box);
  const echarts = await api.echarts();
  const chart = echarts.init(box, 'studio');
  new ResizeObserver(() => chart.resize()).observe(box);
  chart.setOption({
    aria: { enabled: true },
    color: api.palette,
    tooltip: { trigger: 'axis', valueFormatter: v => fmt(ys[0], v) },
    legend: ys.length > 1 ? { top: 0 } : undefined,
    grid: { left: 8, right: 16, top: ys.length > 1 ? 32 : 12, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: res.rows.map(r => (r[x] == null ? '(blank)' : String(r[x]))) },
    yAxis: { type: 'value' },
    series: ys.map(f => ({ name: f, type: tile.kind === 'line' ? 'line' : 'bar', data: res.rows.map(r => r[f]),
      ...(tile.kind === 'line' ? { showSymbol: res.rows.length <= 60 } : {}) })),
  });
}

function make(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
