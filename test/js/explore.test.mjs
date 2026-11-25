// page/explore/explore.js, format.js and draw.js: Pivot's queries, generated from its shelves, and how
// its rows are drawn.
import { test } from "node:test";
import assert from "node:assert/strict";

const { modelFields, buildQuery, modelSql, pivotView, autoMark } = await import("../../page/explore/explore.js");
const BOROUGH = '"dim_zone"."Borough"';
const MODEL = { tables: [
  { name: "dim_zone", columns: [{ name: "Borough", dataType: "string" }, { name: "Zone", dataType: "string" },
                                { name: "Lat", dataType: "double" }, { name: "Lon", dataType: "double" }] },
  { name: "dim_date", columns: [{ name: "Date", dataType: "dateTime" }, { name: "Year", dataType: "int64" }] },
  { name: "trips", columns: [{ name: "fare", dataType: "double" }], measures: [{ name: "Total Fare" }] },
], relationships: [{ fromTable: "trips", toTable: "dim_zone" }, { fromTable: "trips", toTable: "dim_date" }] };
const PIVOT_SQL = 'SELECT "dim_zone"."Borough" AS "Borough", AGG("Total Fare") AS "Total Fare"\nFROM model\nGROUP BY ALL\n' +
                  'ORDER BY "Borough"\nFETCH FIRST 1000 ROWS WITH TIES';

// Shelves as a new Pivot has them, with `s` over them; and their query, as Pivot runs it (explore.js sqlOf).
const shelves = s => ({ v: 2, rows: [], cols: [], values: [], filters: [], mark: "auto", totals: false, sort: "fields", top: 1000, ...s });
const columnOf = fields => id => {
  const f = fields.byId.get(id);
  return f && f.kind === "column" ? { table: f.table, name: f.name, type: f.type } : null;
};
const sqlOf = (s, fields, name = "model") => modelSql(buildQuery(shelves(s)), columnOf(fields), name);

test("Pivot's query: its shelves as one SELECT over the model, named as SQL calls it", () => {
  const fields = modelFields(MODEL);
  assert.equal(sqlOf({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "bar" }, fields), PIVOT_SQL);
  assert.equal(sqlOf({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "bar" }, fields, "ws.taxi_semanticmodel"),
    PIVOT_SQL.replace("FROM model", "FROM ws.taxi_semanticmodel"));
  assert.match(sqlOf({ rows: ["dim_zone.Borough"], values: ["Total Fare"],
                       filters: [{ field: "dim_zone.Borough", op: "notIn", values: ["Queens"] }] }, fields),
    /\nWHERE \("dim_zone"\."Borough" NOT IN \('Queens'\) OR "dim_zone"\."Borough" IS NULL\)\nGROUP BY ALL\n/);
  assert.equal(buildQuery(shelves({})), null, "nothing on the shelves: no query");
});

test("a chart of one measure draws no title over its plot; one of several, a title each", () => {
  const fields = modelFields(MODEL);
  const look = { fields, palette: ["#111"], css: () => "" };
  const rows = [{ Borough: "Bronx", "Total Fare": 10, "Sum of fare": 1 }];
  const plain = pivotView(shelves({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "line" }), rows, "line", look).option;
  assert.deepEqual(plain.title, [], "the Values shelf names it");
  assert.equal(plain.grid.length, 1);
  const two = shelves({ rows: ["dim_zone.Borough"], values: ["Total Fare", "\0sum\0trips.fare"], mark: "line" });
  assert.deepEqual(pivotView(two, rows, "line", look).option.title.map(t => t.text), ["Total Fare", "Sum of fare"]);
});

test("a chart's bars are a value each, in its rows' order", () => {
  const fields = modelFields(MODEL);
  const rows = [{ Borough: "Bronx", "Total Fare": 10 }, { Borough: "Queens", "Total Fare": 20 }];
  const look = { fields, palette: ["#111", "#222"], css: () => "" };
  assert.deepEqual(pivotView(shelves({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "bar" }), rows, "bar", look).option.series[0].data, [10, 20]);
});

