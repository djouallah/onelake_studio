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

// A pivot tile: Pivot's shelves, as Add to report saves them, run as Pivot's own query.
const { modelFields, pivotQuery, pivotTitle, pivotView } = await import("../../app/explore/explore.js");
const MODEL = { tables: [
  { name: "dim_zone", columns: [{ name: "Borough", dataType: "string" }] },
  { name: "trips", columns: [{ name: "fare", dataType: "double" }], measures: [{ name: "Total Fare" }] },
], relationships: [{ fromTable: "trips", toTable: "dim_zone" }] };
const PIVOT_SQL = 'SELECT "dim_zone"."Borough" AS "Borough", AGG("Total Fare") AS "Total Fare"\nFROM model\nGROUP BY ALL\n' +
                  'ORDER BY "Borough"\nFETCH FIRST 5000 ROWS WITH TIES';

test("a pivot tile runs Pivot's query, and a click on it picks its first Rows field", () => {
  const fields = modelFields(MODEL);
  const { state, sql, field } = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "bar" }, fields);
  assert.deepEqual([state.cols, state.filters, state.totals], [[], [], false], "every shelf there");
  assert.equal(sql, PIVOT_SQL);
  assert.deepEqual(field, { table: "dim_zone", column: "Borough", ref: BOROUGH });
  // No Rows: its first Columns field.
  assert.deepEqual(pivotQuery({ cols: ["dim_zone.Borough"], values: ["Total Fare"] }, fields).field.column, "Borough");
  assert.equal(pivotQuery({ values: ["Total Fare"] }, fields).field, null, "nothing to pick");
  for (const [saved, why] of [[null, /the shelves/], [[], /the shelves/], [{ rows: "dim_zone.Borough" }, /rows is a list/], [{}, /no fields/]]) {
    assert.throws(() => pivotQuery(saved, fields), why, JSON.stringify(saved));
  }
});

test("another tile's pick goes in a pivot tile's query, beside its own filters", () => {
  const fields = modelFields(MODEL);
  const pick = [{ ref: BOROUGH, value: "Bronx", type: "string" }];
  assert.equal(withFilters(pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"] }, fields).sql, pick),
               PIVOT_SQL.replace("FROM model", `FROM model WHERE ${BOROUGH} = 'Bronx'`));
  const own = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"],
                           filters: [{ field: "dim_zone.Borough", op: "notIn", values: ["Queens"] }] }, fields).sql;
  assert.match(withFilters(own, pick), /\nWHERE \(\("dim_zone"\."Borough" NOT IN \('Queens'\) OR "dim_zone"\."Borough" IS NULL\)\) AND "dim_zone"\."Borough" = 'Bronx'\nGROUP BY ALL\n/);
});

test("a pivot tile's title: its values by its rows and columns", () => {
  modelFields(MODEL);
  assert.equal(pivotTitle({ rows: ["dim_zone.Borough"], cols: [], values: ["Total Fare", "\0sum\0trips.fare"] }), "Total Fare, Sum of fare by Borough");
  assert.equal(pivotTitle({ rows: [], cols: [], values: ["Total Fare"] }), "Total Fare");
  assert.equal(pivotTitle({ rows: ["dim_zone.Borough"], cols: [], values: [] }), "Borough");
});

test("a pivot tile's chart: the pick bright, the rest dim, and a click's row key; Pivot's own, as it was", () => {
  const fields = modelFields(MODEL);
  const s = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "bar" }, fields).state;
  const rows = [{ Borough: "Bronx", "Total Fare": 10 }, { Borough: "Queens", "Total Fare": 20 }];
  const look = { fields, palette: ["#111", "#222"], css: () => "" };
  const plain = pivotView(s, rows, "bar", look);
  assert.deepEqual(plain.option.series[0].data, [10, 20]);
  const picked = pivotView(s, rows, "bar", look, { on() {}, active: true, value: "Queens" });
  assert.deepEqual(picked.option.series[0].data, [{ value: 10, itemStyle: { opacity: 0.3 } }, 20]);
  assert.deepEqual(picked.keyAt({ dataIndex: 1 }), ["Queens"]);
  assert.deepEqual(pivotView(s, rows, "bar", look, { on() {}, active: false }).option.series[0].data, [10, 20]);
});

