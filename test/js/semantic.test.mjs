// app/semantic.js: which YAML in Files/ is an Apache Ossie model, and opens as one.
import { test } from "node:test";
import assert from "node:assert/strict";

const { isOssie, isOssiePath } = await import("../../app/semantic.js");

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

test("only a statement about a semantic model waits for the views", async () => {
  const { aboutModels } = await import("../../app/semantic.js");
  for (const sql of ['SELECT AGG("x") FROM SemanticModel.ws.m', "SHOW SEMANTIC VIEWS", "show semantic metrics in semanticmodel.ws.m",
                     "DESCRIBE semanticmodel.ws.m"]) assert.equal(aboutModels(sql), true, sql);
  // Nor is a shorter name a model's.
  for (const sql of ["SHOW ALL TABLES;", "SELECT * FROM lakehouse.w.lh.dbo.t", "SELECT 1", "SELECT AGG(Total) FROM shop", "DESCRIBE ws.SHOP"]) {
    assert.equal(aboutModels(sql), false, sql);
  }
});

// A semantic model's one SQL name, and the ones a statement names that are not open yet.
test("a model is semanticmodel.ws.model, and a statement's unopened models are found", async () => {
  const { modelSqlName, unopenedModels, defineView } = await import("../../app/semantic.js");
  assert.equal(modelSqlName("a ws", "Sales"), 'semanticmodel."a ws".Sales');
  assert.deepEqual(unopenedModels('SELECT AGG(x) FROM SemanticModel."a ws"."Sales Model" JOIN semanticmodel.b.c ON 1=1'),
    [{ workspace: "a ws", model: "Sales Model" }, { workspace: "b", model: "c" }]);
  // Each once; not in a string or a comment; a table's name is not a model's.
  assert.deepEqual(unopenedModels("SELECT * FROM semanticmodel.w.m, semanticmodel . w . M"), [{ workspace: "w", model: "m" }]);
  assert.deepEqual(unopenedModels("SELECT 'semanticmodel.w.m' -- semanticmodel.w.m\n/* semanticmodel.w.m */"), []);
  assert.deepEqual(unopenedModels("SELECT * FROM lakehouse.w.lh.dbo.t"), []);
  await assert.rejects(defineView("Sales", "Sales.bim", "{}"), /semanticmodel\.<workspace>\.<model>: Sales has no workspace/);
});
