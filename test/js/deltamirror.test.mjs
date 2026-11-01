// A Delta table's log, copied into the cache folder: as it is, only what's needed, and whatever OneLake is doing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDeltaMirror } = require("../../src/deltamirror.js");

const DIR = "lh.Lakehouse/Tables/dbo/t";
const LOG = `${DIR}/_delta_log`;
const v = (n, rest) => `${String(n).padStart(20, "0")}.${rest}`;

function world(t, files = {}) {
  const w = { files: { ...files }, listed: [], read: [], fail: null, offline: false, clock: 1_000_000 };
  const catalog = {
    async listDir(ws, dir) {
      w.listed.push(dir);
      if (w.fail) throw w.fail;
      const prefix = `${dir}/`, seen = new Map();
      for (const path of Object.keys(w.files)) {
        if (!path.startsWith(prefix)) continue;
        const [first, ...more] = path.slice(prefix.length).split("/");
        seen.set(first, more.length > 0);
      }
      return [...seen].map(([name, isDir]) => ({ name: `${dir}/${name}`, isDir, bytes: isDir ? 0 : Buffer.byteLength(w.files[`${dir}/${name}`]), lastModified: w.lastModified ?? null }));
    },
    async readBytes(ws, path) {
      w.read.push(path);
      if (w.fail) throw w.fail;
      if (path === w.unreadable) throw new Error(`can't read ${path}`);
      if (!(path in w.files)) throw new Error(`no ${path}`);
      return Buffer.from(w.files[path]);
    },
  };
  return (async () => {
    const base = await mkdtemp(join(tmpdir(), "onelake-mirror-"));
    t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
    w.base = base;
    w.catalog = catalog;
    w.mirror = createDeltaMirror({ catalog, base: () => base, ttlMs: 1000, isOffline: () => w.offline, now: () => w.clock });
    w.table = { workspace: "ws", dir: DIR };
    return w;
  })();
}
const names = async local => (await readdir(join(local, "_delta_log"))).sort();

test("a log with no checkpoint comes across as it is, byte for byte", async t => {
  const w = await world(t, { [`${LOG}/${v(0, "json")}`]: "commit 0\n", [`${LOG}/${v(1, "json")}`]: "commit 1\n", [`${LOG}/${v(1, "crc")}`]: "skip" });
  const local = await w.mirror.ensure(w.table);
  assert.deepEqual(await names(local), [v(0, "json"), v(1, "json")]);
  assert.equal(await readFile(join(local, "_delta_log", v(1, "json")), "utf8"), "commit 1\n");
});

test("only the latest checkpoint and the commits after it, and what falls behind it goes", async t => {
  const w = await world(t, {
    [`${LOG}/_last_checkpoint`]: '{"version":10}',
    [`${LOG}/${v(9, "json")}`]: "9", [`${LOG}/${v(10, "json")}`]: "10", [`${LOG}/${v(10, "checkpoint.parquet")}`]: "c10", [`${LOG}/${v(11, "json")}`]: "11",
  });
  const local = await w.mirror.ensure(w.table);
  assert.deepEqual(await names(local), [v(10, "checkpoint.parquet"), v(10, "json"), v(11, "json"), "_last_checkpoint"].sort());
  assert.ok(!w.read.includes(`${LOG}/${v(9, "json")}`), "what's before the checkpoint isn't read");

  Object.assign(w.files, { [`${LOG}/${v(20, "checkpoint.parquet")}`]: "c20", [`${LOG}/${v(20, "json")}`]: "20", [`${LOG}/_last_checkpoint`]: '{"version":20}' });
  w.read.length = 0;
  await w.mirror.ensure(w.table, { fresh: true });
  assert.deepEqual(await names(local), [v(20, "checkpoint.parquet"), v(20, "json"), "_last_checkpoint"].sort());
  assert.equal(await readFile(join(local, "_delta_log", "_last_checkpoint"), "utf8"), '{"version":20}');
});

