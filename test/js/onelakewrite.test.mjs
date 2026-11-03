// onelakewrite.js: what the extension writes to OneLake — Export to Fabric's model and Upload's files, into
// a lakehouse's Files/. No network: `fetch` answers from a script, and every call is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOneLakeWriter } = require("../../src/onelakewrite.js");

const DFS = "https://onelake.dfs.fabric.microsoft.com";
const res = (status, body = "", headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

function writerWith(answer, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return answer(url, init, calls.length);
  };
  return { w: createOneLakeWriter({ getToken: async () => "tok", fetchImpl, ...opts }), calls };
}

test("writeFile: written beside the file, then renamed over it, so the file itself is touched once", async () => {
  const { w, calls } = writerWith(() => res(201));
  await w.writeFile("Power BI", "nem.Lakehouse/Files/semantic_model/nem model.bim", Buffer.from("{\"a\":1}"));
  const url = `${DFS}/Power%20BI/nem.Lakehouse/Files/semantic_model/nem%20model.bim`;
  const tmp = calls[0].url.replace(/\?.*$/, "");
  assert.match(tmp, /nem%20model\.bim\.[0-9a-f]{8}\.tmp$/);
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), [
    `PUT ${tmp}?resource=file`,
    `PATCH ${tmp}?action=append&position=0`,
    `PATCH ${tmp}?action=flush&position=7`,
    `PUT ${url}`,
  ]);
  assert.equal(String(calls[1].body), "{\"a\":1}");
  assert.equal(calls[3].headers["x-ms-rename-source"], tmp.replace(DFS, ""), "the rename names its source, encoded");
  for (const c of calls) assert.equal(c.headers.authorization, "Bearer tok");
});

test("writeFile: what was asked about is what it replaces, and a file changed or made since stays", async () => {
  const headersOfRename = async o => {
    const { w, calls } = writerWith(() => res(201));
    await w.writeFile("ws", "lh.Lakehouse/Files/x.yaml", Buffer.from("x"), o);
    return calls.at(-1).headers;
  };
  assert.equal((await headersOfRename({ over: { etag: '"abc"' } }))["if-match"], '"abc"');
  assert.equal((await headersOfRename({ over: null }))["if-none-match"], "*");
  const free = await headersOfRename();
  assert.equal(free["if-match"], undefined);
  assert.equal(free["if-none-match"], undefined);
});

test("writeFile: OneLake's own message, naming the step that failed", async () => {
  const { w } = writerWith((url) => (url.includes("action=append")
    ? res(403, { error: { message: "This request is not authorized" } }) : res(201)));
  await assert.rejects(w.writeFile("ws", "lh.Lakehouse/Files/x.bim", Buffer.from("x")),
    /Writing lh\.Lakehouse\/Files\/x\.bim failed at append \(HTTP 403\) — This request is not authorized/);
});

test("writeFile: a failure part way never reaches the file, and tidies what it made", async () => {
  for (const failing of ["action=append", "action=flush", "rename"]) {
    const isRename = (url, init) => init.method === "PUT" && !url.includes("resource=file");
    const { w, calls } = writerWith((url, init) => {
      if (failing === "rename" ? isRename(url, init) : url.includes(failing)) return res(500);
      return res(201);
    });
    await assert.rejects(w.writeFile("ws", "lh.Lakehouse/Files/x.bim", Buffer.from("x")), /failed at/);
    const file = `${DFS}/ws/lh.Lakehouse/Files/x.bim`;
    assert.ok(!calls.some(c => c.url === file && failing !== "rename"), `${failing}: the file itself was not touched`);
    const last = calls[calls.length - 1];
    assert.equal(last.method, "DELETE", failing);
    assert.match(last.url, /\.tmp$/);
  }
});

