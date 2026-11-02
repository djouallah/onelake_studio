'use strict';
// =============================================================================
// rowsets.js — Discover: the cube described in the rowsets Excel's field list reads
// =============================================================================
// These are the rowsets Excel asks for (captured from Excel 16 and MSOLAP 17). Only a member
// list runs a query: the model's values are its data, and the rest is the model's definition.
// =============================================================================
const { rowset, schemaRowsets, columns } = require('./soap.js');
const { CUBE, memberUnique, keyOf, captionOf, resolve, columnRef } = require('./cube.js');
const { sortKey, compareKeys } = require('./order.js');

const NOW = '2000-01-01T00:00:00';

const COLUMNS = {
  DBSCHEMA_CATALOGS: columns('CATALOG_NAME DESCRIPTION ROLES DATE_MODIFIED:dateTime COMPATIBILITY_LEVEL:int TYPE:unsignedByte VERSION:int DATABASE_ID'),
  MDSCHEMA_CUBES: columns('CATALOG_NAME SCHEMA_NAME CUBE_NAME CUBE_TYPE CUBE_GUID CREATED_ON:dateTime LAST_SCHEMA_UPDATE:dateTime SCHEMA_UPDATED_BY LAST_DATA_UPDATE:dateTime DATA_UPDATED_BY DESCRIPTION IS_DRILLTHROUGH_ENABLED:boolean IS_LINKABLE:boolean IS_WRITE_ENABLED:boolean IS_SQL_ENABLED:boolean CUBE_CAPTION BASE_CUBE_NAME CUBE_SOURCE:unsignedShort PREFERRED_QUERY_PATTERNS:unsignedShort'),
  MDSCHEMA_MEASUREGROUPS: columns('CATALOG_NAME SCHEMA_NAME CUBE_NAME MEASUREGROUP_NAME DESCRIPTION IS_WRITE_ENABLED:boolean MEASUREGROUP_CAPTION'),
  MDSCHEMA_MEASUREGROUP_DIMENSIONS: columns('CATALOG_NAME SCHEMA_NAME CUBE_NAME MEASUREGROUP_NAME MEASUREGROUP_CARDINALITY DIMENSION_UNIQUE_NAME DIMENSION_CARDINALITY DIMENSION_IS_VISIBLE:boolean DIMENSION_IS_FACT_DIMENSION:boolean DIMENSION_PATH DIMENSION_GRANULARITY'),
  MDSCHEMA_DIMENSIONS: columns('CATALOG_NAME SCHEMA_NAME CUBE_NAME DIMENSION_NAME DIMENSION_UNIQUE_NAME DIMENSION_GUID DIMENSION_CAPTION DIMENSION_ORDINAL:unsignedInt DIMENSION_TYPE:short DIMENSION_CARDINALITY:unsignedInt DEFAULT_HIERARCHY DESCRIPTION IS_VIRTUAL:boolean IS_READWRITE:boolean DIMENSION_UNIQUE_SETTINGS:int DIMENSION_MASTER_NAME DIMENSION_IS_VISIBLE:boolean'),
  MDSCHEMA_HIERARCHIES: columns('CATALOG_NAME SCHEMA_NAME CUBE_NAME DIMENSION_UNIQUE_NAME HIERARCHY_NAME HIERARCHY_UNIQUE_NAME HIERARCHY_GUID HIERARCHY_CAPTION DIMENSION_TYPE:short HIERARCHY_CARDINALITY:unsignedInt DEFAULT_MEMBER ALL_MEMBER DESCRIPTION STRUCTURE:short IS_VIRTUAL:boolean IS_READWRITE:boolean DIMENSION_UNIQUE_SETTINGS:int DIMENSION_MASTER_UNIQUE_NAME DIMENSION_IS_VISIBLE:boolean HIERARCHY_ORDINAL:unsignedInt DIMENSION_IS_SHARED:boolean HIERARCHY_IS_VISIBLE:boolean HIERARCHY_ORIGIN:unsignedShort HIERARCHY_DISPLAY_FOLDER INSTANCE_SELECTION:unsignedShort GROUPING_BEHAVIOR:short STRUCTURE_TYPE'),
  MDSCHEMA_LEVELS: columns('CATALOG_NAME SCHEMA_NAME CUBE_NAME DIMENSION_UNIQUE_NAME HIERARCHY_UNIQUE_NAME LEVEL_NAME LEVEL_UNIQUE_NAME LEVEL_GUID LEVEL_CAPTION LEVEL_NUMBER:unsignedInt LEVEL_CARDINALITY:unsignedInt LEVEL_TYPE:int DESCRIPTION CUSTOM_ROLLUP_SETTINGS:int LEVEL_UNIQUE_SETTINGS:int LEVEL_IS_VISIBLE:boolean LEVEL_ORDERING_PROPERTY LEVEL_DBTYPE:int LEVEL_MASTER_UNIQUE_NAME LEVEL_NAME_SQL_COLUMN_NAME LEVEL_KEY_SQL_COLUMN_NAME LEVEL_UNIQUE_NAME_SQL_COLUMN_NAME LEVEL_ATTRIBUTE_HIERARCHY_NAME LEVEL_KEY_CARDINALITY:unsignedShort LEVEL_ORIGIN:unsignedShort'),
  MDSCHEMA_MEASURES: columns('CATALOG_NAME SCHEMA_NAME CUBE_NAME MEASURE_NAME MEASURE_UNIQUE_NAME MEASURE_CAPTION MEASURE_GUID MEASURE_AGGREGATOR:int DATA_TYPE:unsignedShort NUMERIC_PRECISION:unsignedShort NUMERIC_SCALE:short MEASURE_UNITS DESCRIPTION EXPRESSION MEASURE_IS_VISIBLE:boolean LEVELS_LIST MEASURE_NAME_SQL_COLUMN_NAME MEASURE_UNQUALIFIED_CAPTION MEASUREGROUP_NAME MEASURE_DISPLAY_FOLDER DEFAULT_FORMAT_STRING'),
  MDSCHEMA_MEMBERS: columns('CATALOG_NAME SCHEMA_NAME CUBE_NAME DIMENSION_UNIQUE_NAME HIERARCHY_UNIQUE_NAME LEVEL_UNIQUE_NAME LEVEL_NUMBER:unsignedInt MEMBER_ORDINAL:unsignedInt MEMBER_NAME MEMBER_UNIQUE_NAME MEMBER_TYPE:int MEMBER_GUID MEMBER_CAPTION CHILDREN_CARDINALITY:unsignedInt PARENT_LEVEL:unsignedInt PARENT_UNIQUE_NAME PARENT_COUNT:unsignedInt DESCRIPTION EXPRESSION MEMBER_KEY IS_PLACEHOLDERMEMBER:boolean IS_DATAMEMBER:boolean'),
  MDSCHEMA_SETS: columns('CATALOG_NAME SCHEMA_NAME CUBE_NAME SET_NAME SCOPE:int DESCRIPTION EXPRESSION DIMENSIONS SET_CAPTION SET_DISPLAY_FOLDER'),
  MDSCHEMA_KPIS: columns('CATALOG_NAME SCHEMA_NAME CUBE_NAME MEASUREGROUP_NAME KPI_NAME KPI_CAPTION KPI_DESCRIPTION KPI_DISPLAY_FOLDER KPI_VALUE KPI_GOAL KPI_STATUS KPI_TREND KPI_STATUS_GRAPHIC KPI_TREND_GRAPHIC KPI_WEIGHT KPI_CURRENT_TIME_MEMBER KPI_PARENT_KPI_NAME SCOPE:int'),
  MDSCHEMA_ACTIONS: columns('CATALOG_NAME SCHEMA_NAME CUBE_NAME ACTION_NAME ACTION_TYPE:int COORDINATE COORDINATE_TYPE:int ACTION_CAPTION DESCRIPTION CONTENT INVOCATION:int'),
  MDSCHEMA_PROPERTIES: columns('CATALOG_NAME SCHEMA_NAME CUBE_NAME DIMENSION_UNIQUE_NAME HIERARCHY_UNIQUE_NAME LEVEL_UNIQUE_NAME MEMBER_UNIQUE_NAME PROPERTY_TYPE:short PROPERTY_NAME PROPERTY_CAPTION DATA_TYPE:unsignedShort CHARACTER_MAXIMUM_LENGTH:unsignedInt CHARACTER_OCTET_LENGTH:unsignedInt NUMERIC_PRECISION:unsignedShort NUMERIC_SCALE:short DESCRIPTION PROPERTY_CONTENT_TYPE:short SQL_COLUMN_NAME LANGUAGE:unsignedShort PROPERTY_ORIGIN:unsignedShort PROPERTY_ATTRIBUTE_HIERARCHY_NAME PROPERTY_CARDINALITY PROPERTY_IS_VISIBLE:boolean MIME_TYPE'),
  DISCOVER_LITERALS: columns('LiteralName LiteralValue LiteralInvalidChars LiteralInvalidStartingChars LiteralMaxLength:int LiteralNameEnumValue:int'),
};
const PROPERTY_COLUMNS = columns('PropertyName PropertyDescription PropertyType PropertyAccessType IsRequired:boolean Value');

