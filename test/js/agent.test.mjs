// agent.js: the command line's SQL rewrites and answers, which need no engine, called directly.
// What an agent's shell sees of them, the process and its exit code, is cli.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fakeOneLake, richAgent, stubVendor, APP_DIR } from "./agent-fixtures.mjs";

const require = createRequire(import.meta.url);
const { filesToAbfss } = require("../../src/agent.js");
const { EXIT } = require("../../src/bridge.js");

test("'Files/…' with --in is the lakehouse's file, by its abfss:// name", () => {
  const lh = { workspace: "my ws", item: "data.Lakehouse" };
  assert.equal(filesToAbfss("SELECT * FROM read_parquet('Files/a/x.parquet')", lh),
    "SELECT * FROM read_parquet('abfss://my ws@onelake.dfs.fabric.microsoft.com/data.Lakehouse/Files/a/x.parquet')");
  assert.equal(filesToAbfss("SELECT '/Files/it''s.csv'", lh),
    "SELECT 'abfss://my ws@onelake.dfs.fabric.microsoft.com/data.Lakehouse/Files/it''s.csv'");
  assert.equal(filesToAbfss("SELECT 'Tables/x', 'my Files/x'", lh), "SELECT 'Tables/x', 'my Files/x'", "only a path that starts there");
});

test("models and items --fresh: every workspace read now, and one that fails is a note", async () => {
  const { createAgent } = require("../../src/agent.js");
  const onelake = {
    workspaces: async () => ["b ws", "a ws", "broken"],
    models: async w => {
      if (w === "broken") throw Object.assign(new Error("Unauthorized"), { status: 401 });
      return w === "a ws" ? [{ name: "Sales", description: "the sales model" }, { name: "Ops", description: "" }]
                          : [{ name: "Energy", description: "" }];
    },
    items: async w => (w === "broken" ? [] : [{ name: `${w[0]}.Lakehouse`, kind: "Lakehouse" }, { name: "dw.Warehouse", kind: "Warehouse" }]),
  };
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/x.bim" });
  const fresh = { fresh: true };

  let r = await agent.run({ args: ["models"], opts: fresh });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /3 semantic model\(s\) in 2 workspace\(s\); 1 could not be read$/);
  assert.match(r.err, /broken: not listed/);
  assert.match(r.err, /sign in to Fabric/);
  assert.doesNotMatch(r.err, /from the cache/, "read now, not off disk");

  r = await agent.run({ args: ["models", "b ws"], opts: fresh });
  assert.match(r.out, /1 semantic model\(s\) in 1 workspace\(s\)$/);

  r = await agent.run({ args: ["items"], opts: fresh });
  assert.match(r.out, /4 item\(s\): 2 Lakehouse, 2 Warehouse$/);
});

test("models and items: every cached workspace, counted, and nothing fetched", async () => {
  const { createAgent } = require("../../src/agent.js");
  const onelake = fakeOneLake();
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/x.bim" });

  let r = await agent.run({ args: ["models"] });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\| a ws \| Ops \|[\s\S]*\| a ws \| Sales \|[\s\S]*\| b ws \| Energy \|/, "sorted by workspace, then name");
  assert.match(r.out, /3 semantic model\(s\) in 2 workspace\(s\); 1 workspace\(s\) not cached$/);
  assert.match(r.err, /not cached yet, so not counted: unseen/);
  assert.match(r.err, /as of 3 h ago/);

  r = await agent.run({ args: ["items"] });
  assert.match(r.out, /3 item\(s\): 2 Lakehouse, 1 Warehouse; 1 workspace\(s\) not cached$/);

  r = await agent.run({ args: ["models"], opts: { csv: true } });
  assert.equal(r.out.split("\n")[0], "workspace,semantic_model,downloaded,tables,measures,description");

  assert.deepEqual(onelake.calls, [], "no OneLake or Fabric call without --fresh");
});

