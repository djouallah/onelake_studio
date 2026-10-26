// agent.js: the command line's SQL rewrites, which need no engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { filesToAbfss } = require("../src/agent.js");

test("'Files/…' with --in is the lakehouse's file, by its abfss:// name", () => {
  const lh = { workspace: "my ws", item: "data.Lakehouse" };
  assert.equal(filesToAbfss("SELECT * FROM read_parquet('Files/a/x.parquet')", lh),
    "SELECT * FROM read_parquet('abfss://my ws@onelake.dfs.fabric.microsoft.com/data.Lakehouse/Files/a/x.parquet')");
  assert.equal(filesToAbfss("SELECT '/Files/it''s.csv'", lh),
    "SELECT 'abfss://my ws@onelake.dfs.fabric.microsoft.com/data.Lakehouse/Files/it''s.csv'");
  assert.equal(filesToAbfss("SELECT 'Tables/x', 'my Files/x'", lh), "SELECT 'Tables/x', 'my Files/x'", "only a path that starts there");
});
