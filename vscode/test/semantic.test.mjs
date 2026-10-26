// app/semantic.js: which YAML in Files/ is an Apache Ossie model, and opens as one; where a
// model's Direct Lake tables are read from.
import { test } from "node:test";
import assert from "node:assert/strict";

const { isOssie, isOssiePath, homeOf, directLakeTables } = await import("../app/semantic.js");

test("an Ossie model is told from any other YAML by its text", () => {
  const ossie = "# models/aac/model.bim as Apache Ossie\nversion: 0.2.0.dev0\nname: aac\ndatasets:\n  - name: dim_calendar\n";
  assert.equal(isOssie(ossie), true);
  assert.equal(isOssie("version: 2\nmodels:\n  - name: stg_orders\n"), false, "a dbt schema.yml is a document");
  assert.equal(isOssie("steps:\n  datasets:\n    - x\nversion: 1\n"), false, "datasets must be at the top level");
  assert.equal(isOssie(""), false);
});

test("a .yaml or .yml is read as Ossie, anything else as TMSL", () => {
  assert.equal(isOssiePath("Files/m/aac.yaml"), true);
  assert.equal(isOssiePath("abfss://ws@onelake.dfs.fabric.microsoft.com/lh/Files/A.YML"), true);
  assert.equal(isOssiePath("C:/models/ws/Sales.bim"), false);
});

// A Direct Lake model as deployed names its lakehouse by GUIDs; before deploy it holds
// placeholders, and its tables are read from the lakehouse its file is in.
const model = url => ({ model: {
  expressions: [{ name: "DirectLake", expression: ["let", `Source = AzureStorage.DataLake("${url}")`, "in", "Source"] }],
  tables: [{ name: "fct", partitions: [{ source: { type: "entity", entityName: "fct", schemaName: "mart", expressionSource: "DirectLake" } }] },
           { name: "calc", partitions: [{ source: { type: "calculated" } }] }],
} });

test("a deployed model's tables are in the lakehouse its expression names", () => {
  const ws = "11111111-2222-3333-4444-555555555555", lh = "AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee";
  const t = directLakeTables(model(`https://onelake.dfs.fabric.microsoft.com/${ws}/${lh}`), { workspace: "x", item: "y.Lakehouse" });
  assert.deepEqual([...t.keys()], ["fct"]);
  assert.deepEqual(t.get("fct").lh, { workspace: ws, item: lh.toLowerCase() });
  assert.equal(t.get("fct").ident, '"mart_aaaaaaaa"."fct"');
});

test("an undeployed model's tables are in the lakehouse its file is in, if any", () => {
  const bim = model("https://onelake.dfs.fabric.microsoft.com/{WS_ID}/{LH_ID}");
  assert.equal(directLakeTables(bim).size, 0, "a local file has no lakehouse to read from");
  const home = homeOf("abfss://nem@onelake.dfs.fabric.microsoft.com/nem.Lakehouse/Files/m/ossie.yaml");
  assert.deepEqual(home, { workspace: "nem", item: "nem.Lakehouse" });
  const t = directLakeTables(bim, home);
  assert.deepEqual(t.get("fct").lh, home);
  assert.deepEqual(t.get("fct").t, { schema: "mart", table: "fct" });
  assert.equal(t.get("fct").ident, '"mart_nem"."fct"');
  assert.equal(homeOf("C:/models/ws/Sales.bim"), null);
});