test("compare: only a 404 means nothing is there, and not being able to tell stops the caller", async () => {
  const text = "version: 1\n";
  const read = async () => Buffer.from(text);
  const { w: none } = writerWith(() => res(404));
  assert.equal(await none.compare("ws", "x.yaml", text, read), "none");
  const { w: there } = writerWith(() => res(200, "", { "content-length": "11" }));
  assert.equal(await there.compare("ws", "x.yaml", text, read), "same");
  assert.equal(await there.compare("ws", "x.yaml", "other", read), "different");
  assert.equal(await there.compare("ws", "x.yaml", text, () => { throw new Error("no"); }), "different", "unread is asked about");
  for (const status of [403, 500]) {
    const { w: refused, calls } = writerWith(() => res(status));
    await assert.rejects(refused.compare("ws", "x.yaml", text, read), new RegExp(`HTTP ${status}`));
    assert.deepEqual(calls.map(c => c.method), ["HEAD"], "nothing written");
  }
});

test("a 401 is retried once with a fresh token", async () => {
  let fresh = 0;
  const { w, calls } = writerWith((url, init, n) => (n === 1 ? res(401) : res(201)),
    { getToken: async o => (o && o.fresh ? (fresh++, "new") : "old") });
  await w.writeFile("ws", "lh.Lakehouse/Files/x.bim", Buffer.from("x"));
  assert.equal(fresh, 1);
  assert.equal(calls[1].headers.authorization, "Bearer new");
});

test("stat: the size, or null when there is no file", async () => {
  const { w, calls } = writerWith(url => (url.includes("gone") ? res(404) : res(200, "", { "content-length": "42" })));
  assert.equal((await w.stat("ws", "lh.Lakehouse/Files/a.bim")).bytes, 42);
  assert.equal(calls[0].method, "HEAD");
  assert.equal(await w.stat("ws", "lh.Lakehouse/Files/gone.bim"), null);
});

test("a big file goes in pieces, each at its offset, flushed at the whole length, with progress", async () => {
  const { w, calls } = writerWith(() => res(201));
  const seen = [];
  await w.writeFile("ws", "lh.Lakehouse/Files/big.bin", Buffer.from("abcdefghij"), { chunk: 4, onProgress: (done, size) => seen.push([done, size]) });
  const steps = calls.map(c => c.url.replace(/^.*\?/, "?").replace(/^https.*$/, "rename"));
  assert.deepEqual(steps, ["?resource=file", "?action=append&position=0", "?action=append&position=4", "?action=append&position=8", "?action=flush&position=10", "rename"]);
  assert.deepEqual(calls.slice(1, 4).map(c => String(c.body)), ["abcd", "efgh", "ij"]);
  assert.deepEqual(seen, [[4, 10], [8, 10], [10, 10]]);
});

test("a cancel stops before the next piece and tidies the temp file; what was there stays", async () => {
  let cancel = false;
  const { w, calls } = writerWith(() => res(201));
  await assert.rejects(
    w.writeFile("ws", "lh.Lakehouse/Files/big.bin", Buffer.from("abcdefgh"), { chunk: 4, cancelled: () => cancel, onProgress: () => { cancel = true; } }),
    e => e.cancelled === true);
  assert.deepEqual(calls.map(c => c.method), ["PUT", "PATCH", "DELETE"], "one piece, then the temp file deleted, no rename");
});

test("a file on this computer is read a piece at a time", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "upload-"));
  const file = join(dir, "a b.csv");
  await writeFile(file, "x,y\n1,2\n");
  const { w, calls } = writerWith(() => res(201));
  assert.equal(await w.writeLocalFile("ws", "lh.Lakehouse/Files/raw/a b.csv", file, { chunk: 5, over: null }), 8);
  assert.deepEqual(calls.filter(c => c.method === "PATCH" && c.url.includes("append")).map(c => String(c.body)), ["x,y\n1", ",2\n"]);
  assert.equal(calls.at(-1).headers["if-none-match"], "*", "a new file never lands over one made since");
  assert.match(calls.at(-1).url, /\/ws\/lh\.Lakehouse\/Files\/raw\/a%20b\.csv$/);
  await rm(dir, { recursive: true, force: true });
});