test("a slicer's values go in as IN, a blank among them as IS NULL", () => {
  const sql = 'SELECT AGG("Total Fare") AS "Total Fare" FROM model';
  assert.equal(withFilters(sql, [{ ref: BOROUGH, values: ["Bronx"], type: "string" }]),
               `SELECT AGG("Total Fare") AS "Total Fare" FROM model WHERE ${BOROUGH} IN ('Bronx')`);
  assert.equal(withFilters(sql, [{ ref: BOROUGH, values: ["Bronx", "O'Hare"], type: "string" }]),
               `SELECT AGG("Total Fare") AS "Total Fare" FROM model WHERE ${BOROUGH} IN ('Bronx', 'O''Hare')`);
  assert.equal(withFilters(sql, [{ ref: BOROUGH, values: [null, "Bronx"], type: "string" }]),
               `SELECT AGG("Total Fare") AS "Total Fare" FROM model WHERE (${BOROUGH} IS NULL OR ${BOROUGH} IN ('Bronx'))`);
  assert.equal(withFilters(sql, [{ ref: BOROUGH, values: [null], type: "string" }]),
               `SELECT AGG("Total Fare") AS "Total Fare" FROM model WHERE ${BOROUGH} IS NULL`);
  assert.equal(withFilters(sql, [{ ref: BOROUGH, values: [], type: "string" }]), sql, "nothing ticked: no filter");
  // Typed by the column, beside a click's pick, ANDed to the tile's own WHERE.
  const own = `${sql} WHERE "dim_zone"."Zone" <> 'x' GROUP BY ALL`;
  assert.equal(withFilters(own, [{ ref: '"dim_date"."Date"', values: ["2024-03-01", "2024-03-02"], type: "dateTime" },
                                 { ref: '"dim_date"."Year"', values: [2024], type: "int64" },
                                 { ref: BOROUGH, value: "Bronx", type: "string" }]),
               `${sql} WHERE ("dim_zone"."Zone" <> 'x') AND "dim_date"."Date" IN (DATE '2024-03-01', DATE '2024-03-02') AND ` +
               `"dim_date"."Year" IN (2024) AND ${BOROUGH} = 'Bronx' GROUP BY ALL`);
});

test("a chart of one measure draws no title over its plot; one of several, a title each", () => {
  const fields = modelFields(MODEL);
  const look = { fields, palette: ["#111"], css: () => "" };
  const rows = [{ Borough: "Bronx", "Total Fare": 10, "Sum of fare": 1 }];
  const one = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "line" }, fields).state;
  const plain = pivotView(one, rows, "line", look).option;
  assert.deepEqual(plain.title, [], "the tile's title, or the Values shelf, names it");
  assert.equal(plain.grid.length, 1);
  const two = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare", "\0sum\0trips.fare"], mark: "line" }, fields).state;
  assert.deepEqual(pivotView(two, rows, "line", look).option.title.map(t => t.text), ["Total Fare", "Sum of fare"]);
});

test("a slicer's range: both ends, one end, a date's last day kept whole", () => {
  const sql = 'SELECT AGG("Total Fare") AS "Total Fare" FROM model';
  const date = '"dim_date"."Date"', year = '"dim_date"."Year"';
  assert.equal(withFilters(sql, [{ ref: year, range: [2021, 2023], type: "int64" }]), `${sql} WHERE ${year} >= 2021 AND ${year} <= 2023`);
  assert.equal(withFilters(sql, [{ ref: year, range: [2021, null], type: "int64" }]), `${sql} WHERE ${year} >= 2021`);
  assert.equal(withFilters(sql, [{ ref: date, range: [null, "2023-12-31"], type: "dateTime" }]), `${sql} WHERE ${date} < DATE '2024-01-01'`);
  assert.equal(withFilters(sql, [{ ref: date, range: ["2021-01-01", "2021-01-31"], type: "dateTime" }]),
               `${sql} WHERE ${date} >= DATE '2021-01-01' AND ${date} < DATE '2021-02-01'`);
  assert.equal(withFilters(sql, [{ ref: year, range: [null, null], type: "int64" }]), sql, "no ends: no filter");
});

