// onelake.js: the cache-first layer over the catalog. Driven with a fake catalog and a
// real store in memory, so what is under test is the policy: what is fetched, how often,
// what is kept, and what a table's metadata is reduced to before it is stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStore } = require("../../src/store.js");
const { createOneLake, summarize } = require("../../src/onelake.js");


const LOC = "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/00002-x.metadata.json";

const metadata = (extra = {}) => ({
  "format-version": 2,
  "current-snapshot-id": 2,
  "current-schema-id": 0,
  schemas: [{ "schema-id": 0, fields: [{ id: 1, name: "id", type: "long", required: false }] }],
  snapshots: [
    { "snapshot-id": 1, "timestamp-ms": 1, summary: { "total-records": "5" } },
    { "snapshot-id": 2, "timestamp-ms": 2, summary: { "total-records": "7", "total-data-files": "3" } },
  ],
  ...extra,
});

function fakeCatalog() {
  const calls = [];
  return {
    calls,
    reset: () => calls.push("reset"),
    listWorkspaces: async () => { calls.push("workspaces"); return ["ws"]; },
    listItems: async ws => { calls.push(`items ${ws}`); return [{ name: "lh.Lakehouse", kind: "Lakehouse" }]; },
    listTables: async lh => { calls.push(`tables ${lh.item}`);
      return [{ schema: "dbo", table: "a" }, { schema: "dbo", table: "b" }, { schema: "dbo", table: "c" }]; },
    listFiles: async () => { calls.push("files"); return []; },
    loadTable: async (lh, t) => {
      calls.push(`load ${t.table}`);
      await new Promise(r => setTimeout(r, 5));
      return { metadata: metadata(), metadataLocation: LOC };
    },
    readBytes: async () => new Uint8Array(),
  };
}

const lh = { workspace: "ws", item: "lh.Lakehouse" };

test("a table's metadata is reduced to what the panel shows, with its location", () => {
  const s = summarize(metadata(), LOC);
  assert.equal(s.empty, false);
  assert.equal(s.totalRecords, 7, "the CURRENT snapshot's count, not the last one listed");
  assert.equal(s.metadataLocation, LOC);
  assert.deepEqual(s.schemaFields.map(f => f.name), ["id"]);
  assert.ok(!("snapshots" in s), "the snapshot history is not what gets stored");
});

test("a table converted from Delta says so, with the Delta version it was converted from", () => {
  const xt = JSON.stringify({ sourceTableFormat: "DELTA", sourceIdentifier: "4" });
  const s = summarize(metadata({ properties: { XTABLE_METADATA: xt } }), LOC);
  assert.equal(s.format, "delta");
  assert.equal(s.stats.format, "delta");
  assert.equal(s.stats.deltaVersion, 4);
  assert.equal(s.stats.history, null, "a Delta table's history is its log, read on demand");
  const i = summarize(metadata(), LOC);
  assert.equal(i.format, "iceberg");
  assert.deepEqual(i.stats.history.map(h => h.version), ["2", "1"]);
});

// A Delta table on a disk store (log files are kept as blobs, which a memory store does
// not hold), with every OneLake request it makes recorded.
async function deltaFixture(files, deltaVersion) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "onelake-delta-"));
  const xt = JSON.stringify({ sourceTableFormat: "DELTA", sourceIdentifier: String(deltaVersion) });
  const catalog = fakeCatalog();
  catalog.loadTable = async () => ({ metadata: metadata({ properties: { XTABLE_METADATA: xt } }), metadataLocation: LOC });
  catalog.listDir = async (ws, d) => {
    catalog.calls.push(`list ${ws} ${d}`);
    return Object.keys(files).map(f => ({ name: `${d}/${f}`, isDir: false, lastModified: 1 }));
  };
  catalog.readBytes = async (ws, path) => {
    catalog.calls.push(`read ${path.split("/").pop()}`);
    const f = files[path.split("/").pop()];
    if (f == null) throw Object.assign(new Error("HTTP 404"), { status: 404 });
    return new TextEncoder().encode(f);
  };
  const ol = createOneLake({ catalog, store: createStore({ dir }) });
  return { ol, catalog, done: () => rm(dir, { recursive: true, force: true }) };
}
const pad20 = v => String(v).padStart(20, "0");