test("a card is its Values over every row its filters keep; a field on Rows is its trend, under its total", () => {
  const fields = modelFields(MODEL);
  assert.equal(sqlOf({ values: ["Total Fare"], mark: "card", filters: [{ field: "dim_zone.Borough", op: "in", values: ["Bronx"] }] }, fields),
    `SELECT AGG("Total Fare") AS "Total Fare"\nFROM model\nWHERE ${BOROUGH} IN ('Bronx')`);
  // Rows: the trend, and its total the figure; Columns left out.
  const trend = sqlOf({ rows: ["dim_date.Date"], cols: ["dim_zone.Borough"], values: ["Total Fare"], mark: "card" }, fields);
  assert.match(trend, /^SELECT "dim_date"\."Date" AS "Date", AGG\("Total Fare"\) AS "Total Fare", GROUPING\("dim_date"\."Date"\) AS "__rows_total"\nFROM model\nGROUP BY ROLLUP\("dim_date"\."Date"\)\nORDER BY "Date"/);
  assert.throws(() => buildQuery(shelves({ rows: ["dim_zone.Borough"], mark: "card" })), /Values/);
});

test("Top N keeps the first rows as they are sorted, ties kept; a filter on a measure is a HAVING", () => {
  const fields = modelFields(MODEL);
  assert.equal(sqlOf({ rows: ["dim_zone.Borough"], values: ["Total Fare"], sort: "desc", top: 15 }, fields),
    'SELECT "dim_zone"."Borough" AS "Borough", AGG("Total Fare") AS "Total Fare"\nFROM model\nGROUP BY ALL\n' +
    'ORDER BY "Total Fare" DESC, "Borough"\nFETCH FIRST 15 ROWS WITH TIES');
  assert.equal(sqlOf({ rows: ["dim_zone.Borough"], values: ["Total Fare"],
                       filters: [{ field: "Total Fare", op: "range", min: 0.5, measure: true }] }, fields),
    'SELECT "dim_zone"."Borough" AS "Borough", AGG("Total Fare") AS "Total Fare"\nFROM model\nGROUP BY ALL\n' +
    'HAVING "Total Fare" >= 0.5\nORDER BY "Borough"\nFETCH FIRST 1000 ROWS WITH TIES', "by its name in the SELECT");
  assert.match(sqlOf({ rows: ["dim_zone.Borough"], values: ["\0sum\0trips.fare"],
                       filters: [{ field: "Total Fare", op: "range", min: 1, max: 9, measure: true }] }, fields),
    /\nHAVING AGG\("Total Fare"\) >= 1\n  AND AGG\("Total Fare"\) <= 9\n/, "a measure not shown, as itself");
});

test("measures in one plot: each drawn as it says, on its axis; the total as a line; the highest labelled", () => {
  const fields = modelFields(MODEL);
  const s = shelves({ rows: ["dim_zone.Borough"], values: ["Total Fare", "\0sum\0trips.fare"], mark: "bar", totals: true });
  const rows = [{ Borough: "Bronx", "Total Fare": 10, "Sum of fare": 1, __rows_total: 0 },
                { Borough: "Queens", "Total Fare": 20, "Sum of fare": 2, __rows_total: 0 },
                { Borough: null, "Total Fare": 30, "Sum of fare": 3, __rows_total: 1 }];
  const look = { fields, palette: ["#111", "#222"], css: () => "#999",
                 measures: { "Sum of fare": { as: "dashed", axis: "right" } }, totalLine: true, maxLabel: true };
  const o = pivotView(s, rows, "bar", look).option;
  assert.equal(o.grid.length, 1, "one plot");
  assert.deepEqual(o.yAxis.map(a => a.position), [undefined, "right"]);
  assert.deepEqual(o.series.map(x => [x.name, x.type, x.yAxisIndex, x.lineStyle?.type]),
    [["Total Fare", "bar", 0, undefined], ["Sum of fare", "line", 1, "dashed"]]);
  assert.deepEqual(o.series[0].data, [10, 20], "the total row is no bar");
  assert.equal(o.series[0].markLine.data[0].yAxis, 30, "the total, a line across");
  assert.deepEqual(o.series[0].markPoint.data, [{ type: "max" }]);
  // Without it, one plot each, as before.
  assert.equal(pivotView(s, rows, "bar", { fields, palette: ["#111"], css: () => "" }).option.grid.length, 2);
});

