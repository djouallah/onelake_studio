'use strict';
// =============================================================================
// cellset.js — an MDX statement answered: its grains as model SELECTs, then a cell set
// =============================================================================
// One grain per pattern on each axis, so totals are the model's own at that grain and not sums
// of what's below them: a distinct count or a ratio is right on every line. A pivot's grand
// total, subtotals and detail are separate statements, not one ROLLUP, since rows and columns
// each have their own. Every statement goes through what any query does: dax-sql, then the
// read-only guard (the `query` handed in).
// =============================================================================
const { esc } = require('./soap.js');
const { CUBE, memberUnique, keyOf, captionOf, columnRef, qid } = require('./cube.js');
const { sortKey, compareKeys } = require('./order.js');
const { parseSelect, parseSet, evalSet, readQuery, readFilter, slicerTemplate, known } = require('./mdx.js');
const { memberPaths } = require('./rowsets.js');

const MAX_GRAINS = 256;
const AT_ONCE = 4;
const MEASURES = '[Measures]', MEASURES_LEVEL = '[Measures].[MeasuresLevel]';

// A key as a literal of its column's type. A key comes from the statement, so it is checked and
// quoted here, and never reaches SQL as it was written.
function literal(column, key) {
  const bad = () => new Error(`${key} is not a value of ${column.table}[${column.name}]`);
  switch (column.dataType) {
    case 'int64': case 'double': case 'decimal':
      if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(key)) throw bad();
      return key;
    case 'boolean':
      if (!/^(true|false)$/i.test(key)) throw bad();
      return key.toUpperCase();
    case 'datetime':
      if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return `DATE '${key}'`;
      if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(key)) return `TIMESTAMP '${key}'`;
      throw bad();
    default:
      return `'${key.replace(/'/g, "''")}'`;
  }
}

// The members under any of these key paths, as one condition.
function condition(h, paths) {
  const col = i => h.levels[i].column;
  const one = (k, i) => (k === '' ? `${columnRef(col(i))} IS NULL` : `${columnRef(col(i))} = ${literal(col(i), k)}`);
  if (paths.every(p => p.length === 1)) {
    const keys = paths.map(p => p[0]);
    const named = keys.filter(k => k !== '');
    if (!named.length) return one('', 0);
    const list = `${columnRef(col(0))} IN (${named.map(k => literal(col(0), k)).join(', ')})`;
    return named.length === keys.length ? list : `(${columnRef(col(0))} IS NULL OR ${list})`;
  }
  const each = paths.map(p => p.map(one).join(' AND '));
  return each.length === 1 ? each[0] : `(${each.map(s => `(${s})`).join(' OR ')})`;
}

const NUMBER_TYPE = /INT|DECIMAL|DOUBLE|FLOAT|REAL|NUMERIC/i;
function cellValue(v, type) {
  if (typeof v === 'number' || NUMBER_TYPE.test(type || '')) return { xsd: 'xsd:double', text: String(v) };
  if (typeof v === 'boolean') return { xsd: 'xsd:boolean', text: String(v) };
  return { xsd: 'xsd:string', text: String(v) };
}

