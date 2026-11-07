// A table with OneLake security, read through OneLake's table read API: every stream or nothing, kept until
// it is old, and what the API says when it refuses. A stubbed fetch, so nothing leaves this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTableRead, tableReadCopies } = require("../../src/tableread.js");

const TABLE = { workspace: "my ws", item: "data.Lakehouse", schema: "dbo", table: "sales" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const arrow = bytes => new Response(bytes, { status: 200, headers: { "content-type": "application/vnd.apache.arrow.stream" } });
// A body that sends some bytes, then drops its connection.
const dropped = () => new Response(new ReadableStream({
  start(c) { c.enqueue(new Uint8Array([1, 2])); c.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })); },
}), { status: 200 });

async function world(t, { streams = { a: "AAAA", b: "BBBBBB" } } = {}) {
  const base = await mkdtemp(join(tmpdir(), "onelake-tableread-"));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const w = { base, clock: 1_000_000, posts: 0, gets: [], log: [], offline: null, enabled: true, streams, post: null, get: {} };
  w.fetchImpl = async (url, o) => {
    const u = new URL(url);
    if (o.method === "POST") {
      w.posts++;
      w.body = o.body;
      w.url = u.pathname;
      if (w.post) return w.post();
      return json(200, { streams: Object.keys(w.streams).map(streamId => ({ streamId })) });
    }
    const id = decodeURIComponent(u.pathname.split("/").pop());
    w.gets.push(id);
    if (w.get[id]) { const answer = w.get[id]; delete w.get[id]; return typeof answer === "function" ? answer(o) : answer; }
    return arrow(new TextEncoder().encode(w.streams[id]));
  };
  w.reader = createTableRead({
    getToken: async () => "tok", base: () => base, ttlMs: 1000, fetchImpl: w.fetchImpl, now: () => w.clock,
    offlineReason: () => w.offline, enabled: () => w.enabled, onRequest: e => w.log.push(e),
  });
  return w;
}
const contents = async files => Promise.all(files.map(f => readFile(f, "utf8")));

test("every stream comes down, in order, under the user's own names, and the copy is whole", async t => {
  const w = await world(t);
  const got = await w.reader.ensure(TABLE);
  assert.equal(w.url, "/v1.0/workspaces/my%20ws/items/data.Lakehouse/schemas/dbo/tables/sales/read");
  assert.equal(w.body, "{}", "every column the user may see");
  assert.deepEqual(await contents(got.files), ["AAAA", "BBBBBB"]);
  assert.equal(got.cached, false);
  assert.equal(got.at, w.clock);
  assert.ok(w.log.some(e => /\/read$/.test(e.path) && e.status === 200), "the POST is in the read log");
  assert.ok(w.log.some(e => /readStream$/.test(e.path) && e.bytes === 6), "and each stream, with its bytes");
  const [copy] = await tableReadCopies(w.base);
  assert.equal(copy.bytes, 10);
});

test("a copy within its age is the answer with nothing asked, and past it, or a Refresh, it is read again", async t => {
  const w = await world(t);
  const first = await w.reader.ensure(TABLE);
  w.clock += 500;
  const again = await w.reader.ensure(TABLE);
  assert.equal(w.posts, 1, "no second charge");
  assert.equal(again.cached, true);
  assert.deepEqual(again.files, first.files);

  w.clock += 600;
  w.streams = { c: "NEW" };
  const later = await w.reader.ensure(TABLE);
  assert.equal(w.posts, 2);
  assert.deepEqual(await contents(later.files), ["NEW"]);
  const [dir] = await readdir(w.base);
  assert.deepEqual(await readdir(join(w.base, dir)), [String(later.at)], "the copy before it goes");

  w.clock += 10;
  await w.reader.ensure(TABLE, { since: w.clock });
  assert.equal(w.posts, 3, "a Refresh after the copy reads it again");
});

test("a dropped connection is read again, with no new POST", async t => {
  const w = await world(t);
  w.get.b = dropped();
  const got = await w.reader.ensure(TABLE);
  assert.deepEqual(await contents(got.files), ["AAAA", "BBBBBB"]);
  assert.equal(w.posts, 1);
  assert.equal(w.gets.filter(id => id === "b").length, 2);
});

