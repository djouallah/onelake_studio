// core/lake/health.js: a table's file layout from the lake's metadata and the footers of the files here,
// and the findings the numbers give. The lake's own tables, as DuckLake keeps them, are made here where DuckDB is
// (the lake's workflow); npm test, which has no node_modules, tests the findings alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { tableFacts, findings, lakehouseHealth, VORDER_KEY } = require("../../core/lake/health.js");
let duckdb = null;
try { duckdb = require("@duckdb/node-api"); } catch (_) {}
const skip = !duckdb && "@duckdb/node-api is not installed: the lake's workflow runs this";
if (skip && process.env.NO_SKIP) throw new Error(skip);

const MB = 1024 * 1024;
const facts = (o = {}) => ({ files: 0, bytes: 0, records: 0, deleted: 0, here: 0, footers: null,
  sizes: [0, 0, 0, 0, 0].map((files, i) => ({ label: String(i), files })), ...o });
const sized = (...files) => ["under 4 MB", "4 to 32 MB", "32 to 128 MB", "128 MB to 1 GB", "1 GB and over"].map((label, i) => ({ label, files: files[i] ?? 0 }));
const kinds = f => findings(f).map(x => x.kind);

test("many files that are mostly small is a finding; a few small files are not", () => {
  assert.deepEqual(kinds(facts({ files: 1240, bytes: 1240 * 3 * MB, sizes: sized(1100, 130, 10) })), ["small-files"]);
  assert.deepEqual(kinds(facts({ files: 4, bytes: 4 * MB, sizes: sized(4) })), [], "a small table is small");
  assert.deepEqual(kinds(facts({ files: 20, bytes: 20 * 200 * MB, sizes: sized(2, 0, 0, 18) })), []);
  assert.match(findings(facts({ files: 10, bytes: 10 * MB, sizes: sized(10) }))[0].detail, /10 of 10 files are under 32 MB; 1 MB on average/);
});

test("deleted rows past a tenth of the rows stored are a finding", () => {
  const one = facts({ files: 2, bytes: 2 * 200 * MB, records: 1000, sizes: sized(0, 0, 0, 2) });
  assert.deepEqual(kinds({ ...one, deleted: 99 }), []);
  assert.deepEqual(kinds({ ...one, deleted: 180 }), ["deleted-rows"]);
  assert.match(findings({ ...one, deleted: 180 })[0].detail, /^18% of the rows/);
});

test("the footers of the files here: V-Order and row groups, said of those files only", () => {
  const big = facts({ files: 1240, bytes: 1240 * 300 * MB, sizes: sized(0, 0, 0, 1240) });
  assert.deepEqual(kinds({ ...big, footers: { files: 120, vorder: 120, groups: 120, rows: 120 * 2e6 } }), []);
  const mixed = findings({ ...big, footers: { files: 120, vorder: 100, groups: 600, rows: 600 * 50_000 } });
  assert.deepEqual(mixed.map(x => x.kind), ["no-vorder", "small-row-groups"]);
  assert.match(mixed[0].detail, /20 of the 120 files here have no V-Order/);
  assert.match(mixed[1].detail, /50,000 rows per row group/);
  // An Iceberg table has no V-Order to turn on: only its row groups are said.
  assert.deepEqual(findings({ ...big, format: "iceberg", footers: { files: 120, vorder: 0, groups: 600, rows: 600 * 50_000 } }).map(x => x.kind),
    ["small-row-groups"]);
  // No file here: nothing is said of V-Order or row groups.
  assert.deepEqual(kinds({ ...big, footers: null }), []);
});

test("a Delta checkpoint a hundred commits behind is a finding", () => {
  const f = facts({ files: 1, bytes: 300 * MB, sizes: sized(0, 0, 0, 1) });
  assert.deepEqual(kinds({ ...f, checkpointGap: 99 }), []);
  assert.deepEqual(kinds({ ...f, checkpointGap: 150 }), ["checkpoint"]);
  assert.deepEqual(kinds(facts()), [], "a table with no files has nothing to say");
});

test("the facts come from the lake's metadata, and from the footers of the files it names here", { skip }, async () => {
  const H = await import("./lake-helpers.mjs");
  const dir = await mkdtemp(join(tmpdir(), "health-"));
  const db = await duckdb.DuckDBInstance.create(":memory:");
  const c = await db.connect();
  try {
    await H.load(c, "ducklake");
    const p = s => s.replace(/\\/g, "/");
    await c.run(`ATTACH 'ducklake:${p(join(dir, "meta.ducklake"))}' AS lake (DATA_PATH '${p(join(dir, "data"))}/', METADATA_CATALOG 'system_internal')`);
    await c.run("CREATE TABLE lake.t1 AS SELECT range AS id FROM range(1000)");
    await c.run("INSERT INTO lake.t1 SELECT range FROM range(500)");
    await c.run("DELETE FROM lake.t1 WHERE id < 100");
    // One file is named by a local copy, as the table service does once it has come down; it was written with V-Order.
    const [{ path: rel }] = (await c.runAndReadAll("SELECT path FROM system_internal.ducklake_data_file ORDER BY data_file_id LIMIT 1")).getRowObjectsJson();
    const local = p(join(dir, "here.parquet"));
    await c.run(`COPY (SELECT range AS id FROM range(1000)) TO '${local}' (FORMAT parquet, KV_METADATA {'${VORDER_KEY}': 'true'})`);
    await c.run(`UPDATE system_internal.ducklake_data_file SET path = '${local}', path_is_relative = false WHERE path = '${rel}'`);
    const run = async sql => ({ rows: (await c.runAndReadAll(sql)).getRowObjectsJson() });
    const f = await tableFacts(run, "t1");
    assert.equal(f.files, 2);
    assert.equal(f.records, 1500);
    assert.equal(f.deleted, 200);
    assert.equal(f.here, 1);
    assert.equal(f.sizes[0].files, 2);
    assert.deepEqual(f.footers, { files: 1, groups: 1, rows: 1000, vorder: 1 });
    assert.deepEqual((await tableFacts(run, "nope")).files, 0);
  } finally {
    c.closeSync();
    db.closeSync();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("a lakehouse's tables: findings first, then the most files; a table the lake doesn't hold is not read yet", async () => {
  // A run that answers each lake table's summary query with its own numbers, and no file here.
  const lake = { t_small: { files: 400, bytes: 400 * MB, b0: 400 }, t_fine: { files: 3, bytes: 900 * MB, b3: 3 }, t_more: { files: 9, bytes: 9 * 300 * MB, b3: 9 } };
  const run = async sql => {
    const name = /table_name = '([^']+)'/.exec(sql)[1];
    return { rows: [{ records: 0, deleted: 0, here: 0, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, ...lake[name] }] };
  };
  const tables = [{ schema: "dbo", table: "fine" }, { schema: "dbo", table: "gone" }, { schema: "dbo", table: "small" },
                  { schema: "dbo", table: "more" }, { schema: "dbo", table: "never" }];
  const metaOf = async t => (t.table === "never" ? null : { metadataLocation: `abfss://w@h/${t.table}/metadata/v1.json` });
  const lakeName = async meta => { const t = /\/([a-z]+)\/metadata/.exec(meta.metadataLocation)[1]; return t === "gone" ? null : `t_${t}`; };
  const rows = await lakehouseHealth({ tables, metaOf, lakeName, run });
  assert.deepEqual(rows.map(r => r.table), ["small", "more", "fine", "gone", "never"]);
  assert.deepEqual(rows[0].findings.map(f => f.kind), ["small-files"]);
  assert.deepEqual(rows.slice(3).map(r => r.inLake), [false, false]);
});
