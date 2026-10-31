// The shared engine on the DuckDB that ships: a real server process and real Quack clients, with
// no editor and no OneLake. Windows here are engines in this process, each with its own control
// socket, which is all a window is to the server.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createEngineHost } = require("../../src/engine-host.js");
const { createRemote, createStateClient, openClient, pipePath } = require("../../src/engine-client.js");
const { createStateBackend } = require("../../src/statestore.js");
const { createStore } = require("../../src/store.js");

const root = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(root, "src", "engine-server.js");
const BUNDLED = join(root, "duckdb-extensions");
const LONG = "SELECT sum(hash(x)) FROM range(100000000000000) t(x)";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setup(t, { key = "test", idleMs = 60_000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "onelake-shared-"));
  let secret;
  const options = { extensionDir: join(dir, "extensions"), bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null, threads: 2 };
  const gone = [];
  const open = () => {
    const window = createEngineHost({
      remote: createRemote({ key: `${key}-${dir}`, script: SCRIPT, options, stateDir: join(dir, "state"), idleMs,
        getToken: async () => secret, setToken: async s => { secret = s; }, onGone: () => gone.push(window) }),
    });
    t.after(() => window.close({ stop: true }).catch(() => {}));
    return window;
  };
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const log = () => {
    const state = join(dir, "state");
    return readFileSync(join(state, readdirSync(state).find(f => f.endsWith(".log"))), "utf8");
  };
  const probe = () => openClient({ uri: /serving (quack:\S+)/.exec(log())[1], token: secret, extensionDir: options.extensionDir, bundledExtensions: options.bundledExtensions });
  return { open, gone, log, probe, secret: () => secret, pipe: pipePath(`${key}-${dir}`) };
}

test("two windows join one server, and what one makes the other reads", async t => {
  const { open, log, secret } = await setup(t);
  const a = open(), b = open();
  assert.deepEqual((await a.call("query", ["SELECT 42 AS answer"])).rows, [{ answer: 42 }]);
  assert.deepEqual((await b.call("query", ["SELECT 43 AS answer;"])).rows, [{ answer: 43 }]);
  await a.call("query", ["CREATE OR REPLACE VIEW made_by_a AS SELECT 'a' AS who"]);
  assert.deepEqual((await b.call("query", ["SELECT * FROM made_by_a"])).rows, [{ who: "a" }]);
  assert.equal(log().match(/starting: pid/g).length, 1, "one server");
  assert.ok(!log().includes(secret()), "the session token is not in the log");
});

test("a statement streams, and an error reads as the statement rather than our wrapper", async t => {
  const a = (await setup(t)).open();
  const batches = [];
  const end = await a.call("stream", ["SELECT i::BIGINT AS id FROM range(25000) t(i)"], b => batches.push(b));
  assert.equal(end.numRows, 25000);
  assert.deepEqual(batches[0].fields, [{ name: "id", type: "BIGINT" }]);
  await assert.rejects(a.call("query", ["SELECT\n  nope\nFROM range(1)"]), e => {
    assert.match(e.message, /nope/);
    assert.doesNotMatch(e.message, /quack_query|onelake:/);
    return true;
  });
});

test("the guard refuses Quack's own functions, and the server's lockdown holds", async t => {
  const a = (await setup(t)).open();
  await assert.rejects(a.call("query", ["SELECT * FROM quack_stop('quack:127.0.0.1:1')"]), /Read only/);
  await assert.rejects(a.call("query", ["SELECT * FROM \"quack_serve\"('x')"]), /Read only/);
  await assert.rejects(a.call("query", [`SELECT * FROM read_text(${JSON.stringify(SCRIPT).replace(/"/g, "'")})`]), /Permission|disabled/);
});

test("a tab's Stop reaches its statement and no other's", async t => {
  const a = (await setup(t)).open();
  const one = a.forTab(), two = a.forTab();
  let result = null;
  const running = one.call("query", [LONG]).catch(e => { result = e; });
  await sleep(1000);
  assert.deepEqual((await two.call("query", ["SELECT 7 AS during"])).rows, [{ during: 7 }]);
  await two.call("cancel");
  await sleep(500);
  assert.equal(result, null, "the other tab's Stop left it running");
  await one.call("cancel");
  await running;
  assert.equal(result.cancelled, true);
});

