// sql.js: the host's own check that nothing the page or the command line sends can write. The
// allowed list is what page/data.js, semantic.js and explore/ send, plus user SQL that reads; the
// refused list is every way a write has been, or could be, dressed up as a read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { READS, WRITES } from "./sql-disagreements.mjs";

const require = createRequire(import.meta.url);
const { assertReads, checkedRead, isShowAllTables, readsCatalog } = require("../../core/sql.js");

const ALLOWED = [
  // A schema or table of the user's can be called ducklake_something: only the lake's functions are refused.
  `SELECT * FROM tpch.dbt_lakehouse.ducklake_mart.dim_duid`,
  `SELECT * FROM "tpch"."dbt_ducklake_meta_sqldatabase"."dbo"."ducklake_snapshot"`,
  // The lake's metadata is read by its name.
  "SELECT * FROM system_internal.ducklake_data_file",
  "SELECT 42",
  "select content from read_text('C:/ext/README.md')",
  "SELECT 'COPY (SELECT 1) TO x; INSERT'",
  `SELECT "insert", "copy" FROM t`,
  "SELECT copy, update FROM t;",
  "-- a comment\nSELECT 1 /* COPY */",
  "WITH x AS (SELECT 1) SELECT * FROM x",
  "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x WHERE n < 3) SELECT * FROM x",
  "EXPLAIN SELECT 1",
  "EXPLAIN ANALYZE SELECT 1",
  // Explore's Show plan: the profile and the tree.
  "EXPLAIN (ANALYZE, FORMAT json) SELECT 1",
  "EXPLAIN (FORMAT html) WITH x AS (SELECT 1) SELECT * FROM x",
  "DESCRIBE t",
  "SUMMARIZE t",
  "FROM t",
  "SELECT COLUMNS(*)::VARCHAR FROM (\nSELECT 1 AS a\n) LIMIT 500",
  "SELECT * FROM (VALUES ('a', NULL::VARCHAR)) t(column_name, kind)",
  // A value can mention what a statement may not call.
  "SELECT 'a query (b)', 'write_blob(x)' AS note",
  "SELECT * FROM read_text('abfss://ANZ Retail@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/x.txt')",
  "SELECT * FROM read_text('abfss://ws@westus-onelake.blob.fabric.microsoft.com/lh.Lakehouse/Files/x.txt')",
  "SELECT 'abfss://x/m.json'",
  ...READS,
];

// What a tab sets up to read a file is a host method now, so none of these is a statement's to do.
const SETUP = [
  `CREATE OR REPLACE VIEW "data" AS SELECT * FROM read_parquet(['abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/data.parquet'])`,
  `CREATE OR REPLACE VIEW ws.lh_lakehouse.dbo.t AS SELECT * FROM iceberg_scan('abfss://ws@onelake.dfs.fabric.microsoft.com/x.metadata.json')`,
  `ATTACH 'abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/a.duckdb' AS "a" (READ_ONLY)`,
  `ATTACH 'C:/tmp/copy_1_a.db' AS "a" (TYPE sqlite, READ_ONLY)`,
  `DETACH "a"`,
  `DROP VIEW IF EXISTS ws.lh_lakehouse.dbo.t`,
  `DROP TABLE IF EXISTS "__del_1"`,
  `DROP SCHEMA IF EXISTS "s" CASCADE`,
  `CREATE SCHEMA IF NOT EXISTS "nem"`,
];

const REFUSED = [
  ...WRITES,
  ...SETUP,
  "PRAGMA enable_external_access = true",
  "PRAGMA database_list",
  "SELECT * FROM ducklake_cleanup_old_files('lake', cleanup_all => true)",
  "SELECT * FROM \"ducklake_delete_orphaned_files\"('lake')",
  "SELECT * FROM ducklake_expire_snapshots('lake', older_than => now())",
  "SELECT * FROM truncate_duckdb_logs()",
  "SELECT * FROM enable_logging(['Quack'])",
  "SELECT * FROM quack_stop('quack:127.0.0.1:1')",
  "SELECT * FROM \"quack_serve\"('quack:127.0.0.1:1')",
  "SELECT * FROM query('SELECT * FROM quack' || '_stop(''quack:127.0.0.1:1'')')",
  "SELECT * FROM QUERY ('SELECT 1')",
  "SELECT * FROM \"query\"('SELECT 1')",
  "SELECT * FROM main.query_table('t' || 'x')",
  "SELECT write_blob('x', 'abc'::BLOB)",
  "SELECT \"write_blob\"('x', 'abc'::BLOB)",
  "SELECT write_log('forged', level := 'error', log_type := 'Quack')",
  "SELECT * FROM read_text('abfss://x@attacker.invalid/y.txt')",
  "SELECT * FROM read_text('abfss://x y@attacker.invalid/y.txt')",
  "SELECT * FROM read_text('az://x@attacker.invalid/y.txt')",
  "SELECT * FROM read_text('zip://abfss://x@onelake.dfs.fabric.microsoft.com.attacker.invalid/y.zip/z')",
  "COPY (SELECT 1) TO 'abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/x.csv'",
  "EXPLAIN ANALYZE COPY (SELECT 1) TO 'abfss://ws@onelake.dfs.fabric.microsoft.com/x.csv'",
  "EXPLAIN (ANALYZE, FORMAT json) COPY (SELECT 1) TO 'x.csv'",
  "EXPLAIN (ANALYZE, SET x = 1) SELECT 1",
  "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
  `ATTACH 'abfss://ws@onelake.dfs.fabric.microsoft.com/a.duckdb' AS "READ_ONLY"`,
  `ATTACH 'abfss://ws@onelake.dfs.fabric.microsoft.com/a.duckdb' AS a`,
  "ATTACH 'a.duckdb' AS a (READ_ONLY false)",
  "CREATE TABLE t AS SELECT 1",
  "CREATE VIEW v AS COPY t TO 'x'",
  "INSERT INTO t VALUES (1)",
  "UPDATE t SET a = 1",
  "DELETE FROM t",
  "EXPORT DATABASE 'abfss://ws@onelake.dfs.fabric.microsoft.com/x'",
  "INSTALL httpfs",
  "LOAD 'C:/evil.duckdb_extension'",
  "SET enable_external_access = true",
  "SELECT 1; SELECT 2",
  "SELECT 1; COPY t TO 'x'",
  "",
  "-- only a comment",
];

