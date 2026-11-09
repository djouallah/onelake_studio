// app/explore/report.js: cross filtering's SQL. A pick in one tile is a WHERE in every other
// tile's SQL, on the model column the picked tile's first column is.
import { test } from "node:test";
import assert from "node:assert/strict";

const { firstColumn, columnOf, sqlLiteral, withFilters } = await import("../../app/explore/report.js");

const BAR = 'SELECT "dim_zone"."Borough" AS "Borough", AGG("Total Fare") AS "Total Fare" FROM model GROUP BY ALL ' +
            'ORDER BY "Total Fare" DESC FETCH FIRST 12 ROWS WITH TIES';
const BOROUGH = '"dim_zone"."Borough"';

test("a tile's first column, as the model names it", () => {
  assert.deepEqual(firstColumn(BAR), { ref: BOROUGH, table: "dim_zone", column: "Borough" });
  assert.deepEqual(firstColumn('select dim_date.Year, AGG("x") from model group by all'), { ref: "dim_date.Year", table: "dim_date", column: "Year" });
  assert.deepEqual(firstColumn("SELECT 'Product'[Color] AS c FROM model"), { ref: "'Product'[Color]", table: "Product", column: "Color" });
  assert.deepEqual(firstColumn('SELECT "a ""b"".c"."d" FROM model'), { ref: '"a ""b"".c"."d"', table: 'a "b".c', column: "d" });
  assert.deepEqual(firstColumn("\n  -- by region\n  SELECT Region r, AGG(n) FROM model"), { ref: "Region", table: null, column: "Region" });
  // Anything but a column: no clicks.
  for (const sql of ['SELECT AGG("Total") AS "Total" FROM model', "SELECT 'Red' AS \"Color\" FROM model",
                     'SELECT "t"."c" + 1 AS x FROM model', 'SELECT DISTINCT "t"."c" FROM model', "SELECT CASE WHEN 1 THEN 2 END FROM model",
                     "SELECT * FROM model", "", undefined]) {
    assert.equal(firstColumn(sql), null, String(sql));
  }
  assert.deepEqual(columnOf(' "Product"."Color" '), { ref: '"Product"."Color"', table: "Product", column: "Color" });
  assert.equal(columnOf("AGG(x)"), null);
  assert.equal(columnOf("a.b.c"), null);
});