test("a window that leaves takes its statements with it, and the server stays", async t => {
  const { open, probe } = await setup(t);
  const a = open(), b = open();
  await b.call("query", ["SELECT 1"]);
  await a.call("query", ["SELECT 1"]);
  const running = a.call("query", [LONG]).catch(() => {});
  await sleep(1000);
  const { admin, query, local } = await probe();
  t.after(() => { try { admin.closeSync(); local.closeSync(); } catch (_) {} });
  const count = async () => (await admin.runAndReadAll(query("SELECT count(*)::INT AS n FROM quack_active_connections() WHERE state = 'active' AND query LIKE '%range(' || '1000%'"))).getRowObjectsJson()[0].n;
  assert.equal(await count(), 1);
  await a.close();
  await running;
  await sleep(1000);
  assert.equal(await count(), 0);
  assert.deepEqual((await b.call("query", ["SELECT 8 AS still"])).rows, [{ still: 8 }]);
});

test("stats: the server's process, its memory, and how many statements someone asked for", async t => {
  const { open } = await setup(t);
  const a = open();
  await a.call("query", ["SELECT 1"]);
  const before = await a.stats();
  assert.notEqual(before.pid, process.pid, "the server's process, not this one");
  assert.ok(before.cpuUs > 0 && before.memoryBytes >= 0 && before.memoryLimit && Number(before.threads) === 2);
  for (let i = 0; i < 3; i++) await a.call("query", [`SELECT ${i} AS n`]);
  await a.call("query", ["CREATE OR REPLACE VIEW only_setup AS SELECT 1 AS one"]);
  const after = await a.stats();
  assert.equal(after.statements - before.statements, 3, "setup isn't counted");
  assert.equal((await a.stats()).statements, after.statements, "asking adds nothing");
});

test("the log: every window's statements, as DuckDB recorded them", async t => {
  const { open } = await setup(t);
  const a = open(), b = open();
  await a.call("query", ["SELECT 1 AS it's_a -- never parsed\nFROM range(1)"]).catch(() => {});
  await a.call("query", ["SELECT 'it''s a \"quote\", {x: ''y''}' AS txt,\n  2 AS second"]);
  await b.call("query", ["SELECT * FROM no_such_table"]).catch(() => {});
  const big = (await a.call("query", ["SELECT i FROM range(200000) t(i)"])).numRows;
  assert.equal(big, 200000);
  let stopped = null;
  const running = b.call("query", [LONG]).catch(e => { stopped = e; });
  await sleep(1000);
  await b.call("cancel");
  await running;
  assert.equal(stopped.cancelled, true);
  await sleep(300);

  const rows = await a.logs(100);
  const of = text => rows.find(r => r.sql.includes(text));
  const quoted = of("it''s a");
  assert.equal(quoted.sql, "SELECT 'it''s a \"quote\", {x: ''y''}' AS txt,\n  2 AS second", "the SQL as it was written");
  assert.equal(quoted.status, "ok");
  assert.equal(quoted.here, true);
  assert.ok(!/onelake:/.test(quoted.sql), "no tag");
  const failed = of("no_such_table");
  assert.equal(failed.status, "error");
  assert.equal(failed.here, false, "from the other window");
  assert.match(failed.error, /no_such_table/);
  assert.equal(of("range(100000000000000)").status, "stopped");
  assert.ok(of("range(200000)").ms >= 0);
  assert.ok(rows[0].at >= rows[rows.length - 1].at, "newest first");

  const now = (await a.logs(1000)).length;
  for (let i = 0; i < 5; i++) { await a.stats(); await a.logs(10); }
  assert.equal((await a.logs(1000)).length, now, "reading adds nothing to the log");

  // SQL over it, through the page's own guard.
  const seen = await a.call("query", ["SELECT count(*)::INT AS n FROM duckdb_logs WHERE type = 'Quack'"]);
  assert.ok(seen.rows[0].n > 0);

  await a.clearLogs();
  assert.equal((await a.logs(1000)).length <= 1, true, "cleared");
});

