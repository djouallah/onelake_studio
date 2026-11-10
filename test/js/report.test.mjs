// app/explore/report.js and explore.js: a Report's queries. A tile's query is always Visual's,
// generated from its shelves; a pick in one tile is a condition of every other tile's own query.
import { test } from "node:test";
import assert from "node:assert/strict";

const { pickWhere } = await import("../../app/explore/report.js");
const BOROUGH = '"dim_zone"."Borough"';

test("a pick is a condition as the Filters shelf writes one", () => {
  assert.deepEqual(pickWhere("dim_zone.Borough", { value: "Bronx" }), [["dim_zone.Borough", "=", "Bronx"]]);
  assert.deepEqual(pickWhere("dim_zone.Borough", { value: null }), [["dim_zone.Borough", "blank"]], "a blank");
  assert.deepEqual(pickWhere("dim_date.Year", { values: [2024, null] }), [["dim_date.Year", "in", [2024, null]]]);
  assert.deepEqual(pickWhere("dim_date.Year", { values: [] }), [], "nothing ticked: no condition");
  assert.deepEqual(pickWhere("dim_date.Year", { range: [2021, null] }), [["dim_date.Year", ">=", 2021]]);
  assert.deepEqual(pickWhere("dim_date.Date", { range: ["2021-01-01", "2021-01-31"] }),
    [["dim_date.Date", ">=", "2021-01-01"], ["dim_date.Date", "<=", "2021-01-31"]]);
  assert.deepEqual(pickWhere("dim_date.Year", { range: [null, null] }), [], "no ends: no condition");
});

const { modelFields, pivotQuery, pivotTitle, pivotView, autoMark } = await import("../../app/explore/explore.js");
const MODEL = { tables: [
  { name: "dim_zone", columns: [{ name: "Borough", dataType: "string" }, { name: "Zone", dataType: "string" },
                                { name: "Lat", dataType: "double" }, { name: "Lon", dataType: "double" }] },
  { name: "dim_date", columns: [{ name: "Date", dataType: "dateTime" }, { name: "Year", dataType: "int64" }] },
  { name: "trips", columns: [{ name: "fare", dataType: "double" }], measures: [{ name: "Total Fare" }] },
], relationships: [{ fromTable: "trips", toTable: "dim_zone" }, { fromTable: "trips", toTable: "dim_date" }] };
const PIVOT_SQL = 'SELECT "dim_zone"."Borough" AS "Borough", AGG("Total Fare") AS "Total Fare"\nFROM model\nGROUP BY ALL\n' +
                  'ORDER BY "Borough"\nFETCH FIRST 5000 ROWS WITH TIES';

test("a pivot tile runs Pivot's query, and a click on it picks its first Rows field", () => {
  const fields = modelFields(MODEL);
  const { state, sql, field } = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "bar" }, fields);
  assert.deepEqual([state.cols, state.filters, state.totals], [[], [], false], "every shelf there");
  assert.equal(sql, PIVOT_SQL);
  assert.deepEqual(field, { id: "dim_zone.Borough", table: "dim_zone", column: "Borough", ref: BOROUGH });
  // No Rows: its first Columns field; a map, its points' name.
  assert.equal(pivotQuery({ rows: ["dim_zone.Lat", "dim_zone.Lon", "dim_zone.Zone"], values: ["Total Fare"], mark: "map" }, fields).field.column, "Zone");
  assert.equal(pivotQuery({ rows: ["dim_zone.Lat", "dim_zone.Lon"], values: ["Total Fare"], mark: "map" }, fields).field, null);
  assert.deepEqual(pivotQuery({ cols: ["dim_zone.Borough"], values: ["Total Fare"] }, fields).field.column, "Borough");
  assert.equal(pivotQuery({ values: ["Total Fare"] }, fields).field, null, "nothing to pick");
  for (const [saved, why] of [[null, /the shelves/], [[], /the shelves/], [{ rows: "dim_zone.Borough" }, /rows is a list/], [{}, /no fields/]]) {
    assert.throws(() => pivotQuery(saved, fields), why, JSON.stringify(saved));
  }
});

