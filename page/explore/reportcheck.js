// =============================================================================
// explore/reportcheck.js — what is wrong with a Report, read as the page reads it
// =============================================================================
// No DOM and no data: a Report ({ pages, filters?, theme? }, report.js) against a model's fields
// (explore.js modelFields). Each tile is read as drawReport reads it (tileOf, pivotQuery), so a
// field the model has not, a shelf that is not a list, a mark or a slicer style the page does not
// draw, a filter it cannot apply, a filter-bar field, a layout off the grid, a theme it has no
// name for: each is named, with its page and tile. A pivot tile's query is handed back, for a
// caller that can compile it (`queries`). Two callers: an exported project's `npm run validate`
// (fabric_app/project/validate-report.mjs) and the command line's `report --set` (cli/agent.js).
// A Report that passes here can still show no rows.
// =============================================================================

import { pivotQuery, aggOf, MARKS, SLICER_STYLES } from './explore.js';
import { reportPages, tileOf, COLUMNS } from './report.js';
import { PALETTES, STYLES } from './theme.js';
import { TEXT_SIZES } from './format.js';

const OPS = new Set(['in', 'notIn', 'range', 'last', 'blank', 'notBlank']);
const BAR_STYLES = ['dropdown', 'list', 'dates'];

// How many letters apart two names are (Levenshtein), for "near" names.
function apart(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** Every field a tile can name, as a tile names it, by table: [{ table, kind, fields: [{ id, type, description }] }]. */
export function fieldList(fields) {
  return fields.tables.map(t => ({
    table: t.name, kind: t.kind,
    fields: [...t.columns.map(c => ({ id: c.id, type: c.type, description: c.description ?? null })),
             ...t.measures.map(m => ({ id: m.id, type: 'measure', description: m.description ?? null }))],
  }));
}

/**
 * What is wrong with `spec`, a Report, on a model of these `fields`: { problems, pages, tiles,
 * queries }. `problems`: each "where: what", none when the page reads it all. `queries`: each pivot
 * tile's SELECT over the model ({ where, sql }), as the page makes it; `name` is what it says FROM.
 */
export function checkReport(spec, fields, { name = 'model' } = {}) {
  const problems = [], queries = [];
  const say = (where, what) => problems.push(`${where}: ${what}`);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { problems: ['report: a report is { "pages": [{ "name": "…", "tiles": [...] }] }'], pages: 0, tiles: 0, queries };
  }
  // A field as a shelf names it: a column (table.column), a measure (its name), or a column summarised.
  const known = id => fields.byId.has(aggOf(id)?.col ?? id);
  const unknown = (where, id) => {
    const want = String(aggOf(id)?.col ?? id).toLowerCase();
    const near = [...fields.byId.keys()].map(k => [k, apart(k.toLowerCase(), want)])
      .filter(([k, d]) => d <= Math.max(2, want.length / 4) || k.toLowerCase().includes(want))
      .sort((a, b) => a[1] - b[1]).slice(0, 5).map(([k]) => k);
    say(where, `no field ${JSON.stringify(id)} in the model${near.length ? ` (near: ${near.join(', ')})` : ''}`);
  };

  if (spec.pages !== undefined && !Array.isArray(spec.pages)) say('report', 'pages is not a list');
  const theme = spec.theme;
  if (theme !== undefined) {
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) say('theme', 'the theme is { "style", "palette", "textSize", "colors" }');
    else {
      if (theme.style !== undefined && !Object.hasOwn(STYLES, theme.style)) say('theme', `style is one of ${Object.keys(STYLES).join(', ')}, not ${JSON.stringify(theme.style)}`);
      if (theme.palette !== undefined && !Object.hasOwn(PALETTES, theme.palette)) say('theme', `palette is one of ${Object.keys(PALETTES).join(', ')}, not ${JSON.stringify(theme.palette)}`);
      if (theme.textSize !== undefined && !Object.hasOwn(TEXT_SIZES, theme.textSize)) say('theme', `textSize is one of ${Object.keys(TEXT_SIZES).join(', ')}, not ${JSON.stringify(theme.textSize)}`);
      if (theme.colors !== undefined && (!theme.colors || typeof theme.colors !== 'object' || Array.isArray(theme.colors))) say('theme', 'colors is { "a value as shown": "#rrggbb" }');
    }
  }
  const pages = reportPages(spec);
  // The filter bar, beside the pages: columns of the model.
  const bar = Array.isArray(spec.filters) ? spec.filters : [];
  if (spec.filters !== undefined && !Array.isArray(spec.filters)) say('report', 'filters (the filter bar) is not a list');
  for (const f of bar) {
    if (!f || typeof f.field !== 'string') say('filter bar', `a filter is { "field": "table.column", "style": ... }: ${JSON.stringify(f)}`);
    else if (!fields.byId.has(f.field) || fields.byId.get(f.field).kind !== 'column') unknown('filter bar', f.field);
    if (f && f.style !== undefined && !BAR_STYLES.includes(f.style)) say('filter bar', `${f.field}: style is ${BAR_STYLES.join(', ')}, not ${JSON.stringify(f.style)}`);
  }
  const barFields = new Set(bar.map(f => f?.field));
  const marks = new Set(MARKS.map(([k]) => k));
  const slicers = new Set(SLICER_STYLES.map(([k]) => k));

  let tiles = 0;
  for (const page of pages) {
    if (!Array.isArray(page.tiles)) { say(`page "${page.name}"`, 'tiles is not a list'); continue; }
    page.tiles.forEach((raw, i) => {
      tiles++;
      const t = tileOf(raw);
      const where = `page "${page.name}", tile ${i + 1}${t?.title ? ` "${t.title}"` : ''}`;
      if (!t || typeof t !== 'object') return say(where, 'a tile is an object');
      if (t.layout !== undefined) {
        const { x, y, w, h } = t.layout || {};
        if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > COLUMNS) {
          say(where, `layout is whole numbers on ${COLUMNS} columns, x + w at most ${COLUMNS}: ${JSON.stringify(t.layout)}`);
        }
      }
      for (const id of t.ignore ?? []) if (!barFields.has(id)) say(where, `ignore names ${JSON.stringify(id)}, which is not in the filter bar`);
      if (t.kind === 'text') {
        if (typeof t.text !== 'string') say(where, "a text tile's text is a string of Markdown");
        return;
      }
      if (t.kind !== 'pivot') return say(where, `kind is pivot or text, not ${JSON.stringify(t.kind)}`);
      const p = t.pivot;
      let q;
      try { q = pivotQuery(p, fields, name); } catch (e) { return say(where, e.message); }
      for (const k of ['rows', 'cols', 'values']) for (const id of p[k] ?? []) if (!known(id)) unknown(`${where}, ${k}`, id);
      for (const f of p.filters ?? []) {
        if (!f || typeof f.field !== 'string') { say(`${where}, filters`, `a filter is { "field", "op", ... }: ${JSON.stringify(f)}`); continue; }
        if (!known(f.field)) unknown(`${where}, filters`, f.field);
        if (!OPS.has(f.op)) say(`${where}, filters`, `${f.field}: op is ${[...OPS].join(', ')}, not ${JSON.stringify(f.op)}`);
        if ((f.op === 'in' || f.op === 'notIn') && !Array.isArray(f.values)) say(`${where}, filters`, `${f.field}: ${f.op} takes "values": [...]`);
        if (f.op === 'last' && !(Number.isInteger(f.n) && f.n > 0)) say(`${where}, filters`, `${f.field}: last takes "n", a whole number of days`);
      }
      if (p.mark !== undefined && !marks.has(p.mark)) say(where, `mark is one of ${[...marks].join(', ')}, not ${JSON.stringify(p.mark)}`);
      if (p.mark === 'slicer' && p.slicer !== undefined && !slicers.has(p.slicer)) say(where, `slicer is one of ${[...slicers].join(', ')}, not ${JSON.stringify(p.slicer)}`);
      for (const m of Object.keys(p.format?.measures ?? {})) if (!(p.values ?? []).some(v => v === m)) say(`${where}, format.measures`, `${JSON.stringify(m)} is not on its Values`);
      queries.push({ where, sql: q.sql });
    });
  }
  return { problems, pages: pages.length, tiles, queries };
}
