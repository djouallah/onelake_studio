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
