'use strict';
// =============================================================================
// health.js — a table's files as the lake holds them, and what their layout says
// =============================================================================
// Everything here is already on this machine: the lake's own metadata (onelaketable.js) names each live file of a
// table with its size, its row count and its deleted rows, and a file that has come down whole is named by its
// local copy (tableservice.js). The footers of those copies say how many row groups each has and whether it was
// written with V-Order. Nothing is asked of OneLake, and a file that is not here is never fetched for this: what
// the copies say is said of them alone, with how many they are.
//
// `run(sql)` is a statement on the engine that holds the lake ({ rows }). The rules (findings) are a pure
// function of the facts, so the tests drive them with numbers.
// =============================================================================

const { sqlStr: q } = require('../sql');

const META = 'system_internal';
const MB = 1024 * 1024;
// A file's size, by bin: the edges, and how the card says each.
const BINS = [[0, 4 * MB, 'under 4 MB'], [4 * MB, 32 * MB, '4 to 32 MB'], [32 * MB, 128 * MB, '32 to 128 MB'],
  [128 * MB, 1024 * MB, '128 MB to 1 GB'], [1024 * MB, Infinity, '1 GB and over']];
// The footers read at most: local reads, but each one opens a file.
const FOOTERS_AT_MOST = 2000;
// The key Fabric writes in a file's footer when it wrote it with V-Order (probed on a Fabric Spark file, 2026-11-13).
const VORDER_KEY = 'com.microsoft.parquet.vorder.enabled';

// The rules' thresholds. A finding is something worth doing: a small table read whole in a moment has none,
// whatever its V-Order, row groups or deleted rows.
const SMALL_FILE = 32 * MB;     // under it a file is small; deleted rows matter once they hold this much
const BIG_FILE = 128 * MB;      // V-Order pays off on files this big; smaller ones are fine without it
const MANY_FILES = 10;          // small files worth merging
const DELETED_SHARE = 0.1;
const ROW_GROUP_ROWS = 100_000; // a file with several row groups under this is cut too small...
const SPLIT_ROWS = 1_000_000;   // ...and it matters once such files hold this many rows
const CHECKPOINT_GAP = 100;

const num = v => (v == null ? 0 : Number(v));

// The live files of lake table `name`: where each one is read from now, a local copy or OneLake.
const filesOf = name => `
  SELECT f.file_size_bytes AS size, f.record_count AS records, coalesce(d.deleted, 0) AS deleted,
         NOT f.path_is_relative AND f.path NOT LIKE 'abfs%' AND f.path NOT LIKE 'http%' AS here, f.path
  FROM ${META}.ducklake_data_file f
  JOIN ${META}.ducklake_table t ON t.table_id = f.table_id AND t.end_snapshot IS NULL
  LEFT JOIN (SELECT data_file_id, sum(delete_count) AS deleted FROM ${META}.ducklake_delete_file
             WHERE end_snapshot IS NULL GROUP BY ALL) d ON d.data_file_id = f.data_file_id
  WHERE t.table_name = ${q(name)} AND f.end_snapshot IS NULL`;

/**
 * What the lake holds of table `name`: its files, their sizes by bin, rows and deleted rows, and from the
 * footers of the files here, row groups and V-Order.
 * @param {(sql: string) => Promise<{rows: object[]}>} run
 * @param {string} name  the table's name in the lake
 */
async function tableFacts(run, name) {
  const bins = BINS.map(([lo, hi], i) => `count(*) FILTER (WHERE size >= ${lo}${hi === Infinity ? '' : ` AND size < ${hi}`})::BIGINT AS b${i}`);
  const [s] = (await run(`SELECT count(*)::BIGINT AS files, coalesce(sum(size), 0)::BIGINT AS bytes,
      coalesce(sum(records), 0)::BIGINT AS records, coalesce(sum(deleted), 0)::BIGINT AS deleted,
      count(*) FILTER (WHERE here)::BIGINT AS here, ${bins.join(', ')}
    FROM (${filesOf(name)})`)).rows;
  const facts = {
    files: num(s.files), bytes: num(s.bytes), records: num(s.records), deleted: num(s.deleted), here: num(s.here),
    sizes: BINS.map(([, , label], i) => ({ label, files: num(s[`b${i}`]) })),
    footers: null,
  };
  if (!facts.here) return facts;
  const local = (await run(`SELECT path FROM (${filesOf(name)}) WHERE here ORDER BY path LIMIT ${FOOTERS_AT_MOST}`)).rows.map(r => r.path);
  if (!local.length) return facts;
  const list = `[${local.map(q).join(', ')}]`;
  // One row per footer, with the file's size from the lake (null if its path doesn't match: then it is never big).
  const split = `g > 1 AND r < g * ${ROW_GROUP_ROWS}`, unordered = `NOT vo AND size >= ${BIG_FILE}`;
  const [g] = (await run(`SELECT count(*)::BIGINT AS files, coalesce(sum(g), 0)::BIGINT AS groups,
      coalesce(sum(r), 0)::BIGINT AS rows, count(*) FILTER (WHERE vo)::BIGINT AS vorder,
      count(*) FILTER (WHERE ${unordered})::BIGINT AS u_files, coalesce(sum(size) FILTER (WHERE ${unordered}), 0)::BIGINT AS u_bytes,
      count(*) FILTER (WHERE ${split})::BIGINT AS s_files, coalesce(sum(g) FILTER (WHERE ${split}), 0)::BIGINT AS s_groups,
      coalesce(sum(r) FILTER (WHERE ${split}), 0)::BIGINT AS s_rows
    FROM (SELECT m.num_row_groups AS g, m.num_rows AS r, v.file_name IS NOT NULL AS vo, h.size
          FROM parquet_file_metadata(${list}) m
          LEFT JOIN (SELECT DISTINCT file_name FROM parquet_kv_metadata(${list})
                     WHERE decode(key) = ${q(VORDER_KEY)} AND lower(decode(value)) = 'true') v ON v.file_name = m.file_name
          LEFT JOIN (SELECT path, size FROM (${filesOf(name)}) WHERE here) h ON h.path = m.file_name)`)).rows;
  facts.footers = { files: num(g.files), groups: num(g.groups), rows: num(g.rows), vorder: num(g.vorder),
    unordered: { files: num(g.u_files), bytes: num(g.u_bytes) },
    split: { files: num(g.s_files), groups: num(g.s_groups), rows: num(g.s_rows) } };
  return facts;
}

