'use strict';
// =============================================================================
// onelaketable.js — a OneLake table, Delta or Iceberg, kept in DuckLake from its own metadata
// =============================================================================
// A reader per format turns a table's metadata into one shape: its schema, and its live files with their sizes,
// row counts, partition values and deletes. syncTable then brings a DuckLake table to that state in one snapshot:
// a file no longer live gets an end snapshot, a new one a row. No data file is read. DuckDB reads the log
// (read_text, a checkpoint with read_parquet) or the manifests (iceberg_metadata) through whatever file system the
// path names, so a local folder and abfss:// go the same way.
//
// What DuckLake needs that isn't obvious (docs/CATALOG.md, "A file store on DuckLake"):
// - The lake's own data_path is remote, and each table's path is its folder, absolute: on Windows a local data_path
//   turns every remote path into a local one.
// - A Delta partition column isn't in its files. DuckLake reads it from the col=value folder name when the name
//   mapping marks it, so a local copy keeps the file's relative path.
// - A deletion vector is the same bytes as an Iceberg Puffin delete file, sliced out of the .bin it is packed in.
// - Every file's size is needed: with none, a read stops on an internal error that takes the database with it.
// - CREATE and ALTER reach the metadata only at commit, so a schema change is committed before the files.
//
// No `vscode` import, and no network of its own: what it reads goes through the DuckDB connection it is given.
// =============================================================================

const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync, statSync } = require('node:fs');
const { sqlStr: q, quoteIdent: qi, assertOneLakeUrl } = require('../sql');
const { DFS_ORIGIN } = require('../names');
const { crc32 } = require('../crc32');

// The lake's metadata, by a name a statement can read it by: system_internal.ducklake_snapshot and the rest.
const META = 'system_internal';
// What each lake table was last synced from, so a restart forgets nothing: its folder, the catalog's metadata
// location, the table's own version, and for Delta its log's live files then, which the next sync goes on from.
const SYNCED = `${META}.studio_synced`;
// Commits read at once: over OneLake each is a request of a second or two.
const COMMITS_AT_ONCE = 16;
const rows = async (c, sql) => (await c.runAndReadAll(sql)).getRowObjectsJson();
const one = async (c, sql) => Object.values((await rows(c, sql))[0] || {});

// ---------------------------------------------------------------------------- Delta