test("a commit already held isn't read again, and within its age OneLake isn't asked", async t => {
  const w = await world(t, { [`${LOG}/${v(0, "json")}`]: "0" });
  await w.mirror.ensure(w.table);
  assert.equal(w.read.length, 1);
  w.listed.length = 0; w.read.length = 0;
  await w.mirror.ensure(w.table);
  assert.deepEqual(w.listed, [], "within its age");
  w.clock += 2000;
  await w.mirror.ensure(w.table);
  assert.deepEqual(w.listed, [LOG], "past it, one listing");
  assert.deepEqual(w.read, [], "and nothing new to read");
  await w.mirror.ensure(w.table, { fresh: true });
  assert.equal(w.listed.length, 2, "asked for, whatever its age");
});

test("a new window goes by when any window last asked, so it doesn't ask again within that", async t => {
  const w = await world(t, { [`${LOG}/${v(0, "json")}`]: "0" });
  await w.mirror.ensure(w.table);
  w.listed.length = 0;
  const another = createDeltaMirror({ catalog: w.catalog, base: () => w.base, ttlMs: 1000, now: () => w.clock });
  w.clock += 500;
  await another.ensure(w.table);
  assert.deepEqual(w.listed, [], "within its age");
  const third = createDeltaMirror({ catalog: w.catalog, base: () => w.base, ttlMs: 1000, now: () => w.clock });
  w.clock += 2000;
  await third.ensure(w.table);
  assert.deepEqual(w.listed, [LOG], "past it");
});

test("a table dropped and made again starts over: what's held of the old log goes", async t => {
  const w = await world(t, {
    [`${LOG}/${v(0, "json")}`]: "old commit 0", [`${LOG}/${v(1, "json")}`]: "old commit 1", [`${LOG}/${v(2, "json")}`]: "old commit 2",
    [`${LOG}/_last_checkpoint`]: '{"version":2}',
  });
  const local = await w.mirror.ensure(w.table);
  const was = w.mirror.moves(w.table);

  w.files = { [`${LOG}/${v(0, "json")}`]: "new", [`${LOG}/${v(1, "json")}`]: "newer" };
  await w.mirror.ensure(w.table, { fresh: true });
  assert.deepEqual(await names(local), [v(0, "json"), v(1, "json")], "its last checkpoint and later commits are gone too");
  assert.equal(await readFile(join(local, "_delta_log", v(0, "json")), "utf8"), "new");
  assert.equal(await readFile(join(local, "_delta_log", v(1, "json")), "utf8"), "newer");
  assert.equal(w.mirror.moves(w.table), was + 1, "so a read that failed is worth another try");

  w.read.length = 0;
  await w.mirror.ensure(w.table, { fresh: true });
  assert.deepEqual(w.read, [], "and what's now held is what's there");
  assert.equal(w.mirror.moves(w.table), was + 1);
});

test("a commit of the same size written after the copy is another file", async t => {
  const w = await world(t, { [`${LOG}/${v(0, "json")}`]: "aaa" });
  const local = await w.mirror.ensure(w.table);
  w.files[`${LOG}/${v(0, "json")}`] = "bbb";
  w.lastModified = Date.now() + 60_000;
  await w.mirror.ensure(w.table, { fresh: true });
  assert.equal(await readFile(join(local, "_delta_log", v(0, "json")), "utf8"), "bbb");
});

test("deletion vectors and a checkpoint's sidecars come across, before the commits that name them", async t => {
  const w = await world(t, {
    [`${LOG}/${v(0, "json")}`]: "0", [`${DIR}/deletion_vector_ab.bin`]: "dv", [`${DIR}/part-1.parquet`]: "data",
    [`${LOG}/_sidecars/s1.parquet`]: "side",
  });
  const local = await w.mirror.ensure(w.table);
  assert.equal(await readFile(join(local, "deletion_vector_ab.bin"), "utf8"), "dv");
  assert.equal(await readFile(join(local, "_delta_log", "_sidecars", "s1.parquet"), "utf8"), "side");
  assert.ok(!w.read.includes(`${DIR}/part-1.parquet`), "a data file is never copied");
  assert.ok(w.read.indexOf(`${DIR}/deletion_vector_ab.bin`) < w.read.indexOf(`${LOG}/${v(0, "json")}`));
});