// What the provider asks of the server before it goes on.
const PROPERTIES = {
  ProviderName: 'OneLake Studio', ProviderVersion: '16.0.0.0', DBMSVersion: '16.0.0.0', ServerName: 'OneLake Studio',
  MdpropMdxSubqueries: '15', MdpropMdxDrillFunctions: '3', MdpropMdxNamedSets: '15', MdpropMdxDdlExtensions: '1',
  DbpropMsmdSubqueries: '3', DbpropMsmdOptimizeResponse: '0', DbpropMsmdActivityID: '', DbpropMsmdCurrentActivityID: '', ApplicationContext: '',
};

// Each rowset's GUID is the provider's own, and its restrictions are how it asks for less.
const G1 = '-5CF3-11CE-ADE5-00AA0044773D', G2 = '-8148-11D0-87BB-00C04FC33942';
const CC = 'CATALOG_NAME SCHEMA_NAME CUBE_NAME';
const SHORTS = new Set(['LEVEL_NUMBER', 'MEMBER_TYPE', 'TREE_OP', 'CUBE_SOURCE', 'DIMENSION_VISIBILITY', 'HIERARCHY_VISIBILITY',
  'LEVEL_VISIBILITY', 'MEASURE_VISIBILITY', 'PROPERTY_VISIBILITY', 'HIERARCHY_ORIGIN', 'LEVEL_ORIGIN', 'PROPERTY_ORIGIN', 'PROPERTY_TYPE', 'PROPERTY_CONTENT_TYPE']);