const PRIM = { long: 'BIGINT', integer: 'INTEGER', short: 'SMALLINT', byte: 'TINYINT', float: 'FLOAT', double: 'DOUBLE',
  string: 'VARCHAR', binary: 'BLOB', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMPTZ', timestamp_ntz: 'TIMESTAMP' };

// A field as a tree: its name, its name in the files, its DuckDB type, and its children's.
function deltaField(f) {
  const physical = (f.metadata && f.metadata['delta.columnMapping.physicalName']) || f.name;
  return { name: f.name, physical, ...deltaType(f.type) };
}
function deltaType(t) {
  if (typeof t === 'string') {
    const d = /^decimal\((\d+),\s*(\d+)\)$/.exec(t);
    if (d) return { type: `DECIMAL(${d[1]},${d[2]})`, children: [] };
    if (!PRIM[t]) throw new Error(`a Delta column of type ${t} isn't read here`);
    return { type: PRIM[t], children: [] };
  }
  if (t.type === 'struct') {
    const children = t.fields.map(deltaField);
    return { type: `STRUCT(${children.map(c => `${qi(c.name)} ${c.type}`).join(', ')})`, children };
  }
  if (t.type === 'array') {
    const e = { name: 'element', physical: 'element', ...deltaType(t.elementType) };
    return { type: `${e.type}[]`, children: [e] };
  }
  if (t.type === 'map') {
    const k = { name: 'key', physical: 'key', ...deltaType(t.keyType) };
    const v = { name: 'value', physical: 'value', ...deltaType(t.valueType) };
    return { type: `MAP(${k.type}, ${v.type})`, children: [k, v] };
  }
  throw new Error(`a Delta column of type ${JSON.stringify(t)} isn't read here`);
}

// Z85, which Delta names a deletion vector's file with, and writes an inline one in.
const Z85 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
function z85(s) {
  const out = Buffer.alloc((s.length / 5) * 4);
  for (let i = 0; i < s.length; i += 5) {
    let n = 0;
    for (const ch of s.slice(i, i + 5)) n = n * 85 + Z85.indexOf(ch);
    out.writeUInt32BE(n >>> 0, (i / 5) * 4);
  }
  return out;
}
const uuidOf = b => { const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

// Where a deletion vector's .bin is: an absolute path ('p'), or one named by a Z85 UUID under an optional
// prefix folder ('u'). An inline one ('i') has none.
function dvFileOf(root, dv) {
  // The log's own word for where it is, read with the OneLake token: only on OneLake.
  if (dv.storageType === 'p') return assertOneLakeUrl(dv.pathOrInlineDv).replace(/^file:\/\/\//, '');
  if (dv.storageType === 'u') {
    const p = dv.pathOrInlineDv, prefix = p.slice(0, -20);
    return `${root}/${prefix ? `${prefix}/` : ''}deletion_vector_${uuidOf(z85(p.slice(-20)))}.bin`;
  }
  throw new Error(`a deletion vector stored as '${dv.storageType}' isn't read here`);
}

// A deletion vector as the blob DuckLake reads: its length, the magic and bitmap, a CRC. Sliced out of its .bin,
// where it is exactly that at its offset, or built around an inline one. `bins` keeps each .bin read: one holds
// many files' vectors, and over OneLake each read of it is a request.
async function deletionBlob(c, root, dv, bins = new Map()) {
  if (dv.storageType === 'i') {
    const data = z85(dv.pathOrInlineDv).subarray(0, dv.sizeInBytes);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data));
    return Buffer.concat([len, data, crc]);
  }
  // As hex: a BLOB through the JSON row reader comes back as escaped text, not its bytes.
  const file = dvFileOf(root, dv);
  if (!bins.has(file)) bins.set(file, one(c, `SELECT hex(content) FROM read_blob(${q(file)})`).then(([hex]) => Buffer.from(hex, 'hex')));
  const b = await bins.get(file), at = dv.offset == null ? 1 : Number(dv.offset), size = b.readUInt32BE(at);
  if (size !== Number(dv.sizeInBytes)) throw new Error(`a deletion vector's size is ${size} in its file and ${dv.sizeInBytes} in the log`);
  return b.subarray(at, at + 4 + size + 4);
}

// A checkpoint writes a map as a list of key/value pairs.
const asObject = m => (Array.isArray(m) ? Object.fromEntries(m.map(x => [x.key, x.value])) : m || {});

// A deletion vector's descriptor, the same however the log wrote it: a checkpoint has every field, a commit some.
const dvOf = dv => (dv ? { storageType: dv.storageType, pathOrInlineDv: dv.pathOrInlineDv, offset: dv.offset == null ? null : Number(dv.offset),
  sizeInBytes: Number(dv.sizeInBytes), cardinality: Number(dv.cardinality) } : null);
// An add as it is kept between reads: what its file needs. Its column stats ride along for the sync that reads
// them and no further (not enumerable, so never in what is kept): the lake has them once the file is in it.
const addOf = a => {
  const s = a.stats ? JSON.parse(a.stats) : null;
  const add = { path: a.path, size: Number(a.size), partitionValues: a.partitionValues || {}, deletionVector: dvOf(a.deletionVector),
    records: s ? (s.numRecords ?? null) : (a.records ?? null) };
  if (s && s.minValues && s.maxValues) Object.defineProperty(add, 'stats', { value: { min: s.minValues, max: s.maxValues, nulls: s.nullCount || {} } });
  return add;
};

// A column's lowest or highest value in a file, as DuckLake keeps one (text), or null where the log's word can't
// be taken as a bound: a wrong one would skip a file that holds the rows asked for. Whole numbers and dates are
// exact. A timestamp is cut to milliseconds in the log, which leaves the lowest a bound and the highest short of
// one, so the highest is taken a millisecond later (`upper`). Not kept: a long past 2^53, which has lost digits
// as JSON, a string, cut at a length the table sets, and decimals and floats. A column without one is read as before.
const STAT_TYPES = new Set(['BIGINT', 'INTEGER', 'SMALLINT', 'TINYINT', 'DATE', 'TIMESTAMPTZ', 'TIMESTAMP']);
// 2024-01-02T03:04:05.123Z, as the log writes one.
const STAT_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]00:?00)?$/;
function statText(type, v, upper = false) {
  if (type === 'DATE') return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  if (type === 'TIMESTAMPTZ' || type === 'TIMESTAMP') {
    const m = typeof v === 'string' ? STAT_TIME.exec(v) : null;
    // A column with a zone must say UTC. One without is the same clock time however it is written: Spark gives
    // it no zone, and delta-rs ends it with a Z.
    if (!m || (type === 'TIMESTAMPTZ' && !m[8])) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], Math.floor(Number(`0.${m[7] || 0}`) * 1000)) + (upper ? 1 : 0);
    // Years 1 to 9999 only, where the text below is what it looks like.
    if (!Number.isFinite(ms) || +m[1] < 1 || new Date(ms).getUTCFullYear() > 9999) return null;
    const text = new Date(ms).toISOString();   // 2024-01-02T03:04:05.124Z
    return `${text.slice(0, 10)} ${text.slice(11, 23)}${type === 'TIMESTAMPTZ' ? '+00' : ''}`;
  }
  return Number.isSafeInteger(v) ? String(v) : null;
}

