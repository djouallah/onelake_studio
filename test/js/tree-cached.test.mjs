// tree.js: a file says whether it has been read here, with the same icons as a table.
import { test } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";

const fired = [];
class EventEmitter {
  event = () => ({ dispose() {} });
  fire(n) { fired.push(n); }
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
const { LakehouseTree } = require("../../src/tree.js");
const { createOneLake } = require("../../src/onelake.js");
const { createStore } = require("../../src/store.js");

const WS = "w", ITEM = "i.Lakehouse";
const file = (name, version) => ({ name, path: `${ITEM}/Files/${name}`, isDir: false, bytes: 3, version });

function setup(listing) {
  const catalog = { reset() {}, listFiles: async () => listing(), readBytes: async () => new Uint8Array([1, 2, 3]) };
  const onelake = createOneLake({ catalog, store: createStore({ dir: null, ttlMs: 0 }), prefetchEnabled: () => false });
  const tree = new LakehouseTree({ onelake, isSignedIn: () => true });
  const children = () => tree.getChildren({ kind: "dir", workspace: WS, item: ITEM, dir: "" });
  return { onelake, tree, children };
}
const url = name => `abfss://${WS}@onelake.dfs.fabric.microsoft.com/${ITEM}/Files/${name}`;

test("a file never read is a cloud, and one read has a table's check", async () => {
  const { onelake, tree, children } = setup(() => [file("a.parquet", "v1"), file("b.csv", "v1")]);
  const [a, b] = await children();
  assert.equal(tree.getTreeItem(a).iconPath.id, "cloud");

  await onelake.fileRead(url("a.parquet"));
  const [readA, stillB] = await children();
  const icon = tree.getTreeItem(readA).iconPath;
  assert.equal(icon.id, "pass-filled");
  assert.equal(icon.color.id, "testing.iconPassed");
  assert.equal(tree.getTreeItem(stillB).iconPath.id, "cloud");
  assert.ok(b);
});

test("a file on screen changes the moment it is read", async () => {
  const { onelake, children } = setup(() => [file("a.parquet", "v1")]);
  const [a] = await children();
  fired.length = 0;
  await onelake.fileRead(url("a.parquet"));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(a.cached, true);
  assert.ok(fired.includes(a));
});

test("a file rewritten since is a cloud again", async () => {
  let version = "v1";
  const { onelake, children } = setup(() => [file("a.parquet", version)]);
  await children();
  await onelake.fileRead(url("a.parquet"));
  assert.equal((await children())[0].cached, true);
  version = "v2";
  await onelake.files({ workspace: WS, item: ITEM }, "", { fresh: true });
  assert.equal((await children())[0].cached, false);
});

test("a file the host read whole counts too, once it is kept", async () => {
  const dir = await (await import("node:fs/promises")).mkdtemp(`${(await import("node:os")).tmpdir()}/onelake-tree-`);
  const catalog = { reset() {}, listFiles: async () => [file("m.bim", "v1")], readBytes: async () => new Uint8Array([1, 2, 3]) };
  const onelake = createOneLake({ catalog, store: createStore({ dir }), prefetchEnabled: () => false });
  const tree = new LakehouseTree({ onelake, isSignedIn: () => true });
  const children = () => tree.getChildren({ kind: "dir", workspace: WS, item: ITEM, dir: "" });
  assert.equal((await children())[0].cached, false);
  await onelake.readBytes(WS, `${ITEM}/Files/m.bim`);
  assert.equal((await children())[0].cached, true);
  await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
});

test("a URL no listing knows marks nothing", async () => {
  const { onelake, children } = setup(() => [file("a.parquet", "v1")]);
  await children();
  await onelake.fileRead("abfss://00000000-0000-0000-0000-000000000001@onelake.dfs.fabric.microsoft.com/x/Files/a.parquet");
  await onelake.fileRead("not a url");
  assert.equal((await children())[0].cached, false);
});

test("a folder has no such icon", async () => {
  const { tree } = setup(() => []);
  const onelakeDir = { name: "d", path: `${ITEM}/Files/d`, isDir: true, bytes: 0, version: "" };
  const { children } = setup(() => [onelakeDir]);
  const [d] = await children();
  assert.equal(d.kind, "dir");
  assert.equal(tree.getTreeItem(d).iconPath.id, "folder");
});
