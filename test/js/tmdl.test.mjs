// TMDL read as TMSL by dax-sql (formats/tmdl.js, vendored), as OneLake Studio reads it. The text is cut from the TMDL Fabric's Publish wrote of the
// semantic view nem (app/nem.Lakehouse/SystemContext/Semantic Views/nem/nem.tmdl, 2026-11-19), tabs as Fabric writes them.
import { test } from "node:test";
import assert from "node:assert/strict";

// dax-sql's reader, as vendored: OneLake Studio reads TMDL with it, and this is the TMDL Fabric's Publish writes.
import { m, d, semantic, bundle } from "./daxsql.mjs";
const { tmdlToTmsl } = d;

const WS = "8c945c1a-f25e-4f19-a7ad-c3a7bfbd0fc9", LH = "8775fcab-f8f0-497a-b1d8-7a0cd3133d09";
const NEM = [
  "createOrReplace",
  "",
  "\tdatabase nem",
  "\t\tid: 07b040f0-a78d-4c1f-a775-7b7f7b772ca6",
  "\t\tcompatibilityLevel: 1606",
  "",
  "\t\t/// Australia's National Electricity Market.",
  "\t\tmodel Model",
  "\t\t\tculture: en-US",
  "\t\t\tdefaultPowerBIDataSourceVersion: powerBI_V3",
  "\t\t\tdataAccessOptions",
  "\t\t\t\tlegacyRedirects",
  "\t\t\t\treturnErrorValuesAsNull",
  "",
  "\t\t\t/// One row per day.",
  "\t\t\ttable dim_calendar",
  "\t\t\t\tlineageTag: bb45a182-e985-4203-bd5a-b8262a48b169",
  "\t\t\t\tsourceLineageTag: [mart].[dim_calendar]",
  "",
  "\t\t\t\tcolumn date",
  "\t\t\t\t\tdataType: dateTime",
  "\t\t\t\t\tformatString: General Date",
  "\t\t\t\t\tlineageTag: a3b763ed-0571-4d79-a713-63e6c36afb84",
  "\t\t\t\t\tsummarizeBy: none",
  "\t\t\t\t\tsourceColumn: date",
  "",
  "\t\t\t\t\tannotation SummarizationSetBy = Automatic",
  "",
  "\t\t\t\tpartition dim_calendar = entity",
  "\t\t\t\t\tmode: directLake",
  "\t\t\t\t\tsource",
  "\t\t\t\t\t\tentityName: dim_calendar",
  "\t\t\t\t\t\tschemaName: mart",
  "\t\t\t\t\t\texpressionSource: SemanticViewSource",
  "",
  "\t\t\t\tannotation PBI_ResultType = Table",
  "",
  "\t\t\ttable 'fct summary'",
  "\t\t\t\tcolumn mw",
  "\t\t\t\t\tdataType: double",
  "\t\t\t\t\tisHidden",
  "\t\t\t\t\tsourceColumn: mw",
  "",
  "\t\t\t\tpartition 'fct summary' = entity",
  "\t\t\t\t\tmode: directLake",
  "\t\t\t\t\tsource",
  "\t\t\t\t\t\tentityName: fct_summary",
  "\t\t\t\t\t\tschemaName: mart",
  "\t\t\t\t\t\texpressionSource: SemanticViewSource",
  "",
  "\t\t\ttable Metrics",
  "\t\t\t\tlineageTag: 3bc5ecc5-29b4-4182-a54e-22079eba11aa",
  "",
  "\t\t\t\t/// The units in the selection.",
  "\t\t\t\tmeasure 'Registered units' = COUNTROWS('dim_duid')",
  "\t\t\t\t\tlineageTag: fa324e46-a001-4319-84da-a0483808dbe2",
  "",
  "\t\t\t\tmeasure Label = \"MW\"",
  "\t\t\t\t\tformatString: 0",
  "",
  "\t\t\t\t/// Energy generated.",
  "\t\t\t\tmeasure 'Generation MWh' =",
  "\t\t\t\t\t\tVAR _last = [Newest whole day]",
  "\t\t\t\t\t\tRETURN",
  "",
  "\t\t\t\t\t\t    IF([Reads 5 minutes], 1, 2)",
  "\t\t\t\t\tlineageTag: 18661cd4-655a-42d9-8b82-f8b1d0b5f740",
  "",
  "\t\t\trelationship fct_summary_to_dim_calendar",
  "\t\t\t\tfromColumn: 'fct summary'.mw",
  "\t\t\t\ttoColumn: dim_calendar.date",
  "",
  "\t\t\trelationship inactive",
  "\t\t\t\tisActive: false",
  "\t\t\t\tfromColumn: dim_calendar.date",
  "\t\t\t\ttoColumn: 'fct summary'.'mw'",
  "",
  "\t\t\texpression SemanticViewSource =",
  "\t\t\t\t\tlet",
  `\t\t\t\t\t    Source = AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/${WS}/${LH}", [HierarchicalNavigation=true])`,
  "\t\t\t\t\tin",
  "\t\t\t\t\t    Source",
  "\t\t\t\tlineageTag: 9b8f413e-bf15-4119-a6a9-4e57fcc69e94",
  "",
  "\t\t\t\tannotation PBI_IncludeFutureArtifacts = False",
  "",
  "\t\t\tannotation PBI_QueryOrder = [\"SemanticViewSource\"]",
  "",
].join("\n");

