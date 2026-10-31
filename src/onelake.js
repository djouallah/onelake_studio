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
// again — even after a restart — without a single request to OneLake. A Files/ object's
// bytes are kept the same way, under the version its cached listing gave (readBytes).
// A workspace's semantic models and apps (Fabric's API, not OneLake) are listings like the others.
//
// No `vscode` import: catalog.js does the HTTP, store.js the disk, and the tests drive
// this with fakes of both.
// =============================================================================

const { sqlStr } = require('./sql');
const { mapPool } = require('./http');
const names = require('./names');
const deltalog = require('./deltalog');
const { revalidate } = require('./store');

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
  // Which format the table is written in: a Delta table's Stats and History come from its own
  // log rather than from the conversion.
  const { format, deltaVersion } = names.sourceFormat(metadata);
  // Listed by the catalog but never written: snapshot -1, no snapshots, no files. DuckDB
  // opens it as an empty table against the right schema.
  if (!snap || String(curId) === '-1' || !snapshots.length) {
    return { empty: true, schemaFields: names.icebergFields(schema), totalRecords: 0, stats: null,
             metadataLocation, format };
  }
  return {
    empty: false,
    schemaFields: names.icebergFields(schema),
    totalRecords: Number((snap.summary || {})['total-records']) || null,
    stats: {
      ...names.snapshotStats(metadata, snap),
      format,
      // The Delta version the Iceberg side was converted from: the Stats tab says how far
      // behind the log it is.
      deltaVersion,
      // An Iceberg table's history is its snapshots. A Delta table's is in its log, read
      // only when asked for (delta()).
      history: format === 'iceberg' ? names.icebergHistory(metadata) : null,
    },
    metadataLocation,
    format,
  };
}

/**
 * @param {object} o
 * @param {ReturnType<import('./catalog').createCatalog>} o.catalog
 * @param {ReturnType<import('./store').createStore>} o.store
 * @param {() => boolean} [o.prefetchEnabled]
 * @param {{ listSemanticModels(ws: string): Promise<object[]>, itemOf(wsId: string, itemId: string): Promise<object> }} [o.fabric]
 */
// Everything a cache holds (`cached`: onelake's own, above), read from it alone: every workspace
// with its items, their tables and each table's metadata (null when it was never read), and its
// semantic models — or null with no workspace listing. `unseen` counts the listings not cached
// yet. The metadata is a file each, and a large cache holds thousands: read a few at a time.
// The one walk over the cache: the engine's catalog (extension.js cachedSqlTables, which the
// Go to reads too) and the command line's find.
async function walkCached(cached) {
  const ws = await cached.workspaces();
  if (!ws) return null;
  const out = { at: ws.at, workspaces: [], unseen: { workspaces: 0, items: 0 } };
  const metaOf = [];
  for (const w of ws.value) {
    const models = await cached.models(w);
    const entry = { name: w, items: [], models: (models && models.value) || [] };
    const items = await cached.items(w);
    if (!items) out.unseen.workspaces++;
    for (const it of (items && items.value) || []) {
      const lh = { workspace: w, item: it.name };
      const listed = await cached.tables(lh);
      if (!listed) out.unseen.items++;
      const tables = listed ? listed.value.map(t => ({ ...t, meta: null })) : null;
      for (const t of tables || []) metaOf.push({ lh, t });
      entry.items.push({ ...it, tables });
    }
    out.workspaces.push(entry);
  }
  const metas = await mapPool(metaOf, ({ lh, t }) => cached.table(lh, { schema: t.schema, table: t.table }), 16);
  metaOf.forEach(({ t }, i) => { t.meta = metas[i] ? metas[i].value : null; });
  return out;
}