test("another tile's pick goes in a tile's own query, beside its own filters", () => {
  const fields = modelFields(MODEL);
  const piv = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"] }, fields);
  assert.equal(piv.sqlWith([]), piv.sql);
  assert.equal(piv.sqlWith(pickWhere("dim_zone.Borough", { value: "Bronx" })),
               PIVOT_SQL.replace("FROM model\n", `FROM model\nWHERE ${BOROUGH} = 'Bronx'\n`));
  const own = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"],
                           filters: [{ field: "dim_zone.Borough", op: "notIn", values: ["Queens"] }] }, fields);
  assert.match(own.sqlWith(pickWhere("dim_zone.Borough", { value: "Bronx" })),
    /\nWHERE \("dim_zone"\."Borough" NOT IN \('Queens'\) OR "dim_zone"\."Borough" IS NULL\)\n  AND "dim_zone"\."Borough" = 'Bronx'\nGROUP BY ALL\n/);
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

test("a slicer's values go in as IN, a blank among them as IS NULL, each typed by its column", () => {
  const fields = modelFields(MODEL);
  const piv = pivotQuery({ values: ["Total Fare"], mark: "card" }, fields);
  const base = 'SELECT AGG("Total Fare") AS "Total Fare"\nFROM model';
  assert.equal(piv.sql, base);
  const w = (id, p) => piv.sqlWith(pickWhere(id, p));
  assert.equal(w("dim_zone.Borough", { values: ["Bronx", "O'Hare"] }), `${base}\nWHERE ${BOROUGH} IN ('Bronx', 'O''Hare')`);
  assert.equal(w("dim_zone.Borough", { values: [null, "Bronx"] }), `${base}\nWHERE (${BOROUGH} IS NULL OR ${BOROUGH} IN ('Bronx'))`);
  assert.equal(w("dim_zone.Borough", { values: [null] }), `${base}\nWHERE ${BOROUGH} IS NULL`);
  assert.equal(w("dim_date.Year", { values: [2024] }), `${base}\nWHERE "dim_date"."Year" IN (2024)`);
  assert.equal(w("dim_date.Date", { values: ["2024-03-01"] }), `${base}\nWHERE "dim_date"."Date" IN (DATE '2024-03-01')`);
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
  const fields = modelFields(MODEL);
  const piv = pivotQuery({ values: ["Total Fare"], mark: "card" }, fields);
  const base = 'SELECT AGG("Total Fare") AS "Total Fare"\nFROM model';
  const w = (id, p) => piv.sqlWith(pickWhere(id, p));
  assert.equal(w("dim_date.Year", { range: [2021, 2023] }), `${base}\nWHERE "dim_date"."Year" >= 2021\n  AND "dim_date"."Year" <= 2023`);
  assert.equal(w("dim_date.Year", { range: [2021, null] }), `${base}\nWHERE "dim_date"."Year" >= 2021`);
  assert.equal(w("dim_date.Date", { range: [null, "2023-12-31"] }), `${base}\nWHERE "dim_date"."Date" < DATE '2024-01-01'`);
  assert.equal(w("dim_date.Year", { range: [null, null] }), base, "no ends: no filter");
});

test("a slicer is a Visual: its query lists the values that have the measure, and it is named for its column", () => {
  const fields = modelFields(MODEL);
  const { state, sql, field } = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "slicer", slicer: "buttons" }, fields);
  assert.equal(sql, PIVOT_SQL);
  assert.deepEqual(field, { id: "dim_zone.Borough", table: "dim_zone", column: "Borough", ref: BOROUGH });
  assert.equal(state.slicer, "buttons");
  assert.equal(pivotTitle(state), "Borough");
  assert.equal(pivotQuery({ rows: ["dim_zone.Borough"], mark: "slicer" }, fields).state.slicer, "list", "List unless picked");
});

