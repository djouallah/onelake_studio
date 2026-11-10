// =============================================================================
// explore/explore.js — the Explore page: a pivot of a semantic model, built by dragging its
// fields onto shelves (Rows, Columns, Values, Filters), drawn as a table or a chart
// =============================================================================
// General purpose: it knows no table, column or measure of any model. It reads the fields
// off the model it is given (TMSL: tables, columns, measures, relationships; hidden ones left
// out), and every view is one query in the page's words (`select`, `where`, `totals`,
// `orderBy`, `top`): the figures are the model's measures, a total is a `totals` row. What it
// does with the rows is layout: a row of the result goes in a cell of the pivot or a point of
// a chart. The host passes in how to run a query and how to draw (createExplorer's `ctx`).
// A field's name is the model's, so a table or a column with a dot in its name is read as
// itself.
// =============================================================================

import { formatValue, byValueBackground, extent, stackedGrids, shiftDate } from './draw.js';
import { el } from './dom.js';
import { escapeHtml, quoteIdent as qid, sqlStr, sqlPart as bare } from '../paths.js';

// A tooltip formatter's string is rendered as HTML: anything from the data goes in escaped.
const esc = v => escapeHtml(v == null ? '' : String(v));

const CAP = 5000;             // rows asked for at most
const MAX_CELLS = 200_000;    // cells a pivot's table draws at most
const SERIES_CAP = 24;        // series a chart draws at most
const MULTIPLES = 4;          // measures a chart draws, one plot each
const ROW_TOTAL = '__rows_total', COL_TOTAL = '__columns_total';
const TYPES = { string: 'text', int64: 'number', double: 'number', decimal: 'number', dateTime: 'date', boolean: 'bool' };
const ICONS = { text: 'Abc', number: '#', date: '▦', bool: '◐', measure: 'Σ' };
const MARKS = [['auto', 'Automatic'], ['table', 'Table'], ['highlight', 'Highlight'], ['bar', 'Bar'], ['stacked', 'Stacked'],
  ['line', 'Line'], ['area', 'Area'], ['heatmap', 'Heatmap'], ['scatter', 'Scatter'], ['slicer', 'Slicer'], ['card', 'Card']];
// How a slicer is drawn (slicerView); Range only for a date or a number.
const SLICER_STYLES = [['list', 'List'], ['buttons', 'Buttons'], ['dropdown', 'Dropdown'], ['range', 'Range']];
const SHELVES = [['rows', 'Rows'], ['cols', 'Columns'], ['values', 'Values'], ['filters', 'Filters']];
// A column on Values is summarised, as Power BI does it: a number summed, anything else
// counted; its chip changes the summary. On the shelf it is "\0sum\0Table.Column".
// The summaries SQL over the model has (dax-sql's sql.js: SUM, AVG, MIN, MAX, COUNT, COUNT
// DISTINCT), so no median.
const AGGS = [['sum', 'Sum'], ['avg', 'Average'], ['min', 'Min'], ['max', 'Max'],
  ['count', 'Count'], ['distinct', 'Count (distinct)']];
