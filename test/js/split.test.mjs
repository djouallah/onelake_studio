// split.js: a compiled query's scan of a large table shared out between the Fabric app's
// engines: which CTEs split, their partials, and the final statement.
import { test } from "node:test";
import assert from "node:assert/strict";

const { splitPlan, carried } = await import("../../fabric_app/site/storage/split.js");

const large = t => t === "Sales" || t === "Returns";
const OUTER = `SELECT f3.g0 AS "City", CAST(f3.a0 AS DOUBLE) AS "Sales Amount" FROM f3`;

test("a tile grouped below its joins: the body is the partial, the final adds the answers up", () => {
  const body = `SELECT j4."City" AS "g0", SUM(p6."a0") AS "a0" FROM (SELECT t2."CustomerKey" AS "c0", SUM(t2."Amount") AS "a0" FROM v_Sales AS t2 GROUP BY t2."CustomerKey") AS p6 LEFT JOIN v_Customer AS j4 ON j4."CustomerKey" = p6."c0" GROUP BY j4."City"`;
  const sql = `/*semantic\nSELECT "Customer"."City", AGG("Sales Amount") FROM model\n*/\nWITH f3 AS (${body})\n${OUTER}`;
  const plan = splitPlan(sql, large);
  assert.deepEqual(plan.parts, [{ cte: "f3", table: "Sales", partialSql: body.replace("v_Sales", "p_Sales") }]);
  assert.equal(plan.finalSql(() => ["a.parquet", "b's.parquet"]),
    `/*semantic\nSELECT "Customer"."City", AGG("Sales Amount") FROM model\n*/\nWITH f3 AS (SELECT "g0" AS "g0", SUM("a0") AS "a0" FROM read_parquet(['a.parquet', 'b''s.parquet']) GROUP BY ALL)\n${OUTER}`);
});

test("the final gives each column its type back; a HUGEINT crosses as a DECIMAL", () => {
  const sql = `WITH f2 AS (SELECT SUM(t1."Qty") AS "a0", NULLIF(COUNT(*), 0) AS "a1", COUNT(t1."Qty") AS "a2", MIN(t1."Qty") AS "a3" FROM v_Sales AS t1) SELECT * FROM f2`;
  const plan = splitPlan(sql, large);
  const types = { a0: "HUGEINT", a1: "BIGINT", a2: "BIGINT", a3: "INTEGER" };
  assert.equal(plan.finalSql(() => ["p"], () => types),
    `WITH f2 AS (SELECT CAST(SUM("a0") AS HUGEINT) AS "a0", CAST(SUM("a1") AS BIGINT) AS "a1", CAST(COALESCE(SUM("a2"), 0) AS BIGINT) AS "a2", CAST(MIN("a3") AS INTEGER) AS "a3" FROM read_parquet(['p'])) SELECT * FROM f2`);
  assert.equal(carried("SELECT 1", types), `SELECT * REPLACE (CAST("a0" AS DECIMAL(38, 0)) AS "a0") FROM (SELECT 1)`);
  assert.equal(carried("SELECT 1", { a1: "BIGINT" }), "SELECT 1");
});

test("a filter on a dimension (joined first), an aggregate's own filter, two facts, a MATERIALIZED CTE", () => {
  const joined = `WITH f4 AS (SELECT j5."City" AS "g0", SUM(t2."Amount") FILTER (WHERE t2."Qty" > 1) AS "a0" FROM v_Sales AS t2 LEFT JOIN v_Product AS j3 ON j3."ProductKey" = t2."ProductKey" LEFT JOIN v_Customer AS j5 ON j5."CustomerKey" = t2."CustomerKey" WHERE (((j3."Color" COLLATE NOCASE) IN ('Red', 'a, FROM (b'))) GROUP BY j5."City") SELECT * FROM f4`;
  assert.equal(splitPlan(joined, large).parts[0].table, "Sales");
  const two = `WITH f3 AS MATERIALIZED (SELECT t2."ProductKey" AS "g0", SUM(t2."Amount") AS "a0" FROM v_Sales AS t2 GROUP BY t2."ProductKey"), f6 AS (SELECT t5."ProductKey" AS "g0", SUM(t5."ReturnQty") AS "a0" FROM v_Returns AS t5 GROUP BY t5."ProductKey"), f9 AS (SELECT SUM(f3.a0) AS a0 FROM f3) SELECT 1 FROM f3, f6, f9`;
  const plan = splitPlan(two, large);
  assert.deepEqual(plan.parts.map(p => [p.cte, p.table]), [["f3", "Sales"], ["f6", "Returns"]]);
  assert.match(plan.finalSql(c => [c]), /^WITH f3 AS MATERIALIZED \(SELECT "g0" AS "g0", SUM\("a0"\) AS "a0" FROM read_parquet\(\['f3'\]\) GROUP BY ALL\), f6 AS \(SELECT .* FROM read_parquet\(\['f6'\]\) GROUP BY ALL\), f9 AS /);
});

