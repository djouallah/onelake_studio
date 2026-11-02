// modeldata.js: Keep offline, a model's tables read whole and kept current. A fake engine, OneLake and clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createModelData } = require("../../src/modeldata.js");
const { createCatalogFile } = require("../../src/catalogfile.js");

const CATALOG = "semanticmodel.ws.sales", MODEL = "sales";
const FACT = "lakehouse.ws.data.dbo.fact", DIM = "lakehouse.ws.data.dbo.dim";
const HOUR = 3600 * 1000;
const settled = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

function setup({ tables = [FACT, DIM], room = 1e9, sizes = { fact: 4000, dim: 10 }, others = {}, ...more } = {}) {
  const world = { now: 1_000_000, offline: null, up: true, lease: true, version: 1, gone: new Set() };
  const asked = [], reads = [], kept = new Map(), lines = [], models = new Map();
  const key = (t, location) => `${t.table}|${location}`;
  const usage = {
    offlineModels: () => [...models.values()],
    setOffline: (catalog, model, on) => { if (on) models.set(catalog.toLowerCase(), { catalog, model }); else models.delete(catalog.toLowerCase()); },
    kept: (t, location) => kept.get(key(t, location)) ?? null,
    latestKept: t => [...kept.entries()].find(([k, v]) => k.startsWith(`${t.table}|`) && !v.error)?.[1] ?? null,
    noteKept: (t, k) => kept.set(key(t, k.location), k),
  };
  const data = createModelData({
    tablesOf: async catalog => { if (catalog in others) return others[catalog]; return tables; },
    resolve: async (ref, o) => {
      asked.push([ref.table, !!o.fresh]);
      if (world.gone.has(ref.table)) throw new Error(`there is no table ${ref.table}`);
      const listed = { workspace: ref.workspace, item: `${ref.item}.Lakehouse`, schema: ref.schema, table: ref.table };
      return ref.table === "empty" ? { listed, emptySql: "SELECT 1" } : { listed, metadataLocation: `at/${ref.table}/v${world.version}` };
    },
    cachedTable: async t => ({ value: { stats: { totalFilesSize: sizes[t.table] ?? 1 } } }),
    read: (name, { signal, onColumn }) => new Promise((resolve, reject) => {
      reads.push({ name, resolve, reject, onColumn });
      signal.addEventListener("abort", () => reject(new Error("INTERRUPT Error: Interrupted!")));
    }),
    usage,
    offlineReason: () => world.offline,
    ready: () => world.up,
    lease: () => world.lease,
    maxBytes: () => room,
    log: l => lines.push(l),
    now: () => world.now,
    ...more,
  });
  return { data, world, asked, reads, kept, lines, models };
}

