// =============================================================================
// explore/report.js — a model's Report: tiles, each one SELECT over the model, drawn
// =============================================================================
// The Report is data (site/report.json in Export to Fabric's zip, or the file Studio keeps before
// an export; no tiles before either): { tiles: [{ title, kind, sql, formats?, echarts?,
// wide?, crossFilter? }] }. A tile's SQL is a SELECT over the model, FROM model, in the SQL the SQL
// box takes.
//   kind 'kpi'    one row: each column a figure
//   kind 'bar'    the first column across, every other column a series (also 'line')
//   kind 'table'  the rows as they are
//   kind 'pivot'  no sql: `pivot` is Visual's shelves ({ rows, cols, values, filters, mark, totals,
//                 sort, slicer }, as Add to report saves them), drawn as Visual draws them
//                 (explore.js). Its mark 'slicer' is a slicer: what is picked in it (values, or a
//                 range) filters every other tile, and it does not run again when they change.
// The tiles are laid out on a grid of 12 columns and rows of 10 pixels: `layout` ({ x, y, w, h },
// the column and row a tile starts at, and how many it spans) is where its grip and its ◢ put it.
// Every tile floats up as far as it can, and a tile placed over others pushes them down (arrange);
// a tile with no layout goes in the first place it fits, as wide and tall as its kind is. A host
// that saves the Report places them (`layout`), takes them out (`remove`), copies them
// (`duplicate`), renames them (a double-click on the title: `rename`) and, for a pivot tile, opens
// its shelves in Visual (`edit`).
// `formats`: a column's format string; `echarts` (bar, line): an ECharts option merged over the
// tile's own. A tile that fails says so in its own box, and the rest still draw.
// Cross filtering: a click on a bar, a line's point or a table's row picks that row's first value,
// and every other tile runs again with it as a WHERE on the model column the tile's first column
// is. `crossFilter` names that column when the first is not one ("table"."column"), or is false
// for a tile that takes no clicks. A pivot tile picks its first Rows field (else Columns). The
// tile clicked stays whole, its pick bright; the same click again clears it, as the pick's ✕ above
// the tiles does. Picks in several tiles all apply.
// The same file in the panel and in Export to Fabric's app: the host says how SQL runs (`sql`).
// =============================================================================

import { sqlStr } from '../paths.js';
import { el } from './dom.js';
import { formatValue } from './draw.js';
import { PALETTE } from './theme.js';
import { shiftDate } from './draw.js';
import { autoMark, modelFields, pivotQuery, pivotView } from './explore.js';

const KINDS = new Set(['kpi', 'bar', 'line', 'table', 'pivot']);
// The grid a tile is laid out on: its columns, the height of a row in pixels, the fewest rows a
// tile has, and the rows an arrow key moves or resizes it by.
export const COLUMNS = 12, ROW = 10, MIN_ROWS = 6, ROW_KEY = 2;

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

// A value as the tile says: its column's format string, else a number grouped, at most two decimals.
function formatter(tile) {
  return (column, v) => (tile.formats?.[column] || typeof v !== 'number' ? formatValue(v, tile.formats?.[column])
    : v.toLocaleString('en-US', { maximumFractionDigits: 2 }));
}

// --- Cross filtering: a pick, as a WHERE in a tile's SQL ---------------------------

// A name as SQL over the model writes one: "quoted", [bracketed], `ticked`, or bare.
const NAME = String.raw`"(?:[^"]|"")*"|\[[^\]]*\]|` + '`[^`]*`' + String.raw`|[A-Za-z_]\w*`;
// A column: table.column, 'table'[column] as DAX writes it, or a name alone.
const COLUMN = String.raw`'(?:[^']|'')*'\s*\[[^\]]*\]|(?:${NAME})(?:\s*\.\s*(?:${NAME}))?`;
// The first SELECT item, when it is a column: what follows it is a comma, its alias or FROM.
const FIRST = new RegExp(String.raw`^(?:\s|--[^\n]*|/\*[\s\S]*?\*/)*SELECT\s+(${COLUMN})(?!\w)\s*(?=$|,|AS\b|FROM\b|["\[` + '`' + String.raw`A-Za-z_])`, 'i');
// Bare words a first item can start with that are not a column.
const NOT_COLUMNS = new Set(['ALL', 'DISTINCT', 'CASE', 'NOT', 'NULL', 'TRUE', 'FALSE']);
const unquote = p => (p[0] === '"' ? p.slice(1, -1).replace(/""/g, '"') : p[0] === '[' || p[0] === '`' ? p.slice(1, -1) : p);

