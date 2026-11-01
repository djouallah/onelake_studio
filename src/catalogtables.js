'use strict';
// =============================================================================
// catalogtables.js — the catalog's tables, in the catalog file
// =============================================================================
// A listing or a table's metadata arrives as a store entry (store.js) and is kept as rows. store.js
// and onelake.js still ask by key and get the same answer, so what changes is what is on disk: tables
// that can be queried, and that no budget evicts.
//
// `listing` says a listing was read and when, so an empty listing is an answer and a missing one means
// never read. A table can have metadata with no listing, or stay when a listing no longer names it:
// lake_table.listed_pos says whether the listing names it.
//
// Whatever a key's value holds beyond the columns goes in `extra`, so nothing is lost. Numbers that can
// pass 2^53 are REAL: node:sqlite refuses to read an integer that large.
// =============================================================================

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS listing (k TEXT PRIMARY KEY, ts INTEGER NOT NULL) WITHOUT ROWID;
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
  CREATE INDEX IF NOT EXISTS lake_table_listed ON lake_table (workspace, item, listed_pos);
`;
const TABLES = ['listing', 'workspace', 'item', 'lake_table', 'lake_column', 'snapshot', 'lake_object', 'semantic_model', 'app'];

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

  const listed = k => { const r = one('SELECT ts FROM listing WHERE k = ?', k); return r ? r.ts : null; };

  // A listing with its own rows, which a new one replaces outright.
  const listingOf = ({ fits, put, rows }) => ({
    fits,
    has: (k, p) => listed(k) != null,
    get(k, p) {
      const at = listed(k);
      return at == null ? null : { at, value: rows(p) };
    },
    put(k, p, value, at) {
      put(p, value);
      run('INSERT OR REPLACE INTO listing VALUES (?, ?)', k, at);
    },
  });

  const ITEM = { name: 'name', kind: 'kind' };
  const OBJECT = { name: 'name', path: 'path', isDir: 'is_dir', bytes: 'bytes', version: 'version' };
  const MODEL = { id: 'id', name: 'name', description: 'description' };
  const APP = { id: 'id', name: 'name', description: 'description', url: 'url', deployedAt: 'deployed_at', access: 'access' };
  const SNAPSHOT = { version: 'version', timestamp: 'timestamp', operation: 'operation', rowsAdded: 'rows_added',
    rowsRemoved: 'rows_removed', filesAdded: 'files_added', filesRemoved: 'files_removed', bytesAdded: 'bytes_added',
    totalRows: 'total_rows', engine: 'engine', columns: 'columns' };
  const TOP = ['empty', 'schemaFields', 'totalRecords', 'stats', 'metadataLocation', 'format'];
  const STATS = ['codec', 'totalFilesSize', 'totalDataFiles', 'totalDeleteFiles', 'operation', 'snapshotTs', 'snapshotCount',
    'formatVersion', 'partitionColumns', 'vorderProp', 'format', 'deltaVersion', 'history'];

  const routes = {
    workspaces: listingOf({
      fits: v => Array.isArray(v) && v.every(w => typeof w === 'string'),
      put(p, value) {
        run('DELETE FROM workspace');
        value.forEach((name, pos) => run('INSERT OR REPLACE INTO workspace VALUES (?, ?)', name, pos));
      },
      rows: () => all('SELECT name FROM workspace ORDER BY pos').map(r => r.name),
    }),
    items: listingOf({
      fits: listOf,
      put([ws], value) {
        run('DELETE FROM item WHERE workspace = ?', ws);
        value.forEach((it, pos) => run('INSERT OR REPLACE INTO item VALUES (?, ?, ?, ?, ?)',
          ws, text(it.name) ?? '', text(it.kind), pos, restOf(it, Object.keys(ITEM))));
      },
      rows: ([ws]) => all('SELECT name, kind, extra FROM item WHERE workspace = ? ORDER BY pos', ws).map(r => rowOf(r, ITEM)),
    }),
    tables: listingOf({
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
    files: listingOf({
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
    models: listingOf({
      fits: listOf,
      put([ws], value) {
        run('DELETE FROM semantic_model WHERE workspace = ?', ws);
        value.forEach((m, pos) => run('INSERT INTO semantic_model VALUES (?, ?, ?, ?, ?, ?)',
          ws, pos, text(m.id), text(m.name), text(m.description), restOf(m, Object.keys(MODEL))));
      },
      rows: ([ws]) => all('SELECT id, name, description, extra FROM semantic_model WHERE workspace = ? ORDER BY pos', ws)
        .map(r => rowOf(r, MODEL)),
    }),
    apps: listingOf({
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
    table: {
      fits: v => isObject(v) && (v.schemaFields == null || listOf(v.schemaFields)) && (v.stats == null || isObject(v.stats)),
      has: (k, [ws, item, schema, name]) => !!one(`SELECT 1 AS found FROM lake_table
        WHERE workspace = ? AND item = ? AND schema_name = ? AND name = ? AND meta_ts IS NOT NULL`, ws, item, schema, name),
      get(k, [ws, item, schema, name]) {
        const r = one(`SELECT * FROM lake_table WHERE workspace = ? AND item = ? AND schema_name = ? AND name = ?
          AND meta_ts IS NOT NULL`, ws, item, schema, name);
        if (!r) return null;
        const where = 'WHERE workspace = ? AND item = ? AND schema_name = ? AND table_name = ? ORDER BY pos';
        const value = {
          empty: !!r.is_empty,
          schemaFields: all(`SELECT name, type, extra FROM lake_column ${where}`, ws, item, schema, name)
            .map(c => rowOf(c, { name: 'name', type: 'type' })),
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
            history: !r.has_history ? null : all(`SELECT * FROM snapshot ${where}`, ws, item, schema, name).map(s => {
              const entry = rowOf({ ...s, columns: null }, SNAPSHOT);
              return { ...entry, columns: parsed(s.columns) };
            }),
            ...parsed(r.stats_extra),
          },
          metadataLocation: r.metadata_location ?? undefined,
          ...(r.format != null ? { format: r.format } : {}),
          ...parsed(r.meta_extra),
        };
        return { at: r.meta_ts, value };
      },
      put(k, [ws, item, schema, name], v, at) {
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

  // A store key's route and its parts, or null for what isn't catalog data. The key's separator is a
  // NUL or, from the state file, the character that stood in for one.
  const SIZES = { workspaces: 0, items: 1, tables: 2, files: 3, models: 1, apps: 1, table: 4 };
  function routeOf(key) {
    const [kind, ...parts] = String(key).split(/[\0␟]/);
    if (!Object.hasOwn(SIZES, kind) || parts.length !== SIZES[kind]) return null;
    return { route: routes[kind], parts };
  }

  return {
    read(k, key) {
      const r = routeOf(key);
      return r ? r.route.get(k, r.parts) : null;
    },
    /** Written, or false if this value doesn't fit its table or isn't catalog data. */
    write(k, key, value, at) {
      const r = routeOf(key);
      if (!r || !r.route.fits(value)) return false;
      r.route.put(k, r.parts, value, at);
      return true;
    },
    has(k, key) {
      const r = routeOf(key);
      return !!r && r.route.has(k, r.parts);
    },
    isCatalogData: key => !!routeOf(key),
    clear() { for (const t of TABLES) run(`DELETE FROM ${t}`); },
    anything: () => !!one('SELECT EXISTS (SELECT 1 FROM listing) OR EXISTS (SELECT 1 FROM lake_table) AS found').found,
  };
}

module.exports = { createCatalogTables, CATALOG_SCHEMA: SCHEMA };