const mb = b => `${(b / MB).toLocaleString('en', { maximumFractionDigits: b < 10 * MB ? 1 : 0 })} MB`;
const n0 = n => Number(n).toLocaleString('en');
const pct = x => `${Math.round(x * 100)}%`;
const files = n => `${n0(n)} file${n === 1 ? '' : 's'}`;

/**
 * What the facts say, each as { kind, finding, detail, action }. Nothing is run: the action is what to consider.
 * @param {object} facts  tableFacts's, `format` (the table's: 'delta' or 'iceberg'), and `checkpointGap`: a Delta
 *   table's commits since its last checkpoint
 */
function findings(facts) {
  const out = [];
  if (!facts || !facts.files) return out;
  const small = facts.sizes.slice(0, 2).reduce((n, b) => n + b.files, 0);
  if (small >= MANY_FILES && small * 2 > facts.files) {
    out.push({ kind: 'small-files', finding: 'Many small files',
      detail: `${n0(small)} of ${n0(facts.files)} files are under ${mb(SMALL_FILE)}; ${mb(facts.bytes / facts.files)} on average`,
      action: 'OPTIMIZE to merge them' });
  }
  // Deleted rows cost what they hold: a tenth of a small table is read in no time.
  const share = facts.records ? facts.deleted / facts.records : 0;
  const dead = share * facts.bytes;
  if (share >= DELETED_SHARE && dead >= SMALL_FILE) {
    out.push({ kind: 'deleted-rows', finding: 'Many deleted rows',
      detail: `${pct(share)} of the rows in the files are deleted: about ${mb(dead)} still stored`,
      action: 'OPTIMIZE to rewrite those files' });
  }
  const f = facts.footers;
  // V-Order is said of big files only: small ones are fine without it, and many small ones are small-files'.
  // It is how Fabric writes a Delta table's files: an Iceberg table has nothing to turn on.
  const u = f && f.unordered;
  if (u && u.files && facts.format !== 'iceberg') {
    out.push({ kind: 'no-vorder', finding: 'Big files without V-Order',
      detail: `${files(u.files)} here of ${mb(BIG_FILE)} or more, ${mb(u.bytes)} in all, ${u.files === 1 ? 'has' : 'have'} no V-Order`,
      action: 'Write the table with V-Order on, then OPTIMIZE' });
  }
  // A small file has one row group because it is small; what's worth fixing is a big file cut into small ones.
  const s = f && f.split;
  if (s && s.groups && s.rows >= SPLIT_ROWS) {
    out.push({ kind: 'small-row-groups', finding: 'Small row groups',
      detail: `${files(s.files)} here cut into ${n0(s.groups)} row groups of ${n0(Math.round(s.rows / s.groups))} rows on average`,
      action: 'OPTIMIZE to write bigger ones' });
  }
  if (facts.checkpointGap != null && facts.checkpointGap >= CHECKPOINT_GAP) {
    out.push({ kind: 'checkpoint', finding: 'Checkpoint far behind',
      detail: `${n0(facts.checkpointGap)} commits since the last checkpoint: every reader reads them one by one`,
      action: 'Make a checkpoint: the writer of this table does not' });
  }
  return out;
}

/**
 * Every table of a lakehouse that this machine knows, each with its facts and findings when the lake holds it:
 * findings first, then the most files. Only what is kept here is read, so it works offline and asks nothing of
 * OneLake; a table whose metadata isn't kept, or that no query has read, is listed as not read yet.
 * @param {object} o
 * @param {{schema?: string, table: string}[]} o.tables   the lakehouse's tables, as its listing keeps them
 * @param {(t) => Promise<object|null>} o.metaOf           a table's kept metadata, or null
 * @param {(meta) => Promise<string|null>} o.lakeName      its name in the lake, or null
 * @param {(sql: string) => Promise<{rows: object[]}>} o.run
 */
async function lakehouseHealth({ tables, metaOf, lakeName, run }) {
  const out = [];
  for (const t of tables) {
    const row = { schema: t.schema || '', table: t.table };
    const meta = await metaOf(t).catch(() => null);
    const name = meta && meta.metadataLocation ? await lakeName(meta).catch(() => null) : null;
    if (!name) { out.push({ ...row, inLake: false }); continue; }
    const facts = { ...await tableFacts(run, name), format: meta.format || null };
    out.push({ ...row, inLake: true, facts, findings: findings(facts) });
  }
  const rank = r => (!r.inLake ? 2 : r.findings.length ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (b.facts?.files ?? 0) - (a.facts?.files ?? 0)
    || `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
}

module.exports = { tableFacts, findings, lakehouseHealth, BINS, VORDER_KEY, FOOTERS_AT_MOST };