/** A column as written: { ref, table, column }, the names unquoted (table null for a name alone); null when it is not one. */
export function columnOf(text) {
  const ref = String(text ?? '').trim();
  if (!new RegExp(`^(?:${COLUMN})$`).test(ref)) return null;
  const dax = /^'((?:[^']|'')*)'\s*\[([^\]]*)\]$/.exec(ref);
  const parts = dax ? [dax[1].replace(/''/g, "'"), dax[2]] : ref.match(new RegExp(NAME, 'g')).map(unquote);
  if (parts.length === 1 && /^[A-Za-z_]/.test(ref) && NOT_COLUMNS.has(ref.toUpperCase())) return null;
  return { ref, table: parts.length === 2 ? parts[0] : null, column: parts[parts.length - 1] };
}

/** The model column a tile's SQL starts with: its first SELECT item, when that is a column (columnOf), else null. */
export function firstColumn(sql) {
  const m = FIRST.exec(String(sql ?? ''));
  return m ? columnOf(m[1]) : null;
}

const NUMBER = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

/**
 * A value as a literal of SQL over the model, by its column's type (the model's dataType, when
 * known): a date's text as DATE (TIMESTAMP when it has a time of day), a number as a number, a
 * boolean as TRUE or FALSE, anything else as quoted text.
 */
export function sqlLiteral(value, type) {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${value} can't be a filter`);
    return type === 'string' ? sqlStr(value) : String(value);
  }
  const s = String(value);
  if (type === 'dateTime') {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?/.exec(s);
    if (m) return m[2] && !/^00:00(?::00)?$/.test(m[2]) ? `TIMESTAMP '${m[1]} ${m[2]}'` : `DATE '${m[1]}'`;
  }
  if ((type === 'int64' || type === 'double' || type === 'decimal') && NUMBER.test(s)) return s;
  if (type === 'boolean' && /^(true|false)$/i.test(s)) return s.toUpperCase();
  return sqlStr(s);
}

// SQL's tokens: where each starts and ends, and the words and semicolons outside parentheses,
// past strings, quoted names and comments.
function tokens(sql) {
  const out = [];
  const n = sql.length;
  let i = 0, depth = 0;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    const at = i;
    let word = null;
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      for (i++; i < n; i++) {
        if (sql[i] !== close) continue;
        if (close !== ']' && sql[i + 1] === close) { i++; continue; }
        break;
      }
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      while (i < n && /[\w$]/.test(sql[i])) i++;
      word = sql.slice(at, i).toUpperCase();
    } else {
      i++;
      if (c === ')') depth--;
    }
    out.push({ at, end: Math.min(i, n), top: depth === 0, word, semi: c === ';' });
    if (c === '(') depth++;
  }
  return out;
}

// What can follow FROM model, a WHERE first.
const CLAUSES = new Set(['WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH']);

