// src/xmla: Excel's PivotTable answered. The statements below are what Excel 16 and MSOLAP 17
// sent to this server, word for word; the shapes are the contract, so a change to one is a
// change to what a PivotTable can do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(import.meta.url);
const { parseRequest, esc, unesc } = require("../../src/xmla/soap.js");
const { buildCube, resolve, memberUnique, nameParts } = require("../../src/xmla/cube.js");
const { parseSelect, slicerTemplate } = require("../../src/xmla/mdx.js");
const { execute, literal, condition } = require("../../src/xmla/cellset.js");
const { discover, discoverServer } = require("../../src/xmla/rowsets.js");
const { createHandler, PING } = require("../../src/xmla/server.js");
const { connectionString, connectionValue, openInExcel, SCRIPT } = require("../../src/xmla/excel.js");

const CATALOG = "semanticmodel.demo.sales";
const col = (name, dataType, extra = {}) => ({ name, dataType, ...extra });
const BIM = { model: { tables: [
  { name: "Sales", columns: [col("amount", "double", { isHidden: true })], measures: [
    { name: "Total Sales", expression: "SUM(Sales[amount])", formatString: "#,0.00", displayFolder: "Money" },
    { name: "Orders", expression: "1" },
    { name: "Secret", expression: "1", isHidden: true },
  ] },
  { name: "Product", columns: [
    col("color", "string", { sortByColumn: "color_order" }), col("color_order", "int64", { isHidden: true }), col("size", "string"),
    col("internal", "string", { isAvailableInMdx: false }),
  ] },
  { name: "Calendar", columns: [col("year", "int64"), col("month", "string"), col("day", "dateTime")],
    hierarchies: [{ name: "Calendar", levels: [{ name: "Month", ordinal: 1, column: "month" }, { name: "Year", ordinal: 0, column: "year" }] }] },
  { name: "Hidden", isHidden: true, columns: [col("x", "string")] },
] } };
const cube = () => buildCube(CATALOG, BIM, CATALOG);

