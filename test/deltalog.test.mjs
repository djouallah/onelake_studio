// deltalog.js: a Delta table's state and history out of its _delta_log, with the listing
// and the reads faked. The logs below are shaped like the ones real writers leave — Fabric
// Spark (commitInfo + crc), a Warehouse (no commitInfo, checkpoints), delta-rs. What is
// under test is the answer AND how few files it took to get it: each is a request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { readDeltaState, listCommits, readHistoryPage, tableDirOf, HISTORY_PAGE } =
  createRequire(import.meta.url)("../src/deltalog.js");

const pad = v => String(v).padStart(20, "0");
const DIR = "lh.Lakehouse/Tables/dbo/t";
const LOG = `${DIR}/_delta_log`;
const lines = (...actions) => actions.map(a => JSON.stringify(a)).join("\n") + "\n";
const PROTOCOL = { minReaderVersion: 3, minWriterVersion: 7,
  readerFeatures: ["deletionVectors"], writerFeatures: ["deletionVectors", "invariants"] };
const META = { id: "m1", partitionColumns: ["day"], createdTime: 100,
  configuration: { "delta.parquet.vorder.enabled": "true" } };
const add = (size, rows) => ({ add: { path: `p${size}.parquet`, size, stats: JSON.stringify({ numRecords: rows }) } });
const leaf = p => p.split("/").pop();

function fakeLog(files) {
  const reads = [];
  const notFound = () => Object.assign(new Error("HTTP 404"), { status: 404 });
  return {
    reads,
    io: {
      list: async dir => {
        assert.equal(dir, LOG);
        reads.push("list");
        return Object.keys(files).map(f => ({ name: `${LOG}/${f}`, isDir: false, lastModified: 5 }));
      },
      readText: async path => {
        reads.push(leaf(path));
        if (!(leaf(path) in files)) throw notFound();
        return files[leaf(path)];
      },
      readCheckpoint: async paths => {
        reads.push("checkpoint:" + paths.map(leaf).join(","));
        return { metaData: META, protocol: PROTOCOL };
      },
    },
  };
}

test("a Spark-written table's state is one request: the crc of the converted version", async () => {
  const { io, reads } = fakeLog({
    [`${pad(7)}.crc`]: JSON.stringify({ tableSizeBytes: 300, numFiles: 2, numDeletedRecordsOpt: 4,
      metadata: META, protocol: PROTOCOL }),
  });
  const d = await readDeltaState(io, DIR, 7);
  assert.deepEqual(reads, [`${pad(7)}.crc`]);
  assert.equal(d.source, "crc");
  assert.equal(d.asOf, 7);
  assert.equal(d.sizeBytes, 300);
  assert.equal(d.numFiles, 2);
  assert.equal(d.deletedRows, 4);
  assert.deepEqual(d.partitionColumns, ["day"]);
  assert.equal(d.properties["delta.parquet.vorder.enabled"], "true");
  assert.equal(d.minReaderVersion, 3);
  assert.deepEqual(d.features, ["deletionVectors", "invariants"]);
});

test("without a crc the last checkpoint is read, and never the commits", async () => {
  const { io, reads } = fakeLog({
    "_last_checkpoint": JSON.stringify({ version: 149, size: 10, sizeInBytes: 900, numOfAddFiles: 3 }),
    [`${pad(150)}.json`]: lines(add(1, 1)),
  });
  const d = await readDeltaState(io, DIR, 150);
  assert.deepEqual(reads, [`${pad(150)}.crc`, "_last_checkpoint", `checkpoint:${pad(149)}.checkpoint.parquet`]);
  assert.equal(d.source, "checkpoint");
  assert.equal(d.asOf, 149);
  assert.equal(d.sizeBytes, null, "sizeInBytes is the checkpoint file's size, not the table's");
  assert.equal(d.numFiles, null, "a checkpoint's file count is of an older version");
  assert.equal(d.id, "m1");
});

