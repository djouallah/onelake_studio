'use strict';
// =============================================================================
// pbimodel.js — the Power BI semantic model Create Semantic Model makes of a model file
// =============================================================================
// Create Semantic Model writes the model as a Fabric semantic model item (fabricmodel.js). This is
// that item's definition, worked out from the model's TMSL (semantic.bimOf: an Ossie .yaml is dax-sql's
// ossieToTmsl of it) and nothing else: pure, no I/O. It is Direct Lake on OneLake: each table an entity
// partition of the lakehouse, through one expression that holds its OneLake URL.
// The tables are those the export reads (exportapp.js planExport's `tables`: name -> schema.table).
// A table with no source there (a calculated table, a calculation group) keeps its own partitions.
// =============================================================================

const { DFS_ORIGIN } = require('../../core/names');

const EXPRESSION = 'DatabaseQuery';
const COMPATIBILITY = 1604;
const lc = s => String(s).toLowerCase();

/**
 * The model.bim of the semantic model: `bim` as TMSL, `tables` [[table, 'schema.table']], `lake`
 * { workspace, item } (GUIDs). Throws, saying why, when the model can't be one.
 */
function semanticTmsl(bim, { name, tables, lake }) {
  if (!(lake && lake.workspace && lake.item)) throw new Error('Direct Lake needs the lakehouse by its GUIDs');
  const model = JSON.parse(JSON.stringify(bim.model ?? bim));
  const sources = new Map(tables.map(([t, s]) => [lc(t), s]));
  const read = model.tables.filter(t => sources.has(lc(t.name)));
  if (!read.length) throw new Error('the model has no table to read');
  const calculated = read.flatMap(t => (t.columns ?? []).filter(c => c.type === 'calculated').map(c => `${t.name}[${c.name}]`));
  if (calculated.length) throw new Error(`Direct Lake has no calculated columns, and the model has ${calculated.join(', ')}`);
  for (const t of read) {
    const [schema, entity] = sources.get(lc(t.name)).split('.');
    t.partitions = [{ name: t.name, mode: 'directLake', source: { type: 'entity', entityName: entity, schemaName: schema, expressionSource: EXPRESSION } }];
  }
  // What the file's tables read is now the partitions above: no other expression, no default mode.
  delete model.defaultMode;
  model.expressions = [{ name: EXPRESSION, kind: 'm', expression: [
    'let',
    `    Source = AzureStorage.DataLake("${DFS_ORIGIN}/${lc(lake.workspace)}/${lc(lake.item)}", [HierarchicalNavigation=true])`,
    'in',
    '    Source',
  ] }];
  model.culture ??= 'en-US';
  model.defaultPowerBIDataSourceVersion = 'powerBI_V3';
  return { name: String(name), compatibilityLevel: Math.max(COMPATIBILITY, Number(bim.compatibilityLevel) || 0), model };
}

// The item's definition, as the Fabric API takes it: model.bim and definition.pbism, base64.
function definitionOf(tmsl) {
  const part = (path, o) => ({ path, payload: Buffer.from(JSON.stringify(o, null, 2), 'utf8').toString('base64'), payloadType: 'InlineBase64' });
  return { parts: [part('model.bim', tmsl), part('definition.pbism', { version: '4.0', settings: {} })] };
}

module.exports = { semanticTmsl, definitionOf };
