// The shared engine on the DuckDB that ships: a real server process and real Quack clients, with
// no editor and no OneLake. Windows here are engines in this process, each with its own control
// socket, which is all a window is to the server.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createEngineHost, KEEP_MARK } = require("../../src/engine-host.js");
const { createRemote, stopServer, openClient, pipePath, LOST } = require("../../src/engine-client.js");
const { createCatalogFile } = require("../../src/catalogfile.js");
const { createLogFile, logFileOf } = require("../../src/logfile.js");
const { openOldState } = require("../../src/oldstate.js");
const { DuckDBInstance } = require("@duckdb/node-api");

const root = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(root, "src", "engine-server.js");
const BUNDLED = join(root, "duckdb-extensions");
const LONG = "SELECT sum(hash(x)) FROM range(100000000000000) t(x)";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// As a window would ask, over the pipe: a statement can't stop a listener. The pipe also carries the
// server's news, so the answer is found by its id, and the news gets a moment to reach the windows.
async function restartListeners(pipe, token) {
  const sock = net.connect(pipe);
  await new Promise(r => sock.once("connect", r));
  sock.setEncoding("utf8");
  let lines = "";
  const answered = new Promise((resolve, reject) => {
    sock.on("error", reject);
    sock.on("data", chunk => {
      lines += chunk;
      if (lines.split("\n").some(l => { try { return JSON.parse(l).id === 1; } catch (_) { return false; } })) resolve();
    });
  });
  sock.write(`${JSON.stringify({ token, window: "test" })}\n`);
  sock.write(`${JSON.stringify({ id: 1, listen: { force: true } })}\n`);
  await answered;
  sock.destroy();
  await sleep(200);
}

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
  return { open, gone, log, probe, secret: () => secret, key: `${key}-${dir}`, pipe: pipePath(`${key}-${dir}`) };
}

test("two windows join one server, and what one makes the other reads", async t => {
  const { open, log, secret } = await setup(t);
  const a = open(), b = open();
  assert.deepEqual((await a.call("query", ["SELECT 42 AS answer"])).rows, [{ answer: 42 }]);
  assert.deepEqual((await b.call("query", ["SELECT 43 AS answer;"])).rows, [{ answer: 43 }]);
  await a.call("fileView", ["made_by_a", "SELECT 'a' AS who"]);
  assert.deepEqual((await b.call("query", ["SELECT * FROM made_by_a"])).rows, [{ who: "a" }]);
  assert.equal(log().match(/starting: pid/g).length, 1, "one server");
  assert.ok(!log().includes(secret()), "the session token is not in the log");
});