test("everything the page sends to read is allowed", () => {
  for (const sql of ALLOWED) assert.doesNotThrow(() => assertReads(sql), sql);
});

test("everything that could write is refused, and says it is read only", () => {
  for (const sql of REFUSED) assert.throws(() => assertReads(sql), /Not run/, sql);
});

// The second wall, with DuckDB's parser played by a fake: what it says stands, whatever the scanner
// took the text for. engine-host.test.mjs runs the real one.
const parser = answer => async () => answer;
const ONE_SELECT = { error: false, statements: [{}] };
const NOT_SELECT = { error: true, error_type: "not implemented", error_message: "Only SELECT statements can be serialized to json!" };
const SYNTAX = { error: true, error_type: "parser", error_message: 'syntax error at or near "FROM"' };

test("the parser has the last word on what the scanner took for a read", async () => {
  assert.equal(await checkedRead("SELECT 1", parser(ONE_SELECT)), "SELECT 1");
  await assert.rejects(checkedRead("SELECT 1", parser(NOT_SELECT)), /Not run/);
  await assert.rejects(checkedRead("SELECT 1", parser({ error: false, statements: [{}, {}] })), /one statement at a time/);
  await assert.rejects(checkedRead("EXPLAIN SELECT 1", parser(NOT_SELECT)), /Not run/);
  await assert.rejects(checkedRead("COPY t TO 'x'", parser(ONE_SELECT)), /COPY is not a read/, "and the scanner refuses first");
});

test("a statement that doesn't parse goes to DuckDB for its own error, unless it goes inside one of ours", async () => {
  assert.equal(await checkedRead("SELECT 1 FROM", parser(SYNTAX)), "SELECT 1 FROM");
  await assert.rejects(checkedRead("SELECT 1 FROM", parser(SYNTAX), { strict: true }), /syntax error/);
});

test("EXPLAIN runs as what was checked: its own words, and the query the parser read", async () => {
  const asked = [];
  const answer = async sql => { asked.push(sql); return ONE_SELECT; };
  assert.equal(await checkedRead("/* why */ EXPLAIN ANALYZE SELECT 1 -- this\n;", answer), "EXPLAIN ANALYZE SELECT 1");
  assert.equal(await checkedRead("EXPLAIN (ANALYZE, FORMAT json) SELECT 1", answer), "EXPLAIN (ANALYZE, FORMAT json) SELECT 1");
  assert.deepEqual(asked, ["SELECT 1", "SELECT 1"]);
});

test("a PIVOT, which the parser can't write as JSON, runs with its comments gone", async () => {
  for (const sql of ["/* c */ PIVOT t ON a -- c", "WITH x AS (SELECT 1 a) PIVOT x ON a", "SELECT * FROM (PIVOT t ON a)"]) {
    const run = await checkedRead(sql, parser(NOT_SELECT));
    assert.doesNotMatch(run, /\/\*|--/, sql);
    assert.match(run, /PIVOT/, sql);
  }
  await assert.rejects(checkedRead("SELECT 'pivot' AS a", parser(NOT_SELECT)), /Not run/, "the word in a string is no PIVOT");
});

test("a PIVOT's parser says it can be a query: what can't be one as a subquery is no read", async () => {
  const asked = [];
  const answer = async sql => { asked.push(sql); return asked.length === 1 ? NOT_SELECT : SYNTAX; };
  await assert.rejects(checkedRead("SELECT 1 FROM (PIVOT t ON a)", answer), /Not run/);
  assert.equal(asked[1], "SELECT * FROM (SELECT 1 FROM (PIVOT t ON a)\n)");
});

test("a statement that names the catalog, a subquery's SHOW too, has it synced first", () => {
  for (const sql of ["SHOW ALL TABLES", "SELECT * FROM (SHOW ALL TABLES)", "SELECT * FROM information_schema.tables"]) assert.ok(readsCatalog(sql), sql);
  for (const sql of ["SELECT 1", "SELECT 'SHOW TABLES'"]) assert.ok(!readsCatalog(sql), sql);
});

test("the command line's refusal names what it refused", () => {
  assert.throws(() => assertReads("DROP TABLE memory.main.not_a_table"),
    { message: "Not run: DROP is not a read." });
  assert.throws(() => assertReads("/* hidden */ detach x;"), /DETACH is not a read/);
});

test("SHOW ALL TABLES is known however it is written, and nothing else is", () => {
  for (const sql of ["SHOW ALL TABLES", "show  all\ntables;", "-- why\nSHOW ALL TABLES ;"]) assert.ok(isShowAllTables(sql), sql);
  for (const sql of ["SHOW TABLES", "SELECT 'SHOW ALL TABLES'", "SELECT * FROM (SHOW ALL TABLES)"]) assert.ok(!isShowAllTables(sql), sql);
});

