'use strict';
// =============================================================================
// catalogtables.js — the catalog's tables, in the catalog file
// =============================================================================
// Everything store.js is asked to keep arrives as an entry under a key, and is kept as rows. store.js
// and onelake.js still ask by key and get the same answer, so what changes is what is on disk: tables
// that can be queried, and that nothing evicts. No table holds a key: a key says which row.
//
// `listing_read` says a listing was read and when, so an empty listing is an answer and a missing one
// means never read. A table can have metadata with no listing, or stay when a listing no longer names it:
// lake_table.listed_pos says whether the listing names it.
//
// Whatever a key's value holds beyond the columns goes in `extra`, so nothing is lost. Numbers that can
// pass 2^53 are REAL: node:sqlite refuses to read an integer that large.
// =============================================================================

const { modelSqlName } = require('../names');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS catalog_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), cleared TEXT, imported INTEGER NOT NULL DEFAULT 0,
    views_imported INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until REAL);
  CREATE TABLE IF NOT EXISTS listing_read (
    kind TEXT NOT NULL, workspace TEXT NOT NULL, item TEXT NOT NULL, schema_name TEXT NOT NULL, table_name TEXT NOT NULL,
    dir TEXT NOT NULL, ts INTEGER NOT NULL,
    PRIMARY KEY (kind, workspace, item, schema_name, table_name, dir)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS workspace (name TEXT PRIMARY KEY, pos INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS item (
    workspace TEXT NOT NULL, name TEXT NOT NULL, kind TEXT, pos INTEGER NOT NULL, extra TEXT,
    PRIMARY KEY (workspace, name)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS lake_table (
    workspace TEXT NOT NULL, item TEXT NOT NULL, schema_name TEXT NOT NULL, name TEXT NOT NULL,
    listed_pos INTEGER, extra TEXT,
    meta_ts INTEGER, is_empty INTEGER, total_records REAL, metadata_location TEXT, format TEXT, meta_extra TEXT,
    has_stats INTEGER, codec TEXT, total_bytes REAL, data_files REAL, delete_files REAL, operation TEXT, snapshot_ts REAL,
    snapshot_count REAL, format_version REAL, partition_columns TEXT, vorder INTEGER, delta_version REAL, has_history INTEGER,
    stats_extra TEXT,
    PRIMARY KEY (workspace, item, schema_name, name)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS lake_column (
    workspace TEXT NOT NULL, item TEXT NOT NULL, schema_name TEXT NOT NULL, table_name TEXT NOT NULL,
    pos INTEGER NOT NULL, name TEXT, type TEXT, extra TEXT,
    PRIMARY KEY (workspace, item, schema_name, table_name, pos)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS snapshot (
    workspace TEXT NOT NULL, item TEXT NOT NULL, schema_name TEXT NOT NULL, table_name TEXT NOT NULL,
    pos INTEGER NOT NULL, version TEXT, timestamp REAL, operation TEXT, rows_added REAL, rows_removed REAL,
    files_added REAL, files_removed REAL, bytes_added REAL, total_rows REAL, engine TEXT, columns TEXT, extra TEXT,
    PRIMARY KEY (workspace, item, schema_name, table_name, pos)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS lake_object (
    workspace TEXT NOT NULL, item TEXT NOT NULL, dir TEXT NOT NULL, pos INTEGER NOT NULL,
    name TEXT, path TEXT, is_dir INTEGER, bytes REAL, version TEXT, extra TEXT,
    PRIMARY KEY (workspace, item, dir, pos)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS semantic_model (
    workspace TEXT NOT NULL, pos INTEGER NOT NULL, id TEXT, name TEXT, description TEXT, extra TEXT,
    PRIMARY KEY (workspace, pos)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS app (
    workspace TEXT NOT NULL, pos INTEGER NOT NULL, id TEXT, name TEXT, description TEXT, url TEXT,
    deployed_at TEXT, access TEXT, extra TEXT,
    PRIMARY KEY (workspace, pos)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS delta_commit (
    workspace TEXT NOT NULL, item TEXT NOT NULL, schema_name TEXT NOT NULL, table_name TEXT NOT NULL,
    pos INTEGER NOT NULL, version REAL, last_modified REAL, extra TEXT,
    PRIMARY KEY (workspace, item, schema_name, table_name, pos)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS delta_state (
    workspace TEXT NOT NULL, dir TEXT NOT NULL, at_version TEXT NOT NULL, ts INTEGER NOT NULL,
    version REAL, as_of REAL, source TEXT, id TEXT, created_time REAL, partition_columns TEXT,
    min_reader REAL, min_writer REAL, features TEXT, size_bytes REAL, num_files REAL, deleted_rows REAL, extra TEXT,
    PRIMARY KEY (workspace, dir, at_version)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS delta_property (
    workspace TEXT NOT NULL, dir TEXT NOT NULL, at_version TEXT NOT NULL, name TEXT NOT NULL, value TEXT,
    PRIMARY KEY (workspace, dir, at_version, name)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS item_name (
    workspace_id TEXT NOT NULL, item_id TEXT NOT NULL, ts INTEGER NOT NULL, workspace TEXT, item TEXT, extra TEXT,
    PRIMARY KEY (workspace_id, item_id)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS catalog_prefix (item_key TEXT PRIMARY KEY, ts INTEGER NOT NULL, prefix TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS rows_read (location TEXT PRIMARY KEY, ts INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS first_rows (location TEXT PRIMARY KEY, ts INTEGER NOT NULL, rows_json TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS file_read (
    workspace TEXT NOT NULL, path TEXT NOT NULL, version TEXT NOT NULL, ts INTEGER NOT NULL,
    PRIMARY KEY (workspace, path, version)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS table_use (
    workspace TEXT NOT NULL, item TEXT NOT NULL, schema_name TEXT NOT NULL, table_name TEXT NOT NULL,
    day INTEGER NOT NULL, reads INTEGER NOT NULL,
    PRIMARY KEY (workspace, item, schema_name, table_name, day)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS table_kept (
    workspace TEXT NOT NULL, item TEXT NOT NULL, schema_name TEXT NOT NULL, table_name TEXT NOT NULL,
    location TEXT NOT NULL, ts INTEGER NOT NULL, total REAL NOT NULL, bytes REAL NOT NULL, ms INTEGER NOT NULL,
    error TEXT, retry_at REAL NOT NULL,
    PRIMARY KEY (workspace, item, schema_name, table_name, location)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS model_offline (key TEXT PRIMARY KEY, catalog TEXT NOT NULL, model TEXT NOT NULL, ts INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS semantic_view (name TEXT NOT NULL, schema_name TEXT, path TEXT NOT NULL, created TEXT);
  CREATE TABLE IF NOT EXISTS sync_failure (
    kind TEXT NOT NULL, workspace TEXT NOT NULL, item TEXT NOT NULL, schema_name TEXT NOT NULL, table_name TEXT NOT NULL,
    dir TEXT NOT NULL, ts INTEGER NOT NULL, error TEXT NOT NULL,
    PRIMARY KEY (kind, workspace, item, schema_name, table_name, dir)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS lake_table_listed ON lake_table (workspace, item, listed_pos);
  CREATE INDEX IF NOT EXISTS listing_read_ts ON listing_read (ts);
  CREATE INDEX IF NOT EXISTS lake_table_meta_ts ON lake_table (meta_ts);
`;
// What Clear Cached empties.
const TABLES = ['semantic_view', 'listing_read', 'workspace', 'item', 'lake_table', 'lake_column', 'snapshot', 'lake_object', 'semantic_model', 'app',
  'delta_commit', 'delta_state', 'delta_property', 'item_name', 'catalog_prefix', 'rows_read', 'first_rows', 'file_read', 'sync_failure', 'table_use', 'table_kept', 'model_offline'];

// Each kind of store key (onelake.js keys): the column each part after its kind goes in, where a row
// says which entry it is about.
const KEY_PARTS = {
  workspaces: [], items: ['workspace'], tables: ['workspace', 'item'], files: ['workspace', 'item', 'dir'],
  models: ['workspace'], apps: ['workspace'], table: ['workspace', 'item', 'schema_name', 'table_name'],
  'delta-commits': ['workspace', 'item', 'schema_name', 'table_name'], 'delta-state': ['workspace', 'dir', 'table_name'],
  'item-named': ['workspace', 'item'], irc: ['item'], rows: ['dir'], peek: ['dir'], 'file-read': ['workspace', 'dir', 'table_name'],
};
const WHICH = 'kind = ? AND workspace = ? AND item = ? AND schema_name = ? AND table_name = ? AND dir = ?';
function whichOf(kind, parts) {
  const at = { workspace: '', item: '', schema_name: '', table_name: '', dir: '' };
  KEY_PARTS[kind].forEach((column, i) => { at[column] = parts[i]; });
  return [kind, at.workspace, at.item, at.schema_name, at.table_name, at.dir];
}

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const listOf = v => Array.isArray(v) && v.every(isObject);
// node:sqlite takes neither undefined nor a boolean.
const bind = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const text = v => (v == null ? null : String(v));
const number = v => (typeof v === 'number' ? v : null);
const flag = v => (v == null ? null : v ? 1 : 0);
const json = v => (v == null ? null : JSON.stringify(v));
const parsed = v => (v == null ? null : JSON.parse(v));

// What a value holds beyond the fields a table has columns for.
function restOf(value, fields) {
  const rest = {};
  for (const k of Object.keys(value)) if (!fields.includes(k)) rest[k] = value[k];
  return Object.keys(rest).length ? JSON.stringify(rest) : null;
}
// A row back into a value: its fields, left out when empty, as a listing that never had them was.
function rowOf(row, columns) {
  const out = {};
  for (const [field, column] of Object.entries(columns)) if (row[column] != null) out[field] = row[column];
  return row.extra ? { ...out, ...JSON.parse(row.extra) } : out;
}

/**
 * @param {object} o
 * @param {(sql: string) => object} o.statement  a prepared statement, kept by its text
 */
function createCatalogTables({ statement }) {
  const run = (sql, ...args) => statement(sql).run(...args.map(bind));
  const all = (sql, ...args) => statement(sql).all(...args.map(bind));
  const one = (sql, ...args) => statement(sql).get(...args.map(bind));

  const listed = (kind, parts) => one(`SELECT ts FROM listing_read WHERE ${WHICH}`, ...whichOf(kind, parts))?.ts ?? null;
  const stampListing = (kind, parts, at) => run('INSERT OR REPLACE INTO listing_read VALUES (?, ?, ?, ?, ?, ?, ?)', ...whichOf(kind, parts), at);

  // A listing with its own rows, which a new one replaces outright.
  const listingOf = (kind, { fits, put, rows }) => ({
    fits,
    keptAt: parts => listed(kind, parts),
    has: parts => listed(kind, parts) != null,
    get(parts) {
      const at = listed(kind, parts);
      return at == null ? null : { at, value: rows(parts) };
    },
    put(parts, value, at) {
      put(parts, value);
      stampListing(kind, parts, at);
    },
  });

  const ITEM = { name: 'name', kind: 'kind' };
  const OBJECT = { name: 'name', path: 'path', isDir: 'is_dir', bytes: 'bytes', version: 'version' };
  const MODEL = { id: 'id', name: 'name', description: 'description' };
  const APP = { id: 'id', name: 'name', description: 'description', url: 'url', deployedAt: 'deployed_at', access: 'access' };
  const SNAPSHOT = { version: 'version', timestamp: 'timestamp', operation: 'operation', rowsAdded: 'rows_added',
    rowsRemoved: 'rows_removed', filesAdded: 'files_added', filesRemoved: 'files_removed', bytesAdded: 'bytes_added',
    totalRows: 'total_rows', engine: 'engine', columns: 'columns' };
  const DELTA_STATE = ['version', 'asOf', 'source', 'id', 'createdTime', 'partitionColumns', 'properties',
    'minReaderVersion', 'minWriterVersion', 'features', 'sizeBytes', 'numFiles', 'deletedRows'];
  const TOP = ['empty', 'schemaFields', 'totalRecords', 'stats', 'metadataLocation', 'format'];
  const STATS = ['codec', 'totalFilesSize', 'totalDataFiles', 'totalDeleteFiles', 'operation', 'snapshotTs', 'snapshotCount',
    'formatVersion', 'partitionColumns', 'vorderProp', 'format', 'deltaVersion', 'history'];

  // A lake_table row and its columns as the value it was kept as. `history` reads its snapshots, if it has any.
  const tableValue = (r, columns, history) => ({
    empty: !!r.is_empty,
    schemaFields: columns.map(c => rowOf(c, { name: 'name', type: 'type' })),
    totalRecords: r.total_records,
    stats: !r.has_stats ? null : {
      codec: r.codec,
      totalFilesSize: r.total_bytes,
      totalDataFiles: r.data_files,
      totalDeleteFiles: r.delete_files,
      operation: r.operation,
      snapshotTs: r.snapshot_ts,
      snapshotCount: r.snapshot_count,
      formatVersion: r.format_version,
      partitionColumns: parsed(r.partition_columns),
      vorderProp: r.vorder == null ? null : !!r.vorder,
      format: r.format,
      deltaVersion: r.delta_version,
      history: !r.has_history ? null : history().map(s => {
        const entry = rowOf({ ...s, columns: null }, SNAPSHOT);
        return { ...entry, columns: parsed(s.columns) };
      }),
      ...parsed(r.stats_extra),
    },
    metadataLocation: r.metadata_location ?? undefined,
    ...(r.format != null ? { format: r.format } : {}),
    ...parsed(r.meta_extra),
  });

  const routes = {
    workspaces: listingOf('workspaces', {
      fits: v => Array.isArray(v) && v.every(w => typeof w === 'string'),
      put(p, value) {
        run('DELETE FROM workspace');
        value.forEach((name, pos) => run('INSERT OR REPLACE INTO workspace VALUES (?, ?)', name, pos));
      },
      rows: () => all('SELECT name FROM workspace ORDER BY pos').map(r => r.name),
    }),
    items: listingOf('items', {
      fits: listOf,
      put([ws], value) {
        run('DELETE FROM item WHERE workspace = ?', ws);
        value.forEach((it, pos) => run('INSERT OR REPLACE INTO item VALUES (?, ?, ?, ?, ?)',
          ws, text(it.name) ?? '', text(it.kind), pos, restOf(it, Object.keys(ITEM))));
      },
      rows: ([ws]) => all('SELECT name, kind, extra FROM item WHERE workspace = ? ORDER BY pos', ws).map(r => rowOf(r, ITEM)),
    }),
    tables: listingOf('tables', {
      fits: listOf,
      put([ws, item], value) {
        run('UPDATE lake_table SET listed_pos = NULL WHERE workspace = ? AND item = ?', ws, item);
        value.forEach((t, pos) => run(`INSERT INTO lake_table (workspace, item, schema_name, name, listed_pos, extra)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace, item, schema_name, name) DO UPDATE SET listed_pos = excluded.listed_pos, extra = excluded.extra`,
          ws, item, text(t.schema) ?? '', text(t.table) ?? '', pos, restOf(t, ['schema', 'table'])));
        // Metadata outlives a listing that no longer names its table, as a kept answer always has.
        run('DELETE FROM lake_table WHERE workspace = ? AND item = ? AND listed_pos IS NULL AND meta_ts IS NULL', ws, item);
      },
      rows: ([ws, item]) => all(`SELECT schema_name, name, extra FROM lake_table
        WHERE workspace = ? AND item = ? AND listed_pos IS NOT NULL ORDER BY listed_pos`, ws, item)
        .map(r => ({ schema: r.schema_name, table: r.name, ...parsed(r.extra) })),
    }),
    files: listingOf('files', {
      fits: listOf,
      put([ws, item, dir], value) {
        run('DELETE FROM lake_object WHERE workspace = ? AND item = ? AND dir = ?', ws, item, dir);
        value.forEach((e, pos) => run('INSERT INTO lake_object VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ws, item, dir, pos, text(e.name), text(e.path), flag(e.isDir), number(e.bytes), text(e.version),
          restOf(e, Object.keys(OBJECT))));
      },
      rows: ([ws, item, dir]) => all(`SELECT name, path, is_dir, bytes, version, extra FROM lake_object
        WHERE workspace = ? AND item = ? AND dir = ? ORDER BY pos`, ws, item, dir)
        .map(r => ({ ...rowOf(r, OBJECT), isDir: !!r.is_dir })),
    }),
    models: listingOf('models', {
      fits: listOf,
      put([ws], value) {
        run('DELETE FROM semantic_model WHERE workspace = ?', ws);
        value.forEach((m, pos) => run('INSERT INTO semantic_model VALUES (?, ?, ?, ?, ?, ?)',
          ws, pos, text(m.id), text(m.name), text(m.description), restOf(m, Object.keys(MODEL))));
      },
      rows: ([ws]) => all('SELECT id, name, description, extra FROM semantic_model WHERE workspace = ? ORDER BY pos', ws)
        .map(r => rowOf(r, MODEL)),
    }),
    apps: listingOf('apps', {
      fits: listOf,
      put([ws], value) {
        run('DELETE FROM app WHERE workspace = ?', ws);
        value.forEach((a, pos) => run('INSERT INTO app VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ws, pos, text(a.id), text(a.name), text(a.description), text(a.url), text(a.deployedAt), text(a.access),
          restOf(a, Object.keys(APP))));
      },
      rows: ([ws]) => all('SELECT id, name, description, url, deployed_at, access, extra FROM app WHERE workspace = ? ORDER BY pos', ws)
        .map(r => rowOf(r, APP)),
    }),
    'delta-commits': listingOf('delta-commits', {
      fits: listOf,
      put([ws, item, schema, name], value) {
        run('DELETE FROM delta_commit WHERE workspace = ? AND item = ? AND schema_name = ? AND table_name = ?', ws, item, schema, name);
        value.forEach((c, pos) => run('INSERT INTO delta_commit VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ws, item, schema, name, pos, number(c.version), number(c.lastModified), restOf(c, ['version', 'lastModified'])));
      },
      rows: ([ws, item, schema, name]) => all(`SELECT version, last_modified, extra FROM delta_commit
        WHERE workspace = ? AND item = ? AND schema_name = ? AND table_name = ? ORDER BY pos`, ws, item, schema, name)
        .map(r => ({ version: r.version, lastModified: r.last_modified, ...parsed(r.extra) })),
    }),
    'delta-state': {
      fits: v => isObject(v) && (v.properties == null || isObject(v.properties)),
      has: ([ws, dir, at]) => !!one('SELECT 1 AS found FROM delta_state WHERE workspace = ? AND dir = ? AND at_version = ?', ws, dir, at),
      get([ws, dir, at]) {
        const r = one('SELECT * FROM delta_state WHERE workspace = ? AND dir = ? AND at_version = ?', ws, dir, at);
        if (!r) return null;
        const properties = {};
        for (const p of all('SELECT name, value FROM delta_property WHERE workspace = ? AND dir = ? AND at_version = ?', ws, dir, at)) {
          properties[p.name] = p.value;
        }
        return { at: r.ts, value: {
          version: r.version, asOf: r.as_of, source: r.source, id: r.id, createdTime: r.created_time,
          partitionColumns: parsed(r.partition_columns), properties,
          minReaderVersion: r.min_reader, minWriterVersion: r.min_writer, features: parsed(r.features),
          sizeBytes: r.size_bytes, numFiles: r.num_files, deletedRows: r.deleted_rows, ...parsed(r.extra),
        } };
      },
      put([ws, dir, at], v, ts) {
        run('INSERT OR REPLACE INTO delta_state VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ws, dir, at, ts, number(v.version), number(v.asOf), text(v.source), text(v.id), number(v.createdTime),
          json(v.partitionColumns), number(v.minReaderVersion), number(v.minWriterVersion), json(v.features),
          number(v.sizeBytes), number(v.numFiles), number(v.deletedRows), restOf(v, DELTA_STATE));
        run('DELETE FROM delta_property WHERE workspace = ? AND dir = ? AND at_version = ?', ws, dir, at);
        for (const [name, value] of Object.entries(v.properties || {})) {
          run('INSERT INTO delta_property VALUES (?, ?, ?, ?, ?)', ws, dir, at, name, text(value));
        }
      },
    },
    'item-named': {
      fits: isObject,
      has: ([w, i]) => !!one('SELECT 1 AS found FROM item_name WHERE workspace_id = ? AND item_id = ?', w, i),
      get([w, i]) {
        const r = one('SELECT ts, workspace, item, extra FROM item_name WHERE workspace_id = ? AND item_id = ?', w, i);
        return r ? { at: r.ts, value: rowOf(r, { workspace: 'workspace', item: 'item' }) } : null;
      },
      put([w, i], v, ts) {
        run('INSERT OR REPLACE INTO item_name VALUES (?, ?, ?, ?, ?, ?)', w, i, ts, text(v.workspace), text(v.item), restOf(v, ['workspace', 'item']));
      },
    },
    irc: {
      fits: v => typeof v === 'string',
      has: ([w]) => !!one('SELECT 1 AS found FROM catalog_prefix WHERE item_key = ?', w),
      get([w]) {
        const r = one('SELECT ts, prefix FROM catalog_prefix WHERE item_key = ?', w);
        return r ? { at: r.ts, value: r.prefix } : null;
      },
      put([w], v, ts) { run('INSERT OR REPLACE INTO catalog_prefix VALUES (?, ?, ?)', w, ts, v); },
    },
    rows: {
      fits: v => v === true,
      has: ([location]) => !!one('SELECT 1 AS found FROM rows_read WHERE location = ?', location),
      get([location]) {
        const r = one('SELECT ts FROM rows_read WHERE location = ?', location);
        return r ? { at: r.ts, value: true } : null;
      },
      put([location], v, ts) { run('INSERT OR REPLACE INTO rows_read VALUES (?, ?)', location, ts); },
    },
    // A table's first rows, under its snapshot: as many columns as it has, of any type, so as JSON.
    peek: {
      fits: isObject,
      has: ([location]) => !!one('SELECT 1 AS found FROM first_rows WHERE location = ?', location),
      get([location]) {
        const r = one('SELECT ts, rows_json FROM first_rows WHERE location = ?', location);
        return r ? { at: r.ts, value: JSON.parse(r.rows_json) } : null;
      },
      put([location], v, ts) { run('INSERT OR REPLACE INTO first_rows VALUES (?, ?, ?)', location, ts, JSON.stringify(v)); },
    },
    'file-read': {
      fits: v => v === true,
      has: ([ws, path, version]) => !!one('SELECT 1 AS found FROM file_read WHERE workspace = ? AND path = ? AND version = ?', ws, path, version),
      get([ws, path, version]) {
        const r = one('SELECT ts FROM file_read WHERE workspace = ? AND path = ? AND version = ?', ws, path, version);
        return r ? { at: r.ts, value: true } : null;
      },
      put([ws, path, version], v, ts) { run('INSERT OR REPLACE INTO file_read VALUES (?, ?, ?, ?)', ws, path, version, ts); },
    },
    table: {
      fits: v => isObject(v) && (v.schemaFields == null || listOf(v.schemaFields)) && (v.stats == null || isObject(v.stats)),
      keptAt: ([ws, item, schema, name]) => one(`SELECT meta_ts FROM lake_table
        WHERE workspace = ? AND item = ? AND schema_name = ? AND name = ?`, ws, item, schema, name)?.meta_ts ?? null,
      has: ([ws, item, schema, name]) => !!one(`SELECT 1 AS found FROM lake_table
        WHERE workspace = ? AND item = ? AND schema_name = ? AND name = ? AND meta_ts IS NOT NULL`, ws, item, schema, name),
      get([ws, item, schema, name]) {
        const r = one(`SELECT * FROM lake_table WHERE workspace = ? AND item = ? AND schema_name = ? AND name = ?
          AND meta_ts IS NOT NULL`, ws, item, schema, name);
        if (!r) return null;
        const where = 'WHERE workspace = ? AND item = ? AND schema_name = ? AND table_name = ? ORDER BY pos';
        const columns = all(`SELECT name, type, extra FROM lake_column ${where}`, ws, item, schema, name);
        const history = () => all(`SELECT * FROM snapshot ${where}`, ws, item, schema, name);
        return { at: r.meta_ts, value: tableValue(r, columns, history) };
      },
      put([ws, item, schema, name], v, at) {
        const s = v.stats || {};
        run(`INSERT INTO lake_table (workspace, item, schema_name, name, meta_ts, is_empty, total_records, metadata_location,
            format, meta_extra, has_stats, codec, total_bytes, data_files, delete_files, operation, snapshot_ts, snapshot_count,
            format_version, partition_columns, vorder, delta_version, has_history, stats_extra)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace, item, schema_name, name) DO UPDATE SET
            meta_ts = excluded.meta_ts, is_empty = excluded.is_empty, total_records = excluded.total_records,
            metadata_location = excluded.metadata_location, format = excluded.format, meta_extra = excluded.meta_extra,
            has_stats = excluded.has_stats, codec = excluded.codec, total_bytes = excluded.total_bytes,
            data_files = excluded.data_files, delete_files = excluded.delete_files, operation = excluded.operation,
            snapshot_ts = excluded.snapshot_ts, snapshot_count = excluded.snapshot_count, format_version = excluded.format_version,
            partition_columns = excluded.partition_columns, vorder = excluded.vorder, delta_version = excluded.delta_version,
            has_history = excluded.has_history, stats_extra = excluded.stats_extra`,
          ws, item, schema, name, at, flag(v.empty), number(v.totalRecords), text(v.metadataLocation),
          text(v.format ?? s.format), restOf(v, TOP), flag(!!v.stats), text(s.codec), number(s.totalFilesSize), number(s.totalDataFiles),
          number(s.totalDeleteFiles), text(s.operation), number(s.snapshotTs), number(s.snapshotCount), number(s.formatVersion),
          json(s.partitionColumns), flag(s.vorderProp), number(s.deltaVersion), flag(Array.isArray(s.history)), restOf(s, STATS));
        const where = 'WHERE workspace = ? AND item = ? AND schema_name = ? AND table_name = ?';
        run(`DELETE FROM lake_column ${where}`, ws, item, schema, name);
        (v.schemaFields || []).forEach((f, pos) => run('INSERT INTO lake_column VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ws, item, schema, name, pos, text(f.name), text(f.type), restOf(f, ['name', 'type'])));
        run(`DELETE FROM snapshot ${where}`, ws, item, schema, name);
        (Array.isArray(s.history) ? s.history : []).forEach((h, pos) => run(
          'INSERT INTO snapshot VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ws, item, schema, name, pos, text(h.version), number(h.timestamp), text(h.operation), number(h.rowsAdded),
          number(h.rowsRemoved), number(h.filesAdded), number(h.filesRemoved), number(h.bytesAdded), number(h.totalRows),
          text(h.engine), json(h.columns), restOf(h, Object.keys(SNAPSHOT))));
      },
    },
  };

  // A store key's kind, route and parts, or null for what has no table. The key's separator is a NUL
  // or, from an older version's file, the character that stood in for one.
  function routeOf(key) {
    const [kind, ...parts] = String(key).split(/[\0␟]/);
    if (!Object.hasOwn(KEY_PARTS, kind) || parts.length !== KEY_PARTS[kind].length) return null;
    return { kind, route: routes[kind], parts };
  }

  return {
    read(key) {
      const r = routeOf(key);
      return r ? r.route.get(r.parts) : null;
    },
    /** Written, or false if this value doesn't fit its table or it has none. */
    write(key, value, at) {
      const r = routeOf(key);
      if (!r || !r.route.fits(value)) return false;
      r.route.put(r.parts, value, at);
      return true;
    },
    has(key) {
      const r = routeOf(key);
      return !!r && r.route.has(r.parts);
    },
    /** When this entry was read, or null, with its rows left where they are. */
    keptAt(key) {
      const r = routeOf(key);
      if (!r) return null;
      if (Object.hasOwn(r.route, 'keptAt')) return r.route.keptAt(r.parts);
      const kept = r.route.get(r.parts);
      return kept ? kept.at : null;
    },
    /**
     * Every table's metadata, in one pass: a Map of workspace\0item\0schema\0table to its value, as a key's
     * read gives it, without the snapshots of its history, which nothing that walks them reads.
     */
    allTables() {
      const columns = new Map();
      const keyOf = r => [r.workspace, r.item, r.schema_name, r.table_name ?? r.name].join('\0');
      for (const c of all('SELECT workspace, item, schema_name, table_name, name, type, extra FROM lake_column ORDER BY workspace, item, schema_name, table_name, pos')) {
        const k = keyOf(c);
        if (!columns.has(k)) columns.set(k, []);
        columns.get(k).push(c);
      }
      const out = new Map();
      for (const r of all('SELECT * FROM lake_table WHERE meta_ts IS NOT NULL')) {
        out.set(keyOf(r), tableValue(r, columns.get(keyOf(r)) || [], () => []));
      }
      return out;
    },
    /** That a listing an older version kept the time of was read then. */
    stamp(key, at) {
      const r = routeOf(key);
      if (r) stampListing(r.kind, r.parts, at);
    },
    noteFailure(key, at, error) {
      const r = routeOf(key);
      if (r) run('INSERT OR REPLACE INTO sync_failure VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ...whichOf(r.kind, r.parts), at, error);
    },
    clearFailure(key) {
      const r = routeOf(key);
      if (r) run(`DELETE FROM sync_failure WHERE ${WHICH}`, ...whichOf(r.kind, r.parts));
    },
    failureOf(key) {
      const r = routeOf(key);
      const row = r && one(`SELECT ts, error FROM sync_failure WHERE ${WHICH}`, ...whichOf(r.kind, r.parts));
      return row ? { at: row.ts, error: row.error } : null;
    },
    /** The last snapshot read under a table's metadata folder: { location, at }, or null. */
    latestRead(dir) {
      const r = one(`SELECT location, ts FROM (SELECT location, ts FROM rows_read UNION ALL SELECT location, ts FROM first_rows)
        WHERE location >= ? AND location < ? ORDER BY ts DESC, location DESC LIMIT 1`, dir, `${dir}\uffff`);
      return r ? { location: r.location, at: r.ts } : null;
    },
    /** A statement read these tables' rows on this day. Their names and a count: never its text. */
    noteUse(list, day) {
      for (const t of list) {
        run(`INSERT INTO table_use VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT (workspace, item, schema_name, table_name, day) DO UPDATE SET reads = reads + 1`,
          t.workspace, t.item, t.schema || '', t.table, day);
      }
    },
    /** The tables read at least `minReads` times since `fromDay`, the most read first. */
    tablesInUse(fromDay, minReads, most) {
      return all(`SELECT workspace, item, schema_name, table_name, sum(reads) AS reads FROM table_use WHERE day >= ?
        GROUP BY workspace, item, schema_name, table_name HAVING sum(reads) >= ?
        ORDER BY sum(reads) DESC, max(day) DESC, workspace, item, schema_name, table_name LIMIT ?`, fromDay, minReads, most)
        .map(r => ({ workspace: r.workspace, item: r.item, schema: r.schema_name, table: r.table_name, reads: r.reads }));
    },
    readsOf(t, fromDay) {
      return one(`SELECT coalesce(sum(reads), 0) AS reads FROM table_use
        WHERE workspace = ? AND item = ? AND schema_name = ? AND table_name = ? AND day >= ?`,
        t.workspace, t.item, t.schema || '', t.table, fromDay).reads;
    },
    /** The last attempt to read this table whole at this snapshot, or null. */
    keptAs(t, location) {
      const r = one(`SELECT ts, total, bytes, ms, error, retry_at FROM table_kept
        WHERE workspace = ? AND item = ? AND schema_name = ? AND table_name = ? AND location = ?`,
        t.workspace, t.item, t.schema || '', t.table, location);
      return r ? { at: r.ts, total: r.total, bytes: r.bytes, ms: r.ms, error: r.error, retryAt: r.retry_at } : null;
    },
    /** The last time this table was read whole, at any snapshot: { at, total }, or null. */
    latestKept(t) {
      const r = one(`SELECT ts, total FROM table_kept WHERE workspace = ? AND item = ? AND schema_name = ? AND table_name = ? AND error IS NULL
        ORDER BY ts DESC LIMIT 1`, t.workspace, t.item, t.schema || '', t.table);
      return r ? { at: r.ts, total: r.total } : null;
    },
    noteKept(t, k) {
      run('INSERT OR REPLACE INTO table_kept VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', t.workspace, t.item, t.schema || '', t.table,
        k.location, Math.floor(k.at), k.total, k.bytes, Math.floor(k.ms), k.error ?? null, k.retryAt ?? 0);
    },
    /** The semantic models kept offline (modeldata.js): { catalog (its SQL name), model }. */
    offlineModels() {
      // One kept before models were named ws.model_semanticmodel is renamed: semanticmodel.ws.model.
      const OLD = /^semanticmodel\.("(?:[^"]|"")*"|[^."]+)\.("(?:[^"]|"")*"|[^."]+)$/i;
      for (const r of all('SELECT key, catalog, model, ts FROM model_offline')) {
        const m = OLD.exec(r.catalog);
        if (!m) continue;
        const unq = p => (p[0] === '"' ? p.slice(1, -1).replace(/""/g, '"') : p);
        const now = modelSqlName(unq(m[1]), unq(m[2]));
        run('DELETE FROM model_offline WHERE key = ?', r.key);
        run('INSERT OR REPLACE INTO model_offline VALUES (?, ?, ?, ?)', now.toLowerCase(), now, r.model, r.ts);
      }
      return all('SELECT catalog, model FROM model_offline ORDER BY ts').map(r => ({ catalog: r.catalog, model: r.model }));
    },
    setOffline(catalog, model, on, at) {
      if (on) run('INSERT OR REPLACE INTO model_offline VALUES (?, ?, ?, ?)', String(catalog).toLowerCase(), catalog, model, Math.floor(at));
      else run('DELETE FROM model_offline WHERE key = ?', String(catalog).toLowerCase());
    },
    /** How much came down for tables read whole since `at`. */
    keptSince(at) {
      return one('SELECT coalesce(sum(bytes), 0) AS bytes FROM table_kept WHERE error IS NULL AND ts >= ?', Math.floor(at)).bytes;
    },
    /** Nothing is kept whole any more: the disk cache was emptied under it (filecache.js). */
    dropKept() { run('DELETE FROM table_kept'); },
    pruneUse(fromDay, fromAt) {
      run('DELETE FROM table_use WHERE day < ?', fromDay);
      run('DELETE FROM table_kept WHERE ts < ?', Math.floor(fromAt));
    },
    /** The store's keys of what was written at or after `ts`, the latest time among them, and which keys have it. */
    changedSince(ts) {
      const found = [];
      for (const r of all('SELECT * FROM listing_read WHERE ts >= ?', ts)) {
        found.push({ key: [r.kind, ...KEY_PARTS[r.kind].map(column => r[column])].join('\0'), at: r.ts });
      }
      for (const r of all('SELECT workspace, item, schema_name, name, meta_ts FROM lake_table WHERE meta_ts >= ?', ts)) {
        found.push({ key: ['table', r.workspace, r.item, r.schema_name, r.name].join('\0'), at: r.meta_ts });
      }
      const latest = found.reduce((most, f) => Math.max(most, f.at), ts);
      return { keys: found.map(f => f.key), latest, atLatest: new Set(found.filter(f => f.at === latest).map(f => f.key)) };
    },
    clear() { for (const t of TABLES) run(`DELETE FROM ${t}`); },
    // First rows are the one thing here with a limit, as they are data and offline doesn't rest on them:
    // the disk cache holds them too. Oldest first, down to 80%.
    trimFirstRows(maxBytes) {
      // octet_length needs no reading of the text, which length has to do, on the thread that draws the tree.
      const { total } = one('SELECT coalesce(sum(octet_length(rows_json)), 0) AS total FROM first_rows');
      if (total <= maxBytes) return;
      run(`DELETE FROM first_rows WHERE location IN (
        SELECT location FROM (SELECT location, sum(octet_length(rows_json)) OVER (ORDER BY ts DESC, location) AS kept FROM first_rows)
        WHERE kept > ?)`, Math.floor(maxBytes * 0.8));
    },
    /** How many rows each table holds. */
    counts: () => Object.fromEntries(TABLES.map(t => [t, one(`SELECT count(*) AS n FROM ${t}`).n])),
    anything: () => !!one(`SELECT ${TABLES.map(t => `EXISTS (SELECT 1 FROM ${t})`).join(' OR ')} AS found`).found,
    // The semantic models opened here, oldest first: { name, schema, path, created }. A view is replaced
    // by removing it and adding it again, which also moves it to the end.
    views: () => all('SELECT rowid AS id, name, schema_name, path, created FROM semantic_view ORDER BY rowid')
      .map(r => ({ id: r.id, name: r.name, schema: r.schema_name, path: r.path, created: r.created })),
    removeView: id => run('DELETE FROM semantic_view WHERE rowid = ?', id),
    addView: v => run('INSERT INTO semantic_view VALUES (?, ?, ?, ?)', text(v.name) ?? '', text(v.schema), text(v.path) ?? '', text(v.created)),
  };
}

module.exports = { createCatalogTables, CATALOG_SCHEMA: SCHEMA };
