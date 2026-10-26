// agent.js: the command line's answers that need no engine — what is on screen, and the SQL
// rewrites that let it re-read what the panel read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createAgent, filesToAbfss, withView, panelToAgentSql } = require("../src/agent.js");

test("'Files/…' with --in is the lakehouse's file, by its abfss:// name", () => {
  const lh = { workspace: "my ws", item: "data.Lakehouse" };
  assert.equal(filesToAbfss("SELECT * FROM read_parquet('Files/a/x.parquet')", lh),
    "SELECT * FROM read_parquet('abfss://my ws@onelake.dfs.fabric.microsoft.com/data.Lakehouse/Files/a/x.parquet')");
  assert.equal(filesToAbfss("SELECT '/Files/it''s.csv'", lh),
    "SELECT 'abfss://my ws@onelake.dfs.fabric.microsoft.com/data.Lakehouse/Files/it''s.csv'");
  assert.equal(filesToAbfss("SELECT 'Tables/x', 'my Files/x'", lh), "SELECT 'Tables/x', 'my Files/x'", "only a path that starts there");
});

test("a panel view is bound for one statement, merged into its own WITH", () => {
  assert.equal(withView('SELECT * FROM "v" LIMIT 5;', '"v"', "SELECT 1 AS a"),
    'WITH "v" AS (SELECT 1 AS a)\nSELECT * FROM "v" LIMIT 5');
  assert.equal(withView('with t AS (SELECT * FROM "v") SELECT * FROM t', '"v"', "SELECT 1"),
    'with "v" AS (SELECT 1), t AS (SELECT * FROM "v") SELECT * FROM t');
});

test("the panel's table name becomes the command line's", () => {
  const lh = { workspace: "testing", item: "data.Lakehouse" };
  const t = { schema: "mart", table: "fct_summary" };
  assert.equal(panelToAgentSql('SELECT * FROM "mart"."fct_summary" f JOIN mart.fct_summary_daily d USING (x)', lh, t),
    'SELECT * FROM data_mart."fct_summary" f JOIN mart.fct_summary_daily d USING (x)');
  assert.equal(panelToAgentSql("select count(*) from MART.FCT_SUMMARY", lh, t), 'select count(*) from data_mart."fct_summary"');
});

test("screen: the newest window's panel, as markdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const agent = createAgent({ screenDir: dir });
    let r = await agent.run({ args: ["screen"] });
    assert.match(r.out, /Nothing is open/);

    await writeFile(join(dir, "panel-1.json"), JSON.stringify({
      updated: "2026-01-01T00:00:00Z", open: { kind: "table", workspace: "old", item: "x.Lakehouse", table: "t" } }));
    await writeFile(join(dir, "panel-2.json"), JSON.stringify({
      updated: "2026-01-02T00:00:00Z",
      open: { kind: "model", name: "sales", workspace: "ws", model: "Sales", cli: { model: "model ws Sales" } },
      model: { page: "explore", explore: { dax: "EVALUATE x", rows: 72, fields: ["d", "v"],
        sample: [{ d: "2026-01-01", v: 1 }, { d: "2026-01-02", v: 2 }] } } }));
    r = await agent.run({ args: ["screen"] });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /semantic model sales \(ws\/Sales\)/);
    assert.match(r.out, /## Explore \(in front\)/);
    assert.match(r.out, /```dax\nEVALUATE x\n```/);
    assert.match(r.out, /\| 2026-01-02 \| 2 \|/);
    assert.match(r.out, /72 row\(s\), first 2 saved — `screen --rerun`/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
