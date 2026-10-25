// Tests for site/analyze/: the .bim as the view reads it (model.js tmslOf), Explore's
// shelves as a query (explore.js), and the query as DAX (query.js) — for a .bim whose names
// are not single words, which is most of Power BI's.

import { test } from "node:test";
import assert from "node:assert/strict";

import { tmslOf } from "../site/analyze/model.js";
import { modelFields, buildQuery } from "../site/analyze/explore.js";
import { createModelQuery } from "../site/analyze/query.js";

const BIM = {
  model: {
    tables: [
      { name: "Internet Sales",
        columns: [{ name: "RowNumber-2662979B", type: "rowNumber", dataType: "int64" },
                  { name: "ProductKey", dataType: "int64" }, { name: "Sales Amount", dataType: "decimal" }],
        measures: [{ name: "Total [Sales]", expression: "SUM('Internet Sales'[Sales Amount])" }] },
      { name: "Product.Dim", columns: [{ name: "ProductKey", dataType: "int64" }, { name: "Product's Color", dataType: "string" },
                                        { name: "Since", dataType: "dateTime" }] },
      { name: "LocalDateTable_0f1e", columns: [{ name: "Date", dataType: "dateTime" }] },
      { name: "Notes" },
    ],
    relationships: [
      { name: "r1", fromTable: "Internet Sales", fromColumn: "ProductKey", toTable: "Product.Dim", toColumn: "ProductKey" },
      { name: "r2", fromTable: "Internet Sales", fromColumn: "ProductKey", toTable: "LocalDateTable_0f1e", toColumn: "Date" },
    ],
  },
};

test("tmslOf: no auto date tables, no row numbers, no relationship to a table it dropped, every list there", () => {
  const m = tmslOf(BIM);
  assert.deepEqual(m.tables.map(t => t.name), ["Internet Sales", "Product.Dim", "Notes"]);
  assert.deepEqual(m.tables[0].columns.map(c => c.name), ["ProductKey", "Sales Amount"]);
  assert.deepEqual(m.relationships.map(r => r.name), ["r1"]);
  assert.deepEqual(m.tables[2].columns, []);
  assert.deepEqual(m.tables[2].measures, []);
  assert.deepEqual(tmslOf({}).tables, []);
});

test("Explore names a field as the model does, dots and all", () => {
  const fields = modelFields(tmslOf(BIM));
  assert.ok(fields.byId.has("Product.Dim.Product's Color"));
  const q = buildQuery({ rows: ["Product.Dim.Product's Color"], cols: [], values: ["Total [Sales]"], filters: [],
    totals: false, sort: "fields" });
  assert.deepEqual(q.select, { "Product's Color": "Product.Dim.Product's Color", "Total [Sales]": "Total [Sales]" });
});

test("toDax quotes tables, escapes ] in names and \" in text", () => {
  const mq = createModelQuery(tmslOf(BIM), null);
  const dax = mq.toDax({
    select: { "Product's Color": "Product.Dim.Product's Color", "Total [Sales]": "Total [Sales]" },
    where: [["Product.Dim.Product's Color", "in", ['Red "dark"', "Blue"]], ["Product.Dim.Since", ">=", "2024-01-01"]],
    orderBy: ["Product's Color"], top: 10,
  });
  assert.match(dax, /'Product\.Dim'\[Product's Color\]/);
  assert.match(dax, /"Total \[Sales\]", \[Total \[Sales]]]/);
  assert.match(dax, /IN \{"Red ""dark""", "Blue"\}/);
  assert.match(dax, /'Product\.Dim'\[Since\] >= dt"2024-01-01"/);
  assert.match(dax, /^EVALUATE TOPN\(10, /);
  assert.throws(() => mq.toDax({ select: { x: "Nope.Column" } }), /no measure|not a column/);
});

test("a dimension's columns alone leave out its blank row", () => {
  const mq = createModelQuery(tmslOf(BIM), null);
  assert.match(mq.toDax({ select: { "Product's Color": "Product.Dim.Product's Color" } }),
    /NOT ISBLANK\('Product\.Dim'\[ProductKey\]\)/);
});
