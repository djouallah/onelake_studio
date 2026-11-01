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
const { createStore } = require("../../src/store.js");

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
  await one.store.put("listing", ["a", "b's"]);
  one.backend.close();
  assert.deepEqual(await open().store.peek("listing"), ["a", "b's"]);
  assert.equal(await open().store.peek("absent"), undefined);
});

test("when it was kept comes back too, so a kept answer still ages", async t => {
  const { open } = await setup(t);
  let clock = 1000;
  const first = createStore({ dir: null, backend: open().backend, now: () => clock });
  await first.put("k", { n: 1 });
  clock = 5000;
  const later = createStore({ dir: null, backend: open().backend, now: () => clock });
  assert.deepEqual(await later.known("k"), { value: { n: 1 }, at: 1000 });
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
  await one.store.put("listing", ["kept"]);
  assert.deepEqual(await two.store.peek("listing"), ["kept"]);

  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  writer.exec("BEGIN IMMEDIATE");
  writer.exec("INSERT OR REPLACE INTO kv VALUES ('held', 1, '1')");
  const began = Date.now();
  assert.deepEqual(await createStore({ dir: null, backend: open().backend }).peek("listing"), ["kept"]);
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
  await one.store.put("listing", ["kept"]);
  assert.deepEqual(await two.store.peek("listing"), ["kept"]);
  await one.store.clear();
  await sleep(200);
  assert.equal(told, 1);
  assert.equal(await two.store.peek("listing"), undefined);
});

test("a window isn't told of its own Clear", async t => {
  const { open } = await setup(t);
  let told = 0;
  const { store } = open({ clearedEveryMs: 20, onCleared: () => { told++; } });
  await store.put("k", 1);
  await store.clear();
  await sleep(100);
  assert.equal(told, 0);
});

test("past the budget, the oldest go first, down to 80%", async t => {
  const { open } = await setup(t);
  const { backend } = open({ maxBytes: () => 2000 });
  for (let i = 0; i < 200; i++) await backend.write(`k${String(i).padStart(3, "0")}`, i, "x".repeat(100));
  assert.ok(await backend.size() <= 1600, `kept ${await backend.size()}`);
  assert.equal(await backend.read("k000"), null);
  assert.equal((await backend.read("k199")).at, 199);
});

test("a file that isn't a database is set aside, and started again", async t => {
  const { dir, open, file } = await setup(t);
  await mkdir(dir, { recursive: true });
  await writeFile(file, "not a database, and not going to be one, however long this text may run on");
  const said = [];
  const { store } = open({ log: line => said.push(line) });
  await store.put("listing", ["new"]);
  assert.deepEqual(await store.peek("listing"), ["new"]);
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
  await writeFile(join(jsonDir, "a.json"), JSON.stringify({ key: "from a file", at: 123, value: { kept: true, q: "it's" } }));
  await writeFile(join(jsonDir, "b.json"), JSON.stringify({ key: "newer here", at: 1, value: "old" }));
  await writeFile(join(jsonDir, "c.json"), "not json");

  const { backend, store } = open();
  await store.put("newer here", "new");
  assert.equal(backend.imported(), false);
  assert.equal(await backend.importKept({ jsonDir }), 2);
  assert.equal(backend.imported(), true);
  assert.deepEqual(await store.known("from a file"), { value: { kept: true, q: "it's" }, at: 123 });
  assert.equal(await store.peek("newer here"), "new");

  await store.clear();
  assert.equal(await open().backend.importKept({ jsonDir }), 0);
  assert.equal(await open().store.peek("from a file"), undefined);
});

test("a Clear before any import keeps the old files from coming back", async t => {
  const { dir, open } = await setup(t);
  const jsonDir = join(dir, "json");
  await mkdir(jsonDir);
  await writeFile(join(jsonDir, "a.json"), JSON.stringify({ key: "old", at: 1, value: 1 }));
  const { backend, store } = open();
  await store.clear();
  assert.equal(await backend.importKept({ jsonDir }), 0);
  assert.equal(await store.peek("old"), undefined);
});

test("a state file's entries come across a page at a time, and it can fail and be tried again", async t => {
  const { dir, open } = await setup(t);
  const rows = Array.from({ length: 1203 }, (_, i) => ({ k: `k${String(i).padStart(5, "0")}`, ts: String(i), value: JSON.stringify(i) }));
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
  assert.equal(await store.peek("k01202"), 1202);
  assert.deepEqual(await store.known("k00007"), { value: 7, at: 7 });
  assert.equal(dropped, true);
});

test("a state file that already took the JSON files, or was cleared since, keeps them out", async t => {
  const { dir, open } = await setup(t);
  const jsonDir = join(dir, "json");
  await mkdir(jsonDir);
  await writeFile(join(jsonDir, "a.json"), JSON.stringify({ key: "cleared long ago", at: 1, value: 1 }));
  const fake = async sql => {
    if (/information_schema/.test(sql)) return [{ found: 1 }];
    if (/SELECT 1 AS done/.test(sql)) return [{ done: 1 }];
    return [];
  };
  const { backend, store } = open();
  assert.equal(await backend.importKept({ run: fake, jsonDir }), 0);
  assert.equal(await store.peek("cleared long ago"), undefined);
});

test("a state file with no kv left has nothing to import, and isn't an error", async t => {
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
  await store.put("listing", ["kept"]);
  const script = `
    const { createCatalogFile } = require(${JSON.stringify(require.resolve("../../src/catalogfile.js"))});
    const { createStore } = require(${JSON.stringify(require.resolve("../../src/store.js"))});
    const backend = createCatalogFile({ file: ${JSON.stringify(file)} });
    createStore({ dir: null, backend }).peek("listing").then(value => {
      backend.close();
      console.log(JSON.stringify({ value, duckdb: Object.keys(require.cache).filter(f => /duckdb/i.test(f)) }));
    });
  `;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { value: ["kept"], duckdb: [] });
  assert.ok(existsSync(file));
});
