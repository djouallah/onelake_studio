// store.js: what the extension remembers about OneLake. The contract under test is the
// one the whole cache-first design rests on — an answer on disk is served at once, an old
// one is refreshed behind the caller, and 'changed' fires only when the answer moved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStore, revalidate } = require("../../src/store.js");

test("revalidate: a kept answer is trusted until using it fails, then read again once", async () => {
  const stale = () => Object.assign(new Error("stale"), { stale: true });
  const isStale = e => !!e.stale;
  const setup = answers => {
    const reads = [];
    return { reads, read: async o => { reads.push(!!o.fresh); const a = answers[reads.length - 1]; if (a instanceof Error) throw a; return a; } };
  };

  let s = setup(["kept"]);
  assert.equal(await revalidate(s.read, async a => `used ${a}`, isStale), "used kept");
  assert.deepEqual(s.reads, [false], "working: nothing is read past the cache");

  s = setup(["kept", "new"]);
  const used = [];
  const useNewOnly = async a => { used.push(a); if (a === "kept") throw stale(); return a; };
  assert.equal(await revalidate(s.read, useNewOnly, isStale), "new");
  assert.deepEqual(s.reads, [false, true]);
  assert.deepEqual(used, ["kept", "new"]);

  // The same answer: the first error stands, with no second try.
  s = setup(["kept", "kept"]);
  let tries = 0;
  const first = stale();
  await assert.rejects(revalidate(s.read, async () => { tries++; throw first; }, isStale), e => e === first);
  assert.equal(tries, 1);

  // Not a failure the answer can explain: not read again.
  s = setup(["kept"]);
  await assert.rejects(revalidate(s.read, async () => { throw new Error("typo"); }, isStale), /typo/);
  assert.deepEqual(s.reads, [false]);

  // Offline: the real error, not the failed read's.
  s = setup(["kept", new Error("offline")]);
  await assert.rejects(revalidate(s.read, async () => { throw first; }, isStale), e => e === first);

  // New answer, still failing: that failure, and no third read.
  s = setup(["kept", "new", "newer"]);
  await assert.rejects(revalidate(s.read, async a => { throw Object.assign(stale(), { message: a }); }, isStale), /new/);
  assert.deepEqual(s.reads, [false, true]);
});

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "onelake-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const settle = () => new Promise(r => setTimeout(r, 20));
// A background refresh finishes when its disk write does, which is not a fixed time on a
// busy machine — so wait for what it produces, with a generous ceiling.
async function until(cond, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, 5));
  }
}

test("a miss fetches; a hit is served without fetching", async t => {
  const store = createStore({ dir: await tempDir(t) });
  let calls = 0;
  const fetcher = async () => { calls++; return ["a", "b"]; };
  const first = await store.get("k", fetcher);
  assert.deepEqual(first.value, ["a", "b"]);
  assert.equal(first.cached, false);
  const second = await store.get("k", fetcher);
  assert.equal(second.cached, true);
  assert.equal(calls, 1, "the second read cost OneLake nothing");
});

test("an answer survives a restart: a new store on the same directory serves it", async t => {
  const dir = await tempDir(t);
  await createStore({ dir }).get("k", async () => ({ n: 1 }));
  let calls = 0;
  const r = await createStore({ dir }).get("k", async () => { calls++; return { n: 2 }; });
  assert.deepEqual(r.value, { n: 1 });
  assert.equal(calls, 0);
});

test("an old answer is served at once and refreshed behind; 'changed' fires once", async t => {
  let clock = 1_000;
  const store = createStore({ dir: await tempDir(t), ttlMs: 100, now: () => clock });
  await store.get("k", async () => "v1");
  const changes = [];
  store.on("changed", (k, v) => changes.push([k, v]));
  clock += 500;
  const r = await store.get("k", async () => "v2");
  assert.equal(r.value, "v1", "the caller did not wait for OneLake");
  assert.equal(r.stale, true);
  await until(() => changes.length > 0);
  await settle();
  assert.deepEqual(changes, [["k", "v2"]]);
  assert.equal((await store.get("k", async () => "v3")).value, "v2", "the refreshed answer is now the cached one");
});

