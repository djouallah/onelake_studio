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

// The rules' thresholds.
const SMALL_FILE = 32 * MB;
const MANY_FILES = 10;
const DELETED_SHARE = 0.1;
const ROW_GROUP_ROWS = 100_000;
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
  const [g] = (await run(`SELECT count(*)::BIGINT AS files, coalesce(sum(num_row_groups), 0)::BIGINT AS groups,
      coalesce(sum(num_rows), 0)::BIGINT AS rows FROM parquet_file_metadata(${list})`)).rows;
  const [v] = (await run(`SELECT count(DISTINCT file_name)::BIGINT AS files FROM parquet_kv_metadata(${list})
      WHERE decode(key) = ${q(VORDER_KEY)} AND lower(decode(value)) = 'true'`)).rows;
  facts.footers = { files: num(g.files), groups: num(g.groups), rows: num(g.rows), vorder: num(v.files) };
  return facts;
}

const mb = b => `${(b / MB).toLocaleString('en', { maximumFractionDigits: b < 10 * MB ? 1 : 0 })} MB`;
const n0 = n => Number(n).toLocaleString('en');
const pct = x => `${Math.round(x * 100)}%`;

/**
 * What the facts say, each as { kind, finding, detail, action }. Nothing is run: the action is what to consider.
 * @param {object} facts  tableFacts's, `format` (the table's: 'delta' or 'iceberg'), and `checkpointGap`: a Delta
 *   table's commits since its last checkpoint
 */
function findings(facts) {
  const out = [];
  if (!facts || !facts.files) return out;
  const small = facts.sizes.slice(0, 2).reduce((n, b) => n + b.files, 0);
  if (facts.files >= MANY_FILES && small * 2 > facts.files) {
    out.push({ kind: 'small-files', finding: 'Many small files',
      detail: `${n0(small)} of ${n0(facts.files)} files are under ${mb(SMALL_FILE)}; ${mb(facts.bytes / facts.files)} on average`,
      action: 'OPTIMIZE to merge them' });
  }
  const physical = facts.records;
  if (physical && facts.deleted / physical >= DELETED_SHARE) {
    out.push({ kind: 'deleted-rows', finding: 'Many deleted rows',
      detail: `${pct(facts.deleted / physical)} of the rows in the files are deleted, still stored`,
      action: 'OPTIMIZE to rewrite those files' });
  }
  const f = facts.footers;
  // V-Order is how Fabric writes a Delta table's files: an Iceberg table has nothing to turn on.
  if (f && f.files && f.vorder < f.files && facts.format !== 'iceberg') {
    out.push({ kind: 'no-vorder', finding: 'Not V-Ordered',
      detail: `${n0(f.files - f.vorder)} of the ${n0(f.files)} files here have no V-Order`,
      action: 'Write the table with V-Order on, then OPTIMIZE' });
  }
  if (f && f.groups && f.rows / f.groups < ROW_GROUP_ROWS && f.files >= MANY_FILES) {
    out.push({ kind: 'small-row-groups', finding: 'Small row groups',
      detail: `${n0(Math.round(f.rows / f.groups))} rows per row group in the files here`,
      action: 'OPTIMIZE to write bigger ones' });
  }
  if (facts.checkpointGap != null && facts.checkpointGap >= CHECKPOINT_GAP) {
    out.push({ kind: 'checkpoint', finding: 'Checkpoint far behind',
      detail: `${n0(facts.checkpointGap)} commits since the last checkpoint: every reader reads them one by one`,
      action: 'A write or an OPTIMIZE makes a new one' });
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
