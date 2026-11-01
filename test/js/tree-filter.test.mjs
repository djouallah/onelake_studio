// tree.js: the explorer's filter shows one type, and only the workspaces that hold it.
import { test } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";

class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}
const load = Module._load;
Module._load = function (id, ...rest) {
  return id === "vscode" ? { EventEmitter } : load.call(this, id, ...rest);
};
const require = createRequire(import.meta.url);
const { LakehouseTree, TREE_FILTERS } = require("../../src/tree.js");

const WORKSPACES = {
  sales: {
    items: [{ name: "gold.Lakehouse", kind: "Lakehouse" }, { name: "wh.Warehouse", kind: "Warehouse" }],
    models: [{ name: "revenue", id: "m1" }],
    apps: [],
  },
  ops: {
    items: [{ name: "pg.MountedRelationalDatabase", kind: "MountedRelationalDatabase" }],
    models: [],
    apps: [{ name: "site", id: "a1" }],
  },
  broken: { fails: true },
};

const listing = what => async ws => {
  if (WORKSPACES[ws].fails) throw new Error(`${ws} refused`);
  return WORKSPACES[ws][what];
};

const treeOf = (only, { hasFabric = true } = {}) => new LakehouseTree({
  onelake: {
    workspaces: async () => Object.keys(WORKSPACES),
    items: listing("items"),
    models: listing("models"),
    apps: listing("apps"),
    onChanged: () => () => {},
  },
  fabric: { reset() {} },
  hasFabric: async () => hasFabric,
  isSignedIn: () => true,
  filter: () => only,
});

// The workspaces the tree shows, and what each holds.
async function shown(tree) {
  const out = {};
  for (const group of (await tree.getChildren()).filter(n => n.kind === "group")) {
    for (const ws of await tree.getChildren(group)) {
      if (ws.kind === "workspace") out[ws.workspace] = (await tree.getChildren(ws)).map(k => `${k.kind}:${k.label}`);
    }
  }
  return out;
}

test("no filter lists every workspace, with its items and its Fabric headings", async () => {
  const { sales } = await shown(treeOf(null));
  assert.deepEqual(sales,
    ["item:gold", "item:wh", "models:Semantic models", "apps:Apps"]);
});

test("Semantic models lists them directly, in the workspaces that have any", async () => {
  const got = await shown(treeOf("models"));
  assert.deepEqual(got.sales, ["semanticModel:revenue"]);
  assert.ok(!("ops" in got));
});

test("Apps lists them directly, in the workspaces that have any", async () => {
  const got = await shown(treeOf("apps"));
  assert.deepEqual(got.ops, ["fabricApp:site"]);
  assert.ok(!("sales" in got));
});

test("an item type shows only those items, without the Fabric headings", async () => {
  const got = await shown(treeOf("Warehouse"));
  assert.deepEqual(got.sales, ["item:wh"]);
  assert.ok(!("ops" in got));
});

test("a filter matches a type by the name the portal gives it", async () => {
  const got = await shown(treeOf("Mirrored database"));
  assert.deepEqual(got.ops, ["item:pg"]);
});

test("a workspace that can't be listed stays, and opening it says why", async () => {
  const got = await shown(treeOf("Warehouse"));
  assert.deepEqual(got.broken, ["error:broken refused"]);
});

test("a type no workspace holds says so, and Queries and the engine's views stay", async () => {
  const tree = treeOf("SQL database");
  tree.onelake.items = async () => [];
  const kinds = (await tree.getChildren()).map(n => n.kind);
  assert.deepEqual(kinds, ["empty", "queries", "logs", "performance"]);
});

test("a Fabric filter with no Fabric sign-in offers one, and reads nothing", async () => {
  const tree = treeOf("models", { hasFabric: false });
  tree.onelake.models = async () => { throw new Error("read"); };
  const top = await tree.getChildren();
  assert.equal(top[0].kind, "fabricSignIn");
  assert.equal(top[0].label, "Sign in to list semantic models");
});

test("every filter on offer names something the tree can match", async () => {
  for (const { only } of TREE_FILTERS) {
    const tree = treeOf(only);
    assert.ok(Array.isArray(await tree.getChildren()));
  }
  assert.deepEqual(TREE_FILTERS.map(f => f.only),
    ["Lakehouse", "Warehouse", "SQL database", "Mirrored database", "models", "apps"]);
});