// A query that answers from rows chosen by the SQL's text, and remembers what it was asked.
function fakeQuery(answer) {
  const asked = [];
  const query = async sql => {
    asked.push(sql);
    const rows = answer(sql) ?? [];
    return { rows, numRows: rows.length, fields: [] };
  };
  return { query, asked };
}
const tags = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, "g"))].map(m => unesc(m[1]));
const axisOf = (xml, name) => (new RegExp(`<Axis name="${name}">([\\s\\S]*?)</Axis>`).exec(xml) || [])[1] ?? "";
const cellsOf = xml => Object.fromEntries([...xml.matchAll(/<Cell CellOrdinal="(\d+)"><Value xsi:type="[^"]+">([^<]*)<\/Value>/g)].map(m => [Number(m[1]), m[2]]));

const ROWS_OF_COLOR = "NON EMPTY Hierarchize(AddCalculatedMembers({DrilldownLevel({[Product].[color].[All]})})) DIMENSION PROPERTIES PARENT_UNIQUE_NAME,HIERARCHY_UNIQUE_NAME ON ROWS";
const TWO_MEASURES = "{[Measures].[Total Sales],[Measures].[Orders]} DIMENSION PROPERTIES PARENT_UNIQUE_NAME,HIERARCHY_UNIQUE_NAME ON COLUMNS";

test("the field list: what is hidden stays out, and a hierarchy reads its levels in order", () => {
  const c = cube();
  assert.deepEqual(c.measures.map(m => m.name), ["Total Sales", "Orders"]);
  assert.deepEqual(c.dimensions.map(d => d.name), ["Product", "Calendar"]);
  assert.deepEqual(c.hierarchies.map(h => h.unique), [
    "[Product].[color]", "[Product].[size]", "[Calendar].[year]", "[Calendar].[month]", "[Calendar].[day]", "[Calendar].[Calendar]",
  ]);
  const user = c.hierarchies.at(-1);
  assert.deepEqual(user.levels.map(l => l.name), ["Year", "Month"]);
  assert.deepEqual(c.groups, ["Sales"]);
});

test("a table called Measures keeps its measures, and is no dimension", () => {
  const c = buildCube(CATALOG, { model: { tables: [{ name: "Measures", columns: [col("x", "string")], measures: [{ name: "M", expression: "1" }] }] } }, CATALOG);
  assert.deepEqual(c.dimensions, []);
  assert.deepEqual(c.measures.map(m => m.unique), ["[Measures].[M]"]);
});

test("a model with no measures still opens: Excel refuses a cube with none, so one it can't show stands in", async () => {
  const c = buildCube(CATALOG, { model: { tables: [{ name: "summary", columns: [col("DUID", "string"), col("mw", "double")] }] } }, CATALOG);
  assert.deepEqual(c.measures, []);
  assert.deepEqual(c.groups, ["summary"]);
  const ctx = { query: async () => { throw new Error("no query for a definition"); }, literal };
  const rowset = await discover(c, "MDSCHEMA_MEASURES", {}, ctx);
  assert.deepEqual(tags(rowset, "MEASURE_NAME"), ["__No measures defined"]);
  assert.deepEqual(tags(rowset, "MEASURE_IS_VISIBLE"), ["false"]);
  const hierarchies = await discover(c, "MDSCHEMA_HIERARCHIES", { HIERARCHY_UNIQUE_NAME: ["[Measures]"] }, ctx);
  assert.deepEqual(tags(hierarchies, "DEFAULT_MEMBER"), ["[Measures].[__No measures defined]"]);
  // Asked for, it runs nothing against the model and has no cell: AGG() of it would be an error.
  const f = fakeQuery(() => [{ c0: "A" }]);
  const xml = await execute(`SELECT NON EMPTY Hierarchize(AddCalculatedMembers({DrilldownLevel({[summary].[DUID].[All]})})) ON COLUMNS FROM [Model] WHERE ([Measures].[__No measures defined]) CELL PROPERTIES VALUE`, { cube: c, query: f.query });
  assert.deepEqual(f.asked, [`SELECT "summary"."DUID" AS "c0" FROM ${CATALOG} GROUP BY ALL`]);
  assert.deepEqual(tags(axisOf(xml, "Axis0"), "Caption"), ["All", "A"]);
  assert.deepEqual(cellsOf(xml), {});
  assert.ok(axisOf(xml, "SlicerAxis").includes("<UName>[Measures].[__No measures defined]</UName>"));
  // On an axis too, the members stay.
  const g = fakeQuery(() => [{ c0: "A" }]);
  const across = await execute(`SELECT {[Measures].Members} ON COLUMNS, NON EMPTY Hierarchize({DrilldownLevel({[summary].[DUID].[All]})}) ON ROWS FROM [Model]`, { cube: c, query: g.query });
  assert.deepEqual(tags(axisOf(across, "Axis1"), "Caption"), ["All", "A"]);
  assert.deepEqual(cellsOf(across), {});
});

test("names: a member's keys and a ] in them survive the round trip", () => {
  const c = cube();
  const h = c.hierarchies.at(-1);
  const u = memberUnique(h, ["2023", "a]b"]);
  assert.equal(u, "[Calendar].[Calendar].&[2023].&[a]]b]");
  assert.deepEqual(nameParts(u), ["Calendar", "Calendar", { key: "2023" }, { key: "a]b" }]);
  assert.deepEqual(resolve(c, u).path, ["2023", "a]b"]);
  assert.deepEqual(resolve(c, "[Product].[color].[All]").path, []);
  assert.equal(resolve(c, "[Product].[color].[color]").depth, 1);
  assert.equal(resolve(c, "[Measures].[Orders]").measure.name, "Orders");
  assert.equal(resolve(c, "[Nope].[x].&[1]"), null);
  assert.equal(resolve(c, "[Measures].[Secret]"), null);
});

test("a request: session, restrictions in both forms, catalog, statement", () => {
  const r = parseRequest(`<soap:Envelope><soap:Header><Session SessionId="s-1"/></soap:Header><soap:Body><Discover><RequestType>MDSCHEMA_MEMBERS</RequestType>
    <Restrictions><RestrictionList><CUBE_NAME>Model</CUBE_NAME><MEMBER_UNIQUE_NAME><Value>[a].&amp;[1]</Value><Value>[b]</Value></MEMBER_UNIQUE_NAME></RestrictionList></Restrictions>
    <Properties><PropertyList><Catalog>${esc(CATALOG)}</Catalog></PropertyList></Properties></Discover></soap:Body></soap:Envelope>`);
  assert.equal(r.sessionId, "s-1");
  assert.equal(r.requestType, "MDSCHEMA_MEMBERS");
  assert.deepEqual(r.restrictions, { CUBE_NAME: ["Model"], MEMBER_UNIQUE_NAME: ["[a].&[1]", "[b]"] });
  assert.equal(r.catalog, CATALOG);
  const begin = parseRequest('<Header><BeginSession xmlns="x"/></Header><Command><Statement xmlns="x"/></Command>');
  assert.equal(begin.begin, true);
  assert.equal(begin.statement, null);
  assert.equal(parseRequest('<Header><EndSession SessionId="s"/></Header>').end, true);
  assert.equal(parseRequest("<Statement>SELECT &#xD;\n[a]</Statement>").statement, "SELECT \r\n[a]");
});

test("the provider's questions before a model is named: Catalog is the connection's own", () => {
  const xml = discoverServer("DISCOVER_PROPERTIES", { PropertyName: ["Catalog", "ProviderVersion", "Unknown"] }, CATALOG);
  assert.deepEqual(tags(xml, "PropertyName"), ["Catalog", "ProviderVersion"]);
  assert.ok(xml.includes(`<Value>${CATALOG}</Value>`));
  const rowsets = discoverServer("DISCOVER_SCHEMA_ROWSETS", {});
  assert.ok(rowsets.includes('name="uuid"'), "the provider stops without the uuid type");
  assert.ok(rowsets.includes("<SchemaName>MDSCHEMA_MEMBERS</SchemaName>"));
  assert.ok(rowsets.includes("<Restrictions><Name>TREE_OP</Name><Type>unsignedShort</Type></Restrictions>"));
});

test("rowsets: measures keep their folder and format, and restrictions narrow", async () => {
  const ctx = { query: async () => { throw new Error("no query for a definition"); }, literal };
  const measures = await discover(cube(), "MDSCHEMA_MEASURES", { CUBE_NAME: ["Model"] }, ctx);
  assert.deepEqual(tags(measures, "MEASURE_NAME"), ["Total Sales", "Orders"]);
  assert.ok(measures.includes("<MEASURE_DISPLAY_FOLDER>Money</MEASURE_DISPLAY_FOLDER>"));
  assert.ok(measures.includes("<DEFAULT_FORMAT_STRING>#,0.00</DEFAULT_FORMAT_STRING>"));
  const levels = await discover(cube(), "MDSCHEMA_LEVELS", { HIERARCHY_UNIQUE_NAME: ["[Calendar].[Calendar]"] }, ctx);
  assert.deepEqual(tags(levels, "LEVEL_NAME"), ["(All)", "Year", "Month"]);
  assert.equal(tags(await discover(cube(), "MDSCHEMA_KPIS", {}, ctx), "KPI_NAME").length, 0);
  await assert.rejects(discover(cube(), "DISCOVER_NOPE", {}, ctx), /no rowset DISCOVER_NOPE/);
});

test("members: itself needs no query; a level is read, in its sort-by order", async () => {
  const none = { query: async () => { throw new Error("no query expected"); }, literal };
  const self = await discover(cube(), "MDSCHEMA_MEMBERS", { MEMBER_UNIQUE_NAME: ["[Product].[size].&[L]"], TREE_OP: ["8"] }, none);
  assert.deepEqual(tags(self, "MEMBER_CAPTION"), ["L"]);
  assert.deepEqual(tags(self, "PARENT_UNIQUE_NAME"), ["[Product].[size].[All]"]);
  const f = fakeQuery(() => [{ c0: "Blue", s0: 2 }, { c0: "Red", s0: 1 }, { c0: null, s0: null }]);
  const level = await discover(cube(), "MDSCHEMA_MEMBERS", { LEVEL_UNIQUE_NAME: ["[Product].[color].[color]"] }, { query: f.query, literal });
  assert.deepEqual(f.asked, [`SELECT "Product"."color" AS "c0", "Product"."color_order" AS "s0" FROM ${CATALOG} GROUP BY ALL`]);
  assert.deepEqual(tags(level, "MEMBER_CAPTION"), ["(Blank)", "Red", "Blue"]);
  assert.deepEqual(tags(level, "MEMBER_UNIQUE_NAME"), ["[Product].[color].&[]", "[Product].[color].&[Red]", "[Product].[color].&[Blue]"]);
  const k = fakeQuery(() => [{ c0: "2023", c1: "Feb" }]);
  await discover(cube(), "MDSCHEMA_MEMBERS", { MEMBER_UNIQUE_NAME: ["[Calendar].[Calendar].&[2023]"], TREE_OP: ["1"] }, { query: k.query, literal });
  assert.deepEqual(k.asked, [`SELECT "Calendar"."year" AS "c0", "Calendar"."month" AS "c1" FROM ${CATALOG} WHERE "Calendar"."year" = 2023 GROUP BY ALL`]);
});

test("one measure: no axis at all, and one cell", async () => {
  const f = fakeQuery(() => [{ m0: 400 }]);
  const xml = await execute("SELECT  FROM [Model] WHERE ([Measures].[Total Sales]) CELL PROPERTIES VALUE", { cube: cube(), query: f.query });
  assert.deepEqual(f.asked, [`SELECT AGG("Total Sales") AS "m0" FROM ${CATALOG}`]);
  assert.deepEqual(cellsOf(xml), { 0: "400" });
  assert.ok(axisOf(xml, "SlicerAxis").includes("<UName>[Measures].[Total Sales]</UName>"));
  assert.ok(axisOf(xml, "SlicerAxis").includes("<UName>[Product].[size].[All]</UName>"));
});

test("rows of a column: its total and its members, each a query, in sort-by order", async () => {
  const f = fakeQuery(sql => (sql.includes("GROUP BY")
    ? [{ c0: "Blue", c1: 2, m0: 230, m1: 4 }, { c0: "Red", c1: 1, m0: 170, m1: 2 }]
    : [{ m0: 400, m1: 6 }]));
  const xml = await execute(`SELECT ${TWO_MEASURES} , ${ROWS_OF_COLOR}  FROM [Model] CELL PROPERTIES VALUE`, { cube: cube(), query: f.query });
  assert.deepEqual(f.asked.sort(), [
    `SELECT "Product"."color" AS "c0", "Product"."color_order" AS "c1", AGG("Total Sales") AS "m0", AGG("Orders") AS "m1" FROM ${CATALOG} GROUP BY ALL`,
    `SELECT AGG("Total Sales") AS "m0", AGG("Orders") AS "m1" FROM ${CATALOG}`,
  ].sort());
  assert.deepEqual(tags(axisOf(xml, "Axis0"), "Caption"), ["Total Sales", "Orders"]);
  assert.deepEqual(tags(axisOf(xml, "Axis1"), "Caption"), ["All", "Red", "Blue"]);
  // Columns are axis 0: the ordinal is the column, plus 2 per row.
  assert.deepEqual(cellsOf(xml), { 0: "400", 1: "6", 2: "170", 3: "2", 4: "230", 5: "4" });
  // All is drilled down, and Blue has Red's parent: Excel draws the subtotal from these.
  assert.deepEqual(tags(axisOf(xml, "Axis1"), "DisplayInfo").map(Number), [1 + 0x10000, 0, 0x20000]);
  assert.deepEqual(tags(axisOf(xml, "Axis1"), "PARENT_UNIQUE_NAME"), ["[Product].[color].[All]", "[Product].[color].[All]"]);
});

test("rows by columns: a grain for each pair, so totals are the model's own", async () => {
  const f = fakeQuery(() => []);
  const across = "NON EMPTY CrossJoin({[Measures].[Total Sales],[Measures].[Orders]}, Hierarchize(AddCalculatedMembers({DrilldownLevel({[Calendar].[year].[All]})}))) DIMENSION PROPERTIES PARENT_UNIQUE_NAME,HIERARCHY_UNIQUE_NAME ON COLUMNS";
  const down = "NON EMPTY CrossJoin(Hierarchize(AddCalculatedMembers({DrilldownLevel({[Product].[color].[All]})})), Hierarchize(AddCalculatedMembers({DrilldownLevel({[Product].[size].[All]})}))) DIMENSION PROPERTIES PARENT_UNIQUE_NAME,HIERARCHY_UNIQUE_NAME ON ROWS";
  await execute(`SELECT ${across} , ${down}  FROM [Model] CELL PROPERTIES VALUE`, { cube: cube(), query: f.query });
  assert.equal(f.asked.length, 2 * 2 * 2, "year or not, color or not, size or not");
  assert.equal(new Set(f.asked).size, f.asked.length);
});

test("a blank cell is left out, and NON EMPTY drops a line with nothing on it", async () => {
  const f = fakeQuery(sql => (sql.includes("GROUP BY") ? [{ c0: "Red", c1: 1, m0: null, m1: 2 }, { c0: "Blue", c1: 2, m0: null, m1: null }] : [{ m0: 1, m1: 2 }]));
  const xml = await execute(`SELECT ${TWO_MEASURES} , ${ROWS_OF_COLOR}  FROM [Model] CELL PROPERTIES VALUE`, { cube: cube(), query: f.query });
  assert.deepEqual(tags(axisOf(xml, "Axis1"), "Caption"), ["All", "Red"]);
  assert.deepEqual(cellsOf(xml), { 0: "1", 1: "2", 3: "2" });
});

test("a field on rows with no measure yet: its members alone", async () => {
  const f = fakeQuery(() => [{ c0: "Red", c1: 1 }]);
  const xml = await execute(`SELECT ${ROWS_OF_COLOR.replace("ON ROWS", "ON COLUMNS")}  FROM [Model] CELL PROPERTIES VALUE`, { cube: cube(), query: f.query });
  assert.deepEqual(f.asked, [`SELECT "Product"."color" AS "c0", "Product"."color_order" AS "c1" FROM ${CATALOG} GROUP BY ALL`]);
  assert.deepEqual(tags(axisOf(xml, "Axis0"), "Caption"), ["All", "Red"]);
  assert.deepEqual(cellsOf(xml), {});
});

test("filters: WHERE, a subselect's deselected items, and All, which filters nothing", async () => {
  const f = fakeQuery(() => []);
  await execute(`SELECT ${TWO_MEASURES} , ${ROWS_OF_COLOR}  FROM [Model] WHERE ([Calendar].[year].&[2024]) CELL PROPERTIES VALUE`, { cube: cube(), query: f.query });
  assert.ok(f.asked.every(s => s.includes('WHERE "Calendar"."year" IN (2024)')), f.asked.join("\n"));
  const g = fakeQuery(() => []);
  await execute(`SELECT ${TWO_MEASURES} , ${ROWS_OF_COLOR}  FROM (SELECT ({[Product].[size].&[L],[Product].[size].&[S]}) ON COLUMNS  FROM [Model]) WHERE ([Calendar].[year].&[2023]) CELL PROPERTIES VALUE`, { cube: cube(), query: g.query });
  assert.ok(g.asked.every(s => s.includes(`WHERE "Product"."size" IN ('L', 'S') AND "Calendar"."year" IN (2023)`)), g.asked.join("\n"));
  const h = fakeQuery(() => []);
  await execute(`SELECT ${TWO_MEASURES} , ${ROWS_OF_COLOR}  FROM [Model] WHERE ([Calendar].[year].[All]) CELL PROPERTIES VALUE`, { cube: cube(), query: h.query });
  assert.ok(h.asked.every(s => !s.includes("WHERE")), h.asked.join("\n"));
});

test("a filtered member is what the slicer axis reports, and a measure on an axis isn't there", async () => {
  const f = fakeQuery(() => []);
  const xml = await execute(`SELECT ${TWO_MEASURES}  FROM [Model] WHERE ([Calendar].[year].&[2024]) CELL PROPERTIES VALUE`, { cube: cube(), query: f.query });
  const slicer = axisOf(xml, "SlicerAxis");
  assert.ok(slicer.includes("<UName>[Calendar].[year].&amp;[2024]</UName>"));
  assert.ok(!slicer.includes("[Measures]"));
  assert.ok(slicer.includes("<UName>[Product].[color].[All]</UName>"));
});

test("a hierarchy: expand a level, and expand one member", async () => {
  const f = fakeQuery(() => []);
  await execute(`SELECT NON EMPTY CrossJoin({[Measures].[Orders]}, Hierarchize(AddCalculatedMembers({DrilldownLevel({DrilldownLevel({[Calendar].[Calendar].[All]})},[Calendar].[Calendar].[Year])}))) DIMENSION PROPERTIES PARENT_UNIQUE_NAME,HIERARCHY_UNIQUE_NAME ON COLUMNS  FROM [Model] CELL PROPERTIES VALUE`, { cube: cube(), query: f.query });
  assert.deepEqual(f.asked.sort(), [
    `SELECT "Calendar"."year" AS "c0", "Calendar"."month" AS "c1", AGG("Orders") AS "m0" FROM ${CATALOG} GROUP BY ALL`,
    `SELECT "Calendar"."year" AS "c0", AGG("Orders") AS "m0" FROM ${CATALOG} GROUP BY ALL`,
    `SELECT AGG("Orders") AS "m0" FROM ${CATALOG}`,
  ].sort());
  const g = fakeQuery(sql => (sql.includes('"month"') ? [{ c0: 2024, c1: "Jan", m0: 1 }] : sql.includes("year") ? [{ c0: 2023, m0: 3 }, { c0: 2024, m0: 2 }] : [{ m0: 5 }]));
  const xml = await execute(`SELECT NON EMPTY CrossJoin({[Measures].[Orders]}, Hierarchize(AddCalculatedMembers(DrilldownMember({{DrilldownLevel({[Calendar].[Calendar].[All]})}}, {[Calendar].[Calendar].&[2024]})))) DIMENSION PROPERTIES PARENT_UNIQUE_NAME,HIERARCHY_UNIQUE_NAME ON COLUMNS  FROM [Model] CELL PROPERTIES VALUE`, { cube: cube(), query: g.query });
  assert.ok(g.asked.includes(`SELECT "Calendar"."year" AS "c0", "Calendar"."month" AS "c1", AGG("Orders") AS "m0" FROM ${CATALOG} WHERE "Calendar"."year" IN (2024) GROUP BY ALL`), g.asked.join("\n"));
  // A parent before its child, and a leaf of the first level between them is not its parent.
  assert.deepEqual(tags(axisOf(xml, "Axis0"), "UName").filter(n => !n.startsWith("[Measures]")),
    ["[Calendar].[Calendar].[All]", "[Calendar].[Calendar].&[2023]", "[Calendar].[Calendar].&[2024]", "[Calendar].[Calendar].&[2024].&[Jan]"]);
});

test("what doesn't fit is refused by name, and nothing is run", async () => {
  const refused = async (mdx, re) => {
    const f = fakeQuery(() => []);
    await assert.rejects(execute(mdx, { cube: cube(), query: f.query }), re);
    assert.deepEqual(f.asked, [], mdx);
  };
  await refused("WITH MEMBER [Measures].[x] AS 1 SELECT {[Measures].[x]} ON 0 FROM [Model]", /Calculated members/);
  await refused("DRILLTHROUGH SELECT FROM [Model]", /Show Details/);
  await refused("EVALUATE Sales", /SELECT statements only/);
  await refused("SELECT TopCount([Product].[color].[color].Members, 10) ON 0 FROM [Model]", /Top 10/);
  await refused("SELECT Filter([Product].[color].[color].Members, 1) ON 0 FROM [Model]", /Value filters/);
  await refused("SELECT Foo({[Product].[color].[All]}) ON 0 FROM [Model]", /FOO is not supported/);
  await refused("SELECT {[Product].[nope].[All]} ON 0 FROM [Model]", /not in this model/);
  await refused("SELECT {[Measures].[Secret]} ON 0 FROM [Model]", /not in this model/);
  await refused("SELECT Hierarchize({DrilldownLevel({[Product].[color].[All]})}) ON 0 FROM [Model]", /show items with no data/i);
  await refused("SELECT FROM [Model] WHERE ({[Measures].[Orders],[Measures].[Total Sales]})", /Several measures/);
});

test("more subtotals than a pivot can ask for is said, not attempted", async () => {
  const c = buildCube(CATALOG, { model: { tables: [{ name: "T", columns: Array.from({ length: 10 }, (_, i) => col(`c${i}`, "string")), measures: [{ name: "M", expression: "1" }] }] } }, CATALOG);
  const all = i => `Hierarchize(AddCalculatedMembers({DrilldownLevel({[T].[c${i}].[All]})}))`;
  const f = fakeQuery(() => []);
  await assert.rejects(execute(`SELECT NON EMPTY CrossJoin(${Array.from({ length: 10 }, (_, i) => all(i)).join(", ")}) ON 0 FROM [Model]`, { cube: c, query: f.query }), /more than 256 queries/);
  assert.deepEqual(f.asked, []);
});

test("a result past the row limit is said, not cut short", async () => {
  const query = async () => ({ rows: [{ c0: "a", c1: 1 }], numRows: 200001, fields: [] });
  await assert.rejects(execute(`SELECT ${ROWS_OF_COLOR.replace("ON ROWS", "ON 0")} FROM [Model]`, { cube: cube(), query }), /200,001 lines/);
});

test("a key reaches SQL as a literal of its column's type, or not at all", () => {
  const text = { table: "T", name: "c", dataType: "string" }, num = { table: "T", name: "n", dataType: "int64" };
  const date = { table: "T", name: "d", dataType: "datetime" }, bool = { table: "T", name: "b", dataType: "boolean" };
  assert.equal(literal(text, "x' OR 1=1 --"), "'x'' OR 1=1 --'");
  assert.equal(literal(num, "42"), "42");
  assert.equal(literal(num, "-1.5e3"), "-1.5e3");
  assert.throws(() => literal(num, "1; DROP TABLE t"), /not a value/);
  assert.equal(literal(date, "2024-01-15"), "DATE '2024-01-15'");
  assert.equal(literal(date, "2024-01-15 10:00:00"), "TIMESTAMP '2024-01-15 10:00:00'");
  assert.throws(() => literal(date, "2024-01-15'; --"), /not a value/);
  assert.equal(literal(bool, "true"), "TRUE");
  assert.throws(() => literal(bool, "1"), /not a value/);
  const c = cube();
  const color = c.hierarchies[0], user = c.hierarchies.at(-1);
  assert.equal(condition(color, [["Red"], ["Blue"]]), `"Product"."color" IN ('Red', 'Blue')`);
  assert.equal(condition(color, [[""]]), `"Product"."color" IS NULL`);
  assert.equal(condition(color, [[""], ["Red"]]), `("Product"."color" IS NULL OR "Product"."color" IN ('Red'))`);
  assert.equal(condition(user, [["2023", "Jan"], ["2024", "Feb"]]),
    `(("Calendar"."year" = 2023 AND "Calendar"."month" = 'Jan') OR ("Calendar"."year" = 2024 AND "Calendar"."month" = 'Feb'))`);
});

const SLICER_COUNT = "with member [Measures].__XLolapslicermembercount as [Product].[size].[size].members.count \r\nselect { [Measures].__XLolapslicermembercount } on 0 \r\nfrom [Model] \r\ncell properties value\r\n";
const SLICER_ITEMS = `with\r
 set __XLSlice0 as { [Product].[color].&[Red] }\r
 set __XLSlice1 as { [Measures].[Total Sales], [Measures].[Orders] }\r
 set __XLExistingMembers as \r
NonEmpty(\r
[Product].[size].[size].members,\r
CrossJoin(__XLSlice0,\r
__XLSlice1)\r
)\r
\r
\r
 set __XLExistingRangeMembers as SubSet(__XLExistingMembers, 0, 1000)\r
 set __XLNonExistingRangeMembers as \r
Iif(__XLExistingRangeMembers.Count = 1000, \r
	{},  \r
	SubSet( Except([Product].[size].[size].members, __XLExistingMembers),  \r
			iif (0 - __XLExistingMembers.Count < 0, 0, 0 - __XLExistingMembers.Count), \r
			1000 ) \r
	)\r
member [Measures].__XLRelated as Intersect( [Product].[size].currentmember, __XLExistingRangeMembers ).Count\r
 set __XLTargetSet as SubSet(Union(__XLExistingRangeMembers, __XLNonExistingRangeMembers), 0, 1000)\r
select { [Measures].__XLRelated } on 0, \r
__XLTargetSet on 1 \r
from [Model] \r
cell properties value\r
`;

test("a zoned timestamp is the UTC it's stored in: one key, a date's caption, a literal in a filter, in order", async () => {
  // How the engine hands back a date table's column on a machine at +01, and at +02 in summer.
  const f = fakeQuery(sql => (sql.includes("GROUP BY") ? [{ c0: "2024-07-01 02:00:00+02", m0: 2 }, { c0: "2024-01-15 01:00:00+01", m0: 1 }, { c0: "2024-01-15 11:30:00+01", m0: 3 }] : [{ m0: 6 }]));
  const xml = await execute(`SELECT NON EMPTY Hierarchize({DrilldownLevel({[Calendar].[day].[All]})}) ON COLUMNS FROM [Model] WHERE ([Measures].[Orders])`, { cube: cube(), query: f.query });
  assert.deepEqual(tags(axisOf(xml, "Axis0"), "UName"), [
    "[Calendar].[day].[All]", "[Calendar].[day].&[2024-01-15 00:00:00]", "[Calendar].[day].&[2024-01-15 10:30:00]", "[Calendar].[day].&[2024-07-01 00:00:00]",
  ]);
  assert.deepEqual(tags(axisOf(xml, "Axis0"), "Caption"), ["All", "2024-01-15", "2024-01-15 10:30:00", "2024-07-01"]);
  const g = fakeQuery(() => []);
  await execute(`SELECT FROM [Model] WHERE ([Measures].[Orders], [Calendar].[day].&[2024-01-15 00:00:00])`, { cube: cube(), query: g.query });
  assert.deepEqual(g.asked, [`SELECT AGG("Orders") AS "m0" FROM ${CATALOG} WHERE "Calendar"."day" IN (TIMESTAMP '2024-01-15 00:00:00')`]);
});

test("a slicer's two statements are read as the templates they are", () => {
  assert.deepEqual(slicerTemplate(SLICER_COUNT), { kind: "count", measure: "[Measures].__XLolapslicermembercount", level: "[Product].[size].[size]" });
  const items = slicerTemplate(SLICER_ITEMS);
  assert.equal(items.kind, "items");
  assert.equal(items.level, "[Product].[size].[size]");
  assert.equal(items.measure, "[Measures].__XLRelated");
  assert.deepEqual([items.offset, items.size], [0, 1000]);
  assert.deepEqual(items.slices, ["{ [Product].[color].&[Red] }", "{ [Measures].[Total Sales], [Measures].[Orders] }"]);
  assert.equal(slicerTemplate("SELECT {} ON 0 FROM [Model]"), null);
  assert.equal(slicerTemplate("WITH MEMBER [Measures].[x] AS 1 SELECT {[Measures].[x]} ON 0 FROM [Model]"), null);
});

test("a slicer's count, and its items: those with data under the other fields come first", async () => {
  const f = fakeQuery(() => [{ c0: "L" }, { c0: "S" }, { c0: "XL" }]);
  const count = await execute(SLICER_COUNT, { cube: cube(), query: f.query, literal });
  assert.deepEqual(cellsOf(count), { 0: "3" });
  const g = fakeQuery(sql => (sql.includes("AGG") ? [{ c0: "S", m: 1 }] : [{ c0: "L" }, { c0: "S" }, { c0: "XL" }]));
  const items = await execute(SLICER_ITEMS, { cube: cube(), query: g.query, literal });
  assert.ok(g.asked.includes(`SELECT "Product"."size" AS "c0", AGG("Total Sales") AS "m" FROM ${CATALOG} WHERE "Product"."color" IN ('Red') GROUP BY ALL`), g.asked.join("\n"));
  assert.deepEqual(tags(axisOf(items, "Axis1"), "Caption"), ["S", "L", "XL"]);
  assert.deepEqual(cellsOf(items), { 0: "1", 1: "0", 2: "0" });
});

test("parsing: the axes in order, their properties, and a nested subselect", () => {
  const q = parseSelect("SELECT {[Measures].[Orders]} DIMENSION PROPERTIES PARENT_UNIQUE_NAME,KEY0 ON ROWS, NON EMPTY {[Product].[color].[All]} ON COLUMNS FROM (SELECT ({[Product].[size].&[L]}) ON 0 FROM (SELECT ({[Calendar].[year].&[2024]}) ON AXIS(0) FROM [Model])) CELL PROPERTIES VALUE, FORMAT_STRING");
  assert.deepEqual(q.axes.map(a => [a.number, a.nonEmpty]), [[1, false], [0, true]]);
  assert.deepEqual(q.axes[0].properties, ["PARENT_UNIQUE_NAME", "KEY0"]);
  assert.deepEqual(q.cellProperties, ["VALUE", "FORMAT_STRING"]);
  assert.equal(q.from.sub.from.sub.from.cube, "[Model]");
});

test("cell properties: a format string goes back only when it's asked for", async () => {
  const f = fakeQuery(() => [{ m0: 1 }]);
  const plain = await execute("SELECT  FROM [Model] WHERE ([Measures].[Total Sales]) CELL PROPERTIES VALUE", { cube: cube(), query: f.query });
  assert.ok(!plain.includes("<FormatString>"));
  const formatted = await execute("SELECT  FROM [Model] WHERE ([Measures].[Total Sales]) CELL PROPERTIES VALUE, FORMAT_STRING, BACK_COLOR", { cube: cube(), query: f.query });
  assert.ok(formatted.includes("<FormatString>#,0.00</FormatString>"));
  assert.ok(formatted.includes('<FormatString name="FORMAT_STRING"/>'));
  assert.ok(!formatted.includes("BACK_COLOR"));
});

// -----------------------------------------------------------------------------
// The port
// -----------------------------------------------------------------------------
async function withServer(backend, fn, token = "the-token") {
  let port = 0;
  const server = http.createServer((req, res) => createHandler({ token, port, backend })(req, res));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const ask = ({ method = "POST", path = `/${token}/`, headers = {}, body = "" } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { "Content-Type": "text/xml", ...headers } }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject);
    req.end(body);
  });
  try { await fn(ask, port); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
const noBackend = { cube: async () => { throw new Error("no model"); }, query: async () => { throw new Error("no query"); } };
const ENVELOPE = inner => `<soap:Envelope xmlns:soap="x"><soap:Body>${inner}</soap:Body></soap:Envelope>`;

test("the port: a token, this address, and no browser", async () => {
  await withServer(noBackend, async (ask, port) => {
    assert.equal((await ask({ path: "/wrong/" })).status, 404);
    assert.equal((await ask({ path: "/" })).status, 404);
    assert.equal((await ask({ path: "/the-token/more" })).status, 404);
    assert.equal((await ask({ headers: { Origin: "https://example.com" } })).status, 403);
    assert.equal((await ask({ headers: { Origin: "null" } })).status, 403);
    assert.equal((await ask({ headers: { Host: "rebound.example.com" } })).status, 403);
    assert.equal((await ask({ headers: { Host: `localhost:${port}` } })).status, 403);
    assert.equal((await ask({ method: "PUT" })).status, 405);
    assert.equal((await ask({ headers: { "Content-Type": "application/sx+xpress" } })).status, 415);
    assert.equal((await ask({ headers: { "Content-Type": "application/json" } })).status, 415);
    assert.equal((await ask({ method: "GET" })).body, PING);
  });
});

test("a session: begun, carried, ended; and a failure is a fault Excel can show", async () => {
  await withServer(noBackend, async ask => {
    const begin = await ask({ body: `<soap:Header><BeginSession xmlns="x"/></soap:Header>${ENVELOPE('<Execute><Command><Statement xmlns="x"/></Command></Execute>')}` });
    const id = /SessionId="([^"]+)"/.exec(begin.body)[1];
    assert.ok(id.length > 8);
    const properties = await ask({ body: `<Session SessionId="${id}"/>${ENVELOPE("<Discover><RequestType>DISCOVER_PROPERTIES</RequestType><Restrictions><RestrictionList><PropertyName>ProviderVersion</PropertyName></RestrictionList></Restrictions><Properties><PropertyList><Catalog>c</Catalog></PropertyList></Properties></Discover>")}` });
    assert.ok(properties.body.includes(`SessionId="${id}"`));
    assert.ok(properties.body.includes("<PropertyName>ProviderVersion</PropertyName>"));
    const end = await ask({ body: `<EndSession SessionId="${id}"/>${ENVELOPE('<Execute><Command><Statement xmlns="x"/></Command></Execute>')}` });
    assert.ok(!end.body.includes("Fault"));
    const noCatalog = await ask({ body: ENVELOPE("<Discover><RequestType>MDSCHEMA_CUBES</RequestType></Discover>") });
    assert.ok(noCatalog.body.includes("<soap:Fault>"));
    assert.ok(noCatalog.body.includes("No semantic model named"));
    const failed = await ask({ body: ENVELOPE("<Discover><RequestType>MDSCHEMA_CUBES</RequestType><Properties><PropertyList><Catalog>c</Catalog></PropertyList></Properties></Discover>") });
    assert.equal(failed.status, 200);
    assert.ok(failed.body.includes("no model"));
  });
});

