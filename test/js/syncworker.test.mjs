// syncworker.js: what changes the catalog with nobody asking, on a fake clock and a fake OneLake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSyncWorker } = require("../../src/syncworker.js");
const { createOneLake } = require("../../src/onelake.js");
const { createStore } = require("../../src/store.js");
const { createCatalogFile } = require("../../src/catalogfile.js");

const MIN = 60_000, DAY = 24 * 60 * MIN;

function setup({ workspaces = ["a", "b"], jobsPerTick = 100, ...more } = {}) {
  const world = { now: 1_000_000, offline: false, calls: [], fail: () => null, tables: () => [{ schema: "dbo", table: "t" }] };
  const call = (name, value) => {
    world.calls.push(name);
    const e = world.fail(name);
    if (e) throw e;
    return value;
  };
  const catalog = {
    reset() {},
    listWorkspaces: async () => call("workspaces", workspaces),
    listItems: async ws => call(`items ${ws}`, [{ name: "gold.Lakehouse", kind: "Lakehouse" },
                                               { name: "StagingLakehouseForDataflows_1.Lakehouse", kind: "Lakehouse" }]),
    listTables: async lh => call(`tables ${lh.workspace}`, world.tables()),
    listFiles: async (lh, dir) => call(`files ${lh.workspace}/${dir}`, []),
  };
  const fabric = { reset() {}, listSemanticModels: async ws => call(`models ${ws}`, []), listApps: async ws => call(`apps ${ws}`, []) };
  const onelake = createOneLake({ catalog, fabric, prefetchEnabled: () => false, isOffline: () => world.offline,
    store: createStore({ dir: null, ttlMs: 10 * DAY, now: () => world.now }) });
  const worker = createSyncWorker({ onelake, ttlMs: () => 5 * MIN, isOffline: () => world.offline, now: () => world.now,
    jobsPerTick, ...more });
  return { world, onelake, worker };
}

test("it sweeps the tenant's listings, no table's metadata and no staging item", async () => {
  const { world, worker } = setup();
  await worker.tick();
  assert.deepEqual(world.calls, ["workspaces", "items a", "tables a", "items b", "tables b"]);
});

test("a sweep is gentle: a few listings a tick, carrying on from where it got to", async () => {
  const { world, worker } = setup({ jobsPerTick: 2 });
  await worker.tick();
  assert.deepEqual(world.calls, ["workspaces", "items a"]);
  await worker.tick();
  assert.deepEqual(world.calls.slice(2), ["tables a", "items b"]);
  await worker.tick();
  assert.deepEqual(world.calls.slice(4), ["tables b"]);
});

test("nothing is read again until 12 hours have passed", async () => {
  const { world, worker } = setup();
  await worker.tick();
  world.calls.length = 0;
  world.now += 11 * 60 * MIN;
  await worker.tick();
  assert.deepEqual(world.calls, []);
  world.now += 61 * MIN;
  await worker.tick();
  assert.ok(world.calls.includes("workspaces"));
  assert.ok(world.calls.includes("tables b"));
});

test("only the window with the lease sweeps the tenant", async () => {
  const { world, worker } = setup({ lease: () => false });
  await worker.tick();
  assert.deepEqual(world.calls, []);
});

test("models are swept only with a Fabric token already there", async () => {
  const { world, worker } = setup({ workspaces: ["a"], canFabric: async () => true });
  await worker.tick();
  assert.ok(world.calls.includes("models a"));
});

test("what is open is kept current past the listing's TTL, in any window, lease or not", async () => {
  const opened = [{ kind: "tables", workspace: "a", item: "gold.Lakehouse" }, { kind: "files", workspace: "a", item: "gold.Lakehouse", dir: "raw" }, { kind: "apps", workspace: "a" }];
  const { world, onelake, worker } = setup({ opened: () => opened, lease: () => false });
  await worker.tick();
  assert.deepEqual(world.calls, ["workspaces", "tables a", "files a/raw", "apps a"]);
  world.calls.length = 0;
  world.now += 4 * MIN;
  await worker.tick();
  assert.deepEqual(world.calls, [], "not before");
  world.now += 2 * MIN;
  const changed = [];
  const off = onelake.onChanged(c => changed.push(c.kind));
  world.tables = () => [{ schema: "dbo", table: "t" }, { schema: "dbo", table: "added in Fabric" }];
  await worker.tick();
  off();
  assert.ok(world.calls.includes("tables a"));
  assert.ok(changed.includes("tables"), "a table added in Fabric reaches the tree with no click");
});

test("pinned workspaces are kept current too", async () => {
  const { world, worker } = setup({ pinned: () => ["b"], lease: () => false });
  await worker.tick();
  assert.deepEqual(world.calls, ["items b", "tables b"]);
  world.calls.length = 0;
  world.now += 6 * MIN;
  await worker.tick();
  assert.deepEqual(world.calls, ["items b", "tables b"]);
});