test("a stream that fails leaves no copy and no part, and the next read starts again", async t => {
  const w = await world(t);
  w.get.b = json(500, { message: "Stream was too long" });
  await assert.rejects(w.reader.ensure(TABLE), /too large for OneLake's table read API \("Stream was too long"\)/);
  assert.equal(w.gets.filter(id => id === "b").length, 1, "no retry helps that one");
  const [dir] = await readdir(w.base);
  assert.deepEqual(await readdir(join(w.base, dir)), []);
  assert.equal(await w.reader.held(TABLE), null);
  assert.equal((await w.reader.ensure(TABLE)).files.length, 2);
});

test("refused or missing: the API's 403 says so, and its body's words come with it", async t => {
  const w = await world(t);
  w.post = () => json(403, { errorCode: "UserDoesNotHaveTableAccess", message: "User does not have access to table." });
  await assert.rejects(w.reader.ensure(TABLE), e => e.status === 403 &&
    /may not read dbo\.sales, or it does not exist \(HTTP 403\) — User does not have access to table\./.test(e.message));
  w.post = () => json(400, { message: "Invalid request body" });
  await assert.rejects(w.reader.ensure(TABLE), /failed \(HTTP 400\) — Invalid request body/);
});

test("Stop: a read only one caller waits for stops, and leaves nothing behind", async t => {
  const w = await world(t);
  let started;
  const going = new Promise(r => { started = r; });
  w.get.b = o => {
    started();
    return new Promise((_, reject) => o.signal.addEventListener("abort", () => reject(o.signal.reason), { once: true }));
  };
  const ac = new AbortController();
  const read = w.reader.ensure(TABLE, { signal: ac.signal });
  await going;
  ac.abort(Object.assign(new Error("Interrupted!"), { cancelled: true }));
  await assert.rejects(read, e => e.cancelled === true);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await w.reader.held(TABLE), null);
  const [dir] = await readdir(w.base);
  assert.deepEqual(await readdir(join(w.base, dir)), []);
});

test("Stop: a read two callers wait for goes on while one still does", async t => {
  const w = await world(t);
  let started, release;
  const going = new Promise(r => { started = r; });
  const held = new Promise(r => { release = r; });
  w.get.b = async () => { started(); await held; return arrow(new TextEncoder().encode("BBBBBB")); };
  const one = new AbortController(), two = new AbortController();
  const first = w.reader.ensure(TABLE, { signal: one.signal });
  const second = w.reader.ensure(TABLE, { signal: two.signal });
  await going;
  one.abort(new Error("stopped"));
  await assert.rejects(first, /stopped/);
  release();
  assert.equal((await second).files.length, 2);
  assert.equal(w.posts, 1, "one read for both");
});

test("offline: a copy of any age answers, and with none it says so at once", async t => {
  const w = await world(t);
  await w.reader.ensure(TABLE);
  w.offline = "no internet";
  w.clock += 1e9;
  assert.equal((await w.reader.ensure(TABLE)).cached, true);
  assert.equal(w.posts, 1);
  await assert.rejects(w.reader.ensure({ ...TABLE, table: "other" }),
    e => e.offline === true && /dbo\.other, which has OneLake security, is not cached on this machine, and there is no internet/.test(e.message));
});

test("turned off: a copy here still answers, and nothing is asked of the API", async t => {
  const w = await world(t);
  await w.reader.ensure(TABLE);
  w.enabled = false;
  assert.equal((await w.reader.ensure(TABLE)).cached, true);
  await assert.rejects(w.reader.ensure({ ...TABLE, table: "other" }), e => e.turnedOff === true && /onelakeStudio\.securedTableRead/.test(e.message));
  assert.equal(w.posts, 1);
});

test("with the disk cache off there is nowhere to keep it, and it says so", async t => {
  const reader = createTableRead({ getToken: async () => "tok", base: () => null, ttlMs: 1000, fetchImpl: async () => { throw new Error("asked"); } });
  assert.equal(await reader.held(TABLE), null);
  await assert.rejects(reader.ensure(TABLE), /needs the disk cache, which is off/);
});