const INTS = new Set(['ACTION_TYPE', 'COORDINATE_TYPE', 'INVOCATION', 'SCOPE']);
const typeOf = n => (SHORTS.has(n) ? 'unsignedShort' : INTS.has(n) ? 'int' : 'string');
const SCHEMAS = Object.entries({
  DBSCHEMA_CATALOGS: ['C8B52211' + G1, 'CATALOG_NAME'],
  MDSCHEMA_CUBES: ['C8B522D8' + G1, CC],
  MDSCHEMA_DIMENSIONS: ['C8B522D9' + G1, `${CC} DIMENSION_NAME DIMENSION_UNIQUE_NAME CUBE_SOURCE DIMENSION_VISIBILITY`],
  MDSCHEMA_HIERARCHIES: ['C8B522DA' + G1, `${CC} DIMENSION_UNIQUE_NAME HIERARCHY_NAME HIERARCHY_UNIQUE_NAME HIERARCHY_ORIGIN CUBE_SOURCE HIERARCHY_VISIBILITY`],
  MDSCHEMA_LEVELS: ['C8B522DB' + G1, `${CC} DIMENSION_UNIQUE_NAME HIERARCHY_UNIQUE_NAME LEVEL_NAME LEVEL_UNIQUE_NAME LEVEL_ORIGIN CUBE_SOURCE LEVEL_VISIBILITY`],
  MDSCHEMA_MEASURES: ['C8B522DC' + G1, `${CC} MEASURE_NAME MEASURE_UNIQUE_NAME MEASUREGROUP_NAME CUBE_SOURCE MEASURE_VISIBILITY`],
  MDSCHEMA_PROPERTIES: ['C8B522DD' + G1, `${CC} DIMENSION_UNIQUE_NAME HIERARCHY_UNIQUE_NAME LEVEL_UNIQUE_NAME MEMBER_UNIQUE_NAME PROPERTY_NAME PROPERTY_TYPE PROPERTY_CONTENT_TYPE PROPERTY_ORIGIN CUBE_SOURCE PROPERTY_VISIBILITY`],
  MDSCHEMA_MEMBERS: ['C8B522DE' + G1, `${CC} DIMENSION_UNIQUE_NAME HIERARCHY_UNIQUE_NAME LEVEL_UNIQUE_NAME LEVEL_NUMBER MEMBER_NAME MEMBER_UNIQUE_NAME MEMBER_CAPTION MEMBER_TYPE TREE_OP CUBE_SOURCE`],
  MDSCHEMA_ACTIONS: ['A07CCD08' + G2, `${CC} ACTION_NAME ACTION_TYPE COORDINATE COORDINATE_TYPE INVOCATION CUBE_SOURCE`],
  MDSCHEMA_SETS: ['A07CCD0B' + G2, `${CC} SET_NAME SCOPE CUBE_SOURCE HIERARCHY_UNIQUE_NAME SET_CAPTION`],
  MDSCHEMA_KPIS: ['2AE44109-ED3D-4842-B16F-B694D1CB0E3F', `${CC} MEASUREGROUP_NAME KPI_NAME CUBE_SOURCE`],
  MDSCHEMA_MEASUREGROUPS: ['E1625EBF-FA96-42FD-BEA6-DB90ADAFD96B', `${CC} MEASUREGROUP_NAME`],
  MDSCHEMA_MEASUREGROUP_DIMENSIONS: ['A07CCD33' + G2, `${CC} MEASUREGROUP_NAME DIMENSION_UNIQUE_NAME DIMENSION_VISIBILITY`],
  DISCOVER_PROPERTIES: ['4B40ADFD-8B09-4758-97BB-636E8AE97BCF', 'PropertyName'],
  DISCOVER_SCHEMA_ROWSETS: ['EEA0302B-7922-4992-8991-0E605D0E5593', 'SchemaName'],
  DISCOVER_LITERALS: ['C3EF5ECB-0A07-4665-A140-B075722DBDC2', 'LiteralName'],
}).map(([name, [guid, r]]) => ({ name, guid, restrictions: r.split(' ').map(n => ({ name: n, type: typeOf(n) })) }));