// The commits' text, in their order: COMMITS_AT_ONCE at a time, each on a connection of its own, or in one read on `c`.
async function commitTexts(c, files, withConn) {
  if (!withConn || files.length < 2) {
    if (!files.length) return [];
    const texts = new Map((await rows(c, `SELECT filename, content FROM read_text([${files.map(q).join(', ')}])`))
      .map(t => [t.filename.replace(/\\/g, '/'), t.content]));
    return files.map(f => texts.get(f));
  }
  const out = new Array(files.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(COMMITS_AT_ONCE, files.length) }, () => withConn(async lc => {
    for (let i = next++; i < files.length; i = next++) out[i] = (await rows(lc, `SELECT content FROM read_text(${q(files[i])})`))[0].content;
  })));
  return out;
}

/**
 * A Delta table at its latest version, or at `version`, from its log alone. `root` is its folder, local or abfss://.
 * `from` and `base`: an earlier answer's `version` and `log`. Only the commits after `from` are read then, unless a
 * checkpoint is newer or the log doesn't go on from there: then it is read whole. `withConn(fn)` runs fn on a
 * connection of its own, so the commits are read at the same time.
 */
async function readDelta(c, root, { version: upTo = Infinity, from = null, base = null, withConn = null } = {}) {
  const listed = (await rows(c, `SELECT file FROM glob(${q(`${root}/_delta_log/*`)})`)).map(r => r.file.replace(/\\/g, '/'));
  const commits = new Map(), checkpoints = new Map();
  for (const f of listed) {
    const m = /^(\d{20})\.(json|checkpoint(?:\.\d{10}\.\d{10})?\.parquet)$/.exec(f.split('/').pop());
    if (!m) continue;
    const v = Number(m[1]);
    if (v > upTo) continue;
    if (m[2] === 'json') commits.set(v, f);
    else { if (!checkpoints.has(v)) checkpoints.set(v, []); checkpoints.get(v).push(f); }
  }
  if (!commits.size && !checkpoints.size) throw new Error(`${root} has no Delta log`);
  const version = Math.max(...commits.keys(), ...checkpoints.keys());
  // The newest checkpoint with all its parts.
  const whole = v => {
    const parts = checkpoints.get(v), m = /\.checkpoint\.\d{10}\.(\d{10})\.parquet$/.exec(parts[0]);
    return !m || parts.length === Number(m[1]);
  };
  const cpv = [...checkpoints.keys()].filter(whole).sort((a, b) => b - a)[0];
  const after = v => [...commits.keys()].filter(x => v === undefined || x > v).sort((a, b) => a - b);
  // The log goes on from `from`: every commit after it is there, and no checkpoint is newer. One that is lower now
  // started again: another table at the same path.
  const goesOn = !!base && Number.isInteger(from) && from <= version && (cpv === undefined || cpv <= from)
    && after(from).every((v, i) => v === from + 1 + i);
  // A file is its path and its deletion vector's id together, as Delta reconciles them: a remove that names no
  // deletion vector doesn't remove the add that has one.
  const idOf = x => {
    const dv = x.deletionVector;
    return dv ? `${x.path}\0${dv.storageType}${dv.pathOrInlineDv}${dv.offset == null ? '' : `@${dv.offset}`}` : x.path;
  };
  const live = new Map(), bins = new Map();
  let meta = null;
  const apply = a => {
    if (a.metaData) meta = a.metaData;
    if (a.remove) live.delete(idOf(a.remove));
    if (a.add) live.set(idOf(a.add), addOf(a.add));
  };
  if (goesOn) {
    meta = base.metaData;
    for (const a of base.adds) live.set(idOf(a), a);
  } else if (cpv !== undefined) {
    const parts = checkpoints.get(cpv).map(q).join(', ');
    for (const r of await rows(c, `SELECT to_json(add) AS a, to_json(metaData) AS m FROM read_parquet([${parts}], union_by_name = true) WHERE add IS NOT NULL OR metaData IS NOT NULL`)) {
      if (r.m && r.m !== 'null') { const m = JSON.parse(r.m); m.configuration = asObject(m.configuration); apply({ metaData: m }); }
      if (r.a && r.a !== 'null') { const a = JSON.parse(r.a); a.partitionValues = asObject(a.partitionValues); apply({ add: a }); }
    }
  }
  const newer = after(goesOn ? from : cpv).map(v => commits.get(v));
  for (const text of await commitTexts(c, newer, withConn)) for (const line of text.split('\n')) if (line.trim()) apply(JSON.parse(line));
  if (!meta) throw new Error(`${root}'s log has no metadata`);
  const partitionColumns = meta.partitionColumns || [];
  const files = [...live.values()].map(a => ({
    key: a.path,
    // The log's paths are URIs; the files' own names aren't.
    path: assertOneLakeUrl(decodeURIComponent(a.path)),
    size: a.size,
    records: a.records == null ? null : Number(a.records),
    partitionValues: partitionColumns.map(k => (a.partitionValues[k] != null ? String(a.partitionValues[k]) : null)),
    deletes: a.deletionVector ? { count: a.deletionVector.cardinality, dv: a.deletionVector } : null,
    stats: a.stats || null,
  }));
  return {
    format: 'delta', version, root, commitsRead: newer.length, whole: !goesOn,
    fields: JSON.parse(meta.schemaString).fields.map(deltaField), partitionColumns, files,
    columnMapping: (meta.configuration && meta.configuration['delta.columnMapping.mode']) || 'none',
    // What the next read goes on from.
    log: { metaData: meta, adds: [...live.values()] },
    readDeletes: f => deletionBlob(c, root, f.deletes.dv, bins),
  };
}

// ---------------------------------------------------------------------------- Iceberg

/** An Iceberg table at the snapshot its metadata file names. Its own position-delete files serve as they are. */
async function readIceberg(c, metadataLocation, { allow = async () => {} } = {}) {
  const schema = await rows(c, `DESCRIBE SELECT * FROM iceberg_scan(${q(metadataLocation)})`);
  // The table's folder and its manifest lists, where its metadata file says they are, said to the engine before
  // iceberg_metadata reads them. Fabric writes them by the workspace's GUID, a OneLake place other than the name
  // the metadata file was found by, and the storage secret goes only where it was told (sql.js): unsaid, they
  // were asked for with no token, and OneLake answered Unauthorized.
  const [{ content }] = await rows(c, `SELECT content FROM read_text(${q(metadataLocation)})`);
  const meta = JSON.parse(content);
  await allow([meta.location, ...(meta.snapshots || []).map(s => s['manifest-list'])].filter(Boolean).map(String));
  const listed = await rows(c, `SELECT content, file_path, record_count FROM iceberg_metadata(${q(metadataLocation)}) WHERE status <> 'DELETED'`);
  // What the manifests name is read with the OneLake token, here and by every statement after: only on OneLake.
  for (const m of listed) assertOneLakeUrl(m.file_path);
  // And said to the engine before they are read: the storage secret goes only where it was told (sql.js).
  await allow(listed.map(m => m.file_path));
  const sizes = listed.length
    ? new Map((await rows(c, `SELECT filename, size FROM read_blob([${listed.map(m => q(m.file_path)).join(', ')}])`)).map(r => [r.filename, Number(r.size)]))
    : new Map();
  const data = listed.filter(m => m.content === 'DATA'), dels = listed.filter(m => m.content === 'POSITION_DELETES');
  const deletes = new Map();
  if (dels.length) {
    for (const r of await rows(c, `SELECT filename AS del, file_path AS data, count(*)::BIGINT AS n FROM read_parquet([${dels.map(d => q(d.file_path)).join(', ')}], filename = true) GROUP BY ALL`)) {
      if (!deletes.has(r.data)) deletes.set(r.data, []);
      deletes.get(r.data).push({ path: r.del, count: Number(r.n), size: sizes.get(r.del) });
    }
  }
  // What the snapshot says it holds: its data files' rows less the positions its delete files name. Null when its
  // summary doesn't say, or it has equality deletes, which this reader doesn't apply.
  const current = (meta.snapshots || []).find(s => String(s['snapshot-id']) === String(meta['current-snapshot-id']));
  const summary = (current && current.summary) || {};
  const total = Number(summary['total-records']), posDeletes = Number(summary['total-position-deletes'] || 0);
  const liveRows = Number.isFinite(total) && !Number(summary['total-equality-deletes'] || 0) ? total - posDeletes : null;
  return {
    format: 'iceberg', version: metadataLocation, root: null, partitionColumns: [], columnMapping: 'none', liveRows,
    fields: schema.map(s => ({ name: s.column_name, physical: s.column_name, type: s.column_type, children: [] })),
    files: data.map(d => ({ key: d.file_path, path: d.file_path, size: sizes.get(d.file_path), records: Number(d.record_count),
      partitionValues: [], deletes: deletes.has(d.file_path) ? { parquet: deletes.get(d.file_path) } : null })),
  };
}

// ---------------------------------------------------------------------------- DuckLake

/**
 * The DuckLake table `name` in catalog `lake`, brought to `state` in one snapshot.
 * @param {object} c          a DuckDB connection with the lake attached as `lake`
 * @param {string} name
 * @param {object} state      readDelta's or readIceberg's answer
 * @param {object} o
 * @param {string} o.dvDir    where a deletion vector's own file is written: a local folder the engine may read
 * @param {Map<string,string>} [o.held]  a file's path as DuckLake held it (relative to the table, or a full URL)
 *   -> its local copy, so a file already here goes on being read from here (tableservice.js)
 * @param {object} [o.synced]  where `state` came from, noted in studio_synced in the same transaction:
 *   { folder, location, listed, uuid }
 */
async function syncTable(c, name, state, { dvDir, held = new Map(), synced = null }) {
  const started = Date.now();
  const tableId = async () => (await one(c, `SELECT table_id FROM ${META}.ducklake_table WHERE table_name = ${q(name)} AND end_snapshot IS NULL`))[0];
  let tid = await tableId();
  if (tid === undefined) {
    await c.run(`CREATE TABLE lake.${qi(name)} (${state.fields.map(f => `${qi(f.name)} ${f.type}`).join(', ')})`);
    tid = await tableId();
    if (state.partitionColumns.length) await c.run(`ALTER TABLE lake.${qi(name)} SET PARTITIONED BY (${state.partitionColumns.map(qi).join(', ')})`);
    if (state.root) await c.run(`UPDATE ${META}.ducklake_table SET path = ${q(`${state.root}/`)}, path_is_relative = false WHERE table_id = ${tid}`);
  } else {
    // A column is known by its name in the files: under column mapping a rename changes only the other one.
    const have = await rows(c, `SELECT c.column_name AS name, m.source_name AS physical FROM ${META}.ducklake_column c
      LEFT JOIN ${META}.ducklake_name_mapping m ON m.target_field_id = c.column_id AND m.parent_column IS NULL
        AND m.mapping_id = (SELECT max(mapping_id) FROM ${META}.ducklake_column_mapping WHERE table_id = ${tid})
      WHERE c.table_id = ${tid} AND c.end_snapshot IS NULL AND c.parent_column IS NULL`);
    const byPhysical = new Map(have.map(h => [h.physical || h.name, h.name]));
    const kept = new Set();
    for (const f of state.fields) {
      const was = byPhysical.get(f.physical);
      if (was !== undefined && was !== f.name) await c.run(`ALTER TABLE lake.${qi(name)} RENAME COLUMN ${qi(was)} TO ${qi(f.name)}`);
      else if (was === undefined && !have.some(h => h.name === f.name)) await c.run(`ALTER TABLE lake.${qi(name)} ADD COLUMN ${qi(f.name)} ${f.type}`);
      kept.add(f.name);
    }
    for (const h of have) if (!kept.has(h.name) && ![...byPhysical].some(([p, n]) => n === h.name && state.fields.some(f => f.physical === p)))
      await c.run(`ALTER TABLE lake.${qi(name)} DROP COLUMN ${qi(h.name)}`);
  }
  const cols = await rows(c, `SELECT column_id, column_name, parent_column FROM ${META}.ducklake_column WHERE table_id = ${tid} AND end_snapshot IS NULL ORDER BY column_order`);
  const [pid] = await one(c, `SELECT partition_id FROM ${META}.ducklake_partition_info WHERE table_id = ${tid} AND end_snapshot IS NULL`);

  // A file stays when it is still live with the same deletes. A deletion vector's file is named by its
  // descriptor, so what it would be is known without reading it.
  const dvFile = f => `${dvDir}/${createHash('sha256').update(JSON.stringify(f.deletes.dv)).digest('hex').slice(0, 32)}.puffin`;
  // An Iceberg data file with several position-delete files (an UPDATE, then a DELETE: each writes one): DuckLake
  // takes one delete file a data file, and given two it read the file once for each. So they are one file here,
  // named by the data file and theirs: every position any of them deletes, as Iceberg means them.
  const manyDeletes = f => !!(f.deletes && f.deletes.parquet && f.deletes.parquet.length > 1);
  const mergedFile = f => `${dvDir}/${createHash('sha256').update(JSON.stringify([f.path, f.deletes.parquet.map(d => d.path).sort()])).digest('hex').slice(0, 32)}.parquet`;
  const wantDeletes = f => (f.deletes && f.deletes.dv ? dvFile(f) : manyDeletes(f) ? mergedFile(f)
    : f.deletes && f.deletes.parquet ? f.deletes.parquet.map(d => d.path).sort().join('|') : '');
  const pathOfLocal = new Map([...held].map(([path, local]) => [local, path]));
  const live = await rows(c, `SELECT data_file_id, path, path_is_relative FROM ${META}.ducklake_data_file WHERE table_id = ${tid} AND end_snapshot IS NULL`);
  const deletesOf = new Map((await rows(c, `SELECT data_file_id, string_agg(path, '|' ORDER BY path) AS p FROM ${META}.ducklake_delete_file WHERE table_id = ${tid} AND end_snapshot IS NULL GROUP BY 1`)).map(r => [r.data_file_id, r.p]));
  const want = new Map(state.files.map(f => [f.path, f]));
  const kept = new Set(), ended = [];
  for (const r of live) {
    const f = want.get(r.path_is_relative ? r.path : (pathOfLocal.get(r.path) || r.path));
    if (f && !kept.has(f.key) && (deletesOf.get(r.data_file_id) || '') === wantDeletes(f)) kept.add(f.key);
    else ended.push(r.data_file_id);
  }
  const added = state.files.filter(f => !kept.has(f.key));
  if (!added.length && !ended.length) {
    await noteSynced(c, name, state, synced);
    return { tableId: tid, added: 0, ended: 0, ms: Date.now() - started };
  }
  const blobs = new Map();
  for (const f of added) if (f.deletes && f.deletes.dv) blobs.set(f.key, await state.readDeletes(f));
  for (const f of added) {
    if (!manyDeletes(f)) continue;
    const file = mergedFile(f);
    mkdirSync(dvDir, { recursive: true });
    await c.run(`COPY (SELECT DISTINCT file_path, pos FROM read_parquet([${f.deletes.parquet.map(d => q(d.path)).join(', ')}])
      WHERE file_path = ${q(f.path)} ORDER BY pos) TO ${q(file)} (FORMAT parquet)`);
    const [count] = await one(c, `SELECT count(*)::BIGINT FROM read_parquet(${q(file)})`);
    f.deletes = { parquet: [{ path: file, count: Number(count), size: statSync(file).size }] };
  }

  await c.run('BEGIN');
  try {
    // The name map's id comes from the file ids, as DuckLake's own do: it loads the maps from the next file id it has seen,
    // so a smaller id is never found in a process that has read the lake before.
    const [snap, mid, nextRow] = await one(c, `SELECT s.snapshot_id + 1,
      greatest(s.next_file_id, (SELECT coalesce(max(mapping_id), -1) + 1 FROM ${META}.ducklake_column_mapping)),
      coalesce((SELECT next_row_id FROM ${META}.ducklake_table_stats WHERE table_id = ${tid}), 0)
      FROM ${META}.ducklake_snapshot s ORDER BY s.snapshot_id DESC LIMIT 1`);
    const deleteFiles = added.reduce((n, f) => n + (f.deletes ? (f.deletes.parquet ? f.deletes.parquet.length : 1) : 0), 0);
    await c.run(`INSERT INTO ${META}.ducklake_snapshot SELECT snapshot_id + 1, now(), schema_version, next_catalog_id, ${Number(mid) + 1 + added.length + deleteFiles}
      FROM ${META}.ducklake_snapshot ORDER BY snapshot_id DESC LIMIT 1`);
    await c.run(`INSERT INTO ${META}.ducklake_snapshot_changes VALUES (${snap}, ${q(`inserted_into_table:${tid},deleted_from_table:${tid}`)}, 'onelake-studio', ${q(`${state.format} ${state.version}`)}, NULL)`);
    if (ended.length) {
      await c.run(`UPDATE ${META}.ducklake_data_file SET end_snapshot = ${snap} WHERE data_file_id IN (${ended.join(', ')})`);
      await c.run(`UPDATE ${META}.ducklake_delete_file SET end_snapshot = ${snap} WHERE end_snapshot IS NULL AND data_file_id IN (${ended.join(', ')})`);
    }
    // One name mapping per sync: each column by its name in the files, a Delta partition column by its folder.
    await c.run(`INSERT INTO ${META}.ducklake_column_mapping VALUES (${mid}, ${tid}, 'map_by_name')`);
    const children = new Map();
    for (const col of cols) {
      const p = col.parent_column == null ? null : String(col.parent_column);
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(col);
    }
    const mapping = [];
    const walk = (parent, parentSeq, fields) => {
      for (const col of children.get(parent) || []) {
        const f = fields.find(x => x.name === col.column_name) || { physical: col.column_name, children: [] };
        const seq = mapping.length;
        const partition = parent === null && state.format === 'delta' && state.partitionColumns.includes(col.column_name);
        mapping.push(`(${mid}, ${seq}, ${q(f.physical)}, ${col.column_id}, ${parentSeq == null ? 'NULL' : parentSeq}, ${partition})`);
        walk(String(col.column_id), seq, f.children);
      }
    };
    walk(null, null, state.fields);
    await c.run(`INSERT INTO ${META}.ducklake_name_mapping VALUES ${mapping.join(', ')}`);

    let id = Number(mid) + 1, rowId = Number(nextRow);
    const dataRows = [], partitionRows = [], deleteRows = [], statRows = [];
    // The columns a file's stats can be kept for: at the top, of an exact type, and in the file (a partition
    // column isn't). By their name in the files, as the log's stats name them.
    const statCols = cols.filter(col => col.parent_column == null).map(col => {
      const f = state.fields.find(x => x.name === col.column_name);
      return f && STAT_TYPES.has(f.type) && !state.partitionColumns.includes(f.name) ? { id: col.column_id, physical: f.physical, type: f.type } : null;
    }).filter(Boolean);
    for (const f of added) {
      const me = id++, local = held.get(f.path);
      let records = f.records;
      if (records == null) [records] = await one(c, `SELECT sum(num_rows)::BIGINT FROM parquet_file_metadata(${q(local || `${state.root}/${f.path}`)})`);
      if (f.size == null) throw new Error(`${name}: ${f.path} has no size`);
      const relative = !local && state.root != null;
      dataRows.push(`(${me}, ${tid}, ${snap}, ${q(local || f.path)}, ${relative}, 'parquet', ${Number(records)}, ${f.size}, NULL, ${rowId}, ${pid == null ? 'NULL' : pid}, ${mid})`);
      rowId += Number(records);
      f.partitionValues.forEach((v, i) => partitionRows.push(`(${me}, ${tid}, ${i}, ${v == null ? 'NULL' : q(v)})`));
      if (f.stats) for (const s of statCols) {
        const min = statText(s.type, f.stats.min[s.physical]), max = statText(s.type, f.stats.max[s.physical], true);
        if (min == null || max == null) continue;
        const nulls = Number.isSafeInteger(f.stats.nulls[s.physical]) ? f.stats.nulls[s.physical] : null;
        statRows.push(`(${me}, ${tid}, ${s.id}, ${nulls == null ? 'NULL' : Number(records) - nulls}, ${nulls == null ? 'NULL' : nulls}, ${q(min)}, ${q(max)})`);
      }
      if (f.deletes && f.deletes.dv) {
        const blob = blobs.get(f.key), file = dvFile(f);
        mkdirSync(dvDir, { recursive: true });
        writeFileSync(file, blob);
        deleteRows.push(`(${id++}, ${tid}, ${snap}, ${me}, ${q(file)}, false, 'puffin', ${f.deletes.count}, ${blob.length}, 0)`);
      }
      for (const d of (f.deletes && f.deletes.parquet) || [])
        deleteRows.push(`(${id++}, ${tid}, ${snap}, ${me}, ${q(d.path)}, false, 'parquet', ${d.count}, ${d.size}, NULL)`);
    }
    if (dataRows.length) await c.run(`INSERT INTO ${META}.ducklake_data_file (data_file_id, table_id, begin_snapshot, path, path_is_relative, file_format,
      record_count, file_size_bytes, footer_size, row_id_start, partition_id, mapping_id) VALUES ${dataRows.join(', ')}`);
    if (partitionRows.length) await c.run(`INSERT INTO ${META}.ducklake_file_partition_value VALUES ${partitionRows.join(', ')}`);
    if (statRows.length) await c.run(`INSERT INTO ${META}.ducklake_file_column_stats (data_file_id, table_id, column_id, value_count, null_count,
      min_value, max_value) VALUES ${statRows.join(', ')}`);
    if (deleteRows.length) await c.run(`INSERT INTO ${META}.ducklake_delete_file (delete_file_id, table_id, begin_snapshot, data_file_id, path,
      path_is_relative, format, delete_count, file_size_bytes, footer_size) VALUES ${deleteRows.join(', ')}`);
    const [count, bytes] = await one(c, `SELECT coalesce(sum(record_count), 0), coalesce(sum(file_size_bytes), 0) FROM ${META}.ducklake_data_file WHERE table_id = ${tid} AND end_snapshot IS NULL`);
    await c.run(`DELETE FROM ${META}.ducklake_table_stats WHERE table_id = ${tid}`);
    await c.run(`INSERT INTO ${META}.ducklake_table_stats VALUES (${tid}, ${count}, ${rowId}, ${bytes})`);
    await noteSynced(c, name, state, synced);
    await c.run('COMMIT');
  } catch (e) {
    await c.run('ROLLBACK').catch(() => {});
    throw e;
  }
  return { tableId: tid, added: added.length, ended: ended.length, ms: Date.now() - started };
}

/**
 * Attaches the lake: its metadata a DuckDB file of its own, its data path remote (see the header). Before the
 * lockdown, which leaves nothing to attach with.
 */
async function attachLake(c, metadataFile) {
  // Never written to: every table names its own folder. Remote only so DuckLake keeps remote paths remote.
  await c.run(`ATTACH ${q(`ducklake:${metadataFile}`)} AS lake (DATA_PATH ${q(`${DFS_ORIGIN}/unused/`)}, DATA_INLINING_ROW_LIMIT 0, METADATA_CATALOG ${q(META)})`);
  await c.run(`CREATE TABLE IF NOT EXISTS ${SYNCED} (name VARCHAR PRIMARY KEY, folder VARCHAR, format VARCHAR, location VARCHAR,
    version VARCHAR, listed VARCHAR, uuid VARCHAR, log VARCHAR, synced_at BIGINT)`);
}

// ---------------------------------------------------------------------------- What was synced

// Bound, not spliced: a big table's log is megabytes of text.
async function noteSynced(c, name, state, s) {
  if (!s) return;
  await c.run(`INSERT OR REPLACE INTO ${SYNCED} VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::BIGINT)`, [
    name, String(s.folder), state.format, s.location == null ? null : String(s.location), String(state.version),
    s.listed ? JSON.stringify(s.listed) : null, s.uuid == null ? null : String(s.uuid),
    state.log ? JSON.stringify(state.log) : null, String(Date.now())]);
}
const syncedRow = r => ({ name: r.name, folder: r.folder, format: r.format, location: r.location, version: r.version,
  listed: r.listed ? JSON.parse(r.listed) : null, uuid: r.uuid, syncedAt: Number(r.synced_at) });
/** What lake table `name` was last synced from, its log included, or null. */
async function syncedOf(c, name) {
  const [r] = await rows(c, `SELECT * FROM ${SYNCED} WHERE name = ${q(name)}`);
  return r ? { ...syncedRow(r), log: r.log ? JSON.parse(r.log) : null } : null;
}
/** The same without its log, which for a big table is megabytes to parse: where it was synced from, and when. */
async function syncedBrief(c, name) {
  const [r] = await rows(c, `SELECT * EXCLUDE (log) FROM ${SYNCED} WHERE name = ${q(name)}`);
  return r ? syncedRow(r) : null;
}
/** Every lake table and what it was last synced from, without the logs. */
async function syncedAll(c) {
  return (await rows(c, `SELECT * EXCLUDE (log) FROM ${SYNCED} ORDER BY name`)).map(syncedRow);
}

module.exports = { readDelta, readIceberg, syncTable, attachLake, syncedOf, syncedBrief, syncedAll, rows, META };