test("a listing or metadata not cached says so; --fresh is what reads it", async () => {
  const { createAgent } = require("../../src/agent.js");
  const onelake = fakeOneLake();
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/x.bim" });

  let r = await agent.run({ args: ["ls", "unseen"] });
  assert.equal(r.code, EXIT.NOT_CACHED);
  assert.match(r.err, /not cached yet — expand unseen in the OneLake Studio tree, or add --fresh/);

  r = await agent.run({ args: ["ls", "a ws", "a"] });
  assert.equal(r.code, EXIT.NOT_CACHED);
  assert.match(r.err, /a ws\/a\.Lakehouse's tables is not cached yet/);

  r = await agent.run({ args: ["table", "a ws", "a", "dbo.x"] });
  assert.equal(r.code, EXIT.NOT_CACHED);
  assert.match(r.err, /dbo\.x's metadata is not cached yet/);

  r = await agent.run({ args: ["model", "a ws", "Sales"] });
  assert.equal(r.code, EXIT.NOT_CACHED);
  assert.match(r.err, /a ws\/Sales is not downloaded yet — open it in the OneLake Studio tree, or add --fresh/);
  assert.deepEqual(onelake.calls, []);

  r = await agent.run({ args: ["ls"], opts: { fresh: true } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\| x \|/, "what OneLake answered");
  assert.deepEqual(onelake.calls, [["workspaces"]], "--fresh asks OneLake");
});

test("free from the cache: table sizes, more table fields, files, find, model counts", async () => {
  const { agent, calls, close } = await richAgent();
  try {
    let r = await agent.run({ args: ["ls", "ws", "data"] });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\| customers \| lakehouse\.ws\.data\.dbo\.customers \| 1,200 \| 2\.5 MB \| 3 \| 2026-10-01 08:30 \|/);
    assert.match(r.out, /\| orders \| lakehouse\.ws\.data\.dbo\.orders \| — \| — \| — \| — \|/);
    assert.match(r.out, /2 table\(s\), 1 with metadata cached/);

    r = await agent.run({ args: ["table", "ws", "data", "customers"] });
    assert.equal(r.code, 0, r.err);   // a bare name: found in the schema-less listing, not guessed as dbo
    assert.match(r.out, /\| compression \| zstd \|/);
    assert.match(r.out, /\| snapshots \| 4 \|/);
    assert.match(r.out, /\| Iceberg format \| v2 \|/);

    r = await agent.run({ args: ["files", "ws", "data", "Files/raw"] });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\| 2026 \| folder \|/);
    assert.match(r.out, /1 file\(s\), 1 folder\(s\), 1\.0 MB in Files\/raw/);
    r = await agent.run({ args: ["files", "ws", "dw"] });
    assert.match(r.err, /has no Files area/);
    r = await agent.run({ args: ["files", "ws", "data", "other"] });
    assert.match(r.err, /Files\/other is not cached yet/);

    r = await agent.run({ args: ["find", "custom"] });
    assert.equal(r.code, 0, r.err);
    for (const re of [/\| table \| ws\/data\.Lakehouse \| customers \|/, /\| column \| ws\/data\.Lakehouse customers \| customer_id \(long\) \|/,
                      /\| model table \| ws\/Sales \| dim_customer \|/, /\| measure \| ws\/Sales \| \[Customer Count\] in fct_sales \|/]) {
      assert.match(r.out, re);
    }

    r = await agent.run({ args: ["models"] });
    assert.match(r.out, /\| ws \| Sales \| downloaded \| 2 \| 2 \|/);
    assert.match(r.out, /\| ws \| Ops \|  \|  \|  \|/);

    assert.deepEqual(calls, [], "nothing fetched");
  } finally { await close(); }
});

// export hands Explore's own export the model file, as Explore's button does; the dax-sql and
// YAML modules it loads stand in as stubs (CI's test job has no vendor/).
test("export: a model file in Files/, or a semantic model's local copy, which the export writes", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const vendorDir = await mkdtemp(join(tmpdir(), "agent-vendor-"));
  try {
    await stubVendor(vendorDir);
    const { createAgent } = require("../../src/agent.js");
    const onelake = fakeOneLake();
    onelake.readBytes = async (ws, path) => new TextEncoder().encode(`model at ${ws}/${path}`);
    onelake.cached.models = async ws => ws === "a ws" ? { value: [{ id: "m1", name: "Sales" }, { id: "m2", name: "Ops" }], at: Date.now() } : null;
    // Sales is downloaded (its local copy); Ops is not.
    await writeFile(join(vendorDir, "Sales.yaml"), "the Sales model");
    const exported = [];
    const agent = createAgent({
      onelake, modelPath: (ws, model) => join(vendorDir, `${model}.yaml`),
      appDir: APP_DIR,
      vendorDir, daxSqlPin: "pin", yamlPin: "yaml",
      exportApp: async x => { exported.push(x); return `Published to Fabric: ${x.name}`; },
    });

    let r = await agent.run({ args: ["export", "a ws", "a", "Files/models/sales-2.yaml"] });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "Published to Fabric: sales_2");
    assert.deepEqual(exported.pop(), { file: "sales-2.yaml", name: "sales_2", text: "model at a ws/a.Lakehouse/Files/models/sales-2.yaml",
                                       state: null, workspace: "a ws", path: "a.Lakehouse/Files/models/sales-2.yaml" });

    r = await agent.run({ args: ["export", "a ws", "sales"] });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(exported.pop(), { file: "Sales.yaml", name: "Sales", text: "the Sales model", state: null,
                                       model: { workspace: "a ws", name: "Sales" } });

    r = await agent.run({ args: ["export", "a ws", "Ops"] });
    assert.equal(r.code, EXIT.NOT_CACHED);
    assert.match(r.err, /a ws\/Ops is not downloaded yet — open it in the OneLake Studio tree/);

    r = await agent.run({ args: ["export", "a ws", "dw", "Files/x.bim"] });
    assert.match(r.err, /dw\.Warehouse has no Files area/);
    assert.equal(exported.length, 0);

    r = await createAgent({ onelake, modelPath: () => "" }).run({ args: ["export", "a ws", "Sales"] });
    assert.match(r.err, /Export to Fabric is not available here/);
  } finally {
    await rm(vendorDir, { recursive: true, force: true });
  }
});
