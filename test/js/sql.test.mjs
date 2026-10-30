// sql.js assertReadOnly: the host's own check that nothing the page sends can write. The
// allowed list is exactly what app/data.js, semantic.js and explore/ send, plus user SQL that
// reads; the refused list is every way a write has been, or could be, dressed up as a read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assertReadOnly } = require("../../src/sql.js");

const ALLOWED = [
  "SELECT 42",
  "select content from read_text('C:/ext/README.md')",
  `CREATE OR REPLACE VIEW "data" AS SELECT * FROM read_parquet(['abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/data.parquet'])`,
  `CREATE OR REPLACE VIEW "dbo"."t" AS SELECT * FROM iceberg_scan('abfss://ws@onelake.dfs.fabric.microsoft.com/x.metadata.json')`,
  `CREATE OR REPLACE VIEW "t" AS SELECT CAST(NULL AS INTEGER) AS "a" WHERE false`,
  `ATTACH 'abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/a.duckdb' AS "a" (READ_ONLY)`,
  `ATTACH 'C:/tmp/copy_1_a.db' AS "a" (TYPE sqlite, READ_ONLY)`,
  `DETACH "a"`,
  `DROP VIEW IF EXISTS "dbo"."t"`,
  `DROP TABLE IF EXISTS "__del_1"`,
  `DROP SCHEMA IF EXISTS "s" CASCADE`,
  `CREATE SCHEMA IF NOT EXISTS "nem"`,
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
];

const REFUSED = [
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
  for (const sql of ALLOWED) assert.doesNotThrow(() => assertReadOnly(sql), sql);
});

test("everything that could write is refused, and says it is read only", () => {
  for (const sql of REFUSED) assert.throws(() => assertReadOnly(sql), /Read only/, sql);
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