test("offline, nothing is asked, and it picks up by itself", async () => {
  const { world, worker } = setup();
  world.offline = true;
  await worker.tick();
  assert.deepEqual(world.calls, []);
  world.offline = false;
  await worker.tick();
  assert.ok(world.calls.length > 0);
});

test("going offline mid-sweep stops it there", async () => {
  const { world, worker } = setup();
  world.fail = name => { if (name === "items a") world.offline = true; return null; };
  await worker.tick();
  assert.deepEqual(world.calls, ["workspaces", "items a"]);
});

test("a listing that fails doesn't stop the rest, and isn't asked again for an hour", async () => {
  const said = [];
  const { world, worker } = setup({ log: l => said.push(l) });
  world.fail = name => (name === "items a" ? Object.assign(new Error("HTTP 403"), { status: 403 }) : null);
  await worker.tick();
  assert.ok(world.calls.includes("tables b"));
  assert.match(said.join(), /items a failed — HTTP 403/);
  world.calls.length = 0;
  world.now += 11 * MIN;
  await worker.tick();
  assert.ok(!world.calls.includes("items a"));
  world.now += 60 * MIN;
  world.fail = () => null;
  await worker.tick();
  assert.ok(world.calls.includes("items a"));
});

test("told to slow down, or with no answer at all, everything waits a minute", async () => {
  for (const e of [Object.assign(new Error("HTTP 429"), { status: 429 }), new Error("fetch failed")]) {
    const { world, worker } = setup();
    world.fail = name => (name === "items a" ? e : null);
    await worker.tick();
    assert.deepEqual(world.calls, ["workspaces", "items a"], e.message);
    world.calls.length = 0;
    world.now += 30_000;
    await worker.tick();
    assert.deepEqual(world.calls, [], e.message);
    world.now += 31_000;
    world.fail = () => null;
    await worker.tick();
    assert.ok(world.calls.includes("items b"), e.message);
  }
});

test("an idle sweep isn't walked every tick, and another account starts over", async () => {
  let leases = 0;
  const { world, worker } = setup({ lease: () => { leases++; return true; } });
  await worker.tick();
  await worker.tick();
  assert.equal(leases, 1, "nothing was due, so it rests");
  world.now += 11 * MIN;
  await worker.tick();
  assert.equal(leases, 2);
  worker.reset();
  await worker.tick();
  assert.equal(leases, 3);
});

test("one tick at a time, and a reset stops what is under way", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = [];
  const onelake = createOneLake({ prefetchEnabled: () => false, store: createStore({ dir: null, ttlMs: DAY }),
    catalog: { reset() {}, listWorkspaces: async () => { calls.push("workspaces"); await gate; return ["a"]; },
               listItems: async () => { calls.push("items"); return []; } } });
  const worker = createSyncWorker({ onelake, ttlMs: () => MIN, isOffline: () => false });
  const first = worker.tick();
  for (let i = 0; i < 100 && !calls.length; i++) await new Promise(r => setTimeout(r, 5));
  await worker.tick();
  assert.deepEqual(calls, ["workspaces"]);
  worker.reset();
  release();
  await first;
  assert.deepEqual(calls, ["workspaces"], "not on into the other account's catalog");
});