test("a TTL given as a function is read at each get, so a changed setting applies at once", async t => {
  let clock = 1_000, ttl = 1_000;
  const store = createStore({ dir: await tempDir(t), ttlMs: () => ttl, now: () => clock });
  await store.get("k", async () => "v1");
  clock += 500;
  assert.equal((await store.get("k", async () => "v2")).stale, false);
  ttl = 100;
  assert.equal((await store.get("k", async () => "v2")).stale, true);
  await settle();
});

test("a refresh that brings back the same answer is not a change", async t => {
  let clock = 1_000;
  const store = createStore({ dir: await tempDir(t), ttlMs: 100, now: () => clock });
  await store.get("k", async () => ({ a: 1 }));
  let changed = 0, refreshed = false;
  store.on("changed", () => changed++);
  clock += 500;
  await store.get("k", async () => { refreshed = true; return { a: 1 }; });
  await until(() => refreshed);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(changed, 0);
});

test("a failed background refresh keeps the cached answer and says so", async t => {
  let clock = 1_000;
  const store = createStore({ dir: await tempDir(t), ttlMs: 100, now: () => clock });
  await store.get("k", async () => "good");
  const failures = [];
  store.on("refresh-failed", (k, e) => failures.push(e.message));
  clock += 500;
  const r = await store.get("k", async () => { throw new Error("HTTP 429"); });
  assert.equal(r.value, "good");
  await until(() => failures.length > 0);
  assert.deepEqual(failures, ["HTTP 429"]);
  assert.equal((await store.get("k", async () => "x")).value, "good", "the failure did not replace it");
});

test("with nothing cached, a failure is the caller's to see", async t => {
  const store = createStore({ dir: await tempDir(t) });
  await assert.rejects(store.get("k", async () => { throw new Error("HTTP 403"); }), /403/);
  assert.equal((await store.get("k", async () => "later")).value, "later", "and is not remembered");
});

test("fresh skips the cache — that is what Refresh means", async t => {
  const store = createStore({ dir: await tempDir(t) });
  await store.get("k", async () => "old");
  const r = await store.get("k", async () => "new", { fresh: true });
  assert.equal(r.value, "new");
  assert.equal(r.cached, false);
});

test("one key, one request in flight, however many ask", async t => {
  const store = createStore({ dir: await tempDir(t) });
  let calls = 0;
  const fetcher = () => new Promise(r => setTimeout(() => { calls++; r("v"); }, 30));
  const all = await Promise.all([1, 2, 3].map(() => store.get("k", fetcher)));
  assert.deepEqual(all.map(x => x.value), ["v", "v", "v"]);
  assert.equal(calls, 1);
});

test("put and peek: a value computed by the caller, read back without a fetcher", async t => {
  const dir = await tempDir(t);
  await createStore({ dir }).put("rows", { rows: [1, 2] });
  assert.deepEqual(await createStore({ dir }).peek("rows"), { rows: [1, 2] });
  assert.equal(await createStore({ dir }).peek("absent"), undefined);
});

test("no temp files are left behind, and clear empties the directory", async t => {
  const dir = await tempDir(t);
  const store = createStore({ dir });
  await Promise.all(["a", "b", "c"].map(k => store.get(k, async () => k.repeat(100))));
  const names = await readdir(dir);
  assert.equal(names.filter(n => n.endsWith(".tmp")).length, 0);
  assert.equal(names.length, 3);
  assert.ok(await store.size() > 0);
  await store.clear();
  assert.equal((await readdir(dir)).length, 0);
  let calls = 0;
  await store.get("a", async () => { calls++; return "again"; });
  assert.equal(calls, 1, "cleared means fetched again");
});

test("past the disk budget the oldest entries go", async t => {
  const dir = await tempDir(t);
  const store = createStore({ dir, maxBytes: 2_000 });
  for (let i = 0; i < 10; i++) {
    await store.put(`k${i}`, "x".repeat(400));
    await settle();
  }
  assert.ok((await store.size()) <= 2_000, `size ${await store.size()}`);
  assert.ok((await readdir(dir)).length < 10);
});

test("with no directory it still works, in memory", async () => {
  const store = createStore({ dir: null });
  let calls = 0;
  await store.get("k", async () => { calls++; return 1; });
  await store.get("k", async () => { calls++; return 2; });
  assert.equal(calls, 1);
});
