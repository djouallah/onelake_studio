// The table service's download when OneLake misbehaves: an answer that never comes, a body that stops, a name a
// URL can't hold as it is. What needs DuckDB (the budget, a table's .part files) is in onelaketable.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { httpsDownload, httpsOf, localOf } = require("../../core/lake/tableservice.js");

const URL_ = "abfss://ws@onelake.dfs.fabric.microsoft.com/i.Lakehouse/Tables/t/a.parquet";
const inTemp = async (t, run) => {
  const dir = await mkdtemp(join(tmpdir(), "onelake-download-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return run(dir);
};
// A body that sends `first` and then nothing, for ever, unless it is cancelled.
const stalledBody = (first, onCancel = () => {}) => new ReadableStream({
  start(c) { if (first) c.enqueue(new TextEncoder().encode(first)); },
  cancel() { onCancel(); },
});

test("a body that stops arriving ends the download, and what came is not left behind", t => inTemp(t, async dir => {
  let asked = 0, cancelled = 0;
  const download = httpsDownload({ getToken: async () => "tok", sleep: async () => {}, idleMs: 40,
    fetchImpl: async () => { asked++; return new Response(stalledBody("PAR1 half a f", () => cancelled++)); } });
  const dst = join(dir, "a.parquet.part");
  const started = Date.now();
  await assert.rejects(download(URL_, dst), /no data moved for/);
  assert.ok(Date.now() - started < 5000, "in about two idle waits, not never");
  assert.equal(asked, 2, "tried once more, as a failed connection is");
  assert.equal(cancelled, 2, "and each stalled answer was let go of");
  assert.deepEqual(await readdir(dir), [], "no half file");
}));

test("an answer that never comes ends the download too, even from a request that ignores being told to stop", t => inTemp(t, async dir => {
  const signals = [];
  const download = httpsDownload({ getToken: async () => "tok", sleep: async () => {}, idleMs: 40,
    fetchImpl: (_u, o) => { signals.push(o.signal); return new Promise(() => {}); } });
  await assert.rejects(download(URL_, join(dir, "a.part")), /no data moved for/);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(s => s.aborted), "the request was told to stop");
  assert.deepEqual(await readdir(dir), []);
}));

test("a slow body that keeps arriving is not a stalled one", t => inTemp(t, async dir => {
  const parts = ["PAR1", " slow", " but", " coming", " PAR1"];
  const body = new ReadableStream({
    async pull(c) {
      if (!parts.length) return c.close();
      await new Promise(r => setTimeout(r, 150));
      c.enqueue(new TextEncoder().encode(parts.shift()));
    },
  });
  // Longer in all than the idle limit, and never that long between two pieces.
  const download = httpsDownload({ getToken: async () => "tok", idleMs: 700, fetchImpl: async () => new Response(body) });
  assert.equal(await download(URL_, join(dir, "a.part")), "PAR1 slow but coming PAR1".length);
}));

test("a connection that breaks mid-file leaves nothing, and the second try's file is whole", t => inTemp(t, async dir => {
  let n = 0;
  const broken = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("PAR1 half")); }, pull(c) { c.error(new Error("socket hang up")); } });
  const download = httpsDownload({ getToken: async () => "tok", sleep: async () => {},
    fetchImpl: async () => new Response(++n === 1 ? broken() : "PAR1 whole PAR1") });
  const dst = join(dir, "a.part");
  assert.equal(await download(URL_, dst), 15);
  assert.equal(n, 2);
  const always = httpsDownload({ getToken: async () => "tok", sleep: async () => {}, fetchImpl: async () => new Response(broken()) });
  await assert.rejects(always(URL_, join(dir, "b.part")), /socket hang up/);
  assert.deepEqual(await readdir(dir), ["a.part"], "the one that failed twice left no file");
}));

test("no token asks OneLake nothing", t => inTemp(t, async dir => {
  let asked = 0;
  const download = httpsDownload({ getToken: async () => { throw new Error("not signed in"); }, sleep: async () => {},
    fetchImpl: async () => { asked++; return new Response("x"); } });
  await assert.rejects(download(URL_, join(dir, "a.part")), /not signed in/);
  assert.equal(asked, 0);
}));

test("a file's name goes into the URL as a name: # ? % and a space are part of it, not of the URL", () => {
  const at = p => `abfss://ws@onelake.dfs.fabric.microsoft.com/i.Lakehouse/Tables/t/${p}`;
  const pathOf = p => new URL(httpsOf(at(p))).pathname.split("/").map(decodeURIComponent).join("/");
  for (const name of ["a#b.parquet", "a?b=c.parquet", "50%25 off.parquet", "100%.parquet", "a b.parquet", "région=né/part-1.parquet",
                      "col=a%2Fb/x.parquet", "day=2024-01-01 10:00:00/x.parquet", "a+b&c;d.parquet"]) {
    const u = new URL(httpsOf(at(name)));
    assert.equal(u.hash, "", `${name}: nothing of it is a fragment`);
    assert.equal(u.search, "", `${name}: nor a query`);
    assert.equal(pathOf(name), `/ws/i.Lakehouse/Tables/t/${name}`, `${name}: OneLake is asked for exactly this name`);
  }
  // A workspace's name is a part too.
  assert.equal(new URL(httpsOf("abfss://my ws@onelake.dfs.fabric.microsoft.com/i.Lakehouse/Tables/t/a")).pathname, "/my%20ws/i.Lakehouse/Tables/t/a");
  // One with a # in it is refused, not sent somewhere else: nothing after the # is read as the host.
  assert.throws(() => httpsOf("abfss://ws#1@onelake.dfs.fabric.microsoft.com/i.Lakehouse/Tables/t/a"), /is not on OneLake/);
  // A plain name is untouched.
  assert.equal(httpsOf(at("part-0.parquet")), "https://onelake.dfs.fabric.microsoft.com/ws/i.Lakehouse/Tables/t/part-0.parquet");
});

test("only OneLake is asked, and a copy's place is never outside the cache folder", () => {
  assert.throws(() => httpsOf("abfss://ws@evil.example.com/i/Tables/t/a.parquet"), /is not on OneLake/);
  assert.throws(() => httpsOf("https://onelake.dfs.fabric.microsoft.com/ws/i/a.parquet"), /not a OneLake path/);
  assert.throws(() => httpsOf("abfss://ws@onelake.dfs.fabric.microsoft.com.evil.example/i/a"), /is not on OneLake/);
  const base = "abfss://ws@onelake.dfs.fabric.microsoft.com/i.Lakehouse/Tables/t";
  for (const bad of [`${base}/../../../x.parquet`, `${base}/./x.parquet`, `${base}/a\\..\\..\\x.parquet`,
                     "abfss://..@onelake.dfs.fabric.microsoft.com/i/x.parquet"]) {
    assert.throws(() => localOf("/cache/files", bad), /not a OneLake path/, bad);
  }
  assert.equal(localOf("/cache/files", `${base}/col=1/x.parquet`), "/cache/files/ws/i.Lakehouse/Tables/t/col=1/x.parquet");
});

test("an answer that is a refusal is let go of, not left open", t => inTemp(t, async dir => {
  let cancelled = 0;
  const download = httpsDownload({ getToken: async () => "tok", sleep: async () => {},
    fetchImpl: async () => new Response(stalledBody("no", () => cancelled++), { status: 403 }) });
  await assert.rejects(download(URL_, join(dir, "a.part")), /OneLake answered 403/);
  assert.equal(cancelled, 1);
  assert.deepEqual(await readdir(dir), []);
}));