// Rowsets that need no model: the provider reads them before it has named a catalog.
const WITHOUT_MODEL = new Set(['DISCOVER_PROPERTIES', 'DISCOVER_SCHEMA_ROWSETS', 'DISCOVER_LITERALS']);

function discoverServer(type, r, catalog) {
  if (type === 'DISCOVER_PROPERTIES') {
    // Catalog is the connection's own: the provider asks, and goes no further without its answer.
    const known = { ...PROPERTIES, ...(catalog ? { Catalog: catalog } : {}) };
    const names = (r.PropertyName || Object.keys(known)).filter(n => n in known);
    return rowset(PROPERTY_COLUMNS, names.map(n => ({ PropertyName: n, PropertyDescription: n, PropertyType: 'string', PropertyAccessType: 'Read', IsRequired: false, Value: known[n] })));
  }
  if (type === 'DISCOVER_SCHEMA_ROWSETS') {
    return schemaRowsets(r.SchemaName ? SCHEMAS.filter(s => r.SchemaName.includes(s.name)) : SCHEMAS);
  }
  return rowset(COLUMNS.DISCOVER_LITERALS, [
    { LiteralName: 'DBLITERAL_QUOTE_PREFIX', LiteralValue: '[', LiteralMaxLength: 1, LiteralNameEnumValue: 15 },
    { LiteralName: 'DBLITERAL_QUOTE_SUFFIX', LiteralValue: ']', LiteralMaxLength: 1, LiteralNameEnumValue: 28 },
  ]);
}