test("what's on is a row in the catalog: remembered after a restart, one per model whatever its case", async () => {
  const dir = await mkdtemp(join(tmpdir(), "modeldata-"));
  const file = join(dir, "catalog.sqlite");
  try {
    const one = createCatalogFile({ file });
    assert.deepEqual(one.offlineModels(), []);
    one.setOffline(CATALOG, MODEL, true, 1000);
    one.setOffline("semanticmodel.ws.other", "other", true, 2000);
    one.setOffline(CATALOG.toUpperCase(), MODEL, true, 500);
    assert.equal(one.offlineModels().length, 2);
    one.close();
    const two = createCatalogFile({ file });
    assert.deepEqual(two.offlineModels().map(m => m.model).sort(), ["other", "sales"]);
    two.setOffline(CATALOG, MODEL, false, 3000);
    assert.deepEqual(two.offlineModels(), [{ catalog: "semanticmodel.ws.other", model: "other" }]);
    two.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("off to begin with, and off asks nothing", async () => {
  const { data, asked } = setup();
  assert.deepEqual(await data.state(CATALOG), { on: false, say: "", tone: "", busy: false });
  await data.tick();
  assert.deepEqual(asked, []);
});

test("switched on: every table at its latest, one at a time, saying how far, then all here", async () => {
  const { data, asked, reads, kept } = setup();
  const first = await data.set(CATALOG, MODEL, true);
  assert.deepEqual(asked.slice(0, 2), [["fact", false], ["dim", false]], "from what's kept, so it answers at once");
  assert.equal(first.on, true);
  assert.equal(first.busy, true);
  assert.match(first.say, /^0 of 2 tables · /);
  await settled();
  assert.ok(asked.some(([table, fresh]) => table === "fact" && fresh), "and past the cache, behind it");
  assert.deepEqual(reads.map(r => r.name), [FACT], "one at a time");
  assert.equal(data.busy(), true);
  reads[0].resolve();
  await settled();
  const middle = await data.state(CATALOG);
  assert.match(middle.say, /^1 of 2 tables · /);
  assert.equal(middle.meter, 100, "by bytes: the big one came first");
  assert.deepEqual(reads.map(r => r.name), [FACT, DIM]);
  reads[1].resolve();
  await settled();
  const done = await data.state(CATALOG);
  assert.match(done.say, /^✓ .* on this machine$/);
  assert.equal(done.tone, "good");
  assert.equal(done.busy, false);
  assert.equal(data.busy(), false);
  assert.equal(kept.get("fact|at/fact/v1").error, null);
  assert.equal(kept.get("fact|at/fact/v1").bytes, 0, "the idle job's budget isn't spent on what someone asked for");
});

test("switched off: the read stops, what finished stays noted, and nothing comes down after", async () => {
  const { data, world, reads, kept } = setup();
  await data.set(CATALOG, MODEL, true);
  await settled();
  reads[0].resolve();
  await settled();
  assert.equal(reads.length, 2);
  const off = await data.set(CATALOG, MODEL, false);
  assert.equal(off.on, false);
  await settled();
  assert.equal(data.busy(), false);
  assert.ok(kept.has("fact|at/fact/v1"));
  assert.ok(!kept.has("dim|at/dim/v1"), "stopped isn't whole");
  world.now += 2 * HOUR;
  await data.tick();
  await settled();
  assert.equal(reads.length, 2);
});

test("switched back on, it carries on from what's here", async () => {
  const { data, reads } = setup();
  await data.set(CATALOG, MODEL, true);
  await settled();
  reads[0].resolve();
  await settled();
  await data.set(CATALOG, MODEL, false);
  await settled();
  await data.set(CATALOG, MODEL, true);
  await settled();
  assert.deepEqual(reads.map(r => r.name), [FACT, DIM, DIM], "the fact table isn't read again");
});

test("switched back on with everything here, it says so at once: nothing is read, and nothing waits on OneLake", async () => {
  const { data, world, reads, asked } = setup();
  await data.set(CATALOG, MODEL, true);
  await settled();
  reads[0].resolve();
  await settled();
  reads[1].resolve();
  await settled();
  await data.set(CATALOG, MODEL, false);
  world.version = 2;
  asked.length = 0;
  const back = await data.set(CATALOG, MODEL, true);
  assert.equal(back.on, true);
  assert.match(back.say, /^✓ .* on this machine$/);
  assert.equal(back.busy, false);
  await settled();
  assert.ok(asked.every(([, fresh]) => !fresh), "OneLake isn't asked");
  assert.equal(reads.length, 2, "and nothing comes down again");
  // What's newer is looked for on the usual clock, behind what's already answering.
  world.now += HOUR + 1;
  await data.tick();
  await settled();
  assert.equal(reads.length, 3);
  assert.match((await data.state(CATALOG)).say, /^New data · 2 tables · /);
});

test("switched on, a table the kept listing can't find is looked for past the cache", async () => {
  const { data, world, asked } = setup({ tables: [DIM] });
  world.gone.add("dim");
  const said = await data.set(CATALOG, MODEL, true);
  assert.deepEqual(asked.slice(0, 2), [["dim", false], ["dim", true]]);
  assert.equal(said.on, true);
});

test("while it's on, new data comes down: within the hour, and says so", async () => {
  const { data, world, reads, asked } = setup({ tables: [FACT] });
  await data.set(CATALOG, MODEL, true);
  await settled();
  reads[0].resolve();
  await settled();
  world.version = 2;
  asked.length = 0;
  await data.tick();
  assert.deepEqual(asked, [], "not read past the cache again yet");
  world.now += HOUR + 1;
  await data.tick();
  await settled();
  assert.deepEqual(asked, [["fact", true]]);
  assert.equal(reads.length, 2, "the new snapshot is read");
  const now = await data.state(CATALOG);
  assert.match(now.say, /^New data · 1 table · /);
  assert.equal(now.busy, true);
  reads[1].resolve();
  await settled();
  assert.match((await data.state(CATALOG)).say, /^✓/);
});

test("too much for the disk cache stays off and says why, with nothing read", async () => {
  const { data, reads, models } = setup({ room: 100 });
  const said = await data.set(CATALOG, MODEL, true);
  assert.equal(said.on, false);
  assert.equal(said.refused, true);
  assert.equal(said.tone, "bad");
  assert.match(said.say, /won't fit: the disk cache is /);
  assert.equal(models.size, 0);
  await settled();
  assert.deepEqual(reads, []);
  const none = setup({ room: 0 });
  assert.match((await none.data.set(CATALOG, MODEL, true)).say, /disk cache is off/);
});

test("models already kept count toward what fits", async () => {
  const other = "semanticmodel.ws.other";
  const { data, reads } = setup({ room: 5000, others: { [other]: ["lakehouse.ws.data.dbo.big"] }, sizes: { fact: 4000, dim: 10, big: 2000 } });
  const first = await data.set(other, "other", true);
  assert.equal(first.on, true);
  await settled();
  reads[0].resolve();
  await settled();
  assert.match((await data.set(CATALOG, MODEL, true)).say, /won't fit/);
});

test("with no connection it can still be on, says what's here, and waits", async () => {
  const { data, world, reads } = setup();
  await data.set(CATALOG, MODEL, true);
  await settled();
  reads[0].resolve();
  await settled();
  world.offline = "there is no internet";
  await data.tick();
  await settled();
  const waiting = await data.state(CATALOG);
  assert.equal(waiting.on, true);
  assert.equal(waiting.tone, "warn");
  assert.match(waiting.say, /^No connection · 1 of 2 tables here$/);
  assert.equal(data.busy(), false, "what was reading stopped");
  const before = reads.length;
  await data.tick();
  await settled();
  assert.equal(reads.length, before);
  world.offline = null;
  await data.tick();
  await settled();
  assert.equal(reads.length, before + 1, "and it carries on by itself");

  const fresh = setup();
  fresh.world.offline = "there is no internet";
  assert.equal((await fresh.data.set(CATALOG, MODEL, true)).on, true, "switched on with no connection");
  assert.ok(fresh.asked.every(([, isFresh]) => !isFresh), "and nothing is asked past the cache");
});

test("one table failing doesn't stop the rest, says which, and is tried again later", async () => {
  const { data, world, reads } = setup();
  await data.set(CATALOG, MODEL, true);
  await settled();
  reads[0].reject(new Error("the read failed"));
  await settled();
  reads[1].resolve();
  await settled();
  const said = await data.state(CATALOG);
  assert.equal(said.tone, "bad");
  assert.match(said.say, /^1 of 2 tables here · fact: the read failed$/);
  assert.equal(reads.length, 2);
  await data.tick();
  await settled();
  assert.equal(reads.length, 2, "not at once");
  world.now += HOUR + 1;
  await data.tick();
  await settled();
  assert.equal(reads.length, 3);
});

test("the engine going away isn't the table's fault, and notes nothing", async () => {
  const { data, reads, kept } = setup({ tables: [FACT] });
  await data.set(CATALOG, MODEL, true);
  await settled();
  reads[0].reject(new Error("INTERRUPT Error: Interrupted!"));
  await settled();
  assert.equal(kept.size, 0);
  assert.equal(reads.length, 1, "and it isn't tried again in a tight loop");
  await data.tick();
  await settled();
  assert.equal(reads.length, 2, "the next tick tries again");
});

test("it says how far through a table it is, by its columns, without waiting for the table", async () => {
  const { data, reads } = setup({ tables: [FACT] });
  await data.set(CATALOG, MODEL, true);
  await settled();
  assert.equal((await data.state(CATALOG)).meter, 0);
  reads[0].onColumn(1, 4);
  const quarter = await data.state(CATALOG);
  assert.equal(quarter.meter, 25);
  assert.match(quarter.say, /^0 of 1 table · /);
  reads[0].onColumn(4, 4);
  assert.equal((await data.state(CATALOG)).meter, 100);
  reads[0].resolve();
  await settled();
  assert.match((await data.state(CATALOG)).say, /^✓/);
});

test("once nothing is left to read, what read it can go, and comes back for new data", async () => {
  let idle = 0;
  const { data, world, reads } = setup({ tables: [DIM], onIdle: () => { idle++; } });
  await data.tick();
  assert.equal(idle, 0, "nothing was reading");
  await data.set(CATALOG, MODEL, true);
  await settled();
  assert.equal(idle, 0, "still reading");
  reads[0].resolve();
  await settled();
  assert.equal(idle, 1);
  await data.tick();
  assert.equal(idle, 1, "said once");
  world.version = 2;
  world.now += HOUR + 1;
  await data.tick();
  await settled();
  assert.equal(reads.length, 2);
  reads[1].resolve();
  await settled();
  assert.equal(idle, 2);
});

test("switched off, what read it can go at the next look", async () => {
  let idle = 0;
  const { data, reads } = setup({ tables: [DIM], onIdle: () => { idle++; } });
  await data.set(CATALOG, MODEL, true);
  await settled();
  assert.equal(reads.length, 1);
  await data.set(CATALOG, MODEL, false);
  await settled();
  await data.tick();
  assert.equal(idle, 1);
});

test("a table that can't be found is named, and the others come down", async () => {
  const { data, world, reads } = setup();
  world.gone.add("fact");
  await data.set(CATALOG, MODEL, true);
  await settled();
  assert.deepEqual(reads.map(r => r.name), [DIM]);
  reads[0].resolve();
  await settled();
  assert.match((await data.state(CATALOG)).say, /^1 of 2 tables here · fact: there is no table fact$/);
});

test("an empty table has nothing to bring down", async () => {
  const { data, reads } = setup({ tables: ["lakehouse.ws.data.dbo.empty", DIM] });
  await data.set(CATALOG, MODEL, true);
  await settled();
  assert.deepEqual(reads.map(r => r.name), [DIM]);
  reads[0].resolve();
  await settled();
  assert.match((await data.state(CATALOG)).say, /^✓/);
});

test("only the window with the lease reads, and only with an engine up; any window can tell how it's going", async () => {
  const { data, world, reads } = setup({ tables: [DIM] });
  world.lease = false;
  const said = await data.set(CATALOG, MODEL, true);
  await settled();
  assert.deepEqual(reads, []);
  assert.equal(said.on, true);
  assert.match(said.say, /^0 of 1 table/);
  world.lease = true;
  world.up = false;
  await data.tick();
  await settled();
  assert.deepEqual(reads, [], "not while the engines are being stopped");
  world.up = true;
  await data.tick();
  await settled();
  assert.equal(reads.length, 1);
});

test("a Pivot asking often asks OneLake nothing new", async () => {
  const { data, asked } = setup({ tables: [DIM] });
  await data.set(CATALOG, MODEL, true);
  await settled();
  const before = asked.length;
  for (let i = 0; i < 5; i++) await data.state(CATALOG);
  assert.equal(asked.length, before);
});

test("another account's catalog: what's under way stops, and nothing known carries over", async () => {
  const { data, world, reads, asked } = setup({ tables: [DIM] });
  await data.set(CATALOG, MODEL, true);
  await settled();
  assert.equal(data.busy(), true);
  data.reset();
  await settled();
  assert.equal(data.busy(), false);
  asked.length = 0;
  world.up = false;
  await data.state(CATALOG);
  assert.deepEqual(asked, [["dim", false]]);
  assert.equal(reads.length, 1);
});