// tableRefs: the names a statement reads, which the engine opens before running it.
test("a statement's tables are workspace.item_kind.schema.table, however they are written", () => {
  const { tableRefs, oldTableName } = require("../../core/sql.js");
  const KINDS = ["lakehouse", "warehouse", "sqldatabase", "mirroreddatabase"];
  const refs = sql => tableRefs(sql, KINDS);
  assert.deepEqual(refs("SELECT * FROM aemo.data_Lakehouse.dbo.dim_duid"),
    [{ kind: "lakehouse", workspace: "aemo", item: "data", schema: "dbo", table: "dim_duid" }]);
  // Any case, quoted parts with spaces and doubled quotes, space around the dots.
  assert.deepEqual(refs(`select 1 from "ANZ ws"."my ""lh""_lakehouse" . dbo."t 1"`),
    [{ kind: "lakehouse", workspace: "ANZ ws", item: 'my "lh"', schema: "dbo", table: "t 1" }]);
  // The kind is the last _<kind>, so an item whose own name ends in one keeps it.
  assert.deepEqual(refs("SELECT * FROM ws.x_lakehouse_lakehouse.dbo.t").map(r => r.item), ["x_lakehouse"]);
  // The engine's catalog in front is the same name.
  assert.deepEqual(refs("SELECT * FROM memory.aemo.data_lakehouse.dbo.t"),
    [{ kind: "lakehouse", workspace: "aemo", item: "data", schema: "dbo", table: "t" }]);
  // By GUIDs: the workspace's and the item's.
  const W = "0f3c1a2b-1111-2222-3333-444455556666", I = "9a1b2c3d-aaaa-bbbb-cccc-ddddeeeeffff";
  assert.deepEqual(refs(`SELECT * FROM "${W}"."${I}".dbo.t`),
    [{ byGuid: true, kind: null, workspace: W, item: I, schema: "dbo", table: "t" }]);
  // A join across kinds; a fifth part is a column.
  assert.deepEqual(refs("SELECT w.Warehouse.x FROM ws.wh_Warehouse.sales.f w JOIN ws.m_MirroredDatabase.dbo.c ON ws.wh_warehouse.sales.f.id = 1").map(r => r.kind + "." + r.table),
    ["warehouse.f", "mirroreddatabase.c", "warehouse.f"]);
  // Not tables: fewer parts, no kind on the item, inside a string or a comment.
  assert.deepEqual(refs("SELECT * FROM dbo.t, a.b_lakehouse.c, a.b.c.d, a.b_notebook.c.d, a._lakehouse.c.d"), []);
  // The old way, kind first, is not a table: it is said with its name now.
  assert.deepEqual(refs("SELECT * FROM lakehouse.aemo.data.dbo.t"), []);
  assert.equal(oldTableName("SELECT * FROM Warehouse.aemo.data.dbo.t"),
    "Warehouse.aemo.data.dbo.t is the old way to name a table: it is aemo.data_warehouse.dbo.t now");
  assert.equal(oldTableName(`SELECT * FROM lakehouse."ANZ ws"."gold-1".dbo.t`).endsWith(`"ANZ ws"."gold-1_lakehouse".dbo.t now`), true);
  assert.equal(oldTableName("SELECT * FROM aemo.data_lakehouse.dbo.t, 'lakehouse.a.b.c.d'"), null);
  assert.deepEqual(refs("SELECT 'a.b_lakehouse.c.d' -- a.b_lakehouse.c.d\n /* a.b_lakehouse.c.d */"), []);
  // As DuckDB reads them: nested comments, an E-string, and a line comment a carriage return ends.
  assert.deepEqual(refs("/* /* */ a.b_lakehouse.c.d */ SELECT 1"), []);
  assert.deepEqual(refs("SELECT E'\\' a.b_lakehouse.c.d'"), []);
  assert.equal(refs("SELECT 1 -- c\rFROM a.b_lakehouse.c.d").length, 1);
  // DESCRIBE, EXPLAIN and a view's body name tables too.
  assert.equal(refs("EXPLAIN ANALYZE SELECT count(*) FROM ws.db_sqldatabase.dbo.t").length, 1);
  assert.equal(refs("DESCRIBE ws.lh_lakehouse.dbo.t").length, 1);
  // A comment between its parts, and a Unicode space around it, are as DuckDB reads them.
  assert.equal(refs("SELECT * FROM aemo /*c*/ .data_lakehouse.dbo.t").length, 1);
  assert.equal(refs("SELECT * FROM aemo.data_lakehouse.dbo.t ").length, 1);
});

test("filesReadBy: the OneLake files a statement reads, and not one that is only a value", () => {
  const { filesReadBy } = require("../../core/sql.js");
  const A = "abfss://w@onelake.dfs.fabric.microsoft.com/i.Lakehouse/Files/a.parquet";
  const Z = "abfss://w@onelake.dfs.fabric.microsoft.com/i.Lakehouse/Files/a.zip";
  assert.deepEqual(filesReadBy(`SELECT * FROM '${A}'`), [A]);
  assert.deepEqual(filesReadBy(`SELECT * FROM read_parquet('${A}')`), [A]);
  assert.deepEqual(filesReadBy(`CREATE OR REPLACE VIEW "v" AS SELECT * FROM read_csv_auto('${A}')`), [A]);
  assert.deepEqual(filesReadBy(`ATTACH '${A}' AS x (READ_ONLY)`), [A]);
  assert.deepEqual(filesReadBy(`SELECT 1 FROM t JOIN '${A}' ON true JOIN '${A}' ON true`), [A], "once each");
  assert.deepEqual(filesReadBy(`SELECT * FROM read_csv('zip://${Z}/b.csv')`), [Z], "a zip's entry is its zip");
  assert.deepEqual(filesReadBy(`SELECT * FROM read_csv('${A}/*.csv')`), [], "a wildcard names no one file");
  assert.deepEqual(filesReadBy(`SELECT '${A}' AS path`), [], "a value");
  assert.deepEqual(filesReadBy(`VALUES ('${A}')`), [], "a value");
  assert.deepEqual(filesReadBy("SELECT * FROM 'https://x/y.csv'"), []);
});

