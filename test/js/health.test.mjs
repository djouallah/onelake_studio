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

test("deleted rows are a finding past a tenth of the rows, once they hold 32 MB", () => {
  const big = facts({ files: 2, bytes: 2 * 1024 * MB, records: 1000, sizes: sized(0, 0, 0, 0, 2) });
  assert.deepEqual(kinds({ ...big, deleted: 99 }), []);
  assert.deepEqual(kinds({ ...big, deleted: 150 }), ["deleted-rows"]);
  assert.match(findings({ ...big, deleted: 150 })[0].detail, /^15% of the rows in the files are deleted: about 307 MB still stored/);
  // A fifth of a 50 MB table: 10 MB of deleted rows, nothing worth rewriting.
  assert.deepEqual(kinds(facts({ files: 1, bytes: 50 * MB, records: 1000, deleted: 200, sizes: sized(0, 0, 1) })), []);
});

// The footers of the files here, as tableFacts gives them.
const footers = (o = {}) => ({ files: 1, groups: 1, rows: 1000, vorder: 0,
  unordered: { files: 0, bytes: 0 }, split: { files: 0, groups: 0, rows: 0 }, ...o });

test("a small table of one file has nothing to do, whatever its V-Order, row groups or deleted rows", () => {
  const one = facts({ files: 1, bytes: 2 * MB, records: 1000, deleted: 200, here: 1, sizes: sized(1), footers: footers() });
  assert.deepEqual(kinds(one), []);
});

test("V-Order is a finding for big files without it, never for small ones", () => {
  const big = facts({ files: 12, bytes: 12 * 300 * MB, here: 12, sizes: sized(0, 0, 0, 12) });
  assert.deepEqual(kinds({ ...big, footers: footers({ files: 12, vorder: 12, groups: 12, rows: 12e6 }) }), []);
  const some = findings({ ...big, footers: footers({ files: 12, vorder: 9, groups: 12, rows: 12e6, unordered: { files: 3, bytes: 900 * MB } }) });
  assert.deepEqual(some.map(x => x.kind), ["no-vorder"]);
  assert.match(some[0].detail, /^3 files here of 128 MB or more, 900 MB in all, have no V-Order/);
  // Many small files without V-Order: merging them is the finding, V-Order is not said again.
  const tiny = facts({ files: 10, bytes: 10 * MB, here: 10, sizes: sized(10), footers: footers({ files: 10, groups: 10, rows: 10_000 }) });
  assert.deepEqual(kinds(tiny), ["small-files"]);
  // An Iceberg table has no V-Order to turn on.
  assert.deepEqual(kinds({ ...big, format: "iceberg", footers: footers({ files: 12, vorder: 0, groups: 12, rows: 12e6, unordered: { files: 12, bytes: 3600 * MB } }) }), []);
  // No file here: nothing is said of V-Order or row groups.
  assert.deepEqual(kinds({ ...big, footers: null }), []);
});

test("small row groups are a finding for big files cut into them, not for small files", () => {
  const big = facts({ files: 1, bytes: 600 * MB, here: 1, sizes: sized(0, 0, 0, 1) });
  const cut = findings({ ...big, footers: footers({ files: 1, vorder: 1, groups: 40, rows: 40 * 30_000, split: { files: 1, groups: 40, rows: 40 * 30_000 } }) });
  assert.deepEqual(cut.map(x => x.kind), ["small-row-groups"]);
  assert.match(cut[0].detail, /^1 file here cut into 40 row groups of 30,000 rows on average/);
  // 150,000 rows in two groups: nothing worth rewriting.
  assert.deepEqual(kinds({ ...big, footers: footers({ files: 1, vorder: 1, groups: 2, rows: 150_000, split: { files: 1, groups: 2, rows: 150_000 } }) }), []);
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
    // Both files are named by local copies, as the table service does once they have come down. The first was
    // written with V-Order and cut into several row groups; the second has no V-Order, and the lake says it is
    // 200 MB, so it counts as big: its size comes from the lake, matched to its footer by path.
    const rels = (await c.runAndReadAll("SELECT path FROM system_internal.ducklake_data_file ORDER BY data_file_id")).getRowObjectsJson().map(r => r.path);
    const cut = p(join(dir, "cut.parquet")), plain = p(join(dir, "plain.parquet"));
    await c.run(`COPY (SELECT range AS id FROM range(10000)) TO '${cut}' (FORMAT parquet, ROW_GROUP_SIZE 2048, KV_METADATA {'${VORDER_KEY}': 'true'})`);
    await c.run(`COPY (SELECT range AS id FROM range(500)) TO '${plain}' (FORMAT parquet)`);
    await c.run(`UPDATE system_internal.ducklake_data_file SET path = '${cut}', path_is_relative = false WHERE path = '${rels[0]}'`);
    await c.run(`UPDATE system_internal.ducklake_data_file SET path = '${plain}', path_is_relative = false, file_size_bytes = ${200 * MB} WHERE path = '${rels[1]}'`);
    const run = async sql => ({ rows: (await c.runAndReadAll(sql)).getRowObjectsJson() });
    const f = await tableFacts(run, "t1");
    assert.equal(f.files, 2);
    assert.equal(f.records, 1500);
    assert.equal(f.deleted, 200);
    assert.equal(f.here, 2);
    assert.deepEqual([f.sizes[0].files, f.sizes[3].files], [1, 1]);
    const g = f.footers;
    assert.deepEqual([g.files, g.rows, g.vorder], [2, 10500, 1]);
    assert.deepEqual(g.unordered, { files: 1, bytes: 200 * MB });
    assert.equal(g.split.files, 1);
    assert.equal(g.split.rows, 10000);
    assert.ok(g.split.groups > 1 && g.groups === g.split.groups + 1, `row groups: ${JSON.stringify(g)}`);
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
