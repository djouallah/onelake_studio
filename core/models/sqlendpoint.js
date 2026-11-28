'use strict';
// =============================================================================
// sqlendpoint.js — a Direct Lake model over a SQL endpoint, read from OneLake
// =============================================================================
// Such a model's tables read an expression Sql.Database("<tenant>-<workspace>.datawarehouse…", "<endpoint id>"):
// dax-sql's directLakeTables reads it (viaSqlEndpoint: the workspace and endpoint by GUIDs), and the tables are in
// the item behind that endpoint, which Fabric says. Nothing here connects to the endpoint. When a definition is read
// from Fabric, those tables read that item's OneLake URL instead, an expression of its own, so the local copy holds
// one kind of model, and naming its tables and offline have nothing more to know. Only that copy changes: nothing is
// written to Fabric.
//
// An endpoint Fabric does not show (deleted, or not this account's to see) is one case more: its
// tables are taken from the model's own workspace if exactly one item there holds them all, and
// the caller says so. Anything less certain is refused, since reading a table of the same name
// from the wrong item would give an answer that looks right.
// =============================================================================

const { mapPool } = require('../onelake/http');
const { DFS_ORIGIN, sqlKind, displayName } = require('../names');

const lc = s => String(s).toLowerCase();

const oneLakeExpression = ({ workspace, item }) => [
  'let',
  `\tdatabase = AzureStorage.DataLake("${DFS_ORIGIN}/${lc(workspace)}/${lc(item)}", [HierarchicalNavigation=true])`,
  'in',
  '\tdatabase',
];

// The items of a workspace holding all these tables, by name, as { workspace, item, name }. null:
// a listing could not be read, so there may be another, and nobody can say it is the only one.
async function itemsHolding(tables, workspace, { fabric, onelake }) {
  const items = (await onelake.items(workspace)).filter(i => sqlKind(i.kind));
  const listed = await mapPool(items, i => onelake.tables({ workspace, item: i.name }).catch(() => null), 4);
  if (listed.includes(null)) return null;
  const holds = list => tables.every(w => list.some(t =>
    lc(t.schema || 'dbo') === lc(w.schema) && lc(t.table) === lc(w.table)));
  const holders = items.filter((_, i) => holds(listed[i]));
  if (!holders.length) return [];
  const wsId = await fabric.workspaceId(workspace);
  const known = await fabric.listItems(workspace);
  const found = holders.map(h => {
    const name = displayName(h.name);
    const hit = known.find(k => k.name === name && sqlKind(k.type) === sqlKind(h.kind));
    return hit ? { workspace: wsId, item: hit.id, name } : null;
  });
  // A holder Fabric doesn't list, as one renamed since the listing, is still another holder.
  return found.includes(null) ? null : found;
}

/**
 * Points a TMSL definition's Direct Lake expressions over a SQL endpoint at OneLake, in place.
 * Returns { notes } for what the caller must say, or { refused, why } when one cannot be: refused
 * finishes "<model> is …", and why says what was looked for.
 * `workspace`: the model's, by name. `fabric`: fabric.js. `onelake`: onelake.js.
 */
async function readFromOneLake(bim, workspace, { fabric, onelake, directLakeTables }) {
  const notes = [];
  // dax-sql's word on which Direct Lake tables read a Fabric SQL endpoint, by endpoint.
  const byEndpoint = new Map();
  for (const [name, l] of directLakeTables(bim)) {
    if (!l.viaSqlEndpoint) continue;
    const key = `${l.workspace}/${l.endpoint}`;
    if (!byEndpoint.has(key)) byEndpoint.set(key, { at: { workspace: l.workspace, endpoint: l.endpoint }, tables: [], names: [] });
    byEndpoint.get(key).tables.push({ schema: l.schema, table: l.entity });
    byEndpoint.get(key).names.push(name);
  }
  for (const { at, tables, names } of byEndpoint.values()) {
    let item = await fabric.itemOfSqlEndpoint(at.workspace, at.endpoint);
    if (!item) {
      // An endpoint in another workspace says where its tables are. Ones of the same name here are other tables.
      const home = await fabric.workspaceId(workspace);
      if (lc(home) !== lc(at.workspace)) {
        return {
          refused: 'Direct Lake over a SQL endpoint that cannot be found',
          why: `endpoint ${at.endpoint} is in workspace ${at.workspace}, which isn't this model's, and it cannot be found there`,
        };
      }
      const holders = await itemsHolding(tables, workspace, { fabric, onelake });
      if (!holders || holders.length !== 1) {
        return {
          refused: 'Direct Lake over a SQL endpoint that cannot be found',
          why: `endpoint ${at.endpoint} in workspace ${at.workspace} cannot be found, and ` + (!holders
            ? `not every item in ${workspace} could be listed, so none can be called the only one holding its tables`
            : holders.length
              ? `${holders.map(h => h.name).join(', ')} in ${workspace} all hold its ${tables.length} table(s)`
              : `no item in ${workspace} holds all its ${tables.length} table(s)`),
        };
      }
      [item] = holders;
      notes.push(`its SQL endpoint cannot be found, so its tables are read from ${item.name} in ${workspace}, the one item there holding them all.`);
    }
    // Those tables read the item through OneLake now: an expression of its own, which their partitions name.
    const model = bim.model;
    const name = `OneLake ${lc(item.workspace)}/${lc(item.item)}`;
    model.expressions = model.expressions || [];
    if (!model.expressions.some(e => e.name === name)) model.expressions.push({ name, kind: 'm', expression: oneLakeExpression(item) });
    for (const t of model.tables || []) {
      if (names.includes(lc(t.name)) && t.partitions && t.partitions[0] && t.partitions[0].source) t.partitions[0].source.expressionSource = name;
    }
  }
  return { notes };
}

module.exports = { readFromOneLake };
