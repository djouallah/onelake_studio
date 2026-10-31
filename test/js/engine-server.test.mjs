// The shared engine on the DuckDB that ships: a real server process and real Quack clients, with
// no editor and no OneLake. Windows here are engines in this process, each with its own control
// socket, which is all a window is to the server.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createEngineHost } = require("../../src/engine-host.js");
const { createRemote, openClient, pipePath } = require("../../src/engine-client.js");

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
