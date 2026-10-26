// The panel's own app/paths.js — a separate copy from the website's, tested here.
import { test } from "node:test";
import assert from "node:assert/strict";

test("a never-written table gets an empty view typed from its Iceberg schema", async () => {
  const { emptyTableSql, icebergToDuckType } = await import("../app/paths.js");
  assert.equal(icebergToDuckType("long"), "BIGINT");
  assert.equal(icebergToDuckType("decimal(10, 2)"), "DECIMAL(10,2)");
  assert.equal(icebergToDuckType("struct<a, b>"), "VARCHAR");
  assert.equal(emptyTableSql([{ name: "id", type: "long" }, { name: 'a"b', type: "string" }]),
    `SELECT CAST(NULL AS BIGINT) AS "id", CAST(NULL AS VARCHAR) AS "a""b" WHERE false`);
});