test("a Delta table's state is one request the first time, and none after", async () => {
  const crc = JSON.stringify({ tableSizeBytes: 10, numFiles: 1,
    metadata: { id: "x", partitionColumns: [] }, protocol: { minReaderVersion: 1, minWriterVersion: 2 } });
  const { ol, catalog, done } = await deltaFixture({ [`${pad20(1)}.crc`]: crc }, 1);
  try {
    const t = { schema: "dbo", table: "t" };
    const s = await ol.deltaState(lh, t);
    assert.equal(s.source, "crc");
    assert.equal(s.sizeBytes, 10);
    assert.deepEqual(catalog.calls.filter(c => c.startsWith("read") || c.startsWith("list")), [`read ${pad20(1)}.crc`]);
    catalog.calls.length = 0;
    assert.equal((await ol.deltaState(lh, t)).cached, true);
    assert.ok(!catalog.calls.some(c => c.startsWith("read") || c.startsWith("list")), catalog.calls.join(", "));
  } finally { await done(); }
});

test("a Delta table's history: one listing and a page of commits, each file read once", async () => {
  const files = {};
  for (let v = 0; v < 15; v++) files[`${pad20(v)}.json`] = `{"commitInfo":{"timestamp":${v},"operation":"WRITE"}}\n`;
  const { ol, catalog, done } = await deltaFixture(files, 14);
  try {
    const t = { schema: "dbo", table: "t" };
    const h = await ol.deltaHistory(lh, t);
    assert.equal(h.total, 15);
    assert.equal(h.entries.length, 10);
    assert.equal(h.entries[0].version, "14");
    assert.ok(catalog.calls.includes("list ws lh.Lakehouse/Tables/dbo/t/_delta_log"), catalog.calls.join("\n"));
    assert.equal(catalog.calls.filter(c => c.startsWith("read")).length, 10);
    catalog.calls.length = 0;
    const next = await ol.deltaHistory(lh, t, { skip: 10 });
    assert.deepEqual(next.entries.map(e => e.version), ["4", "3", "2", "1", "0"]);
    assert.equal(catalog.calls.filter(c => c.startsWith("read")).length, 5, "only the new page");
    assert.ok(!catalog.calls.some(c => c.startsWith("list")), "the listing is kept");
    catalog.calls.length = 0;
    await ol.deltaHistory(lh, t);
    assert.ok(!catalog.calls.some(c => c.startsWith("read") || c.startsWith("list")), catalog.calls.join(", "));
  } finally { await done(); }
});

test("a Delta table with no crc reads the current _last_checkpoint for each new version", async () => {
  const files = { "_last_checkpoint": JSON.stringify({ version: 10 }) };
  const { ol, catalog, done } = await deltaFixture(files, 11);
  const seen = [];
  const run = async sql => { seen.push(/_delta_log\/(\d+)\.checkpoint/.exec(sql)[1]); return { rows: [] }; };
  try {
    const t = { schema: "dbo", table: "t" };
    assert.equal((await ol.deltaState(lh, t, { run })).asOf, 10);
    // A new version converts, and a new checkpoint is written.
    files["_last_checkpoint"] = JSON.stringify({ version: 20 });
    const xt = JSON.stringify({ sourceTableFormat: "DELTA", sourceIdentifier: "21" });
    catalog.loadTable = async () => ({ metadata: metadata({ properties: { XTABLE_METADATA: xt } }), metadataLocation: LOC });
    await ol.table(lh, t, { fresh: true });
    assert.equal((await ol.deltaState(lh, t, { run })).asOf, 20);
    assert.deepEqual(seen, [pad20(10), pad20(20)]);
  } finally { await done(); }
});

test("a kept commit listing that names a commit since cleaned up is listed again", async () => {
  const files = {};
  for (let v = 0; v < 15; v++) files[`${pad20(v)}.json`] = `{"commitInfo":{"timestamp":${v},"operation":"WRITE"}}\n`;
  const { ol, catalog, done } = await deltaFixture(files, 14);
  try {
    const t = { schema: "dbo", table: "t" };
    await ol.deltaHistory(lh, t);                        // keeps the listing; reads 14..5
    delete files[`${pad20(0)}.json`];                    // log retention removes version 0
    catalog.calls.length = 0;
    const h = await ol.deltaHistory(lh, t, { skip: 10 });
    assert.equal(h.total, 14);
    assert.deepEqual(h.entries.map(e => e.version), ["4", "3", "2", "1"]);
    assert.equal(catalog.calls.filter(c => c.startsWith("list")).length, 1, catalog.calls.join(", "));
  } finally { await done(); }
});

