// sqltables.js: a table's SQL name found in OneLake, and a model's GUIDs named, on the real
// cache-first layer with a fake catalog and Fabric. What is under test is when each is asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStore } = require("../../core/onelake/store.js");
const { createOneLake } = require("../../core/onelake/onelake.js");
const { createSqlTables } = require("../../core/sqltables.js");

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

test("a folder that is no table says so as it is, with nothing added", async () => {
  const w = world();
  const why = "dbo.t is not a valid OneLake table: its folder has neither a Delta log nor Iceberg metadata";
  w.catalog.loadTable = async () => { throw Object.assign(new Error(why), { status: 404, notValid: true }); };
  await assert.rejects(w.sql.resolve(ref()), e => e.message === why && e.notValid === true);
});

test("offline, a kept listing cannot say an item does not exist", async () => {
  const w = world();
  await w.sql.resolve(ref());
  const offline = createSqlTables({ onelake: w.onelake, paths: async () => ({}), offlineReason: () => "no internet" });
  await assert.rejects(offline.resolve(ref("elsewhere")), e => e.offline === true &&
    /lakehouse elsewhere is not cached on this machine, and there is no internet/.test(e.message));
});

test("a file's lakehouse is found as a table's is: any case, and a miss says the file's name", async () => {
  const w = world();
  const file = (workspace, item) => ({ workspace, item, written: `lakehouse.${workspace}.${item}/Files` });
  assert.deepEqual(await w.sql.resolveFile(file("WS", "OLD")), { workspace: "ws", item: "old.Lakehouse" });
  w.calls.length = 0;
  assert.deepEqual(await w.sql.resolveFile(file("ws", "old")), { workspace: "ws", item: "old.Lakehouse" });
  assert.deepEqual(w.calls, [], "from the cache");
  await assert.rejects(w.sql.resolveFile(file("ws", "nosuch")), /lakehouse\.ws\.nosuch\/Files: there is no lakehouse nosuch in workspace ws/);
});

test("past the cache, every read goes to OneLake", async () => {
  const w = world();
  await w.sql.resolve(ref());
  w.calls.length = 0;
  await w.sql.resolve(ref(), { fresh: true });
  for (const what of ["workspaces", "items", "tables", "load"]) assert.equal(count(w, what), 1, `${what}: ${w.calls}`);
});

test("a Delta table is read from its own folder, and an Iceberg one from its metadata", async c => {
  const { createSqlTables } = require("../../core/sqltables.js");
  let format = "delta", location = "abfss://ANZ Retail Demo@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/v3.metadata.json";
  const onelake = {
    workspaces: async () => ["ws"],
    items: async () => [{ name: "lh.Lakehouse", kind: "Lakehouse" }],
    tables: async () => [{ schema: "dbo", table: "t" }],
    table: async () => ({ empty: false, format, metadataLocation: location, at: 1 }),
  };
  const sql = createSqlTables({ onelake, paths: async () => ({}) });
  const ref = { kind: "lakehouse", workspace: "ws", item: "lh", schema: "dbo", table: "t" };
  assert.equal((await sql.resolve(ref)).deltaTable, "abfss://ANZ Retail Demo@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t");
  format = null;
  assert.ok((await sql.resolve(ref)).deltaTable, "not known to be Iceberg is not read as Iceberg");
  location = "https://onelake.dfs.fabric.microsoft.com/ws/lh.Lakehouse/Tables/dbo/t/metadata/v3.metadata.json";
  assert.equal((await sql.resolve(ref)).deltaTable, "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t");
  format = "iceberg";
  const r = await sql.resolve(ref);
  assert.equal(r.deltaTable, null);
  assert.equal(r.metadataLocation, location);
});

test("a Delta table answers its folder, and its log is left to the engine, which reads it into the lake", async () => {
  const { createSqlTables } = require("../../core/sqltables.js");
  const onelake = {
    workspaces: async () => ["ws"],
    items: async () => [{ name: "lh.Lakehouse", kind: "Lakehouse" }],
    tables: async () => [{ schema: "dbo", table: "t" }],
    table: async () => ({ empty: false, format: "delta", at: 1,
      metadataLocation: "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/v3.metadata.json" }),
  };
  const sql = createSqlTables({ onelake, paths: async () => ({}) });
  const r = await sql.resolve({ kind: "lakehouse", workspace: "ws", item: "lh", schema: "dbo", table: "t" });
  assert.equal(r.deltaTable, "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t");
  assert.equal(r.at, 1);
  assert.equal("deltaLocal" in r, false);
});

// A table with OneLake security: OneLake refuses its metadata to this user, and its rows come from
// the table read API (tableread.js), here a fake that says what it was asked.
function securedWorld({ refuse = "load", kept = null, now = 5000 } = {}) {
  const w = world();
  const forbidden = () => Object.assign(new Error("Reading dbo.t from the Iceberg catalog failed (HTTP 403)"), { status: 403 });
  // Written as Delta, so its log is read too.
  const delta = { ...metadata, properties: { XTABLE_METADATA: JSON.stringify({ sourceTableFormat: "DELTA", sourceIdentifier: "3" }) } };
  w.catalog.loadTable = async () => { w.calls.push("load"); if (refuse === "load") throw forbidden(); return { metadata: delta, metadataLocation: LOC }; };
  w.reads = [];
  w.kept = kept;
  const tableRead = {
    held: async () => w.kept,
    current: at => now - at <= 1000,
    ensure: async (t, o) => {
      w.reads.push([t, o]);
      if (w.readFails) throw w.readFails;
      w.kept = { files: ["C:/cache/secured/x/1/s0.arrows"], at: now };
      return w.kept;
    },
  };
  w.sql = createSqlTables({ onelake: w.onelake, paths: async () => ({ emptyTableSql: () => "SELECT 1" }), tableRead });
  return w;
}

