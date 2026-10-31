'use strict';
// =============================================================================
// sqltables.js — a table's SQL name, found in OneLake, and a Direct Lake model's GUIDs named
// =============================================================================
// Everything here answers from the cache first (onelake.js), and follows its one rule
// (store.js revalidate): a kept answer is trusted until using it fails. A name not in a kept
// listing is looked for in a new listing before it is called missing. A model's item is kept by
// its GUIDs, with no TTL, and is asked about again only when the name it gave stops resolving.
// =============================================================================

const { revalidate } = require('./store');
const { offlineError } = require('./http');
const { sqlKind, sqlName, displayName } = require('./names');

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// How many single-character edits turn one name into the other.
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

// The listed tables nearest a name that isn't there, as schema.table: a typo, not a guess.
function closestTables(name, listing, max = 3) {
  const lc = String(name).toLowerCase();
  const reach = Math.max(2, Math.floor(lc.length / 3));
  return listing
    .map(t => ({ t, d: editDistance(lc, t.table.toLowerCase()) }))
    .filter(x => x.d <= reach)
    .sort((a, b) => a.d - b.d || (a.t.table < b.t.table ? -1 : a.t.table > b.t.table ? 1 : 0))
    .slice(0, max)
    .map(({ t }) => (t.schema ? `${t.schema}.${t.table}` : t.table));
}

/**
 * @param {object} o
 * @param {ReturnType<import('./onelake').createOneLake>} o.onelake
 * @param {() => Promise<{emptyTableSql(fields: object[]): string}>} o.paths  app/paths.js, loaded when needed
 * @param {() => string|null} [o.offlineReason]  why OneLake cannot be asked now
 */
function createSqlTables({ onelake, paths, offlineReason = () => null }) {
  // An item's name in SQL -> the GUIDs that named it, for what nameTables answered: a compiled
  // model query holds that name for as long as the panel does.
  const namedFrom = new Map();
  const nameKey = (kind, workspace, item) => [kind, workspace, item].join('\u0000').toLowerCase();

  // The workspace and the item's directory, as OneLake spells them.
  async function locate(ref, fresh) {
    const lookUp = async o => {
      const workspaces = await onelake.workspaces(o).catch(() => []);
      const ws = workspaces.find(w => same(w, ref.workspace)) || String(ref.workspace);
      if (ref.dir) return { ws, items: null };
      const items = await onelake.items(ws, o).catch(e => {
        throw new Error(`${sqlName(ref)}: workspace ${ref.workspace} could not be listed — ${e.message}`);
      });
      return { ws, items };
    };
    return revalidate(o => lookUp({ fresh: fresh || !!o.fresh }), async ({ ws, items }) => {
      if (ref.dir) return { ws, dir: ref.dir };
      const hit = items.find(i => sqlKind(i.kind) === ref.kind && same(displayName(i.name), ref.item));
      if (!hit) {
        // Offline, the kept listing is all there is, so it cannot say the item does not exist.
        const why = offlineReason();
        throw Object.assign(why ? offlineError(why, `${sqlName(ref)}: ${ref.kind} ${ref.item}`)
          : new Error(`${sqlName(ref)}: there is no ${ref.kind} ${ref.item} in workspace ${ws}`), { notListed: true });
      }
      return { ws, dir: hit.name };
    }, e => e.notListed && !fresh);
  }

  async function resolveAt(ref, fresh) {
    const { ws, dir } = await locate(ref, fresh);
    const lh = { workspace: ws, item: dir };
    const listing = await onelake.tables(lh, { fresh }).catch(() => null);
    const hit = (listing || []).find(x => same(x.schema || 'dbo', ref.schema || 'dbo') && same(x.table, ref.table));
    // Asked past the cache and not listed: gone, and the catalog would be waited on for minutes
    // as if Fabric were still converting it.
    if (fresh && listing && !hit) throw new Error(`${sqlName(ref)}: there is no table ${ref.table} in ${dir}`);
    const t = hit || { schema: ref.schema || 'dbo', table: ref.table };
    let meta;
    try { meta = await onelake.table(lh, t, { fresh }); }
    catch (e) {
      if (!e.noTable) throw new Error(`${sqlName(ref)}: ${e.message}`);
      const near = closestTables(ref.table, listing || []);
      throw new Error(e.message + (near.length ? ` — closest: ${near.join(', ')}` : ''));
    }
    const named = { kind: ref.kind, workspace: ws, item: displayName(dir), schema: t.schema || 'dbo', table: t.table };
    return meta.empty
      ? { ...named, emptySql: (await paths()).emptyTableSql(meta.schemaFields) }
      : { ...named, metadataLocation: meta.metadataLocation };
  }

  // A table's SQL name, found in OneLake. The parts are matched as DuckDB matches names, ignoring
  // case, against what the store lists (the tree's own listings, so a table the tree has shown
  // resolves without a request), and answered spelled as OneLake spells them. `fresh` reads past
  // the cache: the engine's way of asking again once a read has failed.
  async function resolve(ref, { fresh = false } = {}) {
    const from = namedFrom.get(nameKey(ref.kind, ref.workspace, ref.item));
    if (!from) return resolveAt(ref, fresh);
    // Named from GUIDs, so the name may be what moved: a renamed item resolves under its new name,
    // and answers to the name the SQL wrote, which a compiled model query goes on using.
    const asWritten = { workspace: ref.workspace, item: ref.item };
    const r = await revalidate(
      o => onelake.itemNamed(from.wsId, from.itemId, o)
        .then(it => ({ workspace: it.workspace, item: displayName(it.item) }), () => asWritten),
      at => resolveAt({ ...ref, ...at }, fresh),
      e => e.notListed);
    return same(r.workspace, ref.workspace) && same(r.item, ref.item) ? r : { ...r, ...asWritten };
  }

  // A semantic model's Direct Lake tables, which its expressions name by GUID, as SQL names:
  // [{ workspace, item (GUIDs), schema, table }] -> [name]. Every model is named each time the
  // panel opens, and only an item never seen asks Fabric.
  async function nameTables(list) {
    const out = [];
    for (const x of list) {
      const it = await onelake.itemNamed(x.workspace, x.item);
      const kind = sqlKind(it.item.replace(/^.*\./, ''));
      if (!kind) throw new Error(`${it.workspace}/${it.item} holds no tables SQL can name`);
      const item = displayName(it.item);
      namedFrom.set(nameKey(kind, it.workspace, item), { wsId: x.workspace, itemId: x.item });
      out.push(sqlName({ kind, workspace: it.workspace, item, schema: x.schema, table: x.table }));
    }
    return out;
  }

  return { resolve, nameTables, forget: () => namedFrom.clear() };
}

module.exports = { createSqlTables };
