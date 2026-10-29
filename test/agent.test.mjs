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

test("models and items --fresh: every workspace read now, and one that fails is a note", async () => {
  const { createAgent } = require("../src/agent.js");
  const onelake = {
    workspaces: async () => ["b ws", "a ws", "broken"],
    models: async w => {
      if (w === "broken") throw Object.assign(new Error("Unauthorized"), { status: 401 });
      return w === "a ws" ? [{ name: "Sales", description: "the sales model" }, { name: "Ops", description: "" }]
                          : [{ name: "Energy", description: "" }];
    },
    items: async w => (w === "broken" ? [] : [{ name: `${w[0]}.Lakehouse`, kind: "Lakehouse" }, { name: "dw.Warehouse", kind: "Warehouse" }]),
  };
  const agent = createAgent({ onelake, bimPath: () => "/nowhere/x.bim" });
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

// A cache that knows "a ws" and "b ws" but has never listed "unseen"; anything that would
// go to OneLake or Fabric is counted.
function fakeOneLake() {
  const at = Date.now() - 3 * 3600 * 1000;
  const calls = [];
  const remote = name => async (...a) => { calls.push([name, ...a.slice(0, -1)]); return name === "workspaces" ? ["x"] : []; };
  const known = {
    workspaces: ["b ws", "a ws", "unseen"],
    "items a ws": [{ name: "a.Lakehouse", kind: "Lakehouse" }, { name: "dw.Warehouse", kind: "Warehouse" }],
    "items b ws": [{ name: "b.Lakehouse", kind: "Lakehouse" }],
    "models a ws": [{ name: "Sales", description: "the sales model" }, { name: "Ops", description: "" }],
    "models b ws": [{ name: "Energy", description: "" }],
  };
  const hit = k => (k in known ? { value: known[k], at } : null);
  return {
    calls,
    workspaces: remote("workspaces"), items: remote("items"), models: remote("models"),
    tables: remote("tables"), table: remote("table"),
    cached: {
      workspaces: async () => hit("workspaces"),
      items: async ws => hit(`items ${ws}`),
      models: async ws => hit(`models ${ws}`),
      tables: async () => null,
      table: async () => null,
    },
  };
}

test("models and items: every cached workspace, counted, and nothing fetched", async () => {
  const { createAgent } = require("../src/agent.js");
  const onelake = fakeOneLake();
  const agent = createAgent({ onelake, bimPath: () => "/nowhere/x.bim" });

  let r = await agent.run({ args: ["models"] });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\| a ws \| Ops \|[\s\S]*\| a ws \| Sales \|[\s\S]*\| b ws \| Energy \|/, "sorted by workspace, then name");
  assert.match(r.out, /3 semantic model\(s\) in 2 workspace\(s\); 1 workspace\(s\) not cached$/);
  assert.match(r.err, /not cached yet, so not counted: unseen/);
  assert.match(r.err, /as of 3 h ago/);

  r = await agent.run({ args: ["items"] });
  assert.match(r.out, /3 item\(s\): 2 Lakehouse, 1 Warehouse; 1 workspace\(s\) not cached$/);

  r = await agent.run({ args: ["models"], opts: { csv: true } });
  assert.equal(r.out.split("\n")[0], "workspace,semantic model,,tables,measures,description");

  assert.deepEqual(onelake.calls, [], "no OneLake or Fabric call without --fresh");
});

test("a listing or metadata not cached says so; --fresh is what reads it", async () => {
  const { createAgent } = require("../src/agent.js");
  const onelake = fakeOneLake();
  const agent = createAgent({ onelake, bimPath: () => "/nowhere/x.bim" });

  let r = await agent.run({ args: ["ls", "unseen"] });
  assert.equal(r.code, 1);
  assert.match(r.err, /not cached yet — expand unseen in the OneLake Studio tree, or add --fresh/);

  r = await agent.run({ args: ["ls", "a ws", "a"] });
  assert.match(r.err, /a ws\/a\.Lakehouse's tables is not cached yet/);

  r = await agent.run({ args: ["table", "a ws", "a", "dbo.x"] });
  assert.match(r.err, /dbo\.x's metadata is not cached yet/);

  r = await agent.run({ args: ["model", "a ws", "Sales"] });
  assert.match(r.err, /a ws\/Sales is not downloaded yet — open it in the OneLake Studio tree, or add --fresh/);
  assert.deepEqual(onelake.calls, []);

  r = await agent.run({ args: ["ls"], opts: { fresh: true } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(onelake.calls, [["workspaces"]], "--fresh asks OneLake");
});

// A fuller cache: one lakehouse with two tables (one with metadata), a Files/ folder, a
// warehouse, and one downloaded model on disk.
async function richAgent() {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  const bim = join(dir, "Sales.bim");
  await writeFile(bim, JSON.stringify({ model: { tables: [
    { name: "dim_customer", columns: [{ name: "customer_id" }, { name: "Region" }] },
    { name: "fct_sales", columns: [{ name: "amount" }], measures: [{ name: "Total Sales" }, { name: "Customer Count" }] },
  ] } }));
  const at = Date.now() - 10 * 60 * 1000;
  const lh = "ws\u0000data.Lakehouse";
  const known = {
    workspaces: ["ws"],
    "items ws": [{ name: "data.Lakehouse", kind: "Lakehouse" }, { name: "dw.Warehouse", kind: "Warehouse" }],
    "models ws": [{ name: "Sales", description: "" }, { name: "Ops", description: "" }],
    [`tables ${lh}`]: [{ schema: "", table: "customers" }, { schema: "", table: "orders" }],
    [`table ${lh}\u0000\u0000customers`]: { totalRecords: 1200, schemaFields: [{ name: "customer_id", type: "long" }],
      stats: { totalFilesSize: 2_500_000, totalDataFiles: 3, snapshotTs: Date.UTC(2026, 9, 1, 8, 30),
               codec: "zstd", snapshotCount: 4, operation: "append", formatVersion: 2 } },
    [`files ${lh}\u0000raw`]: [{ name: "2026", isDir: true }, { name: "a.parquet", isDir: false, bytes: 1_000_000 }],
  };
  const hit = k => (k in known ? { value: known[k], at } : null);
  const calls = [];
  const remote = name => async () => { calls.push(name); return []; };
  const onelake = {
    workspaces: remote("workspaces"), items: remote("items"), models: remote("models"),
    tables: remote("tables"), table: remote("table"), files: remote("files"),
    cached: {
      workspaces: async () => hit("workspaces"),
      items: async ws => hit(`items ${ws}`),
      models: async ws => hit(`models ${ws}`),
      tables: async l => hit(`tables ${l.workspace}\u0000${l.item}`),
      table: async (l, t) => hit(`table ${l.workspace}\u0000${l.item}\u0000${t.schema || ""}\u0000${t.table}`),
      files: async (l, d) => hit(`files ${l.workspace}\u0000${l.item}\u0000${d}`),
    },
  };
  const { createAgent } = require("../src/agent.js");
  return { agent: createAgent({ onelake, bimPath: (ws, m) => (m === "Sales" ? bim : join(dir, "none.bim")) }), calls, dir };
}

test("free from the cache: table sizes, more table fields, files, find, model counts", async () => {
  const { rm } = await import("node:fs/promises");
  const { agent, calls, dir } = await richAgent();
  try {
    let r = await agent.run({ args: ["ls", "ws", "data"] });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\| customers \| data_main\.customers \| 1,200 \| 2\.5 MB \| 3 \| 2026-10-01 08:30 \|/);
    assert.match(r.out, /\| orders \| data_main\.orders \| — \| — \| — \| — \|/);
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
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// export hands Explore's own export the model file, as Explore's button does; the dax-sql and
// YAML modules it loads stand in as stubs (CI's test job has no vendor/).
test("export: a model file in Files/, or a semantic model's .bim where the tree wrote it", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const vendorDir = await mkdtemp(join(tmpdir(), "agent-vendor-"));
  try {
    for (const [p, body] of [
      ["gh/pin/src/index.js", "export const createCompiler = 0, createViews = 0;"],
      ["gh/pin/formats/tmsl.js", "export const tmslToModel = 0;"],
      ["gh/pin/formats/ossie.js", "export const ossieToTmsl = 0;"],
      ["npm/yaml/+esm.js", "export const parse = 0;"],
    ]) {
      await mkdir(dirname(join(vendorDir, p)), { recursive: true });
      await writeFile(join(vendorDir, p), body);
    }
    const { createAgent } = require("../src/agent.js");
    const onelake = fakeOneLake();
    onelake.readBytes = async (ws, path) => new TextEncoder().encode(`model at ${ws}/${path}`);
    onelake.cached.models = async ws => ws === "a ws" ? { value: [{ id: "m1", name: "Sales" }, { id: "m2", name: "Ops" }], at: Date.now() } : null;
    const exported = [];
    const agent = createAgent({
      onelake, bimPath: () => "/nowhere/x.bim",
      appDir: join(dirname(fileURLToPath(import.meta.url)), "..", "app"),
      vendorDir, daxSqlPin: "pin", yamlPin: "yaml",
      exportApp: async x => { exported.push(x); return `Published to Fabric: ${x.name}`; },
      modelFileOf: (ws, id) => id === "m1" ? { workspace: "lh ws", path: "a.Lakehouse/Files/semantic_model/Sales.bim" } : null,
    });

    let r = await agent.run({ args: ["export", "a ws", "a", "Files/models/sales-2.yaml"] });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "Published to Fabric: sales_2");
    assert.deepEqual(exported.pop(), { file: "sales-2.yaml", name: "sales_2", text: "model at a ws/a.Lakehouse/Files/models/sales-2.yaml",
                                       state: null, workspace: "a ws", path: "a.Lakehouse/Files/models/sales-2.yaml" });

    r = await agent.run({ args: ["export", "a ws", "sales"] });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(exported.pop(), { file: "Sales.bim", name: "Sales", text: "model at lh ws/a.Lakehouse/Files/semantic_model/Sales.bim",
                                       state: null, workspace: "lh ws", path: "a.Lakehouse/Files/semantic_model/Sales.bim" });

    r = await agent.run({ args: ["export", "a ws", "Ops"] });
    assert.equal(r.code, 1);
    assert.match(r.err, /a ws\/Ops is not in its lakehouse yet — open it in the OneLake Studio tree/);

    r = await agent.run({ args: ["export", "a ws", "dw", "Files/x.bim"] });
    assert.match(r.err, /dw\.Warehouse has no Files area/);
    assert.equal(exported.length, 0);

    r = await createAgent({ onelake, bimPath: () => "" }).run({ args: ["export", "a ws", "Sales"] });
    assert.match(r.err, /Export to Fabric is not available here/);
  } finally {
    await rm(vendorDir, { recursive: true, force: true });
  }
});