test("a deletion vector under a random prefix comes across too, and a partition's folder isn't looked in", async t => {
  const w = await world(t, {
    [`${LOG}/${v(0, "json")}`]: "0", [`${DIR}/ab/deletion_vector_cd.bin`]: "dv", [`${DIR}/ab/part-1.parquet`]: "data",
    [`${DIR}/year=2023/part-2.parquet`]: "data", [`${DIR}/metadata/v1.metadata.json`]: "{}",
  });
  const local = await w.mirror.ensure(w.table);
  assert.equal(await readFile(join(local, "ab", "deletion_vector_cd.bin"), "utf8"), "dv");
  assert.ok(!w.read.includes(`${DIR}/ab/part-1.parquet`), "a data file is never copied");
  assert.ok(w.listed.includes(`${DIR}/ab`));
  assert.ok(!w.listed.includes(`${DIR}/year=2023`) && !w.listed.includes(`${DIR}/metadata`));
  assert.ok(w.read.indexOf(`${DIR}/ab/deletion_vector_cd.bin`) < w.read.indexOf(`${LOG}/${v(0, "json")}`));
});

test("offline: what's held is used with nothing asked, and what isn't is no folder", async t => {
  const w = await world(t, { [`${LOG}/${v(0, "json")}`]: "0" });
  const local = await w.mirror.ensure(w.table);
  w.offline = true;
  w.listed.length = 0;
  w.clock += 1e9;
  assert.equal(await w.mirror.ensure(w.table, { fresh: true }), local);
  assert.equal(await w.mirror.ensure({ workspace: "ws", dir: "other" }), null);
  assert.deepEqual(w.listed, []);
});

test("OneLake failing keeps what's held, and is the answer when nothing is", async t => {
  const w = await world(t, { [`${LOG}/${v(0, "json")}`]: "0" });
  const local = await w.mirror.ensure(w.table);
  w.fail = new Error("list HTTP 500");
  assert.equal(await w.mirror.ensure(w.table, { fresh: true }), local);
  await assert.rejects(w.mirror.ensure({ workspace: "ws", dir: "other" }), /HTTP 500/);
});

test("a commit that won't copy leaves a log only behind, with no gap in it", async t => {
  const w = await world(t, { [`${LOG}/${v(0, "json")}`]: "0", [`${LOG}/${v(1, "json")}`]: "1", [`${LOG}/${v(2, "json")}`]: "2" });
  w.unreadable = `${LOG}/${v(1, "json")}`;
  await assert.rejects(w.mirror.ensure(w.table), /can't read/);
  const local = join(w.base, (await readdir(w.base))[0]);
  assert.deepEqual(await names(local), [v(0, "json")]);
});

test("no log there, no folder, and a cache that's cleared is filled again", async t => {
  const w = await world(t, { [`${LOG}/${v(0, "json")}`]: "0" });
  assert.equal(await w.mirror.ensure({ workspace: "ws", dir: "nothing/here" }), null);
  const local = await w.mirror.ensure(w.table);
  await rm(local, { recursive: true, force: true });
  await w.mirror.ensure(w.table);
  assert.ok(existsSync(join(local, "_delta_log", v(0, "json"))));
});

test("two asking at once are one copy, and no cache folder is no folder", async t => {
  const w = await world(t, { [`${LOG}/${v(0, "json")}`]: "0" });
  const [a, b] = await Promise.all([w.mirror.ensure(w.table), w.mirror.ensure(w.table)]);
  assert.equal(a, b);
  assert.equal(w.read.length, 1);
  const none = createDeltaMirror({ catalog: {}, base: () => null, ttlMs: 1 });
  assert.equal(await none.ensure(w.table), null);
});
