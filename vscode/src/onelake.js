'use strict';
// =============================================================================
// onelake.js — OneLake, cache first
// =============================================================================
// Everything the extension knows about OneLake comes through here, and everything here
// comes through the store: a listing or a table's metadata that was ever fetched is on
// screen at once, from disk, and refreshed behind the user once it is older than the TTL.
// The tree, the panel and anything else that asks all share one answer per key, one
// request per key in flight, and one 'changed' event when OneLake's answer moves.
//
// A table's first rows are kept too, under the table's metadata-location: a snapshot is
// immutable, so rows read from it can never be stale, and a table opened once opens
// again — even after a restart — without a single request to OneLake.
//
// No `vscode` import: catalog.js does the HTTP, store.js the disk, and the tests drive
// this with fakes of both.
// =============================================================================

const { sqlStr } = require('./sql');
const names = require('./names');

const PEEK_ROWS = 100;
const PREFETCH_WORKERS = 2;

// The parts of an Iceberg metadata document the panel shows, worked out once here so a
// multi-megabyte document with a long snapshot history is not what gets stored or posted.
function summarize(metadata, metadataLocation) {
  const curId = metadata['current-snapshot-id'];
  // Guessing is worse than failing: the last element of the snapshot list is not defined
  // to be the current one.
  if (curId == null) throw new Error('the table metadata has no current-snapshot-id — it is incomplete');
  const snapshots = metadata.snapshots || [];
  const schema = (metadata.schemas || []).find(s => s['schema-id'] === metadata['current-schema-id'])
              || (metadata.schemas || [])[0];
  const snap = snapshots.find(s => String(s['snapshot-id']) === String(curId));
  // Listed by the catalog but never written: snapshot -1, no snapshots, no files. DuckDB
  // opens it as an empty table against the right schema.
  if (!snap || String(curId) === '-1' || !snapshots.length) {
    return { empty: true, schemaFields: names.icebergFields(schema), totalRecords: 0, stats: null,
             metadataLocation };
  }
  return {
    empty: false,
    schemaFields: names.icebergFields(schema),
    totalRecords: Number((snap.summary || {})['total-records']) || null,
    stats: names.snapshotStats(metadata, snap),
    metadataLocation,
  };
}

/**
 * @param {object} o
 * @param {ReturnType<import('./catalog').createCatalog>} o.catalog
 * @param {ReturnType<import('./store').createStore>} o.store
 * @param {() => boolean} [o.prefetchEnabled]
 */
