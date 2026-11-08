// The lake on local Delta tables (test/fixtures/lake/make_tables.py, written by the workflow into LAKE_FIXTURES):
// every case registered from its log alone and read through DuckLake gives delta_scan's rows; a table followed
// commit by commit stays equal; and the table service brings files here, swaps them, and lets the right ones go.
// Without LAKE_FIXTURES (npm test, which has no DuckDB) it is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, copyFileSync, existsSync, statSync, mkdirSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";

const FIXTURES = process.env.LAKE_FIXTURES;
const skip = !FIXTURES && "LAKE_FIXTURES is not set: the lake is tested by its own workflow";
const require = createRequire(import.meta.url);
const H = skip ? null : await import("./lake-helpers.mjs");
const { readDelta, syncTable, META } = require("../../src/onelaketable.js");
const { createTableService } = require("../../src/tableservice.js");
const MAKE = new URL("../fixtures/lake/make_tables.py", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const fwd = p => p.replace(/\\/g, "/");

const cases = skip ? {} : JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8"));

test("every case delta-rs could write was written", { skip }, () => {
  const refused = Object.entries(cases).filter(([, v]) => !v.made);
  // Column mapping is the one delta-rs may refuse; anything else refused is a broken generator.
  assert.deepEqual(refused.map(([k]) => k).filter(k => k !== "column_mapping"), [], JSON.stringify(refused));
  if (refused.length) console.log(`not written: ${refused.map(([k, v]) => `${k} (${v.why})`).join("; ")}`);
});

for (const [name, info] of Object.entries(cases)) {
  test(`${name}: through DuckLake, the same rows as delta_scan`, { skip: skip || (!info.made && `not written: ${info.why}`) }, async () => {
    const lake = await H.openLake();
    try {
      const root = fwd(join(FIXTURES, name));
      const state = await readDelta(lake.c, root);
      const r = await syncTable(lake.c, name, state, { dvDir: lake.dvDir });
      assert.equal(r.added, state.files.length);
      const names = state.fields.map(f => f.name);
      const same = await H.sameRows(lake.c, `lake.${H.qi(name)}`, `delta_scan(${H.q(root)})`, names);
      assert.deepEqual(same, { rows: same.rows, onlyInFirst: 0, onlyInSecond: 0 }, `${name}: ${JSON.stringify(same)}`);
      // A second sync with nothing new changes nothing.
      assert.equal((await syncTable(lake.c, name, await readDelta(lake.c, root), { dvDir: lake.dvDir })).added, 0);
    } finally { lake.close(); }
  });
}

test("a table followed commit by commit stays equal to delta_scan, time travel included", { skip }, async () => {
  const lake = await H.openLake();
  try {
    const root = fwd(join(FIXTURES, "churn"));
    let steps = [];
    const snapshots = [];
    for (let step = 0; step < 7; step++) {
      const out = JSON.parse(execFileSync("python", [MAKE, FIXTURES, "churn", String(step)], { encoding: "utf8" }));
      steps = out.steps;
      const state = await readDelta(lake.c, root);
      await syncTable(lake.c, "churn", state, { dvDir: lake.dvDir });
      const same = await H.sameRows(lake.c, "lake.churn", `delta_scan(${H.q(root)})`, state.fields.map(f => f.name));
      assert.deepEqual([same.onlyInFirst, same.onlyInSecond], [0, 0], `after ${steps[step]}: ${JSON.stringify(same)}`);
      const [s] = await H.rowsOf(lake.c, "SELECT max(snapshot_id)::BIGINT AS id FROM lake.snapshots()");
      snapshots.push({ version: out.version, snapshot: Number(s.id), rows: same.rows });
    }
    for (const s of snapshots) {
      const [r] = await H.rowsOf(lake.c, `SELECT count(*)::BIGINT AS n FROM lake.churn AT (VERSION => ${s.snapshot})`);
      assert.equal(Number(r.n), s.rows, `time travel to Delta version ${s.version}`);
    }
  } finally { lake.close(); }
});

// The service on a table the lake names by an abfss:// folder, whose files "download" from the local fixture.
async function servedTable(lake, name, { maxBytes = 1e12 } = {}) {
  const local = fwd(join(FIXTURES, name));
  const remote = `abfss://ws@onelake.dfs.fabric.microsoft.com/item.Lakehouse/Tables/${name}`;
  const read = async () => ({ ...(await readDelta(lake.c, local)), root: remote });
  const filesDir = fwd(join(lake.dir, "files"));
  let queue = Promise.resolve();
  const withConn = fn => (queue = queue.then(() => fn(lake.c), () => fn(lake.c)));
  const service = createTableService({
    withConn, filesDir, maxBytes, graceMs: 0,
    download: async (url, dst) => {
      const src = join(local, decodeURIComponent(url.slice(remote.length + 1)));
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      return statSync(dst).size;
    },
  });
  const sync = async () => syncTable(lake.c, name, await read(), { dvDir: lake.dvDir, held: await service.held() });
  const urls = async () => (await H.rowsOf(lake.c, `SELECT t.path || f.path AS url FROM ${META}.ducklake_data_file f
    JOIN ${META}.ducklake_table t USING (table_id) WHERE t.table_name = ${H.q(name)} AND f.end_snapshot IS NULL AND f.path_is_relative`)).map(r => r.url);
  return { local, remote, service, sync, urls };
}

test("the service brings a read file here, and only that file", { skip }, async () => {
  const lake = await H.openLake();
  try {
    const t = await servedTable(lake, "part_multi");
    await t.sync();
    const all = await t.urls();
    await t.service.noteOpened([all[0]]);
    await t.service.idle();
    const s = await t.service.stats();
    assert.equal(s.swapped, 1);
    assert.equal((await t.urls()).length, all.length - 1, "one file is read from here now, the rest from OneLake");
    // Every file here: the table reads entirely from local copies, partition folders and all.
    await t.service.noteOpened(all);
    await t.service.idle();
    assert.equal((await t.urls()).length, 0);
    const names = (await readDelta(lake.c, t.local)).fields.map(f => f.name);
    const same = await H.sameRows(lake.c, "lake.part_multi", `delta_scan(${H.q(t.local)})`, names);
    assert.deepEqual([same.onlyInFirst, same.onlyInSecond], [0, 0], JSON.stringify(same));
  } finally { lake.close(); }
});

test("a copy a commit no longer names is deleted; one still named stays", { skip }, async () => {
  const lake = await H.openLake();
  try {
    // A table of its own to change: churn's first two steps, copied.
    const name = "served_churn";
    const local = fwd(join(FIXTURES, name));
    cpSync(fwd(join(FIXTURES, "plain")), local, { recursive: true });
    const t = await servedTable(lake, name);
    await t.sync();
    await t.service.noteOpened(await t.urls());
    await t.service.idle();
    const held = await t.service.held();
    assert.equal(held.size, 5);
    // OPTIMIZE: every file replaced by one.
    execFileSync("python", ["-c", `from deltalake import DeltaTable; DeltaTable(r'''${local}''').optimize.compact()`]);
    await t.sync();
    await t.service.tidy();   // marks the five copies
    await t.service.tidy();   // and, past a grace of 0, deletes them
    const s = await t.service.stats();
    assert.equal(s.deleted, 5, JSON.stringify(s));
    for (const copy of held.values()) assert.ok(!existsSync(copy), `${copy} should be gone`);
    // The new file is read from OneLake until a statement opens it; then it comes and stays.
    await t.service.noteOpened(await t.urls());
    await t.service.idle();
    await t.service.tidy();
    assert.equal((await t.service.stats()).held, 1);
  } finally { lake.close(); }
});

test("past its budget, the least recently read copy goes back to OneLake", { skip }, async () => {
  const lake = await H.openLake();
  try {
    const t0 = await servedTable(lake, "plain");
    await t0.sync();
    const all = await t0.urls();
    const sizes = (await H.rowsOf(lake.c, `SELECT file_size_bytes AS b FROM ${META}.ducklake_data_file WHERE end_snapshot IS NULL`)).map(r => Number(r.b));
    // Room for two files.
    const t = await servedTable(lake, "plain", { maxBytes: Math.max(...sizes) * 2 + 1 });
    for (const u of all) { await t.service.noteOpened([u]); await t.service.idle(); }
    const s = await t.service.stats();
    assert.equal(s.held, 2, JSON.stringify(s));
    assert.equal(s.evicted, all.length - 2);
    // The two held are the last two read.
    const remote = new Set(await t.urls());
    assert.ok(!remote.has(all.at(-1)) && !remote.has(all.at(-2)), "the most recently read stay here");
  } finally { lake.close(); }
});
