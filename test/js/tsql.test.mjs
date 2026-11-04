// SQL endpoint mode (src/tsql.js), the parts that need no endpoint: what a statement may do there,
// how its tables' names become the endpoint's, and how its answers read as DuckDB's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { assertTsqlRead, onEndpoint, planTree, fieldType, value, createTsql } = require("../../src/tsql.js");

test("only a read runs on the endpoint: one SELECT, nothing that writes or changes the session", () => {
  for (const ok of ["SELECT 1 FROM lakehouse.ws.lh.dbo.t", "WITH a AS (SELECT 1 AS x) SELECT x FROM a;",
    "/*semantic\nSELECT AGG(\"Sales\") FROM semanticmodel.ws.m\n*/\nSELECT 1", "SELECT 'DELETE FROM x' AS s", "SELECT [insert] FROM t"]) {
    assert.doesNotThrow(() => assertTsqlRead(ok), ok);
  }
  for (const [bad, said] of [["DELETE FROM t", /SELECT/], ["SELECT * INTO x FROM t", /INTO/], ["SELECT 1; DROP TABLE t", /one statement/],
    ["EXEC sp_who", /SELECT/], ["SELECT 1 EXEC x", /EXEC/], ["SET SHOWPLAN_XML ON", /SELECT/], ["SELECT 1 /* nested /* */ still */ ; SELECT 2", /one statement/]]) {
    assert.throws(() => assertTsqlRead(bad), said, bad);
  }
});

test("a table's five-part name is the endpoint's three, in the workspace it names", () => {
  const r = onEndpoint('SELECT * FROM lakehouse.Sales.nem.dbo."dim duid" d JOIN lakehouse.sales.nem.dbo.fact f ON 1 = 1 JOIN warehouse.Sales.[dw].dbo.t ON 1 = 1');
  assert.equal(r.sql, 'SELECT * FROM "nem"."dbo"."dim duid" d JOIN "nem"."dbo"."fact" f ON 1 = 1 JOIN "dw"."dbo"."t" ON 1 = 1');
  assert.equal(r.workspace, "Sales");
  assert.deepEqual(r.items, [{ kind: "Lakehouse", item: "nem" }, { kind: "Warehouse", item: "dw" }]);
  // In a string or a comment it is text, not a table.
  assert.equal(onEndpoint("SELECT 'lakehouse.a.b.c.d' -- lakehouse.x.y.z.w\nFROM lakehouse.a.b.c.d").sql,
    "SELECT 'lakehouse.a.b.c.d' -- lakehouse.x.y.z.w\nFROM \"b\".\"c\".\"d\"");
  assert.throws(() => onEndpoint("SELECT * FROM lakehouse.a.l.dbo.t, lakehouse.b.l.dbo.t"), /One workspace/);
  assert.throws(() => onEndpoint("SELECT 1"), /names a table/);
  assert.throws(() => onEndpoint("SELECT * FROM sqldatabase.a.db.dbo.t"), /endpoint of its own/);
});

test("the endpoint's types and values read as DuckDB's", () => {
  assert.equal(fieldType({ type: { name: "IntN" }, dataLength: 8 }), "BIGINT");
  assert.equal(fieldType({ type: { name: "IntN" }, dataLength: 4 }), "INTEGER");
  assert.equal(fieldType({ type: { name: "FloatN" }, dataLength: 8 }), "DOUBLE");
  assert.equal(fieldType({ type: { name: "DecimalN" }, precision: 19, scale: 4 }), "DECIMAL(19,4)");
  assert.equal(fieldType({ type: { name: "BitN" } }), "BOOLEAN");
  assert.equal(fieldType({ type: { name: "DateTime2N" } }), "TIMESTAMP");
  assert.equal(fieldType({ type: { name: "VarChar" } }), "VARCHAR");
  assert.equal(value("12", "BIGINT"), 12);
  assert.equal(value("9223372036854775807", "BIGINT"), "9223372036854775807");
  assert.equal(value(new Date(Date.UTC(2024, 0, 31)), "DATE"), "2024-01-31");
  assert.equal(value(new Date(Date.UTC(2024, 0, 31, 10, 5, 6)), "TIMESTAMP"), "2024-01-31 10:05:06");
  assert.equal(value(new Date(Date.UTC(2024, 0, 31, 10, 5, 6, 250)), "TIMESTAMP"), "2024-01-31 10:05:06.25");
  assert.equal(value(null, "VARCHAR"), null);
});

test("a SHOWPLAN_XML is a tree of operators, each with its own cost", () => {
  const xml = '<ShowPlanXML><RelOp NodeId="0" PhysicalOp="Hash Match" LogicalOp="Aggregate" EstimateRows="10" EstimatedTotalSubtreeCost="3">' +
    '<RelOp NodeId="1" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="1000" EstimatedTotalSubtreeCost="2">' +
    '<Object Database="[nem]" Schema="[dbo]" Table="[fact]" /></RelOp></RelOp></ShowPlanXML>';
  assert.deepEqual(planTree(xml), [{ op: "Hash Match", logical: "Aggregate", rows: 10, table: null, cost: 1,
    children: [{ op: "Table Scan", logical: "Table Scan", rows: 1000, table: "dbo.fact", cost: 2, children: [] }] }]);
});

test("a statement is refused before anything asks for a token or an endpoint", async () => {
  let asked = 0;
  const t = createTsql({ endpoints: async () => { asked++; return []; }, sqlToken: async () => { asked++; return null; } });
  await assert.rejects(t.query("DELETE FROM lakehouse.w.l.dbo.t"), /Read only/);
  await assert.rejects(t.query("SELECT 1"), /names a table/);
  await assert.rejects(t.query("SELECT * FROM lakehouse.w.l.dbo.t"), /has no lakehouse l/);
  assert.equal(asked, 1, "only the endpoint listing, for the last one");
});
