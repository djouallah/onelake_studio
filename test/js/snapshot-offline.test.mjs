// A table that moved on since it was read: offline, what was read keeps working.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOneLake } = require("../../core/onelake/onelake.js");
const { createStore } = require("../../core/onelake/store.js");
const { createCatalogFile } = require("../../core/onelake/catalogfile.js");
const { createSqlTables } = require("../../core/sqltables.js");

const lh = { workspace: "ws", item: "gold.Lakehouse" };
const t = { schema: "dbo", table: "orders" };
const dir = "abfss://ws@onelake.dfs.fabric.microsoft.com/gold.Lakehouse/Tables/dbo/orders/metadata/";
const at = n => `${dir}v${n}.metadata.json`;
const metadata = {
  "format-version": 2, "current-snapshot-id": 1, "current-schema-id": 0,
  schemas: [{ "schema-id": 0, fields: [{ id: 1, name: "id", type: "long", required: false }] }],
  snapshots: [{ "snapshot-id": 1, "timestamp-ms": 1, summary: { "total-records": "7" } }],
};

async function world(c) {
  const folder = await mkdtemp(join(tmpdir(), "onelake-snapshot-"));
  const backend = createCatalogFile({ file: join(folder, "catalog.sqlite") });
  c.after(async () => { backend.close(); await rm(folder, { recursive: true, force: true }).catch(() => {}); });
  const w = { snapshot: 1, offline: false, clock: 1_000_000 };
  const catalog = {
    reset() {},
    listItems: async () => [{ name: lh.item, kind: "Lakehouse" }],
    listTables: async () => [t],
    loadTable: async () => ({ metadata, metadataLocation: at(w.snapshot) }),
  };
  const store = createStore({ dir: null, backend, ttlMs: 1000, now: () => w.clock });
  w.onelake = createOneLake({ catalog, store, prefetchEnabled: () => false, isOffline: () => w.offline });
  w.moves = async n => { w.snapshot = n; w.clock += 1000; await w.onelake.table(lh, t, { fresh: true }); };
  return w;
}

test("offline, a table that moved reads the snapshot that was read", async c => {
  const w = await world(c);
  await w.onelake.table(lh, t);
  await w.onelake.rowsRead(at(1));
  const readAt = w.clock;
  await w.moves(2);

  assert.equal((await w.onelake.table(lh, t)).metadataLocation, at(2), "online, the current one");
  assert.equal(await w.onelake.cached.rows(lh, t), false, "online, that's one read away");
  assert.equal(await w.onelake.rowsOutOfReach(lh, t), false);

  w.offline = true;
  const m = await w.onelake.table(lh, t);
  assert.equal(m.metadataLocation, at(1));
  assert.equal(m.olderSnapshot, true);
  assert.equal(m.at, readAt, "as old as what it reads");
  assert.equal(await w.onelake.cached.rows(lh, t), true);
  assert.equal(await w.onelake.rowsOutOfReach(lh, t), false, "so its Data tab stays");

  w.offline = false;
  assert.equal((await w.onelake.table(lh, t)).metadataLocation, at(2), "and back to the current one");
});

test("a statement offline is resolved to the older snapshot", async c => {
  const w = await world(c);
  await w.onelake.table(lh, t);
  await w.onelake.rowsRead(at(1));
  await w.moves(2);
  w.offline = true;
  const sql = createSqlTables({ onelake: w.onelake, paths: async () => ({}), offlineReason: () => "no internet" });
  const r = await sql.resolve({ kind: "lakehouse", workspace: "ws", item: "gold", schema: "dbo", table: "orders", name: "lakehouse.ws.gold.dbo.orders" });
  assert.equal(r.metadataLocation, at(1));
});

test("offline, the Data tab's first rows are the older snapshot's, with nothing run", async c => {
  const w = await world(c);
  await w.onelake.table(lh, t);
  const rows = { fields: [{ name: "id", type: "BIGINT" }], rows: [{ id: 1 }], numRows: 1 };
  assert.deepEqual((await w.onelake.peek(lh, t, async () => rows)).rows, rows.rows);
  await w.moves(2);
  w.offline = true;
  const seen = await w.onelake.peek(lh, t, async () => { throw new Error("nothing should run"); });
  assert.equal(seen.cached, true);
  assert.deepEqual(seen.rows, rows.rows);
});

test("the newest of the snapshots read, and the current one if it was read", async c => {
  const w = await world(c);
  await w.onelake.table(lh, t);
  await w.onelake.rowsRead(at(1));
  await w.moves(2);
  await w.onelake.rowsRead(at(2));
  await w.moves(3);
  w.offline = true;
  assert.equal((await w.onelake.table(lh, t)).metadataLocation, at(2));
  w.offline = false;
  await w.onelake.rowsRead(at(3));
  w.offline = true;
  const m = await w.onelake.table(lh, t);
  assert.equal(m.metadataLocation, at(3));
  assert.equal(m.olderSnapshot, undefined);
});

test("a table never read here stays as it is, and another table's reads don't count", async c => {
  const w = await world(c);
  await w.onelake.table(lh, t);
  await w.onelake.rowsRead(`${dir.replace("/orders/", "/orders2/")}v1.metadata.json`);
  w.offline = true;
  assert.equal((await w.onelake.table(lh, t)).metadataLocation, at(1));
  assert.equal(await w.onelake.cached.rows(lh, t), false);
  assert.equal(await w.onelake.rowsOutOfReach(lh, t), true, "nothing to show, so no Data tab");
});