test("the OneLake token reaches no log, and history survives the server", async t => {
  const dir = await mkdtemp(join(tmpdir(), "onelake-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const TOKEN = "eyJfake.TOKEN-THAT-MUST-NOT-BE-LOGGED.signature";
  let secret;
  const open = () => {
    const w = createEngineHost({
      getToken: async () => TOKEN,
      remote: createRemote({ key: `log-${dir}`, script: SCRIPT, stateDir: join(dir, "state"),
        options: { extensionDir: join(dir, "extensions"), bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null, threads: 2 },
        getToken: async () => secret, setToken: async s => { secret = s; } }),
    });
    t.after(() => w.close({ stop: true }).catch(() => {}));
    return w;
  };
  const a = open();
  await a.call("query", ["SELECT 'before the restart' AS said"]);
  const types = await a.call("query", ["SELECT count(*)::INT AS n, count(*) FILTER (name = 'onelake_storage')::INT AS ours FROM duckdb_secrets()"]);
  assert.equal(types.rows[0].ours, 1, "the secret was issued");
  const leaked = await a.call("query", ["SELECT count(*)::INT AS n FROM duckdb_logs WHERE message LIKE '%TOKEN-THAT' || '-MUST%'"]);
  assert.equal(leaked.rows[0].n, 0);
  assert.ok(!(await a.logs(1000)).some(r => r.sql.includes("MUST-NOT-BE-LOGGED")));
  await a.close({ stop: true });
  await sleep(1000);

  const state = join(dir, "state");
  for (const f of readdirSync(state)) {
    assert.ok(!readFileSync(join(state, f)).includes(TOKEN), `${f} holds no token`);
  }
  const b = open();
  assert.ok((await b.logs(1000)).some(r => r.sql.includes("before the restart")), "still there");
});

test("the store's entries live in the server, shared by windows, imported once, and survive a stop", async t => {
  const dir = await mkdtemp(join(tmpdir(), "onelake-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const jsonDir = join(dir, "json");
  await mkdir(jsonDir);
  await writeFile(join(jsonDir, "a.json"), JSON.stringify({ key: "from a file", at: 123, value: { kept: true, q: "it's" } }));
  let secret;
  const cfg = { key: `state-${dir}`, script: SCRIPT, stateDir: join(dir, "state"),
    options: { extensionDir: join(dir, "extensions"), bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null, threads: 2 },
    getToken: async () => secret, setToken: async s => { secret = s; } };
  const clients = [];
  const storeOf = () => {
    const client = createStateClient(cfg);
    clients.push(client);
    return createStore({ dir: join(dir, "blobs"), backend: createStateBackend({ run: sql => client.run(sql), importFrom: jsonDir }) });
  };
  t.after(async () => { for (const c of clients) { await c.stop().catch(() => {}); c.close(); } });

  const one = storeOf(), two = storeOf();
  assert.deepEqual(await one.known("from a file"), { value: { kept: true, q: "it's" }, at: 123 });
  await one.put("listing", ["a", "b's"]);
  assert.deepEqual(await two.peek("listing"), ["a", "b's"]);

  // A kept answer outlives the server, and the next one starts by itself.
  await clients[0].stop();
  await clients[1].stop();
  await sleep(1000);
  const three = storeOf();
  assert.deepEqual(await three.peek("listing"), ["a", "b's"]);

  // What Clear takes doesn't come back from the old files.
  await three.clear();
  const four = storeOf();
  assert.equal(await four.peek("from a file"), undefined);
  assert.equal(await four.peek("listing"), undefined);
});

test("a lost session token: the next window waits for the old server to go idle, then starts", async t => {
  const dir = await mkdtemp(join(tmpdir(), "onelake-lost-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  let secret;
  const open = () => {
    const w = createEngineHost({
      remote: createRemote({ key: `lost-${dir}`, script: SCRIPT, stateDir: join(dir, "state"), idleMs: 4000,
        options: { extensionDir: join(dir, "extensions"), bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null, threads: 2 },
        getToken: async () => secret, setToken: async s => { secret = s; } }),
    });
    t.after(() => w.close({ stop: true }).catch(() => {}));
    return w;
  };
  const a = open();
  await a.call("query", ["SELECT 1"]);
  await a.close();
  secret = undefined;
  const b = open();
  assert.deepEqual((await b.call("query", ["SELECT 2 AS two"])).rows, [{ two: 2 }]);
});

test("stop ends the server for every window, and with no window left it goes by itself", async t => {
  const one = await setup(t);
  const a = one.open(), b = one.open();
  await a.call("query", ["SELECT 1"]);
  await b.call("query", ["SELECT 1"]);
  await a.close({ stop: true });
  await sleep(1000);
  assert.deepEqual(one.gone, [b]);
  assert.match(one.log(), /stopping: a window asked/);

  const two = await setup(t, { key: "idle", idleMs: 1000 });
  const c = two.open();
  await c.call("query", ["SELECT 1"]);
  await c.close();
  await sleep(2500);
  assert.match(two.log(), /stopping: no window left/);
});