// A pick as a condition: { ref, value } is `ref = literal`, or `ref IS NULL` for a blank; a
// slicer's { ref, values } is `ref IN (…)`, with a blank among them `ref IS NULL OR …`, and its
// { ref, range: [lo, hi] } `ref >= lo AND ref <= hi`, either end left out when null: a date's
// last day is kept whole (`< the day after`), as Visual's own filter keeps it. An empty list is
// no condition.
function condition(f) {
  if (Array.isArray(f.range)) {
    const [lo, hi] = f.range;
    const day = f.type === 'dateTime' && hi != null && /^\d{4}-\d{2}-\d{2}/.exec(String(hi));
    return [lo != null ? `${f.ref} >= ${sqlLiteral(lo, f.type)}` : null,
      day ? `${f.ref} < ${sqlLiteral(shiftDate(day[0], 1), f.type)}` : hi != null ? `${f.ref} <= ${sqlLiteral(hi, f.type)}` : null]
      .filter(Boolean).join(' AND ') || null;
  }
  if (!Array.isArray(f.values)) return f.value == null ? `${f.ref} IS NULL` : `${f.ref} = ${sqlLiteral(f.value, f.type)}`;
  const named = f.values.filter(v => v != null);
  const inList = named.length ? `${f.ref} IN (${named.map(v => sqlLiteral(v, f.type)).join(', ')})` : null;
  if (named.length === f.values.length) return inList;
  return inList ? `(${f.ref} IS NULL OR ${inList})` : `${f.ref} IS NULL`;
}

/**
 * A tile's SQL with picks as its WHERE (condition): added after FROM, before GROUP BY and the
 * rest, or ANDed to the WHERE it has, which is put in parentheses.
 */
export function withFilters(sql, filters) {
  const conds = (filters ?? []).map(condition).filter(Boolean);
  if (!conds.length) return sql;
  const cond = conds.join(' AND ');
  const toks = tokens(sql);
  const clause = t => t.top && (CLAUSES.has(t.word) || t.semi);
  const from = toks.findIndex(t => t.top && t.word === 'FROM');
  if (from < 0) throw new Error("the tile's SQL has no FROM, so it can't be filtered");
  const after = (i, ok) => { const j = toks.findIndex((t, k) => k > i && ok(t)); return j < 0 ? toks.length : j; };
  // The end of the token before the i-th: what is inserted goes there, before any comment.
  const endBefore = i => toks[i - 1].end;
  const next = after(from, clause);
  if (toks[next]?.word !== 'WHERE') {
    const at = endBefore(next);
    return `${sql.slice(0, at)} WHERE ${cond}${sql.slice(at)}`;
  }
  const a = toks[next].end, b = endBefore(after(next, t => clause(t) && t.word !== 'WHERE'));
  return `${sql.slice(0, a)} (${sql.slice(a, b).trim()}) AND ${cond}${sql.slice(b)}`;
}

const same = (a, b) => (a ?? null) === (b ?? null);

/**
 * The Report in `root`. `ctx`: sql(text) -> { fields, rows }; echarts() -> ECharts with the theme
 * 'studio' registered; shown() (optional), a promise that settles once the Report is on screen;
 * leftWhileRunning() (optional), whether the host stopped the tile running because the Report was
 * left (and forgets it); cancel() (optional), stops the tile running, when a pick changes it;
 * columnType(table, column) (optional), a model column's dataType (table null: the one column of
 * that name), for a pick's literal; model, the model (model.js's tmslOf), for pivot tiles; css(name)
 * (optional), a CSS token's value, for a pivot's tints; remove(index) (optional), a ✕ on each tile
 * that takes it out of the report; layout(tiles) (optional), a grip on each tile that drags it
 * anywhere on the grid and a ◢ that drags its size (or the arrow keys, on either), drawn there at
 * once: `tiles` is each tile, in its new order (top to bottom), as { from: its index before, layout };
 * duplicate(index) (optional), a ⧉ that copies a tile; rename(index, title) (optional), a double-click
 * on a title that edits it in place; edit(index) (optional), a ✎ on a pivot tile that opens it in Visual.
 * Returns { destroy }.
 * The tiles run one at a time, top to bottom: each is a scan of the model's tables, and the engine
 * gives one query all it has, where several at once share it, keep each other waiting, and keep
 * anything else the tab asks waiting too. A tile waits while the Report is off screen; one stopped
 * (`cancelled`, by the host when the Report was left) runs again when it is back.
 */