function createOneLake({ catalog, store, prefetchEnabled = () => true, onHit = () => {} }) {
  // The store is the account's: a different sign-in swaps it (useStore) and every listener
  // follows, so nothing above this module has to know an account changed.
  const subs = [];   // { ev, fn, off }
  function listen(ev, fn) {
    const sub = { ev, fn, off: store.on(ev, fn) };
    subs.push(sub);
    return () => { sub.off(); subs.splice(subs.indexOf(sub), 1); };
  }
  function useStore(next) {
    for (const sub of subs) { sub.off(); sub.off = next.on(sub.ev, sub.fn); }
    store = next;
    queue.length = 0;
    catalog.reset();
    usePrefixStore();
  }
  // Each item's Iceberg catalog prefix (catalog.js), kept with the rest of the account's
  // answers. No TTL: it is the item's GUIDs, and a stale one is noticed on use.
  function usePrefixStore() {
    if (catalog.usePrefixStore) catalog.usePrefixStore({
      get: w => store.peek(`irc\u0000${w}`),
      set: (w, prefix) => store.put(`irc\u0000${w}`, prefix),
    });
  }
  usePrefixStore();

  const keys = {
    workspaces: () => 'workspaces',
    items: ws => `items\u0000${ws}`,
    tables: lh => `tables\u0000${lh.workspace}\u0000${lh.item}`,
    files: (lh, dir) => `files\u0000${lh.workspace}\u0000${lh.item}\u0000${dir || ''}`,
    table: (lh, t) => `table\u0000${lh.workspace}\u0000${lh.item}\u0000${t.schema || ''}\u0000${t.table}`,
    peek: loc => `peek\u0000${loc}`,
  };

  // The store's raw key, turned back into what changed — so a listener can refresh the
  // one tree node, or tell the panel the one table, rather than everything.
  function decode(key) {
    const [kind, a, b, c, d] = key.split('\u0000');
    if (kind === 'workspaces') return { kind };
    if (kind === 'items') return { kind, workspace: a };
    if (kind === 'tables') return { kind, workspace: a, item: b };
    if (kind === 'files') return { kind, workspace: a, item: b, dir: c };
    if (kind === 'table') return { kind, workspace: a, item: b, schema: c, table: d };
    return { kind };
  }

  // Read through the store, and tell the read log when the answer came off disk — the
  // other half of what a click cost, beside the requests catalog.js reports.
  async function get(key, fetcher, o) {
    const t0 = Date.now();
    const r = await store.get(key, fetcher, o);
    if (r.cached) { try { onHit({ cache: 'hit', ms: Date.now() - t0, path: key.split('\u0000').join(' ') }); } catch (_) {} }
    return r;
  }
  const value = r => r.value;

  const workspaces = (o = {}) => get(keys.workspaces(), () => catalog.listWorkspaces(), o).then(value);
  const items = (ws, o = {}) => get(keys.items(ws), () => catalog.listItems(ws), o).then(value);
  const tables = (lh, o = {}) => {
    // A forced refresh of the listing must reach the catalog's own per-item memo too.
    if (o.fresh) catalog.reset(lh);
    return get(keys.tables(lh), () => catalog.listTables(lh), o).then(value);
  };
  const files = (lh, dir = '', o = {}) => get(keys.files(lh, dir), () => catalog.listFiles(lh, dir), o).then(value);

  /**
   * A table's metadata, summarised: { empty, schemaFields, totalRecords, stats,
   * metadataLocation }, plus `at` (when OneLake said so) and `cached`.
   */
  async function table(lh, t, { fresh = false, onWait } = {}) {
    const r = await get(keys.table(lh, t), async () => {
      const { metadata, metadataLocation } = await catalog.loadTable(lh, t, { onWait });
      return summarize(metadata, metadataLocation);
    }, { fresh });
    return { ...r.value, at: r.at, cached: r.cached };
  }

  /**
   * The table's first rows, read once per snapshot. `run(sql)` is the engine's query —
   * passed in, because the engine belongs to the window and this module does not.
   */
  async function peek(lh, t, run) {
    const meta = await table(lh, t);
    if (meta.empty) {
      const cols = meta.schemaFields || [];
      return { fields: cols.map(f => ({ name: f.name, type: f.type })), rows: [], numRows: 0, cached: true };
    }
    if (!meta.metadataLocation) throw new Error('the catalog gave this table no metadata location');
    const k = keys.peek(meta.metadataLocation);
    const hit = await store.peek(k);
    if (hit) return { ...hit, cached: true };
    const res = await run(`SELECT * FROM iceberg_scan(${sqlStr(meta.metadataLocation)}) LIMIT ${PEEK_ROWS}`);
    const out = { fields: res.fields, rows: res.rows, numRows: res.numRows };
    await store.put(k, out);
    return { ...out, cached: false };
  }

  // ---------------------------------------------------------------------------
  // Prefetch: when the user opens a Tables node, read every table's metadata behind them,
  // two at a time, skipping what the store already has. The first click in a lakehouse is
  // then usually a disk read. A click on a table that is still queued simply joins (or
  // starts) its own fetch — the store's single-flight makes the two one request.
  // ---------------------------------------------------------------------------
  const queue = [];
  const queued = new Set();
  let workers = 0;

  function prefetch(lh, list) {
    if (!prefetchEnabled()) return;
    for (const t of list) {
      const k = keys.table(lh, t);
      if (queued.has(k)) continue;
      queued.add(k);
      queue.push({ lh, t, k });
    }
    while (workers < PREFETCH_WORKERS && queue.length) { workers++; drain(); }
  }

  async function drain() {
    try {
      for (let job; (job = queue.shift());) {
        try {
          // Already known: nothing to do. The store refreshes stale entries on read, so a
          // prefetch never needs to force one.
          if (await store.peek(job.k) === undefined) await table(job.lh, job.t);
        } catch (_) {
          // A table that will not resolve says why when it is clicked; a prefetch that
          // failed has cost nothing the click would not have paid anyway.
        } finally {
          queued.delete(job.k);
        }
      }
    } finally { workers--; }
  }

  return {
    workspaces, items, tables, files, table, peek, prefetch,
    readBytes: (ws, path, o) => catalog.readBytes(ws, path, o),
    onChanged: fn => listen('changed', key => fn(decode(key))),
    onRefreshFailed: fn => listen('refresh-failed', (key, e) => fn(decode(key), e)),
    useStore,
    clear: () => { catalog.reset(); return store.clear(); },
    size: () => store.size(),
  };
}

module.exports = { createOneLake, summarize };