// -----------------------------------------------------------------------------
// The cell set's XML
// -----------------------------------------------------------------------------
const BASE_PROPERTIES = ['PARENT_UNIQUE_NAME', 'HIERARCHY_UNIQUE_NAME'];
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const propertyNames = axes => {
  const out = new Set(BASE_PROPERTIES);
  for (const a of axes) for (const p of a.properties) if (XML_NAME.test(p)) out.add(p);
  return [...out];
};
function hierarchyInfo(name, props) {
  const n = esc(name);
  const column = (tag, col, type) => `<${tag} name="${n}.[${col}]" type="xsd:${type}"/>`;
  return `<HierarchyInfo name="${n}">${column('UName', 'MEMBER_UNIQUE_NAME', 'string')}${column('Caption', 'MEMBER_CAPTION', 'string')}` +
    `${column('LName', 'LEVEL_UNIQUE_NAME', 'string')}${column('LNum', 'LEVEL_NUMBER', 'int')}${column('DisplayInfo', 'DISPLAY_INFO', 'unsignedInt')}` +
    `${props.map(p => column(p, p, 'string')).join('')}</HierarchyInfo>`;
}
function memberXml(m, display, props) {
  const value = {
    PARENT_UNIQUE_NAME: m.parent, HIERARCHY_UNIQUE_NAME: m.hierarchy, KEY0: m.key, MEMBER_NAME: m.caption, MEMBER_TYPE: m.type,
  };
  return `<Member Hierarchy="${esc(m.hierarchy)}"><UName>${esc(m.unique)}</UName><Caption>${esc(m.caption)}</Caption><LName>${esc(m.level)}</LName>` +
    `<LNum>${m.depth}</LNum><DisplayInfo>${display}</DisplayInfo>${props.map(p => (value[p] == null ? '' : `<${p}>${esc(value[p])}</${p}>`)).join('')}</Member>`;
}
const measureMember = m => ({ hierarchy: MEASURES, unique: m.unique, caption: m.name, level: MEASURES_LEVEL, depth: 0, parent: null, key: m.name, type: 3, children: 0, order: [] });
function pathMember(h, path, order) {
  const depth = path.length;
  return {
    hierarchy: h.unique, unique: memberUnique(h, path), caption: depth ? captionOf(path[depth - 1]) : 'All',
    level: depth ? h.levels[depth - 1].unique : h.allLevel, depth, parent: depth ? memberUnique(h, path.slice(0, -1)) : null,
    key: depth ? path[depth - 1] : 'All', type: depth ? 1 : 2, children: depth < h.levels.length ? 1 : 0, order,
  };
}
const root = (axesInfo, axes, cellInfo, cells) => '<root xmlns="urn:schemas-microsoft-com:xml-analysis:mddataset" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
  `<OlapInfo><CubeInfo><Cube><CubeName>${CUBE}</CubeName></Cube></CubeInfo><AxesInfo>${axesInfo}</AxesInfo><CellInfo>${cellInfo}</CellInfo></OlapInfo>` +
  `<Axes>${axes}</Axes><CellData>${cells}</CellData></root>`;

const CELL_INFO = {
  VALUE: '<Value name="VALUE"/>', FORMATTED_VALUE: '<FmtValue name="FORMATTED_VALUE"/>', FORMAT_STRING: '<FormatString name="FORMAT_STRING"/>',
};
const asked = props => {
  const known2 = (props || []).filter(p => CELL_INFO[p]);
  return known2.length ? known2 : ['VALUE'];
};

// DISPLAY_INFO: the low 16 bits are its children, 0x10000 says the next tuple is its child, and
// 0x20000 that it has the previous tuple's parent. Excel draws subtotals and +/- from these.
function axisXml(name, tuples, props) {
  const xs = tuples.map((t, ti) => `<Tuple>${t.members.map((m, mi) => {
    const prev = tuples[ti - 1]?.members[mi], next = tuples[ti + 1]?.members[mi];
    let display = Math.min(m.children, 0xffff);
    if (next && next.parent === m.unique) display |= 0x10000;
    if (prev && prev.parent === m.parent && prev.unique !== m.unique) display |= 0x20000;
    return memberXml(m, display, props);
  }).join('')}</Tuple>`).join('');
  return `<Axis name="${name}"><Tuples>${xs}</Tuples></Axis>`;
}

// -----------------------------------------------------------------------------
// A statement's grains
// -----------------------------------------------------------------------------
function grainsOf(plan) {
  let combos = [[]];
  for (const axis of plan.axes) {
    combos = combos.flatMap(c => axis.patterns.map(p => [...c, p]));
    if (combos.length > MAX_GRAINS) {
      throw new Error(`This PivotTable needs more than ${MAX_GRAINS} queries for its subtotals. Turn some subtotals off, or move a field to a filter.`);
    }
  }
  return combos;
}

