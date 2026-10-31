// sqltables.js: a table's SQL name found in OneLake, and a model's GUIDs named, on the real
// cache-first layer with a fake catalog and Fabric. What is under test is when each is asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStore } = require("../../src/store.js");
const { createOneLake } = require("../../src/onelake.js");
const { createSqlTables } = require("../../src/sqltables.js");

const LOC = "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/1.metadata.json";
const metadata = {
  "format-version": 2, "current-snapshot-id": 1, "current-schema-id": 0,
  schemas: [{ "schema-id": 0, fields: [{ id: 1, name: "id", type: "long", required: false }] }],
  snapshots: [{ "snapshot-id": 1, "timestamp-ms": 1, summary: { "total-records": "5" } }],
};

function world({ ttlMs = 60_000 } = {}) {
  const w = {
    now: 1000,
    items: ["old.Lakehouse"],
    tables: [{ schema: "dbo", table: "t" }],
    itemName: "old.Lakehouse",
    calls: [],
  };
  w.catalog = {
    reset: () => {},
    listWorkspaces: async () => { w.calls.push("workspaces"); return ["ws"]; },
    listItems: async () => { w.calls.push("items"); return w.items.map(name => ({ name, kind: "Lakehouse" })); },
    listTables: async () => { w.calls.push("tables"); return w.tables; },
    loadTable: async () => { w.calls.push("load"); return { metadata, metadataLocation: LOC }; },
  };
  w.fabric = {
    resets: 0,
    reset() { this.resets++; },
    itemOf: async () => { w.calls.push("fabric"); return { workspace: "ws", item: w.itemName }; },
  };
  w.onelake = createOneLake({ catalog: w.catalog, fabric: w.fabric, prefetchEnabled: () => false,
                              store: createStore({ dir: null, ttlMs, now: () => w.now }) });
  w.sql = createSqlTables({ onelake: w.onelake, paths: async () => ({ emptyTableSql: () => "SELECT 1" }) });
  return w;
}
const ref = (item = "old") => ({ kind: "lakehouse", workspace: "ws", item, schema: "dbo", table: "t" });
const count = (w, what) => w.calls.filter(c => c === what).length;
const GUIDS = [{ workspace: "w-guid", item: "i-guid", schema: "dbo", table: "t" }];

test("a table resolves from the cache, with nothing asked twice", async () => {
  const w = world();
  assert.equal((await w.sql.resolve(ref())).metadataLocation, LOC);
  w.calls.length = 0;
  assert.equal((await w.sql.resolve(ref())).metadataLocation, LOC);
  assert.deepEqual(w.calls, []);
});

test("an item made since the listing resolves: a miss reads the listing again, once", async () => {
  const w = world();
  await w.sql.resolve(ref());
  w.items = ["old.Lakehouse", "made.Lakehouse"];
  w.calls.length = 0;
  assert.equal((await w.sql.resolve(ref("made"))).item, "made");
  assert.equal(count(w, "items"), 1);
});

test("a name typed by hand that exists nowhere is one listing read and the plain error", async () => {
  const w = world();
  await w.sql.resolve(ref());
  w.calls.length = 0;
  await assert.rejects(w.sql.resolve(ref("typo")), /there is no lakehouse typo in workspace ws/);
  assert.equal(count(w, "items"), 1);
  assert.equal(count(w, "fabric"), 0, "no GUIDs behind it, so nothing to ask Fabric");
});

test("an item's name, however old, asks Fabric once, ever", async () => {
  const w = world({ ttlMs: 0 });
  assert.deepEqual(await w.sql.nameTables(GUIDS), ["lakehouse.ws.old.dbo.t"]);
  w.now += 365 * 24 * 3600 * 1000;
  assert.deepEqual(await w.sql.nameTables(GUIDS), ["lakehouse.ws.old.dbo.t"]);
  await new Promise(r => setImmediate(r));   // a refresh behind the caller would have started by now
  assert.equal(count(w, "fabric"), 1);
  assert.equal(w.fabric.resets, 0);
});

test("a renamed item: the compiled name goes on resolving, and the new name is kept", async () => {
  const w = world();
  await w.sql.nameTables(GUIDS);
  w.items = ["new.Lakehouse"];
  w.itemName = "new.Lakehouse";
  w.calls.length = 0;

  // As the compiled SQL wrote it, so the view is made under the name the SQL reads.
  const r = await w.sql.resolve(ref("old"));
  assert.equal(r.item, "old");
  assert.equal(r.metadataLocation, LOC);
  assert.equal(count(w, "fabric"), 1);
  assert.equal(w.fabric.resets, 1, "past Fabric's memo of the workspaces' names too");

  // The next time the panel names the model, with no call to Fabric.
  w.calls.length = 0;
  assert.deepEqual(await w.sql.nameTables(GUIDS), ["lakehouse.ws.new.dbo.t"]);
  assert.equal(count(w, "fabric"), 0);
  // And the new name resolves in its own right.
  assert.equal((await w.sql.resolve(ref("new"))).item, "new");
});

test("an item gone for good, with its name unchanged, gives the plain error", async () => {
  const w = world();
  await w.sql.nameTables(GUIDS);
  w.items = [];
  await assert.rejects(w.sql.resolve(ref("old")), /there is no lakehouse old in workspace ws/);
});

test("offline, a rename's check gives the real error", async () => {
  const w = world();
  await w.sql.nameTables(GUIDS);
  w.items = [];
  w.fabric.itemOf = async () => { throw new Error("connection reset"); };
  await assert.rejects(w.sql.resolve(ref("old")), /there is no lakehouse old/);
});

test("past the cache, a table no longer listed is gone: not waited on as a conversion", async () => {
  const w = world();
  await w.sql.resolve(ref());
  w.tables = [];
  w.calls.length = 0;
  await assert.rejects(w.sql.resolve(ref(), { fresh: true }), /there is no table t in old.Lakehouse/);
  assert.equal(count(w, "load"), 0);
});

test("a table with no folder says so plainly, with the closest listed names", async () => {
  const w = world();
  w.tables = [{ schema: "dbo", table: "dim_duid" }, { schema: "mart", table: "dim_duids" }, { schema: "dbo", table: "fact_sales" }];
  w.catalog.loadTable = async (lh, t) => {
    throw Object.assign(new Error(`no table ${t.schema}.${t.table} in ws/old`), { status: 404, noTable: true });
  };
  const named = table => ({ ...ref(), table });
  await assert.rejects(w.sql.resolve(named("dim_duidd")),
    e => e.message === "no table dbo.dim_duidd in ws/old — closest: dbo.dim_duid, mart.dim_duids");
  await assert.rejects(w.sql.resolve(named("no_such_table_xyz")), e => e.message === "no table dbo.no_such_table_xyz in ws/old");
});

test("offline, a kept listing cannot say an item does not exist", async () => {
  const w = world();
  await w.sql.resolve(ref());
  const offline = createSqlTables({ onelake: w.onelake, paths: async () => ({}), offlineReason: () => "no internet" });
  await assert.rejects(offline.resolve(ref("elsewhere")), e => e.offline === true &&
    /lakehouse elsewhere is not cached on this machine, and there is no internet/.test(e.message));
});

test("past the cache, every read goes to OneLake", async () => {
  const w = world();
  await w.sql.resolve(ref());
  w.calls.length = 0;
  await w.sql.resolve(ref(), { fresh: true });
  for (const what of ["workspaces", "items", "tables", "load"]) assert.equal(count(w, what), 1, `${what}: ${w.calls}`);
});
