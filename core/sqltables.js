'use strict';
// =============================================================================
// sqltables.js — a table's SQL name, found in OneLake, and a Direct Lake model's GUIDs named
// =============================================================================
// Everything here answers from the cache first (onelake.js), and follows its one rule
// (store.js revalidate): a kept answer is trusted until using it fails. A name not in a kept
// listing is looked for in a new listing before it is called missing. A model's item is kept by
// its GUIDs, with no TTL, and is asked about again only when the name it gave stops resolving.
// =============================================================================

const { revalidate } = require('./onelake/store');
const { offlineError } = require('./onelake/http');
const { sqlKind, sqlName, sqlPart, kindLabel, displayName, abfssUrl, DFS_HOST } = require('./names');
const { tableDirOf } = require('./lake/deltalog');

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
 * @param {ReturnType<import('./onelake/onelake').createOneLake>} o.onelake
 * @param {() => Promise<{emptyTableSql(fields: object[]): string}>} o.paths  page/paths.js, loaded when needed
 * @param {() => string|null} [o.offlineReason]  why OneLake cannot be asked now
 */
// A table not written as Iceberg is read as Delta, from its own folder, which is where its converted
// metadata is kept. A summary from before tables had a format is read again before it comes here.
function deltaTableOf(meta) {
  if (meta.format === 'iceberg') return null;
  // OneLake's catalog gives an abfs:// location, the same place as abfss://, which is what the engine reads by.
  const loc = String(meta.metadataLocation || '').replace(/^abfs:\/\//i, 'abfss://');
  if (/^abfss:/i.test(loc)) return loc.replace(/\/metadata\/[^/]+$/, '');
  const at = tableDirOf(loc);
  return at ? abfssUrl(at.workspace, at.dir) : loc;
}

// OneLake refusing a table's metadata or its files to this user: a table with OneLake security, whose rules
// restrict them. Its rows are read through the table read API instead (tableread.js).
const refused = e => !!e && e.status === 403;

function createSqlTables({ onelake, paths, offlineReason = () => null, tableRead = null }) {
  // An item's name in SQL -> the GUIDs that named it, for what nameTables answered: a compiled
  // model query holds that name for as long as the panel does.
  const namedFrom = new Map();
  const nameKey = (kind, workspace, item) => [kind, workspace, item].join('\u0000').toLowerCase();

  // What the name may have meant, when its item isn't there: an item of that name of another kind.
  function nearItem(ref, ws, items) {
    const named = (kind, item) => (ref.table ? sqlName({ ...ref, workspace: ws, kind, item })
      : [ws, kind === 'lakehouse' ? item : `${item}_${kind}`].map(sqlPart).join('.'));
    const other = items.find(i => sqlKind(i.kind) && sqlKind(i.kind) !== ref.kind && same(displayName(i.name), ref.item));
    if (other) return ` — ${ref.item} is a ${kindLabel(other.kind)}: ${named(sqlKind(other.kind), displayName(other.name))}`;
    return '';
  }

  // The item a name means in a workspace's listing. A lakehouse can be written with _lakehouse after its name,
  // as any other item has its kind: ws.data_lakehouse is lakehouse data, unless there is only a lakehouse named
  // data_lakehouse. With both, the name means two lakehouses, and is refused.
  function itemIn(items, ref, ws) {
    const named = item => items.find(i => sqlKind(i.kind) === ref.kind && same(displayName(i.name), item));
    const hit = named(ref.item);
    const m = ref.kind === 'lakehouse' && /^(.+)_lakehouse$/i.exec(ref.item);
    const base = m ? named(m[1]) : null;
    if (hit && base) {
      throw new Error(`${ref.name || sqlName(ref)}: workspace ${ws} has both a lakehouse ${displayName(base.name)} and a lakehouse ` +
        `${displayName(hit.name)}, so the name means two lakehouses. Write ${sqlPart(ws)}.${sqlPart(displayName(base.name))} for the first, ` +
        'and name the other\'s tables by their GUIDs: "<workspace id>"."<item id>".<schema>.<table>');
    }
    return hit || base;
  }

  // The workspace and the item's directory, as OneLake spells them. `ref.name` says what is being
  // looked for, when it is not a table.
  async function locate(ref, fresh) {
    const asked = () => ref.name || sqlName(ref);
    const lookUp = async o => {
      const workspaces = await onelake.workspaces(o).catch(() => []);
      const ws = workspaces.find(w => same(w, ref.workspace)) || String(ref.workspace);
      if (ref.dir) return { ws, items: null };
      const items = await onelake.items(ws, o).catch(e => {
        throw new Error(`${asked()}: workspace ${ref.workspace} could not be listed — ${e.message}`);
      });
      return { ws, items };
    };
    return revalidate(o => lookUp({ fresh: fresh || !!o.fresh }), async ({ ws, items }) => {
      if (ref.dir) return { ws, dir: ref.dir };
      const hit = itemIn(items, ref, ws);
      if (!hit) {
        // Offline, the kept listing is all there is, so it cannot say the item does not exist.
        const why = offlineReason();
        throw Object.assign(why ? offlineError(why, `${asked()}: ${ref.kind} ${ref.item}`)
          : new Error(`${asked()}: there is no ${ref.kind} ${ref.item} in workspace ${ws}${nearItem(ref, ws, items)}`), { notListed: true });
      }
      return { ws, dir: hit.name };
    }, e => e.notListed && !fresh);
  }

  // A table the lake holds, from what the catalog keeps alone: no request, and nothing refreshed behind it, as
  // finding out that it moved is the sync service's (syncworker.js). `held` asks the engine what its lake table is.
  // Null for anything else, which resolves as it always has. A Refresh over its lakehouse since it was read says
  // { sync }: it reads its metadata again, and the engine syncs it.
  async function heldAt(ref, held) {
    const kept = onelake.cached;
    if (!kept) return null;
    const ws = (((await kept.workspaces()) || {}).value || []).find(w => same(w, ref.workspace));
    if (!ws) return null;
    let dir = ref.dir;
    if (!dir) {
      const hit = (((await kept.items(ws)) || {}).value || []).find(i => sqlKind(i.kind) === ref.kind && same(displayName(i.name), ref.item));
      if (!hit) return null;
      dir = hit.name;
    }
    const lh = { workspace: ws, item: dir };
    const t = (((await kept.tables(lh)) || {}).value || []).find(x => same(x.schema || 'dbo', ref.schema || 'dbo') && same(x.table, ref.table));
    if (!t) return null;
    const where = { workspace: ws, item: dir, schema: t.schema || 'dbo', table: t.table };
    if (tableRead && await tableRead.held(where)) return null;
    const m = await kept.table(lh, t);
    const meta = m && m.value;
    if (!meta || meta.empty || meta.notValid || !meta.format || !meta.metadataLocation) return null;
    const deltaTable = deltaTableOf(meta);
    const lake = await held({ deltaTable, metadataLocation: meta.metadataLocation }).catch(() => null);
    if (!lake || !lake.name) return null;
    if (onelake.refreshedSince && m.at < onelake.refreshedSince(lh)) return { sync: true };
    return {
      kind: ref.kind, workspace: ws, item: displayName(dir), schema: t.schema || 'dbo', table: t.table,
      listed: { workspace: ws, item: dir, schema: t.schema || '', table: t.table },
      // As the lake has it: its snapshot is what a statement reads.
      at: Number.isFinite(lake.at) ? lake.at : m.at, metadataLocation: lake.location || meta.metadataLocation,
      deltaTable, tableUuid: meta.tableUuid || null, lake: lake.name,
    };
  }

  // `secured`: the engine found this table's files refused, so it is read through the table read API.
  async function resolveAt(ref, fresh, { secured = false, signal, held = null } = {}) {
    const inLake = held && !fresh && !secured ? await heldAt(ref, held) : null;
    if (inLake && !inLake.sync) return inLake;
    const { ws, dir } = await locate(ref, fresh);
    const lh = { workspace: ws, item: dir };
    const listing = await onelake.tables(lh, { fresh }).catch(() => null);
    const hit = (listing || []).find(x => same(x.schema || 'dbo', ref.schema || 'dbo') && same(x.table, ref.table));
    // Asked past the cache and not listed: gone, and the catalog would be waited on for minutes
    // as if Fabric were still converting it.
    if (fresh && listing && !hit) throw new Error(`${sqlName(ref)}: there is no table ${ref.table} in ${dir}`);
    const t = hit || { schema: ref.schema || 'dbo', table: ref.table };
    const named = { kind: ref.kind, workspace: ws, item: displayName(dir), schema: t.schema || 'dbo', table: t.table };

    // A table with OneLake security: its rows as the table read API gave them to this user. Not noted as in
    // use, as keeping it current would only be refused.
    const where = { workspace: ws, item: dir, schema: t.schema || 'dbo', table: t.table };
    const since = onelake.refreshedSince ? onelake.refreshedSince(lh) : 0;
    const readSecured = async first => {
      if (!tableRead) throw first || new Error(`${sqlName(ref)}: OneLake refused to give this table's files to you`);
      try {
        const copy = await tableRead.ensure(where, { since, signal });
        const { listed: _, ...plain } = named;
        return { ...plain, at: copy.at, arrowFiles: copy.files, secured: true };
      } catch (e) {
        if (!first || e.offline || (signal && signal.aborted)) throw e;
        if (e.turnedOff) throw Object.assign(new Error(`${first.message}\n${e.message}`), { status: first.status });
        throw Object.assign(new Error(`${first.message}\nIt was then read through OneLake's table read API, for a table with OneLake security, and that failed too: ${e.message}`),
          { status: e.status || first.status });
      }
    };
    // A copy still within its age is the answer, with nothing asked of OneLake. An older one tries the direct
    // read first: a user since given the whole table no longer pays for the API.
    const kept = tableRead ? await tableRead.held(where) : null;
    if (secured || (kept && (offlineReason() || tableRead.current(kept.at, since)))) return readSecured(null);

    let meta;
    try { meta = await onelake.table(lh, t, { fresh }); }
    catch (e) {
      if (e.notValid) throw e;
      if (refused(e)) return readSecured(Object.assign(new Error(`${sqlName(ref)}: ${e.message}`), { status: e.status }));
      if (!e.noTable) throw Object.assign(new Error(`${sqlName(ref)}: ${e.message}`), { status: e.status });
      const near = closestTables(ref.table, listing || []);
      throw new Error(e.message + (near.length ? ` — closest: ${near.join(', ')}` : ''));
    }
    named.at = meta.at;
    named.listed = { workspace: ws, item: dir, schema: t.schema || '', table: t.table };
    // Read as its typed empty SELECT; a Delta one still says where its log is, for a write to go there.
    if (meta.empty) return { ...named, emptySql: (await paths()).emptyTableSql(meta.schemaFields), deltaTable: meta.metadataLocation ? deltaTableOf(meta) : null };
    // Its log is read by the engine, into the lake (engine-host.js lakeTable).
    return { ...named, metadataLocation: meta.metadataLocation, deltaTable: deltaTableOf(meta), tableUuid: meta.tableUuid || null,
             ...(inLake ? { sync: true } : {}) };
  }

  // A table's SQL name, found in OneLake. The parts are matched as DuckDB matches names, ignoring
  // case, against what the store lists (the tree's own listings, so a table the tree has shown
  // resolves without a request), and answered spelled as OneLake spells them. `fresh` reads past
  // the cache: the engine's way of asking again once a read has failed.
  // `held`: the engine's word on what the lake holds (heldAt).
  // A table named by its GUIDs (sql.js tableRefs, byGuid) is first given its names, as a Direct Lake model's are:
  // asked of Fabric once and kept, so it resolves offline after that.
  async function byName(ref) {
    if (!ref.byGuid) return ref;
    const written = `"${ref.workspace}"."${ref.item}".${ref.schema}.${ref.table}`;
    let it;
    try { it = await onelake.itemNamed(ref.workspace, ref.item); }
    catch (e) { throw Object.assign(new Error(`${written}: no item of yours has these GUIDs — ${e.message}`), { offline: e.offline, status: e.status }); }
    const kind = sqlKind(String(it.item).replace(/^.*\./, ''));
    if (!kind) throw new Error(`${written}: ${it.workspace}/${it.item} holds no tables SQL can name`);
    const item = displayName(it.item);
    namedFrom.set(nameKey(kind, it.workspace, item), { wsId: ref.workspace, itemId: ref.item });
    return { kind, workspace: it.workspace, item, schema: ref.schema, table: ref.table };
  }
  // A bare name, ws.lh.schema.table, is a table only in a workspace OneLake has: anything else is DuckDB's
  // own, a struct's field (s.a.b.c) say. A workspace the kept listing doesn't have is looked for again,
  // at most once a minute for each name.
  const missedAt = new Map();
  async function knownWorkspace(name) {
    const kept = await onelake.workspaces().catch(() => null);
    if (!kept) return true;   // no listing to say otherwise: OneLake is asked, and says why
    if (kept.some(w => same(w, name))) return true;
    const key = String(name).toLowerCase();
    if (offlineReason() || Date.now() - (missedAt.get(key) || 0) < 60_000) return false;
    const fresh = await onelake.workspaces({ fresh: true }).catch(() => null);
    if (fresh && fresh.some(w => same(w, name))) return true;
    missedAt.set(key, Date.now());
    return false;
  }
  // Which item a name means. ws.gold_warehouse.dbo.t is warehouse gold, unless the workspace has only a
  // lakehouse named gold_warehouse; with both, the name means two tables, and is refused.
  async function pick(ref) {
    if (ref.bare) return (await knownWorkspace(ref.workspace)) ? ref : null;
    if (ref.asLakehouse == null) return ref;
    const workspaces = await onelake.workspaces().catch(() => []);
    const ws = workspaces.find(w => same(w, ref.workspace)) || String(ref.workspace);
    const items = await onelake.items(ws).catch(() => null);
    if (!items) return ref;
    const has = (kind, item) => items.some(i => sqlKind(i.kind) === kind && same(displayName(i.name), item));
    const asKind = has(ref.kind, ref.item), asLakehouse = has('lakehouse', ref.asLakehouse);
    if (asKind && asLakehouse) {
      throw new Error(`${sqlName(ref)}: workspace ${ws} has both a ${kindLabel(ref.kind)} ${ref.item} and a lakehouse ` +
        `${ref.asLakehouse}, so the name means two tables. Name the table by its GUIDs: "<workspace id>"."<item id>".<schema>.<table>`);
    }
    return asLakehouse ? { ...ref, kind: 'lakehouse', item: ref.asLakehouse, asLakehouse: undefined } : ref;
  }
  // Null for a bare name that isn't OneLake's (pick).
  async function resolve(ref, opts = {}) {
    const which = await pick(await byName(ref));
    return which ? resolveNamed(which, opts) : null;
  }
  async function resolveNamed(ref, { fresh = false, secured = false, signal, held = null } = {}) {
    const from = namedFrom.get(nameKey(ref.kind, ref.workspace, ref.item));
    if (!from) return resolveAt(ref, fresh, { secured, signal, held });
    // Named from GUIDs, so the name may be what moved: a renamed item resolves under its new name,
    // and answers to the name the SQL wrote, which a compiled model query goes on using.
    const asWritten = { workspace: ref.workspace, item: ref.item };
    const r = await revalidate(
      o => onelake.itemNamed(from.wsId, from.itemId, o)
        .then(it => ({ workspace: it.workspace, item: displayName(it.item) }), () => asWritten),
      at => resolveAt({ ...ref, ...at }, fresh, { secured, signal, held }),
      e => e.notListed);
    return same(r.workspace, ref.workspace) && same(r.item, ref.item) ? r : { ...r, ...asWritten };
  }

  // A file's lakehouse, from its SQL name (sql.js fileRefs): the workspace and the item's directory,
  // as OneLake spells them, found the way a table's are. A USE's item too, of its `kind`.
  async function resolveFile(ref, { fresh = false } = {}) {
    const { ws, dir } = await locate({ kind: ref.kind || 'lakehouse', workspace: ref.workspace, item: ref.item, name: ref.written }, fresh);
    return { workspace: ws, item: dir };
  }

  // A semantic model's Direct Lake tables, which its expressions name by GUID, as SQL names:
  // [{ workspace, item (GUIDs), schema, table }] -> [name]. Every model is named each time the
  // panel opens, and only an item never seen asks Fabric.
  // Direct Lake tables as SQL names: { workspace, item } by GUIDs (a model's expression), or
  // { workspaceName, itemName } (a model naming its table item.schema.table), whose kind the
  // workspace's kept listing says; then the schema and the table.
  async function nameTables(list) {
    const out = [];
    for (const x of list) {
      if (x.itemName != null) {
        if (!x.workspaceName) throw new Error(`${x.itemName}.${x.schema}.${x.table}: the model's workspace is not known`);
        const workspaces = await onelake.workspaces().catch(() => []);
        const ws = workspaces.find(w => same(w, x.workspaceName)) || String(x.workspaceName);
        const items = await onelake.items(ws).catch(e => { throw new Error(`workspace ${ws} could not be listed — ${e.message}`); });
        const lh = /^(.+)_lakehouse$/i.exec(x.itemName);
        const hit = items.find(i => sqlKind(i.kind) && same(displayName(i.name), x.itemName))
          || (lh && items.find(i => sqlKind(i.kind) === 'lakehouse' && same(displayName(i.name), lh[1])));
        if (!hit) throw new Error(`there is no lakehouse or warehouse ${x.itemName} in workspace ${ws}`);
        out.push(sqlName({ kind: sqlKind(hit.kind), workspace: ws, item: displayName(hit.name), schema: x.schema, table: x.table }));
        continue;
      }
      const it = await onelake.itemNamed(x.workspace, x.item);
      const kind = sqlKind(it.item.replace(/^.*\./, ''));
      if (!kind) throw new Error(`${it.workspace}/${it.item} holds no tables SQL can name`);
      const item = displayName(it.item);
      namedFrom.set(nameKey(kind, it.workspace, item), { wsId: x.workspace, itemId: x.item });
      out.push(sqlName({ kind, workspace: it.workspace, item, schema: x.schema, table: x.table }));
    }
    return out;
  }

  // Where a table's SQL name is in the tree: its workspace, its item's folder and its schema and name as OneLake
  // spells them, from the kept listings. Nothing of the table is read: it is opened as a click in the tree opens it.
  async function place(asked) {
    const ref = await pick(await byName(asked));
    if (!ref) throw new Error(`${sqlName(asked)}: there is no workspace ${asked.workspace}`);
    const { ws, dir } = await locate(ref, false);
    const listing = await onelake.tables({ workspace: ws, item: dir }).catch(() => null);
    const hit = (listing || []).find(x => same(x.schema || 'dbo', ref.schema || 'dbo') && same(x.table, ref.table));
    if (!hit) throw new Error(`${sqlName(ref)}: there is no table ${ref.table} in ${dir}`);
    return { workspace: ws, item: dir, schema: hit.schema || '', table: hit.table };
  }

  // A lakehouse a write names: its workspace and directory as OneLake spells them, the warehouse its Iceberg
  // catalog answers to (by those names, as catalog.js asks it), and the storage scopes its files are written under.
  // OneLake's catalog puts a table it makes under the workspace's GUID, abfs://<guid>@<host>/<item guid>/Tables/…,
  // which no OneLake listing names but a table's own metadata: so the GUID is read off a table of the workspace, the
  // lakehouse's own first, from what the store keeps. A workspace with no table yet asks the Fabric API, once.
  const wsGuids = new Map();
  const GUID_AT = /^abfss?:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i;
  async function workspaceGuid(ws, dir) {
    const key = String(ws).toLowerCase();
    if (wsGuids.has(key)) return wsGuids.get(key);
    const items = await onelake.items(ws).catch(() => []);
    const order = [dir, ...items.filter(i => sqlKind(i.kind) && i.name !== dir).map(i => i.name)];
    for (const item of order.slice(0, 8)) {
      const lh = { workspace: ws, item };
      const tables = await onelake.tables(lh).catch(() => []);
      for (const t of (tables || []).slice(0, 3)) {
        const meta = await onelake.table(lh, t).catch(() => null);
        const m = GUID_AT.exec(String((meta && meta.metadataLocation) || ''));
        if (m) { wsGuids.set(key, m[1]); return m[1]; }
      }
    }
    const id = onelake.workspaceId ? await onelake.workspaceId(ws).catch(() => null) : null;
    if (id) wsGuids.set(key, String(id));
    return id ? String(id) : null;
  }
  async function lakehouseOf(ref, { fresh = false } = {}) {
    const { ws, dir } = await locate({ kind: 'lakehouse', workspace: ref.workspace, item: ref.item, name: ref.name }, fresh);
    const guid = await workspaceGuid(ws, dir);
    const scopes = [ws, ...(guid ? [guid] : [])].flatMap(w => [`abfss://${w}@${DFS_HOST}/`, `abfs://${w}@${DFS_HOST}/`]);
    return { workspace: ws, item: dir, warehouse: `${ws}/${dir}`, scopes };
  }

  return { resolve, resolveFile, lakehouseOf, nameTables, place, forget: () => namedFrom.clear() };
}

module.exports = { createSqlTables, editDistance, deltaTableOf };
