// What the extension remembers, in SQLite, with no DuckDB and no server anywhere near it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { createCatalogFile, catalogFileOf, stateFileOf } = require("../../src/catalogfile.js");
const { createStore, sameAnswer } = require("../../src/store.js");
const { summarize, walkCached } = require("../../src/onelake.js");

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "onelake-catalog-"));
  const opened = [];
  const open = (more = {}) => {
    const backend = createCatalogFile({ file: join(dir, "catalog.sqlite"), ...more });
    opened.push(backend);
    return { backend, store: createStore({ dir: join(dir, "blobs"), backend }) };
  };
  t.after(async () => {
    for (const b of opened) b.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return { dir, open, file: join(dir, "catalog.sqlite") };
}

test("an answer is kept, and survives the window that wrote it", async t => {
  const { open } = await setup(t);
  const one = open();
  await one.store.put("workspaces", ["a", "b's"]);
  one.backend.close();
  assert.deepEqual(await open().store.peek("workspaces"), ["a", "b's"]);
  assert.equal(await open().store.peek("items\0absent"), undefined);
});

test("when it was kept comes back too, so a kept answer still ages", async t => {
  const { open } = await setup(t);
  let clock = 1000;
  const first = createStore({ dir: null, backend: open().backend, now: () => clock });
  await first.put("workspaces", ["x"]);
  clock = 5000;
  const later = createStore({ dir: null, backend: open().backend, now: () => clock });
  assert.deepEqual(await later.known("workspaces"), { value: ["x"], at: 1000 });
});

test("a key with a NUL in it, as onelake.js makes them", async t => {
  const { open } = await setup(t);
  const { store } = open();
  await store.put("rows\0abfss://x", true);
  assert.equal(await open().store.peek("rows\0abfss://x"), true);
});

test("two windows see each other's answers, and a reader isn't held up by a writer", async t => {
  const { open, file } = await setup(t);
  const one = open(), two = open();
  await one.store.put("workspaces", ["kept"]);
  assert.deepEqual(await two.store.peek("workspaces"), ["kept"]);

  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  writer.exec("BEGIN IMMEDIATE");
  writer.exec("INSERT OR REPLACE INTO workspace VALUES ('held', 9)");
  const began = Date.now();
  assert.deepEqual(await createStore({ dir: null, backend: open().backend }).peek("workspaces"), ["kept"]);
  assert.ok(Date.now() - began < 400, "it did not wait for the writer");
  writer.exec("COMMIT");
});

test("Clear reaches what another window holds in memory", async t => {
  const { open } = await setup(t);
  const one = open();
  let told = 0;
  let twoStore = null;
  const two = open({ clearedEveryMs: 20, onCleared: () => { told++; twoStore.forget(); } });
  twoStore = two.store;
  await one.store.put("workspaces", ["kept"]);
  assert.deepEqual(await two.store.peek("workspaces"), ["kept"]);
  await one.store.clear();
  await sleep(200);
  assert.equal(told, 1);
  assert.equal(await two.store.peek("workspaces"), undefined);
});

test("a window isn't told of its own Clear", async t => {
  const { open } = await setup(t);
  let told = 0;
  const { store } = open({ clearedEveryMs: 20, onCleared: () => { told++; } });
  await store.put("workspaces", ["x"]);
  await store.clear();
  await sleep(100);
  assert.equal(told, 0);
});

test("past the limit, the oldest first rows go, down to 80%, and nothing else does", async t => {
  const { open } = await setup(t);
  const { backend } = open({ firstRowsMaxBytes: 2000 });
  await backend.write("workspaces", 1, JSON.stringify(["old but kept"]));
  await backend.write("item-named\0a\0b", 1, JSON.stringify({ workspace: "w", item: "i" }));
  await backend.write("rows\0loc", 1, "true");
  const peek = i => `peek\0_${String(i).padStart(3, "0")}`;
  for (let i = 0; i < 197; i++) await backend.write(peek(i), i + 10, JSON.stringify({ rows: "x".repeat(89) }));
  // The look comes on the 200th write, three of which weren't first rows: at peek(196). Each is 100 characters.
  assert.equal(await backend.read(peek(0)), null);
  assert.equal(await backend.read(peek(180)), null);
  assert.equal((await backend.read(peek(181))).at, 191);
  assert.equal((await backend.read(peek(196))).at, 206);
  assert.deepEqual(JSON.parse((await backend.read("workspaces")).json), ["old but kept"]);
  assert.ok(await backend.read("item-named\0a\0b"));
  assert.ok(await backend.read("rows\0loc"));
});

// What onelake.js really stores, built by the code that builds it.
const WS = "ANZ Retail", ITEM = "gold-1.Lakehouse";
const icebergMeta = (over = {}) => ({
  "current-snapshot-id": 2, "current-schema-id": 0, "format-version": 2, "default-spec-id": 0,
  schemas: [{ "schema-id": 0, fields: [{ id: 1, name: "id", type: "long" }, { id: 2, name: "ts", type: "timestamp" }] }],
  "partition-specs": [{ "spec-id": 0, fields: [{ name: "day", transform: "day" }] }],
  properties: { "write.parquet.compression-codec": "zstd" },
  snapshots: [
    { "snapshot-id": 1, "timestamp-ms": 1000, "schema-id": 0, summary: { operation: "append", "added-records": "5", "total-records": "5", "engine-name": "x", "engine-version": "1" } },
    { "snapshot-id": 2, "timestamp-ms": 2000, "schema-id": 0, summary: { operation: "append", "total-records": "9007199254740993", "total-files-size": "123", "total-data-files": "4", "total-delete-files": "0" } },
  ],
  ...over,
});

test("every kind of listing comes back as it went in, from real rows", async t => {
  const { open, file } = await setup(t);
  const { backend } = open();
  const answers = {
    workspaces: ["b", "a", "ANZ Retail"],
    [`items\0${WS}`]: [{ name: ITEM, kind: "Lakehouse" }, { name: "w.Warehouse", kind: "Warehouse", later: 1 }],
    [`tables\0${WS}\0${ITEM}`]: [{ schema: "dbo", table: "t" }, { schema: "sales", table: "order", note: "x" }],
    [`files\0${WS}\0${ITEM}\0raw`]: [
      { name: "d", path: "gold-1.Lakehouse/Files/raw/d", isDir: true, bytes: 0, version: "" },
      { name: "a.csv", path: "gold-1.Lakehouse/Files/raw/a.csv", isDir: false, bytes: 12, version: "etag" },
    ],
    [`models\0${WS}`]: [{ id: "1", name: "m", description: "" }],
    [`apps\0${WS}`]: [{ id: "2", name: "a", description: "", url: "https://x", deployedAt: "", access: "public" }],
  };
  for (const [k, v] of Object.entries(answers)) await backend.write(k, 7, JSON.stringify(v));
  for (const [k, v] of Object.entries(answers)) {
    const kept = await backend.read(k);
    assert.equal(kept.at, 7, k);
    assert.deepEqual(JSON.parse(kept.json), v, k);
    assert.equal(sameAnswer(JSON.parse(kept.json), v), true, k);
  }
  // They are tables, not values.
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  assert.deepEqual(db.prepare("SELECT name FROM workspace ORDER BY pos").all().map(r => r.name), ["b", "a", "ANZ Retail"]);
  assert.deepEqual({ ...db.prepare("SELECT workspace, schema_name, name FROM lake_table WHERE name = 'order'").get() },
    { workspace: WS, schema_name: "sales", name: "order" });
  assert.equal(db.prepare("SELECT bytes FROM lake_object WHERE name = 'a.csv'").get().bytes, 12);
});

test("an empty listing is an answer, and one never read isn't", async t => {
  const { open } = await setup(t);
  const { backend, store } = open();
  assert.equal(await backend.read(`tables\0${WS}\0${ITEM}`), null);
  await store.put(`tables\0${WS}\0${ITEM}`, []);
  await store.put(`files\0${WS}\0${ITEM}\0`, []);
  await store.put("workspaces", []);
  const fresh = open();
  assert.deepEqual(await fresh.store.peek(`tables\0${WS}\0${ITEM}`), []);
  assert.deepEqual(await fresh.store.peek(`files\0${WS}\0${ITEM}\0`), []);
  assert.deepEqual(await fresh.store.peek("workspaces"), []);
  assert.equal(await fresh.store.peek(`tables\0${WS}\0other`), undefined);
});

test("a table's metadata comes back the same, with its columns and history in tables", async t => {
  const { open, file } = await setup(t);
  const { backend } = open();
  const loc = "abfss://w@onelake.dfs.fabric.microsoft.com/i/Tables/t/metadata/2.metadata.json";
  const key = `table\0${WS}\0${ITEM}\0dbo\0t`;
  for (const value of [summarize(icebergMeta(), loc),
    summarize(icebergMeta({ properties: { XTABLE_METADATA: JSON.stringify({ sourceTableFormat: "DELTA", sourceIdentifier: 42 }), "delta.parquet.vorder.enabled": "true" } }), loc),
    summarize(icebergMeta({ "current-snapshot-id": -1, snapshots: [] }), loc)]) {
    await backend.write(key, 9, JSON.stringify(value));
    const kept = await backend.read(key);
    assert.equal(kept.at, 9);
    assert.equal(sameAnswer(JSON.parse(kept.json), value), true, `${kept.json}\n${JSON.stringify(value)}`);
  }
  await backend.write(key, 9, JSON.stringify(summarize(icebergMeta(), loc)));
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  assert.deepEqual(db.prepare("SELECT name, type FROM lake_column ORDER BY pos").all().map(r => [r.name, r.type]), [["id", "long"], ["ts", "timestamp"]]);
  assert.equal(db.prepare("SELECT total_records AS n FROM lake_table").get().n, 9007199254740993, "past 2^53, it can still be read");
  assert.deepEqual(db.prepare("SELECT version FROM snapshot ORDER BY pos").all().map(r => r.version), ["2", "1"]);
});

test("a summary kept before tables had a format is still noticed as one", async t => {
  const { open } = await setup(t);
  const { backend } = open();
  await backend.write(`table\0${WS}\0${ITEM}\0dbo\0old`, 1, JSON.stringify({ empty: true, schemaFields: [], totalRecords: 0, stats: null, metadataLocation: "x" }));
  assert.equal("format" in JSON.parse((await backend.read(`table\0${WS}\0${ITEM}\0dbo\0old`)).json), false);
});

test("a table a new listing no longer names leaves it, and its metadata stays", async t => {
  const { open } = await setup(t);
  const { backend } = open();
  const listing = `tables\0${WS}\0${ITEM}`;
  await backend.write(listing, 1, JSON.stringify([{ schema: "dbo", table: "kept" }, { schema: "dbo", table: "gone" }, { schema: "dbo", table: "gone2" }]));
  await backend.write(`table\0${WS}\0${ITEM}\0dbo\0gone`, 1, JSON.stringify(summarize(icebergMeta(), "loc")));
  await backend.write(listing, 2, JSON.stringify([{ schema: "dbo", table: "kept" }, { schema: "dbo", table: "new" }]));
  assert.deepEqual(JSON.parse((await backend.read(listing)).json).map(t => t.table), ["kept", "new"]);
  assert.ok(await backend.read(`table\0${WS}\0${ITEM}\0dbo\0gone`));
  assert.equal(await backend.read(`table\0${WS}\0${ITEM}\0dbo\0gone2`), null);
});

test("a table read by name before any listing isn't listed by it", async t => {
  const { open } = await setup(t);
  const { backend } = open();
  await backend.write(`table\0${WS}\0${ITEM}\0dbo\0early`, 1, JSON.stringify(summarize(icebergMeta(), "loc")));
  assert.equal(await backend.read(`tables\0${WS}\0${ITEM}`), null);
  await backend.write(`tables\0${WS}\0${ITEM}`, 2, "[]");
  assert.deepEqual(JSON.parse((await backend.read(`tables\0${WS}\0${ITEM}`)).json), []);
  assert.ok(await backend.read(`table\0${WS}\0${ITEM}\0dbo\0early`));
});

test("all the metadata is real tables, and there is no table of keys and values", async t => {
  const { open, file } = await setup(t);
  const { backend } = open();
  const state = { version: 12, asOf: 10, source: "checkpoint", id: "abc", createdTime: 1700000000000, partitionColumns: ["day"],
    properties: { "delta.columnMapping.mode": "name", "delta.appendOnly": "true" }, minReaderVersion: 2, minWriterVersion: 5,
    features: ["columnMapping", "deletionVectors"], sizeBytes: null, numFiles: null, deletedRows: 3 };
  const entries = {
    [`delta-commits\0${WS}\0${ITEM}\0dbo\0t`]: [{ version: 12, lastModified: 1700000000000 }, { version: 11, lastModified: null }],
    "delta-state\0ws\0i.Lakehouse/Tables/t\u000012": state,
    "item-named\0aaaa\0bbbb": { workspace: WS, item: ITEM },
    "irc\0ws/i": "ws-guid/item-guid",
    "rows\0abfss://x/metadata/1.metadata.json": true,
    [`file-read\0${WS}\0${ITEM}/Files/a.parquet\0etag`]: true,
    "peek\0abfss://x/metadata/1.metadata.json": { fields: [{ name: "id", type: "BIGINT" }], rows: [{ id: 1 }], numRows: 1 },
  };
  for (const [k, v] of Object.entries(entries)) await backend.write(k, 9, JSON.stringify(v));
  for (const [k, v] of Object.entries(entries)) {
    const kept = await backend.read(k);
    assert.equal(kept.at, 9, k);
    assert.deepEqual(JSON.parse(kept.json), v, k);
  }
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  for (const gone of ["kv", "meta", "listing", "sync_state"]) assert.ok(!tables.includes(gone), gone);
  for (const table of tables) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(r => r.name);
    assert.ok(!columns.includes("k") && !columns.includes("value") || table === "delta_property", `${table}: ${columns}`);
  }
  assert.deepEqual(db.prepare("SELECT version, last_modified FROM delta_commit ORDER BY pos").all().map(r => [r.version, r.last_modified]),
    [[12, 1700000000000], [11, null]]);
  assert.equal(db.prepare("SELECT value FROM delta_property WHERE name = 'delta.columnMapping.mode'").get().value, "name");
  assert.equal(db.prepare("SELECT deleted_rows AS n FROM delta_state").get().n, 3);
  assert.equal(db.prepare("SELECT prefix FROM catalog_prefix").get().prefix, "ws-guid/item-guid");
  assert.equal(db.prepare("SELECT workspace FROM item_name").get().workspace, WS);
  assert.equal(db.prepare("SELECT count(*) AS n FROM rows_read").get().n, 1);
  assert.equal(db.prepare("SELECT version FROM file_read").get().version, "etag");
  await backend.clear();
  for (const t of ["delta_commit", "delta_state", "delta_property", "item_name", "catalog_prefix", "rows_read", "file_read"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, t);
  }
});

