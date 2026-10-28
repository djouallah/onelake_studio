'use strict';
// =============================================================================
// deltalog.js — a Delta table's own log, for its Stats and History
// =============================================================================
// The engine reads every table through its Iceberg metadata, and that does not change
// here. But a table WRITTEN as Delta has its truth in _delta_log: the Iceberg side is
// Fabric's conversion of one Delta version, and it drops what Iceberg has no word for —
// who wrote each commit and why, the protocol and its features, the table properties
// (V-Order among them). This reads those from the log itself, and as little of it as
// answers the question — every file is a request to OneLake:
//
//   state    the Delta version the Iceberg metadata was converted from is already known,
//            so its N.crc is ONE request: size, file count, metadata and protocol. A writer
//            that leaves no crc has its last checkpoint read instead. Either is immutable,
//            so it is fetched once per version.
//   history  only when the History tab is opened: one listing, then the newest commits a
//            page at a time. Commit files are immutable too, and kept.
//
// What a real _delta_log holds varies by writer (probed 2026-10-29):
//
//   Fabric Spark    N.json with commitInfo, plus N.crc
//   Warehouse       N.json with txn + add/remove only: NO commitInfo, no crc; checkpoints
//   delta-rs        N.json with commitInfo, checkpoints, _last_checkpoint, no crc
//
// No I/O of its own: `list`, `readText` and `readCheckpoint` are handed in (onelake.js),
// so the tests drive it with fakes.
// =============================================================================

const HISTORY_PAGE = 10;

const COMMIT = /^(\d{20})\.json$/;

const leaf = p => String(p).split('/').pop();
const pad = v => String(v).padStart(20, '0');
const logDirOf = dir => `${String(dir).replace(/\/+$/, '')}/_delta_log`;
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// One commit file: newline-delimited JSON, one action per line.
function parseCommit(text) {
  const c = { commitInfo: null, metaData: null, protocol: null,
              add: { files: 0, bytes: 0, rows: 0, rowsKnown: true },
              remove: { files: 0, bytes: 0 } };
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let a;
    try { a = JSON.parse(line); } catch (_) { continue; }
    if (a.commitInfo) c.commitInfo = a.commitInfo;
    else if (a.metaData) c.metaData = a.metaData;
    else if (a.protocol) c.protocol = a.protocol;
    else if (a.add) {
      c.add.files++;
      c.add.bytes += Number(a.add.size) || 0;
      // `stats` is a JSON string, and numRecords in it is optional (or null).
      let n = null;
      try { n = JSON.parse(a.add.stats || 'null')?.numRecords; } catch (_) {}
      if (n == null || !Number.isFinite(Number(n))) c.add.rowsKnown = false;
      else c.add.rows += Number(n);
    } else if (a.remove) {
      c.remove.files++;
      c.remove.bytes += Number(a.remove.size) || 0;
    }
  }
  return c;
}

// One row of History. A commit without commitInfo (a Warehouse writes none) still says
// what it did: the files it added and removed.
function historyEntry(version, c, lastModified) {
  const ci = c.commitInfo || {};
  const m = ci.operationMetrics || {};
  const params = ci.operationParameters && Object.keys(ci.operationParameters).length
    ? ci.operationParameters : null;
  return {
    version: String(version),
    timestamp: num(ci.timestamp) ?? num(ci.inCommitTimestamp) ?? lastModified ?? null,
    operation: ci.operation || (c.metaData && !c.add.files ? 'METADATA' : c.add.files || c.remove.files ? 'WRITE' : null),
    rowsAdded: num(m.numOutputRows) ?? num(m.numTargetRowsInserted) ?? (c.add.files && c.add.rowsKnown ? c.add.rows : null),
    rowsRemoved: num(m.numDeletedRows) ?? num(m.numTargetRowsDeleted),
    rowsUpdated: num(m.numUpdatedRows) ?? num(m.numTargetRowsUpdated),
    filesAdded: num(m.numFiles) ?? num(m.numAddedFiles) ?? num(m.numTargetFilesAdded) ?? c.add.files,
    filesRemoved: num(m.numRemovedFiles) ?? num(m.numTargetFilesRemoved) ?? c.remove.files,
    bytesAdded: num(m.numOutputBytes) ?? num(m.numAddedBytes) ?? (c.add.files ? c.add.bytes : null),
    parameters: params,
    engine: ci.engineInfo || ci.clientVersion || null,
    user: ci.userName || null,
  };
}

// configuration and partitionColumns arrive as an object and an array from JSON, and as a
// map and a list from a checkpoint read through DuckDB's to_json.
function tableFacts(metaData, protocol) {
  const md = metaData || {}, p = protocol || {};
  const features = [...new Set([...(p.readerFeatures || []), ...(p.writerFeatures || [])])].sort();
  return {
    id: md.id || null,
    createdTime: num(md.createdTime),
    partitionColumns: Array.isArray(md.partitionColumns) ? md.partitionColumns : [],
    properties: md.configuration && typeof md.configuration === 'object' ? md.configuration : {},
    minReaderVersion: num(p.minReaderVersion),
    minWriterVersion: num(p.minWriterVersion),
    features,
  };
}