// fileRefs: the file names a statement reads, which the engine turns into URLs before running it.
test("a file's name counts only where SQL reads a file, and one that is wrong is refused", () => {
  const { fileRefs } = require("../../core/sql.js");
  const KINDS = ["lakehouse", "warehouse", "sqldatabase", "mirroreddatabase"];
  const refs = sql => fileRefs(sql, KINDS);
  const F = "'aemo.data_lakehouse/Files/x.parquet'";
  assert.deepEqual(refs(`SELECT * FROM ${F}`),
    [{ zip: "", workspace: "aemo", item: "data", path: "/Files/x.parquet", written: "aemo.data_lakehouse/Files", start: 14, end: 14 + F.length, quote: "'" }]);
  // Every place DuckDB reads one, each as DuckDB's own CLI was seen to read it.
  for (const sql of [`FROM ${F}`, `from (${F})`, `SELECT 1 FROM ${F} a, ${F} b`, `SELECT 1 FROM t JOIN ${F} ON true`, `DESCRIBE ${F}`, `SUMMARIZE ${F}`,
    `PIVOT ${F} ON a`, `DESCRIBE FROM ${F}`, `EXPLAIN SELECT * FROM ${F}`, `SELECT 1 FROM read_parquet(${F}, filename = true)`,
    `SELECT 1 FROM main.read_parquet(${F})`, `SELECT 1 FROM range(1) r, LATERAL read_parquet(${F})`, `SELECT 1 FROM t, glob(${F})`, `FROM (read_parquet(${F}))`,
    `SELECT 1 FROM read_parquet([${F}])`, `SELECT * FROM (SELECT * FROM ${F})`, `SELECT 1 WHERE EXISTS (FROM ${F})`, `SELECT 1 FROM a JOIN b ON x = 1, ${F}`,
    `SELECT * FROM "aemo.data_lakehouse/Files/x.parquet"`]) {
    assert.ok(refs(sql).length >= 1, sql);
  }
  // A call's parentheses can hold a query, which reads as any other.
  assert.equal(refs(`SELECT 1 WHERE a IN (SELECT b FROM ${F})`).length, 1);
  // Nor does a value's FROM say anything of what comes after it.
  assert.deepEqual(refs(`SELECT 1 FROM t WHERE p IS DISTINCT FROM 'lakehouse.sales/2024'`), []);
  assert.equal(refs(`SELECT 1 FROM read_parquet([${F}, ${F}])`).length, 2);
  assert.equal(refs(`SELECT 1 FROM ${F} a, ${F} b`).length, 2);
  // Only ever a value: these are strings, and DuckDB gets them as they are.
  for (const sql of [`SELECT ${F}`, `SELECT 1, ${F}`, `SELECT upper(${F})`, `SELECT 1, upper(${F}) FROM t`, `SELECT 1 FROM t WHERE p = ${F}`, `SELECT 1 FROM t WHERE p IN (${F})`,
    `SELECT 1 FROM t WHERE f(${F})`, `SELECT * FROM (VALUES (${F})) v(p)`, `SELECT 1 FROM t, read_csv('a.csv', ${F})`, `SELECT 1 FROM t ORDER BY a DESC, ${F}`,
    `SELECT E${F} FROM t`, `SELECT "from", ${F} FROM t`, `SELECT t.from, ${F} FROM t`, `-- FROM ${F}\nSELECT 1`, `SELECT $$ FROM ${F} $$`,
    `SELECT 1 FROM t WHERE p IS DISTINCT FROM ${F}`, `SELECT trim(LEADING 'l' FROM ${F})`, `SELECT a IS DISTINCT FROM b, ${F} AS p FROM t`,
    `SELECT 1 FROM t WHERE p IS NOT DISTINCT FROM ${F}`, `SELECT substring(${F} FROM 1 FOR 2)`]) {
    assert.deepEqual(refs(sql), [], sql);
  }
  // Not names at all, wherever they are.
  for (const v of ["x.parquet", "lakehouse.parquet", "x_lakehouse.parquet", "abfss://ws@h/lh.Lakehouse/Files/x", "/lakehouse/x/Files/y",
    "data/Files/x", "https://a.b_lakehouse/Files/x"]) {
    assert.deepEqual(refs(`SELECT * FROM '${v}'`), [], v);
  }
  // As a table's name is spelled, any case before the '/'; a doubled quote is one quote.
  const anz = refs(`SELECT * FROM '"ANZ ""R"" a/b"."gold-1_lakehouse"/Files/a/b c/*.csv'`)[0];
  assert.equal(anz.workspace, 'ANZ "R" a/b');
  assert.equal(anz.item, "gold-1");
  assert.equal(anz.path, "/Files/a/b c/*.csv");
  assert.equal(refs(`SELECT * FROM 'a.b_lakehouse/Files/it''s.csv'`)[0].path, "/Files/it's.csv");
  assert.equal(refs(`SELECT * FROM 'zip://a.b_lakehouse/Files/a.zip/b.csv'`)[0].zip, "zip://");
  assert.equal(refs(`SELECT * FROM glob('a.b_lakehouse/Files')`)[0].path, "/Files");
  // Wrong, so never left to DuckDB, which would look on the disk or answer no rows.
  for (const [v, why] of [["aemo.data_lakehouse/x.parquet", /a file's name is/], ["aemo.data/Files/x", /a file's name is/],
    ["other.a.b/Files/x", /a file's name is/], ["a.b_lakehouse.c/Files/x", /a file's name is/], ["aemo.*/Files/x", /a file's name is/],
    ["my-ws.data_lakehouse/Files/x", /a file's name is/], ["a.b_lakehouse/files/x", /a file's name is/], ["a.b_warehouse/Files/x", /only a lakehouse/],
    ["lakehouse.aemo.data/Files/x", /the old way to name a file: it is 'aemo\.data_lakehouse\/Files\/x' now/],
    ["a.b_lakehouse/Tables/dbo/t/x.parquet", /a table's name is a\.b_lakehouse\.<schema>\.<table>/],
    ["a.b_lakehouse/Files/../Tables/dbo/t", /can't hold/], ["a.b_lakehouse/Files/./x", /can't hold/]]) {
    assert.throws(() => refs(`SELECT * FROM glob('${v}')`), why, v);
  }
});

test("DuckDB's error says a file as it was written, with its caret still on what it points at", () => {
  const { namedError } = require("../../core/sql.js");
  const written = [{ url: "abfss://a@h/d.Lakehouse/Files", name: "A.D_lakehouse/Files" }];
  assert.equal(namedError('IO Error: No files found that match the pattern "abfss://a@h/d.Lakehouse/Files/x.parquet"', written),
    'IO Error: No files found that match the pattern "A.D_lakehouse/Files/x.parquet"');
  const before = "SELECT * FROM read_csv('abfss://a@h/d.Lakehouse/Files/x.csv', bad = 1)";
  const after = "SELECT * FROM read_csv('A.D_lakehouse/Files/x.csv', bad = 1)";
  const pointing = (line, at) => `Binder Error: no\n\nLINE 1: ${line}\n${" ".repeat("LINE 1: ".length + at)}^`;
  // Past the URL, on the function before it, and inside it.
  assert.equal(namedError(pointing(before, before.indexOf("bad")), written), pointing(after, after.indexOf("bad")));
  assert.equal(namedError(pointing(before, before.indexOf("read_csv")), written), pointing(after, after.indexOf("read_csv")));
  assert.equal(namedError(pointing(before, before.indexOf("Lakehouse")), written), pointing(after, after.indexOf("LAKEHOUSE")));
  assert.equal(namedError("Binder Error: nothing of ours", written), "Binder Error: nothing of ours");
});

// catalogStatement: the SHOW statements answered with whole schema paths; nothing else.
test("SHOW ALL TABLES, SHOW SCHEMAS and SHOW TABLES FROM a nested schema are rewritten, nothing else", () => {
  const { catalogStatement, readsCatalog } = require("../../core/sql.js");
  for (const sql of ["SHOW ALL TABLES", "show all tables;", "  Show  All\n Tables ; ", "-- all of it\nSHOW ALL TABLES",
                     "SHOW SCHEMAS", "show schemas;"]) {
    assert.match(catalogStatement(sql) || "", /duckdb_schemas\(\)/, sql);
  }
  const from = catalogStatement('SHOW TABLES FROM "ANZ ws".lh_lakehouse.dbo;');
  assert.match(from, /lower\(p\.database_name\) = 'anz ws' AND .* = \['lh_lakehouse', 'dbo'\]/);
  assert.match(from, /current_database\(\) AND .* = \['anz ws', 'lh_lakehouse', 'dbo'\]/);
  assert.match(catalogStatement("show tables in memory.main"), /= \['main'\]/);
  for (const sql of ["SHOW TABLES", "SHOW TABLES FROM memory", "SHOW DATABASES", "SELECT 1", "DESCRIBE a.b_lakehouse.c.d",
                     "SHOW TABLES FROM a.b; DROP x", "SELECT 'SHOW ALL TABLES'"]) {
    assert.equal(catalogStatement(sql), null, sql);
  }
  assert.ok(readsCatalog("SHOW ALL TABLES"));
  assert.ok(readsCatalog("SELECT * FROM information_schema.tables"));
  assert.ok(readsCatalog("select * from duckdb_columns()"));
  assert.ok(!readsCatalog("SELECT 'duckdb_tables' AS x"));
  assert.ok(!readsCatalog("SELECT * FROM ws.lh_lakehouse.dbo.t"));
});

// assertOneLakeUrl: what a table's own metadata names is read with the OneLake token, so a URL there is OneLake's.
test("a URL from a table's metadata is OneLake's or refused; a local path passes", () => {
  const { assertOneLakeUrl } = require("../../core/sql.js");
  const { httpsOf } = require("../../core/lake/tableservice.js");
  for (const ok of ["abfss://ws@onelake.dfs.fabric.microsoft.com/i.Lakehouse/Tables/t/a.parquet",
                    "abfss://ws@westus-onelake.dfs.fabric.microsoft.com/i/a.parquet",
                    "https://onelake.blob.fabric.microsoft.com/ws/i/a.parquet",
                    "part-0.parquet", "year=2024/part-0.parquet", "C:/lake/t/a.parquet", "file:///C:/lake/t/a.bin"]) {
    assert.equal(assertOneLakeUrl(ok), ok);
  }
  for (const no of ["abfss://x@evil.example.com/f.parquet", "abfs://x@acct.dfs.core.windows.net/f.parquet",
                    "abfss://ws@onelake.dfs.fabric.microsoft.com.evil.example.com/f.parquet",
                    "abfss://onelake.dfs.fabric.microsoft.com@evil.example.com/f.parquet",
                    "https://evil.example.com/f.parquet", "az://container/f.parquet", "s3://bucket/f.parquet"]) {
    assert.throws(() => assertOneLakeUrl(no), /is not on OneLake/, no);
  }
  // The table service's GET carries the token.
  assert.equal(httpsOf("abfss://ws@onelake.dfs.fabric.microsoft.com/i/a.parquet"), "https://onelake.dfs.fabric.microsoft.com/ws/i/a.parquet");
  assert.throws(() => httpsOf("abfss://x@evil.example.com/f.parquet"), /is not on OneLake/);
});

// The storage secret's scope: OneLake's own places, each spelled as its URL was.
test("a OneLake URL's scope is its workspace on OneLake's host, and no other URL has one", () => {
  const { scopeOfUrl, oneLakeScopes, ONELAKE_SCOPES } = require("../../core/sql.js");
  const H = "onelake.dfs.fabric.microsoft.com";
  assert.equal(scopeOfUrl(`abfss://ws@${H}/i.Lakehouse/Tables/t`), `abfss://ws@${H}/`);
  assert.equal(scopeOfUrl(`abfss://ANZ Retail Demo@${H}/i/Files/a b.csv`), `abfss://ANZ Retail Demo@${H}/`);
  assert.equal(scopeOfUrl(`abfs://${H}/ws/i/Files/x`), `abfs://${H}/`);
  assert.equal(scopeOfUrl(`abfss://ws@westus-${H}/i/x`), `abfss://ws@westus-${H}/`);
  for (const no of ["abfss://x@evil.example.com/f", `abfss://${H}@evil.example.com/f`, `abfss://ws@${H}.evil.example.com/f`,
                    `https://${H}/ws/i/x`, "az://container/f", "C:/lake/t/a.parquet", `abfss://ws@${H}`]) {
    assert.equal(scopeOfUrl(no), null, no);
  }
  assert.ok(ONELAKE_SCOPES.every(s => scopeOfUrl(s) === s), "the scopes always there are OneLake's host");
  assert.deepEqual(oneLakeScopes(`SELECT * FROM read_csv('abfss://ws@${H}/i/Files/a.csv') JOIN 'zip://abfss://Other WS@${H}/i/Files/z.zip/b.csv' USING (k)
    WHERE note = 'abfss://x@evil.example.com/f' AND p = 'abfss://O''Brien@${H}/x'`),
    [`abfss://ws@${H}/`, `abfss://Other WS@${H}/`, `abfss://O'Brien@${H}/`]);
  // Put together from pieces, no URL is there to read a scope from: it gets no token.
  assert.deepEqual(oneLakeScopes("SELECT * FROM read_parquet('abfss://x@' || 'evil.example.com/f')"), []);
});

// The table service's download: written as it arrives, tried once more when the connection or the server failed.
test("a download is written whole, tried again once after a failure, and a refusal is final", async () => {
  const { httpsDownload } = require("../../core/lake/tableservice.js");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "onelake-download-"));
  const url = "abfss://ws@onelake.dfs.fabric.microsoft.com/i.Lakehouse/Tables/t/a.parquet";
  try {
    const asked = [];
    const answers = [() => { throw new Error("socket hang up"); }, () => new Response("PAR1 the file PAR1")];
    const download = httpsDownload({ getToken: async () => "tok", sleep: async () => {},
      fetchImpl: async (u, o) => { asked.push([u, o.headers.Authorization]); return answers.shift()(); } });
    const dst = join(dir, "a.parquet.part");
    assert.equal(await download(url, dst), 18);
    assert.equal(await readFile(dst, "utf8"), "PAR1 the file PAR1");
    assert.deepEqual(asked, Array(2).fill(["https://onelake.dfs.fabric.microsoft.com/ws/i.Lakehouse/Tables/t/a.parquet", "Bearer tok"]));

    let calls = 0;
    const refused = httpsDownload({ getToken: async () => "tok", sleep: async () => {},
      fetchImpl: async () => { calls++; return new Response("no", { status: 403 }); } });
    await assert.rejects(refused(url, dst), /OneLake answered 403/);
    assert.equal(calls, 1);

    calls = 0;
    const busy = httpsDownload({ getToken: async () => "tok", sleep: async () => {},
      fetchImpl: async () => (++calls === 1 ? new Response("busy", { status: 503 }) : new Response("PAR1")) });
    assert.equal(await busy(url, dst), 4);
    assert.equal(calls, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// -----------------------------------------------------------------------------
// Writes: to a lakehouse, and nothing else
// -----------------------------------------------------------------------------
const { writeOf, checkPlan, statementsOf, readsOnly } = require("../../core/sql.js");

test("a write is found with what it writes, and where", () => {
  const table = (sql, what, ref) => {
    const w = writeOf(sql);
    assert.equal(w.what, what, sql);
    assert.equal(w.target, "table", sql);
    assert.deepEqual(w.ref, ref, sql);
    return w;
  };
  const t = { workspace: "aemo", item: "data", schema: "dbo", table: "monthly" };
  table("INSERT INTO aemo.data_lakehouse.dbo.monthly SELECT 1", "insert", t);
  table("insert into aemo.data_lakehouse.dbo.monthly values (1)", "insert", t);
  table('INSERT INTO "aemo"."data_lakehouse"."dbo"."monthly" BY NAME SELECT 1 AS a', "insert", t);
  table("UPDATE aemo.data_lakehouse.dbo.monthly SET a = 1", "update", t);
  table("DELETE FROM aemo.data_lakehouse.dbo.monthly WHERE a = 1", "delete", t);
  table("MERGE INTO aemo.data_lakehouse.dbo.monthly m USING (SELECT 1 AS a) s ON m.a = s.a WHEN NOT MATCHED THEN INSERT VALUES (s.a)", "merge", t);
  table("CREATE TABLE aemo.data_lakehouse.dbo.monthly (a INT)", "create table", t);
  table("CREATE TABLE IF NOT EXISTS aemo.data_lakehouse.dbo.monthly AS SELECT 1 AS a", "create table", t);
  table("ALTER TABLE aemo.data_lakehouse.dbo.monthly ADD COLUMN b INT", "alter", t);
  table("WITH s AS (SELECT 1 AS a) INSERT INTO aemo.data_lakehouse.dbo.monthly SELECT * FROM s", "insert", t);
  table('/* why */ INSERT INTO "ANZ Retail"."gold-1_lakehouse".sales."order" SELECT 1', "insert",
        { workspace: "ANZ Retail", item: "gold-1", schema: "sales", table: "order" });
  const s = writeOf("CREATE SCHEMA aemo.data_lakehouse.raw");
  assert.deepEqual([s.what, s.target, s.ref], ["create schema", "schema", { workspace: "aemo", item: "data", schema: "raw" }]);
  assert.deepEqual(writeOf("CREATE SCHEMA IF NOT EXISTS aemo.data_lakehouse.raw").ref, { workspace: "aemo", item: "data", schema: "raw" });
});

test("where the target is written is where it is named again", () => {
  const sql = "INSERT INTO  aemo . data_lakehouse . dbo . monthly SELECT * FROM aemo.data_lakehouse.dbo.scada";
  const w = writeOf(sql);
  assert.equal(sql.slice(w.start, w.end), "aemo . data_lakehouse . dbo . monthly");
  const c = "COPY (SELECT 1) TO 'aemo.data_lakehouse/Files/out/x.parquet' (FORMAT parquet)";
  const f = writeOf(c);
  assert.equal(f.what, "copy");
  assert.equal(f.target, "file");
  assert.equal(c.slice(f.start, f.end), "'aemo.data_lakehouse/Files/out/x.parquet'");
  assert.deepEqual([f.ref.workspace, f.ref.item, f.ref.path], ["aemo", "data", "/Files/out/x.parquet"]);
  assert.equal(writeOf("COPY aemo.data_lakehouse.dbo.t TO 'aemo.data_lakehouse/Files/t.csv'").target, "file");
});

test("what isn't one of DuckDB's Iceberg writes to a lakehouse is refused, saying why", () => {
  const refused = [
    ["DROP TABLE aemo.data_lakehouse.dbo.monthly", /DROP is blocked/],
    ["drop schema aemo.data_lakehouse.raw cascade", /DROP is blocked/],
    ["TRUNCATE aemo.data_lakehouse.dbo.monthly", /TRUNCATE isn't/],
    ["CREATE OR REPLACE TABLE aemo.data_lakehouse.dbo.monthly AS SELECT 1", /CREATE OR REPLACE isn't/],
    ["INSERT OR REPLACE INTO aemo.data_lakehouse.dbo.monthly SELECT 1", /INSERT OR REPLACE isn't/],
    ["INSERT INTO aemo.data_lakehouse.dbo.monthly SELECT 1 ON CONFLICT DO NOTHING", /ON CONFLICT isn't/],
    ["CREATE VIEW aemo.data_lakehouse.dbo.v AS SELECT 1", /CREATE VIEW isn't a write to a lakehouse/],
    ["CREATE TEMP TABLE x AS SELECT 1", /temporary/],
    ["CREATE MACRO m() AS 1", /CREATE MACRO isn't/],
    ["CREATE SECRET s (TYPE azure)", /CREATE SECRET isn't/],
    ["ALTER VIEW aemo.data_lakehouse.dbo.v RENAME TO w", /only ALTER TABLE/],
    ["INSERT INTO aemo.data_warehouse.dbo.t SELECT 1", /lakehouse only/],
    ["INSERT INTO memory.main.t SELECT 1", /engine's own/],
    ["INSERT INTO memory.aemo.data_lakehouse.dbo.t SELECT 1", /engine's own/],
    ["INSERT INTO lake.main.t_x SELECT 1", /engine's own/],
    ["INSERT INTO system_internal.main.ducklake_data_file SELECT 1", /engine's own/],
    ["INSERT INTO aemo.data.monthly SELECT 1", /a write goes to a lakehouse table/],
    ["INSERT INTO lakehouse.aemo.data.dbo.monthly SELECT 1", /the old way to name a table: it is aemo\.data_lakehouse\.dbo\.monthly now/],
    ["CREATE SCHEMA lakehouse.aemo.data.raw", /the old way to name a schema: it is aemo\.data_lakehouse\.raw now/],
    ["CREATE SCHEMA aemo.data_warehouse.raw", /in a lakehouse only/],
    ["INSERT INTO t SELECT 1", /a write goes to a lakehouse table/],
    ["INSERT INTO aemo.data_lakehouse.monthly SELECT 1", /a write goes to a lakehouse table/],
    ["CREATE SCHEMA raw", /a schema is made in a lakehouse/],
    ["COPY (SELECT 1) TO 'x.csv'", /COPY writes to a lakehouse's Files/],
    ["COPY (SELECT 1) TO 'C:/Users/me/x.csv'", /COPY writes to a lakehouse's Files/],
    ["COPY (SELECT 1) TO 'abfss://ws@onelake.dfs.fabric.microsoft.com/lh/Files/x.csv'", /COPY writes to a lakehouse's Files/],
    ["COPY (SELECT 1) TO 'aemo.data_lakehouse/Tables/dbo/t/x.parquet'", /a table's name/],
    ["COPY (SELECT 1) TO 'aemo.data_warehouse/Files/x.csv'", /COPY writes to a lakehouse's Files|only a lakehouse/],
    ["COPY aemo.data_lakehouse.dbo.t FROM 'aemo.data_lakehouse/Files/x.csv'", /COPY … FROM loads a table/],
    ["COPY FROM DATABASE a TO b", /COPY/],
    ["ATTACH ':memory:' AS x", /ATTACH is not a read, nor one of the writes/],
    ["DETACH lakehouse", /DETACH is not a read/],
    ["SET enable_external_access = true", /SET is not a read/],
    ["PRAGMA database_list", /PRAGMA is not a read/],
    ["INSTALL httpfs", /INSTALL is not a read/],
    ["CALL ducklake_cleanup_old_files('lake')", /the lake is kept by the engine/],
    ["INSERT INTO ice_0123456789abcdef.dbo.t SELECT 1", /a write's catalog is the engine's own/],
    ["SELECT * FROM ice_0123456789abcdef.dbo.t", /a write's catalog is the engine's own/],
    ["INSERT INTO aemo.data_lakehouse.dbo.t SELECT 1; DROP TABLE aemo.data_lakehouse.dbo.t", /one statement at a time/],
  ];
  for (const [sql, why] of refused) {
    assert.throws(() => (readsOnly(sql) ? null : writeOf(sql)), err => /^Not run: /.test(err.message) && why.test(err.message), sql);
  }
});

test("a read is no write, and goes the read's way", () => {
  for (const sql of ["SELECT 1", "WITH x AS (SELECT 1) SELECT * FROM x", "EXPLAIN SELECT 1", "SHOW ALL TABLES"]) {
    assert.equal(readsOnly(sql), true, sql);
  }
  for (const sql of ["INSERT INTO aemo.data_lakehouse.dbo.t SELECT 1", "COPY (SELECT 1) TO 'a.b_lakehouse/Files/x.csv'"]) {
    assert.equal(readsOnly(sql), false, sql);
  }
});

// DuckDB's plan, as json_serialize_plan answers it (its shape on DuckDB 2.0).
const planned = (type, where) => ({ error: false, plans: [{ type, ...where }] });
const tableAt = catalog => ({ table_info: { qualified_name: { path: [catalog, "dbo", "t"] } } });

test("DuckDB's plan has the last word: the kind of statement, and the catalog or file it writes", () => {
  const ice = "ice_0123456789abcdef";
  assert.doesNotThrow(() => checkPlan(planned("LOGICAL_INSERT", tableAt(ice)), { plan: "LOGICAL_INSERT", catalog: ice }));
  assert.doesNotThrow(() => checkPlan(planned("LOGICAL_CREATE_TABLE", { info: { qualified_name: { path: ["ICE_0123456789ABCDEF", "dbo", "t"] } } }),
    { plan: "LOGICAL_CREATE_TABLE", catalog: ice }));
  assert.doesNotThrow(() => checkPlan(planned("LOGICAL_ALTER", { info: { catalog: ice, schema: "dbo", name: "t" } }),
    { plan: "LOGICAL_ALTER", catalog: ice }));
  const url = "abfss://aemo@onelake.dfs.fabric.microsoft.com/data.Lakehouse/Files/x.csv";
  assert.doesNotThrow(() => checkPlan(planned("LOGICAL_COPY_TO_FILE", { file_path: url }), { plan: "LOGICAL_COPY_TO_FILE", file: url }));

  assert.throws(() => checkPlan(planned("LOGICAL_INSERT", tableAt("memory")), { plan: "LOGICAL_INSERT", catalog: ice }),
    /would write to memory, not the lakehouse/);
  assert.throws(() => checkPlan(planned("LOGICAL_DROP", { info: { catalog: ice } }), { plan: "LOGICAL_INSERT", catalog: ice }),
    /plans this as DROP, not INSERT/);
  assert.throws(() => checkPlan(planned("LOGICAL_COPY_TO_FILE", { file_path: "C:/x.csv" }), { plan: "LOGICAL_COPY_TO_FILE", file: url }),
    /would write C:\/x\.csv/);
  assert.throws(() => checkPlan({ error: false, plans: [{ type: "LOGICAL_INSERT" }, { type: "LOGICAL_DROP" }] }, { plan: "LOGICAL_INSERT", catalog: ice }),
    /more than one statement/);
  assert.throws(() => checkPlan(planned("LOGICAL_INSERT", {}), { plan: "LOGICAL_INSERT", catalog: ice }), /^Error: Not run|Not run/);
  // DuckDB's own error stands as it says it: a table that isn't there.
  assert.throws(() => checkPlan({ error: true, error_type: "catalog", error_message: "Table with name t does not exist!" }, { plan: "LOGICAL_INSERT", catalog: ice }),
    { message: "Table with name t does not exist!" });
  assert.throws(() => checkPlan({ error: true, error_type: "serialization", error_message: "not serializable" }, { plan: "LOGICAL_INSERT", catalog: ice }),
    /Not run: DuckDB could not show its plan/);
});

test("several statements are split where DuckDB splits them", () => {
  assert.deepEqual(statementsOf("SELECT 1; SELECT 2;"), ["SELECT 1", "SELECT 2"]);
  assert.deepEqual(statementsOf("SELECT ';'; -- a ; comment\nSELECT $$;$$ /* ; */"), ["SELECT ';'", "-- a ; comment\nSELECT $$;$$ /* ; */"]);
  assert.deepEqual(statementsOf("SELECT 1 /* only */; -- nothing\n;"), ["SELECT 1 /* only */"]);
  assert.deepEqual(statementsOf(""), []);
});

test("an UPDATE, DELETE or MERGE whose bound plan DuckDB can't write is held to its physical plan", () => {
  const { checkPhysical, isUnserialized } = require("../../core/sql.js");
  const op = (name, ...children) => ({ name, children, extra_info: {} });
  assert.ok(isUnserialized(new Error("Not run: DuckDB could not show its plan of this write, so it isn't run: IcebergScan serialization not implemented.")));
  assert.throws(() => checkPlan({ error: true, error_type: "not implemented", error_message: "IcebergScan serialization not implemented" },
    { plan: "LOGICAL_UPDATE", catalog: "ice_0123456789abcdef" }), err => isUnserialized(err));
  assert.doesNotThrow(() => checkPhysical([op("ICEBERG_UPDATE", op("EMPTY_RESULT"))], "update"));
  // An UPDATE as DuckDB 2.0 plans one on OneLake: its rows written anew over the update that marks the old ones.
  assert.doesNotThrow(() => checkPhysical([op("ICEBERG_INSERT", op("COPY_TO_FILE", op("ICEBERG_UPDATE", op("PROJECTION", op("ICEBERG_SCAN")))))], "update"));
  assert.throws(() => checkPhysical([op("ICEBERG_INSERT", op("COPY_TO_FILE", op("PROJECTION")))], "update"), /has no ICEBERG_UPDATE/);
  assert.doesNotThrow(() => checkPhysical([op("ICEBERG_DELETE", op("ICEBERG_SCAN"))], "delete"));
  assert.doesNotThrow(() => checkPhysical([op("MERGE_INTO", op("ICEBERG_DELETE"), op("ICEBERG_INSERT", op("COPY_TO_FILE")), op("MERGE_ACTION_SOURCE"))], "merge"));
  assert.throws(() => checkPhysical([op("UPDATE", op("SEQ_SCAN"))], "update"), /plans a UPDATE in this/);
  assert.throws(() => checkPhysical([op("DELETE")], "delete"), /plans a DELETE in this/);
  assert.throws(() => checkPhysical([op("MERGE_INTO", op("INSERT"))], "merge"), /plans a INSERT in this/);
  assert.throws(() => checkPhysical([op("ICEBERG_DELETE")], "update"), /plans this as ICEBERG_DELETE, not ICEBERG_UPDATE/);
  assert.throws(() => checkPhysical([op("MERGE_INTO", op("MERGE_ACTION_SOURCE"))], "merge"), /writes no Iceberg table/);
  assert.throws(() => checkPhysical([op("ICEBERG_UPDATE", op("COPY_TO_FILE")), op("ICEBERG_UPDATE")], "update"), /more than one statement/);
  assert.throws(() => checkPhysical([op("ICEBERG_INSERT")], "insert"), /checked by its bound plan only/);
  assert.doesNotThrow(() => checkPhysical([op("ICEBERG_UPDATE", op("PROJECTION", op("COPY_TO_FILE")))], "update"), "an Iceberg write's own files");
  assert.throws(() => checkPhysical([op("PROJECTION", op("COPY_TO_FILE"))], "update"), /plans a COPY_TO_FILE in this/, "a COPY under no Iceberg write is a write elsewhere");
});