test("a table whose metadata is refused is read through the table read API, by its folder's names", async () => {
  const w = securedWorld();
  const r = await w.sql.resolve(ref());
  assert.deepEqual(r.arrowFiles, ["C:/cache/secured/x/1/s0.arrows"]);
  assert.equal(r.secured, true);
  assert.equal(r.listed, undefined, "not kept current as a table in use: that would only be refused");
  assert.deepEqual(w.reads[0][0], { workspace: "ws", item: "old.Lakehouse", schema: "dbo", table: "t" });
});

test("a Delta table whose metadata reads is not secured here: a refusal of its log is the engine's to meet", async () => {
  const w = securedWorld({ refuse: "log" });
  const r = await w.sql.resolve(ref());
  assert.equal(r.secured, undefined);
  assert.ok(r.deltaTable, "the engine reads its log, and moves it to the table read API if OneLake refuses that");
});

test("a copy within its age asks OneLake nothing; an older one tries the direct read first", async () => {
  const w = securedWorld({ refuse: "none", kept: { files: ["C:/cache/secured/x/1/s0.arrows"], at: 4500 } });
  assert.equal((await w.sql.resolve(ref())).secured, true);
  assert.equal(count(w, "load"), 0);
  w.kept = { files: ["C:/cache/secured/x/1/s0.arrows"], at: 1000 };
  const r = await w.sql.resolve(ref());
  assert.equal(r.secured, undefined, "given the whole table since: no more charge");
  assert.equal(count(w, "load"), 1);
});

test("the engine's own refusal goes straight to the table read API", async () => {
  const w = securedWorld({ refuse: "none" });
  assert.equal((await w.sql.resolve(ref(), { secured: true })).secured, true);
  assert.equal(count(w, "load"), 0);
});

test("when the table read API refuses too, both refusals are said", async () => {
  const w = securedWorld();
  w.readFails = Object.assign(new Error("OneLake's table read API says you may not read dbo.t, or it does not exist (HTTP 403)"), { status: 403 });
  await assert.rejects(w.sql.resolve(ref()), e => e.status === 403
    && /Iceberg catalog failed \(HTTP 403\)/.test(e.message) && /that failed too: OneLake's table read API says you may not read/.test(e.message));
});

test("any other failure of the metadata is said as it was, and the API isn't asked", async () => {
  const w = securedWorld({ refuse: "none" });
  w.catalog.loadTable = async () => { throw Object.assign(new Error("Reading dbo.t failed (HTTP 401)"), { status: 401 }); };
  await assert.rejects(w.sql.resolve(ref()), e => e.status === 401);
  assert.equal(w.reads.length, 0);
});

test("a table the lake holds resolves from what the catalog keeps: nothing asked, nothing refreshed behind it, past its age too", async () => {
  const w = world();
  await w.sql.resolve(ref());
  w.calls.length = 0;
  w.now += 365 * 24 * 3600 * 1000;
  const asked = [];
  const held = async x => { asked.push(x); return { name: "t_lake", location: "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/0.metadata.json", at: 5 }; };
  const r = await w.sql.resolve(ref(), { held });
  assert.equal(r.lake, "t_lake");
  assert.equal(r.at, 5, "as old as the lake's sync");
  assert.match(r.metadataLocation, /0\.metadata\.json$/, "the snapshot the lake has");
  assert.deepEqual(r.listed, { workspace: "ws", item: "old.Lakehouse", schema: "dbo", table: "t" });
  assert.deepEqual(asked, [{ deltaTable: null, metadataLocation: LOC }]);
  await new Promise(res => setImmediate(res));
  assert.deepEqual(w.calls, [], "no request, and none behind it");

  // One the lake doesn't hold resolves as it always has.
  const fresh = await w.sql.resolve(ref(), { held: async () => ({ name: null }) });
  assert.equal(fresh.lake, undefined);
  assert.equal(fresh.metadataLocation, LOC);
  // Asked past the cache, the lake isn't asked: the table is read again, and the engine syncs it.
  asked.length = 0;
  await w.sql.resolve(ref(), { held, fresh: true });
  assert.deepEqual(asked, []);
});

test("a Refresh over a lakehouse the lake holds a table of reads its metadata again, and says to sync it", async () => {
  const w = world();
  await w.sql.resolve(ref());
  w.calls.length = 0;
  w.onelake.refreshTables({ workspace: "ws", item: "old.Lakehouse" });
  const r = await w.sql.resolve(ref(), { held: async () => ({ name: "t_lake", location: LOC, at: 1 }) });
  assert.equal(r.sync, true);
  assert.equal(r.lake, undefined);
  assert.equal(count(w, "load"), 1);
});