const CARDINALITY = 1000;   // a figure the provider wants; a true one would be a query per column
const MEASURES_U = '[Measures]', MEASURES_LEVEL = '[Measures].[MeasuresLevel]';

function definitionRows(cube, type) {
  const base = { CATALOG_NAME: cube.catalog, CUBE_NAME: CUBE };
  switch (type) {
    case 'DBSCHEMA_CATALOGS':
      return [{ CATALOG_NAME: cube.catalog, DESCRIPTION: '', ROLES: '', DATABASE_ID: cube.catalog, COMPATIBILITY_LEVEL: 1600, TYPE: 1, VERSION: 1 }];
    case 'MDSCHEMA_CUBES':
      return [{ ...base, CUBE_TYPE: 'CUBE', LAST_SCHEMA_UPDATE: NOW, LAST_DATA_UPDATE: NOW, IS_DRILLTHROUGH_ENABLED: false, IS_LINKABLE: false,
                IS_WRITE_ENABLED: false, IS_SQL_ENABLED: false, CUBE_CAPTION: CUBE, CUBE_SOURCE: 1, PREFERRED_QUERY_PATTERNS: 0 }];
    case 'MDSCHEMA_MEASUREGROUPS':
      return cube.groups.map(g => ({ ...base, MEASUREGROUP_NAME: g, DESCRIPTION: '', IS_WRITE_ENABLED: false, MEASUREGROUP_CAPTION: g }));
    case 'MDSCHEMA_MEASUREGROUP_DIMENSIONS':
      // Every dimension for every group: which reach which is DAX's to say, not the field list's.
      return cube.groups.flatMap(g => cube.dimensions.map(d => ({
        ...base, MEASUREGROUP_NAME: g, MEASUREGROUP_CARDINALITY: 'ONE', DIMENSION_UNIQUE_NAME: d.unique, DIMENSION_CARDINALITY: 'MANY',
        DIMENSION_IS_VISIBLE: true, DIMENSION_IS_FACT_DIMENSION: false, DIMENSION_GRANULARITY: d.hierarchies[0].unique,
      })));
    case 'MDSCHEMA_DIMENSIONS':
      return [
        { ...base, DIMENSION_NAME: 'Measures', DIMENSION_UNIQUE_NAME: MEASURES_U, DIMENSION_CAPTION: 'Measures', DIMENSION_ORDINAL: 0, DIMENSION_TYPE: 2,
          DIMENSION_CARDINALITY: cube.listedMeasures.length, DEFAULT_HIERARCHY: MEASURES_U, IS_VIRTUAL: false, IS_READWRITE: false, DIMENSION_UNIQUE_SETTINGS: 0, DIMENSION_IS_VISIBLE: true },
        ...cube.dimensions.map((d, i) => ({
          ...base, DIMENSION_NAME: d.name, DIMENSION_UNIQUE_NAME: d.unique, DIMENSION_CAPTION: d.name, DIMENSION_ORDINAL: i + 1, DIMENSION_TYPE: 3,
          DIMENSION_CARDINALITY: CARDINALITY, DEFAULT_HIERARCHY: d.hierarchies[0].unique, DESCRIPTION: d.description, IS_VIRTUAL: false, IS_READWRITE: false, DIMENSION_UNIQUE_SETTINGS: 1, DIMENSION_IS_VISIBLE: true })),
      ];
    case 'MDSCHEMA_HIERARCHIES': {
      const common = { IS_VIRTUAL: false, IS_READWRITE: false, DIMENSION_UNIQUE_SETTINGS: 1, DIMENSION_IS_VISIBLE: true, STRUCTURE: 0, DIMENSION_IS_SHARED: true,
                       HIERARCHY_IS_VISIBLE: true, INSTANCE_SELECTION: 0, GROUPING_BEHAVIOR: 1, STRUCTURE_TYPE: 'Natural' };
      return [
        { ...base, ...common, DIMENSION_UNIQUE_NAME: MEASURES_U, HIERARCHY_NAME: 'Measures', HIERARCHY_UNIQUE_NAME: MEASURES_U, HIERARCHY_CAPTION: 'Measures', DIMENSION_TYPE: 2,
          HIERARCHY_CARDINALITY: cube.listedMeasures.length, DEFAULT_MEMBER: cube.defaultMeasure?.unique, HIERARCHY_ORDINAL: 0, HIERARCHY_ORIGIN: 2 },
        ...cube.hierarchies.map((h, i) => ({
          ...base, ...common, DIMENSION_UNIQUE_NAME: h.dimension.unique, HIERARCHY_NAME: h.name, HIERARCHY_UNIQUE_NAME: h.unique, HIERARCHY_CAPTION: h.name, DIMENSION_TYPE: 3,
          HIERARCHY_CARDINALITY: CARDINALITY, DEFAULT_MEMBER: h.all, ALL_MEMBER: h.all, DESCRIPTION: h.description, HIERARCHY_ORDINAL: i + 1, HIERARCHY_ORIGIN: h.origin, HIERARCHY_DISPLAY_FOLDER: h.folder })),
      ];
    }
    case 'MDSCHEMA_LEVELS': {
      const level = (dim, h, name, unique, number, card, type2) => ({
        ...base, DIMENSION_UNIQUE_NAME: dim, HIERARCHY_UNIQUE_NAME: h, LEVEL_NAME: name, LEVEL_UNIQUE_NAME: unique, LEVEL_CAPTION: name, LEVEL_NUMBER: number, LEVEL_CARDINALITY: card,
        LEVEL_TYPE: type2, CUSTOM_ROLLUP_SETTINGS: 0, LEVEL_UNIQUE_SETTINGS: 1, LEVEL_IS_VISIBLE: true, LEVEL_DBTYPE: 130, LEVEL_KEY_CARDINALITY: 1, LEVEL_ORIGIN: 2 });
      return [
        level(MEASURES_U, MEASURES_U, 'MeasuresLevel', MEASURES_LEVEL, 0, cube.listedMeasures.length, 0),
        ...cube.hierarchies.flatMap(h => [
          level(h.dimension.unique, h.unique, '(All)', h.allLevel, 0, 1, 1),
          ...h.levels.map(l => level(h.dimension.unique, h.unique, l.name, l.unique, l.number, CARDINALITY, 0)),
        ]),
      ];
    }
    case 'MDSCHEMA_MEASURES':
      return cube.listedMeasures.map(m => ({
        ...base, MEASURE_NAME: m.name, MEASURE_UNIQUE_NAME: m.unique, MEASURE_CAPTION: m.name, MEASURE_AGGREGATOR: 127, DATA_TYPE: 5, NUMERIC_PRECISION: 16, NUMERIC_SCALE: -1,
        DESCRIPTION: m.description, MEASURE_IS_VISIBLE: !m.placeholder, MEASUREGROUP_NAME: m.table, MEASURE_DISPLAY_FOLDER: m.folder, DEFAULT_FORMAT_STRING: m.format }));
    default:
      return [];   // sets, KPIs, actions and member properties: a model here has none
  }
}

