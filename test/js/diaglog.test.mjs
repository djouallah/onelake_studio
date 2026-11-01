// A window's own log, and the two commands that read it: for debugging it, signed in or not, with
// nothing asked of OneLake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDiagLog } = require("../../src/diaglog.js");
const { createAgent } = require("../../src/agent.js");
const { createCatalogFile } = require("../../src/catalogfile.js");
const { createSyncWorker } = require("../../src/syncworker.js");
const { createOneLake } = require("../../src/onelake.js");
const { createStore } = require("../../src/store.js");
const { EXIT } = require("../../src/bridge.js");

const channel = () => {
  const lines = [];
  return { lines, appendLine: l => lines.push(l) };
};

test("each line has the time, and goes to the channel and the ring", () => {
  const c = channel();
  const log = createDiagLog(c, { now: () => new Date(2026, 10, 1, 13, 26, 45, 7) });
  log.appendLine("hello");
  assert.deepEqual(c.lines, ["13:26:45.007 hello"]);
  assert.deepEqual(log.lines(), ["13:26:45.007 hello"]);
});

test("the ring keeps the newest, and a read takes the newest of what matches", () => {
  const log = createDiagLog(channel(), { keep: 3, now: () => new Date(0) });
  for (const n of ["a1", "b2", "a3", "b4"]) log.appendLine(n);
  assert.equal(log.lines().length, 3, "past its limit the oldest go");
  assert.ok(!log.lines().some(l => l.endsWith("a1")));
  assert.deepEqual(log.lines({ text: "B" }).map(l => l.split(" ")[1]), ["b2", "b4"], "whatever the case");
  assert.deepEqual(log.lines({ limit: 1 }).map(l => l.split(" ")[1]), ["b4"]);
});

test("a step of starting says how long the process had been up, and is kept for status", () => {
  const c = channel();
  let up = 4274;
  const log = createDiagLog(c, { upMs: () => up, now: () => new Date(0) });
  log.mark("activation begins");
  up = 6900;
  log.mark("VS Code asked for the tree");
  assert.match(c.lines[0], /start: activation begins at 4274ms$/);
  assert.deepEqual(log.timeline(), [{ step: "activation begins", ms: 4274 }, { step: "VS Code asked for the tree", ms: 6900 }]);
});

const agentWith = (more = {}) => createAgent({
  onelake: {}, modelPath: () => "/nowhere", signedIn: () => false,
  diagnostics: {
    status: async () => ({ build: { version: "1", dev: false }, start: [{ step: "x", ms: 1 }], catalog: { rows: { workspace: 3 } }, sync: { failures: [] } }),
    log: ({ limit, text }) => ["13:00:00.000 start: x", "13:00:00.001 sync: y"].filter(l => !text || l.includes(text)).slice(-limit),
  },
  ...more,
});

test("status answers signed out, as Markdown lines and as JSON", async () => {
  const agent = agentWith();
  const md = await agent.run({ args: ["status"] });
  assert.equal(md.code, EXIT.OK, md.err);
  assert.match(md.out, /^build\.version: 1$/m);
  assert.match(md.out, /^build\.dev: false$/m);
  assert.match(md.out, /^start: \{"step":"x","ms":1\}$/m);
  assert.match(md.out, /^catalog\.rows\.workspace: 3$/m);
  assert.match(md.out, /^sync\.failures: none$/m);
  const json = JSON.parse((await agent.run({ args: ["status"], opts: { json: true } })).out);
  assert.equal(json.ok, true);
  assert.equal(json.data.catalog.rows.workspace, 3);
});

test("log answers signed out, filtered, with a limit and as JSON", async () => {
  const agent = agentWith();
  assert.equal((await agent.run({ args: ["log"] })).out, "13:00:00.000 start: x\n13:00:00.001 sync: y");
  assert.equal((await agent.run({ args: ["log", "sync:"] })).out, "13:00:00.001 sync: y");
  assert.equal((await agent.run({ args: ["log"], opts: { limit: 1 } })).out, "13:00:00.001 sync: y");
  assert.equal((await agent.run({ args: ["log", "nothing like this"] })).out, "(nothing)");
  assert.deepEqual(JSON.parse((await agent.run({ args: ["log", "start:"], opts: { json: true } })).out).data.lines, ["13:00:00.000 start: x"]);
});

