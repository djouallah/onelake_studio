// core/models/semanticview.js: a semantic model as a Fabric semantic view, in the format Fabric's Publish reads
// (https://learn.microsoft.com/en-us/fabric/fundamentals/semantic-views-yaml-reference).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { viewOf, viewFile, viewDir, freeName, daxRefs, VERSION } = require("../../core/models/semanticview.js");
const semantic = await import("../../page/semantic.js");

const WS = "91588e42-0f1c-4e56-bcaa-cbf015b8f312", LH = "d77983f0-61d2-4d37-b143-f1841f07a3f2";
const lake = (ws = WS, lh = LH) => ({
  name: "SemanticViewSource",
  expression: ["let", `    Source = AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/${ws}/${lh}", [HierarchicalNavigation=true])`, "in", "    Source"],
});
const part = (table, schema = "mart", expr = "SemanticViewSource") =>
  [{ name: table, mode: "directLake", source: { type: "entity", entityName: table, schemaName: schema, expressionSource: expr } }];
const col = (name, dataType, more = {}) => ({ name, dataType, sourceColumn: name, ...more });

// The model Fabric's Publish made of the view below (its TMDL in SystemContext/, as TMSL): exported, it gives
// that view back.
const published = {
  name: "studio_spike",
  model: {
    description: "NEM dispatch, a spike of OneLake Studio.",
    tables: [
      { name: "fct_summary", description: "Five-minute dispatch per unit.", partitions: part("fct_summary"),
        columns: [col("TimeHHMM", "int64", { formatString: "0" }), col("DUID", "string"), col("RegionID", "string"),
                  col("MW", "double"), col("Price", "double"), col("DateKey", "int64", { formatString: "0" })] },
      { name: "dim_duid", description: "One row per dispatchable unit.", partitions: part("dim_duid"),
        columns: [col("DUID", "string"), col("RegionID", "string"), col("FuelSource", "string")] },
      { name: "dim_calendar", description: "One row per day.", partitions: part("dim_calendar"),
        columns: [col("DateKey", "int64", { formatString: "0" }), col("date", "dateTime", { formatString: "General Date" })] },
      { name: "Metrics", measures: [
        { name: "Total MW", description: "Sum of dispatched MW.", expression: "SUM('fct_summary'[MW])" },
        { name: "Avg Price", description: "Average price.", expression: "AVERAGE('fct_summary'[Price])" },
        { name: "MW per Unit", description: "Total MW over the number of units.", expression: "DIVIDE([Total MW], DISTINCTCOUNT('fct_summary'[DUID]))" },
      ] },
    ],
    relationships: [
      { name: "summary_to_duid", fromTable: "fct_summary", fromColumn: "DUID", toTable: "dim_duid", toColumn: "DUID" },
      { name: "summary_to_calendar", fromTable: "fct_summary", fromColumn: "DateKey", toTable: "dim_calendar", toColumn: "DateKey" },
    ],
    expressions: [lake()],
  },
};

test("the model Fabric published from a view exports as that view", () => {
  const v = viewOf(published, "studio_spike", semantic);
  assert.deepEqual(v.lake, { workspace: WS, item: LH });
  assert.deepEqual(v.doc, {
    version: "0.2.0.dev0",
    name: "studio_spike",
    description: "NEM dispatch, a spike of OneLake Studio.",
    datasets: [
      { name: "fct_summary", source: "mart.fct_summary", description: "Five-minute dispatch per unit." },
      { name: "dim_duid", source: "mart.dim_duid", description: "One row per dispatchable unit." },
      { name: "dim_calendar", source: "mart.dim_calendar", description: "One row per day." },
    ],
    relationships: [
      { name: "summary_to_duid", from: "fct_summary", to: "dim_duid", from_columns: ["DUID"], to_columns: ["DUID"] },
      { name: "summary_to_calendar", from: "fct_summary", to: "dim_calendar", from_columns: ["DateKey"], to_columns: ["DateKey"] },
    ],
    metrics: [
      { name: "Total MW", description: "Sum of dispatched MW.", expression: { dialects: [{ dialect: "DAX", expression: "SUM('fct_summary'[MW])" }] } },
      { name: "Avg Price", description: "Average price.", expression: { dialects: [{ dialect: "DAX", expression: "AVERAGE('fct_summary'[Price])" }] } },
      { name: "MW per Unit", description: "Total MW over the number of units.",
        expression: { dialects: [{ dialect: "DAX", expression: "DIVIDE([Total MW], DISTINCTCOUNT('fct_summary'[DUID]))" }] } },
    ],
  });
  assert.equal(VERSION, "0.2.0.dev0");
  assert.deepEqual(v.dropped, ["4 column format strings"], "what a view has no place for is said");
});