test("a card is its Values over every row its filters keep; a field on Rows is its trend, under its total", () => {
  const fields = modelFields(MODEL);
  const { sql, field, sqlWith } = pivotQuery({ rows: [], values: ["Total Fare"], mark: "card",
                                               filters: [{ field: "dim_zone.Borough", op: "in", values: ["Bronx"] }] }, fields);
  assert.equal(sql, `SELECT AGG("Total Fare") AS "Total Fare"\nFROM model\nWHERE ${BOROUGH} IN ('Bronx')`);
  assert.equal(field, null, "a click on a card picks nothing");
  assert.equal(sqlWith(pickWhere("dim_zone.Borough", { value: "Queens" })),
               `SELECT AGG("Total Fare") AS "Total Fare"\nFROM model\nWHERE ${BOROUGH} IN ('Bronx')\n  AND ${BOROUGH} = 'Queens'`, "another tile's pick filters it");
  // Rows: the trend, and its total the figure; Columns left out.
  const trend = pivotQuery({ rows: ["dim_date.Date"], cols: ["dim_zone.Borough"], values: ["Total Fare"], mark: "card" }, fields);
  assert.match(trend.sql, /^SELECT "dim_date"\."Date" AS "Date", AGG\("Total Fare"\) AS "Total Fare", GROUPING\("dim_date"\."Date"\) AS "__rows_total"\nFROM model\nGROUP BY ROLLUP\("dim_date"\."Date"\)\nORDER BY "Date"/);
  assert.throws(() => pivotQuery({ rows: ["dim_zone.Borough"], mark: "card" }, fields), /Values/);
  assert.equal(pivotTitle({ rows: [], cols: [], values: ["Total Fare"], mark: "card" }), "Total Fare");
});

test("Top N keeps the first rows as they are sorted, ties kept; a filter on a measure is a HAVING", () => {
  const fields = modelFields(MODEL);
  assert.equal(pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"], sort: "desc", top: 15 }, fields).sql,
    'SELECT "dim_zone"."Borough" AS "Borough", AGG("Total Fare") AS "Total Fare"\nFROM model\nGROUP BY ALL\n' +
    'ORDER BY "Total Fare" DESC, "Borough"\nFETCH FIRST 15 ROWS WITH TIES');
  assert.equal(pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"],
                            filters: [{ field: "Total Fare", op: "range", min: 0.5, measure: true }] }, fields).sql,
    'SELECT "dim_zone"."Borough" AS "Borough", AGG("Total Fare") AS "Total Fare"\nFROM model\nGROUP BY ALL\n' +
    'HAVING "Total Fare" >= 0.5\nORDER BY "Borough"\nFETCH FIRST 5000 ROWS WITH TIES', "by its name in the SELECT");
  assert.match(pivotQuery({ rows: ["dim_zone.Borough"], values: ["\0sum\0trips.fare"],
                            filters: [{ field: "Total Fare", op: "range", min: 1, max: 9, measure: true }] }, fields).sql,
    /\nHAVING AGG\("Total Fare"\) >= 1\n  AND AGG\("Total Fare"\) <= 9\n/, "a measure not shown, as itself");
});

test("measures in one plot: each drawn as it says, on its axis; the total as a line; the highest labelled", () => {
  const fields = modelFields(MODEL);
  const s = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare", "\0sum\0trips.fare"], mark: "bar", totals: true }, fields).state;
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

test("a value's own colour (the report's theme) colours its bar, its series, its box", () => {
  const fields = modelFields(MODEL);
  const s = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "bar" }, fields).state;
  const rows = [{ Borough: "Bronx", "Total Fare": 10 }, { Borough: "Queens", "Total Fare": 20 }];
  const look = { fields, palette: ["#111"], css: () => "#999", valueColors: { Bronx: "#abcdef" } };
  assert.deepEqual(pivotView(s, rows, "bar", look).option.series[0].data, [{ value: 10, itemStyle: { color: "#abcdef" } }, 20]);
  const tree = pivotView({ ...s, mark: "treemap" }, rows, "treemap", look).option.series[0];
  assert.equal(tree.type, "treemap");
  assert.deepEqual(tree.data.map(d => [d.name, d.value, d.itemStyle.color]), [["Bronx", 10, "#abcdef"], ["Queens", 20, "#111"]]);
});

