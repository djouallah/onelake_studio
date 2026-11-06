'use strict';
// =============================================================================
// pbimodel.js — the Power BI semantic model Export to Fabric makes of a model file
// =============================================================================
// Export to Fabric's DirectQuery and Direct Lake modes write the model as a Fabric semantic model
// item (fabricmodel.js), and the app runs its queries there as DAX. This is that item's
// definition, worked out from the model's TMSL (semantic.bimOf: an Ossie .yaml is dax-sql's
// ossieToTmsl of it) and nothing else: pure, no I/O.
//   Direct Lake   each table an entity partition of the lakehouse, through one expression that
//                 holds its OneLake URL (Direct Lake on OneLake)
//   DirectQuery   each table an M partition over the lakehouse's SQL endpoint
// The tables are those the export reads (exportapp.js planExport's `tables`: name -> schema.table).
// A table with no source there (a calculated table, a calculation group) keeps its own partitions.
// =============================================================================

const { DFS_ORIGIN } = require('./names');

const MODES = { directLake: 'Direct Lake', directQuery: 'DirectQuery' };
const EXPRESSION = 'DatabaseQuery';
const COMPATIBILITY = 1604;
const lc = s => String(s).toLowerCase();
const m = s => `"${String(s).replace(/"/g, '""')}"`;

/**
 * The model.bim of the semantic model: `bim` as TMSL, `mode` 'directLake' or 'directQuery',
 * `tables` [[table, 'schema.table']], `lake` { workspace, item } (GUIDs), `sqlEndpoint`
 * { host, database } (DirectQuery). Throws, saying why, when the model can't be one.
 */
function semanticTmsl(bim, mode, { name, tables, lake, sqlEndpoint = null }) {
  if (!MODES[mode]) throw new Error(`no storage mode ${mode}`);
  if (mode === 'directLake' && !(lake && lake.workspace && lake.item)) throw new Error('Direct Lake needs the lakehouse by its GUIDs');
  if (mode === 'directQuery' && !(sqlEndpoint && sqlEndpoint.host && sqlEndpoint.database)) throw new Error('DirectQuery needs the lakehouse\'s SQL endpoint');
  const model = JSON.parse(JSON.stringify(bim.model ?? bim));
  const sources = new Map(tables.map(([t, s]) => [lc(t), s]));
  const read = model.tables.filter(t => sources.has(lc(t.name)));
  if (!read.length) throw new Error('the model has no table to read');
  if (mode === 'directLake') {
    const calculated = read.flatMap(t => (t.columns ?? []).filter(c => c.type === 'calculated').map(c => `${t.name}[${c.name}]`));
    if (calculated.length) throw new Error(`Direct Lake has no calculated columns, and the model has ${calculated.join(', ')}: export it as DirectQuery`);
  }
  for (const t of read) {
    const [schema, entity] = sources.get(lc(t.name)).split('.');
    t.partitions = [mode === 'directLake'
      ? { name: t.name, mode: 'directLake', source: { type: 'entity', entityName: entity, schemaName: schema, expressionSource: EXPRESSION } }
      : { name: t.name, mode: 'directQuery', source: { type: 'm', expression: [
          'let',
          `    Source = Sql.Database(${m(sqlEndpoint.host)}, ${m(sqlEndpoint.database)}),`,
          `    Data = Source{[Schema=${m(schema)},Item=${m(entity)}]}[Data]`,
          'in',
          '    Data',
        ] } }];
  }
  // What the file's tables read is now the partitions above: no other expression, no default mode.
  delete model.defaultMode;
  model.expressions = mode === 'directLake' ? [{ name: EXPRESSION, kind: 'm', expression: [
    'let',
    `    Source = AzureStorage.DataLake("${DFS_ORIGIN}/${lc(lake.workspace)}/${lc(lake.item)}", [HierarchicalNavigation=true])`,
    'in',
    '    Source',
  ] }] : [];
  if (!model.expressions.length) delete model.expressions;
  model.culture ??= 'en-US';
  model.defaultPowerBIDataSourceVersion = 'powerBI_V3';
  return { name: String(name), compatibilityLevel: Math.max(COMPATIBILITY, Number(bim.compatibilityLevel) || 0), model };
}

// The item's definition, as the Fabric API takes it: model.bim and definition.pbism, base64.
function definitionOf(tmsl) {
  const part = (path, o) => ({ path, payload: Buffer.from(JSON.stringify(o, null, 2), 'utf8').toString('base64'), payloadType: 'InlineBase64' });
  return { parts: [part('model.bim', tmsl), part('definition.pbism', { version: '4.0', settings: {} })] };
}

module.exports = { semanticTmsl, definitionOf, MODES };