test("columns are named as the lake names them, and what a view can't hold is dropped and said", () => {
  const bim = { model: {
    tables: [
      { name: "Sales", partitions: part("fact_sales", "dbo"),
        columns: [col("Amount", "double", { sourceColumn: "amt", formatString: "#,0" }), col("Unit", "string", { sourceColumn: "duid" }),
                  { name: "Doubled", dataType: "double", type: "calculated", expression: "[Amount] * 2" }],
        hierarchies: [{ name: "h" }],
        measures: [
          { name: "Total", expression: "SUM(Sales[Amount]) // Sales[Ignored] in a comment", formatString: "#,0" },
          { name: "Row sum", expression: "SUMX('Sales', [Amount] + 1) & \"'Sales'[Amount]\"" },
          { name: "Twice", expression: "SUM('Sales'[Doubled])" },
          { name: "Uses twice", expression: "[Twice] + 1" },
          { name: "Dated", expression: "DATE(2024, 1, 1)" },
        ] },
      { name: "Unit", partitions: part("dim_unit", "dbo"), columns: [col("DUID", "string")] },
      { name: "Calc", partitions: [{ name: "Calc", source: { type: "calculated", expression: "ROW(\"a\", 1)" } }], columns: [] },
    ],
    relationships: [
      { name: "r1", fromTable: "Sales", fromColumn: "Unit", toTable: "Unit", toColumn: "DUID" },
      { name: "r2", fromTable: "Sales", fromColumn: "Unit", toTable: "Unit", toColumn: "DUID", isActive: false },
    ],
    roles: [{ name: "Readers" }],
    expressions: [lake()],
  } };
  const v = viewOf(bim, "sales", semantic);
  assert.deepEqual(v.doc.datasets, [{ name: "Sales", source: "dbo.fact_sales" }, { name: "Unit", source: "dbo.dim_unit" }]);
  assert.deepEqual(v.doc.relationships, [{ name: "r1", from: "Sales", to: "Unit", from_columns: ["duid"], to_columns: ["DUID"] }]);
  const dax = Object.fromEntries(v.doc.metrics.map(m => [m.name, m.expression.dialects[0].expression]));
  assert.deepEqual(dax, {
    Total: "SUM('Sales'[amt]) // Sales[Ignored] in a comment",
    "Row sum": "SUMX('Sales', [amt] + 1) & \"'Sales'[Amount]\"",
    Dated: "DATE(2024, 1, 1)",
  });
  for (const said of ["table Calc (a calculated table)", "calculated column Sales[Doubled]", "inactive relationship Sales[Unit] -> Unit[DUID]",
    "role Readers", "1 hierarchy", "1 column format string", "1 measure format string"]) {
    assert.ok(v.dropped.includes(said), said);
  }
  assert.ok(v.dropped.some(d => d.startsWith("measure [Twice]: it names Sales[Doubled]")), v.dropped.join("\n"));
  assert.ok(v.dropped.some(d => d.startsWith("measure [Uses twice]: it uses [Twice]")), v.dropped.join("\n"));
});