const AGG_LABEL = Object.fromEntries(AGGS);
const AGG_SQL = { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX', count: 'COUNT', distinct: 'COUNT' };
const NUMBERS_ONLY = new Set(['sum', 'avg']);
const aggId = (agg, col) => `\u0000${agg}\u0000${col}`;
export const aggOf = id => { const m = /^\u0000(\w+)\u0000([\s\S]+)$/.exec(id); return m ? { agg: m[1], col: m[2] } : null; };
const defaultAgg = f => f.type === 'number' ? 'sum' : 'count';
// Totals are off until asked for. `v` 2: shelves saved before that kept totals on by
// default, so their `totals` is not read back.
const EMPTY = () => ({ v: 2, rows: [], cols: [], values: [], filters: [], mark: 'auto', totals: false, sort: 'fields', slicer: 'list' });

// =============================================================================
// The model's fields, the query, the pivot: no DOM
// =============================================================================

// Tables with their visible columns and measures, dimensions first (a dimension is a table a
// relationship points to: the model says it, not the names). A hidden table hides all it holds,
// its measures too, as Power BI does.
export function modelFields(model) {
  const dims = new Set((model.relationships ?? []).map(r => r.toTable));
  const tables = (model.tables ?? []).filter(t => !t.isHidden).map(t => ({
    // A model of one table (a lakehouse table's Pivot) has neither.
    name: t.name, dimension: dims.has(t.name), kind: dims.size ? (dims.has(t.name) ? 'dimension' : 'fact') : null,
    columns: (t.columns ?? []).filter(c => !c.isHidden && c.type !== 'rowNumber').map(c => ({ id: `${t.name}.${c.name}`, kind: 'column', table: t.name,
      name: c.name, type: TYPES[c.dataType] ?? 'text', format: c.formatString, description: c.description,
      // A column the host worked out from another (a table's date grains), not one the data has.
      derived: c.derivedFrom ? { from: c.derivedFrom, as: c.derivedAs ?? c.name } : null })),
    measures: (t.measures ?? []).filter(m => !m.isHidden).map(m => ({ id: m.name, kind: 'measure', table: t.name,
      name: m.name, type: 'measure', format: m.formatString, description: m.description })),
  })).filter(t => t.columns.length || t.measures.length)
    .sort((a, b) => Number(b.dimension) - Number(a.dimension) || a.name.localeCompare(b.name));
  const byId = new Map(tables.flatMap(t => [...t.columns, ...t.measures]).map(f => [f.id, f]));
  NAMES = new Map([...byId].map(([id, f]) => [id, f.name]));
  return { tables, byId };
}

// A field's name, as the model has it: the last model read says (one model view is open at a
// time). An id it does not know, a chip saved for a field the model has since dropped, is
// read as Table.Column.
let NAMES = new Map();
const nameOf = id => {
  const a = aggOf(id);
  if (a) return `${AGG_LABEL[a.agg] ?? a.agg} of ${nameOf(a.col)}`;
  return NAMES.get(id) ?? (id.includes('.') ? id.slice(id.indexOf('.') + 1) : id);
};

// A filter as conditions of the query's `where`. "Last n days" ends today, as Tableau's
// relative dates do (a calendar may run into the future, so not its newest date).
function conditions(f, today) {
  switch (f.op) {
    case 'in': case 'notIn': return f.values?.length ? [[f.field, f.op, f.values]] : [];
    case 'range': return [...(f.min != null && f.min !== '' ? [[f.field, '>=', f.min]] : []),
      ...(f.max != null && f.max !== '' ? [[f.field, '<=', f.max]] : [])];
    case 'last': {
      return f.n > 0 ? [[f.field, 'between', shiftDate(today, 1 - f.n), today]] : [];
    }
    case 'blank': case 'notBlank': return [[f.field, f.op]];
  }
  return [];
}

// The shelves as one query. `cap`: the rows asked for at most (0: all, for the CSV).
// A card is its Values over every row its filters keep: its Rows and Columns are left out.
const localToday = () => new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD
export function buildQuery(s, { cap = CAP, today = localToday() } = {}) {
  if (!s.rows.length && !s.cols.length && !s.values.length) return null;
  if (s.mark === 'card') {
    if (!s.values.length) throw new Error('A card shows the fields on Values: put a measure there.');
    s = { ...s, rows: [], cols: [], totals: false };
  }
  const dims = [...s.rows, ...s.cols];
  const select = {};
  for (const id of [...dims, ...s.values]) {
    const name = nameOf(id);
    if (Object.hasOwn(select, name)) throw new Error(`two fields are named ${name}: keep one of them`);
    const a = aggOf(id);
    select[name] = a ? { [a.agg]: a.col } : id;
  }
  const q = { select };
  const where = s.filters.flatMap(f => conditions(f, today));
  if (where.length) q.where = where;
  if (s.totals && s.values.length && dims.length) {
    q.totals = {};
    if (s.rows.length) q.totals[ROW_TOTAL] = [...s.rows];
    if (s.cols.length) q.totals[COL_TOTAL] = [...s.cols];
  }
  const order = s.sort === 'desc' && s.values.length ? [[nameOf(s.values[0]), 'desc'], ...dims.map(nameOf)] : dims.map(nameOf);
  if (order.length) q.orderBy = order;
  if (cap && order.length) q.top = cap;
  return q;
}

// The query as a SELECT over the model, in dax-sql's SQL: the model's columns
// ("table"."column") and its measures as AGG("name"), a summarised column as SUM(…) and its
// kin, FROM the model, WHERE, GROUP BY ALL or ROLLUP for a total (GROUPING names it), ORDER BY,
// FETCH FIRST n ROWS WITH TIES. What Explore runs and what Show SQL shows: the compiler builds
// the same plan from it as from DAX. `column(id)`: the model's column of an id, { table, name },
// or null (a measure); `from`: the model's name in SQL.
// Names are quoted, and summaries are aggregates.
// `plain`: { from, measure(name), column(name, quote)? } for SQL over one table as a person
// writes it (a lakehouse table's Edit SQL): its columns by name alone, quoted only where DuckDB
// needs it (or as `column` writes one: a date's grain), AS only for a new name, DISTINCT for
// columns alone, each measure as `measure` says, LIMIT for the cap.
// A YYYY-MM-DD value is a DATE literal for a date column (or one whose type is not known); a
// text column that holds such strings compares them as text.
const sqlVal = (v, type) => v == null ? 'NULL' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? String(v)
  : (!type || type === 'date') && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `DATE ${sqlStr(v)}` : sqlStr(v);
export function modelSql(q, column, from = 'model', plain = null) {
  const ref = id => {
    const c = column(id);
    if (!c) throw new Error(`${id} is not a column of the model`);
    return plain ? plain.column?.(c.name, bare) ?? bare(c.name) : `${qid(c.table)}.${qid(c.name)}`;
  };
  const name = plain ? bare : qid;
  const isColumn = x => typeof x === 'string' && !!column(x);
  const expr = x => {
    if (isColumn(x)) return ref(x);
    if (typeof x === 'string') return plain?.measure(x) ?? `AGG(${qid(x)})`;
    const [agg, col] = Object.entries(x)[0];
    return `${AGG_SQL[agg]}(${agg === 'distinct' ? 'DISTINCT ' : ''}${ref(col)})`;
  };
  const cond = ([col, op, ...a]) => {
    const c = ref(col);
    const type = column(col)?.type;
    const val = v => sqlVal(v, type);
    const named = vs => vs.filter(v => v != null), blank = vs => vs.some(v => v == null);
    const list = vs => `(${vs.map(val).join(', ')})`;
    // A DATE as an upper bound on a timestamp means its midnight, and leaves that day's rows out.
    const dayAfter = v => (val(v).startsWith('DATE ') && !isNaN(Date.parse(v))
      ? val(new Date(Date.parse(`${v}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)) : null);
    switch (op) {
      case 'between': return dayAfter(a[1]) ? `${c} >= ${val(a[0])} AND ${c} < ${dayAfter(a[1])}` : `${c} BETWEEN ${val(a[0])} AND ${val(a[1])}`;
      case '<=': return dayAfter(a[0]) ? `${c} < ${dayAfter(a[0])}` : `${c} <= ${val(a[0])}`;
      case 'blank': return `${c} IS NULL`;
      case 'notBlank': return `${c} IS NOT NULL`;
      case 'in': {
        const n = named(a[0]);
        if (!blank(a[0])) return `${c} IN ${list(n)}`;
        return n.length ? `(${c} IS NULL OR ${c} IN ${list(n)})` : `${c} IS NULL`;
      }
      case 'notIn': {
        const n = named(a[0]);
        return [...(n.length ? [`(${c} NOT IN ${list(n)} OR ${c} IS NULL)`] : []), ...(blank(a[0]) ? [`${c} IS NOT NULL`] : [])].join(' AND ');
      }
      default: return `${c} ${op} ${val(a[0])}`;
    }
  };
  const rollup = q.totals ?? {}, rolled = Object.values(rollup).flat();
  const as = (n, x) => plain && isColumn(x) && ref(x) === name(n) ? '' : ` AS ${name(n)}`;
  const items = [...Object.entries(q.select).map(([n, x]) => `${expr(x)}${as(n, x)}`),
    // The pivot's marks of its total rows; SQL by hand reads a total by its NULL.
    ...(plain ? [] : Object.entries(rollup).map(([n, cols]) => `GROUPING(${ref(cols[0])}) AS ${qid(n)}`))];
  const keys = Object.values(q.select).filter(isColumn).filter(c => !rolled.includes(c)).map(ref);
  const columnsOnly = Object.values(q.select).every(isColumn);
  const group = rolled.length
    ? `GROUP BY ${[...keys, ...Object.values(rollup).map(cols => `ROLLUP(${cols.length > 1 ? `(${cols.map(ref).join(', ')})` : ref(cols[0])})`)].join(', ')}`
    : plain && columnsOnly ? '' : Object.values(q.select).some(isColumn) ? 'GROUP BY ALL' : '';
  const order = (q.orderBy ?? []).map(o => Array.isArray(o) ? `${name(o[0])} ${o[1].toUpperCase()}` : name(o));
  const distinct = plain && columnsOnly && !rolled.length ? 'DISTINCT ' : '';
  return [`SELECT ${distinct}${items.join(', ')}`, `FROM ${plain ? plain.from : from}`,
    q.where?.length ? `WHERE ${q.where.map(cond).join('\n  AND ')}` : '', group,
    order.length ? `ORDER BY ${order.join(', ')}` : '',
    q.top == null ? '' : plain ? `LIMIT ${q.top}` : `FETCH FIRST ${q.top} ROWS WITH TIES`].filter(Boolean).join('\n');
}

// Order of the keys of an axis: numbers as numbers, text as a person sorts it.
const compare = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (x == null) return -1;
    if (y == null) return 1;
    const c = typeof x === 'number' && typeof y === 'number' ? Math.sign(x - y) : String(x).localeCompare(String(y), undefined, { numeric: true });
    if (c) return c;
  }
  return 0;
};

// The rows of the query laid out: the row keys (in the query's order), the column keys
// (sorted), and the row of the result at a pair of them (null for a total).
export function pivot(rows, s) {
  const rowNames = s.rows.map(nameOf), colNames = s.cols.map(nameOf);
  const key = a => a ? JSON.stringify(a) : '*';
  const rowKeys = new Map(), colKeys = new Map(), cells = new Map();
  for (const r of rows) {
    const a = r[ROW_TOTAL] ? null : rowNames.map(n => r[n]);
    const b = r[COL_TOTAL] ? null : colNames.map(n => r[n]);
    if (a) rowKeys.set(key(a), a);
    if (b) colKeys.set(key(b), b);
    cells.set(`${key(a)}|${key(b)}`, r);
  }
  return {
    rowKeys: [...rowKeys.values()],
    colKeys: [...colKeys.values()].sort(compare),
    cell: (a, b) => cells.get(`${key(a)}|${key(b)}`),
    hasRowTotal: rows.some(r => r[ROW_TOTAL]),
    hasColTotal: rows.some(r => r[COL_TOTAL]),
  };
}

// The mark drawn when none is picked, as Tableau's Show Me picks it.
export function autoMark(s, fields) {
  if (!s.values.length) return 'table';
  if (!s.rows.length && !s.cols.length) return 'card';
  if (s.rows.length && s.cols.length) return s.values.length === 1 ? 'highlight' : 'table';
  const x = fields.byId.get(s.rows[0] ?? s.cols[0]);
  return x?.type === 'date' || x?.type === 'number' ? 'line' : 'bar';
}

// =============================================================================
// The page
// =============================================================================

const label = a => a.length ? a.map(v => v == null ? '(blank)' : String(v)).join(' · ') : 'All';

// A field of the shelves: the model's, or a column summarised on Values, which acts as a
// measure of the view's own.
function shelfField(fields, id) {
  const a = aggOf(id);
  if (!a) return fields?.byId.get(id);
  const c = fields?.byId.get(a.col);
  return c && { id, kind: 'measure', type: 'measure', name: nameOf(id), agg: a.agg, column: c,
    format: a.agg === 'count' || a.agg === 'distinct' ? '#,0' : c.format };
}
/** The names the shelves' Values have in their query's rows (a Report's format pane lists them). */
export const valueNames = s => (s?.values ?? []).map(nameOf);
// A field's format string: a Report tile's own for its name (look.formats), else the model's.
const formatOf = (look, id) => look?.formats?.[nameOf(id)] ?? shelfField(look?.fields, id)?.format;

/**
 * A Report's tile of saved shelves: { state }, every shelf there, { sql }, the SELECT over the
 * model (FROM model) it runs, and { field }, the model column of its first Rows field (else
 * Columns) that a click on it picks, or null.
 */
export function pivotQuery(saved, fields) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error("a pivot tile's pivot is the shelves: { rows, cols, values, filters, mark }");
  const state = { ...EMPTY(), ...saved };
  for (const k of ['rows', 'cols', 'values', 'filters']) if (!Array.isArray(state[k])) throw new Error(`a pivot tile's ${k} is a list`);
  const q = buildQuery(state);
  if (!q) throw new Error("the tile's pivot has no fields on its shelves");
  const columnOf = id => { const f = fields.byId.get(id); return f && f.kind === 'column' ? { table: f.table, name: f.name, type: f.type } : null; };
  // A card has no rows to click: it picks nothing.
  const first = state.mark === 'card' ? null : columnOf(state.rows[0] ?? state.cols[0]);
  return { state, sql: modelSql(q, columnOf, 'model'), field: first && { table: first.table, column: first.name, ref: `${qid(first.table)}.${qid(first.name)}` } };
}

/** What a Report's tile of these shelves is called: its values by its rows and columns. */
export function pivotTitle(s) {
  const names = ids => ids.map(nameOf).join(', ');
  // A slicer is named for what it slices.
  if (s.mark === 'slicer' && (s.rows[0] ?? s.cols[0])) return nameOf(s.rows[0] ?? s.cols[0]);
  const dims = [...s.rows, ...s.cols];
  return s.values.length && dims.length ? `${names(s.values)} by ${names(dims)}` : names(s.values.length ? s.values : dims);
}

// A Report's tile's other bars, points and cells, while one of its rows is picked.
const DIM = 0.3;
const same = (a, b) => (a ?? null) === (b ?? null);

/**
 * The rows of the shelves' query drawn as `mark` says ('auto': autoMark's), the Pivot page's
 * and a Report's tile's alike: { node }, a table or why there is none, or { option, keyAt }, an
 * ECharts option and the row key of a click on it (null: none). `s`: the shelves the rows are
 * of; `look`: { fields, palette, css, styles?, formats?, byValue?, labels? } — a Report tile's
 * own: `formats`, a format string by a field's name, over the model's; `byValue`, a table's
 * measures coloured by their value, 'background' or 'bar', by name; `labels`, a chart's values
 * written on it. `pick` (a Report's tile): { on(key), active,
 * value } — what a click on a row key calls, and the first field's value picked: its row bright,
 * the others dim. `sel`: a slicer's (slicerView).
 */
export function pivotView(s, rows, mark, look, pick = null, sel = null) {
  const shown = mark === 'auto' ? autoMark(s, look.fields) : mark;
  if (shown === 'slicer') return { node: slicerView(s, rows, look, sel ?? { style: s.slicer, onChange() {} }) };
  if (shown === 'card') return { node: cardView(s, rows, look) };
  const piv = pivot(rows, s);
  if (shown === 'table' || shown === 'highlight' || !s.values.length) return { node: pivotTable(s, piv, shown === 'highlight', look, pick) };
  const out = pivotChart(s, piv, shown, look, pick);
  return typeof out === 'string' ? { node: el('div', { class: 'ex-empty' }, out) } : out;
}

// A card: each field on Values as one figure, from the one row its query answers (buildQuery
// leaves its Rows and Columns out), in its format, else grouped with at most two decimals. Its
// name is under it only when there are several: a Report's tile is titled for one.
function cardView(s, rows, look) {
  const row = rows[0] ?? {}, many = s.values.length > 1;
  const text = id => {
    const v = row[nameOf(id)], format = formatOf(look, id);
    return v == null ? '(blank)' : typeof v === 'number' && !format ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : formatValue(v, format);
  };
  return el('div', { class: `card-figures${many ? ' card-many' : ''}` }, s.values.map(id =>
    el('div', { class: 'card-figure' }, el('b', {}, text(id)), many ? el('span', {}, nameOf(id)) : null)));
}

// A slicer: the values of the first Rows field (else Columns) as the rows have them, in the query's
// order, each with the first measure's figure (a value with none is not in the rows), drawn as
// `sel.style` says: a list to tick, buttons, a dropdown of the list, or a range for a date or a
// number. `sel`: { style, values, range, onChange(next, quiet) }, `next` { values } or { range:
// [lo, hi] } (null: nothing picked); `quiet`: the slicer has drawn the change itself. A Report's
// tile filters by it; the Visual page's only shows it. `look.styles` ({ value, set(style) }, the
// Visual page): a switch of the styles over it.
function slicerView(s, rows, look, sel) {
  const id = s.rows[0] ?? s.cols[0];
  const field = id && look.fields.byId.get(id);
  if (!field) return el('div', { class: 'ex-empty' }, 'A slicer needs a column on Rows.');
  const name = nameOf(id), m = s.values[0];
  const fmt = v => formatValue(v, formatOf(look, m));
  const figures = new Map();
  for (const r of rows) if (!r[ROW_TOTAL] && !r[COL_TOTAL] && !figures.has(r[name])) figures.set(r[name], m ? r[nameOf(m)] : null);
  const values = [...figures.keys()];
  const shown = v => (v == null ? '(blank)' : String(v));
  const ranged = field.type === 'date' || field.type === 'number';
  const style = SLICER_STYLES.some(([k]) => k === sel.style) && (sel.style !== 'range' || ranged) ? sel.style : 'list';
  const ticked = new Set(sel.values ?? []);
  const commit = () => { const vs = values.filter(v => ticked.has(v)); sel.onChange(vs.length ? { values: vs } : null, true); };

  // The list, with a search and Clear; `after` once a box changes (the dropdown's summary).
  function listOf(after = () => {}) {
    const find = el('input', { type: 'search', placeholder: 'Search values', 'aria-label': `Search the values of ${name}` });
    const list = el('div', { class: 'ex-values' });
    const draw = () => {
      const term = find.value.trim().toLowerCase();
      list.replaceChildren(...values.filter(v => shown(v).toLowerCase().includes(term)).map(v => {
        const box = el('input', { type: 'checkbox', checked: ticked.has(v) });
        box.addEventListener('change', () => { if (box.checked) ticked.add(v); else ticked.delete(v); commit(); after(); });
        return el('label', {}, box, el('span', { class: 'slicer-value' }, shown(v)), m ? el('span', { class: 'slicer-figure' }, fmt(figures.get(v))) : null);
      }));
    };
    find.addEventListener('input', draw);
    draw();
    const clear = el('button', { type: 'button', class: 'btn-explore', onclick: () => { ticked.clear(); draw(); commit(); after(); } }, 'Clear');
    return el('div', { class: 'rp-slicer' }, el('div', { class: 'rp-slicer-bar' }, find, clear), list);
  }
  function buttons() {
    const pills = values.map(v => {
      const b = el('button', { type: 'button', class: 'slicer-pill', 'aria-pressed': String(ticked.has(v)) }, shown(v));
      b.addEventListener('click', () => { if (ticked.has(v)) ticked.delete(v); else ticked.add(v); b.setAttribute('aria-pressed', String(ticked.has(v))); commit(); });
      return b;
    });
    const clear = el('button', { type: 'button', class: 'btn-explore', onclick: () => {
      ticked.clear(); for (const b of pills) b.setAttribute('aria-pressed', 'false'); commit(); } }, 'Clear');
    return el('div', { class: 'slicer-pills' }, pills, clear);
  }
  // A button that says what is picked, opening the list in a small window under it.
  function dropdown() {
    const say = () => `${name}: ${!ticked.size ? 'All' : ticked.size === 1 ? shown([...ticked][0]) : `${ticked.size} selected`} ▾`;
    const b = el('button', { type: 'button', class: 'slicer-drop', 'aria-haspopup': 'dialog' }, say());
    let pop = null;
    const close = () => { pop?.remove(); pop = null; document.removeEventListener('pointerdown', outside, true); };
    const outside = e => { if (pop && !pop.contains(e.target) && !b.contains(e.target)) close(); };
    b.addEventListener('click', () => {
      if (pop) { close(); return; }
      pop = el('div', { class: 'ex-pop slicer-drop-pop', role: 'dialog', 'aria-label': name }, listOf(() => { b.textContent = say(); }));
      pop.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); b.focus(); } });
      document.body.append(pop);
      const r = b.getBoundingClientRect();
      pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
      pop.style.top = `${Math.max(8, Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8))}px`;
      pop.querySelector('input')?.focus();
      setTimeout(() => { if (pop) document.addEventListener('pointerdown', outside, true); });
    });
    return el('div', { class: 'slicer-dropdown' }, b);
  }
  // From and To, each optional: a date's or a number's own input, the values' ends as hints.
  function range() {
    const type = field.type === 'date' ? 'date' : 'number';
    const ends = values.filter(v => v != null).map(v => (type === 'date' ? String(v).slice(0, 10) : v));
    const hint = i => (ends.length ? String(i ? ends.reduce((a, b) => (b > a ? b : a)) : ends.reduce((a, b) => (b < a ? b : a))) : '');
    const box = i => el('input', { type, step: 'any', value: sel.range?.[i] ?? '', placeholder: hint(i), 'aria-label': `${name} ${i ? 'to' : 'from'}` });
    const from = box(0), to = box(1);
    const read = x => (x.value === '' ? null : type === 'number' ? Number(x.value) : x.value);
    const send = () => { const r = [read(from), read(to)]; sel.onChange(r[0] == null && r[1] == null ? null : { range: r }, true); };
    for (const x of [from, to]) x.addEventListener('change', send);
    const clear = el('button', { type: 'button', class: 'btn-explore', onclick: () => { from.value = ''; to.value = ''; send(); } }, 'Clear');
    return el('div', { class: 'rp-slicer slicer-range' }, el('label', {}, 'From', from), el('label', {}, 'To', to), clear);
  }

  const body = style === 'buttons' ? buttons() : style === 'dropdown' ? dropdown() : style === 'range' ? range() : listOf();
  if (!look.styles) return body;
  const switcher = el('div', { class: 'subtabs slicer-styles', role: 'radiogroup', 'aria-label': 'Slicer style' },
    SLICER_STYLES.map(([k, t]) => el('button', { type: 'button', class: `subtab${k === style ? ' active' : ''}`, role: 'radio',
      'aria-checked': String(k === style), disabled: k === 'range' && !ranged, title: k === 'range' && !ranged ? 'For a date or a number column' : null,
      onclick: () => look.styles.set(k) }, t)));
  return el('div', { class: 'slicer-view' }, switcher, body);
}

// A key not picked, while a pick is on.
const dimmed = (pick, key) => !!pick?.active && !same(key?.[0], pick.value);

function pivotTable(s, piv, highlight, look, pick) {
  const { palette } = look;
  const fmt = (id, v) => formatValue(v, formatOf(look, id));
  const measures = s.values, rowNames = s.rows.map(nameOf);
  const colKeys = [...piv.colKeys, ...(s.cols.length && piv.hasColTotal ? [null] : [])];
  const rowKeys = [...piv.rowKeys, ...(piv.hasRowTotal ? [null] : [])];
  // Every cell is an element, and nothing here draws only what is in view.
  const cells = rowKeys.length * Math.max(colKeys.length, 1) * Math.max(measures.length, 1);
  if (cells > MAX_CELLS) {
    return el('div', { class: 'ex-empty ex-error' },
      `${rowKeys.length.toLocaleString()} rows by ${colKeys.length.toLocaleString()} columns is too many cells to draw: add a filter, or move a column to Rows.`);
  }
  const tint = palette[0];
  // Only for the highlight, which reads them: every cell is two string keys here.
  // A Report tile's measures coloured by value (look.byValue): 'background' tints as the highlight
  // does, 'bar' fills the cell from the left, as far as its value is of the largest.
  const by = m => (highlight ? 'background' : look.byValue?.[nameOf(m)]);
  const ranges = Object.fromEntries(measures.filter(by).map(m => [m, extent(piv.rowKeys.flatMap(a => (s.cols.length ? piv.colKeys : [[]]).map(b => piv.cell(a, b)?.[nameOf(m)])))]));
  const t = el('table', { class: 'explore-table ex-pivot' });
  const head = el('thead');
  // One header line per column field, then the measures' names when there are several (or no column field).
  const lead = text => el('th', { class: 'ex-rowhead', scope: 'col' }, text);
  for (let level = 0; level < s.cols.length; level++) {
    const tr = el('tr');
    // The column field's name, before its values.
    rowNames.forEach((n, i) => tr.append(lead(i === rowNames.length - 1 ? `${nameOf(s.cols[level])} →` : '')));
    if (!rowNames.length) tr.append(lead(`${nameOf(s.cols[level])} →`));
    for (const b of colKeys) tr.append(el('th', { colspan: measures.length || 1, class: 'ex-colhead' }, b ? label([b[level]]) : level ? '' : 'Total'));
    head.append(tr);
  }
  // The row fields' names, and the measure each column holds.
  if (measures.length || !s.cols.length) {
    const tr = el('tr');
    rowNames.forEach(n => tr.append(lead(n)));
    if (!rowNames.length && s.cols.length) tr.append(lead(''));
    for (const b of s.cols.length ? colKeys : [[]]) for (const m of measures) tr.append(el('th', { class: 'ex-num' }, nameOf(m)));
    head.append(tr);
  }
  const body = el('tbody');
  let prev = [];
  for (const a of rowKeys) {
    // A Report's tile picks a row by its first field's value: a total row picks nothing.
    const picks = pick && a && rowNames.length;
    const tr = el('tr', { class: [a ? '' : 'ex-total', picks ? 'rp-pick' : '', picks && pick.active && same(a[0], pick.value) ? 'rp-on' : ''].filter(Boolean).join(' '),
      ...(picks ? { tabindex: 0, onclick: () => pick.on(a),
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick.on(a); } } } : {}) });
    if (a) {
      a.forEach((v, i) => {
        const repeat = prev.length > i && a.slice(0, i + 1).every((v2, j) => prev[j] === v2);
        tr.append(el('th', { scope: 'row', class: repeat ? 'ex-repeat' : '' }, v == null ? '(blank)' : String(v)));
      });
      prev = a;
    } else if (rowNames.length) {
      tr.append(el('th', { scope: 'row', colspan: rowNames.length }, 'Total'));
    }
    if (!rowNames.length && s.cols.length) tr.append(el('th', { scope: 'row' }, ''));
    for (const b of s.cols.length ? colKeys : [[]]) {
      const r = piv.cell(a, b);
      for (const m of measures) {
        const v = r?.[nameOf(m)];
        const td = el('td', { class: 'ex-num' }, fmt(m, v));
        if (ranges[m] && a && b) td.style.background = byValueBackground(by(m), v, ranges[m], tint);
        tr.append(td);
      }
    }
    body.append(tr);
  }
  t.append(head, body);
  return t;
}