test("a treemap's boxes are the first Rows field's values, coloured from the palette", () => {
  const fields = modelFields(MODEL);
  const rows = [{ Borough: "Bronx", "Total Fare": 10 }, { Borough: "Queens", "Total Fare": 20 }];
  const tree = pivotView(shelves({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "treemap" }), rows, "treemap",
    { fields, palette: ["#111", "#222"], css: () => "#999" }).option.series[0];
  assert.equal(tree.type, "treemap");
  assert.deepEqual(tree.data.map(d => [d.name, d.value, d.itemStyle.color]), [["Bronx", 10, "#111"], ["Queens", 20, "#222"]]);
});

test("a calendar: a strip a year, newest first, each day its figure; a map's points over the world", () => {
  const fields = modelFields(MODEL);
  const s = shelves({ rows: ["dim_date.Date"], values: ["Total Fare"], mark: "calendar" });
  const rows = [{ Date: "2024-12-31", "Total Fare": 5 }, { Date: "2025-01-01", "Total Fare": 7 }];
  const cal = pivotView(s, rows, "calendar", { fields, palette: ["#111"], css: () => "#999" }).option;
  assert.deepEqual(cal.calendar.map(c => c.range), ["2025", "2024"]);
  assert.deepEqual(cal.series.map(x => x.data), [[["2025-01-01", 7]], [["2024-12-31", 5]]]);
  const m = shelves({ rows: ["dim_zone.Lat", "dim_zone.Lon", "dim_zone.Zone"], values: ["Total Fare"], mark: "map" });
  const map = pivotView(m, [{ Lat: -33.9, Lon: 151.2, Zone: "Sydney", "Total Fare": 4 }, { Lat: -37.8, Lon: 145, Zone: "Melbourne", "Total Fare": 1 }],
    "map", { fields, palette: ["#111"], css: () => "#999" }).option;
  assert.equal(map.geo.map, "world");
  assert.deepEqual(map.series[0].data.map(d => [d.name, d.value]), [["Sydney", [151.2, -33.9, 4]], ["Melbourne", [145, -37.8, 1]]]);
});

test("Automatic: a card for Values alone, a table for no Values", () => {
  const fields = modelFields(MODEL);
  assert.equal(autoMark({ rows: [], cols: [], values: ["Total Fare"] }, fields), "card");
  assert.equal(autoMark({ rows: ["dim_zone.Borough"], cols: [], values: [] }, fields), "table");
  assert.equal(autoMark({ rows: ["dim_zone.Borough"], cols: [], values: ["Total Fare"] }, fields), "bar");
});

test("Pivot's fields leave out a hidden table, its measures too, and hidden columns and measures", () => {
  const { tables, byId } = modelFields({ tables: [
    ...MODEL.tables.map(t => (t.name === "trips" ? { ...t, columns: [...t.columns, { name: "secret", dataType: "string", isHidden: true }] } : t)),
    { name: "stg_log", isHidden: true, columns: [{ name: "path", dataType: "string" }], measures: [{ name: "Files" }] },
  ], relationships: MODEL.relationships });
  assert.deepEqual(tables.map(t => t.name), ["dim_date", "dim_zone", "trips"]);
  assert.ok(!byId.has("stg_log.path") && !byId.has("Files") && !byId.has("trips.secret"));
  assert.ok(byId.has("trips.fare") && byId.has("Total Fare"));
});

const { formatChart, numberFormat } = await import("../../page/explore/format.js");
const { formatValue, byValueBackground } = await import("../../page/explore/draw.js");

test("a number style is a format string, and percent and K/M/B are written", () => {
  assert.equal(numberFormat("auto"), null);
  assert.equal(numberFormat("nope"), null);
  assert.equal(formatValue(1234567, numberFormat("int")), "1,234,567");
  assert.equal(formatValue(1234.5, numberFormat("dec2")), "1,234.50");
  assert.equal(formatValue(1234.5, numberFormat("short")), "1.2K");
  assert.equal(formatValue(-2500000, numberFormat("short")), "-2.5M");
  assert.equal(formatValue(3.2e9, numberFormat("short")), "3.2B");
  assert.equal(formatValue(12, numberFormat("short")), "12.0");
  assert.equal(formatValue(0.123, numberFormat("pct")), "12%");
  assert.equal(formatValue(0.1234, "0.0%"), "12.3%", "a model's own percent format");
  assert.equal(formatValue(1234, numberFormat("usd")), "$1,234");
});