test("a multi-part checkpoint is read as all of its parts", async () => {
  const { io, reads } = fakeLog({ "_last_checkpoint": JSON.stringify({ version: 9, parts: 2 }) });
  await readDeltaState(io, DIR, 9);
  assert.equal(reads.at(-1),
    `checkpoint:${pad(9)}.checkpoint.0000000001.0000000002.parquet,${pad(9)}.checkpoint.0000000002.0000000002.parquet`);
});

test("a log with neither crc nor checkpoint gives an empty state, not an error", async () => {
  const { io } = fakeLog({});
  const d = await readDeltaState(io, DIR, 0);
  assert.equal(d.source, null);
  assert.deepEqual(d.features, []);
});

test("a failure other than 'not there' is the caller's to see", async () => {
  const io = { readText: async () => { throw Object.assign(new Error("HTTP 403"), { status: 403 }); },
               readCheckpoint: async () => ({}) };
  await assert.rejects(() => readDeltaState(io, DIR, 1), /403/);
});

test("history: one listing, then only the page asked for", async () => {
  const files = {};
  for (let v = 0; v < 25; v++) files[`${pad(v)}.json`] = lines({ commitInfo: { timestamp: v, operation: "WRITE" } });
  files["_last_checkpoint"] = "{}";
  files[`${pad(20)}.checkpoint.parquet`] = "";
  const { io, reads } = fakeLog(files);
  const commits = await listCommits(io.list, DIR);
  assert.equal(commits.length, 25);
  assert.equal(commits[0].version, 24);
  const page = await readHistoryPage(io.readText, DIR, commits);
  assert.equal(page.length, HISTORY_PAGE);
  assert.deepEqual(page.map(h => h.version).slice(0, 2), ["24", "23"]);
  assert.equal(reads.length, 1 + HISTORY_PAGE, "the listing and one page of commits, nothing more");
  const next = await readHistoryPage(io.readText, DIR, commits, HISTORY_PAGE);
  assert.equal(next[0].version, "14");
});

test("a commit's metrics come from commitInfo, or from its actions when there is none", async () => {
  const { io } = fakeLog({
    [`${pad(1)}.json`]: lines({ commitInfo: { timestamp: 2, operation: "MERGE", engineInfo: "Apache-Spark/3.5",
      operationParameters: { predicate: "id = id" },
      operationMetrics: { numTargetRowsInserted: "10", numTargetRowsUpdated: "3", numTargetRowsDeleted: "1" } } }),
    // A Warehouse commit: no commitInfo at all.
    [`${pad(0)}.json`]: lines({ txn: { appId: "a", version: 2 } }, add(50, 3), { remove: { path: "x", size: 100 } }),
  });
  const [merge, wh] = await readHistoryPage(io.readText, DIR, await listCommits(io.list, DIR));
  assert.equal(merge.operation, "MERGE");
  assert.equal(merge.rowsAdded, 10);
  assert.equal(merge.rowsUpdated, 3);
  assert.equal(merge.rowsRemoved, 1);
  assert.deepEqual(merge.parameters, { predicate: "id = id" });
  assert.equal(merge.engine, "Apache-Spark/3.5");
  assert.equal(wh.operation, "WRITE");
  assert.equal(wh.timestamp, 5, "the commit file's own time, from the listing");
  assert.equal(wh.rowsAdded, 3);
  assert.equal(wh.filesAdded, 1);
  assert.equal(wh.filesRemoved, 1);
});

test("the table directory comes out of its Iceberg metadata location", () => {
  assert.deepEqual(tableDirOf("abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/v3.metadata.json"),
    { workspace: "ws", dir: "lh.Lakehouse/Tables/dbo/t" });
  assert.deepEqual(tableDirOf("https://onelake.dfs.fabric.microsoft.com/My%20WS/lh.Lakehouse/Tables/my%20t/metadata/1.metadata.json"),
    { workspace: "My WS", dir: "lh.Lakehouse/Tables/my t" });
  assert.equal(tableDirOf("abfss://ws@onelake.dfs.fabric.microsoft.com/x.parquet"), null);
});
