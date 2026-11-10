// The command line and the catalog: the real SQLite file, the real store and OneLake behind it, the
// real cli/cli.mjs over a real pipe, and every way out to the network refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { withAgent } from "./cli-harness.mjs";

const require = createRequire(import.meta.url);
const { createAgent } = require("../../cli/agent.js");
const { createOneLake } = require("../../src/onelake.js");
const { createStore } = require("../../src/store.js");
const { createCatalogFile } = require("../../src/catalogfile.js");
const { createSyncWorker } = require("../../src/syncworker.js");
const { EXIT } = require("../../cli/bridge.js");

const LAKEHOUSE = "gold.Lakehouse";
const metadata = {
  "format-version": 2, "current-snapshot-id": 1, "current-schema-id": 0,
  schemas: [{ "schema-id": 0, fields: [{ id: 1, name: "id", type: "long", required: false }] }],
  snapshots: [{ "snapshot-id": 1, "timestamp-ms": 1, summary: { "total-records": "7" } }],
};

// What OneLake and Fabric said, for filling the catalog. `lots` more tables in the lakehouse.
const answering = (lots = 0) => ({
  catalog: {
    reset() {},
    listWorkspaces: async () => ["sales", "ops"],
    listItems: async ws => (ws === "sales" ? [{ name: LAKEHOUSE, kind: "Lakehouse" }, { name: "bronze.Lakehouse", kind: "Lakehouse" }] : []),
    listTables: async lh => (lh.item !== LAKEHOUSE ? null : [{ schema: "dbo", table: "orders" }, { schema: "dbo", table: "customers" },
      { schema: "mart", table: "customers" }, ...Array.from({ length: lots }, (_, i) => ({ schema: "dbo", table: `t${i}` }))]),
    listFiles: async () => [{ name: "a.parquet", path: `${LAKEHOUSE}/Files/raw/a.parquet`, isDir: false, bytes: 10, version: "v1" }],
    loadTable: async () => ({ metadata, metadataLocation: "abfss://x/metadata/1.json" }),
  },
  fabric: { reset() {}, listSemanticModels: async () => [{ id: "m1", name: "Sales", description: "" }], listApps: async () => [] },
});

// Anything that would reach out says so, and is counted.
function refused() {
  const asked = [];
  const no = name => async () => { asked.push(name); throw Object.assign(new Error(`refused: ${name}`), { code: "ECONNREFUSED" }); };
  return {
    asked,
    catalog: { reset() {}, listWorkspaces: no("workspaces"), listItems: no("items"), listTables: no("tables"), listFiles: no("files"), loadTable: no("loadTable"), readBytes: no("readBytes") },
    fabric: { reset() {}, listSemanticModels: no("models"), listApps: no("apps"), itemOf: no("itemOf") },
  };
}

async function catalogFile(t, { lots = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "onelake-cli-catalog-"));
  const file = join(dir, "catalog.sqlite");
  const opened = [];
  const open = () => { const b = createCatalogFile({ file }); opened.push(b); return createStore({ dir: join(dir, "blobs"), backend: b, ttlMs: 7 * 24 * 3600 * 1000 }); };
  t.after(async () => { for (const b of opened) b.close(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });
  const { catalog, fabric } = answering(lots);
  const filling = createOneLake({ catalog, fabric, prefetchEnabled: () => false, store: open() });
  await filling.workspaces();
  await filling.items("sales");
  await filling.models("sales");
  await filling.tables({ workspace: "sales", item: LAKEHOUSE });
  await filling.files({ workspace: "sales", item: LAKEHOUSE }, "raw");
  await filling.table({ workspace: "sales", item: LAKEHOUSE }, { schema: "dbo", table: "orders" });
  return { open, dir };
}

function agentOn(store, more = {}) {
  const net = refused();
  const onelake = createOneLake({ catalog: net.catalog, fabric: net.fabric, prefetchEnabled: () => false, store });
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/none.yaml", diagnostics: {
    status: async () => ({ build: { version: "1" } }), log: () => ["13:00:00.000 x"],
  }, ...more });
  return { agent, onelake, asked: net.asked };
}