function createOneLake({ catalog, store, prefetchEnabled = () => true, onHit = () => {},
                         tableTtlMs = undefined, fabric = null, isOffline = () => false }) {
  // The store is the account's: a different sign-in swaps it (useStore) and every listener
  // follows, so nothing above this module has to know an account changed.
  const subs = [];   // { ev, fn, off }
  function listen(ev, fn) {
    const sub = { ev, fn, off: store.on(ev, fn) };
    subs.push(sub);
    return () => { const i = subs.indexOf(sub); if (i >= 0) { sub.off(); subs.splice(i, 1); } };
  }
  function useStore(next) {
    for (const sub of subs) { sub.off(); sub.off = next.on(sub.ev, sub.fn); }
    store = next;
    // The queued keys go with the queue: left in `queued`, they were never prefetched again.
    queue.length = 0;
    queued.clear();
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
    rows: loc => `rows\u0000${loc}`,
    models: ws => `models\u0000${ws}`,
    apps: ws => `apps\u0000${ws}`,
    itemNamed: (wsId, itemId) => `item-named\u0000${wsId}\u0000${itemId}`.toLowerCase(),
    bytes: (ws, path, version) => `bytes\u0000${ws}\u0000${path}\u0000${version}`,
    deltaCommits: (lh, t) => `delta-commits\u0000${lh.workspace}\u0000${lh.item}\u0000${t.schema || ''}\u0000${t.table}`,
    // Immutable: the table as of one Delta version, under where the table lives.
    deltaState: (at, v) => `delta-state\u0000${at.workspace}\u0000${at.dir}\u0000${v}`,
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
    if (kind === 'models' || kind === 'apps') return { kind, workspace: a };
    return { kind };
  }

  // Read through the store, and tell the read log when the answer came off disk — the
  // other half of what a click cost, beside the requests catalog.js reports.
  // Offline, what is kept is the answer, however old and whoever asks: nothing is refreshed behind
  // the caller, and a miss reaches the fetcher, whose request fails at once (http.js).
  async function get(key, fetcher, o) {
    const t0 = Date.now();
    const r = await store.get(key, fetcher, isOffline() ? { ...o, fresh: false, ttl: Infinity } : o);
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
  const models = (ws, o = {}) => {
    if (!fabric) return Promise.reject(new Error('semantic models are not available here'));
    return get(keys.models(ws), () => fabric.listSemanticModels(ws), o).then(value);
  };
  const apps = (ws, o = {}) => {
    if (!fabric) return Promise.reject(new Error('apps are not available here'));
    return get(keys.apps(ws), () => fabric.listApps(ws), o).then(value);
  };
  // What an item named by GUIDs (a Direct Lake expression's) is called: { workspace, item }.
  // No TTL: nothing refreshes it behind the caller. It is read again (`fresh`) when the name it
  // gave stops resolving (sqltables.js), past Fabric's own memo of the workspaces' names too.
  const itemNamed = (wsId, itemId, o = {}) => {
    if (!fabric) return Promise.reject(new Error('semantic models are not available here'));
    if (o.fresh && fabric.reset && !isOffline()) fabric.reset();
    return get(keys.itemNamed(wsId, itemId), () => fabric.itemOf(wsId, itemId), { ttl: Infinity, ...o }).then(value);
  };

  /**
   * A file's bytes — whole, or the `range` asked for. A Files/ object whose directory
   * listing is cached is kept under the version (etag) that listing gave it, so it is read
   * from OneLake once per version: an unchanged file never again, a rewritten one as soon
   * as its listing has moved, which the listing's own TTL decides. The version comes from
   * the host's listing, never from the page. Anything else is read live.
   */
  async function readBytes(ws, path, { range } = {}) {
    const version = await versionOf(ws, path);
    if (!version) return catalog.readBytes(ws, path, { range });
    const k = keys.bytes(ws, path, version);
    const t0 = Date.now();
    let bytes = await store.getBlob(k);
    if (bytes) {
      try { onHit({ cache: 'hit', ms: Date.now() - t0, path: `${ws}/${path}`, bytes: bytes.length }); } catch (_) {}
    } else {
      // A header sniff of a file not kept yet stays a range read: the whole file is not
      // worth pulling to answer 16 bytes.
      if (range) return catalog.readBytes(ws, path, { range });
      bytes = await catalog.readBytes(ws, path);
      await store.putBlob(k, bytes);
    }
    return range ? sliceRange(bytes, range) : bytes;
  }

  // `item/Files/a/b.png` -> the version of b.png in the cached listing of Files/a.
  async function versionOf(ws, path) {
    const p = names.strip(path);
    const m = /^([^/]+)\/Files\/(?:(.*)\/)?[^/]+$/.exec(p);
    if (!m) return '';
    const listing = await store.peek(keys.files({ workspace: ws, item: m[1] }, m[2] || ''));
    const entry = (Array.isArray(listing) ? listing : []).find(e => !e.isDir && names.strip(e.path) === p);
    return (entry && entry.version) || '';
  }

  /**
   * A table's metadata, summarised: { empty, schemaFields, totalRecords, stats,
   * metadataLocation }, plus `at` (when OneLake said so) and `cached`.
   */
  //
  // A table's metadata is kept far longer than a listing (`tableTtlMs`, a day by default):
  // the catalog's loadTable is the slow call, and a new snapshot can wait for a Refresh.
  // A Refresh over the table's lakehouse (refreshTables) has its next read go to the
  // catalog in the foreground, once.
  async function table(lh, t, { fresh = false, onWait } = {}) {
    const load = f => get(keys.table(lh, t), async () => {
      const { metadata, metadataLocation } = await catalog.loadTable(lh, t, { onWait });
      return summarize(metadata, metadataLocation);
    }, { fresh: f, ...(tableTtlMs != null ? { ttl: tableTtlMs } : {}) });
    let r = await load(fresh);
    // A summary kept before tables had a format is read again once, rather than drawn
    // without one until its TTL runs out.
    if (r.cached && (r.at < refreshedSince(lh) || !('format' in r.value))) r = await load(true);
    // The store says 'changed' only when an answer it had moved; a table read for the first
    // time (a prefetch, a click) is news too — the tree and the engine's catalog both want it.
    if (!r.cached) for (const fn of [...tableReadSubs]) { try { fn({ ...lh, ...t, value: r.value }); } catch (_) {} }
    return { ...r.value, at: r.at, cached: r.cached };
  }
  const tableReadSubs = new Set();
  const onTableRead = fn => { tableReadSubs.add(fn); return () => tableReadSubs.delete(fn); };

  // ---------------------------------------------------------------------------
  // A Delta table's own log (deltalog.js), read sparingly: every file is a request.
  // `run(sql)` is the engine's query, for the one log file that is parquet — a checkpoint.
  // ---------------------------------------------------------------------------
  async function deltaTarget(lh, t) {
    const meta = await table(lh, t);
    if (meta.format !== 'delta') throw new Error(`${t.table} is not written as Delta, so it has no Delta log to read`);
    const at = deltalog.tableDirOf(meta.metadataLocation);
    if (!at) throw new Error('the catalog gave this table no location to find its Delta log at');
    // A log file never changes once written, so its text is kept for good.
    const readText = async path => {
      const k = keys.bytes(at.workspace, path, 'immutable');
      let bytes = await store.getBlob(k);
      if (!bytes) { bytes = await catalog.readBytes(at.workspace, path); await store.putBlob(k, bytes); }
      return new TextDecoder().decode(bytes);
    };
    // The one log file that is rewritten in place: _last_checkpoint.
    const readFresh = async path => new TextDecoder().decode(await catalog.readBytes(at.workspace, path));
    return { meta, at, readText, readFresh };
  }

  function checkpointReader(at, readText, run) {
    return async paths => {
      const out = { metaData: null, protocol: null };
      // A V2 checkpoint may be JSON: actions, one per line, like a commit.
      if (paths.every(p => /\.json$/i.test(p))) {
        for (const p of paths) {
          const c = deltalog.parseCommit(await readText(p));
          out.metaData = out.metaData || c.metaData;
          out.protocol = out.protocol || c.protocol;
        }
        return out;
      }
      if (!run) throw new Error('reading a Delta checkpoint needs the engine');
      // Two columns of one parquet file: DuckDB reads the footer and those column chunks.
      const urls = paths.map(p => sqlStr(names.abfssUrl(at.workspace, p)));
      const res = await run(`SELECT to_json(protocol)::VARCHAR AS protocol, to_json(metaData)::VARCHAR AS metadata ` +
        `FROM read_parquet([${urls.join(', ')}], union_by_name = true) WHERE protocol IS NOT NULL OR metaData IS NOT NULL`);
      for (const r of res.rows || []) {
        if (!out.protocol && r.protocol) out.protocol = JSON.parse(r.protocol);
        if (!out.metaData && r.metadata) out.metaData = JSON.parse(r.metadata);
      }
      return out;
    };
  }

  /**
   * A Delta table as of the version its Iceberg metadata was converted from: protocol,
   * features, properties, partitioning, size. One request the first time (the crc), none
   * after: it is kept per version, and a version never changes.
   */
  async function deltaState(lh, t, { run } = {}) {
    const { meta, at, readText, readFresh } = await deltaTarget(lh, t);
    const version = meta.stats && meta.stats.deltaVersion;
    if (version == null) throw new Error('the Iceberg metadata does not say which Delta version it was converted from');
    const k = keys.deltaState(at, version);
    const kept = await store.peek(k);
    if (kept) return { ...kept, cached: true };
    const s = await deltalog.readDeltaState({ readText, readFresh, readCheckpoint: checkpointReader(at, readText, run) },
      at.dir, version);
    await store.put(k, s);
    return { ...s, cached: false };
  }

  /**
   * A page of the table's commits, newest first: { entries, total, latest, oldest }. Only
   * when the History tab asks. The listing is kept like a table's metadata and read again
   * once it is older than the version the Iceberg side names, or after a Refresh; each
   * commit file is read once, ever.
   */
  async function deltaHistory(lh, t, { skip = 0 } = {}) {
    const { meta, at, readText } = await deltaTarget(lh, t);
    const load = f => get(keys.deltaCommits(lh, t), () => deltalog.listCommits(d => catalog.listDir(at.workspace, d), at.dir),
      { fresh: f, ...(tableTtlMs != null ? { ttl: tableTtlMs } : {}) });
    const listing = async ({ fresh }) => {
      let r = await load(!!fresh);
      const newest = r.value.length ? r.value[0].version : -1;
      const behind = meta.stats && meta.stats.deltaVersion != null && newest < meta.stats.deltaVersion;
      if (r.cached && (behind || r.at < refreshedSince(lh))) r = await load(true);
      return r.value;
    };
    // A kept listing can name commits log retention has deleted since.
    return revalidate(listing, async commits => {
      if (!commits.length) throw Object.assign(new Error('the Delta log has no commits'), { empty: true });
      return {
        entries: await deltalog.readHistoryPage(readText, at.dir, commits, skip),
        total: commits.length,
        latest: commits[0].version,
        oldest: commits[commits.length - 1].version,
      };
    }, e => e.empty || e.status === 404 || /HTTP 404/.test(e.message || ''));
  }

  // When a Refresh last covered a lakehouse: everything, a workspace, or one item.
  const refreshes = new Map();   // `${workspace}\0${item}` ('' for all) -> ms
  function refreshTables({ workspace, item } = {}) {
    refreshes.set(`${workspace || ''}\u0000${(workspace && item) || ''}`, Date.now());
  }
  function refreshedSince(lh) {
    let at = 0;
    for (const [k, ms] of refreshes) {
      const [w, i] = k.split('\u0000');
      if ((!w || w === lh.workspace) && (!i || i === lh.item)) at = Math.max(at, ms);
    }
    return at;
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
    const res = await run(`SELECT * FROM ${names.sqlNameOf(lh, t)} LIMIT ${PEEK_ROWS}`);
    const out = { fields: res.fields, rows: res.rows, numRows: res.numRows };
    await store.put(k, out);
    return { ...out, cached: false };
  }

  // A statement has read this table's rows, at this snapshot: what it read works offline from now on.
  const rowsReadSubs = new Set();
  const onRowsRead = fn => { rowsReadSubs.add(fn); return () => rowsReadSubs.delete(fn); };
  async function rowsRead(location) {
    await store.put(keys.rows(location), true);
    for (const fn of [...rowsReadSubs]) { try { fn(location); } catch (_) {} }
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
    if (!prefetchEnabled() || isOffline()) return;
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
          const kept = await store.peek(job.k);
          if (kept === undefined || (kept && !('format' in kept))) await table(job.lh, job.t);
        } catch (_) {
          // A table that will not resolve says why when it is clicked; a prefetch that
          // failed has cost nothing the click would not have paid anyway.
        } finally {
          queued.delete(job.k);
        }
      }
    } finally { workers--; }
  }

  // What the store already holds, read without asking OneLake or Fabric — and without the
  // refresh a stale entry would otherwise start: { value, at }, or null. The command line's
  // listings and metadata (agent.js) answer from this alone.
  const cached = {
    workspaces: () => store.known(keys.workspaces()),
    items: ws => store.known(keys.items(ws)),
    tables: lh => store.known(keys.tables(lh)),
    files: (lh, dir = '') => store.known(keys.files(lh, dir)),
    models: ws => store.known(keys.models(ws)),
    table: (lh, t) => store.known(keys.table(lh, t)),
    // Whether this table's rows have been read here at its current snapshot. Not whether all of them
    // were: what is kept is the part of each file a statement read. A table nothing was ever written
    // to reads no file. Its first rows kept are rows read, for what was read before this was noted.
    rows: async (lh, t) => {
      const kept = await store.known(keys.table(lh, t));
      const meta = kept && kept.value;
      if (!meta) return false;
      if (meta.empty) return true;
      if (!meta.metadataLocation) return false;
      return await store.peek(keys.rows(meta.metadataLocation)) !== undefined
        || await store.peek(keys.peek(meta.metadataLocation)) !== undefined;
    },
  };

  return {
    workspaces, items, tables, files, table, deltaState, deltaHistory, peek, prefetch, refreshTables,
    models, apps, itemNamed, readBytes, cached, rowsRead, onRowsRead,
    onChanged: fn => listen('changed', key => fn(decode(key))),
    onTableRead,
    onRefreshFailed: fn => listen('refresh-failed', (key, e) => fn(decode(key), e)),
    useStore,
    // The engine's catalog as one entry (catalogsnapshot.js), kept with the account's answers.
    keptCatalog: { read: () => store.peek('catalog snapshot'), write: list => store.put('catalog snapshot', list) },
    clear: () => { catalog.reset(); return store.clear(); },
    size: () => store.size(),
  };
}

// `bytes=a-b` or `bytes=a-` (host.js admits only those), over bytes already in hand.
function sliceRange(bytes, range) {
  const [, a, b] = /^bytes=(\d+)-(\d*)$/.exec(range) || [];
  if (a == null) return bytes;
  return bytes.subarray(Number(a), b === '' ? bytes.length : Number(b) + 1);
}

module.exports = { createOneLake, summarize, walkCached };