test("a slicer is a Visual: its query lists the values that have the measure, and it is named for its column", () => {
  const fields = modelFields(MODEL);
  const { state, sql, field } = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "slicer", slicer: "buttons" }, fields);
  assert.equal(sql, PIVOT_SQL);
  assert.deepEqual(field, { table: "dim_zone", column: "Borough", ref: BOROUGH });
  assert.equal(state.slicer, "buttons");
  assert.equal(pivotTitle(state), "Borough");
  assert.equal(pivotQuery({ rows: ["dim_zone.Borough"], mark: "slicer" }, fields).state.slicer, "list", "List unless picked");
});

test("Visual's fields leave out a hidden table, its measures too, and hidden columns and measures", () => {
  const { tables, byId } = modelFields({ tables: [
    ...MODEL.tables.map(t => (t.name === "trips" ? { ...t, columns: [...t.columns, { name: "secret", dataType: "string", isHidden: true }] } : t)),
    { name: "stg_log", isHidden: true, columns: [{ name: "path", dataType: "string" }], measures: [{ name: "Files" }] },
  ], relationships: MODEL.relationships });
  assert.deepEqual(tables.map(t => t.name), ["dim_zone", "trips"]);
  assert.ok(!byId.has("stg_log.path") && !byId.has("Files") && !byId.has("trips.secret"));
  assert.ok(byId.has("trips.fare") && byId.has("Total Fare"));
});

// The Report's grid: 12 columns, rows of 10px.
const { arrange, COLUMNS, MIN_ROWS } = await import("../../app/explore/report.js");
const at = list => list.map(({ x, y, w, h }) => [x, y, w, h]);

test("tiles with no place go in the first place they fit", () => {
  assert.deepEqual(at(arrange([{ w: 3, h: 20 }, { w: 6, h: 30 }, { w: 6, h: 10 }, { w: 12, h: 8 }])),
    [[0, 0, 3, 20], [3, 0, 6, 30], [0, 30, 6, 10], [0, 40, 12, 8]], "six wide fits only under the chart");
  assert.equal(COLUMNS, 12);
  assert.deepEqual(at(arrange([{ w: 40, h: 1 }])), [[0, 0, 12, MIN_ROWS]], "no wider than the grid, no shorter than the least");
});

test("a tile floats up into the room under a short one beside a tall one", () => {
  // A short slicer, a tall chart beside it, and a tile below them both: it rises under the slicer.
  const placed = arrange([{ x: 0, y: 0, w: 3, h: 10 }, { x: 3, y: 0, w: 9, h: 40 }, { x: 0, y: 40, w: 3, h: 10 }]);
  assert.deepEqual(at(placed)[2], [0, 10, 3, 10]);
});

test("a tile put over others pushes them down; the rest float up", () => {
  const tiles = [{ x: 0, y: 0, w: 6, h: 10 }, { x: 6, y: 0, w: 6, h: 10 }, { x: 0, y: 10, w: 12, h: 10 }];
  // The wide one put at the top: the two pushed under it.
  assert.deepEqual(at(arrange(tiles.map((t, i) => (i === 2 ? { ...t, y: 0 } : t)), 2)),
    [[0, 10, 6, 10], [6, 10, 6, 10], [0, 0, 12, 10]]);
  // The first put in the second's place: the second pushed under it, the wide one under them both.
  assert.deepEqual(at(arrange(tiles.map((t, i) => (i === 0 ? { ...t, x: 6 } : t)), 0)),
    [[6, 0, 6, 10], [6, 10, 6, 10], [0, 20, 12, 10]]);
});
