// onscreen.js: what the panel shows, written to one file per window for Claude Code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createOnScreen } = require("../src/onscreen.js");

const read = async s => JSON.parse(await readFile(s.file, "utf8"));

test("an open replaces what described the previous one; model parts merge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "onscreen-"));
  try {
    const s = createOnScreen({ dir, window: { workspace: "w" }, pid: 4242 });
    await s.update({ open: { kind: "table", workspace: "ws", item: "data.Lakehouse", schema: "mart", table: "x" } });
    let f = await read(s);
    assert.equal(f.window.pid, 4242);
    assert.equal(f.open.table, "x");
    assert.match(f.open.cli.sql, /data_mart\.x/);
    assert.equal(f.open.cli.table, "table ws data.Lakehouse mart.x");

    const rows = Array.from({ length: 80 }, (_, i) => ({ id: i, s: "y".repeat(900) }));
    await s.update({ query: { sql: "SELECT 1", rows: 80, fields: ["id", "s"], sample: rows } });
    f = await read(s);
    assert.equal(f.query.sample.length, 50, "the first rows only");
    assert.equal(f.query.sample[0].s.length, 500, "long values cut short");

    await s.update({ open: { kind: "model", name: "sales", file: "sales.bim", workspace: "ws", model: "Sales" } });
    await s.update({ model: { page: "sql" } });
    await s.update({ model: { explore: { dax: "EVALUATE x", rows: 3 } } });
    f = await read(s);
    assert.equal(f.query, null, "the previous table's query went with it");
    assert.equal(f.model.page, "sql");
    assert.equal(f.model.explore.dax, "EVALUATE x");
    assert.equal(f.open.cli.model, "model ws Sales");

    await s.close();
    await assert.rejects(readFile(s.file), "closed: the file is gone");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a window that died leaves no file behind once another starts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "onscreen-"));
  try {
    // A pid no live process has: far past any real one.
    await writeFile(join(dir, "panel-2147483000.json"), "{}");
    await writeFile(join(dir, `panel-${process.pid}.json`), "{}");
    await writeFile(join(dir, "other.json"), "{}");
    await createOnScreen({ dir, pid: 1 }).sweep();
    assert.deepEqual((await readdir(dir)).sort(), ["other.json", `panel-${process.pid}.json`]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
