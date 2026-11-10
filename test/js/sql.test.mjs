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
  `SELECT * FROM lakehouse.tpch.dbt.ducklake_mart.dim_duid`,
  `SELECT * FROM "sqldatabase"."tpch"."dbt_ducklake_meta"."dbo"."ducklake_snapshot"`,
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
  `CREATE OR REPLACE VIEW lakehouse.ws.lh.dbo.t AS SELECT * FROM iceberg_scan('abfss://ws@onelake.dfs.fabric.microsoft.com/x.metadata.json')`,
  `ATTACH 'abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/a.duckdb' AS "a" (READ_ONLY)`,
  `ATTACH 'C:/tmp/copy_1_a.db' AS "a" (TYPE sqlite, READ_ONLY)`,
  `DETACH "a"`,
  `DROP VIEW IF EXISTS lakehouse.ws.lh.dbo.t`,
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
  for (const sql of REFUSED) assert.throws(() => assertReads(sql), /Read only/, sql);
});

// The second wall, with DuckDB's parser played by a fake: what it says stands, whatever the scanner
// took the text for. engine-host.test.mjs runs the real one.
const parser = answer => async () => answer;
const ONE_SELECT = { error: false, statements: [{}] };
const NOT_SELECT = { error: true, error_type: "not implemented", error_message: "Only SELECT statements can be serialized to json!" };
const SYNTAX = { error: true, error_type: "parser", error_message: 'syntax error at or near "FROM"' };

test("the parser has the last word on what the scanner took for a read", async () => {
  assert.equal(await checkedRead("SELECT 1", parser(ONE_SELECT)), "SELECT 1");
  await assert.rejects(checkedRead("SELECT 1", parser(NOT_SELECT)), /Read only/);
  await assert.rejects(checkedRead("SELECT 1", parser({ error: false, statements: [{}, {}] })), /one statement at a time/);
  await assert.rejects(checkedRead("EXPLAIN SELECT 1", parser(NOT_SELECT)), /Read only/);
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
  await assert.rejects(checkedRead("SELECT 'pivot' AS a", parser(NOT_SELECT)), /Read only/, "the word in a string is no PIVOT");
});

test("a PIVOT's parser says it can be a query: what can't be one as a subquery is no read", async () => {
  const asked = [];
  const answer = async sql => { asked.push(sql); return asked.length === 1 ? NOT_SELECT : SYNTAX; };
  await assert.rejects(checkedRead("SELECT 1 FROM (PIVOT t ON a)", answer), /Read only/);
  assert.equal(asked[1], "SELECT * FROM (SELECT 1 FROM (PIVOT t ON a)\n)");
});

test("a statement that names the catalog, a subquery's SHOW too, has it synced first", () => {
  for (const sql of ["SHOW ALL TABLES", "SELECT * FROM (SHOW ALL TABLES)", "SELECT * FROM information_schema.tables"]) assert.ok(readsCatalog(sql), sql);
  for (const sql of ["SELECT 1", "SELECT 'SHOW TABLES'"]) assert.ok(!readsCatalog(sql), sql);
});

test("the command line's refusal names what it refused", () => {
  assert.throws(() => assertReads("DROP TABLE memory.main.not_a_table"),
    { message: "Read only: OneLake Studio never writes, and DROP is not a read." });
  assert.throws(() => assertReads("/* hidden */ detach x;"), /DETACH is not a read/);
});

test("SHOW ALL TABLES is known however it is written, and nothing else is", () => {
  for (const sql of ["SHOW ALL TABLES", "show  all\ntables;", "-- why\nSHOW ALL TABLES ;"]) assert.ok(isShowAllTables(sql), sql);
  for (const sql of ["SHOW TABLES", "SELECT 'SHOW ALL TABLES'", "SELECT * FROM (SHOW ALL TABLES)"]) assert.ok(!isShowAllTables(sql), sql);
});