test("an Iceberg table has no Delta log to read", async () => {
  const ol = createOneLake({ catalog: fakeCatalog(), store: createStore({ dir: null }) });
  await assert.rejects(() => ol.deltaState(lh, { schema: "dbo", table: "a" }), /not written as Delta/);
  await assert.rejects(() => ol.deltaHistory(lh, { schema: "dbo", table: "a" }), /not written as Delta/);
});

test("a table that was listed but never written is empty, not broken", () => {
  const s = summarize(metadata({ "current-snapshot-id": -1, snapshots: [] }), LOC);
  assert.equal(s.empty, true);
  assert.equal(s.totalRecords, 0);
});

test("metadata with no current snapshot is refused rather than guessed", () => {
  const m = metadata();
  delete m["current-snapshot-id"];
  assert.throws(() => summarize(m, LOC), /current-snapshot-id/);
});

test("listings and table metadata are fetched once, then served from the store", async () => {
  const catalog = fakeCatalog();
  const ol = createOneLake({ catalog, store: createStore({ dir: null }) });
  await ol.workspaces(); await ol.workspaces();
  await ol.tables(lh); await ol.tables(lh);
  const a1 = await ol.table(lh, { schema: "dbo", table: "a" });
  const a2 = await ol.table(lh, { schema: "dbo", table: "a" });
  assert.equal(a1.cached, false);
  assert.equal(a2.cached, true);
  assert.deepEqual(catalog.calls, ["workspaces", "tables lh.Lakehouse", "load a"]);
});

test("a table's metadata keeps its own window, and a Refresh of its lakehouse re-reads it once", async () => {
  const catalog = fakeCatalog();
  // Listings go stale at once; a table's metadata lasts a day.
  const ol = createOneLake({ catalog, store: createStore({ dir: null, ttlMs: 0 }), tableTtlMs: 24 * 3600e3 });
  const a = { schema: "dbo", table: "a" };
  await ol.table(lh, a);
  assert.equal((await ol.table(lh, a)).cached, true);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(catalog.calls, ["load a"], "past the listing TTL, a table is not re-read");

  ol.refreshTables({ workspace: "other" });            // another workspace's Refresh
  assert.equal((await ol.table(lh, a)).cached, true);
  ol.refreshTables({ workspace: "ws", item: "lh.Lakehouse" });
  assert.equal((await ol.table(lh, a)).cached, false, "a Refresh of its lakehouse goes to the catalog");
  assert.equal((await ol.table(lh, a)).cached, true, "…once");
  assert.deepEqual(catalog.calls, ["load a", "load a"]);
});

test("a forced table listing also clears the catalog's own memo for that item", async () => {
  const catalog = fakeCatalog();
  const ol = createOneLake({ catalog, store: createStore({ dir: null }) });
  await ol.tables(lh);
  await ol.tables(lh, { fresh: true });
  assert.deepEqual(catalog.calls, ["tables lh.Lakehouse", "reset", "tables lh.Lakehouse"]);
});

test("the first rows are read once per snapshot, and the engine is not asked again", async () => {
  const catalog = fakeCatalog();
  const ol = createOneLake({ catalog, store: createStore({ dir: null }) });
  const sql = [];
  const run = async q => { sql.push(q); return { fields: [{ name: "id", type: "BIGINT" }], rows: [{ id: 1 }], numRows: 1 }; };
  const t = { schema: "dbo", table: "a" };
  const p1 = await ol.peek(lh, t, run);
  const p2 = await ol.peek(lh, t, run);
  assert.deepEqual(p1.rows, [{ id: 1 }]);
  assert.equal(p2.cached, true);
  assert.equal(sql.length, 1);
  assert.equal(sql[0], "SELECT * FROM lakehouse.ws.lh.dbo.a LIMIT 100");
});

test("prefetch reads every table's metadata in the background, each once", async () => {
  const catalog = fakeCatalog();
  const ol = createOneLake({ catalog, store: createStore({ dir: null }) });
  const tables = await ol.tables(lh);
  await ol.table(lh, tables[0]);              // already known: skipped
  ol.prefetch(lh, tables);
  ol.prefetch(lh, tables);                    // a second expand queues nothing new
  // A click while the prefetch runs shares its request.
  await ol.table(lh, tables[2]);
  await new Promise(r => setTimeout(r, 50));
  const loads = catalog.calls.filter(c => c.startsWith("load"));
  assert.deepEqual(loads.sort(), ["load a", "load b", "load c"]);
});