// A rowset's restrictions on its own columns: a blank in a row is no answer, so it stays.
function filtered(cols, rows, r, skip = new Set()) {
  const names = new Set(cols.map(c => c.name));
  let out = rows;
  for (const [k, want] of Object.entries(r)) {
    if (!names.has(k) || skip.has(k)) continue;
    const lower = want.map(v => v.toLowerCase());
    out = out.filter(x => x[k] == null || lower.includes(String(x[k]).toLowerCase()));
  }
  return out;
}

// -----------------------------------------------------------------------------
// Members: the All member and the measures are the model's, the rest is its data.
// -----------------------------------------------------------------------------
const hasChildren = (h, depth) => depth < h.levels.length;

function memberRow(cube, h, path, ordinal) {
  const depth = path.length;
  const level = depth ? h.levels[depth - 1].unique : h.allLevel;
  const parent = depth ? memberUnique(h, path.slice(0, -1)) : null;
  const key = depth ? path[depth - 1] : '';
  const name = depth ? captionOf(key) : 'All';
  return {
    CATALOG_NAME: cube.catalog, CUBE_NAME: CUBE, DIMENSION_UNIQUE_NAME: h.dimension.unique, HIERARCHY_UNIQUE_NAME: h.unique, LEVEL_UNIQUE_NAME: level,
    LEVEL_NUMBER: depth, MEMBER_ORDINAL: ordinal, MEMBER_NAME: name, MEMBER_UNIQUE_NAME: memberUnique(h, path), MEMBER_TYPE: depth ? 1 : 2, MEMBER_CAPTION: name,
    CHILDREN_CARDINALITY: hasChildren(h, depth) ? CARDINALITY : 0, PARENT_LEVEL: Math.max(0, depth - 1), PARENT_UNIQUE_NAME: parent, PARENT_COUNT: parent ? 1 : 0,
    MEMBER_KEY: depth ? key : 'All', IS_PLACEHOLDERMEMBER: false, IS_DATAMEMBER: false,
  };
}
const measureRow = (cube, m, ordinal) => ({
  CATALOG_NAME: cube.catalog, CUBE_NAME: CUBE, DIMENSION_UNIQUE_NAME: MEASURES_U, HIERARCHY_UNIQUE_NAME: MEASURES_U, LEVEL_UNIQUE_NAME: MEASURES_LEVEL, LEVEL_NUMBER: 0,
  MEMBER_ORDINAL: ordinal, MEMBER_NAME: m.name, MEMBER_UNIQUE_NAME: m.unique, MEMBER_TYPE: 3, MEMBER_CAPTION: m.name, CHILDREN_CARDINALITY: 0, PARENT_LEVEL: 0, PARENT_COUNT: 0,
  MEMBER_KEY: m.name, IS_PLACEHOLDERMEMBER: false, IS_DATAMEMBER: false,
});

