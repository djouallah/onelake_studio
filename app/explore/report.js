// =============================================================================
// explore/report.js — a model's Report: tiles, each one SELECT over the model, drawn
// =============================================================================
// The Report is data (site/report.json in Export to Fabric's zip; the first tiles before there is
// one): { tiles: [{ title, kind, sql, formats?, echarts?, wide?, crossFilter? }] }. A tile's SQL is a
// SELECT over the model, FROM model, in the SQL the SQL box takes.
//   kind 'kpi'    one row: each column a figure
//   kind 'bar'    the first column across, every other column a series (also 'line')
//   kind 'table'  the rows as they are
// `formats`: a column's format string; `echarts` (bar, line): an ECharts option merged over the
// tile's own. A tile that fails says so in its own box, and the rest still draw.
// Cross filtering: a click on a bar, a line's point or a table's row picks that row's first value,
// and every other tile runs again with it as a WHERE on the model column the tile's first column
// is. `crossFilter` names that column when the first is not one ("table"."column"), or is false
// for a tile that takes no clicks. The tile clicked stays whole, its pick bright; the same click
// again clears it, as the pick's ✕ above the tiles does. Picks in several tiles all apply.
// The same file in the panel and in Export to Fabric's app: the host says how SQL runs (`sql`).
// =============================================================================

import { el } from './dom.js';
import { formatValue } from './draw.js';
import { PALETTE } from './theme.js';

const KINDS = new Set(['kpi', 'bar', 'line', 'table']);
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

const quote = s => `'${String(s).replace(/'/g, "''")}'`;
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
    return type === 'string' ? quote(value) : String(value);
  }
  const s = String(value);
  if (type === 'dateTime') {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?/.exec(s);
    if (m) return m[2] && !/^00:00(?::00)?$/.test(m[2]) ? `TIMESTAMP '${m[1]} ${m[2]}'` : `DATE '${m[1]}'`;
  }
  if ((type === 'int64' || type === 'double' || type === 'decimal') && NUMBER.test(s)) return s;
  if (type === 'boolean' && /^(true|false)$/i.test(s)) return s.toUpperCase();
  return quote(s);
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

/**
 * A tile's SQL with picks as its WHERE: each { ref, value, type } is `ref = literal` (sqlLiteral),
 * or `ref IS NULL` for a blank. Added after FROM, before GROUP BY and the rest, or ANDed to the
 * WHERE it has, which is put in parentheses.
 */
export function withFilters(sql, filters) {
  if (!filters?.length) return sql;
  const cond = filters.map(f => (f.value == null ? `${f.ref} IS NULL` : `${f.ref} = ${sqlLiteral(f.value, f.type)}`)).join(' AND ');
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
 * that name), for a pick's literal. Returns { destroy }.
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
  else if (!tiles.length) grid.append(el('p', { class: 'rp-say' }, 'The report has no tiles yet.'));
  let gone = false, pumping = false, running = null;
  // What a click picked, by the tile it was picked in: { field, value, label }, in the order picked.
  const picks = new Map();
  const jobs = (tiles ?? []).map(tile => {
    const body = el('div', {}, el('p', { class: 'rp-say' }, 'Waiting…'));
    const wide = tile.wide ?? (tile.kind === 'kpi' || tile.kind === 'table');
    grid.append(el('section', { class: `rp-tile${wide ? ' wide' : ''}` }, el('h2', {}, String(tile.title ?? '')), body));
    return { tile, body, on: pickColumn(tile), dirty: true, chart: null, box: null, repaint: null };
  });
  pump();

  // The model column a click on this tile filters the others by, with its type; null: no clicks.
  function pickColumn(tile) {
    if (tile.kind === 'kpi' || tile.crossFilter === false) return null;
    const c = typeof tile.crossFilter === 'string' ? columnOf(tile.crossFilter) : firstColumn(tile.sql);
    return c && { ...c, type: ctx.columnType?.(c.table, c.column) };
  }
  // The picks of every other tile, as withFilters takes them.
  const filtersFor = job => [...picks].filter(([j]) => j !== job).map(([j, p]) => ({ ref: j.on.ref, type: j.on.type, value: p.value }));

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
  function changed(job) {
    drawChips();
    job.repaint?.();
    for (const j of jobs) if (j !== job) { j.dirty = true; say(j, 'Waiting…'); }
    if (running && running !== job) ctx.cancel?.();
    pump();
  }

  // One chip per pick, `Column = value`, with a ✕ that clears it; none, no bar.
  function drawChips() {
    chips.hidden = !picks.size;
    chips.replaceChildren(...(picks.size ? [el('span', { class: 'rp-filters-say' }, 'Filtered by:')] : []), ...[...picks].map(([job, p]) => {
      const text = `${p.field} = ${p.value == null || p.label === '' ? '(blank)' : p.label}`;
      return el('span', { class: 'rp-chip' }, el('span', {}, text),
        el('button', { type: 'button', class: 'rp-x', title: 'Clear this filter', 'aria-label': `Clear ${text}`,
          onclick: () => { picks.delete(job); changed(job); } }, '✕'));
    }));
  }

  async function drawTile(job) {
    const { tile, body } = job;
    if (!KINDS.has(tile.kind)) throw new Error(`a tile's kind is kpi, bar, line or table, not ${JSON.stringify(tile.kind)}`);
    if (typeof tile.sql !== 'string' || !tile.sql.trim()) throw new Error('the tile has no sql');
    if (tile.crossFilter != null && tile.crossFilter !== false && !(typeof tile.crossFilter === 'string' && columnOf(tile.crossFilter))) {
      throw new Error(`a tile's crossFilter is a model column ("table"."column") or false, not ${JSON.stringify(tile.crossFilter)}`);
    }
    const res = await ctx.sql(withFilters(tile.sql, filtersFor(job)));
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

  return {
    destroy() {
      gone = true;
      for (const job of jobs) clear(job);
      resized.disconnect();
      root.replaceChildren();
    },
  };
}