test("prefetch can be turned off", async () => {
  const catalog = fakeCatalog();
  const ol = createOneLake({ catalog, store: createStore({ dir: null }), prefetchEnabled: () => false });
  ol.prefetch(lh, await ol.tables(lh));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(catalog.calls.filter(c => c.startsWith("load")).length, 0);
});

test("a changed listing is reported as WHICH listing, and survives a store swap", async () => {
  const catalog = fakeCatalog();
  let clock = 1_000;
  const mk = () => createStore({ dir: null, ttlMs: 10, now: () => clock });
  const ol = createOneLake({ catalog, store: mk() });
  const seen = [];
  ol.onChanged(c => seen.push(c));
  await ol.items("ws");
  catalog.listItems = async () => [{ name: "new.Lakehouse", kind: "Lakehouse" }];
  clock += 100;
  await ol.items("ws");
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(seen, [{ kind: "items", workspace: "ws" }]);

  // Another account: a new store, and the listener follows it there.
  ol.useStore(mk());
  await ol.items("ws");
  catalog.listItems = async () => [];
  clock += 100;
  await ol.items("ws");
  await new Promise(r => setTimeout(r, 20));
  assert.equal(seen.length, 2);
});

test("a listener let go twice lets go of itself only", async () => {
  const catalog = fakeCatalog();
  let clock = 1_000;
  const ol = createOneLake({ catalog, store: createStore({ dir: null, ttlMs: 10, now: () => clock }) });
  const a = [], b = [];
  const offA = ol.onChanged(c => a.push(c));
  ol.onChanged(c => b.push(c));
  offA();
  offA();
  await ol.items("ws");
  catalog.listItems = async () => [{ name: "new.Lakehouse", kind: "Lakehouse" }];
  clock += 100;
  await ol.items("ws");
  await new Promise(r => setTimeout(r, 20));
  assert.equal(a.length, 0);
  assert.equal(b.length, 1, "the other listener still hears");
});

test("a workspace's semantic models are a cached listing: Fabric is asked once", async () => {
  let asked = 0;
  const fabric = { listSemanticModels: async ws => { asked++; return [{ id: "m1", name: `model of ${ws}` }]; } };
  const onelake = createOneLake({ catalog: fakeCatalog(), store: createStore({ dir: null }), fabric });
  assert.deepEqual(await onelake.models("ws"), [{ id: "m1", name: "model of ws" }]);
  await onelake.models("ws");
  assert.equal(asked, 1, "the second expand is served from the store");
  await onelake.models("ws", { fresh: true });
  assert.equal(asked, 2, "and a Refresh asks again");
});

test("offline, what is kept is the answer, however old and whoever asks; a miss fails at once", async () => {
  let now = 1000, offline = false;
  const catalog = fakeCatalog();
  const onelake = createOneLake({ catalog, prefetchEnabled: () => true, isOffline: () => offline,
                                  store: createStore({ dir: null, ttlMs: 1000, now: () => now }) });
  const kept = await onelake.items("ws");
  offline = true;
  now += 365 * 24 * 3600 * 1000;
  catalog.calls.length = 0;
  assert.deepEqual(await onelake.items("ws"), kept, "past its window");
  assert.deepEqual(await onelake.items("ws", { fresh: true }), kept, "a Refresh");
  await new Promise(r => setImmediate(r));
  assert.deepEqual(catalog.calls, [], "nothing behind the caller either");

  onelake.prefetch(lh, [{ schema: "dbo", table: "a" }]);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(catalog.calls, [], "and nothing fetched ahead");

  // Not held: the fetcher runs, and it is the request (http.js) that refuses it.
  catalog.listItems = async () => { throw Object.assign(new Error("not cached"), { offline: true }); };
  await assert.rejects(onelake.items("other"), e => e.offline === true);
});