function pivotChart(s, piv, mark, look, pick) {
  const { fields, palette, css } = look;
  const fmt = (id, v) => formatValue(v, formatOf(look, id));
  const color = i => palette[i % palette.length];
  // The categories are the row keys; with no row field, the column keys are.
  const byCols = !s.rows.length;
  const cats = byCols ? piv.colKeys : piv.rowKeys;
  const series = byCols ? [[]] : piv.colKeys.length ? piv.colKeys : [[]];
  const at = (cat, ser) => byCols ? piv.cell([], cat) : piv.cell(cat, ser);
  const shown = series.slice(0, SERIES_CAP);
  const cut = series.length > SERIES_CAP ? ` (the first ${SERIES_CAP} of ${series.length} series)` : '';
  // A point's value, dim when a pick is on and its key is not the one picked.
  const point = (key, value) => (dimmed(pick, key) ? { value, itemStyle: { opacity: DIM } } : value);

  if (mark === 'heatmap') {
    if (!s.rows.length || !s.cols.length) return 'A heatmap needs a field on Rows and one on Columns.';
    const m = s.values[0], n = nameOf(m);
    const cells = [];
    piv.rowKeys.forEach((a, y) => piv.colKeys.forEach((b, x) => { const v = piv.cell(a, b)?.[n]; if (v != null) cells.push(point(a, [x, y, v])); }));
    const [lo, hi] = extent(cells.map(c => (c.value ?? c)[2]));
    return {
      option: {
        title: { text: nameOf(m) + cut, left: 4, top: 0, textStyle: { fontSize: 12, fontWeight: 600 } },
        tooltip: { position: 'top', formatter: p => `${esc(label(piv.rowKeys[p.value[1]]))} · ${esc(label(piv.colKeys[p.value[0]]))}<br><b>${esc(fmt(m, p.value[2]))}</b>` },
        grid: { left: 4, right: 16, top: 28, bottom: 44, containLabel: true },
        xAxis: { type: 'category', data: piv.colKeys.map(label), splitArea: { show: true } },
        yAxis: { type: 'category', data: piv.rowKeys.map(label), inverse: true, splitArea: { show: true } },
        visualMap: { min: lo, max: hi, calculable: true, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 120,
          inRange: { color: [css('--raised'), color(0)] }, formatter: v => fmt(m, v) },
        series: [{ type: 'heatmap', data: cells, label: { show: cells.length <= 150, formatter: p => fmt(m, p.value[2]), fontSize: 10 } }],
      },
      keyAt: e => piv.rowKeys[e.value?.[1]] ?? null,
    };
  }
  if (mark === 'scatter') {
    if (s.values.length < 2) return 'A scatter needs two measures on Values: the first across, the second up.';
    const [mx, my] = s.values, [nx, ny] = [nameOf(mx), nameOf(my)];
    // Each series' points' keys, in the order of its data.
    const keys = shown.map(b => cats.filter(a => { const r = at(a, b); return r?.[nx] != null && r?.[ny] != null; }));
    return {
      option: {
        tooltip: { trigger: 'item', formatter: p => `${esc(p.data.name)}<br>${esc(nameOf(mx))}: <b>${esc(fmt(mx, p.data.value[0]))}</b><br>${esc(nameOf(my))}: <b>${esc(fmt(my, p.data.value[1]))}</b>` },
        legend: shown.length > 1 ? { type: 'scroll', top: 0 } : undefined,
        grid: { left: 4, right: 16, top: shown.length > 1 ? 56 : 32, bottom: 24, containLabel: true },
        xAxis: { type: 'value', name: nameOf(mx) + cut, nameLocation: 'middle', nameGap: 26, scale: true, axisLabel: { formatter: v => fmt(mx, v) } },
        yAxis: { type: 'value', name: nameOf(my), scale: true, axisLabel: { formatter: v => fmt(my, v) } },
        series: shown.map((b, i) => ({
          type: 'scatter', name: label(b), symbolSize: 8, itemStyle: { color: color(i), opacity: 0.8 },
          data: keys[i].map(a => { const r = at(a, b); return { name: label(a), value: [r[nx], r[ny]], ...(dimmed(pick, a) ? { itemStyle: { opacity: DIM } } : {}) }; }),
        })),
      },
      keyAt: e => keys[e.seriesIndex]?.[e.dataIndex] ?? null,
    };
  }
  // Bar, stacked bar, line, area: one plot per measure, the series the column keys.
  const ms = s.values.slice(0, MULTIPLES);
  const xField = fields.byId.get(byCols ? s.cols[0] : s.rows[0]);
  const flat = (mark === 'bar' || mark === 'stacked') && xField?.type === 'text';   // names read across, bars lie down
  const legend = shown.length > 1;
  // One plot has no title over it: the Values shelf, or a Report tile's title, names its measure,
  // and a title there sat on the axis's top label. Several have one each, over their own plot.
  const one = ms.length === 1;
  const grids = one ? [{ grid: { left: 4, right: 16, containLabel: true, top: legend ? 36 : 14, bottom: cut ? 24 : 8 } }]
    : stackedGrids(ms.length, legend ? 7 : 0);
  const catAxis = (i, more) => ({ type: 'category', gridIndex: i, data: cats.map(label), inverse: flat,
    axisLabel: { show: flat || i === ms.length - 1, hideOverlap: true }, ...more });
  const valAxis = (i, m) => ({ type: 'value', gridIndex: i,
    axisLabel: { formatter: v => fmt(m, v), hideOverlap: true }, splitNumber: ms.length > 2 ? 2 : 4 });
  const lines = mark === 'line' || mark === 'area';
  // A line marks the pick across its plot, as its points are not drawn.
  const marked = pick?.active && lines ? cats.findIndex(a => same(a[0], pick.value)) : -1;
  return {
    option: {
      tooltip: { trigger: 'axis', confine: true, axisPointer: { type: lines ? 'line' : 'shadow' },
        formatter: ps => [esc(ps[0]?.axisValueLabel), ...ps.filter(p => p.value != null).map(p => {
          const m = ms[Math.floor(p.seriesIndex / shown.length)];
          return `${p.marker}${shown.length > 1 ? `${esc(p.seriesName)} · ` : ''}${esc(nameOf(m))}: <b>${esc(fmt(m, p.value))}</b>`;
        })].join('<br>') },
      legend: legend ? { type: 'scroll', top: 0, data: shown.map(label) } : undefined,
      title: one ? (cut ? [{ text: cut.trim(), right: 16, bottom: 0, textStyle: { fontSize: 11, fontWeight: 400 } }] : [])
        : ms.map((m, i) => ({ text: i ? nameOf(m) : nameOf(m) + cut, top: grids[i].title, left: 4, textStyle: { fontSize: 12, fontWeight: 600 } })),
      grid: grids.map(g => g.grid),
      dataZoom: !flat && cats.length > 60 ? [{ type: 'inside', xAxisIndex: ms.map((_, i) => i) }] : [],
      xAxis: ms.map((m, i) => flat ? valAxis(i, m) : catAxis(i, { boundaryGap: mark === 'bar' || mark === 'stacked' })),
      yAxis: ms.map((m, i) => flat ? catAxis(i) : valAxis(i, m)),
      series: ms.flatMap((m, i) => shown.map((b, j) => ({
        type: lines ? 'line' : 'bar', name: label(b), xAxisIndex: i, yAxisIndex: i,
        stack: mark === 'stacked' || mark === 'area' ? `s${i}` : undefined,
        areaStyle: mark === 'area' ? { opacity: 0.85 } : undefined, showSymbol: false, connectNulls: false,
        itemStyle: { color: color(j) }, lineStyle: mark === 'line' ? { width: 1.6 } : undefined,
        barMaxWidth: 28, large: cats.length > 400,
        ...(look.labels ? { label: { show: true, position: flat ? 'right' : mark === 'stacked' || mark === 'area' ? 'inside' : 'top',
          fontSize: 10, formatter: p => fmt(m, p.value) } } : {}),
        data: cats.map(a => point(a, at(a, b)?.[nameOf(m)] ?? null)),
        ...(marked >= 0 && j === 0 ? { markLine: { silent: true, symbol: 'none', label: { show: false },
          data: [flat ? { yAxis: label(cats[marked]) } : { xAxis: label(cats[marked]) }] } } : {}),
      }))),
    },
    keyAt: e => cats[e.dataIndex] ?? null,
  };
}

