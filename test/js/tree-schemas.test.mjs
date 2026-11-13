// tree.js: a schema shows as its catalog lists it, one with no table in it yet too (CREATE SCHEMA).
import { test } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";

class EventEmitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }
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

const lh = { workspace: "w", item: "i.Lakehouse" };

test("a schema with no table yet shows, and says it has none; the tree hears when only the schemas moved", async () => {
  let schemas = ["dbo"];
  const tables = [{ schema: "dbo", table: "t" }];
  const catalog = { reset() {}, listTables: async (_, { onSchemas } = {}) => { if (onSchemas) onSchemas(schemas); return tables; } };
  const onelake = createOneLake({ catalog, store: createStore({ dir: null, ttlMs: 0 }), prefetchEnabled: () => false });
  const tree = new LakehouseTree({ onelake, isSignedIn: () => true });
  const heard = [];
  const off = onelake.onChanged(c => heard.push(c));
  const kids = () => tree.getChildren({ kind: "tables", ...lh });

  // One schema: its tables, with no level between.
  assert.deepEqual((await kids()).map(n => [n.kind, n.label]), [["table", "t"]]);

  // CREATE SCHEMA play: the write reads the listing again, and only the schemas moved.
  schemas = ["dbo", "play"];
  heard.length = 0;
  await onelake.tables(lh, { fresh: true });
  assert.deepEqual(heard, [{ kind: "tables", ...lh }]);
  const shown = await kids();
  assert.deepEqual(shown.map(n => [n.kind, n.label]), [["schema", "dbo"], ["schema", "play"]]);
  const play = await tree.getChildren(shown[1]);
  assert.deepEqual(play.map(n => [n.kind, n.label]), [["empty", "No tables"]]);
  off();
});

test("a lakehouse with nothing in it says so", async () => {
  const catalog = { reset() {}, listTables: async (_, { onSchemas } = {}) => { if (onSchemas) onSchemas(["dbo"]); return []; } };
  const onelake = createOneLake({ catalog, store: createStore({ dir: null, ttlMs: 0 }), prefetchEnabled: () => false });
  const tree = new LakehouseTree({ onelake, isSignedIn: () => true });
  assert.deepEqual((await tree.getChildren({ kind: "tables", ...lh })).map(n => n.label), ["No tables"]);
});
