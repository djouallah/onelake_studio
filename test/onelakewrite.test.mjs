// onelakewrite.js: the one file the extension writes to OneLake — a semantic model's .bim into
// its lakehouse's Files/. No network: `fetch` answers from a script, and every call is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOneLakeWriter } = require("../src/onelakewrite.js");

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

test("writeFile: create, append at 0, flush at the length — on the file's DFS path", async () => {
  const { w, calls } = writerWith(() => res(201));
  await w.writeFile("Power BI", "nem.Lakehouse/Files/semantic_model/nem model.bim", Buffer.from("{\"a\":1}"));
  const url = `${DFS}/Power%20BI/nem.Lakehouse/Files/semantic_model/nem%20model.bim`;
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), [
    `PUT ${url}?resource=file`,
    `PATCH ${url}?action=append&position=0`,
    `PATCH ${url}?action=flush&position=7`,
  ]);
  assert.equal(String(calls[1].body), "{\"a\":1}");
  for (const c of calls) assert.equal(c.headers.authorization, "Bearer tok");
});

test("writeFile: OneLake's own message, naming the step that failed", async () => {
  const { w } = writerWith((url) => (url.includes("action=append")
    ? res(403, { error: { message: "This request is not authorized" } }) : res(201)));
  await assert.rejects(w.writeFile("ws", "lh.Lakehouse/Files/x.bim", Buffer.from("x")),
    /Writing lh\.Lakehouse\/Files\/x\.bim failed at append \(HTTP 403\) — This request is not authorized/);
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
  assert.deepEqual(await w.stat("ws", "lh.Lakehouse/Files/a.bim"), { bytes: 42 });
  assert.equal(calls[0].method, "HEAD");
  assert.equal(await w.stat("ws", "lh.Lakehouse/Files/gone.bim"), null);
});