test("a tab's files are its own: no statement or other tab can take them, and they go when it closes", async t => {
  const window = (await setup(t)).open();
  const one = window.forTab(), two = window.forTab();
  await one.call("fileView", ["ones_view", "SELECT 1 AS a"]);
  const still = async () => (await two.call("query", ["SELECT * FROM ones_view"])).rows;
  assert.deepEqual(await still(), [{ a: 1 }]);

  for (const sql of ["DROP VIEW ones_view", "DROP SCHEMA lakehouse CASCADE", "DETACH lakehouse",
                     "CREATE OR REPLACE VIEW ones_view AS SELECT 2 AS a", "ATTACH ':memory:' AS x (READ_ONLY)"]) {
    await assert.rejects(two.call("query", [sql]), /Read only/, sql);
  }
  await two.call("releaseFiles", [{ views: ["ones_view"] }]);
  assert.deepEqual(await still(), [{ a: 1 }], "another tab's release takes nothing");

  await assert.rejects(one.call("fileView", ["v", "COPY (SELECT 1) TO 'x.csv'"]), /Read only/);
  await assert.rejects(one.call("attachFile", [{ path: "/etc/passwd", alias: "x" }]), /attached from OneLake/);
  await assert.rejects(one.call("attachFile", [{ path: "abfss://c@elsewhere.dfs.core.windows.net/x.duckdb", alias: "x" }]), /attached from OneLake/);

  await one.call("releaseFiles", [{ views: ["ones_view"] }]);
  await assert.rejects(still(), /ones_view/);

  await one.call("fileView", ["ones_view", "SELECT 3 AS a"]);
  assert.deepEqual(await still(), [{ a: 3 }]);
  await one.dispose();
  await assert.rejects(still(), /ones_view/, "a tab that closes takes what it made");
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

test("a statement after a Stop gets a connection of its own: the stopped one's reads may still be winding down", async t => {
  const s = await setup(t);
  const a = s.open();
  await a.forTab().call("query", ["SELECT 1 AS up"]);
  const { admin, route, local } = await s.probe();
  t.after(() => { try { admin.closeSync(); local.closeSync(); } catch (_) {} });
  const attached = async () => {
    for (let i = 0; i < 100; i++) {
      const way = route("SELECT 1");
      const name = /FROM (r\d+)\.query/.exec(way.text)?.[1];
      if (name) return { way, name };
      await sleep(100);
    }
    throw new Error("no attach came");
  };
  const first = await attached();
  first.way.release();
  const again = await attached();
  assert.equal(again.name, first.name, "one that finished is used again");
  again.way.retire();
  const next = await attached();
  assert.notEqual(next.name, first.name, "one that was stopped is not");
  assert.deepEqual((await admin.runAndReadAll(route("SELECT 7 AS seven").text)).getRowObjectsJson(), [{ seven: 7 }]);
  next.way.release();
});

test("a tab's Stop retires its connection, and the tab's next statement answers", async t => {
  const a = (await setup(t)).open();
  const tab = a.forTab();
  await tab.call("query", ["SELECT 1 AS up"]);
  let result = null;
  const running = tab.call("query", [LONG]).catch(e => { result = e; });
  await sleep(1000);
  await tab.call("cancel");
  await running;
  assert.equal(result.cancelled, true);
  const t0 = Date.now();
  assert.deepEqual((await tab.call("query", ["SELECT 8 AS next"])).rows, [{ next: 8 }]);
  assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0}ms`);
});

test("a window that leaves takes its statements with it, and the server stays", async t => {
  const { open, probe } = await setup(t);
  const a = open(), b = open();
  await b.call("query", ["SELECT 1"]);
  await a.call("query", ["SELECT 1"]);
  const running = a.call("query", [LONG]).catch(() => {});
  await sleep(1000);
  const { admin, route, local } = await probe();
  t.after(() => { try { admin.closeSync(); local.closeSync(); } catch (_) {} });
  const count = async () => {
    const way = route("SELECT count(*)::INT AS n FROM quack_active_connections() WHERE state = 'active' AND query LIKE '%range(' || '1000%'");
    try { return (await admin.runAndReadAll(way.text)).getRowObjectsJson()[0].n; }
    finally { way.release(); }
  };
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
  await a.call("fileView", ["only_setup", "SELECT 1 AS one"]);
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
  assert.ok(!/onelake:/.test(quoted.sql), "no tag");
  const failed = of("no_such_table");
  assert.equal(failed.status, "error");
  assert.match(failed.error, /no_such_table/);
  assert.equal(of("range(100000000000000)").status, "stopped");
  assert.ok(of("range(200000)").ms >= 0, "to its first rows");
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

test("what an older version kept in its DuckDB state file comes across, its log too", async t => {
  const dir = await mkdtemp(join(tmpdir(), "onelake-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const file = join(dir, "state.duckdb");
  const db = await DuckDBInstance.create(file);
  const c = await db.connect();
  await c.run("CREATE TABLE kv (k VARCHAR PRIMARY KEY, ts BIGINT, value VARCHAR)");
  await c.run(`INSERT INTO kv VALUES ('workspaces', 123, '["a","b''s"]'), ('(imported)', 0, ''), ('rows␟abfss://x', 5, 'true')`);
  await c.run("CREATE TABLE logs (ts BIGINT, win VARCHAR, sql VARCHAR, ms BIGINT, status VARCHAR, error VARCHAR, conn VARCHAR)");
  await c.run("INSERT INTO logs VALUES (1000, 'w', 'SELECT 1', 7, 'ok', NULL, 'c')");
  c.closeSync();
  db.closeSync();

  const backend = createCatalogFile({ file: join(dir, "catalog.sqlite") });
  t.after(() => backend.close());
  const old = await openOldState(file);
  assert.equal(await backend.importKept({ run: old.run }), 2);
  const logs = createLogFile({ file: join(dir, "logs.sqlite") });
  t.after(() => logs.close());
  logs.add(await old.logs());
  old.close();
  assert.deepEqual(await backend.read("workspaces"), { at: 123, value: ["a", "b's"] });
  assert.deepEqual(await backend.read("rows\0abfss://x"), { at: 5, value: true });
  assert.deepEqual(logs.read(10).map(r => [r.ts, r.sql, r.ms, r.status]), [[1000, "SELECT 1", 7, "ok"]]);

  const none = await openOldState(join(dir, "other.duckdb"));
  assert.deepEqual(await none.logs(), [], "a file with no log has nothing to bring");
  none.close();
});

test("stopServer stops a server this window isn't joined to, and starts none", async t => {
  const { open, secret, key, pipe } = await setup(t);
  const listening = path => new Promise(resolve => {
    const up = net.connect(path);
    up.once("connect", () => { up.destroy(); resolve(true); });
    up.once("error", () => resolve(false));
  });
  const nobody = `nobody-${key}`;
  await stopServer({ key: nobody, getToken: async () => undefined });
  assert.equal(await listening(pipePath(nobody)), false, "nothing was started");

  await open().call("query", ["SELECT 1"]);
  await stopServer({ key, getToken: async () => secret() });
  await sleep(1000);
  assert.equal(await listening(pipe), false, "it went");
});

test("a server's words for a lost connection are the ones a window looks for", async t => {
  const { open, secret, log } = await setup(t);
  await open().call("query", ["SELECT 1"]);
  const uri = /serving (quack:\S+)/.exec(log())[1];
  const client = await openClient({ uri, token: secret(), lockdown: false,
    extensionDir: null, bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null });
  t.after(() => { try { client.local.closeSync(); } catch (_) {} });
  const c = await client.local.connect();
  // A port nobody answers on, with a token for it: without one DuckDB doesn't try.
  await c.run("CREATE SECRET nobody (TYPE quack, TOKEN 'x', SCOPE 'quack:127.0.0.1:9')");
  await assert.rejects(c.run("SELECT * FROM quack_query('quack:127.0.0.1:9', 'SELECT 1')"),
    e => { assert.match(e.message, LOST); return true; });
  c.closeSync();
});

test("the log survives an update too, and the server's own log keeps one name and only its end", async t => {
  const dir = await mkdtemp(join(tmpdir(), "onelake-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const stateDir = join(dir, "state");
  await mkdir(stateDir);
  await writeFile(join(stateDir, "0123456789abcdef.log"), "from the version before");
  const serverLog = logFileOf(stateDir, "me").replace(/\.sqlite$/, ".log");
  await writeFile(serverLog, `${"line\n".repeat(500_000)}the end\n`);
  const secrets = new Map();
  const open = key => {
    const w = createEngineHost({
      remote: createRemote({ key, stateKey: "me", script: SCRIPT, stateDir,
        options: { extensionDir: join(dir, "extensions"), bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null, threads: 2 },
        getToken: async () => secrets.get(key), setToken: async s => { secrets.set(key, s); } }),
    });
    t.after(() => w.close({ stop: true }).catch(() => {}));
    return w;
  };

  const before = open(`me|${dir}/onelake-studio-0.2.9`);
  await before.call("query", ["SELECT 'before the update' AS said"]);
  await before.close({ stop: true });
  await sleep(1000);
  const after = open(`me|${dir}/onelake-studio-0.3.0`);
  await after.call("query", ["SELECT 'after the update' AS said"]);
  await sleep(300);
  const rows = await after.logs(100);
  assert.ok(rows.some(r => r.sql.includes("before the update")), "still there");
  assert.ok(rows.some(r => r.sql.includes("after the update")));

  assert.deepEqual(readdirSync(stateDir).filter(f => f.endsWith(".log")), [serverLog.split(/[\\/]/).pop()]);
  const text = readFileSync(serverLog, "utf8");
  assert.ok(text.length < 1.1 * 1024 * 1024, "only its end is kept");
  assert.ok(text.startsWith("line\n"), "from a whole line");
  assert.ok(text.includes("the end"));
  assert.equal(text.match(/starting: pid/g).length, 2, "both versions in the one file");
});

test("a server that can't start writes down why, where someone can read it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "onelake-crash-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const logFile = join(dir, "server.log");
  const child = spawn(process.execPath, [SCRIPT], { stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.stdin.end(`${JSON.stringify({ token: "t", pipe: join(dir, "no", "such", "folder", "pipe"), options: {}, logFile })}\n`);
  assert.equal(await exited, 1);
  assert.match(readFileSync(logFile, "utf8"), /ended: .*(ENOENT|EACCES|no such)/i);
});

test("concurrency: many tabs of two windows on one server, every answer right, and all of it in that server's log", async t => {
  const { open, log } = await setup(t);
  const a = open(), b = open();
  await Promise.all([a.call("query", ["SELECT 1"]), b.call("query", ["SELECT 1"])]);
  const before = await a.stats();
  const TABS = { a: 10, b: 4 };     // more than a window's pool of attaches, so its overflow runs too
  const ROUNDS = 25;
  const wrong = [], failures = [];
  const ran = new Set();
  const worker = async (window, name, tab) => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = `${name}-${i}`;
      ran.add(id);
      try {
        if (i % 5 === 4) {
          // A result in batches, and whole: another tab's rows can't be in it.
          const rows = [];
          const end = await tab.call("stream", [`SELECT '${id}' AS id, i FROM range(15000) t(i)`], b => rows.push(...b.rows));
          if (end.numRows !== 15000 || rows.length !== 15000 || rows.some(r => r.id !== id)) wrong.push(id);
        } else {
          const { rows } = await tab.call("query", [`SELECT '${id}' AS id, sum(x)::BIGINT AS total FROM range(100000) t(x)`]);
          if (rows.length !== 1 || rows[0].id !== id || Number(rows[0].total) !== 4999950000) wrong.push(`${id}: ${JSON.stringify(rows)}`);
        }
      } catch (e) { failures.push(`${id}: ${e.message}`); }
    }
  };
  // In the middle of it: a bad statement fails alone, and a Stop stops one tab's query and no other's.
  const bad = a.forTab(), stopper = b.forTab();
  const badOne = bad.call("query", ["SELECT * FROM no_such_concurrent_table"]).catch(e => e);
  const long = stopper.call("query", [LONG]).catch(e => e);
  await Promise.all([
    ...Array.from({ length: TABS.a }, (_, i) => worker(a, `a${i}`, a.forTab())),
    ...Array.from({ length: TABS.b }, (_, i) => worker(b, `b${i}`, b.forTab())),
    (async () => { await sleep(500); await stopper.call("cancel"); })(),
  ]);
  assert.deepEqual(failures, [], "no statement failed");
  assert.deepEqual(wrong, [], "every answer was its own");
  assert.match((await badOne).message, /no_such_concurrent_table/);
  assert.equal((await long).cancelled, true);
  assert.equal(log().match(/starting: pid/g).length, 1, "one server for all of it");

  const logged = await a.logs(5000);
  const inLog = new Map();
  for (const r of logged) {
    const id = /SELECT '([ab]\d+-\d+)' AS id/.exec(r.sql);
    if (id) inLog.set(id[1], r);
  }
  const missing = [...ran].filter(id => !inLog.has(id));
  assert.deepEqual(missing, [], "each statement is in the server's log");
  assert.ok([...inLog.values()].every(r => r.status === "ok" && r.ms >= 0));
  assert.equal(logged.find(r => r.sql.includes("no_such_concurrent_table")).status, "error");
  assert.equal(logged.find(r => r.sql.includes("range(100000000000000)")).status, "stopped");

  const after = await a.stats();
  assert.ok(after.statements - before.statements >= ran.size, "queries are counted");
  assert.equal(after.pid, before.pid);
});

test("a listener that stops: the next statement starts it again, and goes on", async t => {
  const { open, secret, pipe } = await setup(t);
  const a = open();
  await a.call("query", ["SELECT 1"]);
  await restartListeners(pipe, secret());

  assert.deepEqual((await a.call("query", ["SELECT 2 AS back"])).rows, [{ back: 2 }], "the old attach recovered");
  const running = a.call("query", [LONG]).catch(e => e);
  await sleep(800);
  await a.call("cancel");
  const stopped = await Promise.race([running, sleep(20_000).then(() => new Error("Stop reached nothing"))]);
  assert.equal(stopped.cancelled, true, "and Stop works after it");
});

test("Stop still reaches the server when its listener came back before anything noticed", async t => {
  const { open, secret, pipe } = await setup(t);
  // A hang here is what this is about, so it fails rather than waits.
  const within = (ms, what, p) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: nothing after ${ms}ms`); })]);
  // With a new window, a pool's first attach can land on either side of the restart, so several tries.
  for (let i = 0; i < 4; i++) {
    const w = open();
    await w.call("query", ["SELECT 1"]);
    await restartListeners(pipe, secret());
    const running = w.call("query", [LONG]).catch(e => e);
    await sleep(800);
    await w.call("cancel");
    assert.equal((await within(20_000, `Stop, try ${i}`, running)).cancelled, true);
    assert.deepEqual((await within(20_000, `after Stop, try ${i}`, w.call("query", ["SELECT 3 AS after"]))).rows, [{ after: 3 }]);
    await within(20_000, `closing, try ${i}`, w.close());
  }
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

test("the server says whether anyone is at work, from any window, a table being kept aside", async t => {
  const { open } = await setup(t);
  const a = open(), b = open();
  await a.call("query", ["SELECT 1"]);
  await b.call("query", ["SELECT 1"]);
  assert.equal(await a.othersRunning(), false);

  const stop = new AbortController();
  const kept = a.agentQuery(LONG, { signal: stop.signal, used: false, mark: KEEP_MARK }).catch(e => e);
  await sleep(1000);
  assert.equal(await a.othersRunning(), false, "a table being kept isn't someone at work");
  assert.equal(await b.othersRunning(), false);

  const tab = b.forTab();
  const running = tab.call("query", [LONG]).catch(() => {});
  await sleep(1000);
  assert.equal(await a.othersRunning(), true, "another window's statement");
  await tab.call("cancel");
  await running;
  stop.abort();
  assert.match(String((await kept).message), /interrupt/i, "the signal stops it");
});