function grainSql(combo, plan, cube) {
  const columns = new Map();   // table.column -> alias
  const aliasOf = c => {
    const k = columnRef(c);
    if (!columns.has(k)) columns.set(k, { alias: `c${columns.size}`, column: c });
    return columns.get(k).alias;
  };
  const where = plan.filters.map(f => condition(f.h, f.paths));
  const positions = combo.map(pat => pat.map(e => {
    if (e.measures) return { measures: e.measures };
    const levels = e.h.levels.slice(0, e.depth).map(l => ({
      alias: aliasOf(l.column), sort: l.column.sortBy ? aliasOf(l.column.sortBy) : null, column: l.column,
    }));
    if (e.paths) where.push(condition(e.h, e.paths));
    return { h: e.h, levels };
  }));
  const onAxis = positions.flat().find(p => p.measures);
  const measures = onAxis ? onAxis.measures : plan.slicerMeasure ? [plan.slicerMeasure] : [];
  const select = [...[...columns].map(([k, c]) => `${k} AS ${qid(c.alias)}`), ...measures.map((m, i) => `AGG(${qid(m.name)}) AS ${qid(`m${i}`)}`)];
  const sql = select.length
    ? `SELECT ${select.join(', ')} FROM ${cube.sqlName}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${columns.size ? ' GROUP BY ALL' : ''}`
    : null;
  return { sql, positions, measures };
}

async function eachAtOnce(list, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, list.length) }, async () => {
    while (next < list.length) { const i = next++; await fn(list[i], i); }
  }));
}

const checkKept = res => {
  if (res.numRows != null && res.numRows > res.rows.length) {
    throw new Error(`This PivotTable would show ${Number(res.numRows).toLocaleString('en')} lines, and a query keeps ${res.rows.length.toLocaleString('en')}. Filter it, or use fewer fields.`);
  }
  return res;
};