test("below the joins, a minimum of minimums and a maximum of maximums add up beside sums of sums", () => {
  const body = `SELECT j4."Color" AS "g0", SUM(p8."a0") AS "a0", MIN(p8."a1") AS "a1", MAX(p8."a2") AS "a2" FROM (SELECT t2."ProductKey" AS "c0", SUM(t2."Amount") AS "a0", MIN(t2."OrderDate") AS "a1", MAX(t2."Qty") AS "a2" FROM v_Sales AS t2 GROUP BY t2."ProductKey") AS p8 LEFT JOIN v_Product AS j4 ON j4."ProductKey" = p8."c0" GROUP BY j4."Color"`;
  const plan = splitPlan(`WITH f3 AS (${body}) SELECT * FROM f3`, large);
  assert.equal(plan.parts[0].table, "Sales");
  assert.match(plan.finalSql(c => [c]), /SELECT "g0" AS "g0", SUM\("a0"\) AS "a0", MIN\("a1"\) AS "a1", MAX\("a2"\) AS "a2" FROM read_parquet\(\['f3'\]\) GROUP BY ALL/);
});

test("what does not add up is left as it is", () => {
  const no = body => assert.equal(splitPlan(`WITH f3 AS (${body}) SELECT * FROM f3`, large), null, body);
  // A distinct count, an average, a ratio in the body.
  no(`SELECT (COUNT(DISTINCT t2."CustomerKey") + MAX(CASE WHEN t2."CustomerKey" IS NULL THEN 1 ELSE 0 END)) AS "a0" FROM v_Sales AS t2`);
  no(`SELECT AVG(t2."Qty") AS "a0" FROM v_Sales AS t2`);
  no(`SELECT SUM(t2."Amount") / SUM(t2."Qty") AS "a0" FROM v_Sales AS t2`);
  // A minimum of sums, a sum of minimums, a maximum of minimums, below the joins.
  no(`SELECT j4."City" AS "g0", MIN(p6."a0") AS "a0" FROM (SELECT t2."CustomerKey" AS "c0", SUM(t2."Amount") AS "a0" FROM v_Sales AS t2 GROUP BY t2."CustomerKey") AS p6 LEFT JOIN v_Customer AS j4 ON j4."CustomerKey" = p6."c0" GROUP BY j4."City"`);
  no(`SELECT j4."City" AS "g0", SUM(p6."a0") AS "a0" FROM (SELECT t2."CustomerKey" AS "c0", MIN(t2."Qty") AS "a0" FROM v_Sales AS t2 GROUP BY t2."CustomerKey") AS p6 LEFT JOIN v_Customer AS j4 ON j4."CustomerKey" = p6."c0" GROUP BY j4."City"`);
  no(`SELECT j4."City" AS "g0", MAX(p6."a0") AS "a0" FROM (SELECT t2."CustomerKey" AS "c0", MIN(t2."Qty") AS "a0" FROM v_Sales AS t2 GROUP BY t2."CustomerKey") AS p6 LEFT JOIN v_Customer AS j4 ON j4."CustomerKey" = p6."c0" GROUP BY j4."City"`);
  // The table on a join's other side, or in a filter.
  no(`SELECT j."City" AS "g0", SUM(t."Amount") AS "a0" FROM v_Customer AS j LEFT JOIN v_Sales AS t ON t."CustomerKey" = j."CustomerKey" GROUP BY j."City"`);
  no(`SELECT SUM(j."Price") AS "a0" FROM v_Product AS j WHERE j."ProductKey" IN (SELECT t."ProductKey" FROM v_Sales AS t)`);
  // No large table, no CTE, and a table the statement reads outside its CTE too.
  no(`SELECT SUM(j."Price") AS "a0" FROM v_Product AS j`);
  assert.equal(splitPlan(`SELECT SUM(t."Amount") FROM v_Sales AS t`, large), null);
  assert.equal(splitPlan(`WITH f3 AS (SELECT SUM(t2."Amount") AS "a0" FROM v_Sales AS t2) SELECT f3.a0, (SELECT COUNT(*) FROM v_Sales AS o) FROM f3`, large), null);
});