test("a value as its column's literal", () => {
  assert.equal(sqlLiteral("Manhattan", "string"), "'Manhattan'");
  assert.equal(sqlLiteral("O'Brien's", "string"), "'O''Brien''s'");
  assert.equal(sqlLiteral(2024, "int64"), "2024");
  assert.equal(sqlLiteral(-1.5, undefined), "-1.5");
  assert.equal(sqlLiteral(7, "string"), "'7'", "a number in a text column is text");
  assert.equal(sqlLiteral("2024", "int64"), "2024", "a whole number handed over as text");
  assert.equal(sqlLiteral(12345678901234567890n, "int64"), "12345678901234567890");
  assert.equal(sqlLiteral("2024-03-01", "dateTime"), "DATE '2024-03-01'");
  assert.equal(sqlLiteral("2024-03-01T00:00:00.000Z", "dateTime"), "DATE '2024-03-01'");
  assert.equal(sqlLiteral("2024-03-01T08:30:00", "dateTime"), "TIMESTAMP '2024-03-01 08:30:00'");
  assert.equal(sqlLiteral("2024-03-01", "string"), "'2024-03-01'", "a date's text in a text column stays text");
  assert.equal(sqlLiteral(true, "boolean"), "TRUE");
  assert.equal(sqlLiteral("false", "boolean"), "FALSE");
  assert.equal(sqlLiteral("1; DROP", "int64"), "'1; DROP'", "only a number is written bare");
  assert.throws(() => sqlLiteral(NaN), /can't be a filter/);
});

test("a pick goes in as a WHERE, before GROUP BY", () => {
  assert.equal(withFilters(BAR, []), BAR, "no pick, the SQL as written");
  assert.equal(withFilters(BAR, [{ ref: '"dim_date"."Year"', value: 2024, type: "int64" }]),
    'SELECT "dim_zone"."Borough" AS "Borough", AGG("Total Fare") AS "Total Fare" FROM model WHERE "dim_date"."Year" = 2024 GROUP BY ALL ' +
    'ORDER BY "Total Fare" DESC FETCH FIRST 12 ROWS WITH TIES');
  // A figure's tile: nothing after FROM model.
  assert.equal(withFilters('SELECT AGG("Trips") AS "Trips" FROM model', [{ ref: BOROUGH, value: "Manhattan", type: "string" }]),
    `SELECT AGG("Trips") AS "Trips" FROM model WHERE ${BOROUGH} = 'Manhattan'`);
  assert.equal(withFilters('SELECT AGG("Trips") FROM model;\n', [{ ref: BOROUGH, value: "Queens" }]),
    `SELECT AGG("Trips") FROM model WHERE ${BOROUGH} = 'Queens';\n`);
  assert.equal(withFilters('SELECT AGG("Trips") FROM model -- all trips', [{ ref: BOROUGH, value: "Queens" }]),
    `SELECT AGG("Trips") FROM model WHERE ${BOROUGH} = 'Queens' -- all trips`, "before a comment, not in it");
  assert.equal(withFilters('SELECT d.y, AGG("n") FROM model\nGROUP BY ALL\nORDER BY 1', [{ ref: "d.m", value: 3 }]),
    'SELECT d.y, AGG("n") FROM model WHERE d.m = 3\nGROUP BY ALL\nORDER BY 1');
});

test("a pick ANDs to the WHERE a tile has", () => {
  const sql = `SELECT "dim_zone"."Zone" AS "Zone", AGG("Trips") AS "Trips" FROM model WHERE "dim_zone"."Borough" = 'Queens' OR "x"."y" BETWEEN 1 AND 2 ` +
              'GROUP BY ALL ORDER BY "Trips" DESC LIMIT 10';
  assert.equal(withFilters(sql, [{ ref: '"dim_date"."Year"', value: 2024, type: "int64" }, { ref: '"pay"."Type"', value: "Card" }]),
    `SELECT "dim_zone"."Zone" AS "Zone", AGG("Trips") AS "Trips" FROM model WHERE ("dim_zone"."Borough" = 'Queens' OR "x"."y" BETWEEN 1 AND 2) ` +
    `AND "dim_date"."Year" = 2024 AND "pay"."Type" = 'Card' GROUP BY ALL ORDER BY "Trips" DESC LIMIT 10`);
  // A WHERE at the end, with words in strings and parentheses that are not clauses.
  assert.equal(withFilters("SELECT a.b FROM model WHERE a.c IN ('GROUP BY', 'x') AND (a.d > 1)", [{ ref: "a.b", value: "it's" }]),
    "SELECT a.b FROM model WHERE (a.c IN ('GROUP BY', 'x') AND (a.d > 1)) AND a.b = 'it''s'");
});

test("a blank is IS NULL, and a FROM in parentheses is not the tile's", () => {
  assert.equal(withFilters('SELECT AGG("Trips") FROM model ORDER BY 1', [{ ref: BOROUGH, value: null }]),
    `SELECT AGG("Trips") FROM model WHERE ${BOROUGH} IS NULL ORDER BY 1`);
  assert.equal(withFilters("SELECT EXTRACT(year FROM d.day) AS y FROM model GROUP BY ALL", [{ ref: BOROUGH, value: undefined }]),
    `SELECT EXTRACT(year FROM d.day) AS y FROM model WHERE ${BOROUGH} IS NULL GROUP BY ALL`);
  assert.equal(withFilters('SELECT "FROM" FROM model', [{ ref: '"t"."FROM"', value: 1 }]), 'SELECT "FROM" FROM model WHERE "t"."FROM" = 1');
  assert.throws(() => withFilters("SELECT 1", [{ ref: BOROUGH, value: "x" }]), /no FROM/);
});
