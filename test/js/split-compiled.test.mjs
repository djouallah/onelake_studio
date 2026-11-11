// split.js on what the compiler writes today: a Fabric app's queries, compiled by the pinned dax-sql as the app
// compiles a tile's, each run whole and shared out over three shares of its fact table on DuckDB, the answers and
// their types compared. split.js reads the compiled SQL's text, so a dax-sql that writes its CTEs another way
// would stop it matching without a word: here that fails, as the shapes that are shared out today must still be.
//
// Needs vendor/ (scripts/vendor.mjs) and the engine's binding: run by the Extension workflow's engine job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const { PINS } = require("../../core/vendored.js");
const { DuckDBInstance } = require("@duckdb/node-api");
const load = (...p) => import(pathToFileURL(join(ROOT, ...p)).href);
const [{ createCompiler }, { tmslToModel }, { EXPLORE_CASTS }, { splitPlan, carried }] = await Promise.all([
  load("vendor", "npm", PINS.daxSql, "src", "index.js"), load("vendor", "npm", PINS.daxSql, "formats", "tmsl.js"),
  load("page", "explore", "query.js"), load("fabric_app", "site", "storage", "split.js")]);

// Two fact tables and two dimensions; a sale of a customer and a product the dimensions lack, and NULLs.
const SETUP = `
CREATE TABLE "Product" AS SELECT * FROM (VALUES (1, 'Red', 'Bikes'), (2, 'Black', 'Bikes'), (3, 'Red', 'Clothing'), (4, 'Blue', 'Clothing')) t("ProductKey", "Color", "Category");
CREATE TABLE "Customer" AS SELECT * FROM (VALUES (1, 'Paris'), (2, 'London'), (3, 'Paris'), (4, 'Berlin')) t("CustomerKey", "City");
CREATE TABLE "Sales" AS SELECT (i % 5 + 1)::BIGINT AS "ProductKey", (i % 6 + 1)::BIGINT AS "CustomerKey", (DATE '2024-01-01' + (i % 40)::INT) AS "OrderDate",
  CASE WHEN i % 7 = 0 THEN NULL ELSE (i % 4 + 1)::BIGINT END AS "Qty", ((i * 37) % 1000 / 10.0)::DECIMAL(18,4) AS "Amount" FROM range(600) t(i);
CREATE TABLE "Returns" AS SELECT (i % 4 + 1)::BIGINT AS "ProductKey", (i % 3 + 1)::BIGINT AS "ReturnQty" FROM range(90) t(i);`;
const TABLES = ["Product", "Customer", "Sales", "Returns"], LARGE = new Set(["Sales", "Returns"]), SHARES = 3;
const col = (name, dataType) => ({ name, dataType, sourceColumn: name });
const BIM = {
  compatibilityLevel: 1604,
  model: {
    tables: [
      { name: "Sales", columns: [col("ProductKey", "int64"), col("CustomerKey", "int64"), col("OrderDate", "dateTime"), col("Qty", "int64"), col("Amount", "decimal")],
        measures: [{ name: "Total", expression: "SUM(Sales[Amount])" }, { name: "Quantity", expression: "SUM(Sales[Qty])" },
                   { name: "Orders", expression: "COUNTROWS(Sales)" }, { name: "Customers", expression: "DISTINCTCOUNT(Sales[CustomerKey])" },
                   { name: "Average Qty", expression: "AVERAGE(Sales[Qty])" }, { name: "Red Total", expression: 'CALCULATE([Total], Product[Color] = "Red")' },
                   { name: "Return Rate", expression: "DIVIDE([Returned], [Quantity])" }] },
      { name: "Returns", columns: [col("ProductKey", "int64"), col("ReturnQty", "int64")],
        measures: [{ name: "Returned", expression: "SUM(Returns[ReturnQty])" }] },
      { name: "Product", columns: [{ ...col("ProductKey", "int64"), isKey: true }, col("Color", "string"), col("Category", "string")] },
      { name: "Customer", columns: [{ ...col("CustomerKey", "int64"), isKey: true }, col("City", "string")] },
    ],
    relationships: [
      { name: "sp", fromTable: "Sales", fromColumn: "ProductKey", toTable: "Product", toColumn: "ProductKey" },
      { name: "sc", fromTable: "Sales", fromColumn: "CustomerKey", toTable: "Customer", toColumn: "CustomerKey" },
      { name: "rp", fromTable: "Returns", fromColumn: "ProductKey", toTable: "Product", toColumn: "ProductKey" },
    ],
  },
};