test("a model that is not Direct Lake on one lakehouse has no view, and says why", () => {
  const imported = { model: { tables: [{ name: "t", partitions: [{ name: "t", mode: "import", source: { type: "m", expression: "x" } }], columns: [] }] } };
  assert.match(viewOf(imported, "m", semantic).refused, /m is an Import model: a semantic view is Direct Lake/);
  const two = { model: {
    tables: [{ name: "a", partitions: part("a", "dbo", "one"), columns: [] }, { name: "b", partitions: part("b", "dbo", "two"), columns: [] }],
    expressions: [{ ...lake(), name: "one" }, { ...lake(WS, "11111111-2222-3333-4444-555555555555"), name: "two" }],
  } };
  assert.match(viewOf(two, "m", semantic).refused, /reads 2 lakehouses: a semantic view reads one lakehouse/);
  // A table named Metrics is a dataset like any other: whether it clashes with Fabric's Metrics is Publish's to say.
  const metrics = { model: { tables: [{ name: "Metrics", partitions: part("metrics"), columns: [col("x", "int64")] }], expressions: [lake()] } };
  assert.deepEqual(viewOf(metrics, "m", semantic).doc.datasets, [{ name: "Metrics", source: "mart.metrics" }]);
});

test("a view's folder and file are named as Fabric's New semantic view names them, and Keep Both finds a free name", () => {
  assert.equal(viewDir("sales"), "Semantic Views/sales");
  assert.equal(viewFile("sales"), "Semantic Views/sales/sales_semantic_view.yaml");
  assert.equal(freeName("sales", ["other"]), "sales");
  assert.equal(freeName("sales", ["Sales", "sales (2)"]), "sales (3)");
});

test("a DAX expression's references skip its strings and comments", () => {
  const refs = daxRefs("SUM('a b'[c]) + \"[x]\" /* T[y] */ + T[z] -- [w]\n+ [m]");
  assert.deepEqual(refs.filter(r => r.column || r.name).map(r => r.column ?? r.name), ["c", "z", "m"]);
});

test("a description of several lines is written on several lines", () => {
  const bim = { model: { description: ["one", "two"], tables: [{ name: "t", description: ["a", "b"], partitions: part("t"), columns: [col("x", "int64")],
    measures: [{ name: "m", description: ["c", "d"], expression: "SUM('t'[x])" }] }], expressions: [lake()] } };
  const v = viewOf(bim, "v", semantic);
  assert.equal(v.doc.description, "one\ntwo");
  assert.equal(v.doc.datasets[0].description, "a\nb");
  assert.equal(v.doc.metrics[0].description, "c\nd");
});

// page/semantic.js fabricViewBim: a Fabric semantic view read back as the model Fabric's Publish makes of it. Its YAML
// is given here as JSON, which is YAML too: the unit tests have no YAML library.
const asModules = { parseYaml: JSON.parse, createViews: () => ({}) };
const lakeColumns = {
  "mart.fct_summary": [{ name: "DUID", type: "string" }, { name: "MW", type: "double" }, { name: "DateKey", type: "long" },
                       { name: "geo", type: { type: "struct", fields: [] } }],
  "mart.dim_duid": [{ name: "DUID", type: "string" }, { name: "Fuel", type: "string" }],
};
const columnsOf = async (schema, table) => lakeColumns[`${schema}.${table}`] || [];
const fileOf = (name, doc) => ({ path: `data.Lakehouse/Context/Semantic Views/v/${name}`, text: JSON.stringify(doc) });

test("a view's files are merged, its tables take the lake's columns, and its metrics are a table of their own", async () => {
  const bim = await semantic.fabricViewBim("v", [
    fileOf("schema.yaml", { version: "0.2.0.dev0", name: "v", description: "d", datasets: [
      { name: "fct", source: "mart.fct_summary" }, { name: "duid", source: "mart.dim_duid", description: "units" }],
      relationships: [{ name: "r", from: "fct", to: "duid", from_columns: ["DUID"], to_columns: ["DUID"] }] }),
    fileOf("metrics.yaml", { version: "0.2.0.dev0", name: "v", metrics: [
      { name: "Total", expression: { dialects: [{ dialect: "DAX", expression: "SUM('fct'[MW])" }] } },
      { name: "Sql only", expression: { dialects: [{ dialect: "ANSI_SQL", expression: "SUM(MW)" }] } }] }),
  ], { lakehouse: "data", columnsOf }, asModules);
  assert.equal(bim.model.description, "d");
  assert.deepEqual(bim.model.tables.map(t => t.name), ["fct", "duid", "Metrics"]);
  assert.deepEqual(bim.model.tables[0].columns.map(c => [c.name, c.dataType]), [["DUID", "string"], ["MW", "double"], ["DateKey", "int64"]],
    "a nested column has no TMSL type, and is left out");
  assert.deepEqual(bim.model.tables[0].partitions[0].source, { type: "entity", entityName: "fct_summary", schemaName: '"data"."mart"' });
  assert.deepEqual(semantic.lakehousesOf(bim, "ws"), [{ workspaceName: "ws", itemName: "data" }], "named in its workspace, as a model's tables are");
  assert.deepEqual(bim.model.tables[2].measures, [{ name: "Total", expression: "SUM('fct'[MW])" }], "a metric with no DAX is left out, as Fabric leaves it");
  assert.deepEqual(bim.model.relationships, [{ name: "r", fromTable: "fct", fromColumn: "DUID", toTable: "duid", toColumn: "DUID" }]);
});

