// sql.js: the host's own check that nothing the page or the command line sends can write. The
// allowed list is what app/data.js, semantic.js and explore/ send, plus user SQL that reads; the
// refused list is every way a write has been, or could be, dressed up as a read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { READS, WRITES } from "./sql-disagreements.mjs";

const require = createRequire(import.meta.url);
const { assertReads, checkedRead, isShowAllTables } = require("../../src/sql.js");

const ALLOWED = [
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
  "SELECT cache_httpfs_clear_cache()",
  'SELECT "cache_httpfs_set_offline"(true)',
  "SELECT * FROM truncate_duckdb_logs()",
  "SELECT * FROM enable_logging(['Quack'])",
  "SELECT * FROM quack_stop('quack:127.0.0.1:1')",
  "SELECT * FROM \"quack_serve\"('quack:127.0.0.1:1')",
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
  const { tableRefs } = require("../../src/sql.js");
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
});

// catalogStatement: the SHOW statements answered with whole schema paths; nothing else.
test("SHOW ALL TABLES, SHOW SCHEMAS and SHOW TABLES FROM a nested schema are rewritten, nothing else", () => {
  const { catalogStatement, readsCatalog } = require("../../src/sql.js");
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