export function drawReport(root, spec, ctx) {
  const resized = new ResizeObserver(entries => { for (const e of entries) jobs.find(j => j.box === e.target)?.chart.resize(); });
  const tiles = Array.isArray(spec?.tiles) ? spec.tiles : null;
  const grid = el('div', { class: 'rp' });
  const chips = el('div', { class: 'rp-filters', hidden: true });
  root.replaceChildren(chips, grid);
  if (!tiles) grid.append(el('p', { class: 'rp-say error' }, 'The report has no "tiles" list.'));
  else if (!tiles.length) grid.append(el('p', { class: 'rp-say' }, ctx.remove
    ? 'The report has no tiles yet. Build a view in Visual and click Add to report.' : 'The report has no tiles yet.'));
  let gone = false, pumping = false, running = null;
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
    const plots = piv && mark !== 'heatmap' && mark !== 'scatter' && mark !== 'slicer' ? Math.min(piv.state.values.length, 4) : 1;
    const wide = tile.wide ?? (tile.kind === 'kpi' || tile.kind === 'table' || mark === 'table' || mark === 'highlight' || mark === 'heatmap');
    const title = String(tile.title ?? '');
    const job = { tile, body, piv, on: pickColumn(tile, piv), dirty: true, asking: false, chart: null, box: null, repaint: null };
    const grip = ctx.layout ? el('button', { type: 'button', class: 'rp-tool rp-grip', title: 'Drag to move, or move with the arrow keys',
      'aria-label': `Move ${title || 'this tile'}`, onpointerdown: e => dragFrom(e, job, 'move'), onkeydown: e => keyed(e, job, 'move') }, '⠿') : null;
    job.slicer = mark === 'slicer';
    job.plots = plots;
    job.at = startAt(tile, { wide, mark, plots });
    const name = title || 'this tile';
    const tool = (glyph, tip, label, onclick) => el('button', { type: 'button', class: 'rp-tool', title: tip, 'aria-label': label, onclick }, glyph);
    const heading = el('h2', ctx.rename ? { title: 'Double-click to rename', ondblclick: () => renameIn(job, heading, heading.textContent) } : {}, title);
    job.section = el('section', { class: `rp-tile${job.slicer ? ' rp-slicer-tile' : ''}${mark === 'card' ? ' rp-card-tile' : ''}` },
      el('div', { class: 'rp-head' }, grip, heading,
        ctx.edit && tile.kind === 'pivot' ? tool('✎', 'Edit this visual', `Edit ${name}`, () => ctx.edit(jobs.indexOf(job))) : null,
        ctx.duplicate ? tool('⧉', 'Duplicate', `Duplicate ${name}`, () => ctx.duplicate(jobs.indexOf(job))) : null,
        ctx.remove ? tool('✕', 'Remove from the report', `Remove ${name} from the report`, () => ctx.remove(jobs.indexOf(job))) : null),
      body,
      ctx.layout ? el('button', { type: 'button', class: 'rp-resize', title: 'Drag to resize, or resize with the arrow keys',
        'aria-label': `Resize ${title || 'this tile'}`, onpointerdown: e => dragFrom(e, job, 'size'), onkeydown: e => keyed(e, job, 'size') }, '◢') : null);
    grid.append(job.section);
    return job;
  });
  layOut(arrange(jobs.map(j => j.at)));
  pump();

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
    if (tile.kind === 'kpi' || tile.crossFilter === false) return null;
    const c = tile.kind === 'pivot' ? piv?.field
      : typeof tile.crossFilter === 'string' ? columnOf(tile.crossFilter) : firstColumn(tile.sql);
    return c && { ...c, type: ctx.columnType?.(c.table, c.column) };
  }
  // The picks of every other tile, as withFilters takes them.
  const filtersFor = job => [...picks].filter(([j]) => j !== job)
    .map(([j, p]) => ({ ref: j.on.ref, type: j.on.type, ...(p.values ? { values: p.values } : p.range ? { range: p.range } : { value: p.value }) }));

  // --- Where a tile is: its grip drags it anywhere, its ◢ drags its size; arrow keys on either ---
  // A tile with no layout yet: as wide and tall as its kind (and a slicer's style) is, the size an
  // earlier build kept (`size`, in pixels) when it has one, at no place yet (arrange finds one).
  function startAt(tile, { wide, mark, plots }) {
    if (tile.layout && typeof tile.layout === 'object') return { ...tile.layout };
    const style = mark === 'slicer' ? tile.pivot?.slicer : null;
    const rows = mark === 'slicer' ? ({ dropdown: 8, range: 9, buttons: 10 }[style] ?? 28)
      : mark === 'card' ? 10 : tile.kind === 'kpi' ? 12 : wide ? 36 : plots > 1 ? 14 + 18 * plots : 32;
    const w = tile.size?.w ?? (mark === 'slicer' || mark === 'card' ? 3 : wide ? COLUMNS : COLUMNS / 2);
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
    const move = m => {
      const c = cells();
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
      s.classList.remove('rp-dragging', 'rp-resizing');
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

  // The tiles waiting to run, one at a time, top to bottom: the first time, then those a pick
  // changed. One a pick changes while it runs is stopped (ctx.cancel) or, where the host can't
  // stop it, its answer is dropped; either way it runs again.
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (let job; (job = jobs.find(j => j.dirty));) {
        await ctx.shown?.();
        if (gone) return;
        job.dirty = false;
        running = job;
        say(job, 'Running…');
        try { await drawTile(job); }
        catch (e) {
          if (gone) return;
          // Stopped because the Report was left, or because a pick changed it: again.
          const left = e?.cancelled && ctx.leftWhileRunning?.();
          if (job.dirty || left) { job.dirty = true; say(job, 'Waiting…'); continue; }
          say(job, e?.cancelled ? 'Stopped.' : e?.message || String(e), e?.cancelled ? '' : ' error');
          // Stopped by Stop: no more tiles, until a pick asks for them.
          if (e?.cancelled) for (const j of jobs.filter(x => x.dirty)) { j.dirty = false; say(j, 'Stopped.'); }
        } finally { running = null; }
      }
    } finally { pumping = false; }
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
    for (const j of jobs) if (j !== job && !j.slicer) { j.dirty = true; say(j, 'Waiting…'); }
    // Stopped only while its query runs: once answered, its drawing is dropped (drawTile).
    if (running && running !== job && running.asking && running.dirty) ctx.cancel?.();
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
    const { tile, body } = job;
    if (!KINDS.has(tile.kind)) throw new Error(`a tile's kind is kpi, bar, line, table or pivot, not ${JSON.stringify(tile.kind)}`);
    if (tile.kind === 'pivot') return drawPivot(job);
    if (typeof tile.sql !== 'string' || !tile.sql.trim()) throw new Error('the tile has no sql');
    if (tile.crossFilter != null && tile.crossFilter !== false && !(typeof tile.crossFilter === 'string' && columnOf(tile.crossFilter))) {
      throw new Error(`a tile's crossFilter is a model column ("table"."column") or false, not ${JSON.stringify(tile.crossFilter)}`);
    }
    const sql = withFilters(tile.sql, filtersFor(job));
    job.asking = true;
    let res;
    try { res = await ctx.sql(sql); } finally { job.asking = false; }
    // A pick changed the tile while it ran: this answer is not its own any more.
    if (gone || job.dirty) return;
    clear(job);
    const fmt = formatter(tile);
    if (!res.rows.length) { body.replaceChildren(el('p', { class: 'rp-say' }, 'No rows.')); return; }
    if (tile.kind === 'kpi') {
      const row = res.rows[0];
      body.replaceChildren(el('div', { class: 'rp-kpis' },
        res.fields.map(f => el('div', { class: 'rp-kpi' }, el('span', {}, f), el('b', {}, fmt(f, row[f]))))));
      return;
    }
    const [x, ...ys] = res.fields;
    const pickRow = (r, label) => job.on && pick(job, x, r[x], label);
    if (tile.kind === 'table') {
      const rows = res.rows.map(r => el('tr', job.on ? {
        class: 'rp-pick', tabindex: 0, onclick: () => pickRow(r, fmt(x, r[x])),
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickRow(r, fmt(x, r[x])); } },
      } : {}, res.fields.map(f => el('td', typeof r[f] === 'number' ? { class: 'num' } : {}, fmt(f, r[f])))));
      body.replaceChildren(el('div', { class: 'rp-table' }, el('table', {},
        el('thead', {}, el('tr', {}, res.fields.map(f => el('th', {}, f)))),
        el('tbody', {}, rows))));
      // The pick's row highlighted.
      job.repaint = () => { const p = picks.get(job); res.rows.forEach((r, i) => rows[i].classList.toggle('rp-on', !!p && same(r[x], p.value))); };
      job.repaint();
      return;
    }
    // A chart: the first column across, the others up.
    const box = el('div', { class: 'rp-chart' });
    body.replaceChildren(box);
    const echarts = await ctx.echarts();
    if (gone || job.dirty) return;
    const chart = echarts.init(box, 'studio');
    Object.assign(job, { chart, box });
    resized.observe(box);
    const cats = res.rows.map(r => (r[x] == null ? '(blank)' : String(r[x])));
    // The series' data: with a pick among the rows, its bar or point bright and the others dim; a
    // line marks it too.
    const picked = () => {
      const p = picks.get(job);
      const at = p ? res.rows.findIndex(r => same(r[x], p.value)) : -1;
      return ys.map((f, s) => ({
        data: res.rows.map(r => (at < 0 ? r[f] : { value: r[f], itemStyle: { opacity: same(r[x], p.value) ? 1 : DIM } })),
        ...(tile.kind === 'line' && s === 0
          ? { markLine: { silent: true, symbol: 'none', label: { show: false }, data: at < 0 ? [] : [{ xAxis: cats[at] }] } } : {}),
      }));
    };
    const option = {
      aria: { enabled: true },
      color: PALETTE,
      tooltip: { trigger: 'axis', valueFormatter: v => fmt(ys[0], v) },
      legend: ys.length > 1 ? { top: 0 } : undefined,
      grid: { left: 8, right: 16, top: ys.length > 1 ? 32 : 12, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: cats },
      yAxis: { type: 'value' },
      series: picked().map((s, i) => ({ name: ys[i], type: tile.kind, cursor: job.on ? 'pointer' : 'default', ...s,
        ...(tile.kind === 'line' ? { showSymbol: res.rows.length <= 60 } : {}) })),
    };
    chart.setOption(tile.echarts && typeof tile.echarts === 'object' ? merge(option, tile.echarts) : option);
    if (job.on) chart.on('click', e => { if (e.componentType === 'series' && res.rows[e.dataIndex]) pickRow(res.rows[e.dataIndex], cats[e.dataIndex]); });
    job.repaint = () => chart.setOption({ series: picked() });
  }

  // A pivot tile: its shelves' query, with the other tiles' picks, drawn as Pivot draws it.
  async function drawPivot(job) {
    const { tile, body } = job;
    if (!fields) throw new Error('a pivot tile needs the model, and the Report was given none');
    // Its shelves read again, to say what is wrong with them.
    const piv = job.piv ?? pivotQuery(tile.pivot, fields);
    const sql = withFilters(piv.sql, filtersFor(job));
    job.asking = true;
    let res;
    try { res = await ctx.sql(sql); } finally { job.asking = false; }
    if (gone || job.dirty) return;
    clear(job);
    if (!res.rows.length) { body.replaceChildren(el('p', { class: 'rp-say' }, 'No rows.')); return; }
    const look = { fields, palette: PALETTE, css: ctx.css ?? (() => '') };
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
    if (gone || job.dirty) return;
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
      job.chart.setOption({ aria: { enabled: true }, ...v.option }, true);
    };
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