async function select(text, ctx) {
  const { cube, query, signal } = ctx;
  const plan = readQuery(parseSelect(text), cube);
  const props = propertyNames(plan.axes);
  const cellProps = asked(plan.cellProperties);
  // Every axis's tuples, by their unique names. The cells carry the same keys until the axes are sorted.
  const seen = plan.axes.map(() => new Map());
  const live = plan.axes.map(() => new Set());
  const cells = [];
  const measureIndex = new Map();
  const indexOf = m => { if (!measureIndex.has(m.unique)) measureIndex.set(m.unique, measureIndex.size); return measureIndex.get(m.unique); };

  const addTuple = (i, members, order) => {
    const key = members.map(m => m.unique).join('\u0001');
    if (!seen[i].has(key)) seen[i].set(key, { key, members, order });
    return key;
  };
  // An axis without NON EMPTY keeps its tuples with no data: what it lists can be listed without
  // a query, except a level's members, which is "show items with no data".
  for (const [i, axis] of plan.axes.entries()) {
    if (axis.nonEmpty) continue;
    for (const pat of axis.patterns) {
      let tuples = [{ members: [], order: [] }];
      for (const e of pat) {
        let next;
        if (e.measures) next = e.measures.map(m => ({ member: measureMember(m), order: [indexOf(m)] }));
        else if (e.depth === 0) next = [{ member: pathMember(e.h, [], []), order: [] }];
        else if (e.paths && e.paths.every(p => p.length === e.depth)) {
          next = e.paths.map(p => ({ member: pathMember(e.h, p, []), order: p.map((k, d) => sortKey(k === '' ? null : k, e.h.levels[d].column)) }));
        } else throw new Error('"Show items with no data" is not supported by OneLake Studio.');
        tuples = tuples.flatMap(t => next.map(n => ({ members: [...t.members, n.member], order: [...t.order, n.order] })));
      }
      for (const t of tuples) addTuple(i, t.members, t.order);
    }
  }

  const grains = grainsOf(plan);
  await eachAtOnce(grains, async combo => {
    const { sql, positions, measures } = grainSql(combo, plan, cube);
    const res = sql ? checkKept(await query(sql, { signal })) : { rows: [{}], fields: [] };
    const typeOf = new Map((res.fields || []).map(f => [f.name, f.type]));
    const mList = measures.length ? measures : [null];
    for (const row of res.rows) {
      const fixed = positions.map(axisPositions => axisPositions.map(p => {
        if (p.measures) return null;
        const path = p.levels.map(l => keyOf(row[l.alias]));
        const order = p.levels.map(l => sortKey(row[l.sort || l.alias], l.column));
        return { member: pathMember(p.h, path, order), order };
      }));
      mList.forEach((measure, mi) => {
        const keys = positions.map((axisPositions, ai) => {
          const members = [], order = [];
          axisPositions.forEach((p, pi) => {
            if (p.measures) { members.push(measureMember(measure)); order.push([indexOf(measure)]); }
            else { members.push(fixed[ai][pi].member); order.push(fixed[ai][pi].order); }
          });
          return addTuple(ai, members, order);
        });
        const value = measure ? row[`m${mi}`] : null;
        if (!measure) keys.forEach((k, ai) => live[ai].add(k));     // no measure: the members themselves
        else if (value != null) {
          keys.forEach((k, ai) => live[ai].add(k));
          cells.push({ keys, value, type: typeOf.get(`m${mi}`), format: measure.format });
        }
      });
    }
  });

  const axes = plan.axes.map((axis, i) => {
    const kept = [...seen[i].values()].filter(t => !axis.nonEmpty || live[i].has(t.key));
    kept.sort((a, b) => {
      for (let k = 0; k < a.order.length; k++) {
        const c = compareKeys(a.order[k], b.order[k]);
        if (c) return c;
      }
      return 0;
    });
    return kept;
  });
  const positionsOf = axes.map(tuples => new Map(tuples.map((t, n) => [t.key, n])));
  const strides = [];
  axes.reduce((s, tuples, i) => { strides[i] = s; return s * Math.max(tuples.length, 1); }, 1);
  const placed = [];
  for (const c of cells) {
    let ordinal = 0, keep = true;
    c.keys.forEach((k, i) => {
      const at = positionsOf[i].get(k);
      if (at === undefined) keep = false; else ordinal += at * strides[i];
    });
    if (keep) placed.push({ ordinal, ...c });
  }
  placed.sort((a, b) => a.ordinal - b.ordinal);
  const cellXml = placed.map(c => {
    const v = cellValue(c.value, c.type);
    const parts = cellProps.map(p => (
      p === 'VALUE' ? `<Value xsi:type="${v.xsd}">${esc(v.text)}</Value>`
        : p === 'FORMATTED_VALUE' ? `<FmtValue>${esc(v.text)}</FmtValue>`
          : c.format ? `<FormatString>${esc(c.format)}</FormatString>` : ''));
    return `<Cell CellOrdinal="${c.ordinal}">${parts.join('')}</Cell>`;
  }).join('');

  // The slicer axis: every other hierarchy at its chosen member, else its default. Excel reads
  // what's filtered from here, so it holds them all.
  const onAxis = new Set(plan.axes.flatMap(a => (a.patterns[0] || []).map(e => (e.measures ? MEASURES : e.h.unique))));
  const slicerMembers = [];
  if (!onAxis.has(MEASURES)) {
    const m = plan.slicerMeasure || cube.defaultMeasure;
    if (m) slicerMembers.push(measureMember(m));
  }
  for (const h of cube.hierarchies) {
    if (!onAxis.has(h.unique)) slicerMembers.push(pathMember(h, plan.chosen.get(h.unique) || [], []));
  }
  const hierarchiesOf = a => (a.patterns[0] || []).map(e => (e.measures ? MEASURES : e.h.unique));
  const axesInfo = plan.axes.map((a, i) => `<AxisInfo name="Axis${i}">${hierarchiesOf(a).map(n => hierarchyInfo(n, props)).join('')}</AxisInfo>`).join('') +
    `<AxisInfo name="SlicerAxis">${slicerMembers.map(m => hierarchyInfo(m.hierarchy, props)).join('')}</AxisInfo>`;
  const axesXml = axes.map((tuples, i) => axisXml(`Axis${i}`, tuples, props)).join('') +
    `<Axis name="SlicerAxis"><Tuples><Tuple>${slicerMembers.map(m => memberXml(m, 0, props)).join('')}</Tuple></Tuples></Axis>`;
  return root(axesInfo, axesXml, cellProps.map(p => CELL_INFO[p]).join(''), cellXml);
}