test("an item's name behind its GUIDs is kept for good: Fabric is asked once, whatever the case or age", async () => {
  let asked = 0;
  let now = 1000;
  const fabric = { itemOf: async () => { asked++; return { workspace: "Sales", item: "nem.Lakehouse" }; } };
  const onelake = createOneLake({ catalog: fakeCatalog(), store: createStore({ dir: null, now: () => now }), fabric });
  assert.deepEqual(await onelake.itemNamed("AAA", "BBB"), { workspace: "Sales", item: "nem.Lakehouse" });
  assert.deepEqual(await onelake.itemNamed("aaa", "bbb"), { workspace: "Sales", item: "nem.Lakehouse" });
  now += 365 * 24 * 3600 * 1000;
  assert.deepEqual(await onelake.itemNamed("aaa", "bbb"), { workspace: "Sales", item: "nem.Lakehouse" });
  await new Promise(r => setImmediate(r));   // a refresh behind the caller would have started by now
  assert.equal(asked, 1);
});

test("a workspace's apps are a cached listing too", async () => {
  let asked = 0;
  const fabric = { listApps: async ws => { asked++; return [{ id: "a1", name: `app of ${ws}`, url: "" }]; } };
  const onelake = createOneLake({ catalog: fakeCatalog(), store: createStore({ dir: null }), fabric });
  assert.deepEqual(await onelake.apps("ws"), [{ id: "a1", name: "app of ws", url: "" }]);
  await onelake.apps("ws");
  assert.equal(asked, 1);
  await onelake.apps("ws", { fresh: true });
  assert.equal(asked, 2);
});

test("a Files/ object's bytes are kept under the version its listing gave", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "onelake-bytes-"));
  try {
    const catalog = fakeCatalog();
    let version = "v1", reads = 0;
    catalog.listFiles = async () => [{ name: "a.png", path: "lh.Lakehouse/Files/img/a.png", isDir: false, bytes: 3, version }];
    catalog.readBytes = async (ws, path, { range } = {}) => { reads++; return range ? new Uint8Array([1]) : new Uint8Array([1, 2, 3]); };
    const hits = [];
    const onelake = createOneLake({ catalog, store: createStore({ dir }), onHit: e => hits.push(e) });
    const path = "lh.Lakehouse/Files/img/a.png";

    // No listing cached: no version to key on, so read live, every time.
    await onelake.readBytes("ws", path);
    await onelake.readBytes("ws", path);
    assert.equal(reads, 2);

    await onelake.files(lh, "img");
    assert.deepEqual([...await onelake.readBytes("ws", path)], [1, 2, 3]);
    assert.equal(reads, 3, "the first read under a version goes to OneLake");
    assert.deepEqual([...await onelake.readBytes("ws", path)], [1, 2, 3]);
    assert.deepEqual([...await onelake.readBytes("ws", path, { range: "bytes=1-1" })], [2],
      "a range of a kept file is a slice of it");
    assert.equal(reads, 3, "and every read after it is from disk");
    assert.ok(hits.some(h => h.path === `ws/${path}`), "a kept read is reported as a hit");

    // The file is rewritten: its listing gives a new version, and the bytes are read again.
    version = "v2";
    await onelake.files(lh, "img", { fresh: true });
    await onelake.readBytes("ws", path);
    assert.equal(reads, 4);
    assert.ok(await onelake.size() > 0);
    await onelake.clear();
    await onelake.files(lh, "img");
    await onelake.readBytes("ws", path);
    assert.equal(reads, 5, "Clear Cache takes the bytes with it");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("switching store does not leave tables marked as queued for prefetch", async () => {
  const catalog = fakeCatalog();
  let gate;
  const held = new Promise(r => { gate = r; });
  catalog.loadTable = async (l, t) => { catalog.calls.push(`load ${t.table}`); await held;
    return { metadata: metadata(), metadataLocation: LOC }; };
  const onelake = createOneLake({ catalog, store: createStore({ dir: null }) });
  const tables = [{ schema: "dbo", table: "a" }, { schema: "dbo", table: "b" },
                  { schema: "dbo", table: "c" }, { schema: "dbo", table: "d" }];
  onelake.prefetch(lh, tables);           // two run, two wait in the queue
  onelake.useStore(createStore({ dir: null }));
  gate();
  await new Promise(r => setTimeout(r, 20));
  catalog.calls.length = 0;
  onelake.prefetch(lh, tables);
  await new Promise(r => setTimeout(r, 20));
  for (const t of ["c", "d"]) assert.ok(catalog.calls.includes(`load ${t}`), `${t} was prefetched after the switch`);
});
