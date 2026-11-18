// tree.js and onelake.js: a lakehouse's Context/ (a semantic view's YAML) and SystemContext/ (Fabric's TMDL of
// it), beside Tables and Files, listed and kept as Files/ is.
import { test } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";

class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class TreeItem { constructor(label) { this.label = label; } }
const load = Module._load;
Module._load = function (id, ...rest) {
  return id === "vscode"
    ? { EventEmitter, ThemeIcon, ThemeColor, TreeItem, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 } }
    : load.call(this, id, ...rest);
};
const require = createRequire(import.meta.url);
const { LakehouseTree } = require("../../extension/tree.js");
const { createOneLake } = require("../../core/onelake/onelake.js");
const { createStore } = require("../../core/onelake/store.js");

const WS = "w", ITEM = "i.Lakehouse";

// A catalog whose listings are by area and directory: { "Context/Semantic Views": [...] }.
function setup(dirs, store = createStore({ dir: null, ttlMs: 0 })) {
  const asked = [];
  let reads = 0;
  const catalog = {
    reset() {},
    listFiles: async (lh, dir = "") => {
      asked.push(`${lh.area || "Files"}/${dir}`);
      return dirs[`${lh.area || "Files"}/${dir}`] || [];
    },
    readBytes: async () => { reads++; return new Uint8Array([1, 2, 3]); },
  };
  const onelake = createOneLake({ catalog, store, prefetchEnabled: () => false });
  const tree = new LakehouseTree({ onelake, isSignedIn: () => true });
  return { onelake, tree, asked, reads: () => reads };
}
const entry = (path, isDir, version = "v1") => ({ name: path.split("/").pop(), path: `${ITEM}/${path}`, isDir, bytes: isDir ? 0 : 3, version });

test("a lakehouse shows Tables, Files, Context and SystemContext, and only SystemContext says it is read-only", async () => {
  const { tree, asked } = setup({});
  const kids = await tree.getChildren({ kind: "item", workspace: WS, item: ITEM });
  assert.deepEqual(kids.map(k => k.label), ["Tables", "Files", "Context", "SystemContext"]);
  assert.deepEqual(asked, [], "drawing the sections asks OneLake nothing");
  const [, files, context, system] = kids;
  assert.equal(files.area, undefined, "a Files/ node is as it always was");
  assert.equal(tree.getTreeItem(files).contextValue, "dir");
  assert.equal(tree.getTreeItem(context).contextValue, "dirReadOnly");
  assert.equal(tree.getTreeItem(system).contextValue, "dirReadOnly");
  assert.equal(tree.getTreeItem(system).description, "read-only");
  assert.notEqual(tree.getTreeItem(context).description, "read-only");
  assert.notEqual(tree.getTreeItem(files).id, tree.getTreeItem(context).id);
});

test("SystemContext/ lists from SystemContext/, its folders by their path in it, and an absent one is Empty", async () => {
  const { tree, asked } = setup({
    "SystemContext/": [entry("SystemContext/Semantic Views", true)],
    "SystemContext/Semantic Views": [entry("SystemContext/Semantic Views/sales", true)],
    "SystemContext/Semantic Views/sales": [entry("SystemContext/Semantic Views/sales/sales.tmdl", false)],
  });
  const [, , context, system] = await tree.getChildren({ kind: "item", workspace: WS, item: ITEM });
  assert.deepEqual((await tree.getChildren(context)).map(k => k.label), ["Empty"]);
  const [views] = await tree.getChildren(system);
  assert.deepEqual([views.kind, views.area, views.dir], ["dir", "SystemContext", "Semantic Views"]);
  const [sales] = await tree.getChildren(views);
  assert.equal(sales.dir, "Semantic Views/sales");
  const [tmdl] = await tree.getChildren(sales);
  assert.deepEqual([tmdl.kind, tmdl.path], ["file", `${ITEM}/SystemContext/Semantic Views/sales/sales.tmdl`]);
  assert.equal(tree.getTreeItem(tmdl).contextValue, "file", "a model's TMDL is no model file to create from");
  assert.deepEqual(asked, ["Context/", "SystemContext/", "SystemContext/Semantic Views", "SystemContext/Semantic Views/sales"]);
});

test("a listing of Context/ is kept apart from Files/'s, and its files are kept by version as Files/'s are", async () => {
  const dir = await (await import("node:fs/promises")).mkdtemp(`${(await import("node:os")).tmpdir()}/onelake-areas-`);
  const { onelake, reads } = setup({
    "Files/": [entry("Files/a.yaml", false)],
    "Context/": [entry("Context/a.yaml", false)],
  }, createStore({ dir }));
  const lh = { workspace: WS, item: ITEM };
  assert.equal((await onelake.files(lh, "")).at(0).path, `${ITEM}/Files/a.yaml`);
  assert.equal((await onelake.files({ ...lh, area: "Context" }, "")).at(0).path, `${ITEM}/Context/a.yaml`);
  assert.equal((await onelake.cached.files({ ...lh, area: "Context" }, "")).value.at(0).path, `${ITEM}/Context/a.yaml`);
  assert.equal(await onelake.versionOf(WS, `${ITEM}/Context/a.yaml`), "v1");
  await onelake.readBytes(WS, `${ITEM}/Context/a.yaml`);
  await onelake.readBytes(WS, `${ITEM}/Context/a.yaml`);
  assert.equal(reads(), 1, "the second read is the kept copy");
});

test("a folder directly in Context/Semantic Views is a view, with Publish; no other folder is", () => {
  const { tree } = setup({});
  const ctx = dir => tree.getTreeItem({ kind: "dir", workspace: WS, item: ITEM, area: "Context", dir, label: "x" }).contextValue;
  assert.equal(ctx("Semantic Views/sales"), "semanticViewDir");
  for (const dir of ["", "Semantic Views", "Semantic Views/sales/sub", "Other/sales"]) assert.equal(ctx(dir), "dirReadOnly", dir);
  assert.equal(tree.getTreeItem({ kind: "dir", workspace: WS, item: ITEM, area: "SystemContext", dir: "Semantic Views/sales", label: "x" }).contextValue,
    "dirReadOnly", "SystemContext/ has no Publish");
});