test("a view written in Ossie 0.3 opens: what Publish refuses of it is its YAML's to show", async () => {
  const bim = await semantic.fabricViewBim("v", [fileOf("a.yaml", { version: "0.3.0.dev0", name: "v",
    datasets: [{ name: "duid", source: "mart.dim_duid", nonportable_extensions: [{ vendor_name: "POWER_BI", data: { x: 1 } }] }] })],
  { lakehouse: "data", columnsOf }, asModules);
  assert.deepEqual(bim.model.tables.map(t => t.name), ["duid"]);
});

test("what leaves nothing to open in a view is said, by its file", async () => {
  const open = files => semantic.fabricViewBim("v", files, { lakehouse: "data", columnsOf }, asModules);
  await assert.rejects(open([]), /v has no \.yaml file/);
  await assert.rejects(open([fileOf("a.yaml", { version: "0.4.0.dev0", name: "v" })]),
    /a\.yaml is version 0\.4\.0\.dev0: a Fabric semantic view is 0\.2\.0\.dev0 or 0\.3\.0\.dev0/);
  await assert.rejects(open([fileOf("a.yaml", { version: "0.2.0.dev0", name: "v", datasets: [{ name: "x", source: "mart.gone" }] })]),
    /data has no table mart\.gone/);
  assert.match("data.Lakehouse/Context/Semantic Views/sales/sub/a.yaml".match(semantic.FABRIC_VIEW_PATH)[2], /^sales$/);
});

test("what Publish refuses but a model can do without, a view opens without: its YAML shows it in red", async () => {
  const bim = await semantic.fabricViewBim("v", [
    fileOf("a.yaml", { version: "0.2.0.dev0", name: "v",
      datasets: [{ name: "duid", source: "mart.dim_duid" }, { name: "q", source: "SELECT 1" }, { name: "fct", source: "mart.fct_summary" }],
      relationships: [
        { name: "r", from: "fct", to: "duid", from_columns: ["DUID"], to_columns: ["DUID"] },
        { name: "two", from: "fct", to: "duid", from_columns: ["DUID", "MW"], to_columns: ["DUID", "Fuel"] },
        { name: "to q", from: "fct", to: "q", from_columns: ["DUID"], to_columns: ["x"] }],
      metrics: [{ name: "Total", expression: { dialects: [{ dialect: "DAX", expression: "SUM('fct'[MW])" }] } },
                { name: "FCT", expression: { dialects: [{ dialect: "DAX", expression: "1" }] } }] }),
    fileOf("b.yaml", { version: "0.2.0.dev0", name: "v", datasets: [{ name: "DUID", source: "mart.fct_summary" }],
      metrics: [{ name: "total", expression: { dialects: [{ dialect: "DAX", expression: "2" }] } }] }),
  ], { lakehouse: "data", columnsOf }, asModules);
  assert.deepEqual(bim.model.tables.map(t => t.name), ["duid", "fct", "Metrics"], "a query source and a name given again are left out");
  assert.deepEqual(bim.model.relationships.map(r => r.name), ["r"], "so are a relationship of two columns and one to a dataset left out");
  assert.deepEqual(bim.model.tables[2].measures.map(m => [m.name, m.expression]), [["Total", "SUM('fct'[MW])"]],
    "the first of a name is kept; a metric named as a dataset is left out");
});