// The catalog file's half: what ties windows together.
async function files(t) {
  const dir = await mkdtemp(join(tmpdir(), "onelake-sync-"));
  const opened = [];
  const open = more => {
    const f = createCatalogFile({ file: join(dir, "catalog.sqlite"), ...more });
    opened.push(f);
    return f;
  };
  t.after(async () => { for (const f of opened) f.close(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });
  return open;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test("one window holds the lease, and another takes over when it goes", async t => {
  const open = await files(t);
  const one = open(), two = open();
  assert.equal(one.lease("one", 1000, 5000), true);
  assert.equal(two.lease("two", 1000, 5500), false, "it is held");
  assert.equal(one.lease("one", 1000, 5800), true, "it keeps it");
  assert.equal(two.lease("two", 1000, 6500), false, "until the renewed time");
  assert.equal(two.lease("two", 1000, 6900), true, "it lapsed");
  assert.equal(one.lease("one", 1000, 7000), false);
});

test("what one window writes reaches another's store, and its memory", async t => {
  const open = await files(t);
  const one = open();
  const two = open({ clearedEveryMs: 20 });
  const a = createStore({ dir: null, backend: one }), b = createStore({ dir: null, backend: two });
  await a.put("workspaces", ["first"]);
  assert.deepEqual(await b.peek("workspaces"), ["first"]);
  const heard = [];
  b.on("changed", k => heard.push(k));
  await a.put("workspaces", ["second"]);
  await a.put("items\0w", [{ name: "i", kind: "Lakehouse" }]);
  await a.put("table\0w\0i\0dbo\0t", { empty: true, schemaFields: [], totalRecords: 0, stats: null, metadataLocation: "x", format: "delta" });
  await sleep(120);
  assert.ok(heard.includes("workspaces"), heard.join());
  assert.ok(heard.includes("items\0w"), heard.join());
  assert.ok(heard.includes("table\0w\0i\0dbo\0t"), heard.join());
  assert.deepEqual(await b.peek("workspaces"), ["second"], "not what it held in memory");
});

test("a window doesn't hear its own writes back", async t => {
  const open = await files(t);
  const one = open({ clearedEveryMs: 20 });
  const a = createStore({ dir: null, backend: one });
  await a.put("workspaces", ["x"]);
  const heard = [];
  a.on("changed", k => heard.push(k));
  await a.put("workspaces", ["y"]);
  await sleep(80);
  assert.deepEqual(heard, []);
});

test("a failed read is noted, shown beside what is kept, and goes with the next good one", async t => {
  const open = await files(t);
  const backend = open();
  let clock = 1000;
  const store = createStore({ dir: null, backend, ttlMs: 10, now: () => clock });
  await store.get("workspaces", async () => ["kept"]);
  assert.equal(store.failureOf("workspaces"), null);
  clock += 100;
  await assert.rejects(store.get("workspaces", async () => { throw new Error("HTTP 500"); }, { fresh: true }));
  assert.deepEqual(store.failureOf("workspaces"), { at: 1100, error: "HTTP 500" });
  assert.deepEqual(await store.peek("workspaces"), ["kept"]);
  await store.get("workspaces", async () => ["back"], { fresh: true });
  assert.equal(store.failureOf("workspaces"), null);
});

test("being offline isn't noted as a failure of the listing", async t => {
  const open = await files(t);
  const store = createStore({ dir: null, backend: open() });
  await assert.rejects(store.get("workspaces", async () => { throw Object.assign(new Error("offline"), { offline: true }); }));
  assert.equal(store.failureOf("workspaces"), null);
});

test("someone waiting goes ahead of what the background has next, one request at a time", async () => {
  const { world, onelake } = setup();
  const release = [];
  const seen = [];
  let running = 0, most = 0;
  const hold = name => async () => {
    running++;
    most = Math.max(most, running);
    seen.push(name);
    await new Promise(r => release.push(r));
    running--;
    return name === "items" ? [] : ["a", "b"];
  };
  const held = { ...onelake, workspaces: hold("workspaces"), items: hold("items") };
  const worker = createSyncWorker({ onelake: held, ttlMs: () => 5 * MIN, isOffline: () => false, now: () => world.now, pinned: () => ["p1", "p2"], jobsPerTick: 2 });
  const tick = worker.tick();
  while (!release.length) await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, ["items"], "the first of the background's");
  const asked = worker.first({ kind: "workspaces" });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, ["items"], "nothing runs beside it");
  release.shift()();
  while (seen.length < 2) await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, ["items", "workspaces"], "the one waiting, ahead of the background's second");
  release.shift()();
  assert.deepEqual(await asked, ["a", "b"]);
  while (seen.length < 3) await new Promise(r => setImmediate(r));
  release.shift()();
  await tick;
  assert.deepEqual(seen, ["items", "workspaces", "items"]);
  assert.equal(most, 1);
});

test("first: a pause fails at once, its own 429 starts one, and a table's own failure doesn't", async () => {
  const { world, worker, onelake } = setup();
  world.fail = n => (n === "workspaces" ? Object.assign(new Error("HTTP 429"), { status: 429 }) : null);
  await assert.rejects(worker.first({ kind: "workspaces" }), /HTTP 429/);
  world.calls.length = 0;
  await assert.rejects(worker.first({ kind: "items", workspace: "a" }), /OneLake asked for a pause, which ends in 60s/);
  assert.deepEqual(world.calls, [], "nothing asked");
  world.now += 2 * MIN;
  world.fail = () => null;
  assert.deepEqual(await worker.first({ kind: "workspaces" }), ["a", "b"]);

  const bad = createSyncWorker({ onelake: { ...onelake, table: async () => { throw new Error("the table metadata has no current-snapshot-id"); } },
    ttlMs: () => 5 * MIN, isOffline: () => false, now: () => world.now });
  const job = { kind: "table", workspace: "a", item: "gold.Lakehouse", schema: "dbo", table: "t" };
  await assert.rejects(bad.first(job), /current-snapshot-id/);
  const p = await bad.progress();
  assert.equal(p.pausedUntil, null, "that says nothing about OneLake");
  assert.equal(p.failures[0].where, "table a/gold.Lakehouse/dbo/t");
});

test("first: nobody waiting any more is not read", async () => {
  const { world, worker } = setup();
  const gone = new AbortController();
  gone.abort();
  await assert.rejects(worker.first({ kind: "workspaces" }, { signal: gone.signal }), /nobody is waiting/);
  assert.deepEqual(world.calls, []);
});