// fetch too: nothing here may have gone around the fakes.
function noFetch(t) {
  const real = globalThis.fetch;
  let tried = 0;
  globalThis.fetch = async () => { tried++; throw new Error("refused"); };
  t.after(() => { globalThis.fetch = real; });
  return () => tried;
}

test("every metadata command answers from the catalog, with the network refused", async t => {
  const fetched = noFetch(t);
  const { open } = await catalogFile(t);
  const { agent, asked } = agentOn(open());
  const answered = [
    [["ls"], /sales/],
    [["ls", "sales"], /gold\.Lakehouse/],
    [["ls", "sales", "gold"], /orders/],
    [["items"], /gold\.Lakehouse/],
    [["items", "sales"], /bronze\.Lakehouse/],
    [["models", "sales"], /Sales/],
    [["files", "sales", "gold", "raw"], /a\.parquet/],
    [["find", "orders"], /dbo\.orders/],
    [["table", "sales", "gold", "dbo.orders"], /\| id \| long \|/],
    [["exists", "sales", "gold", "dbo.orders"], /^yes: dbo\.orders in sales\/gold\.Lakehouse/],
    [["status"], /build\.version: 1/],
    [["log"], /13:00:00/],
  ];
  await withAgent(agent, async ({ cli }) => {
    for (const [argv, wanted] of answered) {
      const r = await cli(argv);
      assert.equal(r.code, EXIT.OK, `${argv.join(" ")}: ${r.stderr}`);
      assert.match(r.stdout, wanted, argv.join(" "));
    }
  });
  assert.deepEqual(asked, [], "nothing asked of OneLake or Fabric");
  assert.equal(fetched(), 0);
});

test("whether a table exists: yes with how old that is, no with the closest names, or not cached", async t => {
  const { open } = await catalogFile(t);
  const { agent, asked } = agentOn(open());
  await withAgent(agent, async ({ cli }) => {
    let r = await cli(["exists", "SALES", "GOLD", "DBO.ORDERS", "--json"]);
    assert.equal(r.code, EXIT.OK, r.stdout);
    let body = JSON.parse(r.stdout);
    assert.equal(body.data.exists, true);
    assert.equal(body.data.workspace, "sales", "as OneLake spells it");
    assert.equal(body.data.item, LAKEHOUSE);
    assert.deepEqual(body.data.tables, ["dbo.orders"]);
    assert.deepEqual(body.data.sqlNames, ["lakehouse.sales.gold.dbo.orders"]);
    assert.ok(body.data.listingAsOf && body.cachedAt);

    r = await cli(["exists", "sales", "gold", "customers", "--json"]);
    assert.equal(r.code, EXIT.OK, "bare: in whichever schemas have it");
    assert.deepEqual(JSON.parse(r.stdout).data.tables, ["dbo.customers", "mart.customers"]);

    r = await cli(["exists", "sales", "gold", "dbo.orderz"]);
    assert.equal(r.code, EXIT.FAILED);
    assert.match(r.stderr, /no table "dbo\.orderz" in sales\/gold\.Lakehouse, as of just now — closest: dbo\.orders/);
    assert.equal(r.stdout, "", "the no is on stderr, like every failure");

    r = await cli(["exists", "sales", "gold", "orderz", "--json"]);
    assert.equal(r.code, EXIT.FAILED);
    const { error } = JSON.parse(r.stdout);
    assert.equal(error.exists, false, "a no, told apart from a failure");
    assert.deepEqual(error.closest, ["dbo.orders"]);
    assert.ok(error.listingAsOf);
    assert.equal(error.retry, undefined);

    r = await cli(["exists", "sales", "gold", "nothing_at_all_like_it", "--json"]);
    assert.equal(r.code, EXIT.FAILED);
    assert.deepEqual(JSON.parse(r.stdout).error.closest, [], "nothing near is nothing named");

    r = await cli(["exists", "sale", "gold", "x", "--json"]);
    assert.equal(r.code, EXIT.FAILED, "a workspace the list doesn't have");
    assert.deepEqual(JSON.parse(r.stdout).error.closest, ["sales"]);

    r = await cli(["exists", "sales", "gol", "x", "--json"]);
    assert.equal(r.code, EXIT.FAILED, "an item the workspace doesn't have");
    assert.deepEqual(JSON.parse(r.stdout).error.closest, [LAKEHOUSE]);

    // What was never read is never a no.
    r = await cli(["exists", "ops", "gold", "x", "--json"]);
    assert.equal(r.code, EXIT.NOT_CACHED, "the workspace's items were never listed");
    assert.equal(JSON.parse(r.stdout).error.retry, "--fresh");
    r = await cli(["exists", "sales", "bronze", "x", "--json"]);
    assert.equal(r.code, EXIT.NOT_CACHED, "the item's tables were never listed");
    assert.equal(JSON.parse(r.stdout).error.exists, undefined);
  });
  assert.deepEqual(asked, []);
});