test("a calendar: a strip a year, newest first, each day its figure; a map's points over the world", () => {
  const fields = modelFields(MODEL);
  const s = pivotQuery({ rows: ["dim_date.Date"], values: ["Total Fare"], mark: "calendar" }, fields).state;
  const rows = [{ Date: "2024-12-31", "Total Fare": 5 }, { Date: "2025-01-01", "Total Fare": 7 }];
  const cal = pivotView(s, rows, "calendar", { fields, palette: ["#111"], css: () => "#999" }).option;
  assert.deepEqual(cal.calendar.map(c => c.range), ["2025", "2024"]);
  assert.deepEqual(cal.series.map(x => x.data), [[["2025-01-01", 7]], [["2024-12-31", 5]]]);
  const m = pivotQuery({ rows: ["dim_zone.Lat", "dim_zone.Lon", "dim_zone.Zone"], values: ["Total Fare"], mark: "map" }, fields).state;
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

test("Visual's fields leave out a hidden table, its measures too, and hidden columns and measures", () => {
  const { tables, byId } = modelFields({ tables: [
    ...MODEL.tables.map(t => (t.name === "trips" ? { ...t, columns: [...t.columns, { name: "secret", dataType: "string", isHidden: true }] } : t)),
    { name: "stg_log", isHidden: true, columns: [{ name: "path", dataType: "string" }], measures: [{ name: "Files" }] },
  ], relationships: MODEL.relationships });
  assert.deepEqual(tables.map(t => t.name), ["dim_date", "dim_zone", "trips"]);
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

const { reportPages, withPages, newPageName, markdownBlocks } = await import("../../app/explore/report.js");

test("a report's pages: its own, or a report from before pages as one, Page 1", () => {
  const tiles = [{ title: "a", kind: "kpi", sql: "SELECT 1 FROM model" }];
  assert.deepEqual(reportPages({ tiles }), [{ name: "Page 1", tiles }]);
  assert.deepEqual(reportPages({ pages: [{ name: "Sales", tiles }, { name: " ", tiles: [] }, {}] }),
    [{ name: "Sales", tiles }, { name: "Page 2", tiles: [] }, { name: "Page 3", tiles: undefined }], "a page with no name is named for where it is");
  assert.deepEqual(reportPages({ pages: [] }), [{ name: "Page 1", tiles: [] }], "no pages: one empty page");
  assert.deepEqual(reportPages({}), [{ name: "Page 1", tiles: undefined }], "no list: drawn as a page that says so");
  // Written back as pages: the old list goes, anything else is kept.
  assert.deepEqual(withPages({ tiles, theme: "x" }, [{ name: "Page 1", tiles }]), { theme: "x", pages: [{ name: "Page 1", tiles }] });
  assert.equal(newPageName([{ name: "Page 1" }, { name: "Sales" }, { name: "Trend" }]), "Page 4");
  assert.equal(newPageName([{ name: "Page 1" }, { name: "Page 2" }, { name: "Page 3" }].slice(1)), "Page 4", "the next name no page has");
});

test("a text tile's Markdown: headings, paragraphs, lists, bold, italic and http links only", () => {
  assert.deepEqual(markdownBlocks("# Sales overview\nFigures are **net of returns**.\nSource: [AEMO](https://aemo.com.au)\n\n- *one*\n- two\n### Notes"), [
    { h: 1, parts: ["Sales overview"] },
    { p: ["Figures are ", { b: "net of returns" }, ". Source: ", { a: "AEMO", href: "https://aemo.com.au" }] },
    { ul: [[{ i: "one" }], ["two"]] },
    { h: 3, parts: ["Notes"] },
  ]);
  assert.deepEqual(markdownBlocks("[x](javascript:alert(1)) <b>hi</b>"), [{ p: ["[x](javascript:alert(1)) <b>hi</b>"] }], "no other link, no HTML: text as it is");
  assert.deepEqual(markdownBlocks(""), []);
  assert.deepEqual(markdownBlocks("a\r\nb\r\n\r\nc"), [{ p: ["a b"] }, { p: ["c"] }]);
});

const { formatChart, numberFormat } = await import("../../app/explore/report.js");
const { formatValue, byValueBackground } = await import("../../app/explore/draw.js");

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

test("a chart's format over its option: colours by series, legend, axis titles and range, labels", () => {
  const option = { legend: undefined, grid: { left: 8, right: 16, top: 12, bottom: 8, containLabel: true },
    xAxis: { type: "category", data: ["a", "b"] }, yAxis: { type: "value" },
    series: [{ name: "Revenue", type: "bar", data: [1, 2] }, { name: "Cost", type: "line", data: [1, 1] }] };
  assert.deepEqual(formatChart(option, {}), { ...option, series: option.series }, "no format, the same chart");
  const out = formatChart(option, { colors: { Cost: "#ff0000" }, legend: "bottom", xTitle: "Region", yTitle: "AUD", yMin: 0, yMax: 10, labels: true },
    { textSize: "L", label: (s, v) => `${s}=${v}` });
  assert.equal(out.series[1].itemStyle.color, "#ff0000");
  assert.equal(out.series[1].lineStyle.color, "#ff0000", "a line's line too");
  assert.equal(out.series[0].itemStyle, undefined, "a series with no colour of its own keeps the palette's");
  assert.deepEqual([out.legend.show, out.legend.bottom], [true, 0]);
  assert.equal(out.grid.bottom, 8 + 22 + 26, "room for the axis title and the legend under the plot");
  assert.deepEqual([out.xAxis.name, out.xAxis.nameLocation], ["Region", "middle"]);
  assert.deepEqual([out.yAxis.name, out.yAxis.min, out.yAxis.max], ["AUD", 0, 10]);
  assert.equal(out.xAxis.axisLabel.fontSize, 14);
  assert.equal(out.series[0].label.formatter({ value: 3 }), "Revenue=3");
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

const { tileOf } = await import("../../app/explore/report.js");

test("an older tile's format goes into its Visual's, but for its title and the filters it does not follow", () => {
  const old = { title: "x", kind: "pivot", pivot: { rows: ["dim_zone.Borough"], values: ["Total Fare"] },
                format: { title: false, titleSize: "L", ignore: ["dim_date.Date"], labels: true, numbers: { "Total Fare": "int" } } };
  const now = { title: "x", kind: "pivot", showTitle: false, titleSize: "L", ignore: ["dim_date.Date"],
                pivot: { rows: ["dim_zone.Borough"], values: ["Total Fare"], format: { labels: true, numbers: { "Total Fare": "int" } } } };
  assert.deepEqual(tileOf(old), now);
  assert.deepEqual(reportPages({ tiles: [old] })[0].tiles[0], now, "read so, and saved so");
  const plain = { title: "y", kind: "pivot", pivot: { rows: [], values: ["Total Fare"] } };
  assert.equal(tileOf(plain), plain, "a tile with no format of its own, as it is");
});

test("a Visual's total line asks its query for the totals", () => {
  const fields = modelFields(MODEL);
  const { sql } = pivotQuery({ rows: ["dim_zone.Borough"], values: ["Total Fare"], mark: "bar", format: { totalLine: true } }, fields);
  assert.match(sql, /GROUPING\("dim_zone"\."Borough"\) AS "__rows_total"[\s\S]*GROUP BY ROLLUP\("dim_zone"\."Borough"\)/);
});
