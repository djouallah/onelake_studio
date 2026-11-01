'use strict';
// =============================================================================
// sqlendpoint.js — a Direct Lake model over a SQL endpoint, read from OneLake
// =============================================================================
// Such a model's expression is Sql.Database("<tenant>-<workspace>.datawarehouse…", "<endpoint id>"),
// and the tables it reads are in the item behind that endpoint. Nothing here connects to the
// endpoint. When a definition is read from Fabric, the expression becomes the OneLake URL of that
// item, so the local copy holds one kind of model, and naming its tables, offline and Export to
// Fabric have nothing more to know. Only that copy changes: nothing is written to Fabric.
//
// An endpoint Fabric does not show (deleted, or not this account's to see) is one case more: its
// tables are taken from the model's own workspace if exactly one item there holds them all, and
// the caller says so. Anything less certain is refused, since reading a table of the same name
// from the wrong item would give an answer that looks right.
// =============================================================================

const { mapPool } = require('./http');
const { DFS_ORIGIN, sqlKind, displayName } = require('./names');

const lc = s => String(s).toLowerCase();
const text = e => (Array.isArray(e) ? e.join('\n') : String(e ?? ''));

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const SQL_DATABASE = /Sql\.Database\s*\(\s*"[a-z2-7]{26}-([a-z2-7]{26})\.[^"]*"\s*,\s*"([0-9a-f]{8}-[0-9a-f-]{27})"/i;

// A label of a Fabric SQL host, which is a GUID's 16 bytes in base32, as the GUID: its first
// three groups are little-endian, as a GUID's bytes are.
function guidOfLabel(label) {
  let bits = 0, held = 0;
  const b = [];
  for (const c of lc(label)) {
    bits = (bits << 5) | BASE32.indexOf(c);
    held += 5;
    if (held >= 8) {
      held -= 8;
      b.push((bits >> held) & 255);
      bits &= (1 << held) - 1;
    }
  }
  const h = b.slice(0, 16).map(x => x.toString(16).padStart(2, '0'));
  return `${h[3]}${h[2]}${h[1]}${h[0]}-${h[5]}${h[4]}-${h[7]}${h[6]}-${h[8]}${h[9]}-${h.slice(10).join('')}`;
}

// The endpoint an expression names, by GUIDs: { workspace, endpoint }. The host's second label is
// the workspace. null: not one, such as a database given by name.
function sqlEndpointOf(expression) {
  const m = SQL_DATABASE.exec(text(expression));
  return m ? { workspace: guidOfLabel(m[1]), endpoint: lc(m[2]) } : null;
}

// The Direct Lake tables reading an expression, as { schema, table }. An Import or DirectQuery
// table can read Sql.Database too, and is not this module's to move.
function tablesReading(bim, name) {
  const fallback = bim?.model?.defaultMode;
  const out = [];
  for (const t of bim?.model?.tables ?? []) {
    for (const p of t.partitions ?? []) {
      const mode = !p.mode || lc(p.mode) === 'default' ? fallback : p.mode;
      if (lc(mode) !== 'directlake' || p.source?.expressionSource !== name) continue;
      out.push({ schema: p.source.schemaName ?? 'dbo', table: p.source.entityName ?? t.name });
    }
  }
  return out;
}

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
  return holders.map(h => {
    const name = displayName(h.name);
    const hit = known.find(k => k.name === name && sqlKind(k.type) === sqlKind(h.kind));
    return hit ? { workspace: wsId, item: hit.id, name } : null;
  }).filter(Boolean);
}

/**
 * Points a TMSL definition's Direct Lake expressions over a SQL endpoint at OneLake, in place.
 * Returns { notes } for what the caller must say, or { refused, why } when one cannot be: refused
 * finishes "<model> is …", and why says what was looked for.
 * `workspace`: the model's, by name. `fabric`: fabric.js. `onelake`: onelake.js.
 */
async function readFromOneLake(bim, workspace, { fabric, onelake }) {
  const notes = [];
  for (const e of bim?.model?.expressions ?? []) {
    const at = sqlEndpointOf(e.expression);
    const tables = at ? tablesReading(bim, e.name) : [];
    if (!tables.length) continue;
    let item = await fabric.itemOfSqlEndpoint(at.workspace, at.endpoint);
    if (!item) {
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
    e.expression = oneLakeExpression(item);
  }
  return { notes };
}

module.exports = { readFromOneLake, sqlEndpointOf, guidOfLabel };
