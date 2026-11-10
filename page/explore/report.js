// =============================================================================
// explore/report.js — a model's Report: pages of tiles, each tile a Visual, drawn
// =============================================================================
// The Report is data (site/report.json in Export to Fabric's zip, or the file Studio keeps before
// an export; no tiles before either): { pages: [{ name, tiles }], theme? }. A report written
// before pages, { tiles }, is one page, Page 1 (reportPages), and is written back as pages
// (withPages). The host draws the pages' names and one page at a time; this draws a page's tiles.
// A tile's query is always Visual's, generated from its shelves: no tile holds SQL.
//   kind 'pivot'  `pivot` is Visual's shelves ({ rows, cols, values, filters, mark, totals, sort,
//                 top, slicer }, as Add to report saves them), drawn as Visual draws them
//                 (explore.js). Its mark 'slicer' is a slicer: what is picked in it (values, or a
//                 range) filters every other tile, and it does not run again when they change.
//   kind 'text'   `text`, a few lines of Markdown (# headings, **bold**, *italic*,
//                 [links](https://…), - lists), drawn as it is; picks don't touch it. A host that
//                 saves the Report edits it in place (a double-click on it: `setText`).
// Any other tile (an older report's tiles of SQL: kpi, bar, line, table) says it is not a Visual
// tile, and is built again in Visual.
// The tiles are laid out on a grid of 12 columns and rows of 10 pixels: `layout` ({ x, y, w, h },
// the column and row a tile starts at, and how many it spans) is where its grip and its ◢ put it.
// Every tile floats up as far as it can, and a tile placed over others pushes them down (arrange);
// a tile with no layout goes in the first place it fits, as wide and tall as its kind is. A host
// that saves the Report places them (`layout`), takes them out (`remove`), copies them
// (`duplicate`), renames them (a double-click on the title: `rename`) and opens a tile's shelves
// in Visual (`edit`). A grip dropped on another page's name moves the tile there (`toPage`).
// A tile's look is its Visual's: the shelves' `format`, set in Visual's Format pane (format.js).
// The tile's own are where it is and its title (`showTitle`, `titleSize`), and the filter bar's
// filters it does not follow (`ignore`). The report's `theme` sets its colours and its text's size. A tile that fails says so in its own box, and the
// rest still draw.
// Cross filtering: a click on a bar, a point or a row picks its first Rows field's value (else
// Columns'), and every other tile runs again with it as a condition of its own query, as its
// Filters shelf writes one (pickWhere). The tile clicked stays whole, its pick bright; the same
// click again clears it, as the pick's ✕ above the tiles does. Picks in several tiles all apply.
// The host's `where` (its filter bar) is in every tile's query too.
// The same file in the panel and in Export to Fabric's app: the host says how SQL runs (`sql`).
// =============================================================================

import { el } from './dom.js';
import { PALETTE, PALETTES } from './theme.js';
import { autoMark, modelFields, pivotQuery, pivotView } from './explore.js';
import { formatChart, formatLook, TEXT_SIZES } from './format.js';

const KINDS = new Set(['pivot', 'text']);
// The marks drawn as a shape of their own, with no axes: what the format pane offers them is less.
const SHAPES = new Set(['treemap', 'calendar', 'map']);
// The grid a tile is laid out on: its columns, the height of a row in pixels, the fewest rows a
// tile has, and the rows an arrow key moves or resizes it by.
export const COLUMNS = 12, ROW = 10, MIN_ROWS = 6, ROW_KEY = 2;

// --- Pages ---------------------------------------------------------------------------

/**
 * A report's pages: [{ name, tiles }], its own `pages`, or a report written before pages
 * ({ tiles }) as one, Page 1. A page with no name is named for where it is. `tiles` is the
 * page's as written (not a list: drawReport says so). No pages at all is one empty page.
 */
export function reportPages(spec) {
  if (Array.isArray(spec?.pages) && !spec.pages.length) return [{ name: 'Page 1', tiles: [] }];
  if (Array.isArray(spec?.pages)) {
    return spec.pages.map((p, i) => ({ ...(p && typeof p === 'object' ? p : {}), name: String(p?.name ?? '').trim() || `Page ${i + 1}`, tiles: tilesOf(p?.tiles) }));
  }
  return [{ name: 'Page 1', tiles: tilesOf(spec?.tiles) }];
}