const notFound = e => !!e && (e.status === 404 || /HTTP 404/.test(e.message || ''));
// A file that is absent, or not the JSON it should be, is "not there": the next source is
// tried. Anything else (a 403, the network) is the caller's to see.
async function readJson(readText, path) {
  try { return JSON.parse(await readText(path)); }
  catch (e) { if (notFound(e) || e instanceof SyntaxError) return null; throw e; }
}

/**
 * The table as of `version`: its metadata and protocol, and its size where the log has it.
 * One request when the writer left a crc; otherwise _last_checkpoint and the checkpoint it
 * names (`asOf` says which version that describes). Never a walk through the commits.
 * @param {object} io
 * @param {(path: string) => Promise<string>} io.readText  an immutable log file's text
 * @param {(path: string) => Promise<string>} [io.readFresh]  a file that is rewritten
 *   (_last_checkpoint), read past any cache
 * @param {(paths: string[]) => Promise<{metaData: object|null, protocol: object|null}>} io.readCheckpoint
 */
async function readDeltaState({ readText, readFresh = readText, readCheckpoint }, dir, version) {
  const logDir = logDirOf(dir);
  const crc = await readJson(readText, `${logDir}/${pad(version)}.crc`);
  if (crc && crc.metadata && crc.protocol) {
    return {
      version, asOf: version, source: 'crc', ...tableFacts(crc.metadata, crc.protocol),
      sizeBytes: num(crc.tableSizeBytes), numFiles: num(crc.numFiles),
      deletedRows: num(crc.numDeletedRecordsOpt),
    };
  }
  // No crc: the checkpoint _last_checkpoint names. It can be a few versions older than
  // `version`, and says so; metadata rarely changes between the two. Unlike every other
  // file here it is rewritten at each checkpoint, so it is never read from a cache.
  const last = await readJson(readFresh, `${logDir}/_last_checkpoint`);
  const cp = last && num(last.version);
  if (cp == null) {
    return { version, asOf: null, source: null, ...tableFacts(null, null),
             sizeBytes: null, numFiles: null, deletedRows: null };
  }
  const parts = num(last.parts);
  const paths = last.v2Checkpoint && last.v2Checkpoint.path
    ? [`${logDir}/${leaf(last.v2Checkpoint.path)}`]
    : parts > 1
      ? Array.from({ length: parts }, (_, i) =>
          `${logDir}/${pad(cp)}.checkpoint.${String(i + 1).padStart(10, '0')}.${String(parts).padStart(10, '0')}.parquet`)
      : [`${logDir}/${pad(cp)}.checkpoint.parquet`];
  const s = await readCheckpoint(paths);
  // Not _last_checkpoint's sizeInBytes (the checkpoint file's own size) nor its file count
  // (of an older version than the rest of the card): the Iceberg side has both for `version`.
  return { version, asOf: cp, source: 'checkpoint', ...tableFacts(s.metaData, s.protocol),
           sizeBytes: null, numFiles: null, deletedRows: null };
}

/**
 * The log's commits, newest first: [{ version, lastModified }] — one listing.
 * @param {(dir: string) => Promise<{name: string, isDir: boolean, lastModified?: number|null}[]>} list
 */
async function listCommits(list, dir) {
  const out = [];
  for (const e of await list(logDirOf(dir))) {
    const m = !e.isDir && COMMIT.exec(leaf(e.name));
    if (m) out.push({ version: Number(m[1]), lastModified: e.lastModified ?? null });
  }
  return out.sort((a, b) => b.version - a.version);
}

/** One page of History: `count` commits after the newest `skip`, read and summarised. */
async function readHistoryPage(readText, dir, commits, skip = 0, count = HISTORY_PAGE) {
  const logDir = logDirOf(dir);
  const page = commits.slice(skip, skip + count);
  const parsed = await Promise.all(page.map(c => readText(`${logDir}/${pad(c.version)}.json`).then(parseCommit)));
  return page.map((c, i) => historyEntry(c.version, parsed[i], c.lastModified));
}

// The table's directory, out of the location of its converted Iceberg metadata — the one
// path to it the catalog hands back, whatever the item calls its schemas. abfss for a
// lakehouse or warehouse, https for some; segments may arrive percent-encoded.
function tableDirOf(metadataLocation) {
  const loc = String(metadataLocation || '');
  const m = /^abfss:\/\/([^@/]+)@[^/]+\/(.+)\/metadata\/[^/]+$/i.exec(loc)
         || /^https:\/\/[^/]+\/([^/]+)\/(.+)\/metadata\/[^/]+$/i.exec(loc);
  if (!m) return null;
  const dec = s => { try { return decodeURIComponent(s); } catch (_) { return s; } };
  return { workspace: dec(m[1]), dir: m[2].split('/').map(dec).join('/') };
}

module.exports = { readDeltaState, listCommits, readHistoryPage, parseCommit, historyEntry,
                   tableDirOf, HISTORY_PAGE };