test("a value with no table, or that doesn't fit its table, isn't kept", async t => {
  const { open } = await setup(t);
  const { backend, store } = open();
  await assert.rejects(backend.write("no such kind", 1, "1"), /no table/);
  await assert.rejects(backend.write(`items\0${WS}`, 1, JSON.stringify(["an older shape"])), /no table/);
  assert.equal(await backend.read(`items\0${WS}`), null);
  await store.put("no such kind", { rows: [] });
  assert.deepEqual(await store.peek("no such kind"), { rows: [] }, "the store still holds it in memory, as when any write fails");
  assert.equal(await open().store.peek("no such kind"), undefined);
});
test("Clear empties the tables too, and the size says so", async t => {
  const { open } = await setup(t);
  const { backend, store } = open();
  assert.equal(await backend.size(), 0);
  await store.put("workspaces", ["a"]);
  await store.put(`table\0${WS}\0${ITEM}\0dbo\0t`, summarize(icebergMeta(), "loc"));
  assert.ok(await backend.size() > 0);
  await store.clear();
  assert.equal(await backend.size(), 0);
  assert.equal(await open().store.peek("workspaces"), undefined);
  assert.equal(await open().store.peek(`table\0${WS}\0${ITEM}\0dbo\0t`), undefined);
});

test("a file from an older version moves over once, and its old tables go", async t => {
  const { open, file, dir } = await setup(t);
  await mkdir(dir, { recursive: true });
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE kv (k TEXT PRIMARY KEY, ts INTEGER NOT NULL, value TEXT NOT NULL);
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE listing (k TEXT PRIMARY KEY, ts INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE sync_state (k TEXT PRIMARY KEY, ts INTEGER NOT NULL, error TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE workspace (name TEXT PRIMARY KEY, pos INTEGER NOT NULL) WITHOUT ROWID;
    INSERT INTO workspace VALUES ('from a table', 0);
    INSERT INTO listing VALUES ('workspaces', 2);
    INSERT INTO meta VALUES ('imported', '1'), ('views-imported', '1'), ('cleared', 'abc');
    INSERT INTO sync_state VALUES ('workspaces', 1, 'old');
    PRAGMA user_version = 3;`);
  const add = old.prepare("INSERT INTO kv VALUES (?, ?, ?)");
  add.run("items␟a", 4, '[{"name":"i.Lakehouse","kind":"Lakehouse"}]');
  add.run("peek␟loc", 5, '{"rows":[]}');
  add.run("catalog snapshot", 6, "[]");
  add.run("rows␟other", 7, "true");
  add.run("item-named␟a␟b", 8, '{"workspace":"w","item":"i"}');
  old.close();

  const { backend } = open();
  assert.deepEqual(await backend.read("workspaces"), { at: 2, json: '["from a table"]' });
  assert.equal((await backend.read("items\0a")).at, 4);
  assert.deepEqual(await backend.read("peek\0loc"), { at: 5, json: '{"rows":[]}' });
  assert.equal(await backend.read("catalog snapshot"), null);
  assert.deepEqual(await backend.read("rows\0other"), { at: 7, json: "true" });
  assert.deepEqual(await backend.read("item-named\0a\0b"), { at: 8, json: '{"workspace":"w","item":"i"}' });
  assert.equal(backend.imported(), true, "what it had imported stays imported");
  backend.close();
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  for (const gone of ["kv", "meta", "listing", "sync_state"]) assert.ok(!tables.includes(gone), gone);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
  assert.equal(db.prepare("SELECT cleared FROM catalog_state").get().cleared, "abc");
});

test("a new file has its one state row", async t => {
  const { open, file } = await setup(t);
  await open().store.put("workspaces", ["kept"]);
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM catalog_state").get().n, 1);
  assert.throws(() => db.exec("INSERT INTO catalog_state (id) VALUES (2)"), /CHECK/);
});
test("an import puts catalog data in the tables, and leaves newer rows alone", async t => {
  const { dir, open, file } = await setup(t);
  const jsonDir = join(dir, "json");
  await mkdir(jsonDir);
  await writeFile(join(jsonDir, "a.json"), JSON.stringify({ key: "workspaces", at: 1, value: ["old"] }));
  await writeFile(join(jsonDir, "b.json"), JSON.stringify({ key: `items\0${WS}`, at: 1, value: [{ name: "i", kind: "Lakehouse" }] }));
  const { backend, store } = open();
  await store.put("workspaces", ["new"]);
  await backend.importKept({ jsonDir });
  assert.deepEqual(await store.peek("workspaces"), ["new"]);
  assert.deepEqual(JSON.parse((await backend.read(`items\0${WS}`)).json), [{ name: "i", kind: "Lakehouse" }]);
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS n FROM item").get().n, 1);
});

test("a refresh that finds the same answer isn't a change, whatever order it reads in", async t => {
  const { open } = await setup(t);
  let clock = 1000;
  const backend = open().backend;
  const store = createStore({ dir: null, backend, ttlMs: 10, now: () => clock });
  await store.get("workspaces", async () => ["a"]);
  const key = `files\0${WS}\0${ITEM}\0`;
  const answer = [{ name: "a", path: "p", isDir: false, bytes: 1, version: "" }];
  await store.get(key, async () => answer);
  const later = createStore({ dir: null, backend, ttlMs: 10, now: () => clock });
  const changed = [];
  later.on("changed", k => changed.push(k));
  clock += 100;
  await later.get(key, async () => [{ version: "", bytes: 1, isDir: false, path: "p", name: "a" }]);
  await sleep(20);
  assert.deepEqual(changed, []);
  clock += 100;
  await later.get(key, async () => [{ name: "a", path: "p", isDir: false, bytes: 2, version: "" }]);
  await sleep(20);
  assert.equal(changed.length, 1, "and a real change is");
});

test("walking a large catalog is quick enough to do on every listing", async t => {
  const { open } = await setup(t);
  const { backend, store } = open();
  const walkStore = createStore({ dir: null, backend });
  await store.put("workspaces", ["w"]);
  await store.put("items\0w", [{ name: "i.Lakehouse", kind: "Lakehouse" }]);
  await store.put("models\0w", []);
  const list = Array.from({ length: 5000 }, (_, i) => ({ schema: "dbo", table: `t${i}` }));
  await store.put(`tables\0w\0i.Lakehouse`, list);
  const meta = summarize(icebergMeta(), "loc");
  for (const t of list) await backend.write(`table\0w\0i.Lakehouse\0dbo\0${t.table}`, 1, JSON.stringify(meta));
  const cached = {
    workspaces: () => walkStore.known("workspaces"),
    items: w => walkStore.known(`items\0${w}`),
    models: w => walkStore.known(`models\0${w}`),
    tables: l => walkStore.known(`tables\0${l.workspace}\0${l.item}`),
    table: (l, x) => walkStore.known(`table\0${l.workspace}\0${l.item}\0${x.schema}\0${x.table}`),
  };
  const began = performance.now();
  const all = await walkCached(cached);
  const ms = Math.round(performance.now() - began);
  t.diagnostic(`walked 5000 tables in ${ms}ms`);
  console.log(`walked 5000 tables in ${ms}ms`);
  assert.equal(all.workspaces[0].items[0].tables.length, 5000);
  assert.ok(all.workspaces[0].items[0].tables[4999].meta.schemaFields.length === 2);
  assert.ok(ms < 15000, `${ms}ms`);
});

test("a file that isn't a database is set aside, and started again", async t => {
  const { dir, open, file } = await setup(t);
  await mkdir(dir, { recursive: true });
  await writeFile(file, "not a database, and not going to be one, however long this text may run on");
  const said = [];
  const { store } = open({ log: line => said.push(line) });
  await store.put("workspaces", ["new"]);
  assert.deepEqual(await store.peek("workspaces"), ["new"]);
  assert.match(readFileSync(`${file}.bad`, "utf8"), /not a database/);
  assert.match(said.join(), /set aside/);
});

test("a file that can't be read reads as nothing cached, says why once, and fails nothing", async t => {
  const { dir } = await setup(t);
  const blocked = join(dir, "a-file");
  await writeFile(blocked, "");
  const said = [];
  const backend = createCatalogFile({ file: join(blocked, "catalog.sqlite"), log: line => said.push(line) });
  t.after(() => backend.close());
  const store = createStore({ dir: null, backend });
  assert.equal(await store.peek("k"), undefined);
  await store.put("k", 1);
  assert.equal(said.length, 1);
  assert.match(said[0], /nothing is remembered/);
});

test("the JSON store is imported once, what is newer stays, and what Clear takes doesn't come back", async t => {
  const { dir, open } = await setup(t);
  const jsonDir = join(dir, "json");
  await mkdir(jsonDir);
  await writeFile(join(jsonDir, "a.json"), JSON.stringify({ key: "items\0from a file", at: 123, value: [{ name: "it's" }] }));
  await writeFile(join(jsonDir, "b.json"), JSON.stringify({ key: "workspaces", at: 1, value: ["old"] }));
  await writeFile(join(jsonDir, "c.json"), "not json");

  const { backend, store } = open();
  await store.put("workspaces", ["new"]);
  assert.equal(backend.imported(), false);
  assert.equal(await backend.importKept({ jsonDir }), 2);
  assert.equal(backend.imported(), true);
  assert.deepEqual(await store.known("items\0from a file"), { value: [{ name: "it's" }], at: 123 });
  assert.deepEqual(await store.peek("workspaces"), ["new"]);

  await store.clear();
  assert.equal(await open().backend.importKept({ jsonDir }), 0);
  assert.equal(await open().store.peek("items\0from a file"), undefined);
});
test("a Clear before any import keeps the old files from coming back", async t => {
  const { dir, open } = await setup(t);
  const jsonDir = join(dir, "json");
  await mkdir(jsonDir);
  await writeFile(join(jsonDir, "a.json"), JSON.stringify({ key: "items\0old", at: 1, value: [{ name: "n" }] }));
  const { backend, store } = open();
  await store.clear();
  assert.equal(await backend.importKept({ jsonDir }), 0);
  assert.equal(await store.peek("items\0old"), undefined);
});
test("a state file's entries come across a page at a time, and it can fail and be tried again", async t => {
  const { dir, open } = await setup(t);
  const rows = Array.from({ length: 1203 }, (_, i) => ({ k: `items␟w${String(i).padStart(5, "0")}`, ts: String(i), value: JSON.stringify([{ name: `n${i}` }]) }));
  let dropped = false;
  const fake = async sql => {
    if (/information_schema/.test(sql)) return [{ found: 1 }];
    if (/^DROP/.test(sql)) { dropped = true; return []; }
    if (/SELECT 1 AS done/.test(sql)) return [];
    const after = /k > '([^']*)'/.exec(sql)[1];
    return rows.filter(r => r.k > after).slice(0, 500);
  };
  const { backend, store } = open();
  await assert.rejects(backend.importKept({ run: async () => { throw new Error("held by another version"); } }));
  assert.equal(backend.imported(), false, "nothing is marked when it fails");

  assert.equal(await backend.importKept({ run: fake, jsonDir: join(dir, "none") }), 1203);
  assert.deepEqual(await store.peek("items\0w01202"), [{ name: "n1202" }]);
  assert.deepEqual(await store.known("items\0w00007"), { value: [{ name: "n7" }], at: 7 });
  assert.equal(dropped, true);
});
test("a state file that already took the JSON files, or was cleared since, keeps them out", async t => {
  const { dir, open } = await setup(t);
  const jsonDir = join(dir, "json");
  await mkdir(jsonDir);
  await writeFile(join(jsonDir, "a.json"), JSON.stringify({ key: "items\0gone", at: 1, value: [{ name: "n" }] }));
  const fake = async sql => {
    if (/information_schema/.test(sql)) return [{ found: 1 }];
    if (/SELECT 1 AS done/.test(sql)) return [{ done: 1 }];
    return [];
  };
  const { backend, store } = open();
  assert.equal(await backend.importKept({ run: fake, jsonDir }), 0);
  assert.equal(await store.peek("items\0gone"), undefined);
});
test("a state file with nothing left has nothing to import, and isn't an error", async t => {
  const { open } = await setup(t);
  const { backend } = open();
  const fake = async sql => (/information_schema/.test(sql) ? [] : []);
  assert.equal(await backend.importKept({ run: fake }), 0);
  assert.equal(backend.imported(), true);
});

test("the file's name is the account's, not the install's, and is not the state file's", () => {
  assert.equal(catalogFileOf("d", "me"), catalogFileOf("d", "me"));
  assert.notEqual(catalogFileOf("d", "me"), catalogFileOf("d", "you"));
  assert.match(catalogFileOf("d", "me"), /catalog-[0-9a-f]{16}\.sqlite$/);
  assert.match(stateFileOf("d", "me"), /state-[0-9a-f]{16}\.duckdb$/);
});

test("reading what is remembered loads no DuckDB", async t => {
  const { file, open } = await setup(t);
  const { store } = open();
  await store.put("workspaces", ["kept"]);
  const script = `
    const { createCatalogFile } = require(${JSON.stringify(require.resolve("../../src/catalogfile.js"))});
    const { createStore } = require(${JSON.stringify(require.resolve("../../src/store.js"))});
    const backend = createCatalogFile({ file: ${JSON.stringify(file)} });
    createStore({ dir: null, backend }).peek("workspaces").then(value => {
      backend.close();
      console.log(JSON.stringify({ value, duckdb: Object.keys(require.cache).filter(f => /duckdb/i.test(f)) }));
    });
  `;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { value: ["kept"], duckdb: [] });
  assert.ok(existsSync(file));
});
