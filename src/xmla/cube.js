'use strict';
// =============================================================================
// cube.js — a semantic model as Excel's PivotTable sees it
// =============================================================================
// A model becomes one cube. Each table is a dimension, each column an attribute hierarchy with
// an All member above one level, each of the model's hierarchies a hierarchy of its columns.
// Each measure is a member of [Measures], in a measure group named after its table. Read from
// the raw TMSL: dax-sql's model drops hierarchies and what is hidden. What stays out is what
// Power BI leaves out of a field list: anything hidden, or not available in MDX.
// =============================================================================

const CUBE = 'Model';
const NO_MEASURES = '__No measures defined';
const lc = s => String(s).toLowerCase();
const br = s => `[${String(s).replace(/\]/g, ']]')}]`;

const qid = s => `"${String(s).replace(/"/g, '""')}"`;
const columnRef = c => `${qid(c.table)}.${qid(c.name)}`;

function buildCube(catalog, bim, sqlName) {
  const tables = bim?.model?.tables ?? [];
  const dimensions = [], hierarchies = [], measures = [];
  const byName = new Map();   // lower-cased unique name -> { hierarchy, level? } or { measure }
  const groups = new Set();

  for (const t of tables) {
    if (t.calculationGroup) continue;
    for (const m of t.measures ?? []) {
      if (m.isHidden) continue;
      const measure = { name: m.name, unique: `[Measures].${br(m.name)}`, table: t.name,
                        folder: m.displayFolder || '', format: m.formatString || '', description: m.description || '' };
      measures.push(measure);
      byName.set(lc(measure.unique), { measure });
      groups.add(t.name);
    }
    // [Measures] is the cube's own: a table of that name keeps its measures, not a dimension.
    if (t.isHidden || lc(t.name) === 'measures') continue;
    const dim = { name: t.name, unique: br(t.name), hierarchies: [], description: t.description || '' };
    const col = new Map((t.columns ?? []).map(c => [lc(c.name), c]));
    const add = (name, folder, origin, levels, description = '') => {
      const unique = `${dim.unique}.${br(name)}`;
      const hierarchy = { name, unique, dimension: dim, folder: folder || '', origin, description, all: `${unique}.[All]`,
                          allLevel: `${unique}.[(All)]`, levels: [] };
      hierarchy.levels = levels.map((l, i) => ({ name: l.name, unique: `${unique}.${br(l.name)}`, number: i + 1, hierarchy, column: l.column }));
      dim.hierarchies.push(hierarchy);
      hierarchies.push(hierarchy);
      byName.set(lc(unique), { hierarchy });
      byName.set(lc(hierarchy.all), { hierarchy, allMember: true });
      byName.set(lc(hierarchy.allLevel), { hierarchy, depth: 0 });
      for (const l of hierarchy.levels) byName.set(lc(l.unique), { hierarchy, depth: l.number });
    };
    const columnOf = c => ({
      table: t.name, name: c.name, dataType: lc(c.dataType || 'string'),
      sortBy: c.sortByColumn && col.has(lc(c.sortByColumn)) ? { table: t.name, name: col.get(lc(c.sortByColumn)).name } : null,
    });
    for (const c of t.columns ?? []) {
      if (c.isHidden || c.type === 'rowNumber' || c.isAvailableInMdx === false) continue;
      add(c.name, c.displayFolder, 2, [{ name: c.name, column: columnOf(c) }], c.description);
    }
    for (const h of t.hierarchies ?? []) {
      if (h.isHidden) continue;
      const levels = [...(h.levels ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
        .map(l => ({ name: l.name, column: col.has(lc(l.column)) ? columnOf(col.get(lc(l.column))) : null }));
      if (levels.length && levels.every(l => l.column)) add(h.name, h.displayFolder, 1, levels, h.description);
    }
    if (dim.hierarchies.length) dimensions.push(dim);
  }
  // Excel refuses a cube with no measure at all ("No data fields are available"), so a model with
  // none gets one it can't show: its fields still open in a PivotTable, with no numbers to add up.
  const placeholder = measures.length ? null : {
    name: NO_MEASURES, unique: `[Measures].${br(NO_MEASURES)}`, table: dimensions[0]?.name ?? CUBE,
    folder: '', format: '', description: '', placeholder: true,
  };
  if (placeholder) {
    byName.set(lc(placeholder.unique), { measure: placeholder });
    groups.add(placeholder.table);
  }
  return { catalog, name: CUBE, sqlName, dimensions, hierarchies, measures, listedMeasures: placeholder ? [placeholder] : measures,
           groups: [...groups], byName, defaultMeasure: measures[0] || placeholder };
}

// A member's key in its unique name: a value as text, a blank as nothing at all.
const keyOf = v => (v == null ? '' : String(v));
const captionOf = key => (key === '' ? '(Blank)' : key);

// `path`: a member's keys from the first level down. [] is the All member.
function memberUnique(h, path) {
  return path.length ? `${h.unique}.${path.map(k => `&${br(k)}`).join('.')}` : h.all;
}

// A dotted name as its parts: [a].[b].&[c] -> ['a', 'b', { key: 'c' }].
function nameParts(raw) {
  const parts = [];
  let i = 0;
  while (i < raw.length) {
    const key = raw[i] === '&';
    if (key) i++;
    if (raw[i] !== '[') throw new Error(`${raw} is not a name`);
    let j = i + 1, s = '';
    for (;;) {
      if (j >= raw.length) throw new Error(`${raw} is not a name`);
      if (raw[j] === ']') {
        if (raw[j + 1] !== ']') break;
        s += ']';
        j += 2;
        continue;
      }
      s += raw[j++];
    }
    parts.push(key ? { key: s } : s);
    i = j + 1;
    if (raw[i] === '.') i++;
  }
  return parts;
}

// What a name is in this cube: { measure }, { hierarchy }, { hierarchy, depth } for a level, or
// { hierarchy, path } for a member. Null when it isn't anything here.
function resolve(cube, raw) {
  const known = cube.byName.get(lc(raw));
  if (known) {
    if (known.allMember) return { hierarchy: known.hierarchy, path: [] };
    return known;
  }
  const parts = nameParts(raw);
  const firstKey = parts.findIndex(p => typeof p === 'object');
  if (firstKey < 2) return null;
  const head = parts.slice(0, firstKey);
  // [t].[h].&[a] or [t].[h].[level].&[a]
  const hit = cube.byName.get(lc(`${br(head[0])}.${br(head[1])}`));
  if (!hit || !hit.hierarchy || head.length > 3) return null;
  const path = parts.slice(firstKey).map(p => {
    if (typeof p !== 'object') throw new Error(`${raw}: a key is expected after the first`);
    return p.key;
  });
  if (path.length > hit.hierarchy.levels.length) return null;
  return { hierarchy: hit.hierarchy, path };
}

module.exports = { CUBE, buildCube, resolve, memberUnique, keyOf, captionOf, columnRef, qid, br, nameParts };