test("a table's cell coloured by its value: a tint, or a bar as long as its share of the largest", () => {
  assert.equal(byValueBackground("bar", 50, [0, 100], "#123456"),
    "linear-gradient(90deg, color-mix(in srgb, #123456 38%, transparent) 50%, transparent 50%)");
  assert.equal(byValueBackground("bar", 0, [0, 100], "#123456"), "");
  assert.match(byValueBackground("background", 100, [0, 100], "#123456"), /color-mix\(in srgb, #123456 60%, transparent\)/);
  assert.equal(byValueBackground("background", "x", [0, 100], "#123456"), "", "only a number");
});

test("a chart's format over its option: colours by series, legend, axis titles and range", () => {
  const option = { legend: undefined, grid: { left: 8, right: 16, top: 12, bottom: 8, containLabel: true },
    xAxis: { type: "category", data: ["a", "b"] }, yAxis: { type: "value" },
    series: [{ name: "Revenue", type: "bar", data: [1, 2] }, { name: "Cost", type: "line", data: [1, 1] }] };
  assert.deepEqual(formatChart(option, {}), { ...option, series: option.series }, "no format, the same chart");
  const out = formatChart(option, { colors: { Cost: "#ff0000" }, legend: "bottom", xTitle: "Region", yTitle: "AUD", yMin: 0, yMax: 10 });
  assert.equal(out.series[1].itemStyle.color, "#ff0000");
  assert.equal(out.series[1].lineStyle.color, "#ff0000", "a line's line too");
  assert.equal(out.series[0].itemStyle, undefined, "a series with no colour of its own keeps the palette's");
  assert.deepEqual([out.legend.show, out.legend.bottom], [true, 0]);
  assert.equal(out.grid.bottom, 8 + 22 + 26, "room for the axis title and the legend under the plot");
  assert.deepEqual([out.xAxis.name, out.xAxis.nameLocation], ["Region", "middle"]);
  assert.deepEqual([out.yAxis.name, out.yAxis.min, out.yAxis.max], ["AUD", 0, 10]);
  assert.equal(option.series[1].itemStyle, undefined, "the option given is not changed");
  assert.equal(formatChart({ ...option, legend: { top: 0 } }, { legend: "off" }).legend.show, false);
  // Several plots: arrays stay arrays; the title goes under the last category axis that has labels.
  const multi = formatChart({ grid: [{ top: "9%" }, { top: "59%" }],
    xAxis: [{ type: "category", axisLabel: { show: false } }, { type: "category", axisLabel: { show: true } }],
    yAxis: [{ type: "value" }, { type: "value" }], series: [] }, { xTitle: "Day", yMin: 5 });
  assert.deepEqual(multi.xAxis.map(a => a.name), [undefined, "Day"]);
  assert.deepEqual(multi.yAxis.map(a => a.min), [5, 5]);
});

test("a zoom slider under a chart's plot, on its category axis", () => {
  const out = formatChart({ grid: { left: 4, right: 16, top: 12, bottom: 8 }, xAxis: { type: "category" }, yAxis: { type: "value" }, series: [] }, { zoom: true });
  assert.deepEqual(out.dataZoom.map(z => [z.type, z.xAxisIndex]), [["inside", [0]], ["slider", [0]]]);
  assert.equal(out.grid.bottom, 38);
});

test("Pivot's total line asks its query for the totals", () => {
  const fields = modelFields(MODEL);
  const sql = sqlOf({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "bar", format: { totalLine: true } }, fields);
  assert.match(sql, /GROUPING\("dim_zone"\."Borough"\) AS "__rows_total"[\s\S]*GROUP BY ROLLUP\("dim_zone"\."Borough"\)/);
});

const { modelPlaces, modelEdges } = await import("../../page/explore/draw.js");

test("the model's lines are drawn from wherever its cards are", () => {
  const tables = [{ name: "sales", lines: 2 }, { name: "date", lines: 2 }];
  const rels = [{ fromTable: "sales", fromColumn: "d", toTable: "date", toColumn: "d" }];
  const boxes = modelPlaces(tables, rels);
  const [star] = modelEdges(boxes, rels);
  assert.equal(star.many.anchor, "start", "the fact is left of the dimension: its line leaves its right side");
  // The fact dragged past the dimension, to its right: the line leaves its left side now.
  const moved = { ...boxes, sales: { ...boxes.sales, x: boxes.date.x + 400, y: 300 } };
  const [after] = modelEdges(moved, rels);
  assert.equal(after.many.anchor, "end");
  assert.equal(after.one.anchor, "start");
  assert.notEqual(after.d, star.d);
  // One above the other: both lines leave the left side.
  const over = { ...boxes, sales: { ...boxes.sales, x: boxes.date.x + 20, y: 400 } };
  const [stacked] = modelEdges(over, rels);
  assert.equal(stacked.many.anchor, "end");
  assert.equal(stacked.one.anchor, "end");
});

test("a table in no relationship (a table of measures) goes under the facts, not first", () => {
  const tables = [{ name: "Metrics", lines: 1 }, { name: "sales", lines: 3 }, { name: "budget", lines: 3 },
    { name: "date", lines: 2 }, { name: "store", lines: 2 }];
  const rels = [{ fromTable: "sales", toTable: "date" }, { fromTable: "sales", toTable: "store" }, { fromTable: "budget", toTable: "date" }];
  const b = modelPlaces(tables, rels);
  const sameSide = ["sales", "budget"].find(f => b[f].x === b.Metrics.x);
  assert.ok(sameSide, "on a fact's side");
  assert.ok(b.Metrics.y >= b[sameSide].y + b[sameSide].h, "under the fact there");
  assert.notEqual(b.Metrics.x, b.date.x, "not among the dimensions");
});

test("a chart's bars are rounded at their free end, and a line alone fades under itself and ends in a dot", () => {
  const fields = modelFields(MODEL);
  const rows = [{ Borough: "Bronx", "Total Fare": 10 }, { Borough: "Queens", "Total Fare": 20 }];
  const look = { fields, palette: ["#112233"], css: () => "#999" };
  const bar = pivotView(shelves({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "bar" }), rows, "bar", look).option;
  assert.ok(bar.series[0].itemStyle.borderRadius, "a bar's end is rounded");
  assert.equal(bar.series[0].areaStyle, undefined);
  const line = pivotView(shelves({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "line" }), rows, "line", look).option;
  assert.equal(line.series[0].areaStyle.color.colorStops[1].color, "rgba(17,34,51,0)", "the fill fades to nothing");
  assert.deepEqual(line.series[0].markPoint.data.map(d => d.coord), [[1, 20]], "a dot on its last value");
});

test("a field's display folders: several split by ';', each a path split by a backslash", async () => {
  const { folderPaths } = await import("../../page/explore/explore.js");
  assert.deepEqual(folderPaths(undefined), []);
  assert.deepEqual(folderPaths(""), []);
  assert.deepEqual(folderPaths("Money"), [["Money"]]);
  assert.deepEqual(folderPaths(String.raw`Sales\Margins\ Ratios `), [["Sales", "Margins", "Ratios"]]);
  assert.deepEqual(folderPaths(String.raw`Sales\Margins;KPIs;;`), [["Sales", "Margins"], ["KPIs"]]);
  const fields = modelFields({ tables: [{ name: "Sales",
    columns: [{ name: "Order Date", dataType: "dateTime", displayFolder: "Dates" }, { name: "Amount", dataType: "double" }],
    measures: [{ name: "Margin %", displayFolder: String.raw`Margins\Ratios` }, { name: "Total" }] }] });
  const [t] = fields.tables;
  assert.deepEqual(t.columns.map(c => c.folders), [[["Dates"]], []]);
  assert.deepEqual(t.measures.map(m => m.folders), [[["Margins", "Ratios"]], []]);
});