/** The paths of a hierarchy's members at `depth`, under `prefix`, in their order. Model SELECT: its columns, and each one's sort-by column. */
async function memberPaths(cube, h, depth, prefix, { query, literal, signal }) {
  if (depth === 0) return [[]];
  const cols = h.levels.slice(0, depth).map(l => l.column);
  const select = cols.flatMap((c, i) => [
    `${columnRef(c)} AS "c${i}"`,
    ...(c.sortBy ? [`${columnRef(c.sortBy)} AS "s${i}"`] : []),
  ]);
  const where = prefix.map((k, i) => (k === '' ? `${columnRef(cols[i])} IS NULL` : `${columnRef(cols[i])} = ${literal(cols[i], k)}`));
  const sql = `SELECT ${select.join(', ')} FROM ${cube.sqlName}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} GROUP BY ALL`;
  const res = await query(sql, { signal });
  const rows = res.rows.map(row => ({
    path: cols.map((_, i) => keyOf(row[`c${i}`])),
    order: cols.map((c, i) => sortKey(c.sortBy ? row[`s${i}`] : row[`c${i}`], c)),
  }));
  rows.sort((a, b) => compareKeys(a.order, b.order));
  return rows.map(r => r.path);
}

async function memberRows(cube, r, ctx) {
  const rows = [];
  const add = (h, paths) => { for (const p of paths) rows.push(memberRow(cube, h, p, rows.length)); };
  const name = r.MEMBER_UNIQUE_NAME?.[0];
  if (name) {
    const hit = resolve(cube, name);
    if (hit?.measure) return [measureRow(cube, hit.measure, 0)];
    if (!hit?.hierarchy || !hit.path) return [];
    const { hierarchy: h, path } = hit;
    const op = Number(r.TREE_OP?.[0] || 8);
    const children = p => memberPaths(cube, h, p.length + 1, p, ctx);
    const descendants = async p => {
      if (!hasChildren(h, p.length)) return [];
      const kids = await children(p);
      return (await Promise.all(kids.map(async k => [k, ...await descendants(k)]))).flat();
    };
    if (op & 8) add(h, [path]);
    if ((op & 1) && hasChildren(h, path.length)) add(h, await children(path));
    if ((op & 2) && path.length) add(h, (await children(path.slice(0, -1))).filter(p => p.join('\0') !== path.join('\0')));
    if ((op & 4) && path.length) add(h, [path.slice(0, -1)]);
    if (op & 16) add(h, await descendants(path));
    if (op & 32) add(h, path.map((_, i) => path.slice(0, path.length - 1 - i)));
    return rows;
  }
  const measuresOnly = rs => (rs || []).some(v => v.toLowerCase() === MEASURES_U.toLowerCase());
  if (measuresOnly(r.HIERARCHY_UNIQUE_NAME) || measuresOnly(r.DIMENSION_UNIQUE_NAME)) {
    return cube.listedMeasures.map((m, i) => measureRow(cube, m, i));
  }
  const levelName = r.LEVEL_UNIQUE_NAME?.[0];
  if (levelName) {
    const hit = resolve(cube, levelName);
    if (hit?.depth == null) return levelName.toLowerCase() === MEASURES_LEVEL.toLowerCase() ? cube.listedMeasures.map((m, i) => measureRow(cube, m, i)) : [];
    add(hit.hierarchy, await memberPaths(cube, hit.hierarchy, hit.depth, [], ctx));
    return rows;
  }
  const hierarchyName = r.HIERARCHY_UNIQUE_NAME?.[0];
  if (hierarchyName) {
    const h = resolve(cube, hierarchyName)?.hierarchy;
    if (!h) return [];
    const depths = r.LEVEL_NUMBER ? r.LEVEL_NUMBER.map(Number) : h.levels.map(l => l.number).concat(0).sort((a, b) => a - b);
    for (const d of depths) add(h, await memberPaths(cube, h, d, [], ctx));
    return rows;
  }
  // Nothing narrower than the cube: the members that cost no query.
  return [...cube.listedMeasures.map((m, i) => measureRow(cube, m, i)), ...cube.hierarchies.map((h, i) => memberRow(cube, h, [], cube.listedMeasures.length + i))];
}

/** A Discover's rowset. `ctx`: { query, literal, signal } for what reads data. */
async function discover(cube, type, r, ctx) {
  if (!(type in COLUMNS)) throw new Error(`OneLake Studio has no rowset ${type}`);
  if (type === 'MDSCHEMA_MEMBERS') {
    const rows = await memberRows(cube, r, ctx);
    return rowset(COLUMNS[type], filtered(COLUMNS[type], rows, r, new Set(['MEMBER_UNIQUE_NAME'])));
  }
  return rowset(COLUMNS[type], filtered(COLUMNS[type], definitionRows(cube, type), r));
}

module.exports = { WITHOUT_MODEL, discoverServer, discover, memberPaths, hasChildren };
