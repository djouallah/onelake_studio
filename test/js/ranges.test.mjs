// ranges.js: which bytes of a large table's Parquet files the Fabric app downloads for a query,
// on the store's blocks, without what the store holds.
import { test } from "node:test";
import assert from "node:assert/strict";

const { BLOCK, GAP, TAIL, merge, columnsIn, readsAll, columnRanges, tailOf, piecesOf } =
  await import("../../fabric_app/site/storage/ranges.js");

const MB = 1024 * 1024;

test("a query's columns are the words and quoted names in its compiled SQL that are the table's", () => {
  // As dax-sql compiles a Report tile: the source written in front, as a comment.
  const sql = `/*semantic\nSELECT dim_date.year, AGG("Total Amount") FROM model\n*/
WITH f3 AS (SELECT j4."year" AS "g0", SUM(p6."a0") AS "a0" FROM (SELECT t2."pickup_date" AS "c0", SUM(t2."total_amount") AS "a0"
FROM v_fct_trips AS t2 GROUP BY t2."pickup_date") AS p6 LEFT JOIN v_dim_date AS j4 ON j4."date" = p6."c0" GROUP BY j4."year")
SELECT * FROM f3`;
  const fact = ["VendorID", "tpep_pickup_datetime", "total_amount", "pickup_date", "file", "PULocationID"];
  assert.deepEqual(columnsIn(sql, fact), ["total_amount", "pickup_date"]);
  assert.deepEqual(columnsIn(sql, ["year", "date", "month"]), ["year", "date"]);
  // Case does not matter, and a quoted name may hold a space or a doubled quote.
  assert.deepEqual(columnsIn(`SELECT t."Total ""Net"" Amount", T.VENDORID FROM v_x AS t`, ['Total "Net" Amount', "VendorID", "x"]),
    ['Total "Net" Amount', "VendorID"]);
  // COUNT(*) reads no column.
  assert.deepEqual(columnsIn(`SELECT COUNT(*) FROM v_fct_trips AS t1`, fact), []);
});

test("SELECT * from a table's view, or its .*, reads all its columns; a subquery's * does not", () => {
  assert.ok(readsAll("SELECT * FROM v_fct_trips", "fct_trips"));
  assert.ok(readsAll('select distinct * from "v_fct_trips" where 1', "fct_trips"));
  assert.ok(readsAll("SELECT v_fct_trips.*, 1 FROM v_fct_trips", "fct_trips"));
  assert.ok(!readsAll("SELECT * FROM (SELECT t.a FROM v_fct_trips AS t) AS q", "fct_trips"));
  assert.ok(!readsAll("SELECT * FROM v_fct_trips_daily", "fct_trips"));
});

test("ranges merge when they overlap, touch, or are within the gap", () => {
  assert.deepEqual(merge([[10, 19], [0, 9], [30, 39]]), [[0, 19], [30, 39]]);
  assert.deepEqual(merge([[0, 9], [30, 39]], 20), [[0, 39]]);
  assert.deepEqual(merge([[0, 9], [31, 39]], 20), [[0, 9], [31, 39]]);
  assert.deepEqual(merge([[0, 100], [10, 20]]), [[0, 100]]);
});

test("a file's chunks for the wanted columns, near ones read together with the bytes between", () => {
  const chunks = [
    { col: "VendorID", from: 4, to: 999 },
    { col: "total_amount", from: 1000, to: 1000 + 6 * MB },
    { col: "payment_type", from: 1001 + 6 * MB, to: 2 * MB + 1000 + 6 * MB },
    { col: "pickup_date", from: 1001 + 8 * MB, to: 1000 + 8 * MB + 4096 },
    // The next row group, far past the gap.
    { col: "total_amount", from: 100 * MB, to: 106 * MB },
  ];
  assert.deepEqual(columnRanges(chunks, new Set(["total_amount", "pickup_date"])),
    [[1000, 1000 + 8 * MB + 4096], [100 * MB, 106 * MB]]);
  assert.deepEqual(columnRanges(chunks, new Set(["vendorid"])), [[4, 999]]);
  assert.ok(GAP >= 1 * MB, "at least the gap DuckDB itself reads across");
});

test("pieces are on the store's blocks, merged, and leave out the blocks held", () => {
  const size = 10 * BLOCK + 100;   // the last block is short
  // One range inside a block is that block.
  assert.deepEqual(piecesOf("f", size, [[BLOCK + 5, BLOCK + 10]]), [{ path: "f", size, from: BLOCK, to: 2 * BLOCK - 1 }]);
  // Two ranges in neighbouring blocks are one piece.
  assert.deepEqual(piecesOf("f", size, [[10, 20], [BLOCK + 1, BLOCK + 2]]), [{ path: "f", size, from: 0, to: 2 * BLOCK - 1 }]);
  // The last block ends where the file does.
  assert.deepEqual(piecesOf("f", size, [tailOf(size)]), [{ path: "f", size, from: Math.floor((size - TAIL) / BLOCK) * BLOCK, to: size - 1 }]);
  // Held blocks 2-3 and 6 split blocks 1-7 into what is left.
  assert.deepEqual(piecesOf("f", size, [[BLOCK, 8 * BLOCK - 1]], [[2, 3], [6, 6]]), [
    { path: "f", size, from: BLOCK, to: 2 * BLOCK - 1 },
    { path: "f", size, from: 4 * BLOCK, to: 6 * BLOCK - 1 },
    { path: "f", size, from: 7 * BLOCK, to: 8 * BLOCK - 1 },
  ]);
  // All held: nothing to download.
  assert.deepEqual(piecesOf("f", size, [[0, size - 1]], [[0, 10]]), []);
  // A file smaller than the tail is read whole.
  assert.deepEqual(piecesOf("f", 500, [tailOf(500)]), [{ path: "f", size: 500, from: 0, to: 499 }]);
});
