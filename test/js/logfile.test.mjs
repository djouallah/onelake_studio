// logfile.js: what the engine ran, in a SQLite file of its own, with no DuckDB near it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLogFile, logFileOf } = require("../../src/logfile.js");
const { catalogFileOf } = require("../../src/catalogfile.js");

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "onelake-log-"));
  const opened = [];
  const open = (more = {}) => {
    const f = createLogFile({ file: join(dir, "logs.sqlite"), ...more });
    opened.push(f);
    return f;
  };
  t.after(async () => {
    for (const f of opened) f.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return { dir, open, file: join(dir, "logs.sqlite") };
}
const row = (at, sql = "SELECT 1") => ({ at, window: "w", sql, ms: 7, status: "ok", error: null, conn: "c" });

test("what the engine ran is kept, newest first, and outlives the process", async t => {
  const { open } = await setup(t);
  const one = open();
  one.add([row(1, "first"), row(2, "second")]);
  one.add([]);
  one.close();
  const rows = open().read(10);
  assert.deepEqual(rows.map(r => [r.ts, r.win, r.sql, r.ms, r.status, r.error]),
    [[2, "w", "second", 7, "ok", null], [1, "w", "first", 7, "ok", null]]);
  assert.equal(open().read(1).length, 1);
});

test("clear empties it", async t => {
  const { open } = await setup(t);
  const f = open();
  f.add([row(1)]);
  f.clear();
  assert.deepEqual(f.read(10), []);
});

test("past its limit the oldest go, down to half", async t => {
  const { open } = await setup(t);
  const f = open();
  f.add(Array.from({ length: 100 }, (_, i) => row(i, "x".repeat(100))));
  f.trim(100_000);
  assert.equal(f.read(1000).length, 100, "under the limit, nothing goes");
  f.trim(5000);
  const kept = f.read(1000);
  assert.equal(kept.length, 25);
  assert.equal(kept[0].ts, 99);
  assert.equal(kept[24].ts, 75);
});

test("a file that isn't a database is set aside, and started again", async t => {
  const { open, file } = await setup(t);
  await writeFile(file, "not a database, and not going to be one");
  const said = [];
  const f = open({ log: l => said.push(l) });
  f.add([row(1)]);
  assert.equal(f.read(1).length, 1);
  assert.equal(readFileSync(`${file}.bad`, "utf8"), "not a database, and not going to be one");
  assert.match(said.join(), /set aside/);
  assert.ok(existsSync(file));
});

test("its file is the account's, and is not the catalog", () => {
  assert.equal(logFileOf("d", "me"), logFileOf("d", "me"));
  assert.notEqual(logFileOf("d", "me"), logFileOf("d", "you"));
  assert.notEqual(logFileOf("d", "me"), catalogFileOf("d", "me"));
  assert.match(logFileOf("d", "me"), /logs-[0-9a-f]{16}\.sqlite$/);
});

test("a database that died is said once it shows, and nothing else is taken for it", async () => {
  const { createLogKeeper } = require("../../src/enginelog.js");
  const said = [], fatal = [];
  let error = new Error("IO Error: a hiccup");
  const keeper = createLogKeeper({ engine: { readLog: async () => { throw error; } }, logs: {}, maxBytes: 1, log: l => said.push(l), onFatal: m => fatal.push(m) });
  await keeper.flush().catch(() => {});
  assert.equal(fatal.length, 0, "a failure costs only that turn");
  error = new Error('FATAL Error: Failed: database has been invalidated because of a previous fatal error.');
  await keeper.flush().catch(() => {});
  assert.equal(fatal.length, 1);
  assert.ok(said.some(l => /the log could not be kept: FATAL/.test(l)));
});
