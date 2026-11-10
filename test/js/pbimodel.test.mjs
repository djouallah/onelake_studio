// pbimodel.js: the semantic model Export to Fabric makes of a model file, in Direct Lake and
// DirectQuery. Pure: the TMSL, and the definition as the Fabric API takes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { semanticTmsl, definitionOf } = require("../../fabric_app/export/pbimodel.js");

const WS = "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0", LH = "11111111-2222-3333-4444-555555555555";
// An Ossie model as ossieToTmsl writes it: tables named nem.mart.<table>, no expression.
const bim = () => ({ model: {
  defaultMode: "directLake",
  tables: [
    { name: "fct_sales", columns: [{ name: "amount", sourceColumn: "amount", dataType: "double" }],
      partitions: [{ name: "fct_sales", source: { type: "entity", schemaName: "nem.mart", entityName: "fct_sales" } }],
      measures: [{ name: "Sales", expression: "SUM(fct_sales[amount])" }] },
    { name: "Dates", columns: [{ name: "Date", type: "calculatedTableColumn" }],
      partitions: [{ name: "Dates", source: { type: "calculated", expression: "CALENDARAUTO()" } }] },
  ],
} });
const TABLES = [["fct_sales", "mart.fct_sales"]];

test("Direct Lake: each table an entity partition through one OneLake expression; calculated tables kept", () => {
  const t = semanticTmsl(bim(), "directLake", { name: "sales", tables: TABLES, lake: { workspace: WS, item: LH } });
  assert.equal(t.name, "sales");
  assert.equal(t.compatibilityLevel, 1604);
  assert.equal(t.model.defaultMode, undefined);
  assert.deepEqual(t.model.tables[0].partitions, [{ name: "fct_sales", mode: "directLake",
    source: { type: "entity", entityName: "fct_sales", schemaName: "mart", expressionSource: "DatabaseQuery" } }]);
  assert.deepEqual(t.model.tables[1].partitions, bim().model.tables[1].partitions);
  assert.equal(t.model.expressions.length, 1);
  assert.equal(t.model.expressions[0].name, "DatabaseQuery");
  assert.match(t.model.expressions[0].expression.join("\n"),
    /AzureStorage\.DataLake\("https:\/\/onelake\.dfs\.fabric\.microsoft\.com\/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\/11111111-2222-3333-4444-555555555555", \[HierarchicalNavigation=true\]\)/);
  assert.equal(t.model.tables[0].measures[0].expression, "SUM(fct_sales[amount])", "measures as they are");
});

test("DirectQuery: each table an M partition over the lakehouse's SQL endpoint, and no expression", () => {
  const t = semanticTmsl(bim(), "directQuery", { name: "sales", tables: TABLES,
    sqlEndpoint: { host: "x.datawarehouse.fabric.microsoft.com", database: "nem" } });
  const [p] = t.model.tables[0].partitions;
  assert.equal(p.mode, "directQuery");
  assert.equal(p.source.type, "m");
  assert.match(p.source.expression.join("\n"), /Sql\.Database\("x\.datawarehouse\.fabric\.microsoft\.com", "nem"\)/);
  assert.match(p.source.expression.join("\n"), /Source\{\[Schema="mart",Item="fct_sales"\]\}\[Data\]/);
  assert.equal(t.model.expressions, undefined);
});

test("Direct Lake refuses a calculated column, which DirectQuery keeps", () => {
  const b = bim();
  b.model.tables[0].columns.push({ name: "double", type: "calculated", expression: "fct_sales[amount] * 2" });
  assert.throws(() => semanticTmsl(b, "directLake", { name: "s", tables: TABLES, lake: { workspace: WS, item: LH } }),
    /no calculated columns, and the model has fct_sales\[double\]: export it as DirectQuery/);
  const t = semanticTmsl(b, "directQuery", { name: "s", tables: TABLES, sqlEndpoint: { host: "h", database: "d" } });
  assert.equal(t.model.tables[0].columns[1].expression, "fct_sales[amount] * 2");
});

test("what each mode needs, said", () => {
  assert.throws(() => semanticTmsl(bim(), "import", { name: "s", tables: TABLES }), /no storage mode import/);
  assert.throws(() => semanticTmsl(bim(), "directLake", { name: "s", tables: TABLES }), /lakehouse by its GUIDs/);
  assert.throws(() => semanticTmsl(bim(), "directQuery", { name: "s", tables: TABLES }), /SQL endpoint/);
  assert.throws(() => semanticTmsl(bim(), "directQuery", { name: "s", tables: [], sqlEndpoint: { host: "h", database: "d" } }), /no table/);
});

test("the definition: model.bim and definition.pbism, base64", () => {
  const t = semanticTmsl(bim(), "directLake", { name: "sales", tables: TABLES, lake: { workspace: WS, item: LH } });
  const { parts } = definitionOf(t);
  assert.deepEqual(parts.map(p => [p.path, p.payloadType]), [["model.bim", "InlineBase64"], ["definition.pbism", "InlineBase64"]]);
  assert.deepEqual(JSON.parse(Buffer.from(parts[0].payload, "base64").toString("utf8")), t);
  assert.equal(JSON.parse(Buffer.from(parts[1].payload, "base64").toString("utf8")).version, "4.0");
});
