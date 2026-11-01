// The panel's own app/paths.js — a separate copy from the website's, tested here.
import { test } from "node:test";
import assert from "node:assert/strict";

test("a never-written table gets an empty view typed from its Iceberg schema", async () => {
  const { emptyTableSql, icebergToDuckType } = await import("../../app/paths.js");
  assert.equal(icebergToDuckType("long"), "BIGINT");
  assert.equal(icebergToDuckType("decimal(10, 2)"), "DECIMAL(10,2)");
  assert.equal(icebergToDuckType("struct<a, b>"), "VARCHAR");
  assert.equal(emptyTableSql([{ name: "id", type: "long" }, { name: 'a"b', type: "string" }]),
    `SELECT CAST(NULL AS BIGINT) AS "id", CAST(NULL AS VARCHAR) AS "a""b" WHERE false`);
});

test("a result past the cap says so: the host sends a count for the rows it stopped sending", async () => {
  const { rowCollector } = await import("../../app/paths.js");
  const fields = [{ name: "a", type: "BIGINT" }];
  const cut = rowCollector(2);
  cut.add({ fields, rows: [{ a: 1 }, { a: 2 }], numRows: 2 });
  cut.add({ fields, rows: [], numRows: 5 });
  assert.deepEqual(cut.result(), { fields: ["a"], types: ["BIGINT"], rows: [{ a: 1 }, { a: 2 }], numRows: 7, truncated: true, limit: 2 });

  const exact = rowCollector(2);
  exact.add({ fields, rows: [{ a: 1 }, { a: 2 }], numRows: 2 });
  assert.equal(exact.result().truncated, false, "exactly the cap is every row");

  const over = rowCollector(1);
  over.add({ fields, rows: [{ a: 1 }, { a: 2 }], numRows: 2 });
  assert.equal(over.result().rows.length, 1);
  assert.equal(over.result().truncated, true, "rows past the page's own cap are not kept");

  assert.deepEqual(rowCollector(2).result(), { fields: [], types: [], rows: [], numRows: 0, truncated: false, limit: 2 });
});

test("an answer says how old its tables are, once that is worth saying", async () => {
  const { ageNote } = await import("../../app/paths.js");
  const HOUR = 3_600_000, now = 100 * 24 * HOUR;
  assert.equal(ageNote(null, now), "", "no table read");
  assert.equal(ageNote(now - HOUR / 2, now), "", "within the hour");
  assert.equal(ageNote(now - HOUR, now), "tables as of 1 hour ago");
  assert.equal(ageNote(now - 14 * HOUR, now), "tables as of 14 hours ago");
  assert.equal(ageNote(now - 47 * HOUR, now), "tables as of 47 hours ago");
  assert.equal(ageNote(now - 72 * HOUR, now), "tables as of 3 days ago");
});

test("CSV quotes a cell holding a quote, a comma, or either line break", async () => {
  const { toCsv } = await import("../../app/paths.js");
  const rows = [{ a: 'x"y', b: "1,2" }, { a: "cr\rhere", b: "lf\nhere" }, { a: null, b: 3 }];
  assert.equal(toCsv(["a", "b"], rows),
    'a,b\r\n"x""y","1,2"\r\n"cr\rhere","lf\nhere"\r\n,3');
  assert.equal(toCsv(["a"], [{ a: 1 }], { eol: "\n" }), "a\n1");
});