test("Fabric's TMDL of a semantic view is read as the TMSL of its model", () => {
  const bim = tmdlToTmsl(NEM);
  assert.equal(bim.name, "nem");
  assert.equal(bim.compatibilityLevel, 1606);
  assert.equal(bim.model.description, "Australia's National Electricity Market.");
  assert.equal(bim.model.culture, "en-US");
  assert.equal(bim.model.dataAccessOptions, undefined, "an object of no use to the pages is left out");
  assert.deepEqual(bim.model.tables.map(t => t.name), ["dim_calendar", "fct summary", "Metrics"]);

  const [cal, fct, metrics] = bim.model.tables;
  assert.equal(cal.description, "One row per day.");
  assert.equal(cal.lineageTag, undefined, "lineage is left out");
  assert.deepEqual(cal.columns, [{ name: "date", dataType: "dateTime", formatString: "General Date", summarizeBy: "none", sourceColumn: "date" }]);
  assert.deepEqual(cal.partitions, [{ name: "dim_calendar", mode: "directLake",
    source: { type: "entity", entityName: "dim_calendar", schemaName: "mart", expressionSource: "SemanticViewSource" } }]);
  assert.deepEqual(fct.columns, [{ name: "mw", dataType: "double", isHidden: true, sourceColumn: "mw" }], "a flag alone is true");

  assert.deepEqual(metrics.columns, []);
  assert.equal(metrics.partitions, undefined);
  assert.deepEqual(metrics.measures, [
    { name: "Registered units", expression: "COUNTROWS('dim_duid')", description: "The units in the selection." },
    { name: "Label", expression: '"MW"', formatString: "0" },
    { name: "Generation MWh", expression: "VAR _last = [Newest whole day]\nRETURN\n\n    IF([Reads 5 minutes], 1, 2)", description: "Energy generated." },
  ], "an expression keeps its quotes, and one below its line keeps what is past its indentation");

  assert.deepEqual(bim.model.relationships, [
    { name: "fct_summary_to_dim_calendar", fromTable: "fct summary", fromColumn: "mw", toTable: "dim_calendar", toColumn: "date" },
    { name: "inactive", isActive: false, fromTable: "dim_calendar", fromColumn: "date", toTable: "fct summary", toColumn: "mw" },
  ]);
  assert.deepEqual(bim.model.expressions, [{ name: "SemanticViewSource", kind: "m",
    expression: `let\n    Source = AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/${WS}/${LH}", [HierarchicalNavigation=true])\nin\n    Source` }]);
});

test("a .tmdl opens as a model, its lakehouse found from its Direct Lake expression", () => {
  const bim = semantic.bimOf("app.nem/SystemContext/Semantic Views/nem/nem.tmdl", NEM, bundle);
  assert.deepEqual(bim.model.tables.map(t => t.name), ["dim_calendar", "fct summary", "Metrics"]);
  assert.equal(semantic.lakehousesOf(bim).length, 1);
  assert.match(semantic.storageMode(bim), /^Direct Lake on 1 lakehouse/);
  assert.match("nem.Lakehouse/SystemContext/Semantic Views/nem/nem.tmdl".match(semantic.SYSTEM_VIEW_TMDL)[2], /^nem$/);
  assert.equal(semantic.SYSTEM_VIEW_TMDL.test("nem.Lakehouse/SystemContext/Semantic Views/nem/metadata.json"), false);
});

test("a model at the file's root reads as well; a text with no model is refused", () => {
  const bim = tmdlToTmsl("model Model\n\tculture: en-US\n\n\ttable t\n\t\tcolumn a\n\t\t\tdataType: int64\n\t\tcolumn b = [a] * 2\n\t\t\tdataType: int64\n");
  assert.equal(bim.name, "Model");
  assert.deepEqual(bim.model.tables[0].columns, [{ name: "a", dataType: "int64" }, { name: "b", type: "calculated", expression: "[a] * 2", dataType: "int64" }]);
  // One table alone is one file of a Power BI project, not a model: dax-sql's formatOf and readModel say so.
  assert.equal(m.formatOf("t.tmdl", "table t\n\tcolumn a\n"), null);
  assert.throws(() => semantic.bimOf("t.tmdl", "table t\n\tcolumn a\n", bundle), /one file of a Power BI project, not a model/);
});
