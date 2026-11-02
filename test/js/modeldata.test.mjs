// modeldata.js: Download Data, every table of a model read whole. A fake engine and a fake OneLake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createModelData } = require("../../src/modeldata.js");

const CATALOG = "semanticmodel.ws.sales";
const FACT = "lakehouse.ws.data.dbo.fact", DIM = "lakehouse.ws.data.dbo.dim";
const SIZES = { fact: 4000, dim: 10 };

function setup({ tables = [FACT, DIM], offline = null, room = 1e6, ...more } = {}) {
  const asked = [], reads = [], noted = [], said = [], lines = [], kept = new Map();
  const data = createModelData({
    tablesOf: async () => tables,
    resolve: async (ref, o) => {
      asked.push([ref.table, o.fresh]);
      if (ref.table === "gone") throw new Error("there is no table gone");
      const listed = { workspace: ref.workspace, item: `${ref.item}.Lakehouse`, schema: ref.schema, table: ref.table };
      return ref.table === "empty" ? { listed, emptySql: "SELECT 1" } : { listed, metadataLocation: `at/${ref.table}/v2` };
    },
    cachedTable: async t => ({ value: { stats: { totalFilesSize: SIZES[t.table] ?? 1 } } }),
    read: (name, { signal }) => new Promise((resolve, reject) => {
      reads.push({ name, resolve, reject });
      signal.addEventListener("abort", () => reject(new Error("INTERRUPT Error: Interrupted!")));
    }),
    usage: { kept: (t, location) => kept.get(`${t.table}|${location}`) ?? null, noteKept: (t, k) => noted.push([t.table, k]) },
    offlineReason: () => offline,
    maxBytes: () => room,
    log: l => lines.push(l),
    now: () => 1000,
    ...more,
  });
  return { data, asked, reads, noted, said, lines, kept, say: m => said.push(m) };
}
const settled = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

test("every table, one at a time, at the snapshot it's at now, and each noted as read whole", async () => {
  const { data, asked, reads, noted, said, say } = setup();
  const going = data.download(CATALOG, "sales", { say });
  await settled();
  assert.deepEqual(asked, [["fact", true], ["dim", true]], "past the cache");
  assert.deepEqual(reads.map(r => r.name), [FACT], "one at a time");
  assert.equal(data.busy(), true);
  reads[0].resolve();
  await settled();
  assert.deepEqual(reads.map(r => r.name), [FACT, DIM]);
  reads[1].resolve();
  assert.match(await going, /sales is on this machine: 2 tables, .*with or without a connection/);
  assert.equal(data.busy(), false);
  assert.deepEqual(noted.map(([t, k]) => [t, k.location, k.total, k.error]), [["fact", "at/fact/v2", 4000, null], ["dim", "at/dim/v2", 10, null]]);
  assert.ok(noted.every(([, k]) => k.bytes === 0), "the idle job's budget isn't spent on what someone asked for");
  assert.ok(said.some(m => /1 of 2: fact/.test(m)), said.join("\n"));
});

test("what's already whole at this snapshot isn't read again", async () => {
  const { data, reads, kept } = setup();
  kept.set("fact|at/fact/v2", { error: null });
  const going = data.download(CATALOG, "sales");
  await settled();
  assert.deepEqual(reads.map(r => r.name), [DIM]);
  reads[0].resolve();
  assert.match(await going, /on this machine: 2 tables/);
});

test("a table that failed last time, or moved to a new snapshot, is read", async () => {
  const { data, reads, kept } = setup({ tables: [FACT] });
  kept.set("fact|at/fact/v2", { error: "not finished" });
  kept.set("fact|at/fact/v1", { error: null });
  const going = data.download(CATALOG, "sales");
  await settled();
  assert.deepEqual(reads.map(r => r.name), [FACT]);
  reads[0].resolve();
  await going;
});

test("Stop ends it where it is, says how far it got, and notes only what finished", async () => {
  const stop = new AbortController();
  const { data, reads, noted } = setup();
  const going = data.download(CATALOG, "sales", { signal: stop.signal });
  await settled();
  reads[0].resolve();
  await settled();
  assert.equal(reads.length, 2);
  stop.abort();
  assert.match(await going, /Stopped with 1 of 2 tables of sales down\. What was read stays/);
  assert.deepEqual(noted.map(([t]) => t), ["fact"]);
  assert.equal(data.busy(), false);
});

test("one table failing doesn't stop the rest, and the answer names it", async () => {
  const { data, reads, noted } = setup();
  const going = data.download(CATALOG, "sales");
  await settled();
  reads[0].reject(new Error("the read failed"));
  await settled();
  reads[1].resolve();
  await assert.rejects(going, /1 of 2 tables of sales came down\. lakehouse\.ws\.data\.dbo\.fact: the read failed/);
  assert.deepEqual(noted.map(([t]) => t), ["dim"], "a failure isn't noted as whole");
});

test("a table that can't be found is named, and the others come down", async () => {
  const { data, reads } = setup({ tables: ["lakehouse.ws.data.dbo.gone", DIM] });
  const going = data.download(CATALOG, "sales");
  await settled();
  assert.deepEqual(reads.map(r => r.name), [DIM]);
  reads[0].resolve();
  await assert.rejects(going, /1 of 2 tables of sales came down\. lakehouse\.ws\.data\.dbo\.gone: there is no table gone/);
});

test("an empty table has nothing to bring down", async () => {
  const { data, reads } = setup({ tables: ["lakehouse.ws.data.dbo.empty", DIM] });
  const going = data.download(CATALOG, "sales");
  await settled();
  assert.deepEqual(reads.map(r => r.name), [DIM]);
  reads[0].resolve();
  assert.match(await going, /on this machine: 1 table,/);
});

test("what can't work is said at once, with nothing read", async () => {
  const offline = setup({ offline: "there is no internet" });
  await assert.rejects(offline.data.download(CATALOG, "sales"), /needs a connection, and there is no internet/);
  assert.deepEqual(offline.asked, []);
  const noCache = setup({ room: 0 });
  await assert.rejects(noCache.data.download(CATALOG, "sales"), /diskCacheMaxGB turns it off/);
  const small = setup({ room: 100 });
  await assert.rejects(small.data.download(CATALOG, "sales"), /hold 3\.9 KB|hold 4\.\d* ?KB|hold .*disk cache holds/);
  assert.deepEqual(small.reads, [], "more than the disk cache holds would evict itself");
  const none = setup({ tables: [] });
  await assert.rejects(none.data.download(CATALOG, "sales"), /reads no tables/);
  assert.equal(small.data.busy(), false);
});

test("a second click on one under way joins it", async () => {
  const { data, reads } = setup({ tables: [DIM] });
  const one = data.download(CATALOG, "sales"), two = data.download(CATALOG.toUpperCase(), "sales");
  assert.equal(one, two);
  await settled();
  assert.equal(reads.length, 1);
  reads[0].resolve();
  await one;
});