test("with no workspace list held, an unknown workspace is not cached, not a no", async t => {
  const dir = await mkdtemp(join(tmpdir(), "onelake-cli-catalog-"));
  const backend = createCatalogFile({ file: join(dir, "catalog.sqlite") });
  t.after(async () => { backend.close(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });
  const { agent } = agentOn(createStore({ dir: null, backend }));
  const r = await agent.run({ args: ["exists", "anything", "gold", "x"] });
  assert.equal(r.code, EXIT.NOT_CACHED, r.err);
});

test("table says no for what its listing lacks, and not cached for what it lists", async t => {
  const { open } = await catalogFile(t);
  const { agent } = agentOn(open());
  let r = await agent.run({ args: ["table", "sales", "gold", "dbo.orderz"] });
  assert.equal(r.code, EXIT.FAILED);
  assert.match(r.err, /no table "dbo\.orderz".*closest: dbo\.orders/);
  r = await agent.run({ args: ["table", "sales", "gold", "dbo.customers"] });
  assert.equal(r.code, EXIT.NOT_CACHED, "listed, with its metadata not read");
  assert.match(r.err, /metadata is not cached yet/);
});

test("a folder that is no table: kept in the catalog, marked by ls and find, and a no from exists and table", async t => {
  const { open } = await catalogFile(t);
  const { catalog, fabric } = answering();
  catalog.loadTable = async () => {
    throw Object.assign(new Error("mart.customers is not a valid OneLake table: its folder has neither a Delta log nor Iceberg metadata"),
      { notValid: true, status: 404 });
  };
  const reading = createOneLake({ catalog, fabric, prefetchEnabled: () => false, store: open() });
  await assert.rejects(reading.table({ workspace: "sales", item: LAKEHOUSE }, { schema: "mart", table: "customers" }), /not a valid/);

  const { agent, asked } = agentOn(open());
  await withAgent(agent, async ({ cli }) => {
    let r = await cli(["exists", "sales", "gold", "mart.customers", "--json"]);
    assert.equal(r.code, EXIT.FAILED, r.stdout);
    const { error } = JSON.parse(r.stdout);
    assert.equal(error.exists, false);
    assert.equal(error.notValid, true);
    assert.match(error.message, /not a valid OneLake table/);

    r = await cli(["exists", "sales", "gold", "customers", "--json"]);
    assert.equal(r.code, EXIT.OK, "bare: the one of that name that is a table");
    assert.deepEqual(JSON.parse(r.stdout).data.tables, ["dbo.customers"]);

    r = await cli(["table", "sales", "gold", "mart.customers"]);
    assert.equal(r.code, EXIT.FAILED);
    assert.match(r.stderr, /not a valid OneLake table/);

    r = await cli(["ls", "sales", "gold"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.match(r.stdout, /mart\.customers \| not a valid table/);

    r = await cli(["find", "customers"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.match(r.stdout, /not a valid table/);
  });
  assert.deepEqual(asked, [], "nothing asked of OneLake");
});

test("--fresh is a job of the worker's, whose answer is what the catalog then holds", async t => {
  const { open } = await catalogFile(t);
  const store = open();
  let tables = [{ schema: "dbo", table: "new_one" }];
  const { catalog, fabric } = answering();
  catalog.listTables = async () => tables;
  const onelake = createOneLake({ catalog, fabric, prefetchEnabled: () => false, store });
  const jobs = [];
  const worker = createSyncWorker({ onelake, ttlMs: () => 60_000, isOffline: () => false });
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/none.yaml",
    readNow: (job, o) => { jobs.push(job.kind); return worker.first(job, o); } });

  let r = await agent.run({ args: ["exists", "sales", "gold", "dbo.new_one"] });
  assert.equal(r.code, EXIT.FAILED, "not in the listing held");
  r = await agent.run({ args: ["exists", "sales", "gold", "dbo.new_one"], opts: { fresh: true } });
  assert.equal(r.code, EXIT.OK, r.err);
  assert.deepEqual(jobs, ["items", "tables"]);
  r = await agent.run({ args: ["exists", "sales", "gold", "dbo.new_one"] });
  assert.equal(r.code, EXIT.OK, "and the catalog has it for everyone");

  tables = [];
  r = await agent.run({ args: ["exists", "sales", "gold", "dbo.new_one"], opts: { fresh: true } });
  assert.equal(r.code, EXIT.FAILED, "gone is a no");

  jobs.length = 0;
  r = await agent.run({ args: ["table", "sales", "gold", "dbo.orders"], opts: { fresh: true } });
  assert.equal(r.code, EXIT.OK, r.err);
  assert.deepEqual(jobs, ["items", "table"]);
  jobs.length = 0;
  r = await agent.run({ args: ["ls", "sales"], opts: { fresh: true, json: true } });
  assert.equal(r.code, EXIT.OK, r.err);
  assert.deepEqual(jobs, ["items", "models"]);
});

test("offline, --fresh fails at once with nothing asked", async t => {
  const { open } = await catalogFile(t);
  const { agent, asked } = agentOn(open(), { offlineReason: () => "no internet" });
  const r = await agent.run({ args: ["exists", "sales", "gold", "dbo.orders"], opts: { fresh: true } });
  assert.equal(r.code, EXIT.NOT_CACHED);
  assert.match(r.err, /there is no internet/);
  assert.deepEqual(asked, []);
  assert.equal((await agent.run({ args: ["exists", "sales", "gold", "dbo.orders"] })).code, EXIT.OK, "without it, the catalog answers");
});

// Over the real pipe, on a lakehouse the size of a big one. The limits catch a table scan or a read of
// every listing, not a slow runner: what this took is printed for the record.
test("a table-exists check, timed cold and warm", async t => {
  const { open } = await catalogFile(t, { lots: 5000 });
  const { agent } = agentOn(open());
  const timed = async () => {
    const t0 = performance.now();
    const r = await agent.run({ args: ["exists", "sales", "gold", "dbo.t4999"] });
    assert.equal(r.code, EXIT.OK, r.err);
    return performance.now() - t0;
  };
  const cold = await timed();
  const warm = await timed();
  const no = performance.now();
  assert.equal((await agent.run({ args: ["exists", "sales", "gold", "dbo.t49999"] })).code, EXIT.FAILED);
  const noMs = performance.now() - no;
  await withAgent(agent, async ({ cli }) => {
    const t0 = performance.now();
    const r = await cli(["exists", "sales", "gold", "dbo.t4999"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    const whole = performance.now() - t0;
    console.log(`exists over 5,003 tables: cold ${cold.toFixed(1)}ms, warm ${warm.toFixed(1)}ms, a no with the closest names ${noMs.toFixed(1)}ms, through cli/cli.mjs ${whole.toFixed(0)}ms`);
    assert.ok(whole < 5000, `${whole}ms`);
  });
  assert.ok(cold < 1000 && warm < 1000, `cold ${cold}ms, warm ${warm}ms`);
  assert.ok(noMs < 2000, `${noMs}ms`);
});