const tilesOf = tiles => (Array.isArray(tiles) ? tiles.map(tileOf) : tiles);

/** The report with these pages, as pages: a report written before them loses its own `tiles`. */
export function withPages(spec, pages) {
  const { tiles: _, ...rest } = spec && typeof spec === 'object' ? spec : {};
  return { ...rest, pages };
}

/** A new page's name: Page n, n one more than the pages there are, or the next no page has. */
export function newPageName(pages) {
  for (let n = pages.length + 1; ; n++) if (!pages.some(p => p.name === `Page ${n}`)) return `Page ${n}`;
}

// --- A text tile's Markdown: nothing in it is HTML --------------------------------------

// **bold**, *italic*, and [a link](https://…): only http and https links.
const INLINE = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
// A line's text as its parts: a string, or { b }, { i }, { a, href }.
function inline(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push(m[1] != null ? { b: m[1] } : m[2] != null ? { i: m[2] } : { a: m[3], href: m[4] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * Markdown's few forms, as blocks: { h: 1-3, parts }, { p: parts }, { ul: [parts] }; # to ###
 * headings, - (or *) lists, and paragraphs, which a blank line, a heading or a list ends.
 */
export function markdownBlocks(text) {
  const out = [];
  let para = [], list = null;
  const endPara = () => { if (para.length) out.push({ p: inline(para.join(' ')) }); para = []; };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const head = /^(#{1,3})\s+(.*)$/.exec(line), item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) { endPara(); list = null; }
    else if (head) { endPara(); list = null; out.push({ h: head[1].length, parts: inline(head[2].trim()) }); }
    else if (item) {
      endPara();
      if (!list) out.push(list = { ul: [] });
      list.ul.push(inline(item[1].trim()));
    } else { list = null; para.push(line.trim()); }
  }
  endPara();
  return out;
}

// The blocks as elements: a heading under the tile's own title is h3 to h5.
function markdownNodes(text) {
  const parts = ps => ps.map(p => (typeof p === 'string' ? p : p.b != null ? el('strong', {}, p.b) : p.i != null ? el('em', {}, p.i)
    : el('a', { href: p.href, target: '_blank', rel: 'noopener noreferrer' }, p.a)));
  return markdownBlocks(text).map(b => (b.h ? el(`h${b.h + 2}`, {}, parts(b.parts)) : b.p ? el('p', {}, parts(b.p))
    : el('ul', {}, b.ul.map(li => el('li', {}, parts(li))))));
}

/**
 * Every tile at its place on the grid: { x, y, w, h } each, in columns and rows. The tile at
 * `fixed` (an index; -1: none) stays where it is put; the others, top to bottom then left to
 * right, float up as far as they can and down past whatever they would overlap. A tile with no
 * x or y goes in the first place it fits, after those that have one.
 */
export function arrange(items, fixed = -1) {
  const out = items.map(it => {
    const w = Math.max(1, Math.min(COLUMNS, Math.round(it.w || COLUMNS / 2)));
    return { ...it, w, h: Math.max(MIN_ROWS, Math.round(it.h || MIN_ROWS)),
      ...(it.x == null || it.y == null ? { x: null, y: null } : { x: Math.max(0, Math.min(COLUMNS - w, Math.round(it.x))), y: Math.max(0, Math.round(it.y)) }) };
  });
  const placed = [];
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const free = it => !placed.some(q => hits(q, it));
  if (out[fixed]) placed.push(out[fixed]);
  const key = it => (it.y == null ? [Infinity, 0] : [it.y, it.x]);
  const order = out.map((_, i) => i).filter(i => i !== fixed)
    .sort((a, b) => { const [ya, xa] = key(out[a]), [yb, xb] = key(out[b]); return ya === yb ? xa - xb || a - b : ya < yb ? -1 : 1; });
  for (const i of order) {
    const it = out[i];
    if (it.y == null) {
      for (let y = 0; it.y == null; y++) {
        for (let x = 0; x + it.w <= COLUMNS; x++) if (free({ ...it, x, y })) { it.x = x; it.y = y; break; }
      }
    } else {
      while (it.y > 0 && free({ ...it, y: it.y - 1 })) it.y--;
      while (!free(it)) it.y++;
    }
    placed.push(it);
  }
  return out;
}
// A chart's other bars and points, while one is picked.
const DIM = 0.3;

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

/**
 * A tile as it is kept now: an older tile's `format` (the Report's own pane wrote it) goes into
 * its Visual's shelves, but for its title's (`showTitle`, `titleSize`) and the filters it does
 * not follow (`ignore`), which are the tile's.
 */
export function tileOf(t) {
  if (!t || typeof t !== 'object' || !t.format || typeof t.format !== 'object') return t;
  const { format: { title, titleSize, ignore, ...look }, ...tile } = t;
  return {
    ...tile,
    ...(title === false ? { showTitle: false } : {}),
    ...(titleSize ? { titleSize } : {}),
    ...(Array.isArray(ignore) && ignore.length ? { ignore } : {}),
    ...(tile.kind === 'pivot' && tile.pivot && typeof tile.pivot === 'object' && Object.keys(look).length
      ? { pivot: { ...tile.pivot, format: { ...look, ...tile.pivot.format } } } : {}),
  };
}

// --- Cross filtering: a pick, as conditions of the other tiles' own queries -------------

/**
 * A pick on model column `id`, as the Filters shelf writes conditions ([id, op, ...values],
 * explore.js modelSql): { value } is = value (a blank, IS NULL); a slicer's { values } is IN (a
 * blank among them, IS NULL), none ticked no condition; its { range: [lo, hi] } is >= lo and
 * <= hi, either end left out when null (a date's last day kept whole, as the shelf keeps it).
 */
export function pickWhere(id, p) {
  if (Array.isArray(p.range)) {
    const [lo, hi] = p.range;
    return [...(lo != null ? [[id, '>=', lo]] : []), ...(hi != null ? [[id, '<=', hi]] : [])];
  }
  if (Array.isArray(p.values)) return p.values.length ? [[id, 'in', p.values]] : [];
  return [p.value == null ? [id, 'blank'] : [id, '=', p.value]];
}

const same = (a, b) => (a ?? null) === (b ?? null);

/**
 * The Report in `root`. `ctx`: sql(text) -> { fields, rows }; echarts() -> ECharts with the theme
 * 'studio' registered; shown() (optional), a promise that settles once the Report is on screen;
 * leftWhileRunning() (optional), whether the host stopped the tile running because the Report was
 * left (and forgets it); cancel() (optional), stops the tile running, when a pick changes it;
 * where (optional), conditions in every tile's query, as the Filters shelf writes them (the host's
 * filter bar); model, the model (model.js's tmslOf); css(name)
 * (optional), a CSS token's value, for a pivot's tints; remove(index) (optional), a ✕ on each tile
 * that takes it out of the report; layout(tiles) (optional), a grip on each tile that drags it
 * anywhere on the grid and a ◢ that drags its size (or the arrow keys, on either), drawn there at
 * once: `tiles` is each tile, in its new order (top to bottom), as { from: its index before, layout };
 * duplicate(index) (optional), a ⧉ that copies a tile; rename(index, title) (optional), a double-click
 * on a title that edits it in place; edit(index) (optional), a ✎ on a pivot tile that opens it in Visual;
 * setText(index, text) (optional), a double-click on a text tile that edits its Markdown in place;
 * toPage (optional), { at(x, y), drop(index, page) }: while a grip is dragged, at() answers the
 * other page whose name is under the pointer (and marks it), or null; dropped there, the tile is
 * put back on this page's grid and drop() moves it.
 * `spec` is one page and the report's theme, { tiles, theme? }. Returns { destroy }.
 * The tiles run one at a time, top to bottom: each is a scan of the model's tables, and the engine
 * gives one query all it has, where several at once share it, keep each other waiting, and keep
 * anything else the tab asks waiting too. `ctx.parallel` (optional) is how many may run at once where that
 * isn't so: a Fabric app's engines each take one query, and its downloads are shared by what is asked together.
 * A tile waits while the Report is off screen; one stopped (`cancelled`, by the host when the Report was left)
 * runs again when it is back.
 */
export function drawReport(root, spec, ctx) {
  const resized = new ResizeObserver(entries => { for (const e of entries) jobs.find(j => j.box === e.target)?.chart.resize(); });
  const tiles = Array.isArray(spec?.tiles) ? spec.tiles : null;
  // The report's theme: its colours, and the size of its text.
  const palette = PALETTES[spec?.theme?.palette] ?? PALETTE;
  // A value's own colour in every tile (a fuel, a region): { label: '#rrggbb' }.
  const valueColors = spec?.theme?.colors && typeof spec.theme.colors === 'object' ? spec.theme.colors : null;
  const textSize = TEXT_SIZES[spec?.theme?.textSize] ? spec.theme.textSize : null;
  const grid = el('div', { class: `rp${textSize ? ` rp-text-${textSize}` : ''}` });
  const chips = el('div', { class: 'rp-filters', hidden: true });
  root.replaceChildren(chips, grid);
  if (!tiles) grid.append(el('p', { class: 'rp-say error' }, 'The page has no "tiles" list.'));
  else if (!tiles.length) grid.append(el('p', { class: 'rp-say rp-empty' }, ctx.remove
    ? 'The page has no tiles yet. Build a view in Visual and click Add to report.' : 'The page has no tiles.'));
  let gone = false, active = 0;
  // How many tiles run at once: one, unless the host says more (ctx.parallel).
  const atOnce = Math.max(1, Number(ctx.parallel) || 1);
  // What a click picked, by the tile it was picked in: { field, value, label }, in the order picked.
  const picks = new Map();
  // The model's fields, for pivot tiles: read once, when there is one.
  const fields = tiles?.some(t => t?.kind === 'pivot') && ctx.model ? modelFields(ctx.model) : null;
  const jobs = (tiles ?? []).map(tile => {
    const body = el('div', { class: 'rp-body' }, el('p', { class: 'rp-say' }, 'Waiting…'));
    // A pivot tile's shelves and query; a broken one says why when it runs (drawPivot).
    let piv = null;
    if (tile?.kind === 'pivot' && fields) try { piv = pivotQuery(tile.pivot, fields); } catch (_) { /* drawPivot says */ }
    const mark = piv && (piv.state.mark === 'auto' ? autoMark(piv.state, fields) : piv.state.mark);
    // A pivot's chart of several measures is a plot each, one above the other: taller.
    const plots = piv && !SHAPES.has(mark) && mark !== 'heatmap' && mark !== 'scatter' && mark !== 'slicer' && !tile.pivot?.format?.measures
      ? Math.min(piv.state.values.length, 4) : 1;
    const wide = tile.wide ?? (mark === 'table' || mark === 'highlight' || mark === 'heatmap' || mark === 'calendar');
    const title = String(tile.title ?? '');
    const text = tile?.kind === 'text';
    const job = { tile, body, piv, on: text ? null : pickColumn(tile, piv), dirty: !text, asking: false, chart: null, box: null, repaint: null };
    const grip = ctx.layout ? el('button', { type: 'button', class: 'rp-tool rp-grip', title: 'Drag to move, or move with the arrow keys',
      'aria-label': `Move ${title || 'this tile'}`, onpointerdown: e => dragFrom(e, job, 'move'), onkeydown: e => keyed(e, job, 'move') }, '⠿') : null;
    job.slicer = mark === 'slicer';
    // Not drawn again when a pick changes: a slicer keeps its values, a text tile has no query.
    job.still = job.slicer || text;
    // What the format pane offers it (about).
    job.plots = plots;
    job.at = startAt(tile, { wide, mark, plots });
    const name = title || 'this tile';
    const tool = (glyph, tip, label, onclick) => el('button', { type: 'button', class: 'rp-tool', title: tip, 'aria-label': label, onclick }, glyph);
    const heading = el('h2', ctx.rename ? { title: 'Double-click to rename', ondblclick: () => renameIn(job, heading, heading.textContent) } : {}, title);
    job.section = el('section', { class: `rp-tile${job.slicer ? ' rp-slicer-tile' : ''}${mark === 'card' ? ' rp-card-tile' : ''}${text ? ' rp-text-tile' : ''}` },
      el('div', { class: 'rp-head' }, grip, heading,
        ctx.edit && tile.kind === 'pivot' ? tool('✎', 'Edit this visual', `Edit ${name}`, () => ctx.edit(jobs.indexOf(job))) : null,
        ctx.duplicate ? tool('⧉', 'Duplicate', `Duplicate ${name}`, () => ctx.duplicate(jobs.indexOf(job))) : null,
        ctx.remove ? tool('✕', 'Remove from the report', `Remove ${name} from the report`, () => ctx.remove(jobs.indexOf(job))) : null),
      body,
      ctx.layout ? el('button', { type: 'button', class: 'rp-resize', title: 'Drag to resize, or resize with the arrow keys',
        'aria-label': `Resize ${title || 'this tile'}`, onpointerdown: e => dragFrom(e, job, 'size'), onkeydown: e => keyed(e, job, 'size') }, '◢') : null);
    grid.append(job.section);
    styleTile(job);
    if (text) drawText(job);
    return job;
  });

  // The tile's title: none, or its size.
  function styleTile(job) {
    const c = job.section.classList;
    c.toggle('rp-notitle', job.tile.showTitle === false);
    for (const s of ['S', 'L']) c.toggle(`rp-title-${s}`, job.tile.titleSize === s);
  }
  layOut(arrange(jobs.map(j => j.at)));
  pump();

  // A text tile: its Markdown drawn. A host that saves the Report: a double-click edits it in a box
  // in its place, kept by Done (or Ctrl+Enter), put back by Esc.
  function drawText(job) {
    const md = String(job.tile.text ?? '');
    const nodes = markdownNodes(md);
    const shown = el('div', { class: 'rp-text', ...(ctx.setText ? { title: 'Double-click to edit' } : {}) },
      nodes.length ? nodes : el('p', { class: 'rp-say' }, ctx.setText ? 'Double-click to write text.' : ''));
    if (ctx.setText) shown.addEventListener('dblclick', e => { if (!e.target.closest('a')) editText(job); });
    job.body.replaceChildren(shown);
  }
  function editText(job) {
    const box = el('textarea', { class: 'rp-text-edit', 'aria-label': 'Text, in Markdown', spellcheck: 'true' });
    box.value = String(job.tile.text ?? '');
    const done = keep => {
      if (keep && box.value !== String(job.tile.text ?? '')) {
        job.tile = { ...job.tile, text: box.value };
        ctx.setText(jobs.indexOf(job), box.value);
      }
      drawText(job);
    };
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    job.body.replaceChildren(el('div', { class: 'rp-text-editing' }, box,
      el('div', { class: 'rp-text-bar' },
        el('span', { class: 'rp-say' }, '# heading, **bold**, *italic*, [link](https://…), - list'),
        el('button', { type: 'button', class: 'btn-explore primary', onclick: () => done(true) }, 'Done'))));
    box.focus();
  }

  // A double-click on a title: an input in its place; Enter or leaving it keeps what is typed, Esc
  // puts the title back.
  function renameIn(job, heading, was) {
    const input = el('input', { type: 'text', class: 'rp-rename', value: was, 'aria-label': 'Tile title' });
    let done = false;
    const end = keep => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      input.replaceWith(heading);
      if (keep && next && next !== was) { heading.textContent = next; ctx.rename(jobs.indexOf(job), next); }
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); end(true); }
      else if (e.key === 'Escape') { e.preventDefault(); end(false); }
    });
    input.addEventListener('blur', () => end(true));
    heading.replaceWith(input);
    input.focus();
    input.select();
  }

  // The model column a click on this tile filters the others by, with its type; null: no clicks.
  function pickColumn(tile, piv) {
    return tile.kind === 'pivot' && piv?.field ? piv.field : null;
  }
  // What every other tile picked, and the host's filter bar: conditions of this tile's query.
  const whereFor = job => [...(typeof ctx.where === 'function' ? ctx.where(job.tile) : ctx.where ?? []),
    ...[...picks].filter(([j]) => j !== job).flatMap(([j, p]) => pickWhere(j.on.id, p))];
  // --- Where a tile is: its grip drags it anywhere, its ◢ drags its size; arrow keys on either ---
  // A tile with no layout yet: as wide and tall as its kind (and a slicer's style) is, the size an
  // earlier build kept (`size`, in pixels) when it has one, at no place yet (arrange finds one).
  function startAt(tile, { wide, mark, plots }) {
    if (tile.layout && typeof tile.layout === 'object') return { ...tile.layout };
    const style = mark === 'slicer' ? tile.pivot?.slicer : null;
    const rows = mark === 'slicer' ? ({ dropdown: 8, range: 9, buttons: 10 }[style] ?? 28)
      : mark === 'card' ? 10 : tile.kind === 'text' ? 12 : mark === 'calendar' ? 40 : SHAPES.has(mark) ? 36 : wide ? 36 : plots > 1 ? 14 + 18 * plots : 32;
    const w = tile.size?.w ?? (mark === 'slicer' || mark === 'card' ? 3 : wide || tile.kind === 'text' ? COLUMNS : COLUMNS / 2);
    return { x: null, y: null, w, h: tile.size?.h > 0 ? Math.ceil(tile.size.h / ROW) : rows };
  }
  // Each tile where `places` says, in the same order as the tiles.
  function layOut(places) {
    places.forEach((at, i) => {
      const j = jobs[i], s = j.section;
      j.at = at;
      s.style.gridColumn = `${at.x + 1} / span ${at.w}`;
      s.style.gridRow = `${at.y + 1} / span ${at.h}`;
      s.style.setProperty('--rp-h', `${at.h * ROW}px`);
    });
  }
  // The tiles in their new order, top to bottom, kept by the host (ctx.layout).
  function keep() {
    const before = new Map(jobs.map((j, i) => [j, i]));
    jobs.sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x);
    for (const j of jobs) grid.append(j.section);   // the reading order, for the keyboard
    ctx.layout(jobs.map(j => ({ from: before.get(j), layout: { x: j.at.x, y: j.at.y, w: j.at.w, h: j.at.h } })));
  }
  // The grid's cells as drawn now: where its first column starts, and a column's and a row's pitch.
  function cells() {
    const cs = getComputedStyle(grid), r = grid.getBoundingClientRect();
    const gap = parseFloat(cs.columnGap) || 0;
    const left = r.left + parseFloat(cs.paddingLeft), inner = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { left, top: r.top + parseFloat(cs.paddingTop), col: (inner + gap) / COLUMNS };
  }
  // `job` put at `to` (x, y, w, h), and every other tile arranged around it, on screen at once.
  function put(job, to) {
    const i = jobs.indexOf(job);
    const places = jobs.map((j, k) => (k === i ? { ...j.at, ...to } : j.at));
    // Then all of them float up, the one put as well: what is drawn is what is kept.
    layOut(arrange(arrange(places, i)));
  }
  // The grip (`what` 'move') or the ◢ ('size'), dragged: the tile follows the pointer cell by cell.
  function dragFrom(e, job, what) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget, s = job.section;
    const was = jobs.map(j => ({ ...j.at })), g = cells(), r = s.getBoundingClientRect();
    // Where in the tile it was taken, in cells, so the tile does not jump to the pointer.
    const grabX = Math.floor((e.clientX - r.left) / g.col), grabY = Math.floor((e.clientY - r.top) / ROW);
    handle.setPointerCapture(e.pointerId);
    s.classList.add(what === 'move' ? 'rp-dragging' : 'rp-resizing');
    // Over another page's name (ctx.toPage): the tile goes there when dropped.
    let onPage = null;
    const move = m => {
      const c = cells();
      if (what === 'move' && ctx.toPage) {
        onPage = ctx.toPage.at(m.clientX, m.clientY);
        s.classList.toggle('rp-leaving', onPage != null);
        if (onPage != null) return;
      }
      if (what === 'move') {
        put(job, { x: Math.max(0, Math.min(COLUMNS - job.at.w, Math.floor((m.clientX - c.left) / c.col) - grabX)),
          y: Math.max(0, Math.floor((m.clientY - c.top) / ROW) - grabY) });
      } else {
        const box = job.section.getBoundingClientRect();
        put(job, { w: Math.max(1, Math.min(COLUMNS - job.at.x, Math.ceil((m.clientX - box.left) / c.col))),
          h: Math.max(MIN_ROWS, Math.ceil((m.clientY - box.top) / ROW)) });
      }
    };
    const done = () => {
      for (const [t, f] of [['pointermove', move], ['pointerup', done], ['pointercancel', done]]) handle.removeEventListener(t, f);
      s.classList.remove('rp-dragging', 'rp-resizing', 'rp-leaving');
      if (onPage != null) {
        // To another page: this page's grid as it was, and the host moves the tile.
        ctx.toPage.at(null);
        layOut(was);
        ctx.toPage.drop(jobs.indexOf(job), onPage);
        return;
      }
      // Kept when any tile is somewhere else now, the one dragged or one it pushed.
      if (jobs.some((j, i) => ['x', 'y', 'w', 'h'].some(k => j.at[k] !== was[i][k]))) keep();
    };
    for (const [t, f] of [['pointermove', move], ['pointerup', done], ['pointercancel', done]]) handle.addEventListener(t, f);
  }
  // The arrow keys: on the grip a column or a few rows over, on the ◢ a column or a few rows more or less.
  function keyed(e, job, what) {
    const dx = { ArrowLeft: -1, ArrowRight: 1 }[e.key] ?? 0, dy = { ArrowUp: -1, ArrowDown: 1 }[e.key] ?? 0;
    if (!dx && !dy) return;
    e.preventDefault();
    const at = job.at;
    put(job, what === 'move'
      ? { x: Math.max(0, Math.min(COLUMNS - at.w, at.x + dx)), y: Math.max(0, at.y + dy * ROW_KEY) }
      : { w: Math.max(1, Math.min(COLUMNS - at.x, at.w + dx)), h: Math.max(MIN_ROWS, at.h + dy * ROW_KEY) });
    keep();
    e.currentTarget.focus();
  }

  function clear(job) {
    if (job.chart) { resized.unobserve(job.box); job.chart.dispose(); }
    job.chart = job.box = job.repaint = null;
  }
  function say(job, text, cls = '') {
    clear(job);
    job.body.replaceChildren(el('p', { class: `rp-say${cls}` }, text));
  }

  // The tiles waiting to run, top to bottom, `atOnce` at a time: the first time, then those a pick
  // changed. One a pick changes while it runs is stopped (ctx.cancel) or, where the host can't
  // stop it, its answer is dropped; either way it runs again, once it has ended (`busy`).
  function pump() {
    while (!gone && active < atOnce) {
      const job = jobs.find(j => j.dirty && !j.busy);
      if (!job) return;
      job.busy = true;
      active++;
      runTile(job).catch(() => {}).finally(() => { job.busy = false; active--; pump(); });
    }
  }
  async function runTile(job) {
    await ctx.shown?.();
    if (gone) return;
    job.dirty = false;
    say(job, 'Running…');
    try { await drawTile(job); }
    catch (e) {
      if (gone) return;
      // Stopped because the Report was left, or because a pick changed it: again.
      const left = e?.cancelled && ctx.leftWhileRunning?.();
      if (job.dirty || left) { job.dirty = true; say(job, 'Waiting…'); return; }
      say(job, e?.cancelled ? 'Stopped.' : e?.message || String(e), e?.cancelled ? '' : ' error');
      // Stopped by Stop: no more tiles, until a pick asks for them.
      if (e?.cancelled) for (const j of jobs.filter(x => x.dirty)) { j.dirty = false; say(j, 'Stopped.'); }
    }
  }

  // A click's value in `job` (`label`: as the tile shows it), picked, or cleared when it is the
  // pick already. Every other tile runs again.
  function pick(job, field, value, label) {
    const was = picks.get(job);
    if (was && same(was.value, value)) picks.delete(job);
    else picks.set(job, { field, value, label });
    changed(job);
  }
  // A slicer keeps the values it was drawn with whatever is picked, so it does not run again.
  function changed(job) {
    drawChips();
    job.repaint?.();
    for (const j of jobs) if (j !== job && !j.still) { j.dirty = true; say(j, 'Waiting…'); }
    // Stopped only while its query runs: once answered, its drawing is dropped (drawTile).
    if (jobs.some(j => j.busy && j !== job && j.asking && j.dirty)) ctx.cancel?.();
    pump();
  }

  // One chip per pick, `Column = value`, with a ✕ that clears it; none, no bar.
  function drawChips() {
    chips.hidden = !picks.size;
    chips.replaceChildren(...(picks.size ? [el('span', { class: 'rp-filters-say' }, 'Filtered by:')] : []), ...[...picks].map(([job, p]) => {
      const text = p.values || p.range ? `${p.field}: ${p.label}` : `${p.field} = ${p.value == null || p.label === '' ? '(blank)' : p.label}`;
      return el('span', { class: 'rp-chip' }, el('span', {}, text),
        el('button', { type: 'button', class: 'rp-x', title: 'Clear this filter', 'aria-label': `Clear ${text}`,
          onclick: () => { picks.delete(job); changed(job); } }, '✕'));
    }));
  }

  async function drawTile(job) {
    const { tile } = job;
    if (!KINDS.has(tile.kind)) {
      throw new Error(tile.sql != null ? 'Not a Visual tile: build it again in Visual and add it to the report.'
        : `a tile's kind is pivot or text, not ${JSON.stringify(tile.kind)}`);
    }
    return drawPivot(job);
  }

  // A pivot tile: its shelves' query, with the other tiles' picks, drawn as Pivot draws it.
  async function drawPivot(job) {
    const { tile } = job;
    if (!fields) throw new Error('a pivot tile needs the model, and the Report was given none');
    // Its shelves read again, to say what is wrong with them.
    const piv = job.piv ?? pivotQuery(tile.pivot, fields);
    job.piv = piv;
    const sql = piv.sqlWith(whereFor(job));
    job.asking = true;
    let res;
    try { res = await ctx.sql(sql); } finally { job.asking = false; }
    if (gone || job.dirty) return;
    job.res = res;
    await paintPivot(job);
  }

  // A pivot tile's answer (job.res) drawn as Visual draws it, with its format: a field's number
  // style, a table's colours by value, a chart's labels, and the chart's format over it.
  async function paintPivot(job) {
    const { tile, body, res, piv } = job;
    clear(job);
    const f = piv.state.format ?? {};
    if (!res.rows.length) { body.replaceChildren(el('p', { class: 'rp-say' }, 'No rows.')); return; }
    const look = { fields, palette, css: ctx.css ?? (() => ''), ...formatLook(f), valueColors };
    const pickOf = () => {
      if (!job.on) return null;
      const p = picks.get(job);
      return { on: key => pick(job, job.on.column, key[0], key[0] == null ? '' : String(key[0])), active: !!p, value: p?.value };
    };
    // A slicer's pick: its values, or its range; `quiet`, it drew the change itself.
    const selOf = () => ({ style: piv.state.slicer, ...(picks.get(job) ?? {}), onChange: (next, quiet) => {
      if (!next && !picks.has(job)) return;
      if (next) picks.set(job, { field: job.on.column, ...next, label: next.values
        ? (next.values.length > 2 ? `${next.values.length} values` : next.values.map(v => (v == null ? '(blank)' : String(v))).join(', '))
        : `${next.range[0] ?? '…'} – ${next.range[1] ?? '…'}` });
      else picks.delete(job);
      job.quiet = quiet;
      changed(job);
    } });
    const view = () => pivotView(piv.state, res.rows, piv.state.mark, look, pickOf(), job.slicer ? selOf() : null);
    const first = view();
    // A chart needs ECharts first; a table draws as it is.
    const echarts = first.node ? null : await ctx.echarts();
    if (gone || job.dirty || job.res !== res) return;
    let keyAt = null;
    const paint = v => {
      if (v.node) { body.replaceChildren(el('div', { class: 'rp-pivot' }, v.node)); return; }
      keyAt = v.keyAt;
      if (!job.chart) {
        const box = el('div', { class: 'rp-chart' });
        body.replaceChildren(box);
        const chart = echarts.init(box, 'studio');
        Object.assign(job, { chart, box });
        resized.observe(box);
        if (job.on) chart.on('click', e => { const key = e.componentType === 'series' && keyAt?.(e); if (key) pickOf().on(key); });
      }
      const option = formatChart(v.option, f, { textSize });
      job.chart.setOption({ aria: { enabled: true }, ...option }, true);
    };
    // A map draws over the world's outline, read the first time one is drawn.
    if (first.option?.geo && ctx.mapReady) {
      await ctx.mapReady();
      if (gone || job.dirty || job.res !== res) return;
    }
    paint(first);
    job.repaint = () => { if (job.quiet) { job.quiet = false; return; } paint(view()); };
  }

  return {
    destroy() {
      gone = true;
      for (const job of jobs) clear(job);
      resized.disconnect();
      root.replaceChildren();
    },
  };
}