test("everything else still needs signing in, and status says what it takes", async () => {
  const agent = agentWith();
  assert.equal((await agent.run({ args: ["ls"] })).code, EXIT.UNAVAILABLE);
  assert.equal((await agent.run({ args: ["status", "extra"] })).code, EXIT.USAGE);
  assert.equal((await agent.run({ args: ["status"], opts: { limit: 1 } })).code, EXIT.USAGE);
  assert.equal((await createAgent({ onelake: {}, modelPath: () => "" }).run({ args: ["status"] })).code, EXIT.FAILED);
});

test("the catalog describes itself, and says when it opens and moves", async t => {
  const dir = await mkdtemp(join(tmpdir(), "onelake-diag-"));
  const said = [];
  const file = join(dir, "catalog.sqlite");
  const backend = createCatalogFile({ file, log: l => said.push(l) });
  t.after(async () => { backend.close(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });
  await backend.write("workspaces", 1, JSON.stringify(["a", "b"]));
  const d = backend.describe();
  assert.equal(d.file, file);
  assert.equal(d.schema, 4);
  assert.equal(d.rows.workspace, 2);
  assert.ok(d.bytes > 0);
  assert.equal(d.imported, false);
  assert.ok(said.some(l => /^catalog: moving from schema 0 to 4/.test(l)), said.join());
  assert.ok(said.some(l => /^catalog: opened .*schema 4, in \d+ms/.test(l)), said.join());
});

const MIN = 60_000;
function syncing(more = {}) {
  const world = { now: 1_000_000, fail: () => null };
  const said = [];
  const call = (name, value) => { const e = world.fail(name); if (e) throw e; return value; };
  const catalog = { reset() {}, listWorkspaces: async () => call("workspaces", ["a"]), listItems: async () => call("items", [{ name: "g.Lakehouse", kind: "Lakehouse" }]),
    listTables: async () => call("tables", []) };
  const onelake = createOneLake({ catalog, prefetchEnabled: () => false, store: createStore({ dir: null, ttlMs: 10 * 24 * 60 * MIN, now: () => world.now }) });
  const worker = createSyncWorker({ onelake, ttlMs: () => 5 * MIN, isOffline: () => false, now: () => world.now, log: l => said.push(l), ...more });
  return { world, said, worker };
}

test("the sweep says what it did, and quiet ticks say nothing", async () => {
  const { said, worker, world } = syncing();
  await worker.tick();
  assert.ok(said.includes("sync: this window sweeps the tenant"), said.join("\n"));
  assert.ok(said.includes("sync: tenant sweep started"), said.join("\n"));
  assert.ok(said.some(l => /^sync: tenant sweep finished in \d+s$/.test(l)), said.join("\n"));
  assert.ok(said.some(l => /^sync: 3 listing\(s\) in \d+ms: 3 tenant$/.test(l)), said.join("\n"));
  said.length = 0;
  world.now += MIN;
  await worker.tick();
  assert.deepEqual(said, [], "nothing ran, so nothing is said");
});

test("losing the lease and pausing are said, and progress knows", async () => {
  let held = true;
  const { said, worker, world } = syncing({ lease: () => held });
  world.fail = n => (n === "workspaces" ? Object.assign(new Error("HTTP 429"), { status: 429 }) : null);
  await worker.tick();
  assert.ok(said.includes("sync: workspaces failed — HTTP 429"), said.join("\n"));
  assert.ok(said.some(l => /^sync: paused for 60s/.test(l)), said.join("\n"));
  const p = await worker.progress();
  assert.equal(p.lease, true);
  assert.ok(p.pausedUntil > world.now);
  assert.deepEqual(p.failures.map(f => [f.where, f.error]), [["workspaces", "HTTP 429"]]);
  held = false;
  world.now += 2 * MIN;
  await worker.tick();
  assert.ok(said.includes("sync: another window sweeps the tenant"), said.join("\n"));
});

test("progress counts what the sweep has left", async () => {
  const { worker } = syncing({ jobsPerTick: 1 });
  await worker.tick();
  assert.deepEqual((await worker.progress()).tenantDue, { items: 1 });
  await worker.tick();
  assert.deepEqual((await worker.progress()).tenantDue, { tables: 1 });
  await worker.tick();
  assert.deepEqual((await worker.progress()).tenantDue, {});
});
