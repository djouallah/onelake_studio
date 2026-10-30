// history.js: the query editor's runs, per account, newest first, trimmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createHistory } = createRequire(import.meta.url)("../../src/history.js");

test("runs are kept per account, newest first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-"));
  try {
    const h = createHistory({ dir });
    await h.add({ sql: "nobody" });                 // signed out: nowhere to keep it
    h.useAccount("a");
    await Promise.all([h.add({ sql: "SELECT 1" }), h.add({ sql: "SELECT 2" })]);
    h.useAccount("b");
    await h.add({ sql: "SELECT 3" });
    assert.deepEqual((await h.list()).map(e => e.sql), ["SELECT 3"]);
    h.useAccount("a");
    assert.deepEqual((await h.list()).map(e => e.sql), ["SELECT 2", "SELECT 1"]);
    await h.clear();
    assert.deepEqual(await h.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("past a fifth over the cap, only the newest are kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-"));
  try {
    const h = createHistory({ dir, max: 5 });
    h.useAccount("a");
    for (let i = 1; i <= 7; i++) await h.add({ sql: `SELECT ${i}` });
    assert.deepEqual((await h.list()).map(e => e.sql), ["SELECT 7", "SELECT 6", "SELECT 5", "SELECT 4", "SELECT 3"]);
    // A line cut short by a crash is skipped, not fatal.
    const f = join(dir, "a.jsonl");
    await (await import("node:fs/promises")).appendFile(f, '{"sql": "SELE');
    assert.equal((await h.list()).length, 5);
    assert.ok((await readFile(f, "utf8")).includes("SELECT 7"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