test("Excel dropping a request stops its statement, and the log says which", async () => {
  const said = [];
  let aborted = null;
  const stopped = new Promise(r => { aborted = r; });
  const backend = {
    cube: async () => cube(),
    query: (sql, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => { aborted(); reject(new Error("stopped")); });
    }),
  };
  const token = "t";
  let port = 0;
  const server = http.createServer((req, res) => createHandler({ token, port, backend, log: m => said.push(m) })(req, res));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  try {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/${token}/`, headers: { "Content-Type": "text/xml" } });
    req.on("error", () => {});
    req.end(ENVELOPE(`<Execute><Command><Statement>SELECT  FROM [Model] WHERE ([Measures].[Orders])</Statement></Command><Properties><PropertyList><Catalog>${CATALOG}</Catalog></PropertyList></Properties></Execute>`));
    await new Promise(r => setTimeout(r, 200));
    req.destroy();
    await stopped;
    assert.ok(said.some(m => /Excel dropped the statement SELECT {2}FROM \[Model\]|Excel dropped the statement SELECT FROM \[Model\]/.test(m)), said.join("\n"));
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test("through the port: a model's cube and a statement's answer", async () => {
  const f = fakeQuery(() => [{ m0: 400 }]);
  const backend = { cube: async c => { assert.equal(c, CATALOG); return cube(); }, query: f.query };
  await withServer(backend, async ask => {
    const cubes = await ask({ body: ENVELOPE(`<Discover><RequestType>MDSCHEMA_CUBES</RequestType><Properties><PropertyList><Catalog>${CATALOG}</Catalog></PropertyList></Properties></Discover>`) });
    assert.ok(cubes.body.includes("<CUBE_NAME>Model</CUBE_NAME>"));
    const run = await ask({ body: ENVELOPE(`<Execute><Command><Statement>SELECT  FROM [Model] WHERE ([Measures].[Total Sales]) CELL PROPERTIES VALUE</Statement></Command><Properties><PropertyList><Catalog>${CATALOG}</Catalog></PropertyList></Properties></Execute>`) });
    assert.deepEqual(cellsOf(run.body), { 0: "400" });
    assert.deepEqual(f.asked, [`SELECT AGG("Total Sales") AS "m0" FROM ${CATALOG}`]);
  });
});

// -----------------------------------------------------------------------------
// Opening Excel
// -----------------------------------------------------------------------------
test("the connection string: plain XML, no prompt, and a name with its quotes", () => {
  assert.equal(connectionValue("semanticmodel.ws.model"), "semanticmodel.ws.model");
  assert.equal(connectionValue('semanticmodel."My WS".model'), `'semanticmodel."My WS".model'`);
  assert.equal(connectionValue("a b"), '"a b"');
  assert.equal(connectionValue(`a"b'c`), '"a""b\'c"');
  assert.equal(connectionValue("a;Provider=evil"), '"a;Provider=evil"');
  const s = connectionString({ port: 50000, token: "t", catalog: "semanticmodel.ws.m" });
  assert.equal(s, "OLEDB;Provider=MSOLAP;Data Source=http://127.0.0.1:50000/t/;Initial Catalog=semanticmodel.ws.m;Protocol Format=XML;Transport Compression=None;Prompt=NoPrompt");
});