// tableRefs: the five-part names a statement reads, which the engine opens before running it.
test("a statement's tables are its five-part names under a kind, however they are written", () => {
  const { tableRefs } = require("../../core/sql.js");
  const KINDS = ["lakehouse", "warehouse", "sqldatabase", "mirroreddatabase"];
  const refs = sql => tableRefs(sql, KINDS);
  assert.deepEqual(refs("SELECT * FROM Lakehouse.aemo.data.dbo.dim_duid"),
    [{ kind: "lakehouse", workspace: "aemo", item: "data", schema: "dbo", table: "dim_duid" }]);
  // Any case, quoted parts with spaces and doubled quotes, space around the dots.
  assert.deepEqual(refs(`select 1 from lakehouse."ANZ ws"."my ""lh""" . dbo."t 1"`),
    [{ kind: "lakehouse", workspace: "ANZ ws", item: 'my "lh"', schema: "dbo", table: "t 1" }]);
  // A join across kinds; a sixth part is a column.
  assert.deepEqual(refs("SELECT w.Warehouse.x FROM Warehouse.ws.wh.sales.f w JOIN MirroredDatabase.ws.m.dbo.c ON Warehouse.ws.wh.sales.f.id = 1").map(r => r.kind + "." + r.table),
    ["warehouse.f", "mirroreddatabase.c", "warehouse.f"]);
  // Not tables: fewer parts, another first part, inside a string or a comment.
  assert.deepEqual(refs("SELECT * FROM dbo.t, Lakehouse.a.b.c, x.Lakehouse.a.b.c.d"), []);
  assert.deepEqual(refs("SELECT 'Lakehouse.a.b.c.d' -- Lakehouse.a.b.c.d\n /* Lakehouse.a.b.c.d */"), []);
  // As DuckDB reads them: nested comments, an E-string, and a line comment a carriage return ends.
  assert.deepEqual(refs("/* /* */ Lakehouse.a.b.c.d */ SELECT 1"), []);
  assert.deepEqual(refs("SELECT E'\\' Lakehouse.a.b.c.d'"), []);
  assert.equal(refs("SELECT 1 -- c\rFROM Lakehouse.a.b.c.d").length, 1);
  // DESCRIBE, EXPLAIN and a view's body name tables too.
  assert.equal(refs("EXPLAIN ANALYZE SELECT count(*) FROM SQLDatabase.ws.db.dbo.t").length, 1);
  assert.equal(refs("DESCRIBE Lakehouse.ws.lh.dbo.t").length, 1);
  // A comment between its parts, and a Unicode space around it, are as DuckDB reads them.
  assert.equal(refs("SELECT * FROM lakehouse.aemo /*c*/ .data.dbo.t").length, 1);
  assert.equal(refs("SELECT * FROM lakehouse.aemo.data.dbo.t ").length, 1);
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
  const F = "'lakehouse.aemo.data/Files/x.parquet'";
  assert.deepEqual(refs(`SELECT * FROM ${F}`),
    [{ zip: "", workspace: "aemo", item: "data", path: "/Files/x.parquet", written: "lakehouse.aemo.data/Files", start: 14, end: 14 + F.length, quote: "'" }]);
  // Every place DuckDB reads one, each as DuckDB's own CLI was seen to read it.
  for (const sql of [`FROM ${F}`, `from (${F})`, `SELECT 1 FROM ${F} a, ${F} b`, `SELECT 1 FROM t JOIN ${F} ON true`, `DESCRIBE ${F}`, `SUMMARIZE ${F}`,
    `PIVOT ${F} ON a`, `DESCRIBE FROM ${F}`, `EXPLAIN SELECT * FROM ${F}`, `SELECT 1 FROM read_parquet(${F}, filename = true)`,
    `SELECT 1 FROM main.read_parquet(${F})`, `SELECT 1 FROM range(1) r, LATERAL read_parquet(${F})`, `SELECT 1 FROM t, glob(${F})`, `FROM (read_parquet(${F}))`,
    `SELECT 1 FROM read_parquet([${F}])`, `SELECT * FROM (SELECT * FROM ${F})`, `SELECT 1 WHERE EXISTS (FROM ${F})`, `SELECT 1 FROM a JOIN b ON x = 1, ${F}`,
    `SELECT * FROM "lakehouse.aemo.data/Files/x.parquet"`]) {
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
  for (const v of ["x.parquet", "lakehouse.parquet", "abfss://ws@h/lh.Lakehouse/Files/x", "/lakehouse/x/Files/y", "other.a.b/Files/x", "https://lakehouse.a.b/Files/x"]) {
    assert.deepEqual(refs(`SELECT * FROM '${v}'`), [], v);
  }
  // As a table's name is spelled, any case before the '/'; a doubled quote is one quote.
  const anz = refs(`SELECT * FROM 'LAKEHOUSE."ANZ ""R"" a/b"."gold-1"/Files/a/b c/*.csv'`)[0];
  assert.equal(anz.workspace, 'ANZ "R" a/b');
  assert.equal(anz.item, "gold-1");
  assert.equal(anz.path, "/Files/a/b c/*.csv");
  assert.equal(refs(`SELECT * FROM 'lakehouse.a.b/Files/it''s.csv'`)[0].path, "/Files/it's.csv");
  assert.equal(refs(`SELECT * FROM 'zip://lakehouse.a.b/Files/a.zip/b.csv'`)[0].zip, "zip://");
  assert.equal(refs(`SELECT * FROM glob('lakehouse.a.b/Files')`)[0].path, "/Files");
  // Wrong, so never left to DuckDB, which would look on the disk or answer no rows.
  for (const [v, why] of [["lakehouse.aemo.data/x.parquet", /a file's name is/], ["lakehouse.aemo/Files/x", /a file's name is/],
    ["lakehouse.a.b.c/Files/x", /a file's name is/], ["lakehouse.aemo.*/Files/x", /a file's name is/], ["lakehouse.my-ws.data/Files/x", /a file's name is/],
    ["lakehouse.a.b/files/x", /a file's name is/], ["warehouse.a.b/Files/x", /only a lakehouse/],
    ["lakehouse.a.b/Tables/dbo/t/x.parquet", /a table's name is lakehouse\.a\.b\.<schema>\.<table>/],
    ["lakehouse.a.b/Files/../Tables/dbo/t", /can't hold/], ["lakehouse.a.b/Files/./x", /can't hold/]]) {
    assert.throws(() => refs(`SELECT * FROM glob('${v}')`), why, v);
  }
});

test("DuckDB's error says a file as it was written, with its caret still on what it points at", () => {
  const { namedError } = require("../../core/sql.js");
  const written = [{ url: "abfss://a@h/d.Lakehouse/Files", name: "LAKEHOUSE.A.D/Files" }];
  assert.equal(namedError('IO Error: No files found that match the pattern "abfss://a@h/d.Lakehouse/Files/x.parquet"', written),
    'IO Error: No files found that match the pattern "LAKEHOUSE.A.D/Files/x.parquet"');
  const before = "SELECT * FROM read_csv('abfss://a@h/d.Lakehouse/Files/x.csv', bad = 1)";
  const after = "SELECT * FROM read_csv('LAKEHOUSE.A.D/Files/x.csv', bad = 1)";
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
  const from = catalogStatement('SHOW TABLES FROM lakehouse."ANZ ws".lh.dbo;');
  assert.match(from, /lower\(p\.database_name\) = 'lakehouse'/);
  assert.match(from, /= \['anz ws', 'lh', 'dbo'\]/);
  assert.match(catalogStatement("show tables in memory.main"), /= \['main'\]/);
  for (const sql of ["SHOW TABLES", "SHOW TABLES FROM memory", "SHOW DATABASES", "SELECT 1", "DESCRIBE lakehouse.a.b.c.d",
                     "SHOW TABLES FROM a.b; DROP x", "SELECT 'SHOW ALL TABLES'"]) {
    assert.equal(catalogStatement(sql), null, sql);
  }
  assert.ok(readsCatalog("SHOW ALL TABLES"));
  assert.ok(readsCatalog("SELECT * FROM information_schema.tables"));
  assert.ok(readsCatalog("select * from duckdb_columns()"));
  assert.ok(!readsCatalog("SELECT 'duckdb_tables' AS x"));
  assert.ok(!readsCatalog("SELECT * FROM lakehouse.ws.lh.dbo.t"));
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