// A tile's query over the model, as Explore writes one (page/explore/explore.js).
const BY = [null, '"Product"."Color"', '"Customer"."City"', '"Sales"."OrderDate"', '"Product"."Category", "Customer"."City"'];
const WHERE = ["", `WHERE "Product"."Color" IN ('Red', 'Blue')`, `WHERE "Sales"."Qty" >= 2`];
const VALUES = { Total: 'AGG("Total")', Quantity: 'AGG("Quantity")', Orders: 'AGG("Orders")', Returned: 'AGG("Returned")', "Return Rate": 'AGG("Return Rate")',
                 "Red Total": 'AGG("Red Total")', Customers: 'AGG("Customers")', "Average Qty": 'AGG("Average Qty")',
                 "least Qty": 'MIN("Sales"."Qty")', "most Amount": 'MAX("Sales"."Amount")', "count of Qty": 'COUNT("Sales"."Qty")',
                 "three at once": 'AGG("Total"), SUM("Sales"."Qty"), MIN("Sales"."OrderDate")' };
// With totals (ROLLUP), each column's flag for its subtotal rows.
const modelSql = (values, by, where, totals) => `SELECT ${by ? `${by}, ` : ""}${values.split(", ").map((v, i) => `${v} AS "m${i}"`).join(", ")}` +
  `${totals ? by.split(", ").map((c, i) => `, GROUPING(${c}) AS "t${i}"`).join("") : ""} FROM model ${where} ${totals ? `GROUP BY ROLLUP(${by})` : "GROUP BY ALL"}`;

test("what the compiler writes is shared out as before, and answers the same shared out as whole", async () => {
  const dir = (await mkdtemp(join(tmpdir(), "split-compiled-"))).split("\\").join("/");
  const db = await DuckDBInstance.create(":memory:");
  const con = await db.connect();
  try {
    await con.run(SETUP);
    for (const t of TABLES) await con.run(`CREATE VIEW v_${t} AS SELECT * FROM "${t}"`);
    const compiler = createCompiler(tmslToModel(BIM), { tableSource: t => `v_${t.name}`, castOutput: EXPLORE_CASTS });
    // The columns' types, then the rows, in an order of their own (a tile's query has one only when it says so).
    const answer = async sql => {
      const r = await con.runAndReadAll(sql);
      return `${r.columnTypes().map(String).join(",")} ${JSON.stringify(r.getRowObjectsJson().map(x => JSON.stringify(x)).sort())}`;
    };
    const splitBy = {};   // the value -> how many of its queries were shared out, of how many
    let n = 0;
    for (const [name, values] of Object.entries(VALUES)) for (const by of BY) for (const where of WHERE) {
      for (const totals of by ? [false, true] : [false]) {
        const text = modelSql(values, by, where, totals);
        const sql = compiler.compileStatement(text).sql;
        const count = splitBy[name] ??= { split: 0, of: 0 };
        count.of++;
        const plan = splitPlan(sql, t => LARGE.has(t));
        if (!plan) continue;
        count.split++;
        const files = {}, types = {};
        for (const part of plan.parts) for (let i = 0; i < SHARES; i++) {
          await con.run(`CREATE OR REPLACE VIEW p_${part.table} AS SELECT * FROM "${part.table}" WHERE rowid % ${SHARES} = ${i}`);
          types[part.cte] = Object.fromEntries((await con.runAndReadAll(`DESCRIBE ${part.partialSql}`)).getRowObjectsJson().map(r => [r.column_name, r.column_type]));
          const file = `${dir}/part_${++n}.parquet`;
          await con.run(`COPY (${carried(part.partialSql, types[part.cte])}) TO '${file}' (FORMAT parquet)`);
          (files[part.cte] ??= []).push(file);
        }
        assert.equal(await answer(plan.finalSql(cte => files[cte], cte => types[cte])), await answer(sql), `${text}\n${sql}`);
      }
    }
    const said = Object.entries(splitBy).map(([k, v]) => `${k} ${v.split}/${v.of}`).join(", ");
    console.log(`shared out: ${said}`);
    // How many of each value's 27 queries are shared out, with dax-sql as pinned. Sums and counts of Sales: all,
    // whatever the grouping and the filter. Returns: not by a column of Sales or of Customer, which it does not
    // reach. A least or a most: not when its CTE is grouped below the joins. A distinct count, an average: never.
    // A number that changes here is dax-sql writing its SQL another way: look at what, then change the number.
    const WAS = { Total: 27, Quantity: 27, Orders: 27, "count of Qty": 27, Returned: 21, "Return Rate": 21, "Red Total": 17,
                  "least Qty": 15, "most Amount": 15, "three at once": 15, Customers: 0, "Average Qty": 0 };
    for (const [name, was] of Object.entries(WAS)) {
      assert.equal(splitBy[name].of, 27, name);
      assert.equal(splitBy[name].split, was, `${name}: ${splitBy[name].split} of its queries are shared out, where ${was} were: ${said}`);
    }
  } finally {
    con.closeSync?.();
    await rm(dir, { recursive: true, force: true });
  }
});