// -----------------------------------------------------------------------------
// A slicer's two statements. One calculated measure on axis 0 and, for the items, a level's
// members on axis 1: those with data under the pivot's other fields first, flagged 1.
// -----------------------------------------------------------------------------
function levelOf(raw, cube) {
  const hit = known(raw, cube);
  if (hit.depth == null || hit.depth === 0) throw new Error(`${raw} is not a level of this model`);
  return hit;
}
const calculated = name => ({ hierarchy: MEASURES, unique: name, caption: name.replace(/^\[Measures\]\./, ''), level: MEASURES_LEVEL, depth: 0, parent: null, key: name, type: 4, children: 0, order: [] });
function cellset(measure, memberTuples, h, values) {
  const props = BASE_PROPERTIES;
  const info = `<AxisInfo name="Axis0">${hierarchyInfo(MEASURES, props)}</AxisInfo>` +
    (h ? `<AxisInfo name="Axis1">${hierarchyInfo(h.unique, props)}</AxisInfo>` : '') + '<AxisInfo name="SlicerAxis"/>';
  const axes = axisXml('Axis0', [{ members: [measure] }], props) +
    (h ? axisXml('Axis1', memberTuples, props) : '') + '<Axis name="SlicerAxis"><Tuples><Tuple/></Tuples></Axis>';
  const cells = values.map((v, i) => `<Cell CellOrdinal="${i}"><Value xsi:type="xsd:int">${v}</Value></Cell>`).join('');
  return root(info, axes, CELL_INFO.VALUE, cells);
}

async function template(t, ctx) {
  const { cube, query, signal } = ctx;
  const { hierarchy: h, depth } = levelOf(t.level, cube);
  const all = await memberPaths(cube, h, depth, [], ctx);
  if (t.kind === 'count') return cellset(calculated(t.measure), null, null, [all.length]);
  const into = { filters: [], chosen: new Map(), measures: [] };
  for (const s of t.slices) readFilter(evalSet(parseSet(s), cube), into);
  const measure = into.measures[0] || cube.defaultMeasure;
  const cols = h.levels.slice(0, depth).map(l => l.column);
  const where = into.filters.map(f => condition(f.h, f.paths));
  const select2 = [...cols.map((c, i) => `${columnRef(c)} AS ${qid(`c${i}`)}`), ...(measure ? [`AGG(${qid(measure.name)}) AS ${qid('m')}`] : [])];
  const res = checkKept(await query(`SELECT ${select2.join(', ')} FROM ${cube.sqlName}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} GROUP BY ALL`, { signal }));
  const live = new Set(res.rows.map(r => cols.map((_, i) => keyOf(r[`c${i}`])).join('\0')));
  const existing = all.filter(p => live.has(p.join('\0')));
  const others = all.filter(p => !live.has(p.join('\0')));
  const shown = [...existing, ...others].slice(t.offset, t.offset + t.size);
  const flagged = shown.map(p => (live.has(p.join('\0')) ? 1 : 0));
  return cellset(calculated(t.measure), shown.map(p => ({ members: [pathMember(h, p, [])] })), h, flagged);
}

/** An Execute's statement, as the root of its answer. `ctx`: { cube, query(sql, { signal }), signal }. */
async function execute(text, ctx) {
  const t = slicerTemplate(text);
  return t ? template(t, ctx) : select(text, ctx);
}

module.exports = { execute, literal, condition };
