// app/semantic.js: which YAML in Files/ is an Apache Ossie model, and opens as one.
import { test } from "node:test";
import assert from "node:assert/strict";

const { isOssie, isOssiePath } = await import("../app/semantic.js");

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
