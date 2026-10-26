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
  assert.equal(r.out.split("\n")[0], "workspace,semantic model,,description");

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