// `root`: the element the page is built in. `ctx`:
//   model()          the model, TMSL (a promise)
//   name             the model's name in SQL (FROM <name>; 'model' in the Fabric app)
//   run(sql, where)  the rows of a SELECT over the model (modelSql), as objects keyed by the
//                    select's names; `where`: its conditions
//   chart(el)        an ECharts instance on el, in the page's theme
//   palette()        the colours of series, in order
//   css(name)        a CSS token's value (the chart's tints)
//   loadState()      the shelves kept from the last visit (or null)
//   saveState(s)     keep the shelves for the next visit
//   noSlicer         (optional) no Slicer mark (a table's Visual, which only builds SQL)
export function createExplorer(root, ctx) {
  let fields = null, state = load(), drag = null, seq = 0, timer = null, result = null, pop = null;
  // What the Visual page's slicer has picked: shown only, nothing filters here.
  let preview = null;
  let popTimer = null, destroyed = false;
  // A column's values, as a filter lists them to tick: the same query whatever else is on
  // the shelves, and the model is read only — asked once per field for the explorer's life.
  const valueLists = new Map();   // field id -> values
  // A query object as the SELECT over the model that runs: a column is the model's own.
  const columnOf = id => { const f = fields?.byId.get(id); return f && f.kind === 'column' ? { table: f.table, name: f.name, type: f.type } : null; };
  const sqlOf = q => modelSql(q, columnOf, ctx.name || 'model');

  function load() {
    try {
      const saved = ctx.loadState() || {};
      if (saved.v !== 2) delete saved.totals;
      return { ...EMPTY(), ...saved, v: 2 };
    } catch { return EMPTY(); }
  }
  function save() { try { ctx.saveState(JSON.parse(JSON.stringify(state))); } catch {} }

  // --- The frame ---
  const search = el('input', { type: 'search', class: 'ex-search', placeholder: 'Search fields', 'aria-label': 'Search fields' });
  const list = el('div', { class: 'ex-list' });
  const pane = el('div', { class: 'ex-fields' }, search, list);
  const shelfEls = Object.fromEntries(SHELVES.map(([k, t]) => [k, el('div', { class: 'ex-drop', 'data-shelf': k })]));
  const shelves = el('div', { class: 'ex-shelves' }, SHELVES.map(([k, t]) =>
    el('div', { class: 'ex-shelf' }, el('span', { class: 'ex-shelf-name' }, t), shelfEls[k])));
  const marks = el('div', { class: 'ex-marks', role: 'group', 'aria-label': 'Show me' });
  const totals = el('input', { type: 'checkbox' });
  const sort = el('select', { 'aria-label': 'Sort' }, el('option', { value: 'fields' }, 'Sort by fields'),
    el('option', { value: 'desc' }, 'Sort by first value ↓'));
  const info = el('span', { class: 'ex-info' });
  const tools = el('div', { class: 'ex-tools' }, marks,
    el('label', { class: 'ex-check' }, totals, 'Totals'), sort,
    el('button', { type: 'button', class: 'btn-explore', title: 'Swap rows and columns', onclick: () => {
      [state.rows, state.cols] = [state.cols, state.rows]; changed(); } }, '⇄ Swap'),
    el('button', { type: 'button', class: 'btn-explore', onclick: () => { state = { ...EMPTY(), mark: state.mark }; changed(); } }, 'Clear'),
    info);
  const table = el('div', { class: 'ex-table' });
  const chartBox = el('div', { class: 'ex-chart' });
  // Over the view while a query runs: a model query reads OneLake and can take a while,
  // and a small "Running…" beside the controls read as a page that had stopped.
  const busyText = el('span');
  const busy = el('div', { class: 'ex-busy', hidden: true, role: 'status', 'aria-live': 'polite' },
    el('span', { class: 'ex-spinner', 'aria-hidden': 'true' }), busyText);
  const out = el('div', { class: 'ex-out' }, table, chartBox, busy);
  root.replaceChildren(el('div', { class: 'ex' }, pane, el('div', { class: 'ex-main' }, shelves, tools, out)));

  search.addEventListener('input', renderFields);
  totals.addEventListener('change', () => { state.totals = totals.checked; changed(); });
  sort.addEventListener('change', () => { state.sort = sort.value; changed(); });
  for (const [k, m] of MARKS) {
    if (k === 'slicer' && ctx.noSlicer) continue;
    marks.append(el('button', { type: 'button', class: 'ex-mark', 'data-mark': k,
      onclick: () => {
        // A card asks a query of its own (buildQuery): to or from one runs again.
        const asks = (state.mark === 'card') !== (k === 'card');
        state.mark = k;
        if (asks) { changed(); return; }
        save(); renderControls(); draw();
      } }, m));
  }

  const fieldOf = id => shelfField(fields, id);

  // --- Drag and drop: a field onto a shelf, a chip along or between shelves, or off them ---
  const accepts = (shelf, f) => f && (shelf === 'values' || f.kind === 'column');
  for (const [k, box] of Object.entries(shelfEls)) {
    box.addEventListener('dragover', e => {
      const f = drag && fieldOf(drag.id);
      if (!accepts(k, f) && !(f?.kind === 'measure' && k !== 'filters')) return;
      e.preventDefault();
      box.classList.add('ex-over');
    });
    box.addEventListener('dragleave', () => box.classList.remove('ex-over'));
    box.addEventListener('drop', e => {
      e.preventDefault();
      box.classList.remove('ex-over');
      if (!drag) return;
      const f = fieldOf(drag.id);
      if (!f) return;
      const to = f.kind === 'measure' ? 'values' : k;   // a measure dropped on Rows goes to Values
      const chip = e.target.closest('.ex-chip');
      const at = chip && to === k ? Number(chip.dataset.index) : null;
      place(drag, to, at);
      drag = null;
    });
  }
  pane.addEventListener('dragover', e => { if (drag?.from) e.preventDefault(); });
  pane.addEventListener('drop', e => { e.preventDefault(); if (drag?.from) { removeAt(drag.from, drag.index); drag = null; } });

  function entry(shelf, i) { return shelf === 'filters' ? state.filters[i].field : state[shelf][i]; }
  function removeAt(shelf, i) { state[shelf].splice(i, 1); changed(); }
  function place({ id, from, index }, to, at) {
    let item = to === 'filters' ? { field: id, op: fields.byId.get(id).type === 'text' || fields.byId.get(id).type === 'bool' ? 'in' : 'range', values: [] } : id;
    if (from) {
      const [moved] = state[from].splice(index, 1);
      if (from === to && at != null && at > index) at--;
      if (from === to) item = moved;
      else if (from === 'filters') item = moved.field;
    }
    // A column put on Values goes there summarised.
    const col = to === 'values' && fields.byId.get(item);
    if (col && col.kind === 'column') item = aggId(defaultAgg(col), item);
    if (to !== 'filters') {
      const already = state[to].indexOf(item);
      if (already >= 0) state[to].splice(already, 1);
    }
    // Rows and Columns hold a column once between them.
    if (to === 'rows' || to === 'cols') {
      const other = to === 'rows' ? 'cols' : 'rows';
      state[other] = state[other].filter(x => x !== item);
    }
    const list = state[to];
    list.splice(at == null || at > list.length ? list.length : at, 0, item);
    changed();
    if (to === 'filters' && from !== 'filters') {
      const chips = shelfEls.filters.querySelectorAll('.ex-chip');
      editFilter(list.indexOf(item), chips[list.indexOf(item)]);
    }
  }
  // A click on a field puts it on its shelf: a measure on Values, a column on Rows.
  function add(f) {
    const shelf = f.kind === 'measure' ? 'values' : 'rows';
    if (state.values.includes(f.id) || state.rows.includes(f.id) || state.cols.includes(f.id)) return;
    place({ id: f.id }, shelf, null);
  }

  // The keyboard's way to the shelves, as a drag is the mouse's. Everything is drawn again after a
  // change, so the focus goes back to the field.
  const openTables = new Map();
  const focusField = id => list.querySelector(`[data-field="${CSS.escape(id)}"]`)?.focus();
  function fieldKey(e, f) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const to = { r: 'rows', c: 'cols', f: 'filters', v: 'values' }[e.key.toLowerCase()];
    if (!to || (f.kind === 'measure' && to !== 'values')) return;
    e.preventDefault();
    place({ id: f.id }, to, null);
    if (to !== 'filters') focusField(f.id);
  }
  // A chip by keyboard: Delete takes it off, Alt+arrow moves it along its shelf.
  function chipKey(e, k, i) {
    const list = state[k];
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeAt(k, i); focusChip(k, Math.min(i, list.length - 1)); return; }
    const by = e.altKey ? { ArrowLeft: -1, ArrowRight: 1 }[e.key] : 0;
    if (!by || i + by < 0 || i + by >= list.length) return;
    e.preventDefault();
    const [moved] = list.splice(i, 1);
    list.splice(i + by, 0, moved);
    changed();
    focusChip(k, i + by);
  }
  const focusChip = (k, i) => shelfEls[k].querySelector(`.ex-chip[data-index="${i}"] .ex-chip-name`)?.focus();

  // --- Rendering the controls ---
  function renderFields() {
    if (!fields) return;
    const term = search.value.trim().toLowerCase();
    const used = new Set([...state.rows, ...state.cols, ...state.values]);
    const item = f => {
      const shelvesFor = f.kind === 'measure' ? 'V: Values' : 'R: Rows, C: Columns, F: Filters, V: Values';
      const b = el('button', { type: 'button', class: `ex-field${used.has(f.id) ? ' ex-used' : ''}${f.derived ? ' ex-derived' : ''}`,
        draggable: 'true', 'data-field': f.id, 'aria-keyshortcuts': f.kind === 'measure' ? 'V' : 'R C F V',
        title: `${f.description ?? f.id} (${shelvesFor})`, onclick: () => { add(f); focusField(f.id); },
        onkeydown: e => fieldKey(e, f) },
        // Under the column it is worked out from, by what it is of it.
        f.derived ? el('span', { class: 'ex-derived-of', 'aria-hidden': 'true' }, '↳') : null,
        el('span', { class: `ex-icon ex-${f.type}` }, ICONS[f.type]),
        f.derived ? [f.derived.as, el('span', { class: 'ex-tag' }, 'derived')] : f.name);
      b.addEventListener('dragstart', e => { drag = { id: f.id }; e.dataTransfer.setData('text/plain', f.id); e.dataTransfer.effectAllowed = 'copyMove'; });
      b.addEventListener('dragend', () => { drag = null; });
      return b;
    };
    list.replaceChildren(...fields.tables.map(t => {
      const cols = t.columns.filter(f => !term || `${t.name} ${f.name}`.toLowerCase().includes(term));
      const ms = t.measures.filter(f => !term || `${t.name} ${f.name}`.toLowerCase().includes(term));
      if (!cols.length && !ms.length) return null;
      // Open as it was left, so adding a field doesn't close the table it came from.
      const open = term || (openTables.has(t.name) ? openTables.get(t.name) : t.dimension || fields.tables.length === 1);
      const group = el('details', { class: 'ex-table-group', open: open ? true : null },
        el('summary', {}, t.name, t.kind && el('span', { class: 'ex-kind' }, t.kind)),
        cols.map(item), ms.map(item));
      group.addEventListener('toggle', () => { if (!search.value.trim()) openTables.set(t.name, group.open); });
      return group;
    }).filter(Boolean));   // a table with nothing matching the search draws nothing, not "null"
  }
  function chipText(shelf, i) {
    if (shelf !== 'filters') return nameOf(state[shelf][i]);
    const f = state.filters[i], n = nameOf(f.field);
    if (f.op === 'in') return f.values.length ? `${n}: ${f.values.length > 2 ? `${f.values.length} values` : f.values.join(', ')}` : `${n}: all`;
    if (f.op === 'notIn') return `${n}: not ${f.values.length > 2 ? `${f.values.length} values` : f.values.join(', ')}`;
    if (f.op === 'last') return `${n}: last ${f.n} days`;
    if (f.op === 'blank') return `${n}: blank`;
    if (f.op === 'notBlank') return `${n}: not blank`;
    if (f.min !== '' && f.min != null && f.max !== '' && f.max != null) return `${n}: ${f.min} – ${f.max}`;
    if (f.min !== '' && f.min != null) return `${n} ≥ ${f.min}`;
    if (f.max !== '' && f.max != null) return `${n} ≤ ${f.max}`;
    return `${n}: all`;
  }
  function renderShelves() {
    for (const [k, box] of Object.entries(shelfEls)) {
      const items = state[k];
      box.replaceChildren(...items.map((_, i) => {
        const f = fieldOf(entry(k, i));
        const summed = k === 'values' && f?.agg;
        const derived = f?.derived ?? f?.column?.derived;
        const chip = el('span', { class: `ex-chip${f?.kind === 'measure' ? ' ex-measure' : ''}${f ? '' : ' ex-missing'}${derived ? ' ex-derived' : ''}`,
          draggable: 'true', 'data-index': i, onkeydown: e => chipKey(e, k, i),
          title: !f ? `${nameOf(entry(k, i))}: not in the model`
            : summed ? `${f.column.id}: click to change how it is summarised` : entry(k, i) },
          el('button', { type: 'button', class: 'ex-chip-name', onclick: e => {
            if (k === 'filters') editFilter(i, e.currentTarget.parentNode);
            else if (summed) editAgg(i, e.currentTarget.parentNode);
          } }, f?.kind === 'measure' ? el('span', { class: 'ex-chip-icon', 'aria-hidden': 'true' }, ICONS.measure) : null,
            chipText(k, i), summed ? ' ▾' : null),
          el('button', { type: 'button', class: 'ex-x', 'aria-label': `Remove ${chipText(k, i)}`, onclick: () => removeAt(k, i) }, '×'));
        chip.addEventListener('dragstart', e => { drag = { id: entry(k, i), from: k, index: i }; e.dataTransfer.setData('text/plain', entry(k, i)); });
        chip.addEventListener('dragend', () => { drag = null; });
        return chip;
      }));
      if (!items.length) box.append(el('span', { class: 'ex-hint' },
        k === 'values' ? 'Drop measures, or columns to summarise, here' : k === 'filters' ? 'Drop a column to filter on it' : 'Drop columns here'));
    }
  }
  function renderControls() {
    totals.checked = state.totals;
    sort.value = state.sort;
    const auto = fields ? autoMark(state, fields) : 'table';
    for (const b of marks.children) {
      const on = b.dataset.mark === state.mark;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('ex-auto', state.mark === 'auto' && b.dataset.mark === auto);
    }
  }

  // --- The popups: a filter's editor, a summarised column's summary ---
  // The outside-click listener is added a tick late (so the click that opened the popup does
  // not close it); a close inside that tick must cancel it, or it is added for good.
  function closePop() {
    clearTimeout(popTimer);
    pop?.remove(); pop = null;
    document.removeEventListener('pointerdown', outside, true);
  }
  function outside(e) { if (pop && !pop.contains(e.target)) closePop(); }
  function showPop(anchor) {
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    // Kept on screen, and the keyboard goes with it: its Esc works only from inside it.
    pop.style.top = `${Math.max(8, Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8))}px`;
    pop.querySelector('input, select, button')?.focus();
    popTimer = setTimeout(() => document.addEventListener('pointerdown', outside, true));
  }

  // Sum and average for a number; any column can be counted, or its min and max.
  function editAgg(i, anchor) {
    closePop();
    const a = aggOf(state.values[i]), col = a && fields.byId.get(a.col);
    if (!col) return;
    const pick = agg => {
      const id = aggId(agg, a.col);
      // Already on Values in that summary: this chip goes rather than becoming a second one.
      if (state.values.includes(id) && state.values[i] !== id) state.values.splice(i, 1);
      else state.values[i] = id;
      closePop();
      changed();
    };
    const opts = AGGS.filter(([k]) => col.type === 'number' || !NUMBERS_ONLY.has(k));
    pop = el('div', { class: 'ex-pop', role: 'dialog', 'aria-label': `Summarise ${col.name}` },
      el('div', { class: 'ex-pop-head' }, `Summarise ${col.name}`),
      el('div', { class: 'ex-aggs', role: 'radiogroup' }, opts.map(([k, t]) =>
        el('button', { type: 'button', role: 'radio', 'aria-checked': String(k === a.agg),
          class: `ex-agg${k === a.agg ? ' active' : ''}`, onclick: () => pick(k) }, t))));
    pop.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });
    showPop(anchor);
    pop.querySelector('.ex-agg.active')?.focus();
  }
  async function editFilter(i, anchor) {
    closePop();
    const f = state.filters[i], fd = fields.byId.get(f.field);
    if (!fd) return;
    const draft = { ...f, values: [...(f.values ?? [])] };
    const body = el('div', { class: 'ex-pop-body' });
    const apply = () => { state.filters[i] = draft; closePop(); changed(); };
    pop = el('div', { class: 'ex-pop', role: 'dialog', 'aria-label': `Filter ${fd.name}` },
      el('div', { class: 'ex-pop-head' }, fd.id), body,
      el('div', { class: 'ex-pop-foot' },
        el('button', { type: 'button', class: 'btn-explore', onclick: closePop }, 'Cancel'),
        el('button', { type: 'button', class: 'btn-explore primary', onclick: apply }, 'Apply')));
    pop.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') apply(); });
    showPop(anchor);

    const modes = fd.type === 'text' || fd.type === 'bool'
      ? [['in', 'Keep only'], ['notIn', 'Exclude'], ['blank', 'Blank'], ['notBlank', 'Not blank']]
      : [['range', 'Range'], ...(fd.type === 'date' ? [['last', 'Last n days']] : []), ['blank', 'Blank'], ['notBlank', 'Not blank']];
    const mode = el('select', { 'aria-label': 'Condition' }, modes.map(([v, t]) => el('option', { value: v }, t)));
    mode.value = modes.some(([v]) => v === draft.op) ? draft.op : modes[0][0];
    draft.op = mode.value;
    const detail = el('div');
    body.append(mode, detail);
    mode.addEventListener('change', () => { draft.op = mode.value; fill(); });
    let values = null;
    async function fill() {
      if (draft.op === 'blank' || draft.op === 'notBlank') { detail.replaceChildren(); return; }
      if (draft.op === 'range') {
        const input = k => {
          const box = el('input', { type: fd.type === 'date' ? 'date' : 'number', step: 'any', value: draft[k] ?? '', 'aria-label': k });
          box.addEventListener('input', () => { draft[k] = box.value === '' ? '' : fd.type === 'number' ? Number(box.value) : box.value; });
          return box;
        };
        detail.replaceChildren(el('label', {}, 'From', input('min')), el('label', {}, 'To', input('max')));
        return;
      }
      if (draft.op === 'last') {
        draft.n ??= 7;
        const box = el('input', { type: 'number', min: 1, step: 1, value: draft.n, 'aria-label': 'days' });
        box.addEventListener('input', () => { draft.n = Math.max(1, Math.round(Number(box.value) || 1)); });
        detail.replaceChildren(el('label', {}, 'Days up to today', box));
        return;
      }
      // A list of the column's values to tick.
      detail.replaceChildren(el('div', { class: 'ex-hint' }, 'Reading values…'));
      const mine = pop;
      // While the list was read, the popup may have closed or the mode moved on to Range or
      // Blank — whose inputs this list must not replace.
      const stale = () => pop !== mine || (draft.op !== 'in' && draft.op !== 'notIn');
      try {
        if (!values) {
          values = valueLists.get(fd.id) ??
            (await ctx.run(sqlOf({ select: { v: fd.id }, orderBy: ['v'], top: 1000 }), [])).map(r => r.v);
          valueLists.set(fd.id, values);
        }
      } catch (e) { if (!stale()) detail.replaceChildren(el('div', { class: 'ex-error' }, e.message)); return; }
      if (stale()) return;
      const picked = new Set(draft.values);
      const find = el('input', { type: 'search', placeholder: 'Search values', 'aria-label': 'Search values' });
      const boxes = el('div', { class: 'ex-values' });
      const show = () => boxes.replaceChildren(...values.filter(v => String(v).toLowerCase().includes(find.value.toLowerCase())).map(v => {
        const c = el('input', { type: 'checkbox', checked: picked.has(v) });
        c.addEventListener('change', () => { if (c.checked) picked.add(v); else picked.delete(v); draft.values = values.filter(x => picked.has(x)); });
        return el('label', {}, c, v == null ? '(blank)' : String(v));
      }));
      find.addEventListener('input', show);
      const all = on => () => { picked.clear(); if (on) values.filter(v => String(v).toLowerCase().includes(find.value.toLowerCase())).forEach(v => picked.add(v)); draft.values = values.filter(x => picked.has(x)); show(); };
      detail.replaceChildren(find, el('div', { class: 'ex-row' },
        el('button', { type: 'button', class: 'btn-explore', onclick: all(true) }, 'All'),
        el('button', { type: 'button', class: 'btn-explore', onclick: all(false) }, 'None'),
        values.length >= 1000 ? el('span', { class: 'ex-hint' }, 'first 1,000 values') : null), boxes);
      show();
    }
    fill();
  }

  // --- Running ---
  function changed() {
    // From here, what comes back of an older query answers shelves that are gone.
    seq++;
    save();
    renderShelves();
    renderFields();
    renderControls();
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  }
  let ticker = null;
  function running(on) {
    clearInterval(ticker);
    busy.hidden = !on;
    out.classList.toggle('ex-running', on);
    if (!on) return;
    const t0 = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      busyText.textContent = s ? `Running the query… ${s}s` : 'Running the query…';
      info.textContent = busyText.textContent;
    };
    tick();
    ticker = setInterval(tick, 1000);
  }
  // Why there is no result, in the view rather than only beside the controls.
  let failure = null;
  let inFlight = 0;
  async function run() {
    const my = ++seq;
    failure = null;
    let q;
    try {
      q = buildQuery(state);
    } catch (e) { running(false); result = null; failure = e.message; info.textContent = e.message; info.className = 'ex-info ex-error'; draw(); return; }
    if (!q) { running(false); result = null; info.textContent = ''; draw(); return; }
    info.className = 'ex-info';
    // Nobody is waiting for the older one now. A popup's list of values may be running too, and a
    // Stop reaches everything this tab runs, so then the older one finishes.
    if (inFlight && !pop && ctx.cancel) ctx.cancel();
    running(true);
    inFlight++;
    try {
      let rows = await ctx.run(sqlOf(q), q.where ?? []);
      if (my !== seq) return;
      // The cap counts the total rows too, and they sort first (their keys are blank), so a
      // capped pivot can be all totals and no detail. Totals of a view that shows only part
      // of the rows mean little anyway: when the cap is hit they are dropped.
      let note = '';
      if (rows.length >= CAP && q.totals) {
        q = buildQuery({ ...state, totals: false });
        rows = await ctx.run(sqlOf(q), q.where ?? []);
        if (my !== seq) return;
        note = ' — totals left out';
      }
      const shown = { ...structuredClone(state), totals: !!q.totals };
      result = { state: shown, rows };
      const n = rows.filter(r => !r[ROW_TOTAL] && !r[COL_TOTAL]).length;
      running(false);
      info.textContent = rows.length >= CAP
        ? `First ${n.toLocaleString()} rows: add a filter for all of them${note}`
        : `${n.toLocaleString()} row${n === 1 ? '' : 's'}`;
      info.classList.toggle('ex-warn', rows.length >= CAP);
      if (state.mark === 'card' && (state.rows.length || state.cols.length)) info.textContent = 'A card shows Values only: Rows and Columns are left out';
      draw();
    } catch (e) {
      if (my !== seq) return;
      running(false);
      result = null;
      info.className = 'ex-info ex-error';
      info.textContent = e.cancelled ? 'Stopped.'
        : e.message?.includes('Out of Memory') ? 'Out of memory: add a filter.' : `Error: ${e.message}`;
      failure = info.textContent;
      draw();
    } finally { inFlight--; }
  }

  // --- Drawing ---
  function draw() {
    // A query that settles after the view is gone must not build a chart nobody disposes.
    if (destroyed) return;
    if (!result) {
      chartBox.hidden = true;
      table.hidden = false;
      table.replaceChildren(failure ? el('div', { class: 'ex-empty ex-error' }, failure)
        : el('div', { class: 'ex-empty' }, fields
          ? 'Drag columns onto Rows and Columns and measures onto Values, or click a field to add it. By keyboard: R, C, F or V on a field.' : 'Reading the model…'));
      return;
    }
    const look = { fields, palette: ctx.palette(), css: ctx.css,
      styles: { value: state.slicer, set: k => { state.slicer = k; save(); draw(); } } };
    const view = pivotView(result.state, result.rows, state.mark, look, null,
      { style: state.slicer, ...preview, onChange: (next, quiet) => { preview = next; if (!quiet) draw(); } });
    if (view.node) {
      chartBox.hidden = true;
      table.hidden = false;
      table.replaceChildren(view.node);
      return;
    }
    table.hidden = true;
    chartBox.hidden = false;
    const chart = ctx.chart(chartBox);
    chart.setOption({ aria: { enabled: true }, ...view.option }, true);
    chart.resize();
  }

  // --- Start ---
  renderControls();
  draw();
  const ready = ctx.model().then(model => {
    fields = modelFields(model);
    renderFields();
    renderShelves();
    renderControls();
    run();
  }, e => { table.replaceChildren(el('div', { class: 'ex-error' }, `Could not read the model: ${e.message}`)); });

  return {
    ready,
    // The theme changed: the chart is drawn again in the new one.
    redraw: () => { if (fields) draw(); },
    // The shelves as one SELECT over the model, and its conditions, or null. As the pivot runs
    // it by default (its first CAP rows: what Show SQL fills its box with, so its text is the
    // query the pivot ran); `cap: 0` for all its rows (Download CSV).
    // `plain`: as SQL over one table (modelSql's). `totals: false` leaves the totals' rows and
    // their marking columns out, for a file of just the rows (Download CSV).
    query: ({ cap = CAP, plain = null, totals = true } = {}) => {
      try {
        const q = fields && buildQuery(totals ? state : { ...state, totals: false }, { cap });
        return q && { sql: plain ? modelSql(q, columnOf, null, plain) : sqlOf(q), where: q.where ?? [] };
      } catch { return null; }
    },
    // The shelves as they are (Export to Fabric: the app's first view).
    state: () => JSON.parse(JSON.stringify(state)),
    // Other shelves on screen, run (a Report's tile, to edit it), and kept as the shelves are.
    setState(s) {
      state = { ...EMPTY(), ...JSON.parse(JSON.stringify(s ?? {})), v: 2 };
      preview = null;
      closePop();
      changed();
    },
    // The view is going: its timers stop, its popup goes, and a query still running finds
    // its sequence moved on and draws nothing.
    destroy() {
      destroyed = true;
      seq++;
      clearTimeout(timer);
      clearInterval(ticker);
      closePop();
    },
  };
}