test("no model's name is ever part of the script: it comes through the environment", async () => {
  assert.ok(!SCRIPT.includes("semanticmodel"));
  const started = [];
  const run = (cmd, args, opts) => {
    started.push({ cmd, args, opts });
    const handlers = {};
    const child = { stderr: { setEncoding() {}, on() {} }, on: (e, f) => { handlers[e] = f; return child; } };
    setImmediate(() => handlers.close(0));
    return child;
  };
  const evil = `x"; Remove-Item C:\\ -Recurse; "`;
  await openInExcel({ port: 1, token: "t", catalog: `semanticmodel.ws."${evil}"`, name: evil }, run);
  const { cmd, args, opts } = started[0];
  assert.equal(cmd, "powershell.exe");
  assert.ok(args.includes("-EncodedCommand"));
  const decoded = Buffer.from(args.at(-1), "base64").toString("utf16le");
  assert.equal(decoded, SCRIPT);
  assert.ok(!decoded.includes("Remove-Item"));
  assert.ok(opts.env.OLS_XMLA_CONNECTION.includes("Remove-Item"), "the name travels as data");
});

test("no Excel on this machine is said in those words", async () => {
  const exits = code => (cmd, args, opts) => {
    const handlers = {};
    const child = { stderr: { setEncoding() {}, on(_, f) { f("boom"); } }, on: (e, f) => { handlers[e] = f; return child; } };
    setImmediate(() => handlers.close(code));
    return child;
  };
  await assert.rejects(openInExcel({ port: 1, token: "t", catalog: "c", name: "n" }, exits(3)), /needs the Excel desktop app/);
  await assert.rejects(openInExcel({ port: 1, token: "t", catalog: "c", name: "n" }, exits(1)), /Excel could not open the PivotTable: boom/);
});

test("Excel's message survives PowerShell's progress blocks around it", async () => {
  const says = text => () => {
    const handlers = {};
    const child = { stderr: { setEncoding() {}, on(_, f) { f(text); } }, on: (e, f) => { handlers[e] = f; return child; } };
    setImmediate(() => handlers.close(1));
    return child;
  };
  const block = '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress"><AV>Preparing modules for first use.</AV></Obj></Objs>';
  const open = text => openInExcel({ port: 1, token: "t", catalog: "c", name: "n" }, says(text));
  await assert.rejects(open(`${block}No data fields are available in the OLAP Cube.\r\n`), /PivotTable: No data fields are available in the OLAP Cube\.$/);
  await assert.rejects(open(`No data fields.\r\n${block}`), /PivotTable: No data fields\.$/);
  await assert.rejects(open(block), /PivotTable: exit code 1$/);
});
